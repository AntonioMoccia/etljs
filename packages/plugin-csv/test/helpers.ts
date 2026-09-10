import type { Ctx, Logger } from "@etl-js/contracts";

/** Log che ricorda cosa gli e' stato scritto: serve a verificare gli avvisi. */
export function recordingLogger(lines: string[] = []): Logger & { lines: string[] } {
  const make = (prefix: string): Logger => ({
    debug: (m) => lines.push(`debug ${prefix}${m}`),
    info: (m) => lines.push(`info ${prefix}${m}`),
    warn: (m) => lines.push(`warn ${prefix}${m}`),
    error: (m) => lines.push(`error ${prefix}${m}`),
    child: () => make(prefix),
  });
  return Object.assign(make(""), { lines });
}

/**
 * Ctx minimo per i test di un plugin che non tocca il database.
 * La versione completa arrivera' in @etl-js/testing (fase 8).
 */
export function fakeCtx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    runId: "run-test",
    db: () => {
      throw new Error("questo test non deve toccare il database");
    },
    secretRef: (ref) => `secret:${ref}`,
    log: recordingLogger(),
    signal: new AbortController().signal,
    ...overrides,
  };
}
