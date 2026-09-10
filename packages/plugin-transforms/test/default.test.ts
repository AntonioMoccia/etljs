import { describe, expect, test } from "vitest";
import { mockCtx, testTransformer } from "@etl-js/testing";
import { defaultPlugin as plugin } from "../src/index.js";

async function fill(config: unknown, rows: Record<string, unknown>[]) {
  return testTransformer(plugin, { rows, config, ctx: mockCtx() });
}

describe("default", () => {
  test("aggiunge un campo che la riga non ha", async () => {
    const result = await fill({ values: { stato: "da_confermare" } }, [{ a: 1 }]);
    expect(result.rows).toEqual([{ a: 1, stato: "da_confermare" }]);
  });

  test("non sovrascrive un valore gia' presente", async () => {
    const result = await fill({ values: { stato: "da_confermare" } }, [{ stato: "aperto" }]);
    expect(result.rows).toEqual([{ stato: "aperto" }]);
  });

  test("di default riempie anche i campi vuoti o null, che nei CSV sono la norma", async () => {
    const result = await fill({ values: { stato: "da_confermare" } }, [
      { stato: "" },
      { stato: null },
    ]);
    expect(result.rows).toEqual([
      { stato: "da_confermare" },
      { stato: "da_confermare" },
    ]);
  });

  test('con when "missing" una stringa vuota resta una stringa vuota', async () => {
    const result = await fill({ values: { stato: { value: "x", when: "missing" } } }, [
      { stato: "" },
    ]);
    expect(result.rows).toEqual([{ stato: "" }]);
  });

  test('con when "always" il valore viene imposto', async () => {
    const result = await fill({ values: { origine: { value: "acme", when: "always" } } }, [
      { origine: "altro" },
    ]);
    expect(result.rows).toEqual([{ origine: "acme" }]);
  });

  test("il valore puo' essere un numero, un booleano o null, non solo testo", async () => {
    const result = await fill({ values: { qta: 0, attivo: false, nota: null } }, [{}]);
    expect(result.rows).toEqual([{ qta: 0, attivo: false, nota: null }]);
  });

  test("copia il valore di un altro campo quando serve la provenienza", async () => {
    const result = await fill({ values: { codice: { fromField: "Nr Ordine" } } }, [
      { "Nr Ordine": "ORD-1" },
    ]);
    expect(result.rows).toEqual([{ "Nr Ordine": "ORD-1", codice: "ORD-1" }]);
  });

  test("copiare da un campo assente lascia il campo assente, non undefined", async () => {
    const result = await fill({ values: { codice: { fromField: "boh" } } }, [{ a: 1 }]);
    expect(result.rows).toEqual([{ a: 1, codice: null }]);
  });

  test("marca ogni riga con run, file e numero di riga: la provenienza e' un valore, non un ramo del motore", async () => {
    const result = await testTransformer(plugin, {
      batches: [
        {
          rows: [{ a: 1 }, { a: 2 }],
          meta: { runId: "run-42", source: "acme_2026-02.csv", offset: 10 },
        },
      ],
      config: {
        values: {
          run_id: { fromMeta: "runId", when: "always" },
          file_origine: { fromMeta: "source", when: "always" },
          riga_origine: { fromMeta: "offset", when: "always" },
        },
      },
      ctx: mockCtx({ runId: "run-42" }),
    });

    expect(result.rows).toEqual([
      { a: 1, run_id: "run-42", file_origine: "acme_2026-02.csv", riga_origine: 10 },
      { a: 2, run_id: "run-42", file_origine: "acme_2026-02.csv", riga_origine: 11 },
    ]);
  });

  test("i campi non nominati restano com'erano", async () => {
    const result = await fill({ values: { stato: "x" } }, [{ a: 1, b: 2 }]);
    expect(result.rows).toEqual([{ a: 1, b: 2, stato: "x" }]);
  });

  test("non scarta mai nulla: non e' il suo mestiere", async () => {
    const result = await fill({ values: { stato: "x" } }, [{ a: 1 }, { a: 2 }]);
    expect(result.failed).toEqual([]);
    expect(result.rows).toHaveLength(2);
  });

  test("una config senza values e' invalida", async () => {
    await expect(fill({}, [{ a: 1 }])).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
