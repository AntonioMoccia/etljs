import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const exec = promisify(execFile);
const repoRoot = new URL("../..", import.meta.url).pathname;

/**
 * Prova end-to-end sul **compilato**: il motore esegue una Definition avendo un
 * registry vuoto e risolvendo i plugin per nome. Gira in un processo Node
 * separato, cosi' controlla anche che `dist/` sia importabile davvero.
 *
 * Col pacchetto unico i plugin non sono piu' pacchetti npm distinti, quindi il
 * nome logico si mappa sul file compilato con l'opzione `packages` del loader.
 */
const built = existsSync(join(repoRoot, "dist/core/index.js"));
const url = (path: string): string => pathToFileURL(join(repoRoot, path)).href;

describe.skipIf(!built)("il motore sul compilato", () => {
  async function runScript(source: string): Promise<string> {
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", source], {
      cwd: repoRoot,
    });
    return stdout;
  }

  test("esegue una Definition con un registry vuoto, risolvendo i plugin per nome", async () => {
    const stdout = await runScript(`
      import { readFile } from "node:fs/promises";
      import { Registry, createFileInput, createLoader, run } from "${url("dist/core/index.js")}";

      const definition = JSON.parse(await readFile("examples/acme-fase0.json", "utf8"));
      const registry = new Registry();            // vuoto: nessun plugin conosciuto
      const silent = { debug(){}, info(){}, warn(){}, error(){}, child(){ return silent; } };

      const result = await run(definition, {
        openInput: createFileInput(),
        db: () => { throw new Error("niente database"); },
        secretRef: (ref) => ref,
        log: silent,
        signal: new AbortController().signal,
      }, {
        registry,
        resolve: createLoader({
          registry,
          packages: {
            csv: "${url("dist/csv/index.js")}",
            postgres: "${url("dist/postgres/index.js")}",
          },
        }),
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

  test("un plugin non risolvibile produce un errore diagnostico", async () => {
    const stdout = await runScript(`
      import { loadPlugin } from "${url("dist/core/index.js")}";
      try {
        await loadPlugin("parquet");
        console.log(JSON.stringify({ ok: true }));
      } catch (error) {
        console.log(JSON.stringify({ code: error.code, message: error.message }));
      }
    `);

    const result = JSON.parse(stdout) as { code: string; message: string };
    expect(result.code).toBe("PLUGIN_NOT_FOUND");
    expect(result.message).toContain("parquet");
  }, 60_000);
});
