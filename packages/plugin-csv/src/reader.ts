import { Readable } from "node:stream";
import { TextDecoder } from "node:util";
import { parse, type Parser } from "csv-parse";
import {
  ErrorCodes,
  EtlError,
  type Batch,
  type ByteStream,
  type Ctx,
  type Reader,
  type Row,
} from "@etl-js/contracts";
import { parseCsvConfig, type CsvConfig } from "./config.js";

/** Il BOM come lo si vede decodificando in UTF-8, e come lo si vede in latin1. */
const BOM_UTF8 = "\uFEFF";
const BOM_COME_LATIN1 = "\u00EF\u00BB\u00BF";

/**
 * Decodifica i byte nell'encoding richiesto, un pezzo alla volta. `stream: true`
 * serve perche' un carattere multibyte puo' essere spezzato fra due chunk.
 *
 * `ignoreBOM: true` non significa "tieni il BOM per sempre": significa che a
 * toglierlo decidiamo noi, non il decoder. Senza, `TextDecoder` lo mangia
 * sempre e l'opzione `bom: false` della config non potrebbe funzionare.
 */
async function* decode(
  bytes: ByteStream,
  config: CsvConfig,
  ref: string,
): AsyncGenerator<string> {
  const decoder = new TextDecoder(config.encoding, { ignoreBOM: true });
  let first = true;

  try {
    for await (const chunk of bytes) {
      let text = decoder.decode(chunk, { stream: true });
      if (first && text.length > 0) {
        first = false;
        if (config.bom) {
          // Un file salvato UTF-8-BOM ma dichiarato latin1 e' un classico dei
          // gestionali: il BOM arriva come tre caratteri, non come uno.
          if (text.startsWith(BOM_UTF8)) text = text.slice(BOM_UTF8.length);
          else if (text.startsWith(BOM_COME_LATIN1)) text = text.slice(BOM_COME_LATIN1.length);
        }
      }
      if (text.length > 0) yield text;
    }
  } catch (error) {
    throw new EtlError(`Lettura interrotta su "${ref}"`, {
      code: ErrorCodes.READ_FAILED,
      retryable: true,
      context: { input: ref },
      cause: error,
    });
  }

  const tail = decoder.decode();
  if (tail.length > 0) yield tail;
}

/** Le opzioni di csv-parse che corrispondono alla nostra config. */
function parserFor(config: CsvConfig): Parser {
  return parse({
    delimiter: config.delimiter,
    quote: config.quote,
    // Il BOM lo togliamo noi in fase di decodifica.
    bom: false,
    trim: config.trim,
    // `columns: true` prende i nomi dalla prima riga utile; un elenco li impone;
    // false lascia gli array posizionali, che rinominiamo noi in c0, c1, ...
    columns: config.header === false ? false : config.header,
    from_line: config.skipRows + 1,
    // Una riga con un numero di campi diverso dall'intestazione non deve
    // abbattere lo stream: entra con quello che ha, e sara' `validate` a
    // giudicarla. Il reader legge, non giudica.
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
  });
}

/** Chiavi posizionali quando il file non ha intestazione e la config non la fornisce. */
function positional(record: string[]): Row {
  const row: Row = {};
  record.forEach((value, index) => {
    row[`c${index}`] = value;
  });
  return row;
}

export const csvReader: Reader = {
  async *read(rawConfig: unknown, ctx: Ctx): AsyncIterable<Batch> {
    const config = parseCsvConfig(rawConfig);

    // La sorgente la apre il core: qui non si sa nemmeno se esista un filesystem (I6).
    const bytes = await ctx.openInput(config.input);
    const parser = parserFor(config);

    // I byte entrano nel parser da un lato mentre dall'altro se ne leggono i
    // record: e' `pipe` a occuparsi della contropressione, ed e' cio' che tiene
    // il file fuori dalla memoria (I3). Scritta a mano, questa parte va in
    // stallo appena il consumatore smette di leggere prima della fine.
    const source = Readable.from(decode(bytes, config, config.input));
    // `pipe` non propaga gli errori a valle: senza questo, una sorgente che si
    // rompe a meta' chiuderebbe il parser come se il file fosse finito.
    source.once("error", (error: Error) => parser.destroy(error));
    source.pipe(parser);

    let rows: Row[] = [];
    let dataRows = 0;
    let batchOffset = 0;

    const flush = (): Batch => {
      const batch: Batch = {
        rows,
        meta: { runId: ctx.runId, source: config.input, offset: batchOffset },
      };
      rows = [];
      batchOffset = dataRows;
      return batch;
    };

    try {
      for await (const record of parser) {
        if (ctx.signal.aborted) break;
        rows.push(config.header === false ? positional(record as string[]) : (record as Row));
        dataRows += 1;
        if (rows.length >= config.batchSize) yield flush();
      }
      if (rows.length > 0) yield flush();
    } catch (error) {
      if (EtlError.is(error)) throw error;
      throw new EtlError(`CSV illeggibile: "${config.input}"`, {
        code: ErrorCodes.READ_FAILED,
        context: { input: config.input, delimiter: config.delimiter },
        cause: error,
      });
    } finally {
      // Chi consuma puo' smettere in qualunque momento (abort, limite di
      // preview): sorgente e parser vanno chiusi comunque, o il processo
      // resterebbe appeso a un file mai finito.
      source.unpipe(parser);
      source.destroy();
      parser.destroy();
    }
  },
};
