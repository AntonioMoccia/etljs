import { z } from "zod";
import { SQL_OPERATORS, configInvalid } from "../contracts/index.js";

/** Una chiave di ricerca: il campo della riga e, se diverso, la colonna sul database. */
const keySchema = z.union([
  z.string().min(1),
  z
    .object({
      field: z.string().min(1).describe("Campo della riga"),
      column: z.string().min(1).describe("Colonna della tabella cercata"),
    })
    .strict(),
]);

/** Che fare quando la corrispondenza non esiste. */
const onMissingSchema = z
  .enum(["reject", "warn", "skip"])
  .default("reject")
  .describe(
    "reject: scarta la riga e la segnala. warn: la tiene coi campi a null e la segnala. skip: la scarta in silenzio",
  );

export const lookupConfigSchema = z
  .object({
    db: z.string().min(1).describe("Nome logico del database fornito dall'host"),
    table: z.string().min(1).describe("Tabella da cercare, eventualmente schema.tabella"),
    on: z
      .array(keySchema)
      .min(1)
      .describe("Chiavi di ricerca: campo della riga, o { field, column }"),
    select: z
      .union([
        z.string().min(1),
        z.array(z.string().min(1)).min(1),
        z.record(z.string().min(1), z.string().min(1)),
      ])
      .describe("Colonne da riportare: una, un elenco, o mappa colonna -> campo"),
    onMissing: onMissingSchema,
    onDuplicate: z
      .enum(["reject", "first"])
      .default("reject")
      .describe("reject: piu' corrispondenze sono un errore. first: prende la prima"),
    filter: z
      .array(
        z
          .object({
            column: z.string().min(1),
            op: z.enum(Object.keys(SQL_OPERATORS) as [string, ...string[]]),
            value: z.unknown().optional(),
          })
          .strict(),
      )
      .optional()
      .describe("Condizioni aggiuntive sulla tabella cercata, con operatori in whitelist"),
  })
  .strict();

export type LookupConfig = z.infer<typeof lookupConfigSchema>;

export function parseLookupConfig(config: unknown): LookupConfig {
  const result = lookupConfigSchema.safeParse(config);
  if (result.success) return result.data;
  throw configInvalid(
    "lookup",
    result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  );
}

/** Chiavi normalizzate: sempre coppia campo/colonna. */
export function normalizeKeys(config: LookupConfig): { field: string; column: string }[] {
  return config.on.map((key) =>
    typeof key === "string" ? { field: key, column: key } : { field: key.field, column: key.column },
  );
}

/** Colonne da riportare, normalizzate in coppie colonna/campo di destinazione. */
export function normalizeSelect(config: LookupConfig): { column: string; field: string }[] {
  const { select } = config;
  if (typeof select === "string") return [{ column: select, field: select }];
  if (Array.isArray(select)) return select.map((column) => ({ column, field: column }));
  return Object.entries(select).map(([column, field]) => ({ column, field }));
}
