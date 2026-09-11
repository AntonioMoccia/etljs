/**
 * etljs/transformers - i transformer di base.
 *
 * Un pacchetto solo che ne contiene cinque: un pacchetto e' un'unita' di
 * distribuzione, un plugin un'unita' di configurazione, e questi cinque si
 * installano sempre insieme. Nelle Definition restano cinque nomi distinti
 * (`cast`, `filter`, ...) e ognuno tiene la propria `manifest.version`, cosi'
 * modificarne uno non fa comparire avvisi di versione sugli altri.
 */
import type { Plugin } from "../contracts/index.js";
import { castTransformer } from "./cast.js";
import { filterTransformer } from "./filter.js";
import { defaultTransformer } from "./default.js";
import { renameTransformer } from "./rename.js";
import { validateTransformer } from "./validate.js";

/** Cio' che il loader del core cerca in un pacchetto con piu' plugin. */
export const transformers: Plugin[] = [
  castTransformer,
  filterTransformer,
  defaultTransformer,
  renameTransformer,
  validateTransformer,
];

export { castTransformer, filterTransformer, defaultTransformer, renameTransformer, validateTransformer };

export { castConfigSchema, type CastConfig } from "./cast-config.js";
export { CastErrorCodes } from "./cast.js";
export { isoWeekMonday, isoWeeksInYear } from "./formats.js";
export { filterConfigSchema, FilterErrorCodes, type FilterConfig } from "./filter.js";
export { defaultConfigSchema, type DefaultConfig } from "./default.js";
export { renameConfigSchema, RenameErrorCodes, type RenameConfig } from "./rename.js";
export { validateConfigSchema, ValidateErrorCodes, type ValidateConfig } from "./validate.js";
