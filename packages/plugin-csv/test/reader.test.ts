import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import type { Batch } from "@etl-js/contracts";
import { plugin } from "../src/index.js";
import { fakeCtx, recordingLogger } from "./helpers.js";

let dir = "";

/** Scrive un file di prova con l'encoding richiesto e ne restituisce il path. */
async function fixture(name: string, content: string, encoding: BufferEncoding = "utf8") {
  const path = join(dir, name);
  await writeFile(path, Buffer.from(content, encoding));
  return path;
}

async function readAll(config: unknown, ctx = fakeCtx()): Promise<Batch[]> {
  const batches: Batch[] = [];
  for await (const batch of plugin.impl.read(config, ctx)) batches.push(batch);
  return batches;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "etl-csv-"));
});

describe("reader csv", () => {
  test("usa la prima riga come intestazione e produce righe chiave/valore", async () => {
    const path = await fixture("base.csv", "Ordine;Quantita\nA100;5\nA101;7\n");
    const batches = await readAll({ path, delimiter: ";" });
    expect(batches.flatMap((b) => b.rows)).toEqual([
      { Ordine: "A100", Quantita: "5" },
      { Ordine: "A101", Quantita: "7" },
    ]);
  });

  test("skipRows scarta le righe di preambolo prima dell'intestazione", async () => {
    const path = await fixture(
      "preambolo.csv",
      "Report cliente\ngenerato il 01/02/2026\n\nOrdine;Quantita\nA100;5\n",
    );
    const batches = await readAll({ path, delimiter: ";", skipRows: 3 });
    expect(batches.flatMap((b) => b.rows)).toEqual([{ Ordine: "A100", Quantita: "5" }]);
  });

  test("spezza in lotti di batchSize e numera gli offset dalla prima riga di dati", async () => {
    const path = await fixture("lotti.csv", "k\n1\n2\n3\n4\n5\n");
    const batches = await readAll({ path, batchSize: 2 });
    expect(batches.map((b) => b.rows.length)).toEqual([2, 2, 1]);
    expect(batches.map((b) => b.meta.offset)).toEqual([0, 2, 4]);
    expect(batches[0]?.meta.source).toBe(path);
    expect(batches[0]?.meta.runId).toBe("run-test");
  });

  test("decodifica un file latin1 senza corrompere gli accenti", async () => {
    const path = await fixture("latin1.csv", "Citta\nPerugia città\n", "latin1");
    const batches = await readAll({ path, encoding: "latin1" });
    expect(batches[0]?.rows[0]).toEqual({ Citta: "Perugia città" });
  });

  test("le righe vuote in mezzo ai dati non diventano righe di null", async () => {
    const path = await fixture("vuote.csv", "a;b\n1;2\n\n3;4\n");
    const batches = await readAll({ path, delimiter: ";" });
    expect(batches.flatMap((b) => b.rows)).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  test("una riga piu' corta dell'intestazione ha i campi mancanti a null", async () => {
    const path = await fixture("corta.csv", "a;b;c\n1;2\n");
    const batches = await readAll({ path, delimiter: ";" });
    expect(batches[0]?.rows[0]).toEqual({ a: "1", b: "2", c: null });
  });

  test("segnala una sola volta le colonne in eccesso invece di perderle in silenzio", async () => {
    const path = await fixture("lunga.csv", "a;b\n1;2;3\n4;5;6\n");
    const log = recordingLogger();
    await readAll({ path, delimiter: ";" }, fakeCtx({ log }));
    expect(log.lines.filter((l) => l.includes("colonne in eccesso"))).toHaveLength(1);
  });

  test("un file inesistente produce un errore SOURCE_UNREADABLE, non un ENOENT grezzo", async () => {
    await expect(readAll({ path: join(dir, "manca.csv") })).rejects.toMatchObject({
      code: "SOURCE_UNREADABLE",
    });
  });

  test("una config senza path viene rifiutata con CONFIG_INVALID", async () => {
    await expect(readAll({ delimiter: ";" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });
});
