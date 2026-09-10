import type { Plugin } from "@etl-js/contracts";
import csv from "@etl-js/plugin-csv";
import postgres from "@etl-js/plugin-postgres";

/**
 * L'unico punto del progetto in cui dei plugin concreti vengono nominati.
 * Il core non li conosce (I2): li riceve gia' pronti in una Registry.
 * Dalla fase 2 questo elenco diventera' solo un comodo default, perche' un
 * plugin si potra' aggiungere per nome senza toccare alcun sorgente.
 */
export const builtinPlugins: Plugin[] = [csv, postgres];
