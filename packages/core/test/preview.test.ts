import { describe, expect, test } from "vitest";
import { Registry, preview } from "@etl-js/core";
import { definition, hostCtx, pickyTransformer, readerOf, writerOf } from "./fakes.js";

describe("preview", () => {
  // `n` limita le righe LETTE dalla sorgente, non quelle in uscita: si guarda
  // "che cosa succede alle prime n righe del file", scarti compresi.
  test("mostra cosa esce dalle prime n righe della sorgente, senza scrivere nulla", async () => {
    const sink = { rows: [], outcome: [] as string[] };
    const registry = new Registry()
      .register(
        readerOf([
          [{ ok: true, id: 1 }, { ok: false, id: 2 }],
          [{ ok: true, id: 3 }, { ok: true, id: 4 }],
        ]),
      )
      .register(pickyTransformer())
      .register(writerOf(sink));

    const result = await preview(
      definition({ transform: [{ type: "picky", config: {} }] }),
      2,
      hostCtx(),
      { registry },
    );

    expect(result.read).toBe(2);
    expect(result.rows).toEqual([{ ok: true, id: 1 }]);
    expect(result.failed.map((f) => f.row)).toEqual([{ ok: false, id: 2 }]);
    expect(sink.outcome).toEqual([]);
  });

  test("porta con se' gli scarti col motivo, che sono meta' di cio' che si vuole vedere", async () => {
    const registry = new Registry()
      .register(readerOf([[{ ok: false, id: 9 }]]))
      .register(pickyTransformer())
      .register(writerOf({ rows: [], outcome: [] }));

    const result = await preview(
      definition({ transform: [{ type: "picky", config: {} }] }),
      10,
      hostCtx(),
      { registry },
    );

    expect(result.rows).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      row: { ok: false, id: 9 },
      reason: "manca ok",
      code: "NOT_OK",
      severity: "reject",
      offset: 0,
      source: "finto",
    });
  });

  test("non legge piu' righe di quante ne servano", async () => {
    const registry = new Registry()
      .register(readerOf([[{ ok: true, id: 1 }], [{ ok: true, id: 2 }], [{ ok: true, id: 3 }]]))
      .register(writerOf({ rows: [], outcome: [] }));

    const result = await preview(definition(), 2, hostCtx(), { registry });

    expect(result.rows).toHaveLength(2);
    expect(result.read).toBe(2);
  });
});
