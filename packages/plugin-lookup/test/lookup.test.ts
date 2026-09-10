import { describe, expect, test } from "vitest";
import type { Row } from "@etl-js/contracts";
import { batchOf, mockCtx, recordingDb, testTransformer } from "@etl-js/testing";
import { plugin } from "../src/index.js";

/** Database che risponde con le righe di `ordini` filtrate sui parametri ricevuti. */
function ordiniDb(ordini: Row[]) {
  return recordingDb((_sql, params) => {
    const wanted = new Set(
      (Array.isArray(params[0]) ? (params[0] as unknown[]) : params).map((v) => String(v)),
    );
    return ordini.filter((row) => wanted.has(String(row["ordine_cliente"])));
  });
}

const baseConfig = {
  db: "gestionale",
  table: "ordini",
  on: ["ordine_cliente"],
  select: "ordine_id",
};

describe("lookup", () => {
  test("attacca alla riga il campo trovato sul gestionale", async () => {
    const db = ordiniDb([{ ordine_cliente: "ORD-1", ordine_id: 11 }]);
    const result = await testTransformer(plugin, {
      rows: [{ ordine_cliente: "ORD-1", qta: 5 }],
      config: baseConfig,
      ctx: mockCtx({ databases: { gestionale: db } }),
    });

    expect(result.rows).toEqual([{ ordine_cliente: "ORD-1", qta: 5, ordine_id: 11 }]);
    expect(result.failed).toEqual([]);
  });

  test("una sola interrogazione per lotto, non una per riga (I5)", async () => {
    const db = ordiniDb([
      { ordine_cliente: "ORD-1", ordine_id: 11 },
      { ordine_cliente: "ORD-2", ordine_id: 12 },
      { ordine_cliente: "ORD-3", ordine_id: 13 },
    ]);
    const result = await testTransformer(plugin, {
      rows: [
        { ordine_cliente: "ORD-1" },
        { ordine_cliente: "ORD-2" },
        { ordine_cliente: "ORD-3" },
      ],
      config: baseConfig,
      ctx: mockCtx({ databases: { gestionale: db } }),
    });

    expect(db.calls).toHaveLength(1);
    expect(result.rows.map((r) => r["ordine_id"])).toEqual([11, 12, 13]);
  });

  test("con una sola chiave usa = ANY($1) e passa i valori come parametro", async () => {
    const db = ordiniDb([]);
    await testTransformer(plugin, {
      rows: [{ ordine_cliente: "ORD-1" }, { ordine_cliente: "ORD-2" }],
      config: { ...baseConfig, onMissing: "skip" },
      ctx: mockCtx({ databases: { gestionale: db } }),
    });

    const call = db.calls[0];
    expect(call?.sql).toContain('"ordine_cliente" = ANY($1)');
    expect(call?.params).toEqual([["ORD-1", "ORD-2"]]);
    // Nessun valore e' finito nel testo dell'istruzione (I7).
    expect(call?.sql).not.toContain("ORD-1");
  });

  test("le chiavi ripetute vengono chieste una volta sola", async () => {
    const db = ordiniDb([{ ordine_cliente: "ORD-1", ordine_id: 11 }]);
    await testTransformer(plugin, {
      rows: [{ ordine_cliente: "ORD-1" }, { ordine_cliente: "ORD-1" }],
      config: baseConfig,
      ctx: mockCtx({ databases: { gestionale: db } }),
    });
    expect(db.calls[0]?.params).toEqual([["ORD-1"]]);
  });

  test("onMissing reject: la riga esce dal flusso con motivo e codice", async () => {
    const db = ordiniDb([{ ordine_cliente: "ORD-1", ordine_id: 11 }]);
    const result = await testTransformer(plugin, {
      rows: [{ ordine_cliente: "ORD-1" }, { ordine_cliente: "SCONOSCIUTO" }],
      config: { ...baseConfig, onMissing: "reject" },
      ctx: mockCtx({ databases: { gestionale: db } }),
    });

    expect(result.rows).toEqual([{ ordine_cliente: "ORD-1", ordine_id: 11 }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ code: "LOOKUP_MISSING", severity: "reject", offset: 1 });
    expect(result.failed[0]?.reason).toContain("SCONOSCIUTO");
  });

  test("onMissing warn: la riga resta, i campi cercati sono null, la segnalazione c'e'", async () => {
    const db = ordiniDb([]);
    const result = await testTransformer(plugin, {
      rows: [{ ordine_cliente: "SCONOSCIUTO" }],
      config: { ...baseConfig, onMissing: "warn" },
      ctx: mockCtx({ databases: { gestionale: db } }),
    });

    expect(result.rows).toEqual([{ ordine_cliente: "SCONOSCIUTO", ordine_id: null }]);
    expect(result.failed[0]).toMatchObject({ severity: "warn", code: "LOOKUP_MISSING" });
  });

  test("onMissing skip: la riga sparisce in silenzio", async () => {
    const db = ordiniDb([]);
    const result = await testTransformer(plugin, {
      rows: [{ ordine_cliente: "SCONOSCIUTO" }],
      config: { ...baseConfig, onMissing: "skip" },
      ctx: mockCtx({ databases: { gestionale: db } }),
    });

    expect(result.rows).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  test("presenti, assenti e ripetuti nello stesso lotto vengono trattati ciascuno per se'", async () => {
    const db = ordiniDb([
      { ordine_cliente: "ORD-1", ordine_id: 11 },
      { ordine_cliente: "ORD-3", ordine_id: 13 },
    ]);
    const result = await testTransformer(plugin, {
      rows: [
        { ordine_cliente: "ORD-1" },
        { ordine_cliente: "ORD-2" },
        { ordine_cliente: "ORD-3" },
        { ordine_cliente: "ORD-2" },
      ],
      config: { ...baseConfig, onMissing: "reject" },
      ctx: mockCtx({ databases: { gestionale: db } }),
    });

    expect(result.rows.map((r) => r["ordine_id"])).toEqual([11, 13]);
    expect(result.failed.map((f) => f.offset)).toEqual([1, 3]);
  });

  test("la cache del run evita di richiedere chiavi gia' viste in un lotto precedente", async () => {
    const db = ordiniDb([
      { ordine_cliente: "ORD-1", ordine_id: 11 },
      { ordine_cliente: "ORD-2", ordine_id: 12 },
    ]);
    const ctx = mockCtx({ databases: { gestionale: db } });

    await testTransformer(plugin, {
      batches: [
        batchOf([{ ordine_cliente: "ORD-1" }], { runId: ctx.runId, offset: 0 }),
        batchOf([{ ordine_cliente: "ORD-1" }, { ordine_cliente: "ORD-2" }], {
          runId: ctx.runId,
          offset: 1,
        }),
      ],
      config: baseConfig,
      ctx,
    });

    expect(db.calls).toHaveLength(2);
    // Il secondo lotto chiede solo la chiave nuova.
    expect(db.calls[1]?.params).toEqual([["ORD-2"]]);
  });

  test("un lotto interamente in cache non interroga affatto il database", async () => {
    const db = ordiniDb([{ ordine_cliente: "ORD-1", ordine_id: 11 }]);
    const ctx = mockCtx({ databases: { gestionale: db } });
    await testTransformer(plugin, {
      batches: [
        batchOf([{ ordine_cliente: "ORD-1" }], { runId: ctx.runId }),
        batchOf([{ ordine_cliente: "ORD-1" }], { runId: ctx.runId, offset: 1 }),
      ],
      config: baseConfig,
      ctx,
    });
    expect(db.calls).toHaveLength(1);
  });

  test("chiavi composite: una sola interrogazione, valori tutti parametrizzati", async () => {
    const db = recordingDb(() => [{ anno: 2026, numero: "7", ordine_id: 77 }]);
    const result = await testTransformer(plugin, {
      rows: [{ anno: 2026, numero: "7" }],
      config: { db: "gestionale", table: "ordini", on: ["anno", "numero"], select: "ordine_id" },
      ctx: mockCtx({ databases: { gestionale: db } }),
    });

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.sql).toContain('("anno", "numero") IN (($1, $2))');
    expect(db.calls[0]?.params).toEqual([2026, "7"]);
    expect(result.rows[0]?.["ordine_id"]).toBe(77);
  });

  test("il campo della riga puo' chiamarsi diversamente dalla colonna", async () => {
    const db = recordingDb(() => [{ codice: "ORD-1", ordine_id: 11 }]);
    const result = await testTransformer(plugin, {
      rows: [{ ordine_cliente: "ORD-1" }],
      config: {
        db: "gestionale",
        table: "ordini",
        on: [{ field: "ordine_cliente", column: "codice" }],
        select: "ordine_id",
      },
      ctx: mockCtx({ databases: { gestionale: db } }),
    });

    expect(db.calls[0]?.sql).toContain('"codice" = ANY($1)');
    expect(result.rows[0]?.["ordine_id"]).toBe(11);
  });

  test("select come mappa: la colonna finisce nel campo che si vuole", async () => {
    const db = ordiniDb([{ ordine_cliente: "ORD-1", ordine_id: 11, stato: "aperto" }]);
    const result = await testTransformer(plugin, {
      rows: [{ ordine_cliente: "ORD-1" }],
      config: { ...baseConfig, select: { ordine_id: "id_gestionale", stato: "stato_ordine" } },
      ctx: mockCtx({ databases: { gestionale: db } }),
    });

    expect(result.rows[0]).toEqual({
      ordine_cliente: "ORD-1",
      id_gestionale: 11,
      stato_ordine: "aperto",
    });
  });

  test("una chiave vuota non viene nemmeno chiesta al database", async () => {
    const db = ordiniDb([{ ordine_cliente: "ORD-1", ordine_id: 11 }]);
    const result = await testTransformer(plugin, {
      rows: [{ ordine_cliente: "" }, { ordine_cliente: null }, { ordine_cliente: "ORD-1" }],
      config: { ...baseConfig, onMissing: "reject" },
      ctx: mockCtx({ databases: { gestionale: db } }),
    });

    expect(db.calls[0]?.params).toEqual([["ORD-1"]]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.code).toBe("LOOKUP_KEY_EMPTY");
  });

  test("due righe del gestionale per la stessa chiave non vengono scelte a caso", async () => {
    const db = recordingDb(() => [
      { ordine_cliente: "ORD-1", ordine_id: 11 },
      { ordine_cliente: "ORD-1", ordine_id: 12 },
    ]);
    const result = await testTransformer(plugin, {
      rows: [{ ordine_cliente: "ORD-1" }],
      config: baseConfig,
      ctx: mockCtx({ databases: { gestionale: db } }),
    });

    expect(result.rows).toEqual([]);
    expect(result.failed[0]).toMatchObject({ code: "LOOKUP_AMBIGUOUS", severity: "reject" });
  });

  test("con onDuplicate first la prima corrispondenza va bene", async () => {
    const db = recordingDb(() => [
      { ordine_cliente: "ORD-1", ordine_id: 11 },
      { ordine_cliente: "ORD-1", ordine_id: 12 },
    ]);
    const result = await testTransformer(plugin, {
      rows: [{ ordine_cliente: "ORD-1" }],
      config: { ...baseConfig, onDuplicate: "first" },
      ctx: mockCtx({ databases: { gestionale: db } }),
    });
    expect(result.rows[0]?.["ordine_id"]).toBe(11);
  });

  test("un filtro aggiuntivo usa solo operatori in whitelist e parametri", async () => {
    const db = recordingDb(() => []);
    await testTransformer(plugin, {
      rows: [{ ordine_cliente: "ORD-1" }],
      config: {
        ...baseConfig,
        onMissing: "skip",
        filter: [{ column: "stato", op: "eq", value: "aperto" }],
      },
      ctx: mockCtx({ databases: { gestionale: db } }),
    });

    expect(db.calls[0]?.sql).toContain('"stato" = $2');
    expect(db.calls[0]?.params[1]).toBe("aperto");
  });

  test("un operatore fuori whitelist e' una config invalida, non SQL grezzo", async () => {
    const db = recordingDb(() => []);
    await expect(
      testTransformer(plugin, {
        rows: [{ ordine_cliente: "ORD-1" }],
        config: { ...baseConfig, filter: [{ column: "stato", op: "; DROP TABLE", value: "x" }] },
        ctx: mockCtx({ databases: { gestionale: db } }),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  test("nomi di tabella e colonne ostili vengono quotati, non interpolati", async () => {
    const db = recordingDb(() => []);
    await testTransformer(plugin, {
      rows: [{ chiave: "x" }],
      config: {
        db: "gestionale",
        table: 'schema strano.tabella "citata"',
        on: ["chiave"],
        select: "valore",
        onMissing: "skip",
      },
      ctx: mockCtx({ databases: { gestionale: db } }),
    });

    expect(db.calls[0]?.sql).toContain('FROM "schema strano"."tabella ""citata"""');
  });

  test("un lotto vuoto non interroga il database", async () => {
    const db = recordingDb(() => []);
    const result = await testTransformer(plugin, {
      rows: [],
      config: baseConfig,
      ctx: mockCtx({ databases: { gestionale: db } }),
    });
    expect(db.calls).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  test("flush libera la cache del run invece di tenerla per sempre", async () => {
    const db = ordiniDb([{ ordine_cliente: "ORD-1", ordine_id: 11 }]);
    const ctx = mockCtx({ databases: { gestionale: db } });

    await testTransformer(plugin, { rows: [{ ordine_cliente: "ORD-1" }], config: baseConfig, ctx });
    await testTransformer(plugin, { rows: [{ ordine_cliente: "ORD-1" }], config: baseConfig, ctx });

    // Dopo il flush del primo run la chiave viene richiesta di nuovo.
    expect(db.calls).toHaveLength(2);
  });
});
