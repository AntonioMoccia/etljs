import type { Plugin } from "../contracts/index.js";
import { csvReader } from "../csv/index.js";
import { postgresWriter } from "../postgres/index.js";
import { lookupTransformer } from "../lookup/index.js";
import { transformers } from "../transforms/index.js";

/**
 * L'unico punto del progetto in cui dei plugin concreti vengono nominati.
 * Il core non li conosce (I2): li riceve gia' pronti in una Registry.
 *
 * Il nome di ciascuno dice di che tipo e': si legge qui cosa entra nella
 * pipeline e con quale ruolo, senza aprire i file.
 */
export const builtinPlugins: Plugin[] = [
  csvReader,
  postgresWriter,
  lookupTransformer,
  ...transformers,
];
