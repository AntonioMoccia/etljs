/** Codici di errore riconosciuti dal motore. I plugin possono aggiungerne di propri. */
export const ErrorCodes = {
  /** Config non conforme allo schema del plugin. */
  CONFIG_INVALID: "CONFIG_INVALID",
  /** Plugin non trovato dal loader. */
  PLUGIN_NOT_FOUND: "PLUGIN_NOT_FOUND",
  /** Manifest incompatibile con PROTOCOL_VERSION. */
  PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
  /** La sorgente non e' leggibile (file assente, permessi, encoding). */
  SOURCE_UNREADABLE: "SOURCE_UNREADABLE",
  /** Errore restituito dal database. */
  DB_ERROR: "DB_ERROR",
  /** Il run ha superato la soglia di scarto ammessa. */
  TOO_MANY_FAILED: "TOO_MANY_FAILED",
  /** Il run e' stato annullato tramite ctx.signal. */
  ABORTED: "ABORTED",
  /** Uso improprio dell'API da parte dell'host o di un plugin. */
  INVALID_USAGE: "INVALID_USAGE",
  /** Il reader e' fallito mentre leggeva. */
  READ_FAILED: "READ_FAILED",
  /** Un transformer e' fallito su un lotto. */
  TRANSFORM_FAILED: "TRANSFORM_FAILED",
  /** Il writer e' fallito aprendo, scrivendo o chiudendo. */
  WRITE_FAILED: "WRITE_FAILED",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes] | (string & {});

export interface IngestErrorOptions {
  code: ErrorCode;
  /** true se ritentare la stessa operazione ha senso (timeout, deadlock, rete). */
  retryable?: boolean;
  /** Dati diagnostici serializzabili: mai credenziali, mai righe intere. */
  context?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * Errore unico del motore: classificato (code), instradabile (retryable) e
 * serializzabile (toJSON), cosi' l'host puo' deciderne il destino senza
 * fare pattern matching sul messaggio.
 */
export class IngestError extends Error {
  override readonly name = "IngestError";
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly context: Record<string, unknown>;

  constructor(message: string, options: IngestErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.context = options.context ?? {};
  }

  static is(value: unknown): value is IngestError {
    return value instanceof IngestError;
  }

  /** Avvolge un errore sconosciuto senza perderne la causa. */
  static wrap(value: unknown, options: IngestErrorOptions): IngestError {
    if (IngestError.is(value)) return value;
    const message = value instanceof Error ? value.message : String(value);
    return new IngestError(message, { ...options, cause: value });
  }

  /** Lo stesso errore con qualche dato diagnostico in piu'. */
  withContext(extra: Record<string, unknown>): IngestError {
    return new IngestError(this.message, {
      code: this.code,
      retryable: this.retryable,
      context: { ...this.context, ...extra },
      cause: this.cause ?? this,
    });
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      context: this.context,
    };
  }
}

/** Un rilievo su una config, nella forma in cui lo produce qualunque validatore. */
export interface ConfigIssue {
  path: string;
  message: string;
}

/**
 * Errore di config uniforme per tutti i plugin. Sta qui e non in un pacchetto
 * di utilita' perche' ogni plugin ne ha bisogno e nessun plugin puo' dipendere
 * da altro che da @etl-js/contracts (I9). Non conosce Zod: riceve i rilievi
 * gia' appiattiti, cosi' resta a zero dipendenze.
 */
export function configInvalid(plugin: string, issues: ConfigIssue[]): IngestError {
  const summary = issues
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ");
  return new IngestError(`Config del plugin ${plugin} non valida - ${summary}`, {
    code: ErrorCodes.CONFIG_INVALID,
    context: { plugin, issues },
  });
}
