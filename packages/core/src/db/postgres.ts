import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ErrorCodes,
  IngestError,
  escapeIdentifier,
  escapeQualifiedName,
  type ReadOnlyDb,
  type Row,
  type WriteTransaction,
} from "@etl-js/contracts";
import { encodeCopyRow } from "./copy-text.js";
import { withRetry } from "../retry.js";

/**
 * Connessioni fornite dal core: e' l'host a possedere le credenziali e a
 * risolverle prima di arrivare qui; nessun plugin vede questa struttura (I6).
 */
export interface PostgresDbConfig {
  /** Stringa di connessione gia' risolta (es. dal secretRef dell'host). */
  connectionString: string;
  /** Dimensione massima del pool. */
  max?: number;
  /** Timeout per singola istruzione, in millisecondi. */
  statementTimeoutMs?: number;
  applicationName?: string;
  /**
   * Tentativi per le letture e per l'apertura di una connessione. Le scritture
   * dentro una transazione non si ritentano mai: un'istruzione fallita ha gia'
   * abortito la transazione, e riprovarla nasconderebbe il motivo.
   */
  retryAttempts?: number;
}

/** Cio' che il core consegna a `run()` come sorgente di connessioni. */
export interface DbProvider {
  db(name: string): ReadOnlyDb;
  dbWrite(name: string): Promise<WriteTransaction>;
  close(): Promise<void>;
}

type PgModule = typeof import("pg");

async function loadPg(): Promise<PgModule> {
  try {
    const mod = await import("pg");
    return ((mod as unknown as { default?: PgModule }).default ?? mod) as PgModule;
  } catch (error) {
    throw new IngestError(
      "Per usare Postgres serve la dipendenza opzionale 'pg': npm i pg pg-copy-streams",
      { code: ErrorCodes.DB_ERROR, cause: error },
    );
  }
}

/** Errori che ha senso ritentare: contesa, riavvii, cadute di rete. */
const RETRYABLE_SQLSTATE = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "08006", // connection_failure
  "08003", // connection_does_not_exist
]);

function asDbError(error: unknown, context: Record<string, unknown>): IngestError {
  const code = (error as { code?: string } | undefined)?.code;
  return IngestError.wrap(error, {
    code: ErrorCodes.DB_ERROR,
    retryable: code !== undefined && RETRYABLE_SQLSTATE.has(code),
    context: { ...context, sqlstate: code },
  });
}

/** Opzioni di sessione passate a Postgres alla connessione. */
function sessionOptions(config: PostgresDbConfig, readOnly: boolean): string {
  const parts: string[] = [];
  if (readOnly) parts.push("-c default_transaction_read_only=on");
  if (config.statementTimeoutMs !== undefined) {
    parts.push(`-c statement_timeout=${Math.trunc(config.statementTimeoutMs)}`);
  }
  return parts.join(" ");
}

/**
 * Crea i pool per i database logici indicati. Ogni database ha due pool: uno
 * in sola lettura (il server stesso rifiuta le scritture, cosi' I4 non dipende
 * dalla buona fede dei transformer) e uno per le transazioni del writer.
 */
