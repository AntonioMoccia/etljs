import { PROTOCOL_VERSION, configInvalid, type TransformerPlugin } from "@etl-js/contracts";
import { z } from "zod";
import {
  type Batch,
  type Ctx,
  type Failed,
  type Row,
  type TransformResult,
  type Transformer,
} from "@etl-js/contracts";

/**
 * Butta via le righe che non sono dati: intestazioni ripetute, righe di totale,
 * righe vuote, righe senza chiave. Un CSV di cliente ne e' pieno, e nessuna di
 * esse deve arrivare al gestionale.
 */
const conditionSchema = z
  .object({
    field: z.string().min(1).optional().describe("Campo su cui applicare la condizione"),
    empty: z.boolean().optional().describe("Vero se il campo e' assente, null o solo spazi"),
    notEmpty: z.boolean().optional(),
    equals: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    notEquals: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    matches: z.string().optional().describe("Espressione regolare sul valore"),
    ignoreCase: z.boolean().default(false),
    in: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    allEmpty: z.boolean().optional().describe("Vero se tutti i campi della riga sono vuoti"),
  })
  .strict();

export const filterConfigSchema = z
  .object({
    keep: z.array(conditionSchema).optional().describe("Tiene solo le righe che soddisfano una di queste"),
    drop: z.array(conditionSchema).optional().describe("Scarta le righe che soddisfano una di queste"),
    report: z
      .boolean()
      .default(false)
      .describe("Se vero le righe filtrate compaiono fra gli scarti con severita' warn"),
  })
  .strict();

export type FilterConfig = z.infer<typeof filterConfigSchema>;
type Condition = z.infer<typeof conditionSchema>;

export const FilterErrorCodes = {
  /** Riga eliminata da una regola del filtro (solo con report: true). */
  FILTERED: "FILTERED",
} as const;

/** Le chiavi che descrivono il campo, non una condizione da verificare. */
const NOT_A_TEST = new Set(["field", "ignoreCase"]);

function parseConfig(raw: unknown): FilterConfig {
  const result = filterConfigSchema.safeParse(raw);
  if (!result.success) {
    throw configInvalid(
      "filter",
      result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  const config = result.data;
  for (const [group, rules] of [
    ["keep", config.keep],
    ["drop", config.drop],
  ] as const) {
    (rules ?? []).forEach((rule, index) => {
      const tests = Object.keys(rule).filter(
        (key) => !NOT_A_TEST.has(key) && rule[key as keyof Condition] !== undefined,
      );
      if (tests.length === 0) {
        throw configInvalid("filter", [
          {
            path: `${group}[${index}]`,
            message: "una regola senza condizioni scarterebbe tutto: dichiara cosa cercare",
          },
        ]);
      }
      if (!rule.allEmpty && rule.field === undefined) {
        throw configInvalid("filter", [
          { path: `${group}[${index}].field`, message: "manca il campo su cui applicare la condizione" },
        ]);
      }
      if (rule.matches !== undefined) compileRegex(rule, `${group}[${index}].matches`);
    });
  }
  return config;
}

function compileRegex(rule: Condition, path: string): RegExp {
  try {
    return new RegExp(rule.matches ?? "", rule.ignoreCase ? "i" : "");
  } catch (error) {
    throw configInvalid("filter", [
      { path, message: `espressione regolare non valida: ${String(error)}` },
    ]);
  }
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === "";
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Tutte le condizioni di una regola devono valere insieme. */
function matches(rule: Condition, row: Row, path: string): boolean {
  if (rule.allEmpty === true && !Object.values(row).every(isEmpty)) return false;
  if (rule.allEmpty === false && Object.values(row).every(isEmpty)) return false;
  if (rule.field === undefined) return true;

  const value = row[rule.field];

  if (rule.empty !== undefined && isEmpty(value) !== rule.empty) return false;
  if (rule.notEmpty !== undefined && isEmpty(value) === rule.notEmpty) return false;
  if (rule.equals !== undefined && String(value ?? "") !== String(rule.equals ?? "")) return false;
  if (rule.notEquals !== undefined && String(value ?? "") === String(rule.notEquals ?? "")) return false;
  if (rule.matches !== undefined && !compileRegex(rule, path).test(String(value ?? ""))) return false;
  if (rule.in !== undefined && !rule.in.some((entry) => String(entry ?? "") === String(value ?? ""))) {
    return false;
  }

  const numeric = asNumber(value);
  if (rule.gt !== undefined && !(numeric !== undefined && numeric > rule.gt)) return false;
  if (rule.gte !== undefined && !(numeric !== undefined && numeric >= rule.gte)) return false;
  if (rule.lt !== undefined && !(numeric !== undefined && numeric < rule.lt)) return false;
  if (rule.lte !== undefined && !(numeric !== undefined && numeric <= rule.lte)) return false;

  return true;
}

const parsedConfigs = new WeakMap<object, FilterConfig>();

function configOf(raw: unknown): FilterConfig {
  if (typeof raw !== "object" || raw === null) return parseConfig(raw);
  const cached = parsedConfigs.get(raw);
  if (cached) return cached;
  const parsed = parseConfig(raw);
  parsedConfigs.set(raw, parsed);
  return parsed;
}

export const filterTransformer: Transformer = {
  async transform(batch: Batch, rawConfig: unknown, _ctx: Ctx): Promise<TransformResult> {
    const config = configOf(rawConfig);
    const kept: Row[] = [];
    const failed: Failed[] = [];

    batch.rows.forEach((row, index) => {
      const offset = batch.meta.offset + index;

      // Prima si decide cosa tenere, poi cosa buttare: cosi' `drop` puo'
      // togliere dei casi da dentro cio' che `keep` ha selezionato.
      if (config.keep && !config.keep.some((rule, i) => matches(rule, row, `keep[${i}]`))) {
        if (config.report) {
          failed.push({
            row,
            reason: "la riga non soddisfa alcuna regola keep",
            code: FilterErrorCodes.FILTERED,
            severity: "warn",
            offset,
          });
        }
        return;
      }

      const dropIndex = (config.drop ?? []).findIndex((rule, i) =>
        matches(rule, row, `drop[${i}]`),
      );
      if (dropIndex >= 0) {
        if (config.report) {
          failed.push({
            row,
            reason: `la riga corrisponde alla regola drop[${dropIndex}]`,
            code: FilterErrorCodes.FILTERED,
            severity: "warn",
            offset,
          });
        }
        return;
      }

      kept.push(row);
    });

    return { batch: { ...batch, rows: kept }, failed };
  },
};

export const plugin: TransformerPlugin = {
  manifest: {
    name: "filter",
    version: "0.1.0",
    kind: "transformer",
    protocol: PROTOCOL_VERSION,
    category: "selezione",
    configSchema: z.toJSONSchema(filterConfigSchema, { io: "input" }),
  },
  impl: filterTransformer,
};

export default plugin;
