import {
  PROTOCOL_VERSION,
  isBlank,
  type Batch,
  type Ctx,
  type Failed,
  type Row,
  type TransformResult,
  type Transformer,
  type TransformerPlugin,
} from "@etl-js/contracts";
import { z } from "zod";
import { castConfigSchema, type CastField } from "./cast-config.js";
import { configReader } from "./shared.js";
import {
  compileFormat,
  isoWeekMonday,
  matchFormat,
  toIsoDate,
  toIsoDateTime,
  type CompiledFormat,
} from "./formats.js";

export const CastErrorCodes = {
  /** Il valore non e' convertibile nel tipo richiesto. */
  CAST_FAILED: "CAST_FAILED",
} as const;

const formatCache = new Map<string, CompiledFormat>();

function formatFor(format: string): CompiledFormat {
  const cached = formatCache.get(format);
  if (cached) return cached;
  const compiled = compileFormat(format);
  formatCache.set(format, compiled);
  return compiled;
}

const configOf = configReader("cast", castConfigSchema);

interface NumberOptions {
  decimal: string;
  thousands?: string | undefined;
  strip?: string | undefined;
}

/**
 * Da "1.250,50" a 1250.5. Le parentesi contabili valgono un segno meno, come
 * nei fogli di calcolo da cui questi CSV vengono esportati.
 */
function toNumber(value: unknown, options: NumberOptions): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;

  let text = String(value).trim();
  let negative = false;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (options.strip) {
    for (const char of options.strip) text = text.split(char).join("");
  }
  if (options.thousands) text = text.split(options.thousands).join("");
  if (options.decimal !== ".") text = text.split(options.decimal).join(".");
  text = text.replace(/\s/g, "");

  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return undefined;
  return negative ? -parsed : parsed;
}

/** Restituisce il valore convertito, oppure il motivo per cui non si puo'. */
function convert(field: CastField, value: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  if ("date" in field || "datetime" in field || "week" in field) {
    const pattern = "date" in field ? field.date : "datetime" in field ? field.datetime : field.week;
    const compiled = formatFor(pattern);
    const parts = matchFormat(compiled, String(value));
    if (!parts) {
      return { ok: false, reason: `"${String(value)}" non rispetta il formato ${pattern}` };
    }
    if ("week" in field) {
      const monday = parts.week === undefined ? undefined : isoWeekMonday(parts.year, parts.week);
      return monday
        ? { ok: true, value: monday }
        : { ok: false, reason: `la settimana "${String(value)}" non esiste nel calendario ISO` };
    }
    const iso = "date" in field ? toIsoDate(parts) : toIsoDateTime(parts);
    return iso
      ? { ok: true, value: iso }
      : { ok: false, reason: `"${String(value)}" non e' una data esistente` };
  }

  if ("number" in field || "integer" in field) {
    const options = "number" in field ? field.number : field.integer;
    const parsed = toNumber(value, options);
    if (parsed === undefined) {
      return { ok: false, reason: `"${String(value)}" non e' un numero` };
    }
    if ("integer" in field && !Number.isInteger(parsed)) {
      return { ok: false, reason: `"${String(value)}" ha dei decimali ma il campo e' intero` };
    }
    return { ok: true, value: parsed };
  }

  if ("boolean" in field) {
    const text = String(value).trim().toLowerCase();
    if (field.boolean.true.some((entry) => entry.trim().toLowerCase() === text)) {
      return { ok: true, value: true };
    }
    if (field.boolean.false.some((entry) => entry.trim().toLowerCase() === text)) {
      return { ok: true, value: false };
    }
    return {
      ok: false,
      reason: `"${String(value)}" non e' fra i valori previsti (${[...field.boolean.true, ...field.boolean.false].join(", ")})`,
    };
  }

  let text = String(value);
  if (field.string.trim) text = text.trim();
  if (field.string.case === "upper") text = text.toUpperCase();
  if (field.string.case === "lower") text = text.toLowerCase();
  return { ok: true, value: text };
}

export const castTransformer: Transformer = {
  async transform(batch: Batch, rawConfig: unknown, _ctx: Ctx): Promise<TransformResult> {
    const config = configOf(rawConfig);
    const entries = Object.entries(config);
    const kept: Row[] = [];
    const failed: Failed[] = [];

    batch.rows.forEach((row, index) => {
      const offset = batch.meta.offset + index;
      const converted: Row = { ...row };
      let drop = false;
      let silent = false;

      for (const [name, field] of entries) {
        const value = row[name];

        if (isBlank(value)) {
          if (field.nullable) {
            converted[name] = null;
            continue;
          }
          const problem = {
            row,
            reason: `il campo "${name}" e' vuoto e non e' dichiarato nullable`,
            code: CastErrorCodes.CAST_FAILED,
            offset,
          };
          if (field.onError === "skip") {
            drop = true;
            silent = true;
          } else if (field.onError === "warn") {
            converted[name] = null;
            failed.push({ ...problem, severity: "warn" });
          } else {
            drop = true;
            failed.push({ ...problem, severity: "reject" });
          }
          continue;
        }

        const result = convert(field, value);
        if (result.ok) {
          converted[name] = result.value;
          continue;
        }

        const problem = {
          row,
          reason: `campo "${name}": ${result.reason}`,
          code: CastErrorCodes.CAST_FAILED,
          offset,
        };
        if (field.onError === "skip") {
          drop = true;
          silent = true;
        } else if (field.onError === "warn") {
          converted[name] = null;
          failed.push({ ...problem, severity: "warn" });
        } else {
          drop = true;
          failed.push({ ...problem, severity: "reject" });
        }
      }

      if (!drop) kept.push(converted);
      else if (silent) {
        // "skip" non lascia traccia: e' la politica scelta dalla config.
      }
    });

    return { batch: { ...batch, rows: kept }, failed };
  },
};

/**
 * Converte i valori grezzi in cio' che il database si aspetta. Tutto cio' che
 * cambia da cliente a cliente - formato data, separatore decimale, parole per
 * vero e falso - e' un valore in questa config (I8).
 *
 * Le date escono come stringhe ISO, non come oggetti Date: un Batch deve
 * restare serializzabile (I3).
 */
export const castPlugin: TransformerPlugin = {
  manifest: {
    name: "cast",
    version: "0.1.0",
    kind: "transformer",
    protocol: PROTOCOL_VERSION,
    category: "conversione",
    capabilities: ["date", "settimane-iso", "numeri-localizzati"],
    configSchema: z.toJSONSchema(castConfigSchema, { io: "input" }),
  },
  impl: castTransformer,
};
