# etl-js

Motore di importazione dati a plugin: libreria senza stato, in TypeScript, pensata per essere
incorporata in un software piu' grande. Il caso d'uso che ne guida ogni scelta e' far confluire
file CSV di formati diversi in una tabella unica, collegandoli a dati gia' presenti su Postgres.

**Un flusso non ha mai codice proprio: ha un file di configurazione JSON.**

## Provalo

```bash
npm install etl-js
```

```ts
import { createEngine } from "etl-js";
import { csvReader } from "etl-js/csv-reader";
import { postgresWriter } from "etl-js/postgres-writer";
import { transformers } from "etl-js/transformers";

const engine = createEngine().use(csvReader).use(postgresWriter).useAll(transformers);
const result = await engine.run(definition, ctx);
```

Installare il pacchetto porta con se' anche il comando:

```bash
npx etl-js plugins                        # cosa e' collegato
npx etl-js describe csv                   # JSON Schema della config
npx etl-js validate clienti/acme.json     # cosa non va, tutto insieme
npx etl-js preview clienti/acme.json -n 5
npx etl-js run clienti/acme.json --dry-run
```

Dal repository, invece che dal pacchetto installato:

```bash
npm install && npm run build
node dist/cli/bin.js run examples/acme-fase0.json --dry-run
```

Per scrivere davvero su Postgres, e tenere le righe rifiutate:

```bash
npx etl-js run clienti/acme.json --db principale=env:DATABASE_URL --rejects scarti.csv
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
grafo delle dipendenze punta tutto verso `etl-js/contracts`, e dependency-cruiser lo verifica a ogni
`npm run check`.

**Un pacchetto e' un'unita' di distribuzione, un plugin un'unita' di configurazione: non coincidono.**
`etl-js/transformers` porta cinque plugin (`cast`, `filter`, `default`, `rename`, `validate`)
perche' si installano sempre insieme; nelle Definition restano cinque nomi distinti e ognuno tiene la
propria versione. Un pacchetto dichiara i suoi con `export const plugins: Plugin[]`.

## Gli entry point

Un solo pacchetto, `etl-js`, con un import per area:

| Import | Cosa contiene |
|---|---|
| `etl-js` | `createEngine`, `run`, `validate`, `describe`, `preview`, `Registry`, eventi, driver Postgres |
| `etl-js/contracts` | tipi, `PROTOCOL_VERSION`, `EtlError`, utility SQL. **Zero dipendenze** |
| `etl-js/csv-reader` | reader CSV in streaming |
| `etl-js/postgres-writer` | writer con `append`, `upsert`, `replace-by` |
| `etl-js/transformers` | la libreria standard: `cast`, `filter`, `default`, `rename`, `validate` |
| `etl-js/lookup-transformer` | collega le righe a dati gia' sul database, in batch |

Il comando `etl-js` arriva con il pacchetto.

## Un flusso, un file

Questa e' l'intera configurazione di un flusso. Non c'e' nulla di specifico a questa origine se non
i valori: cambiano il delimitatore, l'encoding e i nomi delle colonne, non il codice.

```json
{
  "client": "acme",
  "source": { "type": "csv", "config": {
    "input": "dati.csv", "delimiter": ";", "encoding": "latin1", "skipRows": 3 } },
  "transform": [
    { "type": "filter", "config": { "drop": [{ "field": "Codice", "empty": true }] } },
    { "type": "rename", "config": { "map": { "Codice": "codice", "Data": "data_documento" } } },
    { "type": "cast",   "config": {
      "data_documento": { "date": "dd/MM/yyyy" },
      "quantita": { "number": { "decimal": ",", "thousands": "." } } } },
    { "type": "lookup", "config": {
      "db": "principale", "table": "anagrafica", "on": ["codice"],
      "select": "anagrafica_id", "onMissing": "reject" } },
    { "type": "validate", "config": { "rules": [
      { "field": "quantita", "min": 1, "severity": "reject" },
      { "field": "data_documento", "notBefore": "today", "severity": "warn" } ] } },
    { "type": "default", "config": { "values": {
      "run_id": { "fromMeta": "runId", "when": "always" },
      "riga_origine": { "fromMeta": "offset", "when": "always" } } } }
  ],
  "destination": { "type": "postgres", "config": {
    "table": "landing_righe", "strategy": "replace-by", "replaceKey": ["anagrafica_id"] } },
  "policy": { "maxFailedRatio": 0.2, "rejectFile": true }
}
```

Una seconda origine col punto e virgola al posto della virgola, le date all'americana e una colonna
in piu' e' un secondo file JSON, non un secondo pacchetto.

## Usarla da un altro programma

```ts
import { createEngine, createFileInput, createPostgresProvider } from "etl-js";
import { csvReader } from "etl-js/csv-reader";
import { postgresWriter } from "etl-js/postgres-writer";
import { transformers } from "etl-js/transformers";

const provider = await createPostgresProvider({
  principale: { connectionString: process.env.DATABASE_URL! },
});

const engine = createEngine().use(csvReader).use(postgresWriter).useAll(transformers);

const result = await engine.run(definition, {
  // In produzione questa risolve su object storage, e i plugin non cambiano.
  openInput: (ref) => apriDaS3(ref),
  db: (name) => provider.db(name),
  dbWrite: (name) => provider.dbWrite(name),
  secretRef: (ref) => vault.get(ref),
  log: mioLogger,
  signal: controller.signal,
}, {
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
npm run build             # tsc su src/ -> dist/
npm run typecheck:tests   # i test non sono type-checkati da vitest
npm test                  # vitest run
npm run check:boundaries  # dependency-cruiser: I2 + I9
npm run check             # tutti e quattro
npm run check:docs        # documentazione: a comando, non bloccante

PG_TEST_URL=postgres://... npm test    # include anche i test d'integrazione
```
