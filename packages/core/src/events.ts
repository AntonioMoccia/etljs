import type { Batch, Failed, RunResult } from "@etl-js/contracts";
import type { IngestError } from "@etl-js/contracts";

export interface RunStartEvent {
  runId: string;
  client: string;
  /** Nomi dei plugin risolti, nell'ordine di esecuzione. */
  steps: string[];
  dryRun: boolean;
}

export interface BatchEvent {
  runId: string;
  /** Il lotto dopo tutte le trasformazioni, cosi' come e' stato scritto. */
  batch: Batch;
  /** Totali progressivi del run. */
  read: number;
  written: number;
  failed: number;
}

export interface RecordFailedEvent {
  runId: string;
  /** Plugin che ha scartato la riga. */
  step: string;
  failed: Failed;
}

export interface RunEndEvent {
  runId: string;
  result: RunResult;
  error?: IngestError;
}

/**
 * Osservabilita' del run. Sono callback sincrone e best-effort: l'host le usa
 * per avanzamento e log, il motore non ne aspetta l'esito e non fallisce se
 * una di esse lancia.
 */
export interface RunEvents {
  onRunStart?(event: RunStartEvent): void;
  onBatch?(event: BatchEvent): void;
  onRecordFailed?(event: RecordFailedEvent): void;
  onRunEnd?(event: RunEndEvent): void;
}

/** Invoca un handler isolando l'host dai propri stessi errori di callback. */
export function emit<K extends keyof RunEvents>(
  events: RunEvents | undefined,
  name: K,
  event: Parameters<NonNullable<RunEvents[K]>>[0],
): void {
  const handler = events?.[name] as ((e: unknown) => void) | undefined;
  if (!handler) return;
  try {
    handler(event);
  } catch {
    // Un handler difettoso non deve poter annullare un'importazione.
  }
}
