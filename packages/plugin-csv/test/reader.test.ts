import { describe, expect, test } from "vitest";
import type { Batch, ByteStream, Ctx, Logger } from "@etl-js/contracts";
import { plugin } from "../src/index.js";

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
};

/**
 * `openInput` serve i byte da una stringa in memoria, a pezzi di `chunkSize`:
 * un record spezzato fra due chunk deve ricomporsi comunque. Nessun test tocca
 * il disco.
 */
function ctxWith(
  sources: Record<string, string | Uint8Array>,
  options: { signal?: AbortSignal; chunkSize?: number; onChunk?: () => void } = {},
): Ctx {
  const chunkSize = options.chunkSize ?? 64 * 1024;
  return {
    runId: "run-test",
    openInput: async (ref: string): Promise<ByteStream> => {
      const content = sources[ref];
      if (content === undefined) throw new Error(`sorgente "${ref}" non prevista dal test`);
      const bytes =
        typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
      return {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < bytes.length; i += chunkSize) {
            options.onChunk?.();
            yield bytes.subarray(i, i + chunkSize);
          }
        },
      };
    },
    db: () => {
      throw new Error("questo test non deve toccare il database");
    },
    secretRef: (ref) => `secret:${ref}`,
    log: silent,
    signal: options.signal ?? new AbortController().signal,
  };
}

async function readAll(config: unknown, ctx: Ctx): Promise<Batch[]> {
  const batches: Batch[] = [];
  for await (const batch of plugin.impl.read(config, ctx)) batches.push(batch);
  return batches;
}

async function rowsOf(config: Record<string, unknown>, content: string | Uint8Array) {
  const ctx = ctxWith({ "prova.csv": content });
  const batches = await readAll({ input: "prova.csv", ...config }, ctx);
  return batches.flatMap((b) => b.rows);
}

