import { describe, expect, test } from "vitest";
import { mockCtx, testTransformer } from "@etljs/testing";
import { renameTransformer as plugin } from "etljs/transformers";

async function rename(config: unknown, rows: Record<string, unknown>[]) {
  return testTransformer(plugin, { rows, config, ctx: mockCtx() });
}

describe("rename", () => {
  test("porta le intestazioni del file di origine sui nomi interni", async () => {
    const result = await rename(
      { map: { "Codice": "codice", Data: "data_documento" } },
      [{ "Codice": "COD-1", Data: "03/02/2026", Altro: "x" }],
    );
    expect(result.rows).toEqual([
      { codice: "COD-1", data_documento: "03/02/2026", Altro: "x" },
    ]);
  });

  test("l'ordine dei campi segue la mappa, cosi' la landing table e' prevedibile", async () => {
    const result = await rename({ map: { b: "beta", a: "alfa" } }, [{ a: 1, b: 2 }]);
    expect(Object.keys(result.rows[0] ?? {})).toEqual(["beta", "alfa"]);
  });

  test("con keepUnmapped false restano solo i campi nominati", async () => {
    const result = await rename({ map: { a: "alfa" }, keepUnmapped: false }, [{ a: 1, b: 2 }]);
    expect(result.rows).toEqual([{ alfa: 1 }]);
  });

  test("drop elimina colonne che non servono", async () => {
    const result = await rename({ map: {}, drop: ["nota"] }, [{ a: 1, nota: "x" }]);
    expect(result.rows).toEqual([{ a: 1 }]);
  });

  test("una colonna attesa e assente viene segnalata se strict", async () => {
    const result = await rename({ map: { "Codice": "codice" }, strict: true }, [
      { Altro: "x" },
    ]);
    expect(result.rows).toEqual([]);
    expect(result.failed[0]).toMatchObject({ code: "RENAME_MISSING_COLUMN", severity: "reject" });
    expect(result.failed[0]?.reason).toContain("Codice");
  });

  test("senza strict una colonna assente semplicemente non compare", async () => {
    const result = await rename({ map: { "Codice": "codice" } }, [{ Altro: "x" }]);
    expect(result.rows).toEqual([{ Altro: "x" }]);
    expect(result.failed).toEqual([]);
  });

  test("rinominare due colonne sullo stesso nome e' una config invalida", async () => {
    await expect(rename({ map: { a: "x", b: "x" } }, [{ a: 1, b: 2 }])).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  test("normalizza gli spazi delle intestazioni quando il flusso li cambia", async () => {
    const result = await rename({ map: { "Cod  Articolo": "codice" }, trimKeys: true }, [
      { " Cod  Articolo ": "COD-1" },
    ]);
    expect(result.rows).toEqual([{ codice: "COD-1" }]);
  });

  test("una mappa vuota lascia tutto com'e'", async () => {
    const result = await rename({ map: {} }, [{ a: 1 }]);
    expect(result.rows).toEqual([{ a: 1 }]);
  });
});
