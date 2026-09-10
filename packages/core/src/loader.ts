import {
  ErrorCodes,
  EtlError,
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

function isPlugin(value: unknown): value is Plugin {
  return typeof value === "object" && value !== null && "manifest" in value && "impl" in value;
}

/**
 * Tutti i plugin contenuti nel modulo. Un pacchetto puo' portarne uno
 * (`plugin` o default export) o un elenco (`plugins`): un pacchetto e'
 * un'unita' di distribuzione, un plugin un'unita' di configurazione.
 */
function pluginsFromModule(specifier: string, name: string, loaded: unknown): Plugin[] {
  const module = loaded as PluginModule | undefined;
  const bundle = module?.plugins;

  if (Array.isArray(bundle)) {
    if (bundle.length === 0 || !bundle.every(isPlugin)) {
      throw new EtlError(
        `Il pacchetto "${specifier}" esporta "plugins" ma non e' un elenco di plugin validi`,
        { code: ErrorCodes.INVALID_USAGE, context: { specifier, requested: name } },
      );
    }
    return bundle;
  }

  const single = module?.plugin ?? module?.default;
  if (!isPlugin(single)) {
    throw new EtlError(
      `Il pacchetto "${specifier}" non espone un plugin: serve "export const plugin: Plugin" (o "plugins", o un default export)`,
      {
        code: ErrorCodes.INVALID_USAGE,
        context: { specifier, requested: name, exported: Object.keys(module ?? {}) },
      },
    );
  }
  return [single];
}

/**
 * Carica un plugin per nome logico. Il controllo del protocollo avviene qui,
 * al caricamento: un plugin incompatibile deve fallire subito e con un motivo,
 * non a meta' di un'importazione.
 */
export async function loadPlugin(name: string, options: LoaderOptions = {}): Promise<Plugin> {
  return (await loadPluginPackage(name, options)).plugin;
}

/** Il plugin richiesto insieme agli altri che viaggiano nello stesso pacchetto. */
export interface LoadedPackage {
  plugin: Plugin;
  siblings: Plugin[];
}

/**
 * Come `loadPlugin`, ma restituisce anche i fratelli: registrarli tutti evita
 * di reimportare lo stesso pacchetto per ogni plugin che contiene.
 */
export async function loadPluginPackage(
  name: string,
  options: LoaderOptions = {},
): Promise<LoadedPackage> {
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
      throw new EtlError(
        `Il pacchetto "${specifier}" e' fallito al caricamento`,
        { code: ErrorCodes.INVALID_USAGE, context: { specifier, requested: name }, cause: error },
      );
    }

    const found = pluginsFromModule(specifier, name, loaded);
    // Un pacchetto si prende o si lascia tutto intero: un fratello con il
    // protocollo sbagliato e' un pacchetto da aggiornare, non un dettaglio.
    for (const plugin of found) assertUsableManifest(plugin.manifest);

    const wanted = found.find((plugin) => plugin.manifest.name === name);
    if (!wanted) {
      const contiene = found.map((plugin) => plugin.manifest.name);
      // Un pacchetto singolo che dichiara un altro nome e' un errore d'uso;
      // un pacchetto che ne contiene molti semplicemente non ha quello chiesto.
      if (found.length === 1) {
        throw new EtlError(
          `Il pacchetto "${specifier}" dichiara il plugin "${contiene[0] ?? ""}", ma e' stato chiesto "${name}"`,
          {
            code: ErrorCodes.INVALID_USAGE,
            context: { specifier, declared: contiene[0], requested: name },
          },
        );
      }
      throw new EtlError(
        `Il pacchetto "${specifier}" non contiene il plugin "${name}"`,
        { code: ErrorCodes.PLUGIN_NOT_FOUND, context: { specifier, requested: name, contiene } },
      );
    }
    return { plugin: wanted, siblings: found };
  }

  throw new EtlError(
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

    const loading = loadPluginPackage(name, options)
      .then(({ plugin, siblings }) => {
        // Si registra tutto il pacchetto: il prossimo plugin dello stesso
        // pacchetto lo trovera' gia' pronto, senza un secondo import.
        for (const sibling of siblings) registry.register(sibling);
        return plugin;
      })
      .finally(() => {
        inFlight.delete(name);
      });

    inFlight.set(name, loading);
    return loading;
  };
}
