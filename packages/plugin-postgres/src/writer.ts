import {
  ErrorCodes,
  EtlError,
  escapeIdentifier,
  escapeQualifiedName,
  type Batch,
  type Ctx,
  type WriteSession,
  type WriteTransaction,
  type Writer,
  type WriterCtx,
} from "@etl-js/contracts";
import { parsePostgresConfig, type PostgresConfig } from "./config.js";

/** Codici propri di questo plugin, in aggiunta a quelli comuni. */
export const PostgresErrorCodes = {
  /** Una riga porta una colonna che la tabella di atterraggio non ha. */
  COLUMN_MISMATCH: "COLUMN_MISMATCH",
  /** La chiave di sostituzione non e' fra le colonne che stiamo scrivendo. */
  REPLACE_KEY_MISSING: "REPLACE_KEY_MISSING",
} as const;

/** Le tabelle di appoggio sono temporanee e vivono quanto la transazione. */
let stagingCounter = 0;

/**
 * Il writer riceve dal core un contesto con `dbWrite`: non apre connessioni e
 * non vede credenziali (I6). Se l'host non l'ha fornito, e' un errore d'uso.
 */
function requireWriterCtx(ctx: Ctx): WriterCtx {
  const candidate = ctx as Partial<WriterCtx>;
  if (typeof candidate.dbWrite !== "function") {
    throw new EtlError(
      "Il writer postgres richiede un contesto con dbWrite fornito dal core",
      { code: ErrorCodes.INVALID_USAGE },
    );
  }
  return ctx as WriterCtx;
}

class PostgresSession implements WriteSession {
  #columns: string[] | undefined;
  #staging: string | undefined;
  #rowsStaged = 0;
  #closed = false;

  constructor(
    private readonly config: PostgresConfig,
    private readonly tx: WriteTransaction,
  ) {
    this.#columns = config.columns ? [...config.columns] : undefined;
  }

  get #needsStaging(): boolean {
    return this.config.strategy !== "append";
  }

  /**
   * L'appoggio ha la stessa forma della destinazione (`LIKE`), cosi' il COPY
   * interpreta date e numeri con i tipi giusti, e sparisce da solo al commit.
   */
  async #ensureStaging(): Promise<string> {
    if (this.#staging) return this.#staging;
    stagingCounter += 1;
    const name = `etl_staging_${stagingCounter}`;
    await this.tx.exec(
      `CREATE TEMP TABLE ${escapeIdentifier(name)} (LIKE ${escapeQualifiedName(this.config.table)}) ON COMMIT DROP`,
    );
    this.#staging = name;
    return name;
  }

  /** Le colonne si fissano al primo lotto: una landing table ha una forma sola. */
  #resolveColumns(batch: Batch): string[] {
    const columns = (this.#columns ??= Object.keys(batch.rows[0] ?? {}));
    const known = new Set(columns);

    for (const [index, row] of batch.rows.entries()) {
      for (const key of Object.keys(row)) {
        if (known.has(key)) continue;
        throw new EtlError(
          `La riga porta la colonna "${key}", assente da ${this.config.table}`,
          {
            code: PostgresErrorCodes.COLUMN_MISMATCH,
            context: {
              table: this.config.table,
              column: key,
              expected: columns,
              offset: batch.meta.offset + index,
            },
          },
        );
      }
    }

    const keys =
      this.config.strategy === "replace-by" ? this.config.replaceKey : this.config.conflictKey;
    const missing = (keys ?? []).filter((key) => !known.has(key));
    if (missing.length > 0) {
      throw new EtlError(
        `La chiave ${missing.join(", ")} non e' fra le colonne scritte: la sostituzione colpirebbe righe sbagliate`,
        {
          code: PostgresErrorCodes.REPLACE_KEY_MISSING,
          context: { table: this.config.table, missing, columns },
        },
      );
    }

    return columns;
  }

  async write(batch: Batch): Promise<void> {
    if (this.#closed) {
      throw new EtlError("Sessione di scrittura gia' chiusa", {
        code: ErrorCodes.INVALID_USAGE,
        context: { table: this.config.table },
      });
    }
    if (batch.rows.length === 0) return;

    const columns = this.#resolveColumns(batch);
    const target = this.#needsStaging ? await this.#ensureStaging() : this.config.table;

    const values = batch.rows.map((row) =>
      columns.map((column) => (column in row ? (row[column] ?? null) : null)),
    );
    await this.tx.bulkLoad(target, columns, toAsyncIterable(values));
    this.#rowsStaged += values.length;
  }

  /** Dall'appoggio alla destinazione, dentro la stessa transazione del caricamento. */
  async #promote(): Promise<void> {
    const staging = this.#staging;
    const columns = this.#columns;
    if (!staging || !columns || this.#rowsStaged === 0) return;

    const target = escapeQualifiedName(this.config.table);
    const source = escapeIdentifier(staging);
    const columnList = columns.map((column) => escapeIdentifier(column)).join(", ");

    if (this.config.strategy === "replace-by") {
      const keys = this.config.replaceKey ?? [];
      const join = keys
        .map((key) => `t.${escapeIdentifier(key)} = s.${escapeIdentifier(key)}`)
        .join(" AND ");
      const keyList = keys.map((key) => escapeIdentifier(key)).join(", ");
      // Si cancellano solo le chiavi presenti in questo file: il flusso ha
      // rimandato il piano di quei record, non di tutti.
      await this.tx.exec(
        `DELETE FROM ${target} AS t USING (SELECT DISTINCT ${keyList} FROM ${source}) AS s WHERE ${join}`,
      );
      await this.tx.exec(
        `INSERT INTO ${target} (${columnList}) SELECT ${columnList} FROM ${source}`,
      );
      return;
    }

    const keys = this.config.conflictKey ?? [];
    const keySet = new Set(keys);
    const updates = columns
      .filter((column) => !keySet.has(column))
      .map((column) => `${escapeIdentifier(column)} = EXCLUDED.${escapeIdentifier(column)}`);
    const conflict =
      updates.length > 0
        ? `ON CONFLICT (${keys.map((key) => escapeIdentifier(key)).join(", ")}) DO UPDATE SET ${updates.join(", ")}`
        : "ON CONFLICT DO NOTHING";
    await this.tx.exec(
      `INSERT INTO ${target} (${columnList}) SELECT ${columnList} FROM ${source} ${conflict}`,
    );
  }

  async close(commit: boolean): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!commit) {
      // Niente promozione: il rollback butta via appoggio e caricamento insieme.
      await this.tx.rollback();
      return;
    }
    await this.#promote();
    await this.tx.commit();
  }
}

async function* toAsyncIterable(rows: readonly unknown[][]): AsyncGenerator<readonly unknown[]> {
  for (const row of rows) yield row;
}

export const postgresWriter: Writer = {
  async open(rawConfig: unknown, ctx: Ctx): Promise<WriteSession> {
    const config = parsePostgresConfig(rawConfig);
    const writerContext = requireWriterCtx(ctx);
    const tx = await writerContext.dbWrite(config.db);

    if (config.truncate) {
      await tx.exec(`TRUNCATE ${escapeQualifiedName(config.table)}`);
    }

    return new PostgresSession(config, tx);
  },
};
