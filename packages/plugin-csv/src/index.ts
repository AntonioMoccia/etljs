import { PROTOCOL_VERSION, type ReaderPlugin } from "@etl-js/contracts";
import { z } from "zod";
import { csvConfigSchema } from "./config.js";
import { csvReader } from "./reader.js";

/**
 * Reader CSV in streaming. Un cliente non ha mai un plugin proprio: ha solo
 * valori diversi in questa config (I8).
 */
export const plugin: ReaderPlugin = {
  manifest: {
    name: "csv",
    version: "0.1.0",
    kind: "reader",
    protocol: PROTOCOL_VERSION,
    category: "file",
    capabilities: ["streaming"],
    configSchema: z.toJSONSchema(csvConfigSchema, { io: "input" }),
  },
  impl: csvReader,
};

export default plugin;
export { csvConfigSchema, parseCsvConfig, type CsvConfig } from "./config.js";
