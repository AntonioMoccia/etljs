import type { Plugin } from "../contracts/index.js";
import csv from "../csv/index.js";
import postgres from "../postgres/index.js";
import lookup from "../lookup/index.js";
import { plugins as transforms } from "../transforms/index.js";

/**
 * L'unico punto del progetto in cui dei plugin concreti vengono nominati.
 * Il core non li conosce (I2): li riceve gia' pronti in una Registry.
 *
 * Con il pacchetto unico i plugin viaggiano insieme alla libreria, quindi la
 * CLI li collega tutti con import statici invece di cercarli su npm.
 */
export const builtinPlugins: Plugin[] = [csv, postgres, lookup, ...transforms];
