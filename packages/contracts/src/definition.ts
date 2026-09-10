import type { Failed } from "./rows.js";

/** Riferimento a un plugin piu' la sua config: e' un dato JSON, non codice (I1). */
export interface StepRef {
  type: string;
  config: unknown;
}

export interface Policy {
  /**
   * Frazione massima di righe scartate tollerata (0..1). Superata la soglia,
   * il run viene annullato e la destinazione riceve rollback.
   */
  maxFailedRatio?: number;
  /** Se true il run produce l'elenco degli scarti con il motivo. */
  rejectFile?: boolean;
}

/**
 * La descrizione completa di un'importazione: un cliente = un file di questi (I8).
 * Deve essere interamente serializzabile in JSON, perche' una GUI dovra' produrla.
 */
export interface Definition {
  client: string;
  source: StepRef;
  transform: StepRef[];
  destination: StepRef;
  policy?: Policy;
  /** Istantanea nome->versione dei plugin usati, per riprodurre un run passato. */
  manifestSnapshot?: Record<string, string>;
}

export interface RunResult {
  runId: string;
  /** Righe lette dalla sorgente. */
  read: number;
  /** Righe effettivamente scritte in destinazione. */
  written: number;
  /** Righe scartate o segnalate. */
  failed: number;
  /** Dettaglio degli scarti, se policy.rejectFile e' attiva. */
  rejects?: Failed[];
  aborted: boolean;
  durationMs: number;
}