describe("reader csv", () => {
  test("un CSV con intestazione diventa righe chiave/valore", async () => {
    const rows = await rowsOf({}, "Ordine,Quantita\nORD-1,5\nORD-2,7\n");
    expect(rows).toEqual([
      { Ordine: "ORD-1", Quantita: "5" },
      { Ordine: "ORD-2", Quantita: "7" },
    ]);
  });

  test("delimitatore ';' ed encoding latin1: gli accenti arrivano interi", async () => {
    const bytes = Buffer.from("Citta;Nota\nCittà di Castello;perché\n", "latin1");
    const rows = await rowsOf({ delimiter: ";", encoding: "latin1" }, bytes);
    expect(rows).toEqual([{ Citta: "Città di Castello", Nota: "perché" }]);
  });

  test("skipRows scarta il preambolo e prende l'intestazione dalla riga giusta", async () => {
    const rows = await rowsOf(
      { delimiter: ";", skipRows: 3 },
      "Report cliente\ngenerato il 01/02/2026\n\nOrdine;Quantita\nORD-1;5\n",
    );
    expect(rows).toEqual([{ Ordine: "ORD-1", Quantita: "5" }]);
  });

  test("header come elenco: nomi imposti a un file che non ne ha", async () => {
    const rows = await rowsOf({ header: ["a", "b"] }, "1,2\n3,4\n");
    expect(rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  test("header false: chiavi posizionali c0, c1", async () => {
    const rows = await rowsOf({ header: false }, "1,2\n3,4\n");
    expect(rows).toEqual([
      { c0: "1", c1: "2" },
      { c0: "3", c1: "4" },
    ]);
  });

  test("il BOM non sporca il nome della prima colonna", async () => {
    const rows = await rowsOf({}, "﻿Ordine,Quantita\nORD-1,5\n");
    expect(Object.keys(rows[0] ?? {})).toEqual(["Ordine", "Quantita"]);
  });

  // `trim` mangia comunque U+FEFF, che e' uno spazio a tutti gli effetti:
  // per conservare il BOM servono entrambe le opzioni spente.
  test("con bom false e trim false il BOM resta, perche' e' stato chiesto", async () => {
    const rows = await rowsOf({ bom: false, trim: false }, "﻿Ordine\nORD-1\n");
    expect(Object.keys(rows[0] ?? {})[0]).toBe("﻿Ordine");
  });

  test("un file UTF-8 con BOM ma dichiarato latin1 non porta il BOM nel nome di colonna", async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("Ordine;Citta\nORD-1;Perugia\n", "latin1"),
    ]);
    const rows = await rowsOf({ delimiter: ";", encoding: "latin1" }, bytes);
    expect(Object.keys(rows[0] ?? {})).toEqual(["Ordine", "Citta"]);
  });

  test("batchSize 2 su 5 righe: tre lotti, offset coerenti", async () => {
    const ctx = ctxWith({ "prova.csv": "k\n1\n2\n3\n4\n5\n" });
    const batches = await readAll({ input: "prova.csv", batchSize: 2 }, ctx);

    expect(batches.map((b) => b.rows.length)).toEqual([2, 2, 1]);
    expect(batches.map((b) => b.meta.offset)).toEqual([0, 2, 4]);
    expect(batches[0]?.meta.source).toBe("prova.csv");
    expect(batches[0]?.meta.runId).toBe("run-test");
  });

  test("una riga con meno campi entra comunque: il giudizio spetta a validate", async () => {
    const rows = await rowsOf({}, "a,b,c\n1,2\n4,5,6\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ a: "1", b: "2" });
    expect(rows[1]).toEqual({ a: "4", b: "5", c: "6" });
  });

  test("una riga con piu' campi non interrompe lo stream", async () => {
    const rows = await rowsOf({}, "a,b\n1,2,3\n4,5\n");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ a: "4", b: "5" });
  });

  test("un campo quotato con delimitatore, apici e a capo dentro resta intero", async () => {
    const rows = await rowsOf(
      { delimiter: ";" },
      'Nome;Nota\n"Rossi; Mario";"dice ""ciao""\ne va a capo"\n',
    );
    expect(rows).toEqual([
      { Nome: "Rossi; Mario", Nota: 'dice "ciao"\ne va a capo' },
    ]);
  });

  test("un record spezzato fra due chunk si ricompone", async () => {
    const ctx = ctxWith({ "prova.csv": 'a;b\n"Ros si";42\nx;y\n' }, { chunkSize: 3 });
    const batches = await readAll({ input: "prova.csv", delimiter: ";" }, ctx);
    expect(batches.flatMap((b) => b.rows)).toEqual([
      { a: "Ros si", b: "42" },
      { a: "x", b: "y" },
    ]);
  });

  test("trim toglie gli spazi ai bordi, e si puo' spegnere", async () => {
    expect(await rowsOf({}, "a\n  ciao  \n")).toEqual([{ a: "ciao" }]);
    expect(await rowsOf({ trim: false }, "a\n  ciao  \n")).toEqual([{ a: "  ciao  " }]);
  });

  test("un file vuoto o con la sola intestazione non e' un errore: zero righe", async () => {
    expect(await rowsOf({}, "")).toEqual([]);
    expect(await rowsOf({}, "a,b\n")).toEqual([]);
  });

  test("i lotti arrivano man mano, senza aspettare la fine del file", async () => {
    const righe = ["k"];
    for (let i = 0; i < 100_000; i += 1) righe.push(String(i));
    const ctx = ctxWith({ "grande.csv": `${righe.join("\n")}\n` }, { chunkSize: 8 * 1024 });

    let lotti = 0;
    let primoLotto: Batch | undefined;
    for await (const batch of plugin.impl.read({ input: "grande.csv", batchSize: 1000 }, ctx)) {
      lotti += 1;
      primoLotto ??= batch;
      // Appena si hanno abbastanza lotti si smette: se il reader avesse letto
      // tutto il file prima di emettere, questo `break` non salverebbe nulla.
      if (lotti === 3) break;
    }

    expect(lotti).toBe(3);
    expect(primoLotto?.rows).toHaveLength(1000);
    expect(primoLotto?.rows[0]).toEqual({ k: "0" });
  });

  test("un file grande non viene tenuto in memoria: si legge a pezzi", async () => {
    const righe = ["k"];
    for (let i = 0; i < 50_000; i += 1) righe.push(String(i));
    let chunkChiesti = 0;
    const ctx = ctxWith(
      { "grande.csv": `${righe.join("\n")}\n` },
      { chunkSize: 16 * 1024, onChunk: () => (chunkChiesti += 1) },
    );

    const batches = await readAll({ input: "grande.csv", batchSize: 5000 }, ctx);

    expect(batches).toHaveLength(10);
    expect(batches.reduce((n, b) => n + b.rows.length, 0)).toBe(50_000);
    expect(chunkChiesti).toBeGreaterThan(10);
  });

  test("un signal abortito a meta' interrompe l'iterazione", async () => {
    const righe = ["k"];
    for (let i = 0; i < 10_000; i += 1) righe.push(String(i));
    const controller = new AbortController();
    const ctx = ctxWith({ "grande.csv": `${righe.join("\n")}\n` }, { signal: controller.signal });

    const batches: Batch[] = [];
    for await (const batch of plugin.impl.read({ input: "grande.csv", batchSize: 100 }, ctx)) {
      batches.push(batch);
      if (batches.length === 2) controller.abort();
    }

    expect(batches.length).toBeLessThan(5);
  });

  test("una sorgente che non si apre produce un errore classificato, non un ENOENT grezzo", async () => {
    const ctx: Ctx = {
      ...ctxWith({}),
      openInput: async () => {
        const error = new Error("ENOENT") as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      },
    };
    await expect(readAll({ input: "manca.csv" }, ctx)).rejects.toThrowError(/ENOENT/);
  });

  test("una sorgente che si rompe a meta' diventa READ_FAILED", async () => {
    const ctx: Ctx = {
      ...ctxWith({}),
      openInput: async () => ({
        async *[Symbol.asyncIterator]() {
          yield Buffer.from("a,b\n1,2\n");
          throw new Error("il disco si e' staccato");
        },
      }),
    };
    await expect(readAll({ input: "rotta.csv" }, ctx)).rejects.toMatchObject({
      code: "READ_FAILED",
    });
  });

  test("il reader non apre nulla da se': senza openInput non legge", async () => {
    const ctx = ctxWith({ "prova.csv": "a\n1\n" });
    const senzaInput = { ...ctx, openInput: undefined } as unknown as Ctx;
    await expect(readAll({ input: "prova.csv" }, senzaInput)).rejects.toThrowError();
  });

  test("una config senza input viene rifiutata con CONFIG_INVALID", async () => {
    await expect(readAll({ delimiter: ";" }, ctxWith({}))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  test("una chiave di config sconosciuta non passa in silenzio", async () => {
    await expect(
      readAll({ input: "prova.csv", delimitatore: ";" }, ctxWith({ "prova.csv": "a\n1\n" })),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
