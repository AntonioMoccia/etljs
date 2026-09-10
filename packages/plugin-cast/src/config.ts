import { z } from "zod";
import { configInvalid } from "@etl-js/contracts";

/** Politiche comuni a ogni conversione. */
const common = {
  nullable: z
    .boolean()
    .default(false)
    .describe("Un valore vuoto diventa null invece di essere un errore"),
  onError: z
    .enum(["reject", "warn", "skip"])
    .default("reject")
    .describe("reject: scarta e segnala. warn: tiene la riga con null e segnala. skip: scarta in silenzio"),
};

const numberOptions = z
  .object({
    decimal: z.string().length(1).default(".").describe("Separatore decimale del cliente"),
    thousands: z.string().length(1).optional().describe("Separatore delle migliaia"),
    strip: z.string().optional().describe("Caratteri da togliere prima di leggere il numero"),
  })
  .strict();

export const castFieldSchema = z.union([
  z.object({ date: z.string().min(1), ...common }).strict(),
  z.object({ datetime: z.string().min(1), ...common }).strict(),
  z.object({ week: z.string().min(1), ...common }).strict(),
  z.object({ number: numberOptions.default({ decimal: "." }), ...common }).strict(),
  z.object({ integer: numberOptions.default({ decimal: "." }), ...common }).strict(),
  z
    .object({
      boolean: z
        .object({
          true: z.array(z.string()).min(1),
          false: z.array(z.string()).min(1),
        })
        .strict(),
      ...common,
    })
    .strict(),
  z
    .object({
      string: z
        .object({
          trim: z.boolean().default(false),
          case: z.enum(["upper", "lower"]).optional(),
        })
        .strict()
        .default({ trim: false }),
      ...common,
    })
    .strict(),
]);

/** La config e' una mappa campo -> conversione: nessun nome di cliente, solo valori (I8). */
export const castConfigSchema = z.record(z.string().min(1), castFieldSchema);

export type CastConfig = z.infer<typeof castConfigSchema>;
export type CastField = z.infer<typeof castFieldSchema>;

export function parseCastConfig(config: unknown): CastConfig {
  const result = castConfigSchema.safeParse(config);
  if (result.success) return result.data;
  throw configInvalid(
    "cast",
    result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  );
}
