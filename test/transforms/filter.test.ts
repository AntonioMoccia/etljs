import { describe, expect, test } from "vitest";
import { mockCtx, testTransformer } from "@etl-js/testing";
import { filterPlugin as plugin } from "etl-js/transforms";

async function filter(config: unknown, rows: Record<string, unknown>[]) {
  return testTransformer(plugin, { rows, config, ctx: mockCtx() });
}

describe("filter", () => {
  test("scarta le righe col campo vuoto, che e' il caso del file di dati", async () => {
    const result = await filter({ drop: [{ field: "Ordine", empty: true }] }, [
      { Ordine: "COD-1" },
      { Ordine: "" },
      { Ordine: null },
      { Ordine: "   " },
    ]);
    expect(result.rows).toEqual([{ Ordine: "COD-1" }]);
  });

  test("scarta la riga dei totali riconoscendola da un'espressione", async () => {
    const result = await filter({ drop: [{ field: "Ordine", matches: "^(TOTALE|TOT\\.)" }] }, [
      { Ordine: "COD-1" },
      { Ordine: "TOTALE" },
      { Ordine: "TOT. GENERALE" },
    ]);
    expect(result.rows).toEqual([{ Ordine: "COD-1" }]);
  });

  test("l'espressione e' ancorata ai dati, non al caso: si puo' chiedere ignoreCase", async () => {
    const result = await filter(
      { drop: [{ field: "Ordine", matches: "^totale", ignoreCase: true }] },
      [{ Ordine: "TOTALE" }, { Ordine: "COD-1" }],
    );
    expect(result.rows).toEqual([{ Ordine: "COD-1" }]);
  });

  test("scarta le righe completamente vuote", async () => {
    const result = await filter({ drop: [{ allEmpty: true }] }, [
      { a: "", b: null },
      { a: "1", b: "" },
    ]);
    expect(result.rows).toEqual([{ a: "1", b: "" }]);
  });

  test("piu' condizioni nella stessa regola valgono insieme", async () => {
    const result = await filter({ drop: [{ field: "stato", equals: "annullato" }] }, [
      { stato: "aperto" },
      { stato: "annullato" },
    ]);
    expect(result.rows).toEqual([{ stato: "aperto" }]);
  });

  test("regole diverse scartano in alternativa", async () => {
    const result = await filter(
      { drop: [{ field: "a", empty: true }, { field: "b", equals: "no" }] },
      [{ a: "1", b: "si" }, { a: "", b: "si" }, { a: "1", b: "no" }],
    );
    expect(result.rows).toEqual([{ a: "1", b: "si" }]);
  });

  test("keep tiene solo cio' che corrisponde", async () => {
    const result = await filter({ keep: [{ field: "tipo", in: ["attivo", "sospeso"] }] }, [
      { tipo: "attivo" },
      { tipo: "preventivo" },
      { tipo: "sospeso" },
    ]);
    expect(result.rows.map((r) => r["tipo"])).toEqual(["attivo", "sospeso"]);
  });

  test("keep e drop insieme: prima si tiene, poi si scarta", async () => {
    const result = await filter(
      { keep: [{ field: "tipo", equals: "attivo" }], drop: [{ field: "qta", equals: "0" }] },
      [{ tipo: "attivo", qta: "5" }, { tipo: "attivo", qta: "0" }, { tipo: "sospeso", qta: "5" }],
    );
    expect(result.rows).toEqual([{ tipo: "attivo", qta: "5" }]);
  });

  test("in silenzio per scelta: un filtro non e' uno scarto", async () => {
    const result = await filter({ drop: [{ field: "a", empty: true }] }, [{ a: "" }]);
    expect(result.failed).toEqual([]);
  });

  test("con report: true le righe filtrate diventano tracciabili", async () => {
    const result = await filter({ drop: [{ field: "a", empty: true }], report: true }, [
      { a: "1" },
      { a: "" },
    ]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ code: "FILTERED", severity: "warn", offset: 1 });
  });

  test("confronti numerici su valori gia' convertiti", async () => {
    const result = await filter({ drop: [{ field: "qta", lt: 1 }] }, [
      { qta: 5 },
      { qta: 0 },
      { qta: -3 },
    ]);
    expect(result.rows.map((r) => r["qta"])).toEqual([5]);
  });

  test("una regola senza alcuna condizione e' una config invalida, non un drop di tutto", async () => {
    await expect(filter({ drop: [{}] }, [{ a: 1 }])).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  test("un'espressione regolare malformata e' una config invalida", async () => {
    await expect(filter({ drop: [{ field: "a", matches: "([" }] }, [{ a: "x" }])).rejects.toMatchObject(
      { code: "CONFIG_INVALID" },
    );
  });

  test("senza regole non tocca nulla", async () => {
    const result = await filter({}, [{ a: 1 }, { a: 2 }]);
    expect(result.rows).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
