import { describe, expect, test } from "vitest";
import { mockCtx, testTransformer } from "@etl-js/testing";
import { castPlugin as plugin } from "../src/index.js";

async function cast(config: unknown, rows: Record<string, unknown>[]) {
  return testTransformer(plugin, { rows, config, ctx: mockCtx() });
}

describe("cast: date", () => {
  test("dd/MM/yyyy diventa una data ISO, che e' quello che il database vuole", async () => {
    const result = await cast({ data: { date: "dd/MM/yyyy" } }, [{ data: "03/02/2026" }]);
    expect(result.rows).toEqual([{ data: "2026-02-03" }]);
  });

  test("il giorno 13 non viene scambiato per un mese", async () => {
    const result = await cast({ data: { date: "dd/MM/yyyy" } }, [{ data: "13/01/2026" }]);
    expect(result.rows).toEqual([{ data: "2026-01-13" }]);
  });

  test("una data inesistente non diventa il mese successivo", async () => {
    const result = await cast({ data: { date: "dd/MM/yyyy" } }, [{ data: "31/02/2026" }]);
    expect(result.rows).toEqual([]);
    expect(result.failed[0]).toMatchObject({ code: "CAST_FAILED", severity: "reject" });
    expect(result.failed[0]?.reason).toContain("31/02/2026");
  });

  test("altri formati: yyyy-MM-dd e d/M/yy", async () => {
    const a = await cast({ data: { date: "yyyy-MM-dd" } }, [{ data: "2026-02-03" }]);
    const b = await cast({ data: { date: "d/M/yy" } }, [{ data: "3/2/26" }]);
    expect(a.rows[0]?.["data"]).toBe("2026-02-03");
    expect(b.rows[0]?.["data"]).toBe("2026-02-03");
  });

  test("un orario si conserva in forma ISO senza fuso", async () => {
    const result = await cast({ quando: { datetime: "dd/MM/yyyy HH:mm" } }, [
      { quando: "03/02/2026 14:30" },
    ]);
    expect(result.rows).toEqual([{ quando: "2026-02-03T14:30:00" }]);
  });
});

describe("cast: settimane", () => {
  test("una settimana ISO diventa il lunedi' di quella settimana", async () => {
    const result = await cast({ periodo: { week: "ww/yyyy" } }, [{ periodo: "07/2026" }]);
    expect(result.rows).toEqual([{ periodo: "2026-02-09" }]);
  });

  test("la settimana 1 del 2026 parte dal 29 dicembre 2025, come dice la ISO 8601", async () => {
    const result = await cast({ periodo: { week: "ww/yyyy" } }, [{ periodo: "01/2026" }]);
    expect(result.rows).toEqual([{ periodo: "2025-12-29" }]);
  });

  test("il formato yyyy-Www e' accettato", async () => {
    const result = await cast({ periodo: { week: "yyyy-Www" } }, [{ periodo: "2026-W07" }]);
    expect(result.rows[0]?.["periodo"]).toBe("2026-02-09");
  });

  test("la settimana 54 non esiste", async () => {
    const result = await cast({ periodo: { week: "ww/yyyy" } }, [{ periodo: "54/2026" }]);
    expect(result.failed[0]?.code).toBe("CAST_FAILED");
  });
});

describe("cast: numeri", () => {
  test("la virgola decimale e il punto delle migliaia italiani", async () => {
    const result = await cast(
      { qta: { number: { decimal: ",", thousands: "." } } },
      [{ qta: "1.250,50" }],
    );
    expect(result.rows).toEqual([{ qta: 1250.5 }]);
  });

  test("un numero senza separatori resta se stesso", async () => {
    const result = await cast({ qta: { number: { decimal: "," } } }, [{ qta: "12" }]);
    expect(result.rows).toEqual([{ qta: 12 }]);
  });

  test("il segno meno e le parentesi contabili", async () => {
    const result = await cast({ qta: { number: { decimal: "," } } }, [
      { qta: "-7,5" },
      { qta: "(7,5)" },
    ]);
    expect(result.rows.map((r) => r["qta"])).toEqual([-7.5, -7.5]);
  });

  test("il testo che non e' un numero viene scartato, non convertito in NaN", async () => {
    const result = await cast({ qta: { number: {} } }, [{ qta: "n/d" }]);
    expect(result.rows).toEqual([]);
    expect(result.failed[0]?.code).toBe("CAST_FAILED");
  });

  test("integer rifiuta i decimali invece di troncarli in silenzio", async () => {
    const result = await cast({ qta: { integer: { decimal: "," } } }, [{ qta: "7,5" }]);
    expect(result.failed[0]?.code).toBe("CAST_FAILED");
  });

  test("una percentuale con simbolo viene ripulita", async () => {
    const result = await cast({ sconto: { number: { decimal: ",", strip: "%" } } }, [
      { sconto: "12,5%" },
    ]);
    expect(result.rows).toEqual([{ sconto: 12.5 }]);
  });
});

