import {
  PROTOCOL_VERSION,
  configInvalid,
  createRunCache,
  isBlank,
  type Batch,
  type Ctx,
  type Failed,
  type Row,
  type Severity,
  type TransformResult,
  type Transformer,
  type TransformerPlugin,
} from "@etl-js/contracts";
import { z } from "zod";
import { compileRegex, configReader } from "./shared.js";

/**
 * Controlla le regole di merito sui dati gia' convertiti: quantita' minime,
 * date plausibili, codici duplicati. Ogni regola dice da se' se una violazione
 * ferma la riga (`reject`) o si limita a segnalarla (`warn`).
 */
const ruleSchema = z
  .object({
    field: z.string().min(1),
    severity: z.enum(["reject", "warn"]).default("reject"),
    message: z.string().min(1).optional().describe("Motivo su misura al posto di quello automatico"),
    required: z.boolean().optional().describe("Il campo deve esserci e non essere vuoto"),
    min: z.number().optional(),
    max: z.number().optional(),
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(0).optional(),
    matches: z.string().optional(),
    ignoreCase: z.boolean().default(false),
    in: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    notBefore: z.string().min(1).optional().describe('Data ISO oppure "today"'),
    notAfter: z.string().min(1).optional().describe('Data ISO oppure "today"'),
    unique: z.boolean().optional().describe("Il valore non deve ripetersi nel run"),
  })
  .strict();

export const validateConfigSchema = z
  .object({ rules: z.array(ruleSchema).min(1) })
  .strict();

export type ValidateConfig = z.infer<typeof validateConfigSchema>;
type Rule = z.infer<typeof ruleSchema>;

export const ValidateErrorCodes = {
  /** Una regola di merito non e' rispettata. */
  VALIDATION_FAILED: "VALIDATION_FAILED",
} as const;

/** Chiavi che descrivono la regola, non un controllo. */
const NOT_A_CHECK = new Set(["field", "severity", "message", "ignoreCase"]);




/** Valori gia' visti, per le regole `unique`, liberati da flush() a fine run. */
const seenByRun = createRunCache<Map<string, Set<string>>>(() => new Map());

function seenFor(runId: string, field: string): Set<string> {
  const perRun = seenByRun.for(runId);
  let values = perRun.get(field);
  if (!values) {
    values = new Set();
    perRun.set(field, values);
  }
  return values;
}


const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** Le date viaggiano come stringhe ISO: il confronto lessicografico basta e avanza. */
function asIsoDate(value: unknown): string | undefined {
  const text = String(value).trim();
  return ISO_DATE.test(text) ? text.slice(0, 10) : undefined;
}

function boundary(spec: string): string {
  if (spec !== "today") return spec.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

/** Il primo motivo per cui la riga non va bene, o undefined se va bene. */
function violation(rule: Rule, row: Row, runId: string): string | undefined {
  const value = row[rule.field];
  const label = `campo "${rule.field}"`;

  if (rule.required && isBlank(value)) return `${label}: obbligatorio ma vuoto`;
  // Un campo vuoto non facoltativo non deve far scattare i controlli di merito:
  // se e' un problema lo dice `required`.
  if (isBlank(value)) return undefined;

  const text = String(value);

  if (rule.min !== undefined || rule.max !== undefined) {
    const numeric = typeof value === "number" ? value : Number(text);
    if (!Number.isFinite(numeric)) return `${label}: "${text}" non e' un numero`;
    if (rule.min !== undefined && numeric < rule.min) {
      return `${label}: ${numeric} e' sotto il minimo ${rule.min}`;
    }
    if (rule.max !== undefined && numeric > rule.max) {
      return `${label}: ${numeric} supera il massimo ${rule.max}`;
    }
  }

  if (rule.minLength !== undefined && text.length < rule.minLength) {
    return `${label}: "${text}" e' piu' corto di ${rule.minLength} caratteri`;
  }
  if (rule.maxLength !== undefined && text.length > rule.maxLength) {
    return `${label}: "${text}" supera i ${rule.maxLength} caratteri`;
  }
  if (
    rule.matches !== undefined &&
    !compileRegex("validate", rule.field, rule.matches, rule.ignoreCase).test(text)
  ) {
    return `${label}: "${text}" non corrisponde a ${rule.matches}`;
  }
  if (rule.in !== undefined && !rule.in.some((entry) => String(entry) === text)) {
    return `${label}: "${text}" non e' fra i valori ammessi (${rule.in.join(", ")})`;
  }

  if (rule.notBefore !== undefined || rule.notAfter !== undefined) {
    const date = asIsoDate(value);
    if (!date) return `${label}: "${text}" non e' una data ISO (yyyy-MM-dd)`;
    if (rule.notBefore !== undefined && date < boundary(rule.notBefore)) {
      return `${label}: ${date} e' precedente a ${boundary(rule.notBefore)}`;
    }
    if (rule.notAfter !== undefined && date > boundary(rule.notAfter)) {
      return `${label}: ${date} e' successivo a ${boundary(rule.notAfter)}`;
    }
  }

  if (rule.unique) {
    const seen = seenFor(runId, rule.field);
    if (seen.has(text)) return `${label}: "${text}" e' gia' comparso in questo run`;
    seen.add(text);
  }

  return undefined;
}

const configOf = configReader("validate", validateConfigSchema, (config) => {
  config.rules.forEach((rule, index) => {
    const checks = Object.keys(rule).filter(
      (key) => !NOT_A_CHECK.has(key) && rule[key as keyof typeof rule] !== undefined,
    );
    if (checks.length === 0) {
      throw configInvalid("validate", [
        { path: `rules[${index}]`, message: "la regola non controlla nulla" },
      ]);
    }
    if (rule.matches !== undefined) {
      compileRegex("validate", `rules[${index}].matches`, rule.matches, rule.ignoreCase);
    }
  });
});

export const validateTransformer: Transformer = {
  async transform(batch: Batch, rawConfig: unknown, ctx: Ctx): Promise<TransformResult> {
    const config = configOf(rawConfig);
    const kept: Row[] = [];
    const failed: Failed[] = [];

    batch.rows.forEach((row, index) => {
      const offset = batch.meta.offset + index;
      let rejected = false;

      for (const rule of config.rules) {
        const reason = violation(rule, row, ctx.runId);
        if (reason === undefined) continue;
        const severity: Severity = rule.severity;
        if (severity === "reject") rejected = true;
        failed.push({
          row,
          reason: rule.message ?? reason,
          code: ValidateErrorCodes.VALIDATION_FAILED,
          severity,
          offset,
        });
      }

      if (!rejected) kept.push(row);
    });

    return { batch: { ...batch, rows: kept }, failed };
  },

  async flush(ctx: Ctx): Promise<TransformResult> {
    seenByRun.release(ctx.runId);
    return {
      batch: { rows: [], meta: { runId: ctx.runId, source: "validate", offset: 0 } },
      failed: [],
    };
  },
};

export const validatePlugin: TransformerPlugin = {
  manifest: {
    name: "validate",
    version: "0.1.0",
    kind: "transformer",
    protocol: PROTOCOL_VERSION,
    category: "controllo",
    capabilities: ["severity", "unique-per-run"],
    configSchema: z.toJSONSchema(validateConfigSchema, { io: "input" }),
  },
  impl: validateTransformer,
};

