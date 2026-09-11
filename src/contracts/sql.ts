/**
 * Utility SQL puramente sintattiche, senza dipendenze: vivono qui perche'
 * servono ai plugin, e un plugin non puo' importare il core (I9).
 *
 * Regola I7: i VALORI passano sempre come parametri ($1, $2...); solo gli
 * IDENTIFICATORI vengono interpolati, e solo dopo escapeIdentifier.
 */
import { EtlError, ErrorCodes } from "./errors.js";

/**
 * Racchiude un identificatore fra doppi apici raddoppiando quelli interni,
 * come fa `PQescapeIdentifier` di libpq.
 */
export function escapeIdentifier(identifier: string): string {
  if (typeof identifier !== "string" || identifier.length === 0) {
    throw new EtlError("Identificatore SQL vuoto", {
      code: ErrorCodes.INVALID_USAGE,
      context: { identifier },
    });
  }
  // Il byte NUL non e' rappresentabile in un identificatore Postgres.
  if (identifier.includes("\u0000")) {
    throw new EtlError("Identificatore SQL con byte NUL", {
      code: ErrorCodes.INVALID_USAGE,
      context: { identifier },
    });
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Escapa un nome eventualmente qualificato (`schema.tabella`) preservando la
 * qualificazione. Un punto dentro il nome va scritto come `"a.b"` dal chiamante.
 */
export function escapeQualifiedName(name: string): string {
  return name
    .split(".")
    .map((part) => escapeIdentifier(part))
    .join(".");
}

/** Whitelist: qualunque operatore fuori da qui e' un errore, non un passaggio a SQL grezzo. */
export const SQL_OPERATORS = {
  eq: "=",
  neq: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  like: "LIKE",
  ilike: "ILIKE",
  is_null: "IS NULL",
  is_not_null: "IS NOT NULL",
} as const;

export type SqlOperatorName = keyof typeof SQL_OPERATORS;

/** Traduce il nome logico di un operatore nel suo simbolo SQL, o fallisce. */
export function sqlOperator(name: string): string {
  const operator = (SQL_OPERATORS as Record<string, string | undefined>)[name];
  if (operator === undefined) {
    throw new EtlError(`Operatore SQL non ammesso: ${name}`, {
      code: ErrorCodes.INVALID_USAGE,
      context: { operator: name, allowed: Object.keys(SQL_OPERATORS) },
    });
  }
  return operator;
}

/** Segnaposto posizionali `$1, $2, ...` a partire da `start` (1-based). */
export function placeholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, i) => `$${start + i}`).join(", ");
}
