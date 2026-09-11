import { describe, expect, test } from "vitest";
import type { Row } from "etl-js/contracts";
import { batchOf, mockCtx, recordingDb, testTransformer } from "@etl-js/testing";
import { plugin } from "etl-js/lookup";

/** Database che risponde con le righe di `anagrafica` filtrate sui parametri ricevuti. */
function anagraficaDb(anagrafica: Row[]) {
  return recordingDb((_sql, params) => {
    const wanted = new Set(
      (Array.isArray(params[0]) ? (params[0] as unknown[]) : params).map((v) => String(v)),
    );
    return anagrafica.filter((row) => wanted.has(String(row["codice"])));
  });
}

const baseConfig = {
  db: "principale",
  table: "anagrafica",
  on: ["codice"],
  select: "anagrafica_id",
};

describe("lookup", () => {
  test("attacca alla riga il campo trovato sul database", async () => {
    const db = anagraficaDb([{ codice: "COD-1", anagrafica_id: 11 }]);
    const result = await testTransformer(plugin, {
      rows: [{ codice: "COD-1", qta: 5 }],
      config: baseConfig,
      ctx: mockCtx({ databases: { principale: db } }),
    });

    expect(result.rows).toEqual([{ codice: "COD-1", qta: 5, anagrafica_id: 11 }]);
    expect(result.failed).toEqual([]);
  });

  test("una sola interrogazione per lotto, non una per riga (I5)", async () => {
    const db = anagraficaDb([
      { codice: "COD-1", anagrafica_id: 11 },
      { codice: "COD-2", anagrafica_id: 12 },
      { codice: "COD-3", anagrafica_id: 13 },
    ]);
    const result = await testTransformer(plugin, {
      rows: [
        { codice: "COD-1" },
        { codice: "COD-2" },
        { codice: "COD-3" },
      ],
      config: baseConfig,
      ctx: mockCtx({ databases: { principale: db } }),
    });

    expect(db.calls).toHaveLength(1);
    expect(result.rows.map((r) => r["anagrafica_id"])).toEqual([11, 12, 13]);
  });

  test("con una sola chiave usa = ANY($1) e passa i valori come parametro", async () => {
    const db = anagraficaDb([]);
    await testTransformer(plugin, {
      rows: [{ codice: "COD-1" }, { codice: "COD-2" }],
      config: { ...baseConfig, onMissing: "skip" },
      ctx: mockCtx({ databases: { principale: db } }),
    });

    const call = db.calls[0];
    expect(call?.sql).toContain('"codice" = ANY($1)');
    expect(call?.params).toEqual([["COD-1", "COD-2"]]);
    // Nessun valore e' finito nel testo dell'istruzione (I7).
    expect(call?.sql).not.toContain("COD-1");
  });

  test("le chiavi ripetute vengono chieste una volta sola", async () => {
    const db = anagraficaDb([{ codice: "COD-1", anagrafica_id: 11 }]);
    await testTransformer(plugin, {
      rows: [{ codice: "COD-1" }, { codice: "COD-1" }],
      config: baseConfig,
      ctx: mockCtx({ databases: { principale: db } }),
    });
    expect(db.calls[0]?.params).toEqual([["COD-1"]]);
  });

  test("onMissing reject: la riga esce dal flusso con motivo e codice", async () => {
    const db = anagraficaDb([{ codice: "COD-1", anagrafica_id: 11 }]);
    const result = await testTransformer(plugin, {
      rows: [{ codice: "COD-1" }, { codice: "SCONOSCIUTO" }],
      config: { ...baseConfig, onMissing: "reject" },
      ctx: mockCtx({ databases: { principale: db } }),
    });

    expect(result.rows).toEqual([{ codice: "COD-1", anagrafica_id: 11 }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ code: "LOOKUP_MISSING", severity: "reject", offset: 1 });
    expect(result.failed[0]?.reason).toContain("SCONOSCIUTO");
  });

  test("onMissing warn: la riga resta, i campi cercati sono null, la segnalazione c'e'", async () => {
    const db = anagraficaDb([]);
    const result = await testTransformer(plugin, {
      rows: [{ codice: "SCONOSCIUTO" }],
      config: { ...baseConfig, onMissing: "warn" },
      ctx: mockCtx({ databases: { principale: db } }),
    });

    expect(result.rows).toEqual([{ codice: "SCONOSCIUTO", anagrafica_id: null }]);
    expect(result.failed[0]).toMatchObject({ severity: "warn", code: "LOOKUP_MISSING" });
  });

  test("onMissing skip: la riga sparisce in silenzio", async () => {
    const db = anagraficaDb([]);
    const result = await testTransformer(plugin, {
      rows: [{ codice: "SCONOSCIUTO" }],
      config: { ...baseConfig, onMissing: "skip" },
      ctx: mockCtx({ databases: { principale: db } }),
    });

    expect(result.rows).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  test("presenti, assenti e ripetuti nello stesso lotto vengono trattati ciascuno per se'", async () => {
    const db = anagraficaDb([
      { codice: "COD-1", anagrafica_id: 11 },
      { codice: "COD-3", anagrafica_id: 13 },
    ]);
    const result = await testTransformer(plugin, {
      rows: [
        { codice: "COD-1" },
        { codice: "COD-2" },
        { codice: "COD-3" },
        { codice: "COD-2" },
      ],
      config: { ...baseConfig, onMissing: "reject" },
      ctx: mockCtx({ databases: { principale: db } }),
    });

    expect(result.rows.map((r) => r["anagrafica_id"])).toEqual([11, 13]);
    expect(result.failed.map((f) => f.offset)).toEqual([1, 3]);
  });

  test("la cache del run evita di richiedere chiavi gia' viste in un lotto precedente", async () => {
    const db = anagraficaDb([
      { codice: "COD-1", anagrafica_id: 11 },
      { codice: "COD-2", anagrafica_id: 12 },
    ]);
    const ctx = mockCtx({ databases: { principale: db } });

    await testTransformer(plugin, {
      batches: [
        batchOf([{ codice: "COD-1" }], { runId: ctx.runId, offset: 0 }),
        batchOf([{ codice: "COD-1" }, { codice: "COD-2" }], {
          runId: ctx.runId,
          offset: 1,
        }),
      ],
      config: baseConfig,
      ctx,
    });

    expect(db.calls).toHaveLength(2);
    // Il secondo lotto chiede solo la chiave nuova.
    expect(db.calls[1]?.params).toEqual([["COD-2"]]);
  });

  test("un lotto interamente in cache non interroga affatto il database", async () => {
    const db = anagraficaDb([{ codice: "COD-1", anagrafica_id: 11 }]);
    const ctx = mockCtx({ databases: { principale: db } });
    await testTransformer(plugin, {
      batches: [
        batchOf([{ codice: "COD-1" }], { runId: ctx.runId }),
        batchOf([{ codice: "COD-1" }], { runId: ctx.runId, offset: 1 }),
      ],
      config: baseConfig,
      ctx,
    });
    expect(db.calls).toHaveLength(1);
  });

  test("chiavi composite: una sola interrogazione, valori tutti parametrizzati", async () => {
    const db = recordingDb(() => [{ anno: 2026, numero: "7", anagrafica_id: 77 }]);
    const result = await testTransformer(plugin, {
      rows: [{ anno: 2026, numero: "7" }],
      config: { db: "principale", table: "anagrafica", on: ["anno", "numero"], select: "anagrafica_id" },
      ctx: mockCtx({ databases: { principale: db } }),
    });

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.sql).toContain('("anno", "numero") IN (($1, $2))');
    expect(db.calls[0]?.params).toEqual([2026, "7"]);
    expect(result.rows[0]?.["anagrafica_id"]).toBe(77);
  });

  test("il campo della riga puo' chiamarsi diversamente dalla colonna", async () => {
    const db = recordingDb(() => [{ codice: "COD-1", anagrafica_id: 11 }]);
    const result = await testTransformer(plugin, {
      rows: [{ codice: "COD-1" }],
      config: {
        db: "principale",
        table: "anagrafica",
        on: [{ field: "codice", column: "codice" }],
        select: "anagrafica_id",
      },
      ctx: mockCtx({ databases: { principale: db } }),
    });

    expect(db.calls[0]?.sql).toContain('"codice" = ANY($1)');
    expect(result.rows[0]?.["anagrafica_id"]).toBe(11);
  });

  test("select come mappa: la colonna finisce nel campo che si vuole", async () => {
    const db = anagraficaDb([{ codice: "COD-1", anagrafica_id: 11, stato: "aperto" }]);
    const result = await testTransformer(plugin, {
      rows: [{ codice: "COD-1" }],
      config: { ...baseConfig, select: { anagrafica_id: "id_esterno", stato: "stato_record" } },
      ctx: mockCtx({ databases: { principale: db } }),
    });

    expect(result.rows[0]).toEqual({
      codice: "COD-1",
      id_esterno: 11,
      stato_record: "aperto",
    });
  });

  test("una chiave vuota non viene nemmeno chiesta al database", async () => {
    const db = anagraficaDb([{ codice: "COD-1", anagrafica_id: 11 }]);
    const result = await testTransformer(plugin, {
      rows: [{ codice: "" }, { codice: null }, { codice: "COD-1" }],
      config: { ...baseConfig, onMissing: "reject" },
      ctx: mockCtx({ databases: { principale: db } }),
    });

    expect(db.calls[0]?.params).toEqual([["COD-1"]]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.code).toBe("LOOKUP_KEY_EMPTY");
  });

  test("due righe del database per la stessa chiave non vengono scelte a caso", async () => {
    const db = recordingDb(() => [
      { codice: "COD-1", anagrafica_id: 11 },
      { codice: "COD-1", anagrafica_id: 12 },
    ]);
    const result = await testTransformer(plugin, {
      rows: [{ codice: "COD-1" }],
      config: baseConfig,
      ctx: mockCtx({ databases: { principale: db } }),
    });

    expect(result.rows).toEqual([]);
    expect(result.failed[0]).toMatchObject({ code: "LOOKUP_AMBIGUOUS", severity: "reject" });
  });

  test("con onDuplicate first la prima corrispondenza va bene", async () => {
    const db = recordingDb(() => [
      { codice: "COD-1", anagrafica_id: 11 },
      { codice: "COD-1", anagrafica_id: 12 },
    ]);
    const result = await testTransformer(plugin, {
      rows: [{ codice: "COD-1" }],
      config: { ...baseConfig, onDuplicate: "first" },
      ctx: mockCtx({ databases: { principale: db } }),
    });
    expect(result.rows[0]?.["anagrafica_id"]).toBe(11);
  });

  test("un filtro aggiuntivo usa solo operatori in whitelist e parametri", async () => {
    const db = recordingDb(() => []);
    await testTransformer(plugin, {
      rows: [{ codice: "COD-1" }],
      config: {
        ...baseConfig,
        onMissing: "skip",
        filter: [{ column: "stato", op: "eq", value: "aperto" }],
      },
      ctx: mockCtx({ databases: { principale: db } }),
    });

    expect(db.calls[0]?.sql).toContain('"stato" = $2');
    expect(db.calls[0]?.params[1]).toBe("aperto");
  });

  test("un operatore fuori whitelist e' una config invalida, non SQL grezzo", async () => {
    const db = recordingDb(() => []);
    await expect(
      testTransformer(plugin, {
        rows: [{ codice: "COD-1" }],
        config: { ...baseConfig, filter: [{ column: "stato", op: "; DROP TABLE", value: "x" }] },
        ctx: mockCtx({ databases: { principale: db } }),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  test("nomi di tabella e colonne ostili vengono quotati, non interpolati", async () => {
    const db = recordingDb(() => []);
    await testTransformer(plugin, {
      rows: [{ chiave: "x" }],
      config: {
        db: "principale",
        table: 'schema strano.tabella "citata"',
        on: ["chiave"],
        select: "valore",
        onMissing: "skip",
      },
      ctx: mockCtx({ databases: { principale: db } }),
    });

    expect(db.calls[0]?.sql).toContain('FROM "schema strano"."tabella ""citata"""');
  });

  test("un lotto vuoto non interroga il database", async () => {
    const db = recordingDb(() => []);
    const result = await testTransformer(plugin, {
      rows: [],
      config: baseConfig,
      ctx: mockCtx({ databases: { principale: db } }),
    });
    expect(db.calls).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  test("flush libera la cache del run invece di tenerla per sempre", async () => {
    const db = anagraficaDb([{ codice: "COD-1", anagrafica_id: 11 }]);
    const ctx = mockCtx({ databases: { principale: db } });

    await testTransformer(plugin, { rows: [{ codice: "COD-1" }], config: baseConfig, ctx });
    await testTransformer(plugin, { rows: [{ codice: "COD-1" }], config: baseConfig, ctx });

    // Dopo il flush del primo run la chiave viene richiesta di nuovo.
    expect(db.calls).toHaveLength(2);
  });
});
