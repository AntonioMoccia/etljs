import type { Definition, Plugin, RunResult } from "../contracts/index.js";
import { Registry } from "./registry.js";
import { run, type RunOptions } from "./pipeline.js";
import type { HostCtx } from "./context.js";

/** Le opzioni di `run()` meno quelle che l'engine decide da se'. */
export type EngineRunOptions = Omit<RunOptions, "registry" | "resolve">;

/**
 * Un motore con i suoi plugin gia' collegati.
 *
 * E' una facciata sottile sopra `Registry` e `run()`: non aggiunge
 * comportamento, rende esplicito **chi** partecipa a un'importazione. Il core
 * continua a non conoscere alcun plugin per nome (I2): e' chi usa la libreria
 * a passarglieli, qui con un `use()` invece che costruendo una Registry.
 */
export interface Engine {
  /** Collega un plugin. Restituisce l'engine, cosi' le chiamate si concatenano. */
  use(plugin: Plugin): Engine;
  /** Collega piu' plugin insieme, comodo con i pacchetti che ne contengono molti. */
  useAll(plugins: Iterable<Plugin>): Engine;
  /** Esegue una Definition con i plugin collegati. */
  run(definition: Definition, ctx: HostCtx, options?: EngineRunOptions): Promise<RunResult>;
  /** Il registry sottostante, per chi ha bisogno di ispezionarlo (describe, listPlugins). */
  readonly registry: Registry;
}

/**
 * ```ts
 * const engine = createEngine().use(csv).use(postgres);
 * await engine.run(definition, ctx);
 * ```
 *
 * Ogni engine ha la **sua** Registry: due engine nello stesso processo non si
 * scambiano i plugin, il che conta quando un host ne costruisce uno diverso
 * per ogni tenant.
 */
export function createEngine(): Engine {
  const registry = new Registry();

  const engine: Engine = {
    registry,
    use(plugin: Plugin): Engine {
      // Il controllo del protocollo e il rifiuto dei nomi duplicati stanno
      // gia' in Registry.register: qui non serve altra logica di errore.
      registry.register(plugin);
      return engine;
    },
    useAll(plugins: Iterable<Plugin>): Engine {
      registry.registerAll(plugins);
      return engine;
    },
    run(definition: Definition, ctx: HostCtx, options: EngineRunOptions = {}): Promise<RunResult> {
      return run(definition, ctx, { ...options, registry });
    },
  };

  return engine;
}
