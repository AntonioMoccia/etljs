import {
  ErrorCodes,
  EtlError,
  createRunCache,
  escapeIdentifier,
  escapeQualifiedName,
  isBlank,
  sqlOperator,
  type Batch,
  type Ctx,
  type Failed,
  type ReadOnlyDb,
  type Row,
  type TransformResult,
  type Transformer,
} from "../contracts/index.js";
import {
  normalizeKeys,
  normalizeSelect,
  parseLookupConfig,
  type LookupConfig,
} from "./config.js";

export const LookupErrorCodes = {
  /** Nessuna corrispondenza sul database. */
  LOOKUP_MISSING: "LOOKUP_MISSING",
  /** Piu' corrispondenze per la stessa chiave: scegliere a caso corromperebbe i dati. */
  LOOKUP_AMBIGUOUS: "LOOKUP_AMBIGUOUS",
  /** La riga non ha un valore per la chiave di ricerca. */
  LOOKUP_KEY_EMPTY: "LOOKUP_KEY_EMPTY",
} as const;

/** Postgres accetta al massimo 65535 parametri: si resta molto sotto. */
const MAX_PARAMS_PER_QUERY = 30_000;

type CacheEntry = { kind: "hit"; row: Row } | { kind: "missing" } | { kind: "ambiguous"; count: number };

/**
 * Cache per run: la stessa chiave ricorre spesso in un file di dati, e
 * richiederla a ogni lotto sarebbe uno spreco. La chiave della cache include
 * l'identita' della config, perche' due lookup diversi nella stessa pipeline
 * condividono questa istanza del transformer.
 */
const cachesByRun = createRunCache<Map<string, CacheEntry>>(() => new Map());

/** Config gia' validate, per non ripassare da Zod a ogni lotto. */
const parsedConfigs = new WeakMap<object, LookupConfig>();

function configOf(raw: unknown): LookupConfig {
  if (typeof raw !== "object" || raw === null) return parseLookupConfig(raw);
  const cached = parsedConfigs.get(raw);
  if (cached) return cached;
  const parsed = parseLookupConfig(raw);
  parsedConfigs.set(raw, parsed);
  return parsed;
}

/** Identifica la config nella cache: due lookup diversi non devono mischiarsi. */
function configId(config: LookupConfig): string {
  return JSON.stringify([config.db, config.table, config.on, config.select, config.filter]);
}

/** Chiave di confronto fra valori della riga e valori del database. */
function keyOf(values: readonly unknown[]): string {
  return values.map((value) => String(value)).join("\u0000");
}


/** Costruisce la clausola dei filtri aggiuntivi, con operatori in whitelist (I7). */
function buildFilter(
  config: LookupConfig,
  params: unknown[],
): string {
  const clauses: string[] = [];
  for (const condition of config.filter ?? []) {
    const column = escapeIdentifier(condition.column);
    const operator = sqlOperator(condition.op);
    if (condition.op === "is_null" || condition.op === "is_not_null") {
      clauses.push(`${column} ${operator}`);
      continue;
    }
    if (condition.value === undefined) {
      throw new EtlError(
        `Il filtro su "${condition.column}" con operatore "${condition.op}" richiede un valore`,
        { code: ErrorCodes.CONFIG_INVALID, context: { filter: condition } },
      );
    }
    params.push(condition.value);
    clauses.push(`${column} ${operator} $${params.length}`);
  }
  return clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
}

/**
 * Una sola interrogazione per l'intero gruppo di chiavi (I5), con tutti i
 * valori come parametri (I7).
 */
async function fetchKeys(
  db: ReadOnlyDb,
  config: LookupConfig,
  keys: readonly (readonly unknown[])[],
): Promise<Row[]> {
  const columns = normalizeKeys(config).map((key) => key.column);
  const selected = normalizeSelect(config).map((entry) => entry.column);
  const projection = [...new Set([...columns, ...selected])]
    .map((column) => escapeIdentifier(column))
    .join(", ");
  const table = escapeQualifiedName(config.table);

  const rows: Row[] = [];
  const perQuery = Math.max(1, Math.floor(MAX_PARAMS_PER_QUERY / Math.max(1, columns.length)));

  for (let start = 0; start < keys.length; start += perQuery) {
    const slice = keys.slice(start, start + perQuery);
    const params: unknown[] = [];
    let where: string;

    if (columns.length === 1) {
      // Il caso normale: una chiave sola, un solo parametro di tipo array.
      params.push(slice.map((values) => values[0]));
      where = `${escapeIdentifier(columns[0] ?? "")} = ANY($1)`;
    } else {
      const tuples = slice.map((values) => {
        const placeholders = values.map((value) => {
          params.push(value);
          return `$${params.length}`;
        });
        return `(${placeholders.join(", ")})`;
      });
      const columnList = columns.map((column) => escapeIdentifier(column)).join(", ");
      where = `(${columnList}) IN (${tuples.join(", ")})`;
    }

    const sql = `SELECT ${projection} FROM ${table} WHERE ${where}${buildFilter(config, params)}`;
    rows.push(...(await db.query(sql, params)));
  }

  return rows;
}

