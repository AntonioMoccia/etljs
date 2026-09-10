import { z } from "zod";
import { configInvalid } from "@etl-js/contracts";

/**
 * Config del writer Postgres. `table` e' sempre una tabella di atterraggio
 * (landing): promuovere i dati nelle tabelle di dominio e' compito dell'host,
 * non di questa libreria.
 */
export const postgresConfigSchema = z
  .object({
    table: z
      .string()
      .min(1)
      .describe("Tabella di atterraggio, eventualmente qualificata: schema.tabella"),
    db: z
      .string()
      .min(1)
      .default("default")
      .describe("Nome logico del database fornito dall'host via ctx"),
    columns: z
      .array(z.string().min(1))
      .optional()
      .describe("Colonne e loro ordine; se assente si usano le chiavi del primo lotto"),
    strategy: z
      .enum(["append", "upsert", "replace-by"])
      .default("append")
      .describe("append: accoda. upsert: aggiorna per chiave. replace-by: sostituisce per chiave"),
    replaceKey: z
      .array(z.string().min(1))
      .optional()
      .describe("Chiave di sostituzione, obbligatoria con strategy replace-by"),
    conflictKey: z
      .array(z.string().min(1))
      .optional()
      .describe("Chiave di conflitto, obbligatoria con strategy upsert"),
    truncate: z
      .boolean()
      .default(false)
      .describe("Svuota la destinazione prima di caricare; ha senso solo con append"),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.strategy === "replace-by" && (config.replaceKey?.length ?? 0) === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["replaceKey"],
        message: "obbligatoria quando strategy e' replace-by",
      });
    }
    if (config.truncate && config.strategy !== "append") {
      ctx.addIssue({
        code: "custom",
        path: ["truncate"],
        message: `non ha senso con strategy ${config.strategy}: svuoterebbe la tabella e poi sostituirebbe per chiave`,
      });
    }
    if (config.strategy === "upsert" && (config.conflictKey?.length ?? 0) === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["conflictKey"],
        message: "obbligatoria quando strategy e' upsert",
      });
    }
  });

export type PostgresConfig = z.infer<typeof postgresConfigSchema>;

export function parsePostgresConfig(config: unknown): PostgresConfig {
  const result = postgresConfigSchema.safeParse(config);
  if (result.success) return result.data;
  throw configInvalid(
    "postgres",
    result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  );
}
