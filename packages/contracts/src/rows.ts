/** Una riga e' un sacchetto di valori non tipizzati: il tipo lo danno i transformer. */
export type Row = Record<string, unknown>;

/** Provenienza di un lotto: serve a ricostruire da dove viene ogni riga (I5 su volumi, fase 5 sugli scarti). */
export interface BatchMeta {
  /** Identificativo del run, propagato a scarti ed eventi. */
  runId: string;
  /** Sorgente leggibile: nome file, tabella, endpoint. */
  source: string;
  /** Indice della prima riga del lotto rispetto all'inizio della sorgente (0-based). */
  offset: number;
}

/** L'unita' di lavoro di tutta la pipeline: si ragiona sempre a lotti, mai a riga singola (I3, I5). */
export interface Batch {
  rows: Row[];
  meta: BatchMeta;
}

/** `reject` = la riga non entra; `warn` = entra ma viene segnalata. */
export type Severity = "reject" | "warn";

/** Una riga scartata, con il motivo in chiaro per il CSV di scarto. */
export interface Failed {
  row: Row;
  /** Messaggio leggibile da un operatore, non da un programma. */
  reason: string;
  /** Codice stabile, questo si' pensato per i programmi (es. "LOOKUP_MISSING"). */
  code: string;
  severity: Severity;
  /** Offset assoluto della riga nella sorgente. */
  offset: number;
  /**
   * Provenienza, compilata dal motore: senza di essa un file di scarto non
   * dice a quale importazione e a quale file appartenga una riga.
   */
  runId?: string;
  source?: string;
}

/** Cio' che un transformer restituisce: il lotto sopravvissuto piu' gli scarti. */
export interface TransformResult {
  batch: Batch;
  failed: Failed[];
}
