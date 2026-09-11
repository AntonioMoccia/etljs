import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const exec = promisify(execFile);
// fileURLToPath e non .pathname: su Windows quello lascia lo slash
// iniziale ("/C:/...") e join() finisce per produrre "C:\C:\...".
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * File-sonda: viene creato dentro una cartella di `src/`, gli si fa importare
 * qualcosa di proibito e si verifica che dependency-cruiser se ne accorga.
 * Cosi' I2 e I9 restano imposti dallo strumento anche se un giorno la
 * configurazione cambia. Col pacchetto unico i confini sono fra cartelle
 * invece che fra workspace, ma le regole sono le stesse.
 */
/**
 * Si invoca il binario con `node`, non con `npx`: su Windows gli eseguibili di
 * node_modules sono `.cmd` e `execFile` non li trova senza shell.
 */
const depcruise = join(repoRoot, "node_modules/dependency-cruiser/bin/dependency-cruise.mjs");
const argomenti = ["src", "packages", "--config", ".dependency-cruiser.cjs"];

const probes: string[] = [];

async function plantProbe(dir: string, source: string): Promise<void> {
  const path = join(repoRoot, dir, "__boundary_probe__.ts");
  probes.push(path);
  await writeFile(path, source);
}

async function cruise(): Promise<{ code: number; output: string }> {
  try {
    const { stdout } = await exec(process.execPath, [depcruise, ...argomenti], { cwd: repoRoot });
    return { code: 0, output: stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

afterEach(async () => {
  await Promise.all(probes.splice(0).map((path) => rm(path, { force: true })));
});

describe("confini architetturali", () => {
  test("il progetto pulito non ha violazioni", async () => {
    const result = await cruise();
    expect(result.output).toContain("no dependency violations found");
    expect(result.code).toBe(0);
  }, 60_000);

  test("un plugin che importa il core fa fallire il controllo (I9)", async () => {
    await plantProbe("src/csv-reader", 'import "../core/index.js";\nexport const probe = 1;\n');
    const result = await cruise();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("plugin-dipende-solo-da-contracts");
  }, 60_000);

  test("un plugin che importa un altro plugin fa fallire il controllo (I9)", async () => {
    await plantProbe("src/csv-reader", 'import "../postgres-writer/index.js";\nexport const probe = 1;\n');
    const result = await cruise();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("plugin-dipende-solo-da-contracts");
  }, 60_000);

  test("il core che importa un plugin fa fallire il controllo (I2)", async () => {
    await plantProbe("src/core", 'import "../csv-reader/index.js";\nexport const probe = 1;\n');
    const result = await cruise();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("core-non-conosce-i-plugin");
  }, 60_000);

  test("l'harness di test che importa il core fa fallire il controllo (I9)", async () => {
    await plantProbe("packages/testing/src", 'import "../../../src/core/index.js";\nexport const probe = 1;\n');
    const result = await cruise();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("testing-dipende-solo-da-contracts");
  }, 60_000);

  test("contracts che dipende da qualcosa fa fallire il controllo (I9)", async () => {
    await plantProbe("src/contracts", 'import "zod";\nexport const probe = 1;\n');
    const result = await cruise();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("contracts-senza-dipendenze-npm");
  }, 60_000);
});
