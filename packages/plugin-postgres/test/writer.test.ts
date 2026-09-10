import { describe, expect, test } from "vitest";
import type { Batch, Row } from "@etl-js/contracts";
import { plugin } from "../src/index.js";
import { fakeTransaction, fakeWriterCtx } from "./helpers.js";

function batch(rows: Row[], offset = 0): Batch {
  return { rows, meta: { runId: "run-test", source: "test.csv", offset } };
}

describe("writer postgres", () => {
  test("apre la transazione sul database logico indicato dalla config", async () => {
    const tx = fakeTransaction();
    const ctx = fakeWriterCtx(tx);
    const session = await plugin.impl.open({ table: "landing", db: "gestionale" }, ctx);
    await session.close(true);
    expect(ctx.openedDbs).toEqual(["gestionale"]);
  });

  test("carica le righe con bulkLoad su tabella e colonne del primo lotto", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open({ table: "landing" }, fakeWriterCtx(tx));
    await session.write(batch([{ ordine_id: 1, qta: 5 }, { ordine_id: 2, qta: 7 }]));
    await session.close(true);
    expect(tx.loaded).toEqual([
      {
        table: "landing",
        columns: ["ordine_id", "qta"],
        rows: [
          [1, 5],
          [2, 7],
        ],
      },
    ]);
  });

  test("una colonna assente in una riga successiva diventa null, non uno scostamento", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open({ table: "landing" }, fakeWriterCtx(tx));
    await session.write(batch([{ a: 1, b: 2 }, { a: 3 }]));
    await session.close(true);
    expect(tx.loaded[0]?.rows).toEqual([
      [1, 2],
      [3, null],
    ]);
  });

  test("una colonna sconosciuta interrompe il caricamento invece di perdere il dato", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open({ table: "landing" }, fakeWriterCtx(tx));
    await session.write(batch([{ a: 1 }]));
    await expect(session.write(batch([{ a: 1, sorpresa: 2 }], 1))).rejects.toMatchObject({
      code: "COLUMN_MISMATCH",
    });
  });

  test("le colonne dichiarate in config vincono sulle chiavi del primo lotto", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open(
      { table: "landing", columns: ["qta", "ordine_id"] },
      fakeWriterCtx(tx),
    );
    await session.write(batch([{ ordine_id: 1, qta: 5 }]));
    await session.close(true);
    expect(tx.loaded[0]?.columns).toEqual(["qta", "ordine_id"]);
    expect(tx.loaded[0]?.rows).toEqual([[5, 1]]);
  });

  test("close(true) fa commit", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open({ table: "landing" }, fakeWriterCtx(tx));
    await session.close(true);
    expect(tx.outcome).toEqual(["commit"]);
  });

  test("close(false) fa rollback", async () => {
    const tx = fakeTransaction();
    const session = await plugin.impl.open({ table: "landing" }, fakeWriterCtx(tx));
    await session.write(batch([{ a: 1 }]));
    await session.close(false);
    expect(tx.outcome).toEqual(["rollback"]);
  });

  test("replace-by senza replaceKey e' una config invalida", async () => {
    const tx = fakeTransaction();
    await expect(
      plugin.impl.open({ table: "landing", strategy: "replace-by" }, fakeWriterCtx(tx)),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
