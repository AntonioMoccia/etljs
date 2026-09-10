import { describe, expect, test } from "vitest";
import { parseCsv } from "../src/parser.js";

/** Trasforma un elenco di chunk in uno stream, per simulare la lettura a pezzi. */
async function* chunks(...parts: string[]): AsyncGenerator<string> {
  for (const part of parts) yield part;
}

async function collect(
  stream: AsyncIterable<string[]>,
): Promise<string[][]> {
  const out: string[][] = [];
  for await (const record of stream) out.push(record);
  return out;
}

describe("parseCsv", () => {
  test("separa i campi sul delimitatore configurato", async () => {
    const records = await collect(
      parseCsv(chunks("a;b;c\n1;2;3\n"), { delimiter: ";" }),
    );
    expect(records).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  test("un campo quotato puo' contenere il delimitatore", async () => {
    const records = await collect(
      parseCsv(chunks('"Rossi; Mario";42\n'), { delimiter: ";" }),
    );
    expect(records).toEqual([["Rossi; Mario", "42"]]);
  });

  test("due apici dentro un campo quotato valgono un apice", async () => {
    const records = await collect(parseCsv(chunks('"dice ""ciao""";x\n'), { delimiter: ";" }));
    expect(records).toEqual([['dice "ciao"', "x"]]);
  });

  test("un campo quotato puo' contenere un a capo", async () => {
    const records = await collect(
      parseCsv(chunks('"prima\nseconda";fine\n'), { delimiter: ";" }),
    );
    expect(records).toEqual([["prima\nseconda", "fine"]]);
  });

  test("accetta CRLF e l'ultima riga senza a capo finale", async () => {
    const records = await collect(parseCsv(chunks("a;b\r\nc;d"), { delimiter: ";" }));
    expect(records).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("ricompone un record spezzato fra due chunk", async () => {
    const records = await collect(
      parseCsv(chunks('"Ros', 'si; Ma', 'rio";4', "2\nx;y\n"), { delimiter: ";" }),
    );
    expect(records).toEqual([
      ["Rossi; Mario", "42"],
      ["x", "y"],
    ]);
  });

  test("scarta il BOM iniziale", async () => {
    const records = await collect(parseCsv(chunks("﻿a;b\n"), { delimiter: ";" }));
    expect(records).toEqual([["a", "b"]]);
  });

  test("non emette un record dopo l'a capo finale", async () => {
    const records = await collect(parseCsv(chunks("a;b\n"), { delimiter: ";" }));
    expect(records).toEqual([["a", "b"]]);
  });

  // Una riga vuota e' una riga: se il parser la inghiottisse, skipRows conterebbe
  // righe diverse da quelle che vede chi apre il file in un editor.
  test("emette un record vuoto per una riga vuota interna", async () => {
    const records = await collect(parseCsv(chunks("a;b\n\nc;d\n"), { delimiter: ";" }));
    expect(records).toEqual([["a", "b"], [""], ["c", "d"]]);
  });

  test("un campo vuoto resta una stringa vuota, non sparisce", async () => {
    const records = await collect(parseCsv(chunks("a;;c\n"), { delimiter: ";" }));
    expect(records).toEqual([["a", "", "c"]]);
  });
});
