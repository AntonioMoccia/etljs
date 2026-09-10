import { ErrorCodes, EtlError } from "@etl-js/contracts";

/**
 * Codifica per il formato testo di `COPY ... FROM STDIN`, che e' quello di
 * default di Postgres: campi separati da tabulatore, righe da a capo, NULL
 * scritto `\N`. Tabulatori, a capo e backslash presenti nei dati vanno
 * quotati, altrimenti un indirizzo con un a capo dentro spezza la tabella.
 */
export function encodeCopyValue(value: unknown): string {
  if (value === null || value === undefined) return "\\N";

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new EtlError(`Valore numerico non finito: ${String(value)}`, {
        code: ErrorCodes.DB_ERROR,
        context: { value: String(value) },
      });
    }
    return String(value);
  }

  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new EtlError("Data non valida", { code: ErrorCodes.DB_ERROR });
    }
    return value.toISOString();
  }

  const text = typeof value === "string" ? value : JSON.stringify(value);
  return escapeCopyText(text ?? "");
}

/** L'ordine conta: la backslash va raddoppiata per prima. */
function escapeCopyText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/** Una riga completa, terminatore incluso. */
export function encodeCopyRow(values: readonly unknown[]): string {
  return `${values.map(encodeCopyValue).join("\t")}\n`;
}
