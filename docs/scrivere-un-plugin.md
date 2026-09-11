# Scrivere un plugin

Un plugin e' un pacchetto npm che esporta un oggetto `plugin`. Il core non lo conosce e non lo
nominera' mai: lo carica per nome quando una Definition lo cita (I2).

Prima di scriverne uno, controlla se serve davvero: [i plugin esistenti](plugin.md) coprono
conversioni, filtri, rinomine, controlli e lookup, e sono parametrizzati. Se ti serve un
`if (flusso === "acme")`, manca un parametro a un plugin che c'e' gia'.

## Le tre forme

| Tipo | Cosa fa | Firma |
|------|---------|-------|
| `reader` | legge la sorgente in streaming | `read(config, ctx): AsyncIterable<Batch>` |
| `transformer` | trasforma un lotto, senza scrivere da nessuna parte (I4) | `transform(batch, config, ctx): Promise<{ batch, failed }>` |
| `writer` | apre una sessione transazionale | `open(config, ctx): Promise<WriteSession>` |

## Uno scheletro completo

```ts
// @acme/etl-plugin-maiuscolo/src/index.ts
import {
  PROTOCOL_VERSION,
  configInvalid,
  type TransformerPlugin,
  type Transformer,
} from "etl-js/contracts";
import { z } from "zod";

// 1. La config e' un DATO: si descrive con uno schema, non con del codice (I1).
export const configSchema = z
  .object({ fields: z.array(z.string().min(1)).min(1) })
  .strict();

function parseConfig(raw: unknown) {
  const result = configSchema.safeParse(raw);
  if (result.success) return result.data;
  throw configInvalid(
    "maiuscolo",
    result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  );
}

// 2. L'implementazione lavora a lotti e non ha stato globale.
const impl: Transformer = {
  async transform(batch, rawConfig, _ctx) {
    const config = parseConfig(rawConfig);
    const rows = batch.rows.map((row) => {
      const out = { ...row };
      for (const field of config.fields) {
        if (typeof out[field] === "string") out[field] = (out[field] as string).toUpperCase();
      }
      return out;
    });
    return { batch: { ...batch, rows }, failed: [] };
  },
};

// 3. Il manifest e' cio' che il core legge: nome, protocollo, schema.
export const plugin: TransformerPlugin = {
  manifest: {
    name: "maiuscolo",
    version: "0.1.0",
    kind: "transformer",
    protocol: PROTOCOL_VERSION,
    configSchema: z.toJSONSchema(configSchema, { io: "input" }),
  },
  impl,
};

export default plugin;
```

`package.json`:

```json
{
  "name": "@acme/etl-plugin-maiuscolo",
  "type": "module",
  "main": "./dist/index.js",
  "keywords": ["etl-js-plugin", "transformer"],
  "peerDependencies": { "etl-js": "^0.1.0" },
  "dependencies": { "zod": "^4.0.0" }
}
```

### Un pacchetto con piu' plugin

Se ne pubblichi diversi che si installano sempre insieme, un pacchetto solo basta e avanza:

```ts
export const transformers: Plugin[] = [castTransformer, filterTransformer, renameTransformer];
```

Si collegano in un colpo con `useAll()`, e nelle Definition restano nomi distinti. Dai a ognuno la
**sua** `manifest.version`, indipendente da quella del pacchetto: altrimenti modificarne uno fa
comparire avvisi `VERSION_DRIFT` su tutti gli altri.

Il nome del pacchetto e' libero: nel v1 non c'e' risoluzione per convenzione, perche' non c'e'
caricamento dinamico. Cio' che conta e' `manifest.name`, perche' e' quello che le Definition
scrivono in `type`.

## Provarlo

Un plugin si prova **senza motore, senza database e senza file**: gli si passa un lotto e un
contesto finto, e si guarda cosa restituisce. Non serve altro, perche' il contratto e' tutto qui.

```ts
import { describe, expect, test } from "vitest";
import { plugin } from "../src/index.js";

const ctxFinto = {
  runId: "run-di-prova",
  openInput: async () => { throw new Error("questo test non legge sorgenti"); },
  db: () => { throw new Error("questo test non tocca il database"); },
  secretRef: (ref: string) => ref,
  log: { debug(){}, info(){}, warn(){}, error(){}, child(){ return this; } },
  signal: new AbortController().signal,
};

const lotto = (rows: Row[]) => ({ rows, meta: { runId: "run-di-prova", source: "prova.csv", offset: 0 } });

test("mette in maiuscolo solo i campi indicati", async () => {
  const { batch, failed } = await plugin.impl.transform(
    lotto([{ nome: "mario", citta: "perugia" }]),
    { fields: ["nome"] },
    ctxFinto,
  );
  expect(batch.rows).toEqual([{ nome: "MARIO", citta: "perugia" }]);
  expect(failed).toEqual([]);
});
```

### Le tre prove che contano davvero

