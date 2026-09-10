import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { Manifest } from "@etl-js/contracts";
import csv from "@etl-js/plugin-csv";
import postgres from "@etl-js/plugin-postgres";
import lookup from "@etl-js/plugin-lookup";
import { plugins as transforms } from "@etl-js/plugin-transforms";

/**
 * La documentazione invecchia in silenzio: si aggiunge un'opzione di config e
 * nessuno se ne accorge finche' qualcuno non la cerca invano. Questi test la
 * legano al codice, cosi' marcire diventa un test rosso.
 */
const repoRoot = new URL("..", import.meta.url).pathname;

const DOCUMENTI = [
  "README.md",
  "CLAUDE.md",
  "docs/README.md",
  "docs/concetti.md",
  "docs/guida-rapida.md",
  "docs/definition.md",
  "docs/plugin.md",
  "docs/api.md",
  "docs/errori.md",
  "docs/limiti.md",
  "docs/scrivere-un-plugin.md",
  "docs/piano.md",
];

const TUTTI = [csv, ...transforms, lookup, postgres];

async function leggi(relativo: string): Promise<string> {
  return readFile(join(repoRoot, relativo), "utf8");
}

/** I nomi delle opzioni di config, dal JSON Schema del manifest. */
function opzioniDi(manifest: Manifest): string[] {
  const schema = manifest.configSchema as { properties?: Record<string, unknown> };
  return Object.keys(schema.properties ?? {});
}

describe("documentazione", () => {
  test("nessun link locale e' rotto", async () => {
    const rotti: string[] = [];

    for (const documento of DOCUMENTI) {
      const testo = await leggi(documento);
      const base = dirname(join(repoRoot, documento));
      for (const match of testo.matchAll(/\[[^\]]+\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
        const target = match[1] ?? "";
        if (/^https?:/.test(target)) continue;
        if (!existsSync(resolve(base, target))) rotti.push(`${documento} -> ${target}`);
      }
    }

    expect(rotti).toEqual([]);
  });

  test("ogni documento indicizzato esiste davvero", async () => {
    for (const documento of DOCUMENTI) {
      expect(existsSync(join(repoRoot, documento)), documento).toBe(true);
    }
  });

  test("ogni plugin installato ha la sua sezione nel riferimento", async () => {
    const riferimento = await leggi("docs/plugin.md");
    for (const plugin of TUTTI) {
      expect(riferimento, plugin.manifest.name).toContain(`## ${plugin.manifest.name}`);
    }
  });

  test("ogni opzione di config compare nel riferimento", async () => {
    const riferimento = await leggi("docs/plugin.md");
    const mancanti: string[] = [];

    for (const plugin of TUTTI) {
      for (const opzione of opzioniDi(plugin.manifest)) {
        // Si cerca il nome quotato come nelle tabelle: `input`, `skipRows`...
        if (!riferimento.includes(`\`${opzione}\``)) {
          mancanti.push(`${plugin.manifest.name}.${opzione}`);
        }
      }
    }

    expect(mancanti).toEqual([]);
  });

  test("ogni codice di errore del motore e' spiegato", async () => {
    const documento = await leggi("docs/errori.md");
    const contracts = await leggi("packages/contracts/src/errors.ts");
    const codici = [...contracts.matchAll(/^\s{2}([A-Z_]+):\s"/gm)].map((m) => m[1]);

    expect(codici.length).toBeGreaterThan(5);
    for (const codice of codici) {
      expect(documento, codice).toContain(`\`${codice}\``);
    }
  });

  test("gli esempi della guida rapida citano file che esistono", async () => {
    const guida = await leggi("docs/guida-rapida.md");
    for (const match of guida.matchAll(/examples\/[\w.-]+/g)) {
      expect(existsSync(join(repoRoot, match[0])), match[0]).toBe(true);
    }
  });
});
