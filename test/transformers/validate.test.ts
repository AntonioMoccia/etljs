import { afterEach, describe, expect, test, vi } from "vitest";
import { batchOf, mockCtx, testTransformer } from "@etl-js/testing";
import { validateTransformer as plugin } from "etl-js/transformers";

async function check(config: unknown, rows: Record<string, unknown>[], ctx = mockCtx()) {
  return testTransformer(plugin, { rows, config, ctx });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("validate", () => {
  test("min scarta le quantita' sotto la soglia e dice quale regola e' stata violata", async () => {
    const result = await check({ rules: [{ field: "quantita", min: 1, severity: "reject" }] }, [
      { quantita: 5 },
      { quantita: 0 },
    ]);
    expect(result.rows).toEqual([{ quantita: 5 }]);
    expect(result.failed[0]).toMatchObject({
      code: "VALIDATION_FAILED",
      severity: "reject",
      offset: 1,
    });
    expect(result.failed[0]?.reason).toContain("quantita");
  });

  test("severity warn lascia passare la riga ma la segnala", async () => {
    const result = await check({ rules: [{ field: "quantita", min: 1, severity: "warn" }] }, [
      { quantita: 0 },
    ]);
    expect(result.rows).toEqual([{ quantita: 0 }]);
    expect(result.failed[0]).toMatchObject({ severity: "warn" });
  });

  test("severity e' reject se non si dice altro: nel dubbio il dato non entra", async () => {
    const result = await check({ rules: [{ field: "quantita", min: 1 }] }, [{ quantita: 0 }]);
    expect(result.rows).toEqual([]);
    expect(result.failed[0]?.severity).toBe("reject");
  });

  test("required coglie il campo assente e quello vuoto", async () => {
    const result = await check({ rules: [{ field: "codice", required: true }] }, [
      { codice: "COD-1" },
      { codice: "" },
      { altro: 1 },
    ]);
    expect(result.rows).toEqual([{ codice: "COD-1" }]);
    expect(result.failed).toHaveLength(2);
  });

  test("max, minLength e maxLength", async () => {
    const result = await check(
      {
        rules: [
          { field: "qta", max: 100 },
          { field: "codice", minLength: 3, maxLength: 8 },
        ],
      },
      [
        { qta: 50, codice: "COD-1" },
        { qta: 500, codice: "COD-1" },
        { qta: 50, codice: "AB" },
      ],
    );
    expect(result.rows).toEqual([{ qta: 50, codice: "COD-1" }]);
    expect(result.failed).toHaveLength(2);
  });

  test("matches e in", async () => {
    const result = await check(
      {
        rules: [
          { field: "codice", matches: "^COD-\\d+$" },
          { field: "stato", in: ["aperto", "chiuso"] },
        ],
      },
      [
        { codice: "COD-1", stato: "aperto" },
        { codice: "XYZ", stato: "aperto" },
        { codice: "COD-2", stato: "boh" },
      ],
    );
    expect(result.rows).toEqual([{ codice: "COD-1", stato: "aperto" }]);
    expect(result.failed).toHaveLength(2);
  });

  test("notBefore today confronta con la data odierna", async () => {
    vi.useFakeTimers({ now: new Date("2026-02-10T09:00:00Z") });
    const result = await check(
      { rules: [{ field: "data_documento", notBefore: "today", severity: "warn" }] },
      [{ data_documento: "2026-02-15" }, { data_documento: "2026-02-01" }, { data_documento: "2026-02-10" }],
    );
    expect(result.rows).toHaveLength(3);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toContain("2026-02-01");
  });

  test("notBefore e notAfter accettano anche una data fissa", async () => {
    const result = await check(
      { rules: [{ field: "data_documento", notBefore: "2026-01-01", notAfter: "2026-12-31" }] },
      [{ data_documento: "2026-06-01" }, { data_documento: "2025-12-31" }, { data_documento: "2027-01-01" }],
    );
    expect(result.rows).toEqual([{ data_documento: "2026-06-01" }]);
    expect(result.failed).toHaveLength(2);
  });

  test("una data non leggibile viene segnalata invece di passare inosservata", async () => {
    const result = await check({ rules: [{ field: "data_documento", notBefore: "2026-01-01" }] }, [
      { data_documento: "03/02/2026" },
    ]);
    expect(result.failed[0]?.reason).toContain("non e' una data");
  });

  test("unique coglie il duplicato, non la prima occorrenza", async () => {
    const ctx = mockCtx();
    const result = await testTransformer(plugin, {
      batches: [
        batchOf([{ codice: "COD-1" }, { codice: "COD-2" }], { runId: ctx.runId }),
        batchOf([{ codice: "COD-1" }], { runId: ctx.runId, offset: 2 }),
      ],
      config: { rules: [{ field: "codice", unique: true }] },
      ctx,
    });
    expect(result.rows.map((r) => r["codice"])).toEqual(["COD-1", "COD-2"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ offset: 2, code: "VALIDATION_FAILED" });
  });

  test("un messaggio su misura sostituisce quello automatico", async () => {
    const result = await check(
      { rules: [{ field: "quantita", min: 1, message: "la quantita' non puo' essere zero" }] },
      [{ quantita: 0 }],
    );
    expect(result.failed[0]?.reason).toBe("la quantita' non puo' essere zero");
  });

  test("una riga che viola due regole viene segnalata due volte ma scartata una", async () => {
    const result = await check(
      { rules: [{ field: "a", required: true }, { field: "b", required: true }] },
      [{ a: "", b: "" }],
    );
    expect(result.rows).toEqual([]);
    expect(result.failed).toHaveLength(2);
  });

  test("un campo vuoto non fa scattare le regole di intervallo se non e' required", async () => {
    const result = await check({ rules: [{ field: "qta", min: 1 }] }, [{ qta: null }]);
    expect(result.rows).toEqual([{ qta: null }]);
    expect(result.failed).toEqual([]);
  });

  test("una regola senza alcun controllo e' una config invalida", async () => {
    await expect(check({ rules: [{ field: "a" }] }, [{ a: 1 }])).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  test("un'espressione regolare malformata e' una config invalida", async () => {
    await expect(check({ rules: [{ field: "a", matches: "([" }] }, [{ a: "x" }])).rejects.toMatchObject(
      { code: "CONFIG_INVALID" },
    );
  });
});
