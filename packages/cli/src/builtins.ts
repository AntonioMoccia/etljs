import type { Plugin } from "@etl-js/contracts";
import csv from "@etl-js/plugin-csv";
import postgres from "@etl-js/plugin-postgres";
import { plugins as transforms } from "@etl-js/plugin-transforms";

/**
 * L'unico punto del progetto in cui dei plugin concreti vengono nominati.
 * Il core non li conosce (I2): li riceve gia' pronti in una Registry.
 *
 * Qui c'e' la libreria standard - quella che si installa comunque - mentre
 * tutto il resto, `lookup` compreso, viene caricato per nome dal loader quando
 * una Definition lo cita. Se un giorno quel meccanismo si rompesse, il test
 * "l'esempio completo e' valido con i plugin caricati da npm" diventerebbe rosso.
 */
export const builtinPlugins: Plugin[] = [csv, postgres, ...transforms];
