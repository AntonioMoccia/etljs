import type { Logger, Row, WriteTransaction, WriterCtx } from "@etl-js/contracts";

/** Traccia di tutto cio' che il writer ha chiesto alla transazione. */
export interface FakeTransaction extends WriteTransaction {
  readonly loaded: { table: string; columns: readonly string[]; rows: unknown[][] }[];
  readonly statements: { sql: string; params: readonly unknown[] }[];
  readonly outcome: string[];
}

export function fakeTransaction(): FakeTransaction {
  const loaded: FakeTransaction["loaded"] = [];
  const statements: FakeTransaction["statements"] = [];
  const outcome: string[] = [];
  return {
    loaded,
    statements,
    outcome,
    async query<T extends Row = Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      statements.push({ sql, params });
      return [];
    },
    async exec(sql: string, params: readonly unknown[] = []): Promise<number> {
      statements.push({ sql, params });
      return 0;
    },
    async bulkLoad(table, columns, rows): Promise<number> {
      const collected: unknown[][] = [];
      for await (const row of rows) collected.push([...row]);
      loaded.push({ table, columns: [...columns], rows: collected });
      return collected.length;
    },
    async commit(): Promise<void> {
      outcome.push("commit");
    },
    async rollback(): Promise<void> {
      outcome.push("rollback");
    },
  };
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/** WriterCtx di prova: consegna sempre la stessa transazione finta. */
export function fakeWriterCtx(tx: WriteTransaction): WriterCtx & { openedDbs: string[] } {
  const openedDbs: string[] = [];
  return {
    openedDbs,
    runId: "run-test",
    db: () => {
      throw new Error("il writer non deve usare la connessione in sola lettura");
    },
    secretRef: (ref) => `secret:${ref}`,
    log: silentLogger,
    signal: new AbortController().signal,
    dbWrite: async (name) => {
      openedDbs.push(name);
      return tx;
    },
  };
}
