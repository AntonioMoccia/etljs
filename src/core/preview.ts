import type { Definition, Failed, Row } from "../contracts/index.js";
import { run, type RunOptions } from "./pipeline.js";
import type { HostCtx } from "./context.js";

export interface PreviewResult {
  /** Le righe come arriverebbero alla destinazione, gia' trasformate. */
  rows: Row[];
  /** Gli scarti prodotti strada facendo, col motivo. */
  failed: Failed[];
  /** Righe lette per ottenere questo campione. */
  read: number;
}

/**
 * Esegue la pipeline a vuoto sulle prime `n` righe della SORGENTE e restituisce
 * cio' che sarebbe stato scritto piu' cio' che sarebbe stato scartato. Se un
 * filtro elimina meta' delle righe, `rows` ne conterra' meno di `n`: la domanda
 * a cui risponde e' "che cosa succede alle prime n righe di questo file?".
 *
 * Il reader legge a lotti, quindi `read` puo' superare `n` di poco: ci si ferma
 * al primo lotto che raggiunge la soglia.
 *
 * Non e' un ramo speciale del motore: e' `run()` in dry-run con un limite e
 * due handler di eventi (I2).
 */
export async function preview(
  definition: Definition,
  n: number,
  ctx: HostCtx,
  options: Omit<RunOptions, "dryRun" | "limitRows" | "events"> = {},
): Promise<PreviewResult> {
  const rows: Row[] = [];
  const failed: Failed[] = [];

  const result = await run(definition, ctx, {
    ...options,
    dryRun: true,
    limitRows: n,
    events: {
      onBatch: (event) => {
        for (const row of event.batch.rows) {
          if (rows.length < n) rows.push(row);
        }
      },
      onRecordFailed: (event) => {
        failed.push(event.failed);
      },
    },
  });

  return { rows, failed, read: result.read };
}
