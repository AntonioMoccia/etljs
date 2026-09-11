import {
  ErrorCodes,
  EtlError,
  PROTOCOL_VERSION,
  type Manifest,
  type Plugin,
  type PluginKind,
  type PluginOfKind,
} from "../contracts/index.js";

/**
 * Elenco dei plugin disponibili a un run. Il core non ne conosce nessuno per
 * nome (I2): li riceve gia' istanziati da chi lo usa (la CLI, l'host, il
 * loader dinamico della fase 2).
 */
export class Registry {
  readonly #plugins = new Map<string, Plugin>();

  /** Registra un plugin verificandone il protocollo e la coerenza del manifest. */
  register(plugin: Plugin): this {
    const { manifest } = plugin;
    assertUsableManifest(manifest);
    const existing = this.#plugins.get(manifest.name);
    if (existing && existing !== plugin) {
      throw new EtlError(
        `Due plugin diversi dichiarano il nome "${manifest.name}"`,
        {
          code: ErrorCodes.INVALID_USAGE,
          context: {
            name: manifest.name,
            versions: [existing.manifest.version, manifest.version],
          },
        },
      );
    }
    this.#plugins.set(manifest.name, plugin);
    return this;
  }

  registerAll(plugins: Iterable<Plugin>): this {
    for (const plugin of plugins) this.register(plugin);
    return this;
  }

  has(name: string): boolean {
    return this.#plugins.has(name);
  }

  get(name: string): Plugin | undefined {
    return this.#plugins.get(name);
  }

  /** Come get(), ma fallisce con un errore diagnostico invece di restituire undefined. */
  require<K extends PluginKind>(name: string, kind: K): PluginOfKind<K>;
  require(name: string, kind?: PluginKind): Plugin;
  require(name: string, kind?: PluginKind): Plugin {
    const plugin = this.#plugins.get(name);
    if (!plugin) {
      throw new EtlError(`Plugin "${name}" non registrato`, {
        code: ErrorCodes.PLUGIN_NOT_FOUND,
        context: { name, available: this.list().map((m) => m.name) },
      });
    }
    if (kind && plugin.manifest.kind !== kind) {
      throw new EtlError(
        `Il plugin "${name}" e' di tipo ${plugin.manifest.kind}, qui serve ${kind}`,
        {
          code: ErrorCodes.INVALID_USAGE,
          context: { name, expected: kind, actual: plugin.manifest.kind },
        },
      );
    }
    return plugin;
  }

  /** Manifest di tutti i plugin, ordinati per nome: e' cio' che una GUI mostra. */
  list(): Manifest[] {
    return [...this.#plugins.values()]
      .map((plugin) => plugin.manifest)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  clear(): void {
    this.#plugins.clear();
  }
}

/** Verifica che un manifest sia utilizzabile prima che il run parta, non a meta' strada. */
export function assertUsableManifest(manifest: Manifest): void {
  if (!manifest || typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new EtlError("Manifest senza nome", {
      code: ErrorCodes.INVALID_USAGE,
      context: { manifest },
    });
  }
  if (manifest.protocol !== PROTOCOL_VERSION) {
    throw new EtlError(
      `Il plugin "${manifest.name}" parla il protocollo ${manifest.protocol}, questo motore il ${PROTOCOL_VERSION}`,
      {
        code: ErrorCodes.PROTOCOL_MISMATCH,
        context: {
          plugin: manifest.name,
          version: manifest.version,
          pluginProtocol: manifest.protocol,
          enginePROTOCOL: PROTOCOL_VERSION,
        },
      },
    );
  }
}

/**
 * Registry di default: fa da cache di processo per il loader dinamico (fase 2).
 * Chi vuole isolamento totale si costruisce la propria Registry.
 */
export const defaultRegistry = new Registry();
