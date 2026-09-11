import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Definition, Logger, Row } from "etl-js/contracts";
import {
  Registry,
  createFileInput,
  createPostgresProvider,
  run,
  type DbProvider,
  type HostCtx,
} from "etl-js";
import csv from "etl-js/csv";
import postgres from "etl-js/postgres";
import { castPlugin } from "etl-js/transforms";

/**
 * I criteri della fase 7 contro un Postgres vero: ri-importare lo stesso piano
 * non duplica, e un errore a meta' non lascia niente a terra. Le forme dell'SQL
 * sono gia' coperte dai test unitari; qui si controlla che il database sia
 * d'accordo.
 *
 *   PG_TEST_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
 */
const url = process.env["PG_TEST_URL"];
const suite = url ? describe : describe.skip;

const TABLE = "etl_js_landing_probe";
let dir = "";
let provider: DbProvider;

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
};

function ctx(): HostCtx {
  return {
    openInput: createFileInput(),
    db: (name) => provider.db(name),
    secretRef: (ref) => ref,
    log: silent,
    signal: new AbortController().signal,
    dbWrite: (name) => provider.dbWrite(name),
  };
}

function registry(): Registry {
  return new Registry().register(csv).register(castPlugin).register(postgres);
}

/** Un file di dati: codice, quantita', data. */
async function piano(name: string, righe: [string, string, string][]): Promise<string> {
  const path = join(dir, name);
  const testo = ["Codice;Quantita;Data", ...righe.map((r) => r.join(";"))].join("\n");
  await writeFile(path, `${testo}\n`, "utf8");
  return path;
}

function definition(path: string, strategy: "append" | "replace-by" | "upsert"): Definition {
  return {
    client: "acme",
    source: { type: "csv", config: { input: path, delimiter: ";" } },
    transform: [
      {
        type: "cast",
        config: {
          Quantita: { number: { decimal: "," } },
          Data: { date: "dd/MM/yyyy" },
        },
      },
    ],
    destination: {
      type: "postgres",
      config: {
        table: TABLE,
        columns: ["Ordine", "Quantita", "Data"],
        strategy,
        ...(strategy === "replace-by" ? { replaceKey: ["Ordine"] } : {}),
        ...(strategy === "upsert" ? { conflictKey: ["Ordine"] } : {}),
      },
    },
  };
}

async function contenuto(): Promise<Row[]> {
  return provider
    .db("default")
    .query(`SELECT "Ordine", "Quantita"::text AS q FROM ${TABLE} ORDER BY "Ordine"`);
}

suite("import verso Postgres (integrazione)", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "etl-pg-"));
    provider = await createPostgresProvider({ default: { connectionString: url ?? "" } });
    const tx = await provider.dbWrite("default");
    await tx.exec(`DROP TABLE IF EXISTS ${TABLE}`);
    await tx.exec(
      `CREATE TABLE ${TABLE} ("Ordine" text primary key, "Quantita" numeric, "Data" date)`,
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

  test("il primo import porta a terra le righe convertite", async () => {
    const path = await piano("primo.csv", [
      ["COD-1", "10", "03/02/2026"],
      ["COD-2", "1.250,50", "04/02/2026"],
    ]);

    const result = await run(definition(path, "replace-by"), ctx(), { registry: registry() });

    expect(result.written).toBe(2);
    expect(await contenuto()).toEqual([
      { Ordine: "COD-1", q: "10" },
      { Ordine: "COD-2", q: "1250.50" },
    ]);
  });

  test("rimandare il piano aggiornato sostituisce, non duplica", async () => {
    const path = await piano("secondo.csv", [
      ["COD-1", "99", "05/02/2026"],
      ["COD-3", "7", "06/02/2026"],
    ]);

    await run(definition(path, "replace-by"), ctx(), { registry: registry() });

    // COD-1 sostituito, COD-3 aggiunto, COD-2 lasciato in pace: il file
    // riguardava solo i sue chiavi.
    expect(await contenuto()).toEqual([
      { Ordine: "COD-1", q: "99" },
      { Ordine: "COD-2", q: "1250.50" },
      { Ordine: "COD-3", q: "7" },
    ]);
  });

  test("lo stesso file importato due volte lascia la tabella identica", async () => {
    const path = await piano("idempotente.csv", [["COD-4", "42", "07/02/2026"]]);

    await run(definition(path, "replace-by"), ctx(), { registry: registry() });
    const dopoUno = await contenuto();
    await run(definition(path, "replace-by"), ctx(), { registry: registry() });

    expect(await contenuto()).toEqual(dopoUno);
  });

  test("un errore a meta' non lascia nulla: rollback totale", async () => {
    const prima = await contenuto();
    // La quantita' non e' un numero: il cast scarta la riga, ma la soglia
    // di scarto e' zero, quindi il run viene annullato dopo aver gia' caricato.
    const path = await piano("rotto.csv", [
      ["COD-5", "1", "08/02/2026"],
      ["COD-6", "non un numero", "09/02/2026"],
    ]);
    const def = { ...definition(path, "replace-by"), policy: { maxFailedRatio: 0 } };

    await expect(run(def, ctx(), { registry: registry() })).rejects.toMatchObject({
      code: "TOO_MANY_FAILED",
    });

    expect(await contenuto()).toEqual(prima);
  });

  test("upsert aggiorna le colonne e lascia intatte le altre righe", async () => {
    const path = await piano("upsert.csv", [["COD-1", "5", "10/02/2026"]]);

    await run(definition(path, "upsert"), ctx(), { registry: registry() });

    const righe = await contenuto();
    expect(righe.find((r) => r["Ordine"] === "COD-1")).toEqual({ Ordine: "COD-1", q: "5" });
    expect(righe.find((r) => r["Ordine"] === "COD-2")).toEqual({ Ordine: "COD-2", q: "1250.50" });
  });
});
