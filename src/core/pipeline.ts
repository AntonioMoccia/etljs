import {
  ErrorCodes,
  EtlError,
  type Batch,
  type Definition,
  type Failed,
  type Plugin,
  type PluginKind,
  type PluginOfKind,
  type RunResult,
  type Transformer,
  type WriteSession,
} from "../contracts/index.js";
import { randomUUID } from "node:crypto";

/** Quanti scarti tenere in memoria se la Definition li chiede. */
const DEFAULT_MAX_REJECTS_IN_RESULT = 1_000;
import { defaultRegistry, type Registry } from "./registry.js";
import { emit, type RunEvents } from "./events.js";
import { assertValid } from "./validate.js";
import { nullLogger, readOnlyCtx, writerCtx, type HostCtx } from "./context.js";

/**
 * Come si procura un plugin dato il suo nome. La Registry ne e' l'implementazione
 * sincrona; il loader dinamico della fase 2 ne e' un'altra. Il core non sa
 * quali plugin esistano: sa solo chiedere (I2).
 */
export type PluginResolver = (name: string) => Promise<Plugin>;

export interface RunOptions {
  /** Plugin gia' disponibili. Default: il registry di processo. */
  registry?: Registry;
  /** Risolutore per i nomi assenti dal registry (loader dinamico). */
  resolve?: PluginResolver;
  events?: RunEvents;
  /** Identificativo del run; se assente ne viene generato uno. */
  runId?: string;
  /** Esegue tutto tranne la scrittura: la destinazione non viene nemmeno aperta. */
  dryRun?: boolean;
  /** Ferma la lettura dopo N righe (usato da preview). */
  limitRows?: number;
  /**
   * Quanti scarti tenere in `RunResult.rejects`. Serve a non far esplodere la
   * memoria su un file interamente sbagliato: per averli tutti si ascolta
   * l'evento onRecordFailed, che non ha limiti.
   */
  maxRejectsInResult?: number;
}

/** Uno stadio risolto: il plugin, la sua config e il nome con cui e' stato chiesto. */
interface Step<T> {
  name: string;
  config: unknown;
  impl: T;
}

/**
 * Esegue un'importazione descritta da una Definition.
 *
 * Questa funzione non nomina alcun plugin e non contiene alcun ramo dipendente
 * dal tipo di uno stadio: aggiungere un transformer NON deve mai richiedere di
 * toccare questo file (I2).
 */
