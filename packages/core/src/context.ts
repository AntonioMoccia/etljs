import {
  ErrorCodes,
  IngestError,
  type Ctx,
  type Logger,
  type WriteTransaction,
  type WriterCtx,
} from "@etl-js/contracts";

/**
 * Contesto che l'host consegna a `run()`. E' un `Ctx` normale piu' la
 * capacita' di aprire transazioni: e' l'host a possedere pool e credenziali (I6).
 */
export interface HostCtx extends Omit<Ctx, "runId"> {
  /** Se assente, il runId lo genera `run()`. */
  runId?: string;
  dbWrite?(name: string): Promise<WriteTransaction>;
}

/**
 * Vista in sola lettura del contesto, per reader e transformer.
 * Non e' una convenzione: `dbWrite` proprio non esiste su questo oggetto,
 * quindi un transformer non puo' scrivere nemmeno per sbaglio (I4).
 */
export function readOnlyCtx(ctx: HostCtx, log: Logger, runId: string): Ctx {
  return {
    runId,
    db: (name) => ctx.db(name),
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
