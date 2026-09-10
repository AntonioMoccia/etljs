import {
  ErrorCodes,
  IngestError,
  type ByteStream,
  type Ctx,
  type Logger,
  type WriteTransaction,
  type WriterCtx,
} from "@etl-js/contracts";

/**
 * Contesto che l'host consegna a `run()`. E' un `Ctx` normale piu' la
 * capacita' di aprire transazioni: e' l'host a possedere pool e credenziali (I6).
 */
export interface HostCtx extends Omit<Ctx, "runId" | "openInput"> {
  /** Se assente, il runId lo genera `run()`. */
  runId?: string;
  /**
   * Come aprire le sorgenti. Se l'host non la fornisce, un reader che ne ha
   * bisogno fallisce con un messaggio che dice cosa manca, invece di leggere
   * di nascosto dal filesystem. Vedi `createFileInput`.
   */
  openInput?(ref: string): Promise<ByteStream>;
  dbWrite?(name: string): Promise<WriteTransaction>;
}

/**
 * Vista in sola lettura del contesto, per reader e transformer.
 * Non e' una convenzione: `dbWrite` proprio non esiste su questo oggetto,
 * quindi un transformer non puo' scrivere nemmeno per sbaglio (I4).
 */
export function readOnlyCtx(ctx: HostCtx, log: Logger, runId: string): Ctx {
  const openInput = ctx.openInput?.bind(ctx);
  return {
    runId,
    db: (name) => ctx.db(name),
    openInput: async (ref) => {
      if (!openInput) {
        throw new IngestError(
          `La sorgente "${ref}" non puo' essere aperta: l'host non ha fornito ctx.openInput (vedi createFileInput)`,
          { code: ErrorCodes.INVALID_USAGE, context: { ref } },
        );
      }
      return openInput(ref);
    },
    secretRef: (ref) => ctx.secretRef(ref),
    log,
    signal: ctx.signal,
  };
}

/** Contesto completo, riservato al writer della destinazione. */
export function writerCtx(ctx: HostCtx, log: Logger, runId: string): WriterCtx {
  const dbWrite = ctx.dbWrite?.bind(ctx);
  return {
    ...readOnlyCtx(ctx, log, runId),
    dbWrite: async (name) => {
      if (!dbWrite) {
        throw new IngestError(
          "La destinazione richiede una connessione in scrittura ma l'host non ha fornito ctx.dbWrite",
          { code: ErrorCodes.INVALID_USAGE, context: { db: name } },
        );
      }
      return dbWrite(name);
    },
  };
}

/** Logger che non fa nulla: default quando l'host non ne passa uno. */
export function nullLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}
