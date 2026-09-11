import { describe, expect, test } from "vitest";
import { encodeCopyRow, encodeCopyValue } from "../../src/core/db/copy-text.js";

describe("encodeCopyValue", () => {
  test("null e undefined diventano il marcatore NULL di COPY", () => {
    expect(encodeCopyValue(null)).toBe("\\N");
    expect(encodeCopyValue(undefined)).toBe("\\N");
  });

  test("una stringa vuota resta una stringa vuota, non un NULL", () => {
    expect(encodeCopyValue("")).toBe("");
  });

  test("escapa i caratteri che in COPY text sono struttura", () => {
    expect(encodeCopyValue("a\tb")).toBe("a\\tb");
    expect(encodeCopyValue("a\nb")).toBe("a\\nb");
    expect(encodeCopyValue("a\r\nb")).toBe("a\\r\\nb");
    expect(encodeCopyValue("a\\b")).toBe("a\\\\b");
  });

  test("una backslash-N letterale non viene confusa con un NULL", () => {
    expect(encodeCopyValue("\\N")).toBe("\\\\N");
  });

  test("numeri e booleani passano nella forma che Postgres si aspetta", () => {
    expect(encodeCopyValue(42)).toBe("42");
    expect(encodeCopyValue(3.5)).toBe("3.5");
    expect(encodeCopyValue(true)).toBe("true");
    expect(encodeCopyValue(false)).toBe("false");
  });

  test("una data va in ISO 8601, non nel formato locale", () => {
    expect(encodeCopyValue(new Date(Date.UTC(2026, 1, 3, 10, 30)))).toBe(
      "2026-02-03T10:30:00.000Z",
    );
  });

  test("un oggetto viene serializzato in JSON per le colonne jsonb", () => {
    expect(encodeCopyValue({ a: 1 })).toBe('{"a":1}');
  });

  test("NaN e Infinity non sono numeri validi per una colonna numerica", () => {
    expect(() => encodeCopyValue(Number.NaN)).toThrowError(/NaN|finito/i);
    expect(() => encodeCopyValue(Number.POSITIVE_INFINITY)).toThrowError(/finito/i);
  });
});

describe("encodeCopyRow", () => {
  test("unisce i campi con il tabulatore e chiude con un a capo", () => {
    expect(encodeCopyRow(["a", null, 3])).toBe("a\t\\N\t3\n");
  });

  test("una riga senza campi resta una riga vuota valida", () => {
    expect(encodeCopyRow([])).toBe("\n");
  });
});
