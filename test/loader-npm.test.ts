import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const exec = promisify(execFile);
const repoRoot = new URL("..", import.meta.url).pathname;

/**
 * Prova end-to-end del criterio della fase 2: un plugin si aggiunge **per nome**
 * senza toccare il core. Gira in un processo Node separato, sui pacchetti
 * compilati, cosi' la risoluzione e' quella vera di npm e non l'alias di vitest.
 */
const built = existsSync(join(repoRoot, "packages/core/dist/index.js"));

describe.skipIf(!built)("caricamento dei plugin da npm", () => {
  async function runScript(source: string): Promise<string> {
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", source], {
      cwd: repoRoot,
    });
    return stdout;
  }

  test("il core esegue una Definition avendo solo il loader, senza plugin registrati", async () => {
    const stdout = await runScript(`
      import { readFile } from "node:fs/promises";
      import { Registry, createLoader, run } from "@etl-js/core";

      const definition = JSON.parse(await readFile("examples/acme-fase0.json", "utf8"));
      const registry = new Registry();            // vuoto: nessun plugin conosciuto
      const silent = { debug(){}, info(){}, warn(){}, error(){}, child(){ return silent; } };

      const result = await run(definition, {
        db: () => { throw new Error("niente database"); },
        secretRef: (ref) => ref,
        log: silent,
        signal: new AbortController().signal,
      }, {
        registry,
        resolve: createLoader({ registry }),
        dryRun: true,
      });

      console.log(JSON.stringify({
        read: result.read,
        caricati: registry.list().map((m) => m.name),
      }));
    `);

    const result = JSON.parse(stdout) as { read: number; caricati: string[] };
    expect(result.read).toBe(5);
    expect(result.caricati).toEqual(["csv", "postgres"]);
  }, 60_000);

  test("un plugin inesistente suggerisce il pacchetto da installare", async () => {
    const stdout = await runScript(`
      import { loadPlugin } from "@etl-js/core";
      try {
        await loadPlugin("parquet");
        console.log(JSON.stringify({ ok: true }));
      } catch (error) {
        console.log(JSON.stringify({ code: error.code, message: error.message }));
      }
    `);

    const result = JSON.parse(stdout) as { code: string; message: string };
    expect(result.code).toBe("PLUGIN_NOT_FOUND");
    expect(result.message).toContain("npm i @etl-js/plugin-parquet");
  }, 60_000);
});
