import {
  PROTOCOL_VERSION,
  type Batch,
  type Ctx,
  type Row,
  type TransformResult,
  type Transformer,
  type TransformerPlugin,
} from "../contracts/index.js";
import { z } from "zod";
import { configReader } from "./shared.js";

const literal = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const whenSchema = z
  .enum(["missing", "empty", "always"])
  .default("empty")
  .describe(
    "missing: solo se la chiave non c'e'. empty: anche se e' vuota o null. always: sovrascrive sempre",
  );

const valueSchema = z.union([
  z.object({ value: literal, when: whenSchema }).strict(),
  z
    .object({ fromMeta: z.enum(["runId", "source", "offset"]), when: whenSchema })
    .strict()
    .describe("Provenienza della riga: identificativo del run, file di origine, numero di riga"),
  z
    .object({ fromField: z.string().min(1), when: whenSchema })
    .strict()
    .describe("Copia il valore di un altro campo della stessa riga"),
  literal,
]);

export const defaultConfigSchema = z
  .object({
    values: z
      .record(z.string().min(1), valueSchema)
      .describe("Campo -> valore da usare quando manca"),
  })
  .strict();

export type DefaultConfig = z.infer<typeof defaultConfigSchema>;



function shouldFill(row: Row, field: string, when: "missing" | "empty" | "always"): boolean {
  if (when === "always") return true;
  if (!(field in row)) return true;
  if (when === "missing") return false;
  const value = row[field];
  return value === null || value === undefined || String(value).trim() === "";
}

const configOf = configReader("default", defaultConfigSchema);

export const defaultTransformer: Transformer = {
  async transform(batch: Batch, rawConfig: unknown, _ctx: Ctx): Promise<TransformResult> {
    const config = configOf(rawConfig);
    const entries = Object.entries(config.values);

    const rows = batch.rows.map((row, index) => {
      const filled: Row = { ...row };
      for (const [field, spec] of entries) {
        const when =
          typeof spec === "object" && spec !== null && "when" in spec ? spec.when : "empty";
        if (!shouldFill(row, field, when)) continue;

        if (typeof spec === "object" && spec !== null && "fromMeta" in spec) {
          filled[field] =
            spec.fromMeta === "offset" ? batch.meta.offset + index : batch.meta[spec.fromMeta];
        } else if (typeof spec === "object" && spec !== null && "fromField" in spec) {
          // Un campo di provenienza assente vale null: non si inventa un valore.
          filled[field] = row[spec.fromField] ?? null;
        } else if (typeof spec === "object" && spec !== null && "value" in spec) {
          filled[field] = spec.value;
        } else {
          filled[field] = spec;
        }
      }
      return filled;
    });

    return { batch: { ...batch, rows }, failed: [] };
  },
};

/**
 * Riempie i campi che il flusso non manda. Non scarta mai nulla: se un campo
 * obbligatorio manca ed e' un problema, e' `validate` a doverlo dire.
 *
 * `fromMeta` marca ogni riga con la sua provenienza (run, file, numero di riga):
 * cosi' la tabella di atterraggio sa da dove viene ogni record senza che il
 * motore debba conoscere le colonne di nessuno (I2).
 */
export const defaultPlugin: TransformerPlugin = {
  manifest: {
    name: "default",
    version: "0.1.0",
    kind: "transformer",
    protocol: PROTOCOL_VERSION,
    category: "completamento",
    configSchema: z.toJSONSchema(defaultConfigSchema, { io: "input" }),
  },
  impl: defaultTransformer,
};

