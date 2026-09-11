import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const exec = promisify(execFile);
// fileURLToPath e non .pathname: su Windows quello lascia lo slash
// iniziale ("/C:/...") e join() finisce per produrre "C:\C:\...".
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Prova sul **compilato**, in un processo Node separato: i subpath di
 * `exports` esistono davvero in `dist/` e il motore ci gira sopra. I test
 * normali usano i sorgenti, quindi senza questo un errore di packaging
 * (un entry point sbagliato, un file che non finisce in dist) passerebbe
 * inosservato fino alla pubblicazione.
 */
const built = existsSync(join(repoRoot, "dist/core/index.js"));
const url = (path: string): string => pathToFileURL(join(repoRoot, path)).href;

describe.skipIf(!built)("il pacchetto compilato", () => {
  async function runScript(source: string): Promise<string> {
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", source], {
      cwd: repoRoot,
    });
    return stdout;
  }

  test("createEngine esegue una Definition coi plugin collegati a mano", async () => {
    const stdout = await runScript(`
      import { readFile } from "node:fs/promises";
      import { createEngine, createFileInput } from "${url("dist/core/index.js")}";
      import { csvReader } from "${url("dist/csv-reader/index.js")}";
      import { postgresWriter } from "${url("dist/postgres-writer/index.js")}";

      const definition = JSON.parse(await readFile("examples/acme-fase0.json", "utf8"));
      const silent = { debug(){}, info(){}, warn(){}, error(){}, child(){ return silent; } };

      const engine = createEngine().use(csvReader).use(postgresWriter);
      const result = await engine.run(definition, {
        openInput: createFileInput(),
        db: () => { throw new Error("niente database"); },
        secretRef: (ref) => ref,
        log: silent,
        signal: new AbortController().signal,
      }, { dryRun: true });

      console.log(JSON.stringify({
        read: result.read,
        collegati: engine.registry.list().map((m) => m.name),
      }));
    `);

    const result = JSON.parse(stdout) as { read: number; collegati: string[] };
    expect(result.read).toBe(5);
    expect(result.collegati).toEqual(["csv", "postgres"]);
  }, 60_000);

  test("ogni subpath dichiarato in exports e' importabile", async () => {
    const stdout = await runScript(`
      const moduli = {
        ".":          "${url("dist/core/index.js")}",
        "contracts":  "${url("dist/contracts/index.js")}",
        "csv":        "${url("dist/csv-reader/index.js")}",
        "postgres":   "${url("dist/postgres-writer/index.js")}",
        "transforms": "${url("dist/transformers/index.js")}",
        "lookup":     "${url("dist/lookup-transformer/index.js")}",
      };
      const esito = {};
      for (const [nome, specifier] of Object.entries(moduli)) {
        esito[nome] = Object.keys(await import(specifier)).length > 0;
      }
      console.log(JSON.stringify(esito));
    `);

    expect(JSON.parse(stdout)).toEqual({
      ".": true, contracts: true, csv: true, postgres: true, transforms: true, lookup: true,
    });
  }, 60_000);
});
