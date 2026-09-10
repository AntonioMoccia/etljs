# Scrivere un plugin

Un plugin e' un pacchetto npm che esporta un oggetto `plugin`. Il core non lo conosce e non lo
nominera' mai: lo carica per nome quando una Definition lo cita (I2).

## Le tre forme

| Tipo | Cosa fa | Firma |
|------|---------|-------|
| `reader` | legge la sorgente in streaming | `read(config, ctx): AsyncIterable<Batch>` |
| `transformer` | trasforma un lotto, senza scrivere da nessuna parte (I4) | `transform(batch, config, ctx): Promise<{ batch, failed }>` |
| `writer` | apre una sessione transazionale | `open(config, ctx): Promise<WriteSession>` |

## Uno scheletro completo

```ts
// packages/plugin-maiuscolo/src/index.ts
import {
  PROTOCOL_VERSION,
  configInvalid,
  type TransformerPlugin,
  type Transformer,
} from "@etl-js/contracts";
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
  "name": "@etl-js/plugin-maiuscolo",
  "type": "module",
  "main": "./dist/index.js",
  "keywords": ["etl-js-plugin", "transformer"],
  "peerDependencies": { "@etl-js/contracts": "^0.1.0" },
  "dependencies": { "zod": "^4.0.0" }
}
```

### Un pacchetto con piu' plugin

Se ne pubblichi diversi che si installano sempre insieme, un pacchetto solo basta e avanza:

```ts
export const plugins: Plugin[] = [castPlugin, filterPlugin, renamePlugin];
```

Il loader li registra tutti al primo import, e nelle Definition restano nomi distinti. Dai a ognuno
la **sua** `manifest.version`, indipendente da quella del pacchetto: altrimenti modificarne uno fa
comparire avvisi `VERSION_DRIFT` su tutti gli altri.

Il nome del pacchetto segue la convenzione `@etl-js/plugin-<nome>` oppure `etl-js-plugin-<nome>`:
e' cosi' che il loader lo trova a partire dal nome logico scritto nella Definition. Chi usa un altro
nome lo dichiara con `createLoader({ packages: { maiuscolo: "@acme/qualunque-cosa" } })`.

## Provarlo: `@etl-js/testing`

L'harness esegue il plugin come lo eseguirebbe il motore, senza motore, senza database e senza file.

```ts
import { describe, expect, test } from "vitest";
import { mockCtx, testTransformer } from "@etl-js/testing";
import { plugin } from "../src/index.js";

test("mette in maiuscolo solo i campi indicati", async () => {
  const result = await testTransformer(plugin, {
    rows: [{ nome: "mario", citta: "perugia" }],
    config: { fields: ["nome"] },
    ctx: mockCtx(),
  });
  expect(result.rows).toEqual([{ nome: "MARIO", citta: "perugia" }]);
});
```

### Provare un reader

`mockCtx({ inputs })` serve i byte da una stringa: un test di un reader non tocca il disco.

```ts
const ctx = mockCtx({ inputs: { "piano.csv": "Ordine;Qta\nORD-1;5\n" } });

const batches = [];
for await (const b of plugin.impl.read({ input: "piano.csv", delimiter: ";" }, ctx)) {
  batches.push(b);
}
expect(batches[0].rows).toEqual([{ Ordine: "ORD-1", Qta: "5" }]);
```

### Provare un plugin che legge dal database

`recordingDb` non interpreta SQL: risponde quel che gli dici e registra quel che ha ricevuto. E'
l'unico modo onesto di verificare che una query sia **una sola per lotto** (I5) e **parametrizzata** (I7).

```ts
import { mockCtx, recordingDb, testTransformer } from "@etl-js/testing";

test("una sola interrogazione per lotto, e nessun valore dentro l'SQL", async () => {
  const db = recordingDb(() => [{ codice: "ORD-1", id: 11 }]);

  const result = await testTransformer(plugin, {
    rows: [{ codice: "ORD-1" }, { codice: "ORD-2" }],
    config: { db: "gestionale", table: "ordini", on: ["codice"], select: "id" },
    ctx: mockCtx({ databases: { gestionale: db } }),
  });

  expect(db.calls).toHaveLength(1);
  expect(db.calls[0].sql).toContain('"codice" = ANY($1)');
  expect(db.calls[0].sql).not.toContain("ORD-1");   // i valori sono parametri
  expect(db.calls[0].params).toEqual([["ORD-1", "ORD-2"]]);
});
```

### Provare lo stato fra un lotto e l'altro

Un transformer con cache o con `flush` va provato su piu' lotti, con lo **stesso** `ctx`: e' cosi'
che lavora il motore.

```ts
const ctx = mockCtx({ databases: { gestionale: db } });

await testTransformer(plugin, {
  batches: [
    batchOf([{ codice: "ORD-1" }], { runId: ctx.runId, offset: 0 }),
    batchOf([{ codice: "ORD-1" }], { runId: ctx.runId, offset: 1 }),
  ],
  config,
  ctx,
});

expect(db.calls).toHaveLength(1);   // il secondo lotto ha usato la cache del run
```

### Cosa offre l'harness

| Funzione | A cosa serve |
|----------|--------------|
| `testTransformer(plugin, caso)` | esegue `transform` su uno o piu' lotti e poi `flush`, come il motore |
| `mockCtx({ databases, secrets, runId, signal, logger })` | il `Ctx` di prova; **non** ha `dbWrite`, quindi un transformer non puo' scrivere (I4) |
| `recordingDb(rispondi)` | database finto che registra ogni `query` in `.calls` |
| `recordingLogger()` | logger che ricorda messaggi e campi in `.lines` |
| `batchOf(rows, meta)` | costruisce un lotto con meta sensati |

`mockCtx` accetta `inputs` per `ctx.openInput`, `databases` per `ctx.db`, `secrets`, `runId`,
`signal` e `logger`. Chiedere qualcosa che il test non ha dichiarato produce un errore che dice
esattamente cosa aggiungere, invece di un `undefined` silenzioso.

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
5. **Non nomina nessun cliente.** Se ti serve un `if (cliente === "acme")`, manca un parametro alla
   config (I8).
6. **Non importa `@etl-js/core` ne' un altro plugin.** `npm run check:boundaries` te lo impedisce (I9).

## Pubblicarlo e usarlo

```bash
npm i @etl-js/plugin-maiuscolo
```

Poi basta citarlo in una Definition; nessun sorgente di questo progetto va toccato:

```json
{ "type": "maiuscolo", "config": { "fields": ["ordine_cliente"] } }
```
