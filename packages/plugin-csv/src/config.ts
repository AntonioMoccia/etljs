import { z } from "zod";
import { configInvalid } from "@etl-js/contracts";

/**
 * Config del reader CSV. Tutto cio' che cambia da cliente a cliente sta qui,
 * come valore: delimitatore, encoding, righe di preambolo (I8).
 */
export const csvConfigSchema = z
  .object({
    /**
     * Percorso del file. E' un dato come gli altri: l'host che riceve un file
     * nuovo riscrive questo campo prima di chiamare run().
     */
    path: z.string().min(1).describe("Percorso del file CSV da leggere"),
    delimiter: z.string().min(1).max(4).default(",").describe("Separatore di campo"),
    quote: z.string().length(1).default('"').describe("Carattere di quoting"),
    encoding: z
      .string()
      .default("utf8")
      .describe("Encoding del file: utf8, latin1, windows-1252, ..."),
    skipRows: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Righe di preambolo da buttare prima dell'intestazione"),
    header: z
      .boolean()
      .default(true)
      .describe("La prima riga utile contiene i nomi delle colonne"),
    columns: z
      .array(z.string().min(1))
      .optional()
      .describe("Nomi di colonna espliciti, quando header e' false"),
    batchSize: z.number().int().min(1).max(100_000).default(1_000),
    trim: z.boolean().default(true).describe("Toglie gli spazi ai bordi di ogni campo"),
  })
  .strict();

export type CsvConfig = z.infer<typeof csvConfigSchema>;

/** Valida la config grezza trasformando gli errori di Zod in un IngestError leggibile. */
export function parseCsvConfig(config: unknown): CsvConfig {
  const result = csvConfigSchema.safeParse(config);
  if (result.success) return result.data;
  throw configInvalid(
    "csv",
    result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  );
}
