import { PROTOCOL_VERSION, type WriterPlugin } from "../contracts/index.js";
import { z } from "zod";
import { postgresConfigSchema } from "./config.js";
import { postgresWriter } from "./writer.js";

/** Writer verso una tabella di atterraggio Postgres. */
export const plugin: WriterPlugin = {
  manifest: {
    name: "postgres",
    version: "0.1.0",
    kind: "writer",
    protocol: PROTOCOL_VERSION,
    category: "database",
    capabilities: ["transaction", "bulk-load"],
    configSchema: z.toJSONSchema(postgresConfigSchema, { io: "input" }),
  },
  impl: postgresWriter,
};

export default plugin;
export { postgresConfigSchema, parsePostgresConfig, type PostgresConfig } from "./config.js";
export { PostgresErrorCodes } from "./writer.js";
