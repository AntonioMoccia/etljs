# Limiti

Cosa `etl-js` **non** fa, perche', e come si fa comunque. Sono i confini scelti: sapere dove sono
serve piu' di una lista di funzionalita'.

## La forma di un run e' fissa

**Un run = una sorgente → N transformer in sequenza → una destinazione.**

Non ci sono: join fra due sorgenti, fan-out verso piu' destinazioni, rami condizionali, esecuzione
parallela degli stadi, cicli.

Se ti serve unire due file: importali in due landing table e uniscili con una query, oppure metti il
secondo in una tabella e usa `lookup`. Se ti serve un ramo condizionale, sono due Definition con un
`filter` diverso in testa.

## Due tabelle in un solo run: no

`Definition` ha **una** `destination`. Tre strade, in ordine di quanto rispettano il progetto:

| Come | Atomico | Costo |
|---|---|---|
| **Landing table + promozione dell'host** — il modo previsto | si', la promozione e' SQL tuo in una transazione tua | zero |
| **Un writer plugin che scrive N tabelle** | si', una sola transazione | ~100 righe, zero modifiche al core |
| Due Definition, due run | no | zero, ma legge il file due volte |

La seconda e' meno difficile di quanto sembri: `WriteSession.write(batch)` riceve il lotto e la
transazione offre `bulkLoad` e `exec`. Un writer con config
`{ "tables": [{ "table": "testate", "columns": [...] }, { "table": "righe", "columns": [...] }] }`
smista le colonne in due `bulkLoad` dentro la **stessa** transazione.

La prima resta la raccomandata, e non per pigrizia: la decisione di fondo e' che **l'ETL non si
accoppia al modello del database**. Atterra in una tabella piatta e l'host, che quel modello lo
conosce, promuove.

## Eseguire una procedura durante il caricamento: non c'e' il gancio

Nella `Definition` non esistono hook di ciclo di vita. `onRunStart`/`onRunEnd` sono **osservazione**:
best-effort, con gli errori ingoiati, fuori dalla transazione.

Oggi la procedura si chiama in due punti:

- **dentro il writer**, con `tx.exec("CALL aggiorna_piani($1)", [runId])` prima del commit: e'
  atomica coi dati. Serve un writer plugin, o un'opzione `afterLoad` in `plugin-postgres`;
- **nell'host, dopo `run()`**: semplice ma non atomico. Se la procedura fallisce, i dati sono dentro.

**Da un transformer non si puo'**, e non per convenzione: il pool di lettura si connette con
`default_transaction_read_only=on`, quindi e' Postgres a rifiutare una procedura che scrive.

Un `afterLoad` parametrizzato in `plugin-postgres` e' l'aggiunta piu' sensata che manchi, e non tocca
nessun invariante.

## Una funzione JavaScript dentro la config: no, per scelta

La config e' un **dato** perche' una GUI deve poterla generare, perche' si diffa e si valida, e
perche' se le Definition arrivano da fuori, `{"code": "..."}` e' esecuzione di codice arbitrario sul
tuo server.

**Il meccanismo per la logica custom esiste: e' il plugin.** Sono ~60 righe e un `npm install`, e
poi lo usi per nome senza toccare niente — vedi [scrivere-un-plugin.md](scrivere-un-plugin.md).

Una via di mezzo difendibile: un plugin che riceve dalla config il **riferimento** a un modulo e il
percorso a una funzione (`{"module": "./custom.js", "fn": "acme.normalizza"}`). E' JSON, quindi I1
regge. Non c'e' oggi; se lo si aggiunge, tre
accortezze non sono opzionali: risoluzione del modulo **confinata** dall'host, navigazione del
percorso puntato che blocchi `__proto__` e `constructor`, e la consapevolezza che dentro quella
funzione nessuno ti impedisce di fare una query per riga.

## Il reader legge da un `ref`, non da un flusso qualsiasi

`ctx.openInput(ref)` restituisce un `AsyncIterable<Uint8Array>`, quindi ci entra un file, un oggetto
su storage, una risposta HTTP o dei byte in memoria. Non ci entra un flusso **push** senza fine (una
coda, un websocket): il modello e' un'importazione che comincia e finisce, non uno stream continuo.

