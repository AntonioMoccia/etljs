import { ErrorCodes, EtlError } from "../contracts/index.js";

export interface RetryOptions {
  /** Numero massimo di tentativi, il primo compreso. */
  attempts?: number;
  /** Attesa di partenza, raddoppiata a ogni tentativo. */
  baseMs?: number;
  /** Tetto all'attesa, perche' l'esponenziale non diventi un'ora. */
  maxMs?: number;
  /** Annulla i tentativi quando il run viene fermato. */
  signal?: AbortSignal;
  /** Iniettabili nei test: senza, il tempo e il caso veri. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Ritenta solo cio' che l'errore stesso dichiara ritentabile: deadlock,
 * contesa, cadute di rete. Un vincolo violato o una colonna assente non
 * migliorano riprovando, e ritentarli nasconderebbe il problema.
 *
 * L'attesa e' esponenziale con jitter pieno: senza il jitter, dieci worker
 * caduti insieme tornerebbero a bussare tutti nello stesso istante.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseMs = options.baseMs ?? 100;
  const maxMs = options.maxMs ?? 10_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = EtlError.is(error) && error.retryable;
      const lastAttempt = attempt === attempts;
      if (!retryable || lastAttempt || options.signal?.aborted) break;

      const window = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      await sleep(Math.round(window * random()));
    }
  }

  if (EtlError.is(lastError)) throw lastError.withContext({ attempts });
  throw EtlError.wrap(lastError, { code: ErrorCodes.DB_ERROR, context: { attempts } });
}
