import { describe, expect, test } from "vitest";
import type { RunResult } from "etl-js/contracts";
import { Registry, run, withRetry, type RunEvents } from "etl-js";
import { EtlError } from "etl-js/contracts";
import { definition, hostCtx, pickyTransformer, readerOf, writerOf } from "./fakes.js";

/**
 * Un host tipico: non vede il motore, vede solo gli eventi. Da quelli deve
 * poter disegnare una barra di avanzamento, salvare gli scarti e capire
 * com'e' finita.
 */
function osservatore() {
  const stato = {
    avviato: false,
    concluso: false,
    passi: [] as string[],
    letto: 0,
    scritto: 0,
    scartate: [] as { codice: string; passo: string; riga: number }[],
    esito: undefined as RunResult | undefined,
    errore: undefined as { code: string; retryable: boolean } | undefined,
  };

  const events: RunEvents = {
    onRunStart: (event) => {
      stato.avviato = true;
      stato.passi = event.steps;
    },
    onBatch: (event) => {
      stato.letto = event.read;
      stato.scritto = event.written;
    },
    onRecordFailed: (event) => {
      stato.scartate.push({
        codice: event.failed.code,
        passo: event.step,
        riga: event.failed.offset,
      });
    },
    onRunEnd: (event) => {
      stato.concluso = true;
      stato.esito = event.result;
      if (event.error) {
        stato.errore = { code: event.error.code as string, retryable: event.error.retryable };
      }
    },
  };

  return { stato, events };
}

describe("eventi del run", () => {
  test("dagli eventi si ricostruisce l'avanzamento e il conto finale", async () => {
    const { stato, events } = osservatore();
    const registry = new Registry()
      .register(readerOf([[{ ok: true }, { ok: false }], [{ ok: true }]]))
      .register(pickyTransformer())
      .register(writerOf({ rows: [], outcome: [] }));

    const result = await run(
      definition({ transform: [{ type: "picky", config: {} }] }),
      hostCtx(),
      { registry, events },
    );

    expect(stato.avviato).toBe(true);
    expect(stato.concluso).toBe(true);
    expect(stato.passi).toEqual(["fake-reader", "picky", "fake-writer"]);
    // I totali visti dagli eventi coincidono con quelli del risultato.
    expect(stato.letto).toBe(result.read);
    expect(stato.scritto).toBe(result.written);
    expect(stato.scartate).toHaveLength(result.failed);
    expect(stato.esito).toEqual(result);
  });

  test("anche quando il run fallisce, l'host riceve la chiusura e l'errore classificato", async () => {
    const { stato, events } = osservatore();
    const registry = new Registry()
      .register(readerOf([[{ ok: true }]]))
      .register(writerOf({ rows: [], outcome: [], failAt: 1 }));

    await expect(run(definition(), hostCtx(), { registry, events })).rejects.toThrow();

    expect(stato.concluso).toBe(true);
    expect(stato.errore).toBeDefined();
    expect(stato.esito?.aborted).toBe(true);
  });

  test("l'errore dice in quale passo e' successo, non solo che e' successo", async () => {
    const registry = new Registry()
      .register(readerOf([[{ ok: true }]]))
      .register(writerOf({ rows: [], outcome: [], failAt: 1 }));

    await expect(run(definition(), hostCtx(), { registry })).rejects.toMatchObject({
      code: "WRITE_FAILED",
      context: { step: "fake-writer" },
    });
  });

  test("un errore del reader viene attribuito al reader", async () => {
    const rotto = readerOf([]);
    const registry = new Registry()
      .register({
        ...rotto,
        impl: {
          // eslint-disable-next-line require-yield
          async *read() {
            throw new Error("il file e' sparito");
          },
        },
      })
      .register(writerOf({ rows: [], outcome: [] }));

    await expect(run(definition(), hostCtx(), { registry })).rejects.toMatchObject({
      code: "READ_FAILED",
      context: { step: "fake-reader" },
    });
  });

  test("un errore di un transformer porta il nome del transformer", async () => {
    const picky = pickyTransformer();
    const registry = new Registry()
      .register(readerOf([[{ ok: true }]]))
      .register({
        ...picky,
        impl: {
          async transform() {
            throw new Error("conversione impossibile");
          },
        },
      })
      .register(writerOf({ rows: [], outcome: [] }));

    await expect(
      run(definition({ transform: [{ type: "picky", config: {} }] }), hostCtx(), { registry }),
    ).rejects.toMatchObject({ code: "TRANSFORM_FAILED", context: { step: "picky" } });
  });

  test("un handler difettoso dell'host non annulla l'importazione", async () => {
    const registry = new Registry()
      .register(readerOf([[{ ok: true }]]))
      .register(writerOf({ rows: [], outcome: [] }));

    const result = await run(definition(), hostCtx(), {
      registry,
      events: {
        onBatch: () => {
          throw new Error("bug nella barra di avanzamento dell'host");
        },
      },
    });

    expect(result.written).toBe(1);
  });
});

describe("withRetry", () => {
  test("ritenta solo cio' che e' dichiarato ritentabile", async () => {
    let tentativi = 0;
    const attese: number[] = [];

    const valore = await withRetry(
      async () => {
        tentativi += 1;
        if (tentativi < 3) {
          throw new EtlError("deadlock", { code: "DB_ERROR", retryable: true });
        }
        return "fatto";
      },
      { attempts: 5, baseMs: 100, sleep: async (ms) => void attese.push(ms), random: () => 1 },
    );

    expect(valore).toBe("fatto");
    expect(tentativi).toBe(3);
    // Attesa esponenziale: 100, 200. Con random()=1 il jitter e' al massimo.
    expect(attese).toEqual([100, 200]);
  });

  test("il jitter distribuisce le attese invece di sincronizzare i worker", async () => {
    const attese: number[] = [];
    await withRetry(
      async () => {
        if (attese.length < 1) {
          throw new EtlError("contesa", { code: "DB_ERROR", retryable: true });
        }
        return 1;
      },
      { attempts: 3, baseMs: 100, sleep: async (ms) => void attese.push(ms), random: () => 0.25 },
    );
    expect(attese).toEqual([25]);
  });

  test("un errore non ritentabile esce subito", async () => {
    let tentativi = 0;
    await expect(
      withRetry(
        async () => {
          tentativi += 1;
          throw new EtlError("colonna assente", { code: "DB_ERROR", retryable: false });
        },
        { attempts: 5, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ code: "DB_ERROR" });
    expect(tentativi).toBe(1);
  });

  test("esauriti i tentativi rilancia l'ultimo errore", async () => {
    let tentativi = 0;
    await expect(
      withRetry(
        async () => {
          tentativi += 1;
          throw new EtlError("ancora contesa", { code: "DB_ERROR", retryable: true });
        },
        { attempts: 3, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ code: "DB_ERROR", context: { attempts: 3 } });
    expect(tentativi).toBe(3);
  });

  test("un run annullato non viene ritentato", async () => {
    const controller = new AbortController();
    controller.abort();
    let tentativi = 0;
    await expect(
      withRetry(
        async () => {
          tentativi += 1;
          throw new EtlError("contesa", { code: "DB_ERROR", retryable: true });
        },
        { attempts: 5, sleep: async () => {}, signal: controller.signal },
      ),
    ).rejects.toBeDefined();
    expect(tentativi).toBe(1);
  });
});
