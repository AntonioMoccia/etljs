import { PROTOCOL_VERSION, type TransformerPlugin } from "@etl-js/contracts";
import { z } from "zod";
import { castConfigSchema } from "./config.js";
import { castTransformer } from "./cast.js";

/**
 * Converte i valori grezzi del CSV nei tipi che il database si aspetta.
 * Tutto cio' che cambia da cliente a cliente - formato data, separatore
 * decimale, parole per vero e falso - e' un valore in questa config (I8).
 *
 * Le date escono come stringhe ISO, non come oggetti Date: un Batch deve
 * restare serializzabile (I3).
 */
export const plugin: TransformerPlugin = {
  manifest: {
    name: "cast",
    version: "0.1.0",
    kind: "transformer",
    protocol: PROTOCOL_VERSION,
    category: "conversione",
    capabilities: ["date", "settimane-iso", "numeri-localizzati"],
    configSchema: z.toJSONSchema(castConfigSchema, { io: "input" }),
  },
  impl: castTransformer,
};

export default plugin;
export { castConfigSchema, parseCastConfig, type CastConfig } from "./config.js";
export { CastErrorCodes } from "./cast.js";
export { isoWeekMonday, isoWeeksInYear } from "./formats.js";
