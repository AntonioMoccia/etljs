/**
 * `pg-copy-streams` non pubblica tipi propri; qui dichiariamo solo la parte
 * che usiamo davvero, invece di aggiungere una dipendenza @types.
 */
declare module "pg-copy-streams" {
  import type { Writable } from "node:stream";
  /** Restituisce uno stream scrivibile da passare a client.query(). */
  export function from(sql: string): Writable;
}