export async function createPostgresProvider(
  databases: Record<string, PostgresDbConfig>,
): Promise<DbProvider> {
  const pg = await loadPg();
  const readPools = new Map<string, InstanceType<PgModule["Pool"]>>();
  const writePools = new Map<string, InstanceType<PgModule["Pool"]>>();

  const configFor = (name: string): PostgresDbConfig => {
    const config = databases[name];
    if (!config) {
      throw new IngestError(`Database logico "${name}" non configurato`, {
        code: ErrorCodes.INVALID_USAGE,
        context: { name, available: Object.keys(databases) },
      });
    }
    return config;
  };

  const poolFor = (
    name: string,
    readOnly: boolean,
  ): InstanceType<PgModule["Pool"]> => {
    const pools = readOnly ? readPools : writePools;
    const existing = pools.get(name);
    if (existing) return existing;
    const config = configFor(name);
    const options = sessionOptions(config, readOnly);
    const pool = new pg.Pool({
      connectionString: config.connectionString,
      max: config.max ?? (readOnly ? 4 : 2),
      application_name: config.applicationName ?? "etl-js",
      ...(options ? { options } : {}),
    });
    // Un errore su un client inattivo non deve abbattere il processo dell'host.
    pool.on("error", () => {});
    pools.set(name, pool);
    return pool;
  };

  return {
    db(name: string): ReadOnlyDb {
      return {
        async query<T extends Row = Row>(
          sql: string,
          params: readonly unknown[] = [],
        ): Promise<T[]> {
          return withRetry(
            async () => {
              try {
                const result = await poolFor(name, true).query(sql, [...params]);
                return result.rows as T[];
              } catch (error) {
                throw asDbError(error, { db: name, sql });
              }
            },
            { attempts: configFor(name).retryAttempts ?? 3 },
          );
        },
      };
    },

    async dbWrite(name: string): Promise<WriteTransaction> {
      const client = await withRetry(
        async () => {
          try {
            return await poolFor(name, false).connect();
          } catch (error) {
            throw asDbError(error, { db: name, phase: "connect" });
          }
        },
        { attempts: configFor(name).retryAttempts ?? 3 },
      );
      let settled = false;
      const release = (): void => {
        if (settled) return;
        settled = true;
        client.release();
      };

      try {
        await client.query("BEGIN");
      } catch (error) {
        release();
        throw asDbError(error, { db: name, phase: "begin" });
      }

      return {
        async query<T extends Row = Row>(
          sql: string,
          params: readonly unknown[] = [],
        ): Promise<T[]> {
          try {
            const result = await client.query(sql, [...params]);
            return result.rows as T[];
          } catch (error) {
            throw asDbError(error, { db: name, sql });
          }
        },

        async exec(sql: string, params: readonly unknown[] = []): Promise<number> {
          try {
            const result = await client.query(sql, [...params]);
            return result.rowCount ?? 0;
          } catch (error) {
            throw asDbError(error, { db: name, sql });
          }
        },

        async bulkLoad(table, columns, rows): Promise<number> {
          if (columns.length === 0) {
            throw new IngestError("bulkLoad senza colonne", {
              code: ErrorCodes.INVALID_USAGE,
              context: { table },
            });
          }
          // Nessun valore finisce nel testo dell'istruzione: solo identificatori,
          // e solo dopo escapeIdentifier (I7).
          const target = escapeQualifiedName(table);
          const columnList = columns.map((column) => escapeIdentifier(column)).join(", ");
          const sql = `COPY ${target} (${columnList}) FROM STDIN`;

          let count = 0;
          const source = Readable.from(
            (async function* encode(): AsyncGenerator<string> {
              for await (const row of rows) {
                count += 1;
                yield encodeCopyRow(row);
              }
            })(),
          );

          try {
            const { from: copyFrom } = await import("pg-copy-streams");
            // I tipi di pg non prevedono il submittable di pg-copy-streams:
            // e' la sua unica via d'uso, documentata dalla libreria stessa.
            const startCopy = client.query.bind(client) as unknown as (
              submittable: unknown,
            ) => NodeJS.WritableStream;
            await pipeline(source, startCopy(copyFrom(sql)));
          } catch (error) {
            throw asDbError(error, { db: name, table, sql });
          }
          return count;
        },

        async commit(): Promise<void> {
          try {
            await client.query("COMMIT");
          } catch (error) {
            throw asDbError(error, { db: name, phase: "commit" });
          } finally {
            release();
          }
        },

        async rollback(): Promise<void> {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Un rollback fallito non deve mascherare l'errore che l'ha causato.
          } finally {
            release();
          }
        },
      };
    },

    async close(): Promise<void> {
      const pools = [...readPools.values(), ...writePools.values()];
      readPools.clear();
      writePools.clear();
      await Promise.all(pools.map((pool) => pool.end()));
    },
  };
}
