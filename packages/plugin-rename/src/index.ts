import {
  PROTOCOL_VERSION,
  configInvalid,
  type Batch,
  type Ctx,
  type Failed,
  type Row,
  type TransformResult,
  type Transformer,
  type TransformerPlugin,
} from "@etl-js/contracts";
import { z } from "zod";

/**
 * Porta le intestazioni del cliente sui nomi usati dal gestionale. E' il
 * plugin che rende inutile scrivere un pacchetto per cliente: cambiano le
 * chiavi della mappa, non il codice (I8).
 */
export const renameConfigSchema = z
  .object({
    map: z
      .record(z.string().min(1), z.string().min(1))
      .describe("Intestazione del cliente -> nome interno"),
    keepUnmapped: z
      .boolean()
      .default(true)
      .describe("Se falso tiene solo i campi nominati nella mappa"),
    drop: z.array(z.string().min(1)).optional().describe("Campi da eliminare"),
    strict: z
      .boolean()
      .default(false)
      .describe("Se vero, una colonna attesa e assente scarta la riga invece di ignorarla"),
    trimKeys: z
      .boolean()
      .default(false)
      .describe("Toglie gli spazi ai bordi delle intestazioni prima di confrontarle"),
  })
  .strict();

export type RenameConfig = z.infer<typeof renameConfigSchema>;

export const RenameErrorCodes = {
  /** Una colonna dichiarata nella mappa non esiste nella riga. */
  RENAME_MISSING_COLUMN: "RENAME_MISSING_COLUMN",
} as const;

function parseConfig(raw: unknown): RenameConfig {
  const result = renameConfigSchema.safeParse(raw);
  if (!result.success) {
    throw configInvalid(
      "rename",
      result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  const config = result.data;

  // Due colonne che finiscono sullo stesso nome perderebbero un dato in silenzio.
  const seen = new Map<string, string>();
  for (const [from, to] of Object.entries(config.map)) {
    const previous = seen.get(to);
    if (previous) {
      throw configInvalid("rename", [
        { path: `map.${from}`, message: `"${previous}" e "${from}" finiscono entrambi su "${to}"` },
      ]);
    }
    seen.set(to, from);
  }
  return config;
}

const parsedConfigs = new WeakMap<object, RenameConfig>();

function configOf(raw: unknown): RenameConfig {
  if (typeof raw !== "object" || raw === null) return parseConfig(raw);
  const cached = parsedConfigs.get(raw);
  if (cached) return cached;
  const parsed = parseConfig(raw);
  parsedConfigs.set(raw, parsed);
  return parsed;
}

export const renameTransformer: Transformer = {
  async transform(batch: Batch, rawConfig: unknown, _ctx: Ctx): Promise<TransformResult> {
    const config = configOf(rawConfig);
    const normalize = (key: string): string => (config.trimKeys ? key.trim() : key);
    const map = new Map(
      Object.entries(config.map).map(([from, to]) => [normalize(from), to] as const),
    );
    const dropped = new Set((config.drop ?? []).map(normalize));

    const kept: Row[] = [];
    const failed: Failed[] = [];

    batch.rows.forEach((row, index) => {
      const offset = batch.meta.offset + index;
      const source = new Map<string, unknown>();
      for (const [key, value] of Object.entries(row)) source.set(normalize(key), value);

      if (config.strict) {
        const missing = [...map.keys()].filter((key) => !source.has(key));
        if (missing.length > 0) {
          failed.push({
            row,
            reason: `colonne attese e assenti: ${missing.join(", ")}`,
            code: RenameErrorCodes.RENAME_MISSING_COLUMN,
            severity: "reject",
            offset,
          });
          return;
        }
      }

      // Prima i campi della mappa, nel suo ordine: la tabella di atterraggio
      // deve avere colonne prevedibili, non l'ordine casuale del file.
      const renamed: Row = {};
      for (const [from, to] of map) {
        if (source.has(from)) renamed[to] = source.get(from);
      }
      if (config.keepUnmapped) {
        for (const [key, value] of source) {
          if (map.has(key) || dropped.has(key)) continue;
          renamed[key] = value;
        }
      }
      kept.push(renamed);
    });

    return { batch: { ...batch, rows: kept }, failed };
  },
};

export const plugin: TransformerPlugin = {
  manifest: {
    name: "rename",
    version: "0.1.0",
    kind: "transformer",
    protocol: PROTOCOL_VERSION,
    category: "struttura",
    configSchema: z.toJSONSchema(renameConfigSchema, { io: "input" }),
  },
  impl: renameTransformer,
};

export default plugin;
