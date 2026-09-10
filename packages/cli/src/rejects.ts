import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import type { Failed } from "@etl-js/contracts";

const COLUMNS = ["run_id", "file", "riga", "severita", "codice", "motivo", "riga_originale"];

/** Quoting CSV secondo RFC 4180: si quota sempre, e' piu' semplice e sempre corretto. */
function csvField(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * File di scarto scritto man mano che gli scarti arrivano dagli eventi, non
 * accumulato in memoria: un file interamente sbagliato non deve far esplodere
 * il processo.
 */
export class RejectFile {
  readonly #stream: WriteStream;
  #count = 0;

  constructor(path: string) {
    this.#stream = createWriteStream(path, { encoding: "utf8" });
    this.#stream.write(`${COLUMNS.join(";")}\n`);
  }

  add(failed: Failed): void {
    this.#count += 1;
    this.#stream.write(
      [
        csvField(failed.runId),
        csvField(failed.source),
        csvField(failed.offset),
        csvField(failed.severity),
        csvField(failed.code),
        csvField(failed.reason),
        csvField(JSON.stringify(failed.row)),
      ].join(";") + "\n",
    );
  }

  get count(): number {
    return this.#count;
  }

  async close(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
    return this.#count;
  }
}
