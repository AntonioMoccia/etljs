import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Due errori che su macOS e Linux non si vedono e su Windows fanno fallire
 * tutto. Li abbiamo fatti entrambi, e li ha trovati l'utente eseguendo
 * `npm publish` - cioe' il posto peggiore.
 *
 * Finche' si sviluppa su una piattaforma sola, l'unico modo di accorgersene
 * prima e' un controllo statico come questo.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

async function sorgenti(cartella: string, raccolti: string[] = []): Promise<string[]> {
  for (const voce of await readdir(join(repoRoot, cartella), { withFileTypes: true })) {
    const relativo = `${cartella}/${voce.name}`;
    if (voce.isDirectory()) await sorgenti(relativo, raccolti);
    else if (extname(voce.name) === ".ts") raccolti.push(relativo);
  }
  return raccolti;
}

async function tuttiISorgenti(): Promise<{ file: string; testo: string }[]> {
  const elenco = [
    ...(await sorgenti("src")),
    ...(await sorgenti("test")),
    ...(await sorgenti("tools")),
  ];
  return Promise.all(
    elenco.map(async (file) => ({ file, testo: await readFile(join(repoRoot, file), "utf8") })),
  );
}

describe("portabilita'", () => {
  test("nessuno ricava un percorso da import.meta.url con .pathname", async () => {
    const colpevoli = (await tuttiISorgenti())
      .filter(({ testo }) => /import\.meta\.url\s*\)?\s*\)?\s*\.pathname/.test(testo))
      .map(({ file }) => file);

    // Su Windows .pathname restituisce "/C:/Users/..." con lo slash iniziale,
    // e join() produce "C:\C:\Users\...". Si usa fileURLToPath.
    expect(colpevoli).toEqual([]);
  });

  test("nessuno lancia npm o npx come eseguibile: su Windows sono file .cmd", async () => {
    const colpevoli = (await tuttiISorgenti())
      .filter(({ testo }) => /exec(?:File|FileSync)?\(\s*"(npm|npx|tsc|vitest|depcruise)"/.test(testo))
      .map(({ file }) => file);

    // execFile non passa dalla shell e su Windows non trova npx.cmd.
    // Si invoca il binario con process.execPath.
    expect(colpevoli).toEqual([]);
  });

  test("i percorsi dei file di prova si costruiscono con join, non concatenando slash", async () => {
    const colpevoli = (await tuttiISorgenti())
      .filter(({ testo }) => /repoRoot\s*\+\s*["'`]/.test(testo))
      .map(({ file }) => file);

    expect(colpevoli).toEqual([]);
  });
});