describe("cast: booleani e stringhe", () => {
  test("i valori veri e falsi si dichiarano nella config, non nel codice (I8)", async () => {
    const result = await cast(
      { urgente: { boolean: { true: ["si", "x"], false: ["no", ""] } } },
      [{ urgente: "si" }, { urgente: "no" }, { urgente: "X" }],
    );
    expect(result.rows.map((r) => r["urgente"])).toEqual([true, false, true]);
  });

  test("un valore non previsto fra i booleani viene segnalato", async () => {
    const result = await cast({ urgente: { boolean: { true: ["si"], false: ["no"] } } }, [
      { urgente: "forse" },
    ]);
    expect(result.failed[0]?.code).toBe("CAST_FAILED");
  });

  test("string sa ripulire spazi e uniformare le maiuscole", async () => {
    const result = await cast({ codice: { string: { trim: true, case: "upper" } } }, [
      { codice: "  ord-1 " },
    ]);
    expect(result.rows).toEqual([{ codice: "ORD-1" }]);
  });
});

describe("cast: valori assenti e politiche di errore", () => {
  test("un campo vuoto diventa null se il campo e' dichiarato nullable", async () => {
    const result = await cast({ data: { date: "dd/MM/yyyy", nullable: true } }, [{ data: "" }]);
    expect(result.rows).toEqual([{ data: null }]);
    expect(result.failed).toEqual([]);
  });

  test("un campo vuoto non nullable e' un errore, non uno zero silenzioso", async () => {
    const result = await cast({ qta: { number: {} } }, [{ qta: "" }]);
    expect(result.rows).toEqual([]);
    expect(result.failed[0]?.code).toBe("CAST_FAILED");
  });

  test("onError warn tiene la riga e mette null, segnalando", async () => {
    const result = await cast({ qta: { number: {}, onError: "warn" } }, [{ qta: "n/d" }]);
    expect(result.rows).toEqual([{ qta: null }]);
    expect(result.failed[0]).toMatchObject({ severity: "warn" });
  });

  test("onError skip elimina la riga senza rumore", async () => {
    const result = await cast({ qta: { number: {}, onError: "skip" } }, [{ qta: "n/d" }]);
    expect(result.rows).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  test("un campo assente dalla riga non viene inventato", async () => {
    const result = await cast({ mancante: { number: {}, nullable: true } }, [{ altro: 1 }]);
    expect(result.rows).toEqual([{ altro: 1, mancante: null }]);
  });

  test("gli errori riportano il campo e l'offset della riga nel file", async () => {
    const result = await cast({ qta: { number: {} } }, [{ qta: "1" }, { qta: "boh" }]);
    expect(result.failed[0]).toMatchObject({ offset: 1 });
    expect(result.failed[0]?.reason).toContain("qta");
  });

  test("i campi non nominati nella config restano intatti", async () => {
    const result = await cast({ qta: { number: {} } }, [{ qta: "1", nota: "  spazi  " }]);
    expect(result.rows).toEqual([{ qta: 1, nota: "  spazi  " }]);
  });

  test("un formato di data sconosciuto e' una config invalida", async () => {
    await expect(cast({ data: { date: "gg/mm/aaaa" } }, [{ data: "03/02/2026" }])).rejects.toMatchObject(
      { code: "CONFIG_INVALID" },
    );
  });
});
