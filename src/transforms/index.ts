/**
 * @etl-js/plugin-transforms - i transformer di base.
 *
 * Un pacchetto solo che ne contiene cinque: un pacchetto e' un'unita' di
 * distribuzione, un plugin un'unita' di configurazione, e questi cinque si
 * installano sempre insieme. Nelle Definition restano cinque nomi distinti
 * (`cast`, `filter`, ...) e ognuno tiene la propria `manifest.version`, cosi'
 * modificarne uno non fa comparire avvisi di versione sugli altri.
 */
import type { Plugin } from "../contracts/index.js";
import { castPlugin } from "./cast.js";
import { filterPlugin } from "./filter.js";
import { defaultPlugin } from "./default.js";
import { renamePlugin } from "./rename.js";
import { validatePlugin } from "./validate.js";

/** Cio' che il loader del core cerca in un pacchetto con piu' plugin. */
export const plugins: Plugin[] = [
  castPlugin,
  filterPlugin,
  defaultPlugin,
  renamePlugin,
  validatePlugin,
];

export { castPlugin, filterPlugin, defaultPlugin, renamePlugin, validatePlugin };

export { castConfigSchema, type CastConfig } from "./cast-config.js";
export { CastErrorCodes } from "./cast.js";
export { isoWeekMonday, isoWeeksInYear } from "./formats.js";
export { filterConfigSchema, FilterErrorCodes, type FilterConfig } from "./filter.js";
export { defaultConfigSchema, type DefaultConfig } from "./default.js";
export { renameConfigSchema, RenameErrorCodes, type RenameConfig } from "./rename.js";
export { validateConfigSchema, ValidateErrorCodes, type ValidateConfig } from "./validate.js";