## I plugin non si caricano a runtime

Nel v1 i plugin si collegano **in codice**, con `createEngine().use(...)`: non esiste un modo per
dire "carica il plugin che l'utente ha appena installato" partendo da un nome in una Definition.

E' una semplificazione voluta. La risoluzione per nome da npm c'era, quando il progetto era un
monorepo di pacchetti separati; con un pacchetto unico non ci sono piu' pacchetti da risolvere, e
nessuno la usava. Il codice resta nella storia git (commit "Fase 3") e torna quando serve davvero:
una GUI dove l'utente installa plugin, o un multi-tenant dove ogni flusso ha i suoi.

Conseguenza da sapere in anticipo: anche quando tornera', **aggiornare o disinstallare un plugin
richiedera' il riavvio del processo**. Il modulo e' nella cache di Node, e ricaricarlo lascerebbe in
giro due versioni della stessa cosa. E' lo stesso vincolo di Node-RED e n8n, per lo stesso motivo.

Nel frattempo un plugin di terzi si usa come qualunque dipendenza:

```ts
import { maiuscoloTransformer } from "@acme/etl-plugin-maiuscolo";
const engine = createEngine().use(csvReader).use(maiuscoloTransformer).use(postgresWriter);
```

## Il core non ricorda niente

Niente persistenza dei run, niente coda, niente scheduler, niente ripresa da dove si era interrotto.
`run()` esegue e restituisce un `RunResult`: salvarlo, riprovare, notificare e pianificare sono
compito dell'applicazione.

Non e' una mancanza: e' cio' che rende la libreria incorporabile senza portarsi dietro un database
suo.

## Non c'e' checkpoint: un run riparte da capo

Se un run fallisce a meta' di un file da un milione di righe, il rollback annulla tutto e il
successivo ricomincia dall'inizio. Con `replace-by` questo e' sicuro (rimandare lo stesso file non
duplica), ma costa tempo.

Un import a scaglioni si fa oggi spezzando il file, o con un `filter` su un intervallo di righe.

## `lookup` confronta le chiavi come stringhe

Se la colonna del database e' numerica, **`cast` deve girare prima di `lookup`**. E' documentato ma
non impedito: una chiave `"00123"` non trovera' l'intero `123`.

## Postgres e' l'unico writer

`plugin-postgres` e il driver del core sono specifici. I contratti non lo sono: `WriteTransaction`
espone `query`, `exec`, `bulkLoad`, `commit`, `rollback` — niente che sia peculiare di Postgres, e
`bulkLoad` prende tabella, colonne e righe, non una istruzione `COPY`.

Un writer MySQL o SQL Server significa: un plugin writer e un provider di connessioni nel core. Non
tocca ne' i contratti ne' la pipeline.

## Encoding: utf8 e latin1

Sono quelli nativi di Node. Per un CP-1250 o uno Shift-JIS serve `iconv-lite` nel reader CSV: una
dipendenza in piu' che non e' stata aggiunta perche' non serviva ai casi reali. E' un cambio
contenuto e localizzato in un file.

## Cosa e' provato e cosa no

| | |
|---|---|
| **Provato senza database** | reader CSV in streaming, tutti i transformer, la pipeline, `createEngine`, la soglia di scarto, gli eventi, la codifica dei valori per `COPY`, la forma dell'SQL prodotto dal writer, e che ogni subpath di `exports` sia importabile dal compilato |
| **Provato solo con `PG_TEST_URL`** | `COPY` end-to-end, transazioni reali, sola lettura imposta dal server, `replace-by` che non duplica, rollback totale |
| **Non provato** | volumi reali su un database vero: la logica c'e' ed e' in streaming, ma nessuno ha ancora importato un file da due giga |

```bash
PG_TEST_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

## In sintesi

`etl-js` fa una cosa: **prendere un file di un flusso, renderlo dati, e metterlo in una tabella in
modo ripetibile**. Tutto cio' che sta prima (chi decide quando) e dopo (chi promuove i dati nel
modello di dominio) e' dell'applicazione che la usa. Questa e' la scelta, non un residuo da colmare.
