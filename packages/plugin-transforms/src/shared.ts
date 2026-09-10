import type { z } from "zod";
import { configInvalid } from "@etl-js/contracts";

/**
 * Un lettore di config: valida con Zod, traduce i rilievi in un EtlError e
 * ricorda il risultato, perche' il motore ripassa la **stessa** config a ogni
 * lotto e ripassare da Zod mille volte non serve a nessuno.
 *
 * Prima della fusione dei pacchetti questa funzione era riscritta cinque volte.
 */
export function configReader<S extends z.ZodType>(
  plugin: string,
  schema: S,
  /** Controlli che Zod non sa esprimere; deve lanciare via `configInvalid`. */
  check?: (config: z.infer<S>) => void,
): (raw: unknown) => z.infer<S> {
  const cache = new WeakMap<object, z.infer<S>>();

  const parse = (raw: unknown): z.infer<S> => {
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw configInvalid(
        plugin,
        result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }
    check?.(result.data);
    return result.data;
  };

  return (raw: unknown): z.infer<S> => {
    if (typeof raw !== "object" || raw === null) return parse(raw);
    const cached = cache.get(raw);
    if (cached !== undefined) return cached;
    const parsed = parse(raw);
    cache.set(raw, parsed);
    return parsed;
  };
}

/** Compila un'espressione regolare dalla config, o dice che e' malformata. */
export function compileRegex(
  plugin: string,
  path: string,
  source: string,
  ignoreCase: boolean,
): RegExp {
  try {
    return new RegExp(source, ignoreCase ? "i" : "");
  } catch (error) {
    throw configInvalid(plugin, [
      { path, message: `espressione regolare non valida: ${String(error)}` },
    ]);
  }
}
