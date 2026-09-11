/**
 * Cache legata a un run, per i plugin che ricordano qualcosa fra un lotto e
 * l'altro (le chiavi gia' cercate, i valori gia' visti).
 *
 * Il punto delicato non e' la cache: e' liberarla. `flush()` la libera a fine
 * run, ma un run che finisce male non chiama flush, quindi si tengono in vita
 * al massimo `maxRuns` run e si sfratta il piu' vecchio. Senza questo, un
 * processo che gira per settimane accumula una cache per ogni import fatto.
 */
export interface RunCache<T> {
  /** La memoria di questo run, creandola se serve. */
  for(runId: string): T;
  /** Libera la memoria di un run finito. */
  release(runId: string): void;
  /** Quanti run sono attualmente in memoria: serve solo ai test. */
  readonly size: number;
}

export function createRunCache<T>(create: () => T, maxRuns = 8): RunCache<T> {
  const perRun = new Map<string, T>();
  return {
    for(runId: string): T {
      const existing = perRun.get(runId);
      if (existing !== undefined) return existing;
      const created = create();
      perRun.set(runId, created);
      while (perRun.size > maxRuns) {
        const oldest = perRun.keys().next();
        if (oldest.done) break;
        perRun.delete(oldest.value);
      }
      return created;
    },
    release(runId: string): void {
      perRun.delete(runId);
    },
    get size(): number {
      return perRun.size;
    },
  };
}
