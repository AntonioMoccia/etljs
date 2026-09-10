import type { Logger } from "@etl-js/contracts";

/**
 * Log strutturato su stderr, una riga JSON per evento: stdout resta pulito
 * per il risultato del run, cosi' la CLI si puo' mettere in pipe.
 */
export function jsonLogger(level: "debug" | "info" | "warn" | "error", fields: Record<string, unknown> = {}): Logger {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const write = (severity: keyof typeof order, message: string, extra?: Record<string, unknown>): void => {
    if (order[severity] < order[level]) return;
    process.stderr.write(
      `${JSON.stringify({ severity, message, ...fields, ...extra })}\n`,
    );
  };
  return {
    debug: (message, extra) => write("debug", message, extra),
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra),
    child: (childFields) => jsonLogger(level, { ...fields, ...childFields }),
  };
}
