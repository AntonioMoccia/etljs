/**
 * Parser CSV incrementale: consuma chunk di testo di dimensione arbitraria e
 * emette record. Non conosce le intestazioni ne' i tipi: restituisce campi
 * grezzi, e sono i transformer a dare loro un significato.
 *
 * E' scritto a mano perche' serve streaming vero (un record puo' essere
 * spezzato a meta' fra due chunk) e perche' e' l'unica alternativa a una
 * dipendenza runtime nel plugin piu' usato del progetto.
 */
export interface CsvParserOptions {
  /** Separatore di campo. Default: virgola. */
  delimiter?: string;
  /** Carattere di quoting. Default: doppio apice. */
  quote?: string;
}

const BOM = "﻿";

export async function* parseCsv(
  source: AsyncIterable<string>,
  options: CsvParserOptions = {},
): AsyncGenerator<string[]> {
  const delimiter = options.delimiter ?? ",";
  const quote = options.quote ?? '"';

  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  /** Abbiamo appena visto un apice dentro un campo quotato e non sappiamo ancora se chiude o raddoppia. */
  let quotePending = false;
  /** Il record corrente ha del contenuto: a fine stream distingue "coda da emettere" da "niente". */
  let hasContent = false;
  /** Un CR in attesa: serve a mangiare il LF di un CRLF spezzato fra due chunk. */
  let pendingCr = false;
  let firstChunk = true;

  const endField = (): void => {
    fields.push(field);
    field = "";
  };

  const endRecord = (): string[] => {
    fields.push(field);
    const record = fields;
    fields = [];
    field = "";
    hasContent = false;
    return record;
  };

  for await (const rawChunk of source) {
    let chunk = rawChunk;
    if (firstChunk) {
      firstChunk = false;
      if (chunk.startsWith(BOM)) chunk = chunk.slice(BOM.length);
    }

    let i = 0;
    while (i < chunk.length) {
      const char = chunk.charAt(i);

      if (pendingCr) {
        pendingCr = false;
        // Il LF di un CRLF e' gia' stato consumato come fine record.
        if (char === "\n") {
          i += 1;
          continue;
        }
      }

      if (quotePending) {
        quotePending = false;
        if (char === quote) {
          // Apice raddoppiato: e' un apice letterale dentro il campo.
          field += quote;
          i += 1;
          continue;
        }
        // L'apice precedente chiudeva il campo: il carattere corrente va
        // rivalutato fuori dal contesto quotato.
        inQuotes = false;
        continue;
      }

      if (inQuotes) {
        if (char === quote) quotePending = true;
        else field += char;
        i += 1;
        continue;
      }

      if (char === quote && field.length === 0) {
        inQuotes = true;
        hasContent = true;
        i += 1;
        continue;
      }

      if (chunk.startsWith(delimiter, i)) {
        endField();
        hasContent = true;
        i += delimiter.length;
        continue;
      }

      if (char === "\n" || char === "\r") {
        // Ogni terminatore chiude una riga fisica, anche se la riga e' vuota:
        // skipRows deve contare le righe come le conta chi apre il file.
        if (char === "\r") pendingCr = true;
        i += 1;
        yield endRecord();
        continue;
      }

      field += char;
      hasContent = true;
      i += 1;
    }
  }

  if (quotePending) inQuotes = false;
  if (hasContent || field.length > 0 || fields.length > 0) {
    yield endRecord();
  }
}
