import { createReadStream } from "node:fs";
import { TextDecoder } from "node:util";
import {
  ErrorCodes,
  IngestError,
  type Batch,
  type Ctx,
  type Reader,
  type Row,
} from "@etl-js/contracts";
import { parseCsvConfig, type CsvConfig } from "./config.js";
import { parseCsv } from "./parser.js";

/** Legge il file a blocchi e li decodifica nell'encoding richiesto, senza mai caricarlo tutto. */
async function* decodedChunks(config: CsvConfig): AsyncGenerator<string> {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(config.encoding);
  } catch (error) {
    throw new IngestError(`Encoding non supportato: ${config.encoding}`, {
      code: ErrorCodes.CONFIG_INVALID,
      context: { encoding: config.encoding },
      cause: error,
    });
  }

  const stream = createReadStream(config.path);
  try {
    for await (const chunk of stream) {
      yield decoder.decode(chunk as Buffer, { stream: true });
    }
  } catch (error) {
    throw new IngestError(`Impossibile leggere ${config.path}`, {
      code: ErrorCodes.SOURCE_UNREADABLE,
      retryable: true,
      context: { path: config.path },
      cause: error,
    });
  }
  const tail = decoder.decode();
  if (tail.length > 0) yield tail;
}

/** Nomi di colonna di ripiego quando il file non ha intestazione e la config non li elenca. */
function fallbackColumns(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `col_${i + 1}`);
}

export const csvReader: Reader = {
  async *read(rawConfig: unknown, ctx: Ctx): AsyncIterable<Batch> {
    const config = parseCsvConfig(rawConfig);
    const log = ctx.log;

    let columns: string[] | undefined = config.header ? undefined : config.columns;
    let skipped = 0;
    let dataRows = 0;
    let rows: Row[] = [];
    let batchOffset = 0;
    let extraColumnsWarned = false;

    const flush = (): Batch => {
      const batch: Batch = {
        rows,
        meta: { runId: ctx.runId, source: config.path, offset: batchOffset },
      };
      rows = [];
      batchOffset = dataRows;
      return batch;
    };

    for await (const record of parseCsv(decodedChunks(config), {
      delimiter: config.delimiter,
      quote: config.quote,
    })) {
      if (ctx.signal.aborted) return;

      if (skipped < config.skipRows) {
        skipped += 1;
        continue;
      }

      const fields = config.trim ? record.map((value) => value.trim()) : record;

      // Una riga fisicamente vuota e' un separatore visivo, non un dato:
      // conta per skipRows (sopra) ma non diventa una riga di null.
      if (fields.length === 1 && fields[0] === "") continue;

      if (columns === undefined) {
        columns = config.header ? fields : (config.columns ?? fallbackColumns(fields.length));
        if (config.header) continue;
      }

      if (fields.length > columns.length && !extraColumnsWarned) {
        extraColumnsWarned = true;
        log.warn("Righe con colonne in eccesso rispetto all'intestazione: ignorate", {
          source: config.path,
          expected: columns.length,
          found: fields.length,
          offset: dataRows,
        });
      }

      const row: Row = {};
      for (let i = 0; i < columns.length; i += 1) {
        const name = columns[i];
        if (name === undefined) continue;
        // Campo assente != campo vuoto: il primo e' null, il secondo "".
        row[name] = i < fields.length ? (fields[i] ?? null) : null;
      }
      rows.push(row);
      dataRows += 1;

      if (rows.length >= config.batchSize) yield flush();
    }

    if (rows.length > 0) yield flush();
  },
};
