import {
  PROTOCOL_VERSION,
  type Batch,
  type Ctx,
  type Definition,
  type Logger,
  type ReaderPlugin,
  type Row,
  type TransformerPlugin,
  type WriteSession,
  type WriterPlugin,
} from "@etl-js/contracts";
import type { HostCtx } from "@etl-js/core";

/**
 * Plugin finti con schemi scritti a mano: i test del core non devono importare
 * un plugin vero, altrimenti proverebbero il contrario di I2.
 */

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

export function hostCtx(overrides: Partial<HostCtx> = {}): HostCtx {
  return {
    db: () => {
      throw new Error("nessun database in questo test");
    },
    secretRef: (ref) => `secret:${ref}`,
    log: silentLogger,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

/** Reader finto: emette i lotti che gli si passano. La config vuole un `path`. */
export function readerOf(batches: Row[][]): ReaderPlugin {
  return {
    manifest: {
      name: "fake-reader",
      version: "1.0.0",
      kind: "reader",
      protocol: PROTOCOL_VERSION,
      configSchema: schema({ path: { type: "string", minLength: 1 } }, ["path"]),
    },
    impl: {
      async *read(_config: unknown, ctx: Ctx): AsyncIterable<Batch> {
        let offset = 0;
        for (const rows of batches) {
          yield { rows, meta: { runId: ctx.runId, source: "finto", offset } };
          offset += rows.length;
        }
      },
    },
  };
}

export interface Sink {
  rows: Row[];
  outcome: string[];
  failAt?: number;
}

/** Writer finto: registra i lotti ricevuti e l'esito della sessione. */
export function writerOf(sink: Sink): WriterPlugin {
  return {
    manifest: {
      name: "fake-writer",
      version: "1.0.0",
      kind: "writer",
      protocol: PROTOCOL_VERSION,
      configSchema: schema({ table: { type: "string", minLength: 1 } }, ["table"]),
    },
    impl: {
      async open(): Promise<WriteSession> {
        sink.outcome.push("open");
        let writes = 0;
        return {
          async write(batch: Batch): Promise<void> {
            writes += 1;
            if (sink.failAt === writes) throw new Error("disco pieno");
            sink.rows.push(...batch.rows);
          },
          async close(commit: boolean): Promise<void> {
            sink.outcome.push(commit ? "commit" : "rollback");
          },
        };
      },
    },
  };
}

/** Transformer finto: scarta le righe senza `ok` e ricorda il ctx ricevuto. */
export function pickyTransformer(seen: Ctx[] = []): TransformerPlugin {
  return {
    manifest: {
      name: "picky",
      version: "1.0.0",
      kind: "transformer",
      protocol: PROTOCOL_VERSION,
      configSchema: schema({ campo: { type: "string" } }),
    },
    impl: {
      async transform(batch, _config, ctx) {
        seen.push(ctx);
        const kept = batch.rows.filter((row) => row["ok"] === true);
        const failed = batch.rows
          .map((row, index) => ({ row, index }))
          .filter((entry) => entry.row["ok"] !== true)
          .map((entry) => ({
            row: entry.row,
            reason: "manca ok",
            code: "NOT_OK",
            severity: "reject" as const,
            offset: batch.meta.offset + entry.index,
          }));
        return { batch: { ...batch, rows: kept }, failed };
      },
    },
  };
}

/** Definition minima valida contro gli schemi qui sopra. */
export function definition(overrides: Partial<Definition> = {}): Definition {
  return {
    client: "acme",
    source: { type: "fake-reader", config: { path: "finto.csv" } },
    transform: [],
    destination: { type: "fake-writer", config: { table: "landing" } },
    ...overrides,
  };
}
