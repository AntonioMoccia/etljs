import type { Row } from "./rows.js";

/**
 * Un flusso di byte, comunque prodotto. E' volutamente il tipo piu' povero
 * possibile: un `fs.ReadStream` di Node lo soddisfa cosi' com'e', ma anche un
 * iteratore su un oggetto di object storage o uno stream web. Cosi' il
 * contratto non si lega al filesystem ne' a Node (I6), e `contracts` resta a
 * zero dipendenze, `@types/node` compreso (I9).
 */
export type ByteStream = AsyncIterable<Uint8Array>;

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Log strutturato: niente console.log nei plugin, l'host decide dove finisce. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Logger figlio con campi ereditati (es. { plugin: "lookup" }). */
  child(fields: Record<string, unknown>): Logger;
}

/**
 * Accesso in sola lettura a un database, gia' connesso dal core (I6).
 * L'unica API e' batch e parametrizzata: non esiste un metodo "per riga" (I5, I7).
 */
export interface ReadOnlyDb {
  query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

/**
 * Transazione in scrittura, aperta dal core e consegnata al writer.
 * Il writer non conosce credenziali ne' pool: riceve una transazione gia'
 * iniziata e decide solo se chiuderla con commit o rollback.
 */
export interface WriteTransaction extends ReadOnlyDb {
  /** DDL/DML parametrizzato; restituisce il numero di righe toccate. */
  exec(sql: string, params?: readonly unknown[]): Promise<number>;
  /**
   * Caricamento massivo di righe posizionali nelle colonne indicate.
   * Il driver sceglie come farlo (COPY su Postgres); il plugin non scrive SQL
   * di caricamento e quindi non puo' sbagliarne l'escaping.
   */
  bulkLoad(
    table: string,
    columns: readonly string[],
    rows: AsyncIterable<readonly unknown[]>,
  ): Promise<number>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Contesto di esecuzione consegnato a ogni plugin dal core. */
export interface Ctx {
  /**
   * Identificativo del run in corso. Sta qui e non nella config perche' e' il
   * reader a costruire i Batch, e ogni Batch deve poter dichiarare da quale
   * run proviene (`Batch.meta.runId`).
   */
  runId: string;
  /** Connessione in sola lettura al database logico `name` (I4, I6). */
  db(name: string): ReadOnlyDb;
  /**
   * Apre la sorgente indicata da `ref` e ne restituisce i byte.
   *
   * E' il core (o l'host) a decidere che cosa sia un `ref`: un path su disco in
   * sviluppo, una chiave su object storage in produzione. Il reader dice
   * **quale** sorgente vuole, mai **come** aprirla, e non importa mai `node:fs` (I6).
   */
  openInput(ref: string): Promise<ByteStream>;
  /** Risolve un riferimento a un segreto; il plugin non vede mai la credenziale grezza. */
  secretRef(ref: string): string;
  log: Logger;
  /** Annullamento cooperativo del run. */
  signal: AbortSignal;
}

/**
 * Contesto arricchito che il core passa ESCLUSIVAMENTE al writer della
 * destinazione. Resta un `Ctx` a tutti gli effetti: reader e transformer
 * continuano a vedere solo la sola lettura (I4).
 */
export interface WriterCtx extends Ctx {
  /** Apre (BEGIN) una transazione sul database logico `name`. */
  dbWrite(name: string): Promise<WriteTransaction>;
}
