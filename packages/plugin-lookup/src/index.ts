import { PROTOCOL_VERSION, type TransformerPlugin } from "@etl-js/contracts";
import { z } from "zod";
import { lookupConfigSchema } from "./config.js";
import { lookupTransformer } from "./lookup.js";

/**
 * Collega le righe in arrivo a dati gia' presenti su un database, in batch e
 * in sola lettura. E' il plugin che rende utile tutto il resto: senza di lui
 * un CSV di piani di consegna non sa a quale ordine appartiene.
 */
export const plugin: TransformerPlugin = {
  manifest: {
    name: "lookup",
    version: "0.1.0",
    kind: "transformer",
    protocol: PROTOCOL_VERSION,
    category: "arricchimento",
    capabilities: ["database", "cache-per-run", "batch"],
    configSchema: z.toJSONSchema(lookupConfigSchema, { io: "input" }),
  },
  impl: lookupTransformer,
};

export default plugin;
export { lookupConfigSchema, parseLookupConfig, type LookupConfig } from "./config.js";
export { LookupErrorCodes } from "./lookup.js";
