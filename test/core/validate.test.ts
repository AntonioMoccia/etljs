import { describe, expect, test } from "vitest";
import type { Definition } from "etl-js/contracts";
import { Registry, describePlugin, listPlugins, validate } from "etl-js";
import type { ValidationIssue } from "etl-js";
import { definition, pickyTransformer, readerOf, writerOf } from "./fakes.js";

function fullRegistry(): Registry {
  return new Registry()
    .register(readerOf([[{ ok: true }]]))
    .register(pickyTransformer())
    .register(writerOf({ rows: [], outcome: [] }));
}

/** Cerca l'issue che riguarda un certo punto della Definition. */
function at(issues: ValidationIssue[], path: string): ValidationIssue | undefined {
  return issues.find((issue) => issue.path === path);
}

describe("validate", () => {
  test("una Definition corretta non produce alcun rilievo", () => {
    const result = validate(definition({ transform: [{ type: "picky", config: {} }] }), {
      registry: fullRegistry(),
    });
    expect(result).toEqual({ valid: true, issues: [] });
  });

  test("un plugin inesistente viene segnalato col punto esatto e con le alternative", () => {
    const result = validate(definition({ source: { type: "csvv", config: { path: "x" } } }), {
      registry: fullRegistry(),
    });
    const issue = at(result.issues, "source.type");
    expect(result.valid).toBe(false);
    expect(issue).toMatchObject({ code: "PLUGIN_NOT_FOUND", severity: "error" });
    expect(issue?.message).toContain("csvv");
    expect(issue?.context?.["available"]).toContain("fake-reader");
  });

  test("un plugin del tipo sbagliato al posto sbagliato viene segnalato", () => {
    const result = validate(definition({ destination: { type: "picky", config: {} } }), {
      registry: fullRegistry(),
    });
    expect(at(result.issues, "destination.type")).toMatchObject({ code: "PLUGIN_KIND_MISMATCH" });
  });

  test("una config a cui manca un campo obbligatorio dice quale campo manca", () => {
    const result = validate(definition({ source: { type: "fake-reader", config: {} } }), {
      registry: fullRegistry(),
    });
    const issue = at(result.issues, "source.config.path");
    expect(issue).toMatchObject({ code: "CONFIG_INVALID" });
    expect(issue?.message).toMatch(/obbligatori|required/i);
  });

  test("una chiave di config sconosciuta non passa in silenzio", () => {
    const result = validate(
      definition({ source: { type: "fake-reader", config: { path: "x", delimitatore: ";" } } }),
      { registry: fullRegistry() },
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes("delimitatore"))).toBe(true);
  });

  test("l'indice del transformer compare nel percorso dell'errore", () => {
    const result = validate(
      definition({
        transform: [
          { type: "picky", config: {} },
          { type: "picky", config: { campo: 42 } },
        ],
      }),
      { registry: fullRegistry() },
    );
    expect(at(result.issues, "transform[1].config.campo")).toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  test("maxFailedRatio fuori dall'intervallo 0..1 e' un errore", () => {
    const result = validate(definition({ policy: { maxFailedRatio: 1.5 } }), {
      registry: fullRegistry(),
    });
    expect(at(result.issues, "policy.maxFailedRatio")).toMatchObject({ code: "CONFIG_INVALID" });
  });

  test("una Definition senza client e senza destination viene descritta campo per campo", () => {
    const result = validate({ source: { type: "fake-reader", config: { path: "x" } } } as unknown as Definition, {
      registry: fullRegistry(),
    });
    expect(at(result.issues, "client")).toBeDefined();
    expect(at(result.issues, "destination")).toBeDefined();
  });

  test("una versione diversa da manifestSnapshot e' un avviso, non un errore", () => {
    const result = validate(
      definition({ manifestSnapshot: { "fake-reader": "0.9.0", "fake-writer": "1.0.0" } }),
      { registry: fullRegistry() },
    );
    const issue = at(result.issues, "manifestSnapshot.fake-reader");
    expect(issue).toMatchObject({ severity: "warn", code: "VERSION_DRIFT" });
    expect(result.valid).toBe(true);
  });

  test("raccoglie tutti i rilievi in una volta, non solo il primo", () => {
    const result = validate(
      definition({
        source: { type: "fake-reader", config: {} },
        destination: { type: "fake-writer", config: {} },
      }),
      { registry: fullRegistry() },
    );
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe("describePlugin", () => {
  test("restituisce il JSON Schema della config del plugin", () => {
    const schema = describePlugin("fake-reader", { registry: fullRegistry() }) as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties["path"]).toBeDefined();
  });

  test("un plugin inesistente produce PLUGIN_NOT_FOUND", () => {
    expect(() => describePlugin("assente", { registry: fullRegistry() })).toThrowError(
      /assente/,
    );
  });
});

describe("listPlugins", () => {
  test("elenca i manifest in ordine di nome", () => {
    const names = listPlugins({ registry: fullRegistry() }).map((m) => m.name);
    expect(names).toEqual(["fake-reader", "fake-writer", "picky"]);
  });
});
