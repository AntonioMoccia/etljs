import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { main } from "../src/cli.js";

let dir = "";

/** Esegue la CLI catturando cio' che scrive, senza lanciare un processo. */
async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
  try {
    const code = await main(args);
    return { code, out, err };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "etl-cli-"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cli", () => {
  test("plugins elenca i manifest dei plugin inclusi", async () => {
    const { code, out } = await cli("plugins");
    const manifests = JSON.parse(out) as { name: string; kind: string }[];
    expect(code).toBe(0);
    expect(manifests.map((m) => `${m.name}:${m.kind}`)).toEqual([
      "csv:reader",
      "postgres:writer",
    ]);
  });

  test("describe stampa il JSON Schema della config", async () => {
    const { code, out } = await cli("describe", "csv");
    const schema = JSON.parse(out) as { properties: Record<string, unknown> };
    expect(code).toBe(0);
    expect(schema.properties["input"]).toBeDefined();
    expect(schema.properties["delimiter"]).toBeDefined();
  });

  test("describe di un plugin inesistente non finisce in silenzio", async () => {
    await expect(cli("describe", "inesistente")).rejects.toMatchObject({
      code: "PLUGIN_NOT_FOUND",
    });
  });

  test("validate su una Definition corretta non riporta nulla", async () => {
    const { code, out } = await cli("validate", "examples/acme-fase0.json");
    expect(code).toBe(0);
    expect(out).toContain("nessun rilievo");
  });

  test("validate elenca in una volta tutti i punti sbagliati", async () => {
    const path = join(dir, "rotta.json");
    await writeFile(
      path,
      JSON.stringify({
        client: "acme",
        source: { type: "csv", config: { delimitatore: ";", skipRows: "tre" } },
        transform: [],
        destination: { type: "postgres", config: { table: "t", strategy: "sostituisci" } },
      }),
    );

    const { code, err } = await cli("validate", path);

    expect(code).toBe(1);
    expect(err).toContain("source.config.input");
    expect(err).toContain("chiave non prevista: delimitatore");
    expect(err).toContain("source.config.skipRows");
    expect(err).toContain("destination.config.strategy");
  });

  // I transformer dell'esempio non sono dipendenze della CLI: vengono caricati
  // per nome dal loader. Se questo test passa, I2 regge fino in fondo.
  test("l'esempio completo e' valido con i plugin caricati da npm", async () => {
    const { code, out } = await cli("validate", "examples/acme.json");
    expect(code).toBe(0);
    expect(out).toContain("nessun rilievo");
  });

  test("preview mostra le righe senza toccare la destinazione", async () => {
    const { code, out } = await cli("preview", "examples/acme-fase0.json", "-n", "2");
    const result = JSON.parse(out) as { rows: Record<string, string>[] };
    expect(code).toBe(0);
    expect(result.rows).toHaveLength(2);
    // Il file di prova e' in latin1: se l'encoding non fosse rispettato qui
    // comparirebbe un carattere di sostituzione al posto dell'accento.
    expect(result.rows[1]?.["Città"]).toBe("Città di Castello");
  });

  test("run --dry-run conta le righe senza aprire la destinazione", async () => {
    const { code, out } = await cli("run", "examples/acme-fase0.json", "--dry-run", "--log", "error");
    const result = JSON.parse(out) as { read: number; written: number };
    expect(code).toBe(0);
    expect(result).toMatchObject({ read: 5, written: 5 });
  });

  test("un comando sconosciuto stampa l'uso e fallisce", async () => {
    const { code, err } = await cli("importa");
    expect(code).toBe(1);
    expect(err).toContain("Comando sconosciuto");
  });
});
