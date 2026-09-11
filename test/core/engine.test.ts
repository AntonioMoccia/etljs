import { describe, expect, test } from "vitest";
import type { Row } from "etljs/contracts";
import { Registry, createEngine, run } from "etljs";
import { definition, hostCtx, pickyTransformer, readerOf, writerOf } from "./fakes.js";

/**
 * `createEngine()` e' una facciata sopra `Registry` + `run()`: non aggiunge
 * comportamento, rende esplicito il collegamento dei plugin. I test lo
 * verificano confrontandolo con cio' che gia' faceva `run()` a mano.
 */
describe("createEngine", () => {
  test("collega i plugin e li usa per eseguire", async () => {
    const sink = { rows: [] as Row[], outcome: [] as string[] };

    const result = await createEngine()
      .use(readerOf([[{ ok: true, id: 1 }]]))
      .use(writerOf(sink))
      .run(definition(), hostCtx());

    expect(result).toMatchObject({ read: 1, written: 1, failed: 0 });
    expect(sink.rows).toEqual([{ ok: true, id: 1 }]);
  });

  test("use() restituisce l'engine, cosi' si concatena", () => {
    const engine = createEngine();
    expect(engine.use(readerOf([[]]))).toBe(engine);
  });

  test("due plugin con lo stesso nome sono un errore d'uso", () => {
    const engine = createEngine().use(readerOf([[]]));
    expect(() => engine.use(readerOf([[{ altro: 1 }]]))).toThrowError(/fake-reader/);
  });

  test("lo stesso plugin registrato due volte non da' fastidio", () => {
    const reader = readerOf([[]]);
    const engine = createEngine().use(reader);
    expect(() => engine.use(reader)).not.toThrow();
  });

  test("un plugin che serve e non e' stato collegato lo dice", async () => {
    await expect(
      createEngine().use(writerOf({ rows: [], outcome: [] })).run(definition(), hostCtx()),
    ).rejects.toMatchObject({ code: "PLUGIN_NOT_FOUND" });
  });

  test("produce lo stesso risultato di run() con un Registry popolato a mano", async () => {
    const righe = [[{ ok: true, id: 1 }, { ok: false, id: 2 }], [{ ok: true, id: 3 }]];
    const def = definition({ transform: [{ type: "picky", config: {} }] });

    const aMano = { rows: [] as Row[], outcome: [] as string[] };
    const registry = new Registry()
      .register(readerOf(righe))
      .register(pickyTransformer())
      .register(writerOf(aMano));
    const atteso = await run(def, hostCtx(), { registry, runId: "run-fisso" });

    const conEngine = { rows: [] as Row[], outcome: [] as string[] };
    const ottenuto = await createEngine()
      .use(readerOf(righe))
      .use(pickyTransformer())
      .use(writerOf(conEngine))
      .run(def, hostCtx(), { runId: "run-fisso" });

    expect({ ...ottenuto, durationMs: 0 }).toEqual({ ...atteso, durationMs: 0 });
    expect(conEngine.rows).toEqual(aMano.rows);
    expect(conEngine.outcome).toEqual(aMano.outcome);
  });

  test("le opzioni di run() passano, ma il registry resta quello dell'engine", async () => {
    const sink = { rows: [] as Row[], outcome: [] as string[] };
    const eventi: string[] = [];

    const result = await createEngine()
      .use(readerOf([[{ ok: true }]]))
      .use(writerOf(sink))
      .run(definition(), hostCtx(), {
        dryRun: true,
        events: { onRunStart: (e) => eventi.push(e.steps.join(">")) },
      });

    expect(result.read).toBe(1);
    expect(sink.outcome).toEqual([]);
    expect(eventi).toEqual(["fake-reader>fake-writer"]);
  });

  test("due engine non si scambiano i plugin", async () => {
    const primo = createEngine().use(readerOf([[{ ok: true }]]));
    const secondo = createEngine().use(writerOf({ rows: [], outcome: [] }));

    await expect(secondo.run(definition(), hostCtx())).rejects.toMatchObject({
      code: "PLUGIN_NOT_FOUND",
    });
    expect(primo).not.toBe(secondo);
  });

  test("un elenco di plugin si collega in un colpo solo", async () => {
    const sink = { rows: [] as Row[], outcome: [] as string[] };
    const result = await createEngine()
      .useAll([readerOf([[{ ok: true }]]), writerOf(sink)])
      .run(definition(), hostCtx());
    expect(result.written).toBe(1);
  });
});
