# Guida rapida

Dal repository appena clonato al primo import, con e senza database.

## Installare

```bash
npm install etljs
```

Node 18.18 o superiore. `pg` e `pg-copy-streams` sono dipendenze **opzionali**: senza Postgres tutto
il resto funziona, e te ne accorgi solo quando provi a scrivere davvero.

## Il primo import, da codice

```ts
import { createEngine, createFileInput } from "etljs";
import { csvReader } from "etljs/csv-reader";
import { postgresWriter } from "etljs/postgres-writer";
import { transformers } from "etljs/transformers";

const engine = createEngine().use(csvReader).use(postgresWriter).useAll(transformers);

const result = await engine.run(definition, {
  openInput: createFileInput({ baseDir: "/var/spool" }),
  db: () => { throw new Error("questo import non usa il database"); },
  secretRef: (ref) => process.env[ref] ?? "",
  log: mioLogger,
  signal: new AbortController().signal,
});

console.log(`${result.written} righe su ${result.read}, ${result.failed} scartate`);
```

Tre cose, e sono tutto il modello:

1. **Colleghi i plugin** con `use()`. Il motore non ne conosce nessuno: se una Definition cita un
   `type` che non hai collegato, fallisce con `PLUGIN_NOT_FOUND` prima di leggere una riga.
2. **Fornisci il contesto**: da dove arrivano i byte, quali database, dove finiscono i log. Sono
   cose dell'applicazione, non della libreria.
3. **Passi una Definition** - un JSON - e ricevi un `RunResult`.

## Il primo import, da riga di comando

Il pacchetto porta con se' il comando `etljs`, con tutti i plugin gia' collegati:

```bash
npx etljs plugins                      # cosa e' collegato, coi manifest completi
npx etljs describe csv                 # il JSON Schema della config del reader CSV
```

`describe` e' la stessa cosa che leggera' una GUI per disegnare il modulo di configurazione: non
c'e' una documentazione dei parametri separata dal codice, **lo schema e' la documentazione**.

Dal repository, invece che dal pacchetto installato:

```bash
npm install && npm run build
node dist/cli/bin.js plugins
```

Nel resto della pagina `etl` sta per `npx etljs` (o `node dist/cli/bin.js`).

## Un import in cinque minuti

Il repository contiene un CSV volutamente sporco, `examples/acme.csv`, con tutto cio' che rende
antipatico un file vero:

| | |
|---|---|
| tre righe di preambolo | il titolo del report e la data di generazione |
| una riga vuota | fra il preambolo e l'intestazione |
| punto e virgola | invece della virgola |
| encoding latin1 | con accenti dentro i valori |
| decimali all'italiana | `1.250,50` |
| una riga tutta vuota | in mezzo ai dati |
| una riga di totali | in fondo, che non e' un dato |

Ed `examples/acme.json`, la Definition che lo legge.

### 1. Controllare la configurazione senza eseguirla

```bash
etl validate examples/acme.json
```

`validate` non legge il file, non apre il database e non esegue niente: controlla che i plugin
esistano, che siano del tipo giusto e che ogni config rispetti il proprio schema. Riporta **tutti** i
problemi insieme, ciascuno col punto esatto:

```
/tmp/rotta.json: 5 rilievi
  errore  source.config.input: campo obbligatorio mancante: input
  errore  source.config: chiave non prevista: delimitatore
  errore  source.config.skipRows: tipo errato: atteso integer
  errore  destination.config.strategy: valore non ammesso; validi: append, upsert, replace-by
  errore  policy.maxFailedRatio: deve essere un numero fra 0 e 1
```

### 2. Vedere cosa uscirebbe

```bash
etl preview examples/acme-fase0.json -n 3
```

`preview` esegue la pipeline **a vuoto** sulle prime `n` righe della sorgente e mostra sia le righe
sopravvissute sia gli scarti col motivo. Non apre nemmeno la destinazione.

Attenzione alla semantica di `n`: limita le righe **lette**, non quelle in uscita. La domanda a cui
risponde e' *"che cosa succede alle prime n righe di questo file?"* — se un filtro ne scarta meta',
ne vedrai meno di `n`, e sotto ci sara' scritto perche'.

### 3. Eseguire senza scrivere

```bash
etl run examples/acme-fase0.json --dry-run
```

```json
{
  "runId": "93885a05-b4db-469a-a6db-132ff41e57c2",
  "read": 5, "written": 5, "failed": 0,
  "aborted": false, "durationMs": 27,
  "rejects": []
}
```

In dry-run la destinazione **non viene nemmeno aperta**: nessuna transazione, nessuna connessione.

### 4. Eseguire per davvero

Serve un Postgres e una tabella di atterraggio:

```sql
CREATE TABLE landing_righe (
  anagrafica_id     integer,
  codice text,
  data_documento date,
  quantita      numeric,
  run_id        text,
  file_origine  text,
  riga_origine  integer
);
```

```bash
export DATABASE_URL='postgres://utente:password@localhost:5432/database'
etl run examples/acme.json --db principale=env:DATABASE_URL --rejects scarti.csv
```

La credenziale non passa dalla riga di comando: `env:NOME` la fa leggere dall'ambiente, cosi' non
finisce nella cronologia della shell ne' nell'elenco dei processi.

