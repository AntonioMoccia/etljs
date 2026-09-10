import { describe, expect, test } from "vitest";
import { PROTOCOL_VERSION, type Plugin } from "@etl-js/contracts";
import { Registry, createLoader, loadPlugin, run } from "@etl-js/core";
import { definition, hostCtx, readerOf, writerOf } from "./fakes.js";

/** Finto npm: un dizionario da specifier a modulo. */
function fakeNpm(modules: Record<string, unknown>) {
  const requested: string[] = [];
  const importModule = async (specifier: string): Promise<unknown> => {
    requested.push(specifier);
    if (!(specifier in modules)) {
      const error = new Error(`Cannot find package '${specifier}'`) as Error & { code: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    }
    return modules[specifier];
  };
  return { importModule, requested };
}

function pluginNamed(name: string, protocol = PROTOCOL_VERSION): Plugin {
  const base = readerOf([[{ id: 1 }]]);
  return { ...base, manifest: { ...base.manifest, name, protocol } };
}

describe("loadPlugin", () => {
  test("passa dal nome logico al pacchetto npm con la convenzione del prefisso", async () => {
    const npm = fakeNpm({ "@etl-js/plugin-csv": { plugin: pluginNamed("csv") } });
    const plugin = await loadPlugin("csv", { importModule: npm.importModule });
    expect(plugin.manifest.name).toBe("csv");
    expect(npm.requested).toContain("@etl-js/plugin-csv");
  });

  test("accetta anche il default export, non solo `plugin`", async () => {
    const npm = fakeNpm({ "@etl-js/plugin-csv": { default: pluginNamed("csv") } });
    const plugin = await loadPlugin("csv", { importModule: npm.importModule });
    expect(plugin.manifest.name).toBe("csv");
  });

  test("una mappa esplicita vince sulla convenzione", async () => {
    const npm = fakeNpm({ "@acme/lettore-strano": { plugin: pluginNamed("csv") } });
    const plugin = await loadPlugin("csv", {
      packages: { csv: "@acme/lettore-strano" },
      importModule: npm.importModule,
    });
    expect(plugin.manifest.name).toBe("csv");
    expect(npm.requested).toEqual(["@acme/lettore-strano"]);
  });

  test("un nome che e' gia' uno specifier viene provato cosi' com'e'", async () => {
    const npm = fakeNpm({ "@acme/etl-lettore": { plugin: pluginNamed("@acme/etl-lettore") } });
    const plugin = await loadPlugin("@acme/etl-lettore", { importModule: npm.importModule });
    expect(plugin.manifest.name).toBe("@acme/etl-lettore");
  });

  test("un protocollo incompatibile e' un errore diagnostico, non un crash a meta' run", async () => {
    const npm = fakeNpm({ "@etl-js/plugin-csv": { plugin: pluginNamed("csv", PROTOCOL_VERSION + 1) } });
    await expect(loadPlugin("csv", { importModule: npm.importModule })).rejects.toMatchObject({
      code: "PROTOCOL_MISMATCH",
      context: { pluginProtocol: PROTOCOL_VERSION + 1, enginePROTOCOL: PROTOCOL_VERSION },
    });
  });

  test("un modulo che non esporta un plugin dice cosa avrebbe dovuto esportare", async () => {
    const npm = fakeNpm({ "@etl-js/plugin-csv": { qualcosaAltro: 1 } });
    await expect(loadPlugin("csv", { importModule: npm.importModule })).rejects.toMatchObject({
      code: "INVALID_USAGE",
    });
    await expect(loadPlugin("csv", { importModule: npm.importModule })).rejects.toThrowError(
      /export const plugin/,
    );
  });

  test("un manifest che dichiara un nome diverso da quello richiesto viene rifiutato", async () => {
    const npm = fakeNpm({ "@etl-js/plugin-csv": { plugin: pluginNamed("tsv") } });
    await expect(loadPlugin("csv", { importModule: npm.importModule })).rejects.toThrowError(
      /"tsv".*"csv"|"csv".*"tsv"/,
    );
  });

  test("se nessuno specifier risolve, l'errore elenca cosa e' stato tentato", async () => {
    const npm = fakeNpm({});
    await expect(loadPlugin("csv", { importModule: npm.importModule })).rejects.toMatchObject({
      code: "PLUGIN_NOT_FOUND",
      context: { tried: ["@etl-js/plugin-csv", "etl-js-plugin-csv"] },
    });
  });

  test("un errore dentro il modulo del plugin non viene scambiato per 'non trovato'", async () => {
    const importModule = async (): Promise<unknown> => {
      throw new TypeError("il plugin ha un bug al caricamento");
    };
    await expect(loadPlugin("csv", { importModule })).rejects.toMatchObject({
      code: "INVALID_USAGE",
    });
  });
});

describe("createLoader", () => {
  test("carica una volta sola: il registry fa da cache", async () => {
    const npm = fakeNpm({ "@etl-js/plugin-csv": { plugin: pluginNamed("csv") } });
    const registry = new Registry();
    const loader = createLoader({ importModule: npm.importModule, registry });

    await loader("csv");
    await loader("csv");

    expect(npm.requested).toEqual(["@etl-js/plugin-csv"]);
    expect(registry.has("csv")).toBe(true);
  });

  test("run() usa il loader per un plugin che il registry non ha (I2)", async () => {
    const sink = { rows: [], outcome: [] as string[] };
    const npm = fakeNpm({
      "@etl-js/plugin-fake-reader": { plugin: readerOf([[{ ok: true, id: 1 }]]) },
    });
    const registry = new Registry().register(writerOf(sink));

    const result = await run(definition(), hostCtx(), {
      registry,
      resolve: createLoader({ importModule: npm.importModule, registry }),
    });

    expect(result.read).toBe(1);
    expect(npm.requested).toEqual(["@etl-js/plugin-fake-reader"]);
  });
});