/** Applica al lotto quanto trovato, secondo le politiche onMissing/onDuplicate. */
function applyEntry(
  entry: CacheEntry,
  row: Row,
  offset: number,
  config: LookupConfig,
  kept: Row[],
  failed: Failed[],
): void {
  const selection = normalizeSelect(config);

  if (entry.kind === "hit") {
    const enriched: Row = { ...row };
    for (const { column, field } of selection) {
      enriched[field] = entry.row[column] ?? null;
    }
    kept.push(enriched);
    return;
  }

  if (entry.kind === "ambiguous") {
    failed.push({
      row,
      reason: `${entry.count} righe di ${config.table} corrispondono alla stessa chiave`,
      code: LookupErrorCodes.LOOKUP_AMBIGUOUS,
      severity: "reject",
      offset,
    });
    return;
  }

  const keyDescription = normalizeKeys(config)
    .map(({ field }) => `${field}=${String(row[field] ?? "")}`)
    .join(", ");

  switch (config.onMissing) {
    case "skip":
      return;
    case "warn": {
      const enriched: Row = { ...row };
      for (const { field } of selection) enriched[field] = null;
      kept.push(enriched);
      failed.push({
        row,
        reason: `nessuna corrispondenza in ${config.table} per ${keyDescription}`,
        code: LookupErrorCodes.LOOKUP_MISSING,
        severity: "warn",
        offset,
      });
      return;
    }
    case "reject":
    default:
      failed.push({
        row,
        reason: `nessuna corrispondenza in ${config.table} per ${keyDescription}`,
        code: LookupErrorCodes.LOOKUP_MISSING,
        severity: "reject",
        offset,
      });
  }
}

export const lookupTransformer: Transformer = {
  async transform(batch: Batch, rawConfig: unknown, ctx: Ctx): Promise<TransformResult> {
    const config = configOf(rawConfig);
    if (batch.rows.length === 0) return { batch, failed: [] };

    const keys = normalizeKeys(config);
    const cache = cachesByRun.for(ctx.runId);
    const prefix = configId(config);

    // Primo giro: si raccolgono le chiavi mancanti dalla cache, una volta sola
    // ciascuna. Nessuna interrogazione qui dentro (I5).
    const missing = new Map<string, unknown[]>();
    const rowKeys: (string | null)[] = [];

    for (const row of batch.rows) {
      const values = keys.map((key) => row[key.field]);
      if (values.some(isBlank)) {
        rowKeys.push(null);
        continue;
      }
      const cacheKey = `${prefix}\u0000${keyOf(values)}`;
      rowKeys.push(cacheKey);
      if (!cache.has(cacheKey) && !missing.has(cacheKey)) missing.set(cacheKey, values);
    }

    if (missing.size > 0) {
      const found = await fetchKeys(ctx.db(config.db), config, [...missing.values()]);

      const byKey = new Map<string, Row[]>();
      for (const row of found) {
        const cacheKey = `${prefix}\u0000${keyOf(keys.map((key) => row[key.column]))}`;
        const bucket = byKey.get(cacheKey);
        if (bucket) bucket.push(row);
        else byKey.set(cacheKey, [row]);
      }

      for (const cacheKey of missing.keys()) {
        const matches = byKey.get(cacheKey) ?? [];
        const first = matches[0];
        if (!first) cache.set(cacheKey, { kind: "missing" });
        else if (matches.length === 1 || config.onDuplicate === "first") {
          cache.set(cacheKey, { kind: "hit", row: first });
        } else {
          cache.set(cacheKey, { kind: "ambiguous", count: matches.length });
        }
      }
    }

    const kept: Row[] = [];
    const failed: Failed[] = [];

    batch.rows.forEach((row, index) => {
      const offset = batch.meta.offset + index;
      const cacheKey = rowKeys[index];

      if (cacheKey === null || cacheKey === undefined) {
        const which = keys.map((key) => key.field).join(", ");
        if (config.onMissing === "skip") return;
        if (config.onMissing === "warn") {
          const enriched: Row = { ...row };
          for (const { field } of normalizeSelect(config)) enriched[field] = null;
          kept.push(enriched);
        }
        failed.push({
          row,
          reason: `la riga non ha un valore per la chiave di ricerca (${which})`,
          code: LookupErrorCodes.LOOKUP_KEY_EMPTY,
          severity: config.onMissing === "warn" ? "warn" : "reject",
          offset,
        });
        return;
      }

      applyEntry(cache.get(cacheKey) ?? { kind: "missing" }, row, offset, config, kept, failed);
    });

    return { batch: { ...batch, rows: kept }, failed };
  },

  /** Fine del run: la cache di quel run non serve piu'. */
  async flush(ctx: Ctx): Promise<TransformResult> {
    cachesByRun.release(ctx.runId);
    return {
      batch: { rows: [], meta: { runId: ctx.runId, source: "lookup", offset: 0 } },
      failed: [],
    };
  },
};
