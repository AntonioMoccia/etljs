import { PROTOCOL_VERSION, type ReaderPlugin } from "../contracts/index.js";
import { z } from "zod";
import { csvConfigSchema } from "./config.js";
import { reader } from "./reader.js";

/**
 * Reader CSV in streaming. Un flusso non ha mai un plugin proprio: ha solo
 * valori diversi in questa config (I8).
 */
export const csvReader: ReaderPlugin = {
  manifest: {
    name: "csv",
    version: "0.1.0",
    kind: "reader",
    protocol: PROTOCOL_VERSION,
    category: "file",
    capabilities: ["streaming"],
    configSchema: z.toJSONSchema(csvConfigSchema, { io: "input" }),
  },
  impl: reader,
};

export { csvConfigSchema, parseCsvConfig, type CsvConfig } from "./config.js";
