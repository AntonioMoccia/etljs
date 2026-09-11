import { z } from "zod";
import { configInvalid } from "../contracts/index.js";

/**
 * Config del reader CSV. Tutto cio' che cambia da flusso a flusso sta qui,
 * come valore: delimitatore, encoding, righe di preambolo, nomi di colonna (I8).
 */
export const csvConfigSchema = z
  .object({
    /**
     * Riferimento alla sorgente, risolto da `ctx.openInput`. In sviluppo e'
     * un path; in produzione una chiave su object storage. Il reader non lo
     * interpreta mai da se' (I6).
     */
    input: z.string().min(1).describe("Riferimento alla sorgente, risolto dall'host"),
    delimiter: z.string().min(1).max(4).default(",").describe("Separatore di campo"),
    quote: z.string().length(1).default('"').describe("Carattere di quoting"),
    encoding: z
      .enum(["utf8", "latin1"])
      .default("utf8")
      .describe("Encoding del file; latin1 copre i CSV esportati da sistemi esterni europei"),
    skipRows: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Righe di preambolo da buttare prima dell'intestazione"),
    header: z
      .union([z.boolean(), z.array(z.string().min(1)).min(1)])
      .default(true)
      .describe(
        "true: la prima riga utile porta i nomi. Elenco: nomi espliciti. false: chiavi posizionali c0, c1, ...",
      ),
    trim: z.boolean().default(true).describe("Toglie gli spazi ai bordi di ogni campo"),
    batchSize: z.number().int().min(1).max(100_000).default(1_000).describe("Righe per lotto"),
    bom: z.boolean().default(true).describe("Toglie il BOM iniziale, se presente"),
  })
  .strict();

export type CsvConfig = z.infer<typeof csvConfigSchema>;

/** Valida la config grezza trasformando gli errori di Zod in un EtlError leggibile. */
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
