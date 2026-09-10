# Guida rapida

Dal repository appena clonato al primo import, con e senza database.

## Installare

```bash
npm install
npm run build
```

Node 18.18 o superiore. `pg` e `pg-copy-streams` sono dipendenze **opzionali** del core: senza
Postgres tutto il resto funziona, e la CLI se ne accorge solo quando provi a scrivere davvero.

Comodita': `alias etl='node packages/cli/dist/bin.js'` — nel resto della pagina si usa quello.

## Guardarsi intorno

```bash
etl plugins            # cosa e' installato, coi manifest completi
etl describe csv       # il JSON Schema della config del reader CSV
```

`describe` e' la stessa cosa che leggera' una GUI per disegnare il modulo di configurazione: non c'e'
una documentazione dei parametri separata dal codice, lo schema **e'** la documentazione.

## Un import in cinque minuti

Il repository contiene un CSV volutamente sporco — `examples/acme.csv` — con tre righe di
intestazione, il punto e virgola, l'encoding latin1, una riga vuota in mezzo e una riga di totali in
fondo:

```
Piano di consegna - ACME S.p.A.
Generato il 03/02/2026

Nr Ordine;Data;Quantita;Città
ORD-1001;03/02/2026;1.250,50;Perugia
ORD-1002;04/02/2026;12;Città di Castello
;;;
ORD-1003;05/02/2026;7,5;Assisi
TOTALE;;1.270,00;
```

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
CREATE TABLE landing_piani_consegna (
  ordine_id     integer,
  ordine_cliente text,
  data_consegna date,
  quantita      numeric,
  run_id        text,
  file_origine  text,
  riga_origine  integer
);
```

```bash
export DATABASE_URL='postgres://utente:password@localhost:5432/gestionale'
etl run examples/acme.json --db gestionale=env:DATABASE_URL --rejects scarti.csv
```

La credenziale non passa dalla riga di comando: `env:NOME` la fa leggere dall'ambiente, cosi' non
finisce nella cronologia della shell ne' nell'elenco dei processi.

`--rejects` scrive le righe rifiutate **man mano che arrivano**, non alla fine: un file interamente
sbagliato non fa esplodere la memoria.

```csv
run_id;file;riga;severita;codice;motivo;riga_originale
"93885a05";"examples/acme.csv";"3";"reject";"LOOKUP_MISSING";"nessuna corrispondenza in ordini per ordine_cliente=";"{...}"
```

## Leggere la Definition dell'esempio

```json
{
  "client": "acme",
  "source": { "type": "csv", "config": {
    "input": "examples/acme.csv", "delimiter": ";", "encoding": "latin1", "skipRows": 3 } },
  "transform": [
    { "type": "filter",   "config": { "drop": [{ "field": "Nr Ordine", "empty": true }] } },
    { "type": "rename",   "config": { "map": { "Nr Ordine": "ordine_cliente", "Data": "data_consegna", "Quantita": "quantita" } } },
    { "type": "cast",     "config": {
        "data_consegna": { "date": "dd/MM/yyyy" },
        "quantita":      { "number": { "decimal": ",", "thousands": "." } } } },
    { "type": "lookup",   "config": {
        "db": "gestionale", "table": "ordini", "on": ["ordine_cliente"],
        "select": "ordine_id", "onMissing": "reject" } },
    { "type": "validate", "config": { "rules": [
        { "field": "quantita",      "min": 1,               "severity": "reject" },
        { "field": "data_consegna", "notBefore": "today",   "severity": "warn" } ] } },
    { "type": "default",  "config": { "values": {
        "run_id":       { "fromMeta": "runId",  "when": "always" },
        "file_origine": { "fromMeta": "source", "when": "always" },
        "riga_origine": { "fromMeta": "offset", "when": "always" } } } }
  ],
  "destination": { "type": "postgres", "config": {
    "db": "gestionale", "table": "landing_piani_consegna",
    "strategy": "replace-by", "replaceKey": ["ordine_id"] } },
  "policy": { "maxFailedRatio": 0.2, "rejectFile": true }
}
```

**L'ordine dei passaggi conta**, e lo decide la Definition:

- `filter` prima di `rename`, perche' lavora sulle intestazioni originali del cliente;
- `cast` prima di `lookup`, perche' la chiave di ricerca dev'essere del tipo giusto;
- `validate` dopo `cast`, perche' `min: 1` su una stringa non vuol dire niente;
- `default` per ultimo, perche' marca cio' che e' sopravvissuto.

**`replace-by` e' il motivo per cui si puo' rimandare lo stesso file due volte.** Il cliente manda il
piano aggiornato di certi ordini: il writer cancella dalla landing table **solo quelle chiavi** e
reinserisce. Gli ordini non citati nel file non vengono toccati.

## Un secondo cliente

Punto e virgola diventa virgola, la data e' all'americana, c'e' una colonna in piu' e le settimane al
posto delle date:

```json
{
  "client": "beta",
  "source": { "type": "csv", "config": { "input": "beta.csv", "delimiter": "," } },
  "transform": [
    { "type": "rename", "config": { "map": { "Order": "ordine_cliente", "Week": "settimana" } } },
    { "type": "cast",   "config": { "settimana": { "week": "ww/yyyy" } } },
    { "type": "lookup", "config": {
        "db": "gestionale", "table": "ordini", "on": ["ordine_cliente"], "select": "ordine_id" } }
  ],
  "destination": { "type": "postgres", "config": {
    "table": "landing_piani_consegna", "strategy": "replace-by", "replaceKey": ["ordine_id"] } }
}
```

**Un secondo file JSON, non un secondo pacchetto.** Nessun sorgente di questo progetto e' cambiato.

## Il file di ingresso cambia ogni settimana

La Definition e' il modello del cliente, non del singolo file. Il file del giorno si passa cosi':

```bash
etl run clienti/acme.json --input /var/spool/acme/2026-02-10.csv
```

`--input` riscrive `source.config.input`. E' una riscrittura del **dato**, non un ramo nel motore.

## Da un altro programma

```ts
import { Registry, createFileInput, createLoader, createPostgresProvider, run } from "@etl-js/core";

const provider = await createPostgresProvider({
  gestionale: { connectionString: process.env.DATABASE_URL! },
});
const registry = new Registry();

const result = await run(definition, {
  openInput: createFileInput({ baseDir: "/var/spool" }),
  db:        (name) => provider.db(name),
  dbWrite:   (name) => provider.dbWrite(name),
  secretRef: (ref) => vault.get(ref),
  log:       mioLogger,
  signal:    controller.signal,
}, {
  registry,
  resolve: createLoader({ registry }),
  events: {
    onBatch:        (e) => barra.aggiorna(e.read, e.written),
    onRecordFailed: (e) => scarti.salva(e.failed),
    onRunEnd:       (e) => registro.chiudi(e.result, e.error),
  },
});
```

`baseDir` non e' un dettaglio: senza, un `input` che arriva da una Definition puo' leggere qualunque
file della macchina. Vedi [api.md](api.md#createfileinput).

## Comandi

```bash
npm run build             # tsc --build su tutti i workspace
npm run typecheck:tests   # vitest non type-checka: questo si'
npm test                  # vitest run
npm run check:boundaries  # dependency-cruiser
npm run check             # tutti e quattro

PG_TEST_URL=postgres://... npm test   # include i test d'integrazione, altrimenti saltati
```
