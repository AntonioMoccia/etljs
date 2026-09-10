import { createReadStream } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ErrorCodes, EtlError, type ByteStream } from "@etl-js/contracts";

/** Come il core apre una sorgente: e' cio' che finisce in `ctx.openInput`. */
export type InputResolver = (ref: string) => Promise<ByteStream>;

export interface FileInputOptions {
  /**
   * Cartella entro cui i `ref` devono restare. Senza di essa un `ref` che
   * arriva da una Definition puo' leggere qualunque file della macchina:
   * "../../.ssh/id_rsa" e' un percorso valido come un altro.
   */
  baseDir?: string;
}

/**
 * Risolve un `ref` come file su disco. E' la risoluzione da sviluppo e da CLI;
 * in produzione l'host ne passa un'altra (object storage) e **il plugin non
 * cambia di una riga** (I6).
 */
export function createFileInput(options: FileInputOptions = {}): InputResolver {
  const base = options.baseDir === undefined ? undefined : resolve(options.baseDir);

  return async (ref: string): Promise<ByteStream> => {
    if (typeof ref !== "string" || ref.trim() === "") {
      throw new EtlError("Riferimento alla sorgente vuoto", {
        code: ErrorCodes.INVALID_USAGE,
        context: { ref },
      });
    }

    const path = base ? resolve(base, ref) : resolve(ref);

    if (base) {
      const inside = relative(base, path);
      if (inside === "" || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) {
        throw new EtlError(`La sorgente "${ref}" esce dalla cartella consentita`, {
          code: ErrorCodes.INVALID_USAGE,
          context: { ref, baseDir: base },
        });
      }
    }

    const stream = createReadStream(path);
    // L'apertura di fs.createReadStream e' pigra: l'errore arriva sull'evento,
    // non qui. Lo si intercetta subito per poterlo classificare.
    await new Promise<void>((accept, fail) => {
      stream.once("open", () => accept());
      stream.once("error", (error) =>
        fail(
          new EtlError(`Impossibile leggere la sorgente "${ref}"`, {
            code: ErrorCodes.READ_FAILED,
            retryable: true,
            context: { ref, path },
            cause: error,
          }),
        ),
      );
    });

    return stream;
  };
}

/** Sorgente presa da un valore gia' in memoria: comoda nei test e per gli incolla. */
export function createMemoryInput(sources: Record<string, string | Uint8Array>): InputResolver {
  return async (ref: string): Promise<ByteStream> => {
    const content = sources[ref];
    if (content === undefined) {
      throw new EtlError(`Sorgente "${ref}" non disponibile`, {
        code: ErrorCodes.READ_FAILED,
        context: { ref, available: Object.keys(sources) },
      });
    }
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    return {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    };
  };
}
