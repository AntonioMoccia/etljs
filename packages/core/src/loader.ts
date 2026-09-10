import {
  ErrorCodes,
  IngestError,
  PROTOCOL_VERSION,
  type Plugin,
  type PluginModule,
} from "@etl-js/contracts";
import { assertUsableManifest, defaultRegistry, type Registry } from "./registry.js";
import type { PluginResolver } from "./pipeline.js";

/**
 * Convenzione di nomi: il plugin "csv" sta nel pacchetto "@etl-js/plugin-csv"
 * oppure "etl-js-plugin-csv". Cosi' aggiungere un plugin e' un `npm install`,
 * non una modifica al core (I2).
 */
export const DEFAULT_PREFIXES = ["@etl-js/plugin-", "etl-js-plugin-"] as const;

export interface LoaderOptions {
  /** Prefissi da provare, in ordine. */
  prefixes?: readonly string[];
  /** Mappa esplicita nome logico -> specifier npm; ha la precedenza. */
  packages?: Record<string, string>;
  /** Registry usato come cache di processo. */
  registry?: Registry;
  /** Iniettabile nei test; in produzione e' `await import(...)`. */
  importModule?: (specifier: string) => Promise<unknown>;
}

/** Gli specifier npm da tentare per un nome logico, in ordine di preferenza. */
export function candidateSpecifiers(name: string, options: LoaderOptions = {}): string[] {
  const explicit = options.packages?.[name];
  if (explicit) return [explicit];
  // Un nome che e' gia' uno specifier (scoped o con path) si prova cosi' com'e'.
  if (name.startsWith("@") || name.includes("/")) return [name];
  return (options.prefixes ?? DEFAULT_PREFIXES).map((prefix) => `${prefix}${name}`);
}

function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

/** Estrae il plugin dal modulo, spiegando cosa avrebbe dovuto esportare. */
function pluginFromModule(specifier: string, name: string, loaded: unknown): Plugin {
  const module = loaded as PluginModule | undefined;
  const plugin = module?.plugin ?? module?.default;
  if (!plugin || typeof plugin !== "object" || !("manifest" in plugin) || !("impl" in plugin)) {
    throw new IngestError(
      `Il pacchetto "${specifier}" non espone un plugin: serve "export const plugin: Plugin" (o un default export)`,
      {
        code: ErrorCodes.INVALID_USAGE,
        context: { specifier, requested: name, exported: Object.keys(module ?? {}) },
      },
    );
  }
  return plugin;
}

/**
 * Carica un plugin per nome logico. Il controllo del protocollo avviene qui,
 * al caricamento: un plugin incompatibile deve fallire subito e con un motivo,
 * non a meta' di un'importazione.
 */
export async function loadPlugin(name: string, options: LoaderOptions = {}): Promise<Plugin> {
  const importModule =
    options.importModule ?? ((specifier: string) => import(/* @vite-ignore */ specifier));
  const tried = candidateSpecifiers(name, options);

  let lastNotFound: unknown;
  for (const specifier of tried) {
    let loaded: unknown;
    try {
      loaded = await importModule(specifier);
    } catch (error) {
      // "non trovato" si prova col prefisso successivo; qualunque altro errore
      // viene dal codice del plugin e non va mascherato.
      if (isModuleNotFound(error)) {
        lastNotFound = error;
        continue;
      }
      throw new IngestError(
        `Il pacchetto "${specifier}" e' fallito al caricamento`,
        { code: ErrorCodes.INVALID_USAGE, context: { specifier, requested: name }, cause: error },
      );
    }

    const plugin = pluginFromModule(specifier, name, loaded);
    // Fa fallire subito i protocolli incompatibili, con nome e versione.
    assertUsableManifest(plugin.manifest);

    if (plugin.manifest.name !== name) {
      throw new IngestError(
        `Il pacchetto "${specifier}" dichiara il plugin "${plugin.manifest.name}", ma e' stato chiesto "${name}"`,
        {
          code: ErrorCodes.INVALID_USAGE,
          context: { specifier, declared: plugin.manifest.name, requested: name },
        },
      );
    }
    return plugin;
  }

  throw new IngestError(
    `Nessun pacchetto trovato per il plugin "${name}". Prova: npm i ${tried[0] ?? name}`,
    {
      code: ErrorCodes.PLUGIN_NOT_FOUND,
      context: { requested: name, tried, protocol: PROTOCOL_VERSION },
      cause: lastNotFound,
    },
  );
}

/**
 * Risolutore da passare a `run()`. Usa il registry come cache: un plugin viene
 * importato una volta sola per processo. Disinstallare o aggiornare un plugin
 * richiede il riavvio del worker, come in Node-RED o n8n.
 */
export function createLoader(options: LoaderOptions = {}): PluginResolver {
  const registry = options.registry ?? defaultRegistry;
  const inFlight = new Map<string, Promise<Plugin>>();

  return async (name: string): Promise<Plugin> => {
    const cached = registry.get(name);
    if (cached) return cached;

    const pending = inFlight.get(name);
    if (pending) return pending;

    const loading = loadPlugin(name, options)
      .then((plugin) => {
        registry.register(plugin);
        return plugin;
      })
      .finally(() => {
        inFlight.delete(name);
      });

    inFlight.set(name, loading);
    return loading;
  };
}
