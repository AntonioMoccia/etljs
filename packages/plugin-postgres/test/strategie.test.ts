import { describe, expect, test } from "vitest";
import type { Batch, Row } from "@etl-js/contracts";
import { plugin } from "../src/index.js";
import { fakeTransaction, fakeWriterCtx } from "./helpers.js";

function batch(rows: Row[], offset = 0): Batch {
  return { rows, meta: { runId: "run-test", source: "test.csv", offset } };
}

/** Le istruzioni eseguite, ripulite dagli spazi, per leggerle nei test. */
function sqlOf(tx: ReturnType<typeof fakeTransaction>): string[] {
  return tx.statements.map((s) => s.sql.replace(/\s+/g, " ").trim());
}

describe("strategia replace-by", () => {
  const config = {
    table: "landing_piani",
    strategy: "replace-by",
    replaceKey: ["ordine_id"],
  };

  test("carica in una tabella di appoggio, non direttamente nella destinazione", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open(config, fakeWriterCtx(tx));
    await session.write(batch([{ ordine_id: 1, qta: 5 }]));

    expect(tx.loaded[0]?.table).toMatch(/^etl_staging_/);
    expect(sqlOf(tx).some((sql) => sql.startsWith("CREATE TEMP TABLE"))).toBe(true);
  });

  test("al commit cancella per chiave e poi inserisce, dentro la stessa transazione", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open(config, fakeWriterCtx(tx));
    await session.write(batch([{ ordine_id: 1, qta: 5 }]));
    await session.close(true);

    const sql = sqlOf(tx);
    const delete_ = sql.findIndex((s) => s.startsWith("DELETE FROM"));
    const insert = sql.findIndex((s) => s.startsWith("INSERT INTO"));

    expect(delete_).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(delete_);
    expect(sql[delete_]).toContain('"landing_piani"');
    expect(sql[delete_]).toContain('"ordine_id"');
    expect(tx.outcome).toEqual(["commit"]);
  });

  test("cancella solo le chiavi presenti nel file, non l'intera tabella", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open(config, fakeWriterCtx(tx));
    await session.write(batch([{ ordine_id: 1 }, { ordine_id: 2 }]));
    await session.close(true);

    const delete_ = sqlOf(tx).find((s) => s.startsWith("DELETE FROM")) ?? "";
    // La cancellazione e' vincolata alle chiavi caricate nell'appoggio.
    expect(delete_).toContain("SELECT");
    expect(delete_).not.toMatch(/DELETE FROM "landing_piani"\s*$/);
  });

  test("un errore a meta' non lascia ne' l'appoggio ne' la destinazione a meta'", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open(config, fakeWriterCtx(tx));
    await session.write(batch([{ ordine_id: 1 }]));
    await session.close(false);

    expect(tx.outcome).toEqual(["rollback"]);
    expect(sqlOf(tx).some((s) => s.startsWith("DELETE FROM"))).toBe(false);
    expect(sqlOf(tx).some((s) => s.startsWith("INSERT INTO"))).toBe(false);
  });

  test("un run che non porta righe non cancella nulla", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open(config, fakeWriterCtx(tx));
    await session.close(true);

    expect(sqlOf(tx).some((s) => s.startsWith("DELETE FROM"))).toBe(false);
    expect(tx.outcome).toEqual(["commit"]);
  });

  test("la chiave di sostituzione deve essere fra le colonne caricate", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open(config, fakeWriterCtx(tx));
    await expect(session.write(batch([{ altro: 1 }]))).rejects.toMatchObject({
      code: "REPLACE_KEY_MISSING",
    });
  });

  test("i nomi delle colonne finiscono nell'SQL solo dopo essere stati quotati", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open(
      { table: "landing", strategy: "replace-by", replaceKey: ['strana "colonna'] },
      fakeWriterCtx(tx),
    );
    await session.write(batch([{ 'strana "colonna': 1 }]));
    await session.close(true);

    const delete_ = sqlOf(tx).find((s) => s.startsWith("DELETE FROM")) ?? "";
    expect(delete_).toContain('"strana ""colonna"');
  });
});

describe("strategia upsert", () => {
  const config = {
    table: "landing",
    strategy: "upsert",
    conflictKey: ["ordine_id"],
  };

  test("inserisce dall'appoggio con ON CONFLICT DO UPDATE", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open(config, fakeWriterCtx(tx));
    await session.write(batch([{ ordine_id: 1, qta: 5 }]));
    await session.close(true);

    const insert = sqlOf(tx).find((s) => s.startsWith("INSERT INTO")) ?? "";
    expect(insert).toContain('ON CONFLICT ("ordine_id") DO UPDATE SET');
    expect(insert).toContain('"qta" = EXCLUDED."qta"');
  });

  test("le colonne della chiave non vengono riassegnate a se stesse", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open(config, fakeWriterCtx(tx));
    await session.write(batch([{ ordine_id: 1, qta: 5 }]));
    await session.close(true);

    const insert = sqlOf(tx).find((s) => s.startsWith("INSERT INTO")) ?? "";
    expect(insert).not.toContain('"ordine_id" = EXCLUDED."ordine_id"');
  });

  test("se le uniche colonne sono la chiave, il conflitto non fa nulla", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open(config, fakeWriterCtx(tx));
    await session.write(batch([{ ordine_id: 1 }]));
    await session.close(true);

    const insert = sqlOf(tx).find((s) => s.startsWith("INSERT INTO")) ?? "";
    expect(insert).toContain("ON CONFLICT DO NOTHING");
  });
});

describe("strategia append", () => {
  test("resta il caso semplice: carica dritto nella destinazione", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open({ table: "landing" }, fakeWriterCtx(tx));
    await session.write(batch([{ a: 1 }]));
    await session.close(true);

    expect(tx.loaded[0]?.table).toBe("landing");
    expect(sqlOf(tx).some((s) => s.startsWith("CREATE TEMP TABLE"))).toBe(false);
  });

  test("truncate insieme a replace-by e' una contraddizione, e viene rifiutata", async () => {
    const tx = fakeTransaction();
    await expect(
      plugin.impl.open(
        { table: "landing", strategy: "replace-by", replaceKey: ["id"], truncate: true },
        fakeWriterCtx(tx),
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  test("truncate svuota la destinazione prima di caricare", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open(
      { table: "landing", truncate: true },
      fakeWriterCtx(tx),
    );
    await session.write(batch([{ a: 1 }]));
    await session.close(true);

    expect(sqlOf(tx)[0]).toBe('TRUNCATE "landing"');
  });
});
