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

**Un pacchetto e' un'unita' di distribuzione, un plugin un'unita' di configurazione: non coincidono.**
`@etl-js/plugin-transforms` porta cinque plugin (`cast`, `filter`, `default`, `rename`, `validate`)
perche' si installano sempre insieme; nelle Definition restano cinque nomi distinti e ognuno tiene la
propria versione. Un pacchetto dichiara i suoi con `export const plugins: Plugin[]`.

## I pacchetti

| Pacchetto | Cosa fa |
|-----------|---------|
| `@etl-js/contracts` | tipi, `PROTOCOL_VERSION`, `EtlError`, utility SQL. **Zero dipendenze** |
| `@etl-js/core` | `run`, `validate`, `describe`, `listPlugins`, `preview`, loader, eventi, driver Postgres |
| `@etl-js/testing` | `testTransformer`, `mockCtx`, `recordingDb`: provare un plugin senza servizi esterni |
| `@etl-js/cli` | `run`, `plugins`, `describe`, `validate`, `preview` |
| `@etl-js/plugin-csv` | reader CSV in streaming su `csv-parse`; non apre file da se' (`ctx.openInput`) |
| `@etl-js/plugin-postgres` | writer con `append`, `upsert`, `replace-by` |
| `@etl-js/plugin-transforms` | la libreria standard: `cast`, `filter`, `default`, `rename`, `validate` |
| `@etl-js/plugin-lookup` | collega le righe a dati gia' sul database, in batch |

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

**[docs/](docs/README.md)** e' l'indice completo. In breve:

| Documento | Cosa contiene |
|---|---|
| [Concetti](docs/concetti.md) | il modello mentale, in dieci minuti |
| [Guida rapida](docs/guida-rapida.md) | dal clone al primo import |
| [La Definition](docs/definition.md) | il formato del file di configurazione |
| [I plugin](docs/plugin.md) | riferimento completo di ogni config |
| [API](docs/api.md) | usare la libreria da un altro programma |
| [Errori, eventi e scarti](docs/errori.md) | codici, severita', come raccogliere gli scarti |
| [Scrivere un plugin](docs/scrivere-un-plugin.md) | scheletro e harness di test |
| [Limiti](docs/limiti.md) | cosa non fa, e come si fa comunque |
| [CLAUDE.md](CLAUDE.md) | invarianti e regole di lavoro |
| [Piano](docs/piano.md) | stato delle fasi, e come si verifica ogni invariante |

## Comandi

```bash
npm run build             # tsc --build su tutti i workspace
npm run typecheck:tests   # i test non sono type-checkati da vitest
npm test                  # vitest run
npm run check:boundaries  # dependency-cruiser: I2 + I9
npm run check             # tutti e quattro

PG_TEST_URL=postgres://... npm test    # include anche i test d'integrazione
```
