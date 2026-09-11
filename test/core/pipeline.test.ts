import { describe, expect, test } from "vitest";
import { PROTOCOL_VERSION, type Ctx, type Row, type TransformerPlugin } from "etljs/contracts";
import { Registry, run } from "etljs";
import { definition, hostCtx, pickyTransformer, readerOf, writerOf } from "./fakes.js";

describe("run", () => {
  test("legge, trasforma e scrive, e riporta i conteggi", async () => {
    const sink = { rows: [] as Row[], outcome: [] as string[] };
    const registry = new Registry()
      .register(readerOf([[{ ok: true, id: 1 }, { ok: false, id: 2 }], [{ ok: true, id: 3 }]]))
      .register(pickyTransformer())
      .register(writerOf(sink));

    const result = await run(
      definition({ transform: [{ type: "picky", config: {} }] }),
      hostCtx(),
      { registry },
    );

    expect(sink.rows).toEqual([{ ok: true, id: 1 }, { ok: true, id: 3 }]);
    expect(sink.outcome).toEqual(["open", "commit"]);
    expect(result).toMatchObject({ read: 3, written: 2, failed: 1, aborted: false });
  });

  test("in dry-run la destinazione non viene nemmeno aperta", async () => {
    const sink = { rows: [] as Row[], outcome: [] as string[] };
    const registry = new Registry()
      .register(readerOf([[{ id: 1 }]]))
      .register(writerOf(sink));

    const result = await run(definition(), hostCtx(), { registry, dryRun: true });

    expect(sink.outcome).toEqual([]);
    expect(result.read).toBe(1);
    expect(result.written).toBe(1);
  });

  test("con rejectFile gli scarti tornano al chiamante con il motivo", async () => {
    const registry = new Registry()
      .register(readerOf([[{ ok: false, id: 7 }]]))
      .register(pickyTransformer())
      .register(writerOf({ rows: [], outcome: [] }));

    const result = await run(
      definition({
        transform: [{ type: "picky", config: {} }],
        policy: { rejectFile: true },
      }),
      hostCtx(),
      { registry },
    );

    expect(result.rejects).toHaveLength(1);
    expect(result.rejects?.[0]).toMatchObject({
      row: { ok: false, id: 7 },
      reason: "manca ok",
      code: "NOT_OK",
      severity: "reject",
      offset: 0,
    });
  });

  test("un errore in scrittura chiude la sessione con rollback e rilancia", async () => {
    const sink = { rows: [] as Row[], outcome: [] as string[], failAt: 1 };
    const registry = new Registry()
      .register(readerOf([[{ id: 1 }]]))
      .register(writerOf(sink));

    await expect(run(definition(), hostCtx(), { registry })).rejects.toMatchObject({
      name: "EtlError",
    });
    expect(sink.outcome).toEqual(["open", "rollback"]);
  });

  test("un signal gia' annullato ferma il run e non fa commit", async () => {
    const controller = new AbortController();
    controller.abort();
    const sink = { rows: [] as Row[], outcome: [] as string[] };
    const registry = new Registry()
      .register(readerOf([[{ id: 1 }]]))
      .register(writerOf(sink));

    const result = await run(definition(), hostCtx({ signal: controller.signal }), { registry });

    expect(result.aborted).toBe(true);
    expect(sink.rows).toEqual([]);
    expect(sink.outcome).toEqual(["open", "rollback"]);
  });

  test("i transformer ricevono un ctx senza dbWrite: non possono scrivere (I4)", async () => {
    const seen: Ctx[] = [];
    const registry = new Registry()
      .register(readerOf([[{ ok: true }]]))
      .register(pickyTransformer(seen))
      .register(writerOf({ rows: [], outcome: [] }));

    await run(
      definition({ transform: [{ type: "picky", config: {} }] }),
      hostCtx({ dbWrite: async () => { throw new Error("mai"); } }),
      { registry },
    );

    expect(seen).toHaveLength(1);
    expect("dbWrite" in (seen[0] as object)).toBe(false);
  });

  test("cio' che esce da flush attraversa i transformer successivi", async () => {
    const coda: TransformerPlugin = {
      manifest: {
        name: "coda",
        version: "1.0.0",
        kind: "transformer",
        protocol: PROTOCOL_VERSION,
        configSchema: {},
      },
      impl: {
        async transform(batch) {
          return { batch: { ...batch, rows: [] }, failed: [] };
        },
        async flush() {
          return {
            batch: {
              rows: [{ ok: true, id: 99 }, { ok: false, id: 100 }],
              meta: { runId: "r", source: "coda", offset: 0 },
            },
            failed: [],
          };
        },
      },
    };
    const sink = { rows: [] as Row[], outcome: [] as string[] };
    const registry = new Registry()
      .register(readerOf([[{ ok: true, id: 1 }]]))
      .register(coda)
      .register(pickyTransformer())
      .register(writerOf(sink));

    const result = await run(
      definition({
        transform: [
          { type: "coda", config: {} },
          { type: "picky", config: {} },
        ],
      }),
      hostCtx(),
      { registry },
    );

    // La riga 100 e' stata scartata da `picky`, che gira DOPO il flush di `coda`.
    expect(sink.rows).toEqual([{ ok: true, id: 99 }]);
    expect(result.failed).toBe(1);
  });

  test("un plugin non registrato produce PLUGIN_NOT_FOUND prima di leggere alcunche'", async () => {
    const registry = new Registry().register(writerOf({ rows: [], outcome: [] }));
    await expect(
      run(definition({ source: { type: "assente", config: { path: "x" } } }), hostCtx(), { registry }),
    ).rejects.toMatchObject({ code: "PLUGIN_NOT_FOUND" });
  });

  test("un plugin usato al posto sbagliato non viene eseguito", async () => {
    const registry = new Registry()
      .register(readerOf([[{ id: 1 }]]))
      .register(pickyTransformer())
      .register(writerOf({ rows: [], outcome: [] }));
    await expect(
      run(definition({ destination: { type: "picky", config: {} } }), hostCtx(), { registry }),
    ).rejects.toMatchObject({ code: "INVALID_USAGE" });
  });

  test("una config invalida ferma il run prima di aprire la destinazione", async () => {
    const sink = { rows: [] as Row[], outcome: [] as string[] };
    const registry = new Registry()
      .register(readerOf([[{ ok: true }]]))
      .register(writerOf(sink));

    await expect(
      run(definition({ source: { type: "fake-reader", config: {} } }), hostCtx(), { registry }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(sink.outcome).toEqual([]);
  });

  test("gli eventi raccontano il run dall'inizio alla fine", async () => {
    const events: string[] = [];
    const registry = new Registry()
      .register(readerOf([[{ ok: true }, { ok: false }]]))
      .register(pickyTransformer())
      .register(writerOf({ rows: [], outcome: [] }));

    await run(
      definition({ transform: [{ type: "picky", config: {} }] }),
      hostCtx(),
      {
        registry,
        events: {
          onRunStart: (e) => events.push(`start:${e.steps.join(">")}`),
          onBatch: (e) => events.push(`batch:${e.read}/${e.written}`),
          onRecordFailed: (e) => events.push(`failed:${e.step}:${e.failed.code}`),
          onRunEnd: (e) => events.push(`end:${e.result.written}`),
        },
      },
    );

    expect(events).toEqual([
      "start:fake-reader>picky>fake-writer",
      "failed:picky:NOT_OK",
      "batch:2/1",
      "end:1",
    ]);
  });
});