**Una sola interrogazione per lotto (I5).** Se il plugin legge dal database, il `db` finto registra
le chiamate: e' l'unico modo onesto di dimostrare che non ne fa una per riga.

```ts
const calls: { sql: string; params: readonly unknown[] }[] = [];
const db = {
  async query(sql: string, params: readonly unknown[] = []) {
    calls.push({ sql, params });
    return [{ codice: "COD-1", id: 11 }];
  },
};

await plugin.impl.transform(lotto([{ codice: "COD-1" }, { codice: "COD-2" }]), config, {
  ...ctxFinto,
  db: () => db,
});

expect(calls).toHaveLength(1);                      // una sola, per due righe
expect(calls[0].sql).toContain('"codice" = ANY($1)');
expect(calls[0].sql).not.toContain("COD-1");        // i valori sono parametri (I7)
```

**Lo stato fra un lotto e l'altro.** Un plugin con cache o con `flush` va provato su piu' lotti con
lo **stesso** `ctx`, perche' e' cosi' che lavora il motore: `ctx.runId` e' la chiave con cui tenere
e liberare la memoria di un run.

**I casi tristi.** Riga che non corrisponde, valore non convertibile, campo assente: ognuno deve
produrre un `Failed` col suo `code`, la sua `severity` e un `reason` che nomina il campo e il valore.
E' quello che finira' nel file di scarto, e lo leggera' un operatore.

### L'harness interno

Il repository ha un harness (`testTransformer`, `mockCtx`, `recordingDb`) che fa esattamente le cose
qui sopra con meno cerimonie. **Non e' pubblicato su npm**, quindi da un pacchetto tuo non lo puoi
importare: le venti righe di `ctxFinto` qui sopra sono l'equivalente, e non hanno dipendenze.

Se lo vuoi come pacchetto, e' una richiesta legittima: si pubblica il giorno che qualcuno la fa,
non prima.

## Le regole che un plugin non puo' violare

1. **Non apre nulla da se'.** Il database arriva da `ctx.db(nome)`, i byte della sorgente da
   `ctx.openInput(ref)`: un reader non importa mai `node:fs`, perche' in produzione il file e' su
   object storage (I6). Le credenziali non le vede: riceve al massimo un riferimento da risolvere
   con `ctx.secretRef`.
2. **Non fa una query per riga.** Un lotto = una interrogazione, con `= ANY($1)` o con una lista di
   tuple parametrizzate (I5).
3. **Non interpola valori nell'SQL.** I valori sono parametri; gli identificatori passano da
   `escapeIdentifier`; gli operatori vengono da `SQL_OPERATORS` (I7).
4. **Un transformer non scrive.** Nemmeno un file di log: si usa `ctx.log` (I4).
5. **Non nomina nessun flusso.** Se ti serve un `if (flusso === "acme")`, manca un parametro alla
   config (I8).
6. **Non importa il core ne' un altro plugin.** Dipende solo da `etl-js/contracts`. Dentro questo
   repository `npm run check:boundaries` te lo impedisce; in un pacchetto tuo e' una disciplina che
   conviene tenere, perche' e' cio' che rende il plugin sostituibile.

## Un reader o un writer

Le stesse regole, contratti diversi.

Un **reader** produce lotti e non apre nulla:

```ts
const impl: Reader = {
  async *read(rawConfig, ctx) {
    const config = parseConfig(rawConfig);
    const bytes = await ctx.openInput(config.input);   // mai node:fs
    let rows = [], offset = 0;
    for await (const riga of leggi(bytes)) {
      if (ctx.signal.aborted) return;
      rows.push(riga);
      if (rows.length >= config.batchSize) {
        yield { rows, meta: { runId: ctx.runId, source: config.input, offset } };
        offset += rows.length;
        rows = [];
      }
    }
    if (rows.length) yield { rows, meta: { runId: ctx.runId, source: config.input, offset } };
  },
};
```

Un **writer** apre una sessione e la chiude con commit o rollback:

```ts
const impl: Writer = {
  async open(rawConfig, ctx) {
    const config = parseConfig(rawConfig);
    const tx = await (ctx as WriterCtx).dbWrite(config.db);   // il core l'ha gia' aperta
    return {
      async write(batch) { await tx.bulkLoad(config.table, colonne, righe(batch)); },
      async close(commit) { commit ? await tx.commit() : await tx.rollback(); },
    };
  },
};
```

Un writer riceve un `Ctx` arricchito con `dbWrite`; reader e transformer no, e non e' una
convenzione: su quell'oggetto il metodo non esiste.

## Pubblicarlo e usarlo

```bash
npm i @acme/etl-plugin-maiuscolo
```

Lo si collega come gli altri, e poi lo si cita nella Definition. Nessun sorgente di `etl-js` va
toccato:

```ts
import { maiuscoloTransformer } from "@acme/etl-plugin-maiuscolo";
const engine = createEngine().use(csvReader).use(maiuscoloTransformer).use(postgresWriter);
```

```json
{ "type": "maiuscolo", "config": { "fields": ["codice"] } }
```
