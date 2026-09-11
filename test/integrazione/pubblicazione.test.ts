import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Il pacchetto e' pubblicabile: i controlli che proteggono la pubblicazione
 * devono restare veri anche fra sei mesi, quando nessuno si ricordera' perche'
 * erano fatti cosi'.
 */
// fileURLToPath e non .pathname: su Windows quello lascia lo slash
// iniziale ("/C:/...") e join() finisce per produrre "C:\C:\...".
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

async function manifest(): Promise<Record<string, never> & {
  name: string; version: string; files: string[]; bin: Record<string, string>;
  exports: Record<string, { types: string; import: string }>;
  scripts: Record<string, string>;
}> {
  return JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
}

describe("pubblicazione", () => {
  test("prepublishOnly esegue esattamente gli stessi controlli di check", async () => {
    const { scripts } = await manifest();
    // Se divergono, si pubblica con meno controlli di quelli che si crede.
    expect(scripts["prepublishOnly"]).toBe(scripts["check"]);
  });

  test("nessuno script di lifecycle chiama npm: su Windows gira in cmd.exe, dove npm puo' non essere sul PATH", async () => {
    const { scripts } = await manifest();
    for (const nome of ["prepublishOnly", "prepare", "prepack", "postinstall"]) {
      const comando = scripts[nome];
      if (comando === undefined) continue;
      expect(comando, nome).not.toMatch(/\bnpm\b/);
    }
  });

  test("ogni subpath di exports punta a file che il pacchetto contiene", async () => {
    const { exports: mappa, files } = await manifest();
    for (const [subpath, target] of Object.entries(mappa)) {
      for (const percorso of [target.types, target.import]) {
        const cartella = percorso.replace(/^\.\//, "").split("/")[0];
        expect(files, `${subpath} -> ${percorso}`).toContain(cartella);
      }
    }
  });

  test("il bin dichiarato esce dalla compilazione", async () => {
    const { bin, exports: mappa } = await manifest();
    const percorsi = Object.values(bin);
    expect(percorsi.length).toBeGreaterThan(0);
    for (const percorso of percorsi) {
      // Stessa radice degli entry point: se dist/ si sposta, se ne accorge.
      expect(percorso).toMatch(/^\.\/dist\//);
    }
    expect(Object.keys(mappa)).toContain(".");
  });

  test("i sorgenti sono nel pacchetto, altrimenti le declaration map puntano nel vuoto", async () => {
    const { files } = await manifest();
    expect(files).toContain("src");
    expect(files).toContain("dist");
  });

  test("i metadati che npm mostra ci sono", async () => {
    const m = await manifest() as unknown as Record<string, unknown>;
    for (const campo of ["description", "license", "author", "repository", "keywords", "engines"]) {
      expect(m[campo], campo).toBeDefined();
    }
  });
});
