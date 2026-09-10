import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import {
  PROTOCOL_VERSION,
  type Batch,
  type Definition,
  type Logger,
  type Row,
  type WriterPlugin,
} from "@etl-js/contracts";
import { Registry, run } from "@etl-js/core";
import type { HostCtx } from "@etl-js/core";
import csv from "@etl-js/plugin-csv";
import cast from "@etl-js/plugin-cast";
import validate from "@etl-js/plugin-validate";
import fill from "@etl-js/plugin-default";

/**
 * Criterio della fase 5, provato dal file su disco fino alla destinazione:
 * un file poco sbagliato entra in parte, un file molto sbagliato non entra
 * affatto. Passa dal vero reader CSV e dai veri transformer; l'unica cosa
 * finta e' la destinazione, perche' qui non c'e' un Postgres.
 */
let dir = "";

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
};

function memoryWriter(sink: { rows: Row[]; outcome: string[] }): WriterPlugin {
  return {
    manifest: {
      name: "memoria",
      version: "1.0.0",
      kind: "writer",
      protocol: PROTOCOL_VERSION,
      configSchema: { type: "object", additionalProperties: true },
    },
    impl: {
      async open() {
        const staged: Row[] = [];
        sink.outcome.push("open");
        return {
          async write(batch: Batch) {
            staged.push(...batch.rows);
          },
          async close(commit: boolean) {
            sink.outcome.push(commit ? "commit" : "rollback");
            if (commit) sink.rows.push(...staged);
          },
        };
      },
    },
  };
}

/** CSV con `total` righe di cui `bad` hanno quantita' zero. */
async function fixture(name: string, total: number, bad: number): Promise<string> {
  const righe = ["Ordine;Quantita;Consegna"];
  for (let i = 0; i < total; i += 1) {
    righe.push(`ORD-${i};${i < bad ? "0" : "10"};0${(i % 9) + 1}/02/2026`);
  }
  const path = join(dir, name);
  await writeFile(path, `${righe.join("\n")}\n`, "utf8");
  return path;
}

function definitionFor(path: string, maxFailedRatio: number): Definition {
  return {
    client: "acme",
    source: { type: "csv", config: { path, delimiter: ";" } },
    transform: [
      {
        type: "cast",
        config: {
          Quantita: { number: { decimal: "," } },
          Consegna: { date: "dd/MM/yyyy" },
        },
      },
      { type: "validate", config: { rules: [{ field: "Quantita", min: 1, severity: "reject" }] } },
      {
        type: "default",
        config: {
          values: {
            run_id: { fromMeta: "runId", when: "always" },
            file_origine: { fromMeta: "source", when: "always" },
            riga_origine: { fromMeta: "offset", when: "always" },
          },
        },
      },
    ],
    destination: { type: "memoria", config: {} },
    policy: { maxFailedRatio, rejectFile: true },
  };
}

function setup(sink: { rows: Row[]; outcome: string[] }) {
  return new Registry()
    .register(csv)
    .register(cast)
    .register(validate)
    .register(fill)
    .register(memoryWriter(sink));
}

const ctx: HostCtx = {
  db: () => {
    throw new Error("questo import non usa il database");
  },
  secretRef: (ref) => ref,
  log: silent,
  signal: new AbortController().signal,
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "etl-scarto-"));
});

describe("import parziale e run annullato", () => {
  test("un file invalido al 10% entra in parte, con lo scarto motivato", async () => {
    const path = await fixture("dieci.csv", 20, 2);
    const sink = { rows: [] as Row[], outcome: [] as string[] };

    const result = await run(definitionFor(path, 0.2), ctx, {
      registry: setup(sink),
      runId: "run-10",
    });

    expect(result).toMatchObject({ read: 20, written: 18, failed: 2, aborted: false });
    expect(sink.outcome).toEqual(["open", "commit"]);
    expect(sink.rows).toHaveLength(18);

    expect(result.rejects?.[0]).toMatchObject({
      runId: "run-10",
      source: path,
      offset: 0,
      severity: "reject",
      code: "VALIDATION_FAILED",
    });
    expect(result.rejects?.[0]?.reason).toContain("sotto il minimo 1");
  });

  test("le righe entrate portano con se' da dove vengono", async () => {
    const path = await fixture("provenienza.csv", 3, 0);
    const sink = { rows: [] as Row[], outcome: [] as string[] };

    await run(definitionFor(path, 0.2), ctx, { registry: setup(sink), runId: "run-prov" });

    expect(sink.rows[0]).toMatchObject({
      Ordine: "ORD-0",
      Quantita: 10,
      Consegna: "2026-02-01",
      run_id: "run-prov",
      file_origine: path,
      riga_origine: 0,
    });
    expect(sink.rows[2]?.["riga_origine"]).toBe(2);
  });

  test("un file invalido al 40% non entra affatto: il motore annulla e fa rollback", async () => {
    const path = await fixture("quaranta.csv", 20, 8);
    const sink = { rows: [] as Row[], outcome: [] as string[] };

    await expect(
      run(definitionFor(path, 0.2), ctx, { registry: setup(sink), runId: "run-40" }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_FAILED",
      context: { failed: 8, read: 20, maxFailedRatio: 0.2 },
    });

    expect(sink.outcome).toEqual(["open", "rollback"]);
    expect(sink.rows).toEqual([]);
  });

  test("l'host puo' raccogliere tutti gli scarti dagli eventi, senza limiti di memoria", async () => {
    const path = await fixture("tutti.csv", 30, 30);
    const sink = { rows: [] as Row[], outcome: [] as string[] };
    const raccolti: string[] = [];

    await run(definitionFor(path, 1), ctx, {
      registry: setup(sink),
      maxRejectsInResult: 5,
      events: { onRecordFailed: (event) => raccolti.push(String(event.failed.row["Ordine"])) },
    });

    expect(raccolti).toHaveLength(30);
    expect(raccolti[29]).toBe("ORD-29");
  });
});

describe("file di scarto della CLI", () => {
  test("scrive un CSV con motivo e provenienza di ogni riga rifiutata", async () => {
    const { main } = await import("@etl-js/cli");
    const path = await fixture("cli.csv", 10, 3);
    const definition = join(dir, "cli.json");
    const rejects = join(dir, "scarti.csv");

    await writeFile(
      definition,
      JSON.stringify({
        client: "acme",
        source: { type: "csv", config: { path, delimiter: ";" } },
        transform: [
          { type: "cast", config: { Quantita: { number: {} } } },
          { type: "validate", config: { rules: [{ field: "Quantita", min: 1 }] } },
        ],
        destination: { type: "postgres", config: { table: "landing" } },
        policy: { rejectFile: true },
      }),
    );

    const code = await main(["run", definition, "--dry-run", "--log", "error", "--rejects", rejects]);
    expect(code).toBe(0);

    const contenuto = await readFile(rejects, "utf8");
    const righe = contenuto.trim().split("\n");
    expect(righe[0]).toBe("run_id;file;riga;severita;codice;motivo;riga_originale");
    expect(righe).toHaveLength(4);
    expect(righe[1]).toContain("VALIDATION_FAILED");
    expect(righe[1]).toContain("sotto il minimo 1");
    expect(righe[1]).toContain("ORD-0");
  });
});