export async function run(
  definition: Definition,
  ctx: HostCtx,
  options: RunOptions = {},
): Promise<RunResult> {
  const startedAt = Date.now();
  const runId = options.runId ?? ctx.runId ?? randomUUID();
  const registry = options.registry ?? defaultRegistry;
  const dryRun = options.dryRun ?? false;
  const events = options.events;
  const baseLog = (ctx.log ?? nullLogger()).child({ runId, client: definition.client });

  const resolve = async <K extends PluginKind>(
    name: string,
    kind: K,
  ): Promise<PluginOfKind<K>> => {
    if (!registry.has(name) && options.resolve) {
      registry.register(await options.resolve(name));
    }
    return registry.require(name, kind);
  };

  const reader = await resolve(definition.source.type, "reader");
  const transformSteps: Step<Transformer>[] = [];
  for (const step of definition.transform ?? []) {
    const plugin = await resolve(step.type, "transformer");
    transformSteps.push({ name: step.type, config: step.config, impl: plugin.impl });
  }
  const writer = await resolve(definition.destination.type, "writer");

  // Tutti gli stadi sono risolti: ora la Definition si puo' controllare per
  // intero e fallire subito, prima di leggere una riga o aprire una transazione.
  assertValid(definition, { registry });

  const counters = { read: 0, written: 0, failed: 0 };
  const rejects: Failed[] = [];
  const keepRejects = definition.policy?.rejectFile === true;
  let aborted = false;
  let session: WriteSession | undefined;

  const maxRejects = options.maxRejectsInResult ?? DEFAULT_MAX_REJECTS_IN_RESULT;
  let rejectsTruncated = false;

  /** Attribuisce un errore al passo che l'ha prodotto: senza questo, un host
   * sa solo che "il run e' fallito", che non aiuta nessuno. */
  const classify = (error: unknown, code: string, step: string): EtlError =>
    EtlError.is(error)
      ? error.withContext({ step, runId })
      : EtlError.wrap(error, { code, context: { step, runId, client: definition.client } });

  const collect = (step: string, source: string, failures: readonly Failed[]): void => {
    for (const failure of failures) {
      counters.failed += 1;
      // La provenienza la conosce il motore, non il plugin che ha scartato.
      const traced: Failed = { ...failure, runId, source: failure.source ?? source };
      if (keepRejects) {
        if (rejects.length < maxRejects) rejects.push(traced);
        else if (!rejectsTruncated) {
          rejectsTruncated = true;
          baseLog.warn(
            `Piu' di ${maxRejects} scarti: RunResult.rejects e' troncato, usa l'evento onRecordFailed per averli tutti`,
            { maxRejects },
          );
        }
      }
      emit(events, "onRecordFailed", { runId, step, failed: traced });
    }
  };

  /** Fa passare un lotto attraverso i transformer da `from` in poi. */
  const applyTransformers = async (input: Batch, from: number): Promise<Batch> => {
    let current = input;
    for (let i = from; i < transformSteps.length; i += 1) {
      const step = transformSteps[i];
      if (!step) continue;
      if (current.rows.length === 0) break;
      const stepCtx = readOnlyCtx(ctx, baseLog.child({ step: step.name }), runId);
      let result;
      try {
        result = await step.impl.transform(current, step.config, stepCtx);
      } catch (error) {
        throw classify(error, ErrorCodes.TRANSFORM_FAILED, step.name);
      }
      collect(step.name, current.meta.source, result.failed);
      current = result.batch;
    }
    return current;
  };

  const deliver = async (batch: Batch): Promise<void> => {
    if (batch.rows.length > 0 && session) {
      try {
        await session.write(batch);
      } catch (error) {
        throw classify(error, ErrorCodes.WRITE_FAILED, definition.destination.type);
      }
    }
    if (batch.rows.length > 0) counters.written += batch.rows.length;
    emit(events, "onBatch", {
      runId,
      batch,
      read: counters.read,
      written: counters.written,
      failed: counters.failed,
    });
  };

  emit(events, "onRunStart", {
    runId,
    client: definition.client,
    steps: [
      definition.source.type,
      ...transformSteps.map((s) => s.name),
      definition.destination.type,
    ],
    dryRun,
  });

  try {
    if (!dryRun) {
      try {
        session = await writer.impl.open(
          definition.destination.config,
          writerCtx(ctx, baseLog.child({ step: definition.destination.type }), runId),
        );
      } catch (error) {
        throw classify(error, ErrorCodes.WRITE_FAILED, definition.destination.type);
      }
    }

    const readCtx = readOnlyCtx(ctx, baseLog.child({ step: definition.source.type }), runId);

    // Il reader viene avvolto perche' un suo errore non venga confuso con un
    // errore di cio' che sta a valle.
    const source = (async function* readSafely(): AsyncGenerator<Batch> {
      try {
        for await (const batch of reader.impl.read(definition.source.config, readCtx)) {
          yield batch;
        }
      } catch (error) {
        throw classify(error, ErrorCodes.READ_FAILED, definition.source.type);
      }
    })();

    for await (const batch of source) {
      if (ctx.signal.aborted) {
        aborted = true;
        break;
      }
      counters.read += batch.rows.length;
      const transformed = await applyTransformers(batch, 0);
      // Si controlla la soglia prima di scrivere: inutile mandare al database
      // un lotto che stiamo per annullare.
      assertWithinFailureBudget();
      await deliver(transformed);
      if (options.limitRows !== undefined && counters.read >= options.limitRows) break;
    }

    // I transformer con stato (dedup, aggregazioni) emettono la coda; cio' che
    // esce dal transformer i deve ancora attraversare i transformer successivi.
    if (!aborted) {
      for (let i = 0; i < transformSteps.length; i += 1) {
        const step = transformSteps[i];
        if (!step?.impl.flush) continue;
        const stepCtx = readOnlyCtx(ctx, baseLog.child({ step: step.name }), runId);
        const flushed = await step.impl.flush(stepCtx);
        collect(step.name, flushed.batch.meta.source, flushed.failed);
        const transformed = await applyTransformers(flushed.batch, i + 1);
        assertWithinFailureBudget();
        await deliver(transformed);
      }
    }

    assertWithinFailureBudget();
    if (session) {
      try {
        await session.close(!aborted);
      } catch (error) {
        throw classify(error, ErrorCodes.WRITE_FAILED, definition.destination.type);
      }
    }
  } catch (error) {
    const failure = EtlError.wrap(error, {
      code: ErrorCodes.INVALID_USAGE,
      context: { runId, client: definition.client },
    });

    if (session) {
      try {
        await session.close(false);
      } catch (rollbackError) {
        baseLog.error("Rollback della destinazione fallito", {
          error: String(rollbackError),
        });
      }
    }
    const result = buildResult();
    result.aborted = true;
    emit(events, "onRunEnd", { runId, result, error: failure });
    throw failure;
  }

  const result = buildResult();
  emit(events, "onRunEnd", { runId, result });
  return result;

  /**
   * La quota di righe scartate tollerata dalla Definition. Non c'e' un numero
   * minimo di righe prima del controllo: chi scrive 0.2 intende 0.2 anche su
   * un file di tre righe.
   */
  function assertWithinFailureBudget(): void {
    const limit = definition.policy?.maxFailedRatio;
    if (limit === undefined || counters.read === 0) return;
    const ratio = counters.failed / counters.read;
    if (ratio <= limit) return;
    throw new EtlError(
      `Troppe righe scartate: ${counters.failed} su ${counters.read} (${(ratio * 100).toFixed(1)}%), il massimo ammesso e' ${(limit * 100).toFixed(1)}%`,
      {
        code: ErrorCodes.TOO_MANY_FAILED,
        context: {
          runId,
          client: definition.client,
          failed: counters.failed,
          read: counters.read,
          ratio,
          maxFailedRatio: limit,
        },
      },
    );
  }

  function buildResult(): RunResult {
    const value: RunResult = {
      runId,
      read: counters.read,
      written: counters.written,
      failed: counters.failed,
      aborted,
      durationMs: Date.now() - startedAt,
    };
    if (keepRejects) value.rejects = rejects;
    return value;
  }
}
