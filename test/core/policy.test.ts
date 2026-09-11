import { describe, expect, test } from "vitest";
import type { Row } from "etljs/contracts";
import { Registry, run } from "etljs";
import { definition, hostCtx, pickyTransformer, readerOf, writerOf } from "./fakes.js";

/** `bad` righe cattive su `total`, mescolate in modo prevedibile. */
function rowsWith(total: number, bad: number): Row[] {
  return Array.from({ length: total }, (_, i) => ({ id: i, ok: i >= bad }));
}

function setup(rows: Row[][], maxFailedRatio?: number, rejectFile = true) {
  const sink = { rows: [] as Row[], outcome: [] as string[] };
  const registry = new Registry()
    .register(readerOf(rows))
    .register(pickyTransformer())
    .register(writerOf(sink));
  const def = definition({
    transform: [{ type: "picky", config: {} }],
    policy: { rejectFile, ...(maxFailedRatio === undefined ? {} : { maxFailedRatio }) },
  });
  return { sink, registry, def };
}

describe("policy.maxFailedRatio", () => {
  test("un file invalido al 10% con soglia 20% viene importato in parte, e lo scarto resta", async () => {
    const { sink, registry, def } = setup([rowsWith(20, 2)], 0.2);

    const result = await run(def, hostCtx(), { registry });

    expect(result.read).toBe(20);
    expect(result.written).toBe(18);
    expect(result.failed).toBe(2);
    expect(result.rejects).toHaveLength(2);
    expect(sink.outcome).toEqual(["open", "commit"]);
  });

  test("un file invalido al 40% con la stessa soglia annulla il run e fa rollback", async () => {
    const { sink, registry, def } = setup([rowsWith(20, 8)], 0.2);

    await expect(run(def, hostCtx(), { registry })).rejects.toMatchObject({
      code: "TOO_MANY_FAILED",
      context: { ratio: 0.4, maxFailedRatio: 0.2 },
    });
    expect(sink.outcome).toEqual(["open", "rollback"]);
  });

  test("il lotto che fa sforare la soglia non viene nemmeno scritto", async () => {
    const { sink, registry, def } = setup([rowsWith(10, 0), rowsWith(10, 9)], 0.2);

    await expect(run(def, hostCtx(), { registry })).rejects.toMatchObject({
      code: "TOO_MANY_FAILED",
    });
    // Il primo lotto era passato, il secondo no: e comunque il rollback annulla tutto.
    expect(sink.rows).toHaveLength(10);
    expect(sink.outcome).toEqual(["open", "rollback"]);
  });

  test("senza maxFailedRatio nessuna soglia: si importa quel che si puo'", async () => {
    const { sink, registry, def } = setup([rowsWith(10, 9)]);

    const result = await run(def, hostCtx(), { registry });

    expect(result.failed).toBe(9);
    expect(sink.outcome).toEqual(["open", "commit"]);
  });

  test("una soglia a zero non tollera nemmeno una riga sbagliata", async () => {
    const { registry, def } = setup([rowsWith(10, 1)], 0);
    await expect(run(def, hostCtx(), { registry })).rejects.toMatchObject({
      code: "TOO_MANY_FAILED",
    });
  });

  test("le segnalazioni warn contano nella soglia quanto gli scarti", async () => {
    // `picky` scarta; qui interessa che il conteggio sia quello di RunResult.failed.
    const { registry, def } = setup([rowsWith(10, 3)], 0.25);
    await expect(run(def, hostCtx(), { registry })).rejects.toMatchObject({
      code: "TOO_MANY_FAILED",
      context: { failed: 3, read: 10 },
    });
  });
});

describe("provenienza degli scarti", () => {
  test("ogni scarto porta run, sorgente e offset: basta per il file di scarto", async () => {
    const { registry, def } = setup([rowsWith(4, 1)]);

    const result = await run(def, hostCtx(), { registry, runId: "run-42" });

    expect(result.rejects?.[0]).toMatchObject({
      runId: "run-42",
      source: "finto",
      offset: 0,
      code: "NOT_OK",
    });
  });

  test("l'elenco degli scarti tenuto in memoria e' limitato e la cosa viene detta", async () => {
    const lines: string[] = [];
    const { registry, def } = setup([rowsWith(50, 50)]);
    const log = {
      debug: () => {},
      info: () => {},
      warn: (message: string) => lines.push(message),
      error: () => {},
      child: () => log,
    };

    const result = await run(def, hostCtx({ log }), { registry, maxRejectsInResult: 10 });

    expect(result.failed).toBe(50);
    expect(result.rejects).toHaveLength(10);
    expect(lines.some((line) => line.includes("scarti"))).toBe(true);
  });

  test("senza rejectFile il risultato non porta gli scarti, ma li conta", async () => {
    const { registry, def } = setup([rowsWith(10, 3)], undefined, false);
    const result = await run(def, hostCtx(), { registry });
    expect(result.rejects).toBeUndefined();
    expect(result.failed).toBe(3);
  });
});
