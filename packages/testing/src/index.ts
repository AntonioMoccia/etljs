/**
 * @etl-js/testing - quel poco che serve per provare un plugin senza database,
 * senza file e senza motore. Dipende solo da @etl-js/contracts (I9).
 */
import type {
  Batch,
  BatchMeta,
  ByteStream,
  Ctx,
  Failed,
  Logger,
  ReadOnlyDb,
  Row,
  TransformerPlugin,
  Transformer,
} from "@etl-js/contracts";

/** Una riga di log catturata, con i suoi campi strutturati. */
export interface LogLine {
  severity: "debug" | "info" | "warn" | "error";
  message: string;
  fields: Record<string, unknown>;
}

export interface RecordingLogger extends Logger {
  readonly lines: LogLine[];
}

/** Logger che non stampa nulla e ricorda tutto. */
export function recordingLogger(inherited: Record<string, unknown> = {}, lines: LogLine[] = []): RecordingLogger {
  const push = (severity: LogLine["severity"]) =>
    (message: string, fields: Record<string, unknown> = {}): void => {
      lines.push({ severity, message, fields: { ...inherited, ...fields } });
    };
  return {
    lines,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    child: (fields) => recordingLogger({ ...inherited, ...fields }, lines),
  };
}

export interface DbCall {
  sql: string;
  params: readonly unknown[];
}

export interface RecordingDb extends ReadOnlyDb {
  /** Ogni interrogazione ricevuta, in ordine: serve a dimostrare I5. */
  readonly calls: DbCall[];
}

/**
 * Database finto che risponde con cio' che gli dice `respond`. Non interpreta
 * SQL: e' il test a dichiarare la risposta e a controllare l'istruzione, che e'
 * l'unico modo onesto di verificare che una query sia parametrizzata e batch.
 */
export function recordingDb(
  respond: (sql: string, params: readonly unknown[]) => Row[] | Promise<Row[]> = () => [],
): RecordingDb {
  const calls: DbCall[] = [];
  return {
    calls,
    async query<T extends Row = Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      calls.push({ sql, params });
      return (await respond(sql, params)) as T[];
    },
  };
}

export interface MockCtxOptions {
  runId?: string;
  /**
   * Sorgenti per `ctx.openInput`, come testo o byte gia' pronti: un test di un
   * reader non deve toccare il disco.
   */
  inputs?: Record<string, string | Uint8Array>;
  /** Database per nome logico. Chiedere un nome assente e' un errore, come in produzione. */
  databases?: Record<string, ReadOnlyDb>;
  secrets?: Record<string, string>;
  signal?: AbortSignal;
  logger?: RecordingLogger;
}

export interface MockCtx extends Ctx {
  log: RecordingLogger;
}

/**
 * Ctx di prova. Non espone `dbWrite`: un transformer che provasse a scrivere
 * non compilerebbe nemmeno, ed e' esattamente cio' che fa il core (I4).
 */
export function mockCtx(options: MockCtxOptions = {}): MockCtx {
  const log = options.logger ?? recordingLogger();
  const databases = options.databases ?? {};
  const inputs = options.inputs ?? {};
  return {
    runId: options.runId ?? "run-di-prova",
    openInput: async (ref): Promise<ByteStream> => {
      const content = inputs[ref];
      if (content === undefined) {
        throw new Error(
          `Il test non ha fornito la sorgente "${ref}". Passala a mockCtx({ inputs: { "${ref}": "..." } })`,
        );
      }
      const bytes =
        typeof content === "string" ? new TextEncoder().encode(content) : content;
      return {
        async *[Symbol.asyncIterator]() {
          yield bytes;
        },
      };
    },
    db: (name) => {
      const db = databases[name];
      if (!db) {
        throw new Error(
          `Il test non ha fornito il database "${name}". Passalo a mockCtx({ databases: { ${name}: ... } })`,
        );
      }
      return db;
    },
    secretRef: (ref) => {
      const secret = options.secrets?.[ref];
      if (secret === undefined) {
        throw new Error(`Il test non ha fornito il segreto "${ref}"`);
      }
      return secret;
    },
    log,
    signal: options.signal ?? new AbortController().signal,
  };
}

/** Costruisce un lotto a partire da righe nude. */
export function batchOf(rows: Row[], meta: Partial<BatchMeta> = {}): Batch {
  return {
    rows,
    meta: {
      runId: meta.runId ?? "run-di-prova",
      source: meta.source ?? "prova.csv",
      offset: meta.offset ?? 0,
    },
  };
}

export interface TransformerCase {
  /** Righe in ingresso, oppure lotti gia' formati per provare piu' passaggi. */
  rows?: Row[];
  batches?: Batch[];
  config?: unknown;
  ctx?: MockCtx;
  /** Chiama anche flush() alla fine, come fa il motore. */
  flush?: boolean;
}

export interface TransformerOutcome {
  /** Righe sopravvissute, di tutti i lotti messi in fila. */
  rows: Row[];
  failed: Failed[];
  /** I lotti cosi' come sono usciti, se serve guardarne i meta. */
  batches: Batch[];
  ctx: MockCtx;
}

/**
 * Esegue un transformer come lo eseguirebbe il motore: a lotti, con lo stesso
 * ctx per tutto il run, e con flush() alla fine se il plugin ce l'ha.
 */
export async function testTransformer(
  plugin: TransformerPlugin | Transformer,
  testCase: TransformerCase = {},
): Promise<TransformerOutcome> {
  const impl: Transformer = "impl" in plugin ? plugin.impl : plugin;
  const ctx = testCase.ctx ?? mockCtx();
  const batches =
    testCase.batches ?? [batchOf(testCase.rows ?? [], { runId: ctx.runId })];

  const outRows: Row[] = [];
  const failed: Failed[] = [];
  const outBatches: Batch[] = [];

  for (const batch of batches) {
    const result = await impl.transform(batch, testCase.config ?? {}, ctx);
    outRows.push(...result.batch.rows);
    failed.push(...result.failed);
    outBatches.push(result.batch);
  }

  if (testCase.flush !== false && impl.flush) {
    const result = await impl.flush(ctx);
    outRows.push(...result.batch.rows);
    failed.push(...result.failed);
    outBatches.push(result.batch);
  }

  return { rows: outRows, failed, batches: outBatches, ctx };
}
