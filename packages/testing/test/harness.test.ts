import { describe, expect, test } from "vitest";
import type { Batch, Transformer } from "etl-js/contracts";
import { batchOf, mockCtx, recordingDb, recordingLogger, testTransformer } from "@etl-js/testing";

/** Transformer d'esempio: tiene le righe pari e accumula le dispari per il flush. */
const esempio: Transformer = {
  async transform(batch: Batch) {
    const kept = batch.rows.filter((row) => Number(row["n"]) % 2 === 0);
    return {
      batch: { ...batch, rows: kept },
      failed: batch.rows
        .filter((row) => Number(row["n"]) % 2 !== 0)
        .map((row, index) => ({
          row,
          reason: "dispari",
          code: "DISPARI",
          severity: "warn" as const,
          offset: batch.meta.offset + index,
        })),
    };
  },
  async flush(ctx) {
    return {
      batch: { rows: [{ n: 100 }], meta: { runId: ctx.runId, source: "coda", offset: 0 } },
      failed: [],
    };
  },
};

describe("testTransformer", () => {
  test("esegue il transformer e mette insieme righe e scarti", async () => {
    const result = await testTransformer(esempio, { rows: [{ n: 1 }, { n: 2 }], flush: false });
    expect(result.rows).toEqual([{ n: 2 }]);
    expect(result.failed).toHaveLength(1);
  });

  test("chiama flush come farebbe il motore, e ne raccoglie l'uscita", async () => {
    const result = await testTransformer(esempio, { rows: [{ n: 2 }] });
    expect(result.rows).toEqual([{ n: 2 }, { n: 100 }]);
  });

  test("accetta piu' lotti con lo stesso ctx, per provare lo stato fra un lotto e l'altro", async () => {
    const ctx = mockCtx();
    const result = await testTransformer(esempio, {
      batches: [
        batchOf([{ n: 1 }], { runId: ctx.runId, offset: 0 }),
        batchOf([{ n: 2 }], { runId: ctx.runId, offset: 1 }),
      ],
      ctx,
      flush: false,
    });
    expect(result.rows).toEqual([{ n: 2 }]);
    expect(result.batches).toHaveLength(2);
  });

  test("accetta anche un plugin intero, non solo l'implementazione", async () => {
    const plugin = {
      manifest: {
        name: "esempio",
        version: "1.0.0",
        kind: "transformer" as const,
        protocol: 1,
        configSchema: {},
      },
      impl: esempio,
    };
    const result = await testTransformer(plugin, { rows: [{ n: 2 }], flush: false });
    expect(result.rows).toEqual([{ n: 2 }]);
  });
});

describe("mockCtx", () => {
  test("non espone dbWrite: un transformer non puo' scrivere nemmeno per sbaglio (I4)", () => {
    expect("dbWrite" in mockCtx()).toBe(false);
  });

  test("chiedere un database che il test non ha dichiarato spiega cosa fare", () => {
    expect(() => mockCtx().db("principale")).toThrowError(/mockCtx\(\{ databases/);
  });

  test("chiedere un segreto non dichiarato non restituisce una stringa vuota", () => {
    expect(() => mockCtx().secretRef("DB_PASSWORD")).toThrowError(/DB_PASSWORD/);
  });

  test("il runId e' stabile, cosi' le cache per run si possono provare", () => {
    expect(mockCtx({ runId: "run-1" }).runId).toBe("run-1");
  });

  test("il segnale di annullamento si puo' pilotare dal test", () => {
    const controller = new AbortController();
    const ctx = mockCtx({ signal: controller.signal });
    expect(ctx.signal.aborted).toBe(false);
    controller.abort();
    expect(ctx.signal.aborted).toBe(true);
  });
});

describe("recordingDb", () => {
  test("registra ogni interrogazione: e' cosi' che si dimostra il batch (I5)", async () => {
    const db = recordingDb(() => [{ id: 1 }]);
    await db.query("SELECT 1 WHERE x = ANY($1)", [["a", "b"]]);
    expect(db.calls).toEqual([{ sql: "SELECT 1 WHERE x = ANY($1)", params: [["a", "b"]] }]);
  });

  test("la risposta puo' dipendere dai parametri ricevuti", async () => {
    const db = recordingDb((_sql, params) => (params[0] === "x" ? [{ trovato: true }] : []));
    expect(await db.query("...", ["x"])).toEqual([{ trovato: true }]);
    expect(await db.query("...", ["y"])).toEqual([]);
  });
});

describe("recordingLogger", () => {
  test("cattura i messaggi con i loro campi strutturati", () => {
    const log = recordingLogger();
    log.warn("riga sospetta", { offset: 7 });
    expect(log.lines).toEqual([
      { severity: "warn", message: "riga sospetta", fields: { offset: 7 } },
    ]);
  });

  test("i logger figli ereditano i campi e scrivono nello stesso elenco", () => {
    const log = recordingLogger();
    log.child({ plugin: "lookup" }).info("cache mancata", { chiave: "COD-1" });
    expect(log.lines[0]?.fields).toEqual({ plugin: "lookup", chiave: "COD-1" });
  });
});