`--rejects` scrive le righe rifiutate **man mano che arrivano**, non alla fine: un file interamente
sbagliato non fa esplodere la memoria.

```csv
run_id;file;riga;severita;codice;motivo;riga_originale
"93885a05";"examples/acme.csv";"3";"reject";"LOOKUP_MISSING";"nessuna corrispondenza in anagrafica per codice=";"{...}"
```

## Leggere la Definition dell'esempio

Apri `examples/acme.json`. In ordine, quello che fa:

| Stadio | Cosa risolve |
|---|---|
| `csv` | delimitatore, encoding e le tre righe di preambolo |
| `filter` | butta le righe senza chiave e quella dei totali |
| `rename` | porta le intestazioni del file sui nomi interni |
| `cast` | date `dd/MM/yyyy` e decimali con la virgola |
| `lookup` | collega ogni riga a un record gia' presente sul database |
| `validate` | quantita' sotto il minimo, date nel passato |
| `default` | marca ogni riga con run, file e numero di riga |
| `postgres` | scrive con `replace-by`, cosi' un secondo import non duplica |

**L'ordine dei passaggi conta**, e lo decide la Definition:

- `filter` prima di `rename`, perche' lavora sulle intestazioni originali del flusso;
- `cast` prima di `lookup`, perche' la chiave di ricerca dev'essere del tipo giusto;
- `validate` dopo `cast`, perche' `min: 1` su una stringa non vuol dire niente;
- `default` per ultimo, perche' marca cio' che e' sopravvissuto.

**`replace-by` e' il motivo per cui si puo' rimandare lo stesso file due volte.** Il flusso manda il
piano aggiornato di certi anagrafica: il writer cancella dalla landing table **solo quelle chiavi** e
reinserisce. Gli anagrafica non citati nel file non vengono toccati.

## Un secondo flusso

Punto e virgola diventa virgola, la data e' all'americana, c'e' una colonna in piu' e le settimane al
posto delle date:

```json
{
  "client": "beta",
  "source": { "type": "csv", "config": { "input": "beta.csv", "delimiter": "," } },
  "transform": [
    { "type": "rename", "config": { "map": { "Order": "codice", "Week": "settimana" } } },
    { "type": "cast",   "config": { "settimana": { "week": "ww/yyyy" } } },
    { "type": "lookup", "config": {
        "db": "principale", "table": "anagrafica", "on": ["codice"], "select": "anagrafica_id" } }
  ],
  "destination": { "type": "postgres", "config": {
    "table": "landing_righe", "strategy": "replace-by", "replaceKey": ["anagrafica_id"] } }
}
```

**Un secondo file JSON, non un secondo pacchetto.** Nessun sorgente di questo progetto e' cambiato.

## Il file di ingresso cambia ogni settimana

La Definition e' il modello del flusso, non del singolo file. Il file del giorno si passa cosi':

```bash
etl run flussi/acme.json --input /var/spool/acme/2026-02-10.csv
```

`--input` riscrive `source.config.input`. E' una riscrittura del **dato**, non un ramo nel motore.

## In produzione: connessioni, eventi, scarti

L'esempio di prima senza database. Con Postgres, gli eventi e un vero logger diventa cosi':

```ts
import { createEngine, createFileInput, createPostgresProvider } from "etljs";
import { csvReader } from "etljs/csv-reader";
import { postgresWriter } from "etljs/postgres-writer";
import { lookupTransformer } from "etljs/lookup-transformer";
import { transformers } from "etljs/transformers";

const provider = await createPostgresProvider({
  principale: { connectionString: process.env.DATABASE_URL! },
});

const engine = createEngine().use(csvReader).use(postgresWriter).use(lookupTransformer).useAll(transformers);

const result = await engine.run(definition, {
  openInput: createFileInput({ baseDir: "/var/spool" }),
  db:        (name) => provider.db(name),
  dbWrite:   (name) => provider.dbWrite(name),
  secretRef: (ref) => vault.get(ref),
  log:       mioLogger,
  signal:    controller.signal,
}, {
  events: {
    onBatch:        (e) => barra.aggiorna(e.read, e.written),
    onRecordFailed: (e) => scarti.salva(e.failed),
    onRunEnd:       (e) => registro.chiudi(e.result, e.error),
  },
});
```

`baseDir` non e' un dettaglio: senza, un `input` che arriva da una Definition puo' leggere qualunque
file della macchina. Vedi [api.md](api.md#createfileinput).

Gli eventi sono **osservazione**: il motore non ne aspetta l'esito e ingoia i loro errori, cosi' un
bug nella barra di avanzamento non annulla un'importazione. Per raccogliere **tutti** gli scarti si
usa `onRecordFailed`, che non ha limiti, mentre `RunResult.rejects` e' troncato a 1000 righe.

## Comandi

```bash
npm run build             # tsc su src/ -> dist/
npm run typecheck:tests   # vitest non type-checka: questo si'
npm test                  # vitest run
npm run check:boundaries  # dependency-cruiser
npm run check             # tutti e quattro
npm run check:docs        # documentazione: a comando, non bloccante

PG_TEST_URL=postgres://... npm test   # include i test d'integrazione, altrimenti saltati
```
