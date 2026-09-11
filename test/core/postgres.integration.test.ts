import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPostgresProvider, type DbProvider } from "../../src/core/db/postgres.js";

/**
 * Test d'integrazione vero: gira solo se PG_TEST_URL punta a un Postgres
 * usa-e-getta. Senza database viene saltato, perche' un COPY finto non
 * proverebbe nulla su cio' che qui puo' davvero rompersi (escaping, transazioni,
 * sola lettura imposta dal server).
 *
 *   PG_TEST_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
 */
const url = process.env["PG_TEST_URL"];
const suite = url ? describe : describe.skip;

const TABLE = "etl_js_copy_probe";

suite("driver postgres (integrazione)", () => {
  let provider: DbProvider;

  beforeAll(async () => {
    provider = await createPostgresProvider({ default: { connectionString: url ?? "" } });
    const tx = await provider.dbWrite("default");
    await tx.exec(`DROP TABLE IF EXISTS ${TABLE}`);
    await tx.exec(
      `CREATE TABLE ${TABLE} (id integer, testo text, quando timestamptz, dati jsonb)`,
    );
    await tx.commit();
  });

  afterAll(async () => {
    if (!provider) return;
    const tx = await provider.dbWrite("default");
    await tx.exec(`DROP TABLE IF EXISTS ${TABLE}`);
    await tx.commit();
    await provider.close();
  });

  test("bulkLoad porta a destinazione anche i caratteri che in COPY sono struttura", async () => {
    const tx = await provider.dbWrite("default");
    const rows = [
      [1, "con\ttabulatore", new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), { a: 1 }],
      [2, "con\na capo", null, null],
      [3, "con \\ backslash e \\N letterale", null, null],
      [4, "", null, null],
      [5, "città accentata", null, null],
    ];
    const loaded = await tx.bulkLoad(
      TABLE,
      ["id", "testo", "quando", "dati"],
      (async function* () {
        for (const row of rows) yield row;
      })(),
    );
    await tx.commit();

    expect(loaded).toBe(5);
    const read = await provider.db("default").query<{ id: number; testo: string }>(
      `SELECT id, testo FROM ${TABLE} ORDER BY id`,
    );
    expect(read.map((r) => r.testo)).toEqual([
      "con\ttabulatore",
      "con\na capo",
      "con \\ backslash e \\N letterale",
      "",
      "città accentata",
    ]);
  });

  test("il rollback non lascia traccia delle righe caricate", async () => {
    const before = await provider.db("default").query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${TABLE}`,
    );
    const tx = await provider.dbWrite("default");
    await tx.bulkLoad(
      TABLE,
      ["id", "testo"],
      (async function* () {
        yield [99, "da annullare"];
      })(),
    );
    await tx.rollback();
    const after = await provider.db("default").query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${TABLE}`,
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  test("la connessione in sola lettura viene rifiutata dal server, non dalla buona fede (I4)", async () => {
    await expect(
      provider.db("default").query(`INSERT INTO ${TABLE} (id) VALUES (1)`),
    ).rejects.toMatchObject({ code: "DB_ERROR" });
  });

  test("un identificatore ostile non diventa SQL: viene quotato", async () => {
    const tx = await provider.dbWrite("default");
    await tx.exec(`CREATE TEMP TABLE "strana ""tabella" (x text)`);
    const loaded = await tx.bulkLoad(
      'strana "tabella',
      ["x"],
      (async function* () {
        yield ["ok"];
      })(),
    );
    const read = await tx.query<{ x: string }>(`SELECT x FROM "strana ""tabella"`);
    await tx.rollback();
    expect(loaded).toBe(1);
    expect(read).toEqual([{ x: "ok" }]);
  });
});
