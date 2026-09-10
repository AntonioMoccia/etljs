# etl-js

Motore di importazione dati a plugin: libreria senza stato, in TypeScript, pensata per essere
incorporata in un software piu' grande. Il caso d'uso che ne guida ogni scelta e' importare piani di
consegna dai CSV dei clienti collegandoli a ordini gia' presenti su un gestionale Postgres.

**Un cliente non ha mai codice proprio: ha un file di configurazione JSON.**

## Provalo

```bash
npm install
npm run build

node packages/cli/dist/bin.js plugins                        # cosa c'e' installato
node packages/cli/dist/bin.js describe csv                   # JSON Schema della config
node packages/cli/dist/bin.js validate examples/acme.json    # cosa non va, tutto insieme
node packages/cli/dist/bin.js preview examples/acme-fase0.json -n 5
node packages/cli/dist/bin.js run examples/acme-fase0.json --dry-run
```

Per scrivere davvero su Postgres, e tenere le righe rifiutate:

```bash
node packages/cli/dist/bin.js run examples/acme.json \
  --db gestionale=env:DATABASE_URL \
  --rejects scarti.csv
```

## Come funziona

```
Definition (JSON)
      |
      v
 core.run() --> reader ---> Batch ---> transformer* ---> Batch ---> writer
              (streaming)          (batch, sola lettura)      (transazione)
```

Il `core` non conosce nessun plugin: li riceve in una `Registry` o li carica per nome da npm. Il
grafo delle dipendenze punta tutto verso `@etl-js/contracts`, e dependency-cruiser lo verifica a ogni
`npm run check`.

## I pacchetti

| Pacchetto | Cosa fa |
|-----------|---------|
| `@etl-js/contracts` | tipi, `PROTOCOL_VERSION`, `IngestError`, utility SQL. **Zero dipendenze** |
| `@etl-js/core` | `run`, `validate`, `describe`, `listPlugins`, `preview`, loader, eventi, driver Postgres |
| `@etl-js/testing` | `testTransformer`, `mockCtx`, `recordingDb`: provare un plugin senza servizi esterni |
| `@etl-js/cli` | `run`, `plugins`, `describe`, `validate`, `preview` |
| `@etl-js/plugin-csv` | reader CSV in streaming su `csv-parse`; non apre file da se' (`ctx.openInput`) |
| `@etl-js/plugin-postgres` | writer con `append`, `upsert`, `replace-by` |
| `@etl-js/plugin-lookup` | collega le righe a dati gia' sul database, in batch |
| `@etl-js/plugin-cast` | date, settimane ISO, decimali con la virgola, booleani |
| `@etl-js/plugin-filter` | butta via intestazioni, totali, righe vuote |
| `@etl-js/plugin-default` | riempie i campi assenti, marca la provenienza di ogni riga |
| `@etl-js/plugin-rename` | dalle intestazioni del cliente ai nomi del gestionale |
| `@etl-js/plugin-validate` | regole di merito con `severity` |

## Un cliente, un file

Questa e' l'intera configurazione di un cliente. Non c'e' nulla di specifico ad Acme se non i valori:

```json
{
  "client": "acme",
  "source": { "type": "csv", "config": {
    "input": "examples/acme.csv", "delimiter": ";", "encoding": "latin1", "skipRows": 3 } },
  "transform": [
    { "type": "filter", "config": { "drop": [{ "field": "Nr Ordine", "empty": true }] } },
    { "type": "rename", "config": { "map": { "Nr Ordine": "ordine_cliente", "Data": "data_consegna" } } },
    { "type": "cast",   "config": {
      "data_consegna": { "date": "dd/MM/yyyy" },
      "quantita": { "number": { "decimal": ",", "thousands": "." } } } },
    { "type": "lookup", "config": {
      "db": "gestionale", "table": "ordini", "on": ["ordine_cliente"],
      "select": "ordine_id", "onMissing": "reject" } },
    { "type": "validate", "config": { "rules": [
      { "field": "quantita", "min": 1, "severity": "reject" },
      { "field": "data_consegna", "notBefore": "today", "severity": "warn" } ] } },
    { "type": "default", "config": { "values": {
      "run_id": { "fromMeta": "runId", "when": "always" },
      "riga_origine": { "fromMeta": "offset", "when": "always" } } } }
  ],
  "destination": { "type": "postgres", "config": {
    "table": "landing_piani_consegna", "strategy": "replace-by", "replaceKey": ["ordine_id"] } },
  "policy": { "maxFailedRatio": 0.2, "rejectFile": true }
}
```

Un secondo cliente col punto e virgola al posto della virgola, le date all'americana e una colonna in
piu' e' un secondo file JSON, non un secondo pacchetto.

## Usarla da un altro programma

```ts
import { Registry, createLoader, run } from "@etl-js/core";
import { createPostgresProvider } from "@etl-js/core";

const provider = await createPostgresProvider({
  gestionale: { connectionString: process.env.DATABASE_URL! },
});

const registry = new Registry();
const result = await run(definition, {
  // In produzione questa risolve su object storage, e i plugin non cambiano.
  openInput: (ref) => apriDaS3(ref),
  db: (name) => provider.db(name),
  dbWrite: (name) => provider.dbWrite(name),
  secretRef: (ref) => vault.get(ref),
  log: mioLogger,
  signal: controller.signal,
}, {
  registry,
  resolve: createLoader({ registry }),   // carica i plugin per nome da npm
  events: {
    onBatch: (e) => aggiornaBarra(e.read, e.written),
    onRecordFailed: (e) => salvaScarto(e.failed),
    onRunEnd: (e) => registraEsito(e.result, e.error),
  },
});
```

Persistenza dei run, coda, GUI e autenticazione **non** stanno qui: sono compito dell'applicazione
che usa questa libreria.

## Documentazione

- [CLAUDE.md](CLAUDE.md) - invarianti, regole di lavoro, deviazioni deliberate dai contratti
- [docs/piano.md](docs/piano.md) - stato delle fasi e come si verifica ogni invariante
- [docs/scrivere-un-plugin.md](docs/scrivere-un-plugin.md) - scheletro di un plugin e come provarlo

## Comandi

```bash
npm run build             # tsc --build su tutti i workspace
npm run typecheck:tests   # i test non sono type-checkati da vitest
npm test                  # vitest run
npm run check:boundaries  # dependency-cruiser: I2 + I9
npm run check             # tutti e quattro

PG_TEST_URL=postgres://... npm test    # include anche i test d'integrazione
```
