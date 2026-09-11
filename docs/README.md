# Documentazione di etl-js

`etl-js` e' un motore di importazione dati a plugin: una **libreria senza stato** che si incorpora in
un'applicazione piu' grande. Legge una sorgente, trasforma le righe, le scrive in una destinazione
transazionale, e racconta a chi la usa che cosa e' successo.

Il caso d'uso che ne ha guidato ogni scelta: far confluire file CSV di formati diversi in una
tabella unica, collegandoli a dati gia' presenti su Postgres. **Un flusso non ha mai codice proprio:
ha un file di configurazione JSON.**

## Da dove cominciare

| Se vuoi... | Leggi |
|---|---|
| capire come funziona, in 10 minuti | [Concetti](concetti.md) |
| far girare il primo import | [Guida rapida](guida-rapida.md) |
| scrivere la configurazione di un flusso | [La Definition](definition.md) e [I plugin](plugin.md) |
| usare la libreria da un altro programma | [API](api.md) |
| capire un errore o gestire gli scarti | [Errori, eventi e scarti](errori.md) |
| aggiungere logica tua | [Scrivere un plugin](scrivere-un-plugin.md) |
| sapere cosa **non** fa | [Limiti](limiti.md) |

Documenti di progetto: [gli invarianti e le regole di lavoro](../CLAUDE.md), [lo stato delle
fasi](piano.md).

## In tre righe

```ts
import { createEngine } from "etl-js";
import csv from "etl-js/csv";
import postgres from "etl-js/postgres";

const engine = createEngine().use(csv).use(postgres);
const result = await engine.run(definition, ctx);
```

Colleghi i plugin che vuoi, passi una Definition e un contesto, ottieni un `RunResult`.

## La mappa in una figura

```
   i plugin li colleghi tu                 il contesto lo fornisci tu
   createEngine().use(csv).use(postgres)   openInput / db / dbWrite / secretRef / log / signal
                  |                                      |
                  v                                      v
             engine.run(definition, ctx) ----------------+
                  |
                  |   reader          transformer*              writer
                  +--> csv ---Batch--> filter, rename, cast ---> postgres
                       (streaming)     lookup, validate,          (transazione)
                                       default
                                          |
                                          +--> Failed[] --> eventi --> file di scarto

             RunResult { read, written, failed, aborted, durationMs }
```

Il motore non conosce nessuno dei nomi scritti li' dentro: li riceve da `use()` e li cerca per
`manifest.name` quando una Definition li cita.

## Gli entry point

Un solo pacchetto npm, `etl-js`, con un import per area. Le dipendenze puntano tutte verso i
contratti, e non e' una convenzione: `npm run check:boundaries` lo verifica, e sei test piantano un
import proibito per assicurarsi che il controllo funzioni davvero.

| Import | Contiene | Dipende da |
|---|---|---|
| `etl-js/contracts` | tipi, `PROTOCOL_VERSION`, `EtlError`, utility SQL | **niente** |
| `etl-js` | `createEngine`, `run`, `validate`, `describe`, `preview`, eventi, driver Postgres | contracts, ajv, pg |
| `etl-js/csv` | reader CSV | contracts, csv-parse |
| `etl-js/transforms` | `cast`, `filter`, `default`, `rename`, `validate` | contracts, zod |
| `etl-js/lookup` | `lookup` | contracts, zod |
| `etl-js/postgres` | writer Postgres | contracts, zod |

Il comando `etl-js` arriva col pacchetto. `pg` e `pg-copy-streams` sono **opzionali**: senza Postgres
tutto il resto funziona.

**Un entry point non e' un plugin.** `exports` dice cosa puoi importare, `use()` dice cosa partecipa
a un'importazione: `etl-js/transforms` e' un import solo che porta **cinque** plugin.

## Le nove regole che spiegano tutto il resto

Ogni scelta strana di questa libreria discende da uno di questi vincoli. Sono spiegati per esteso in
[CLAUDE.md](../CLAUDE.md), ma vale la pena averli sotto mano mentre si legge il resto:

1. **La config e' un dato JSON**, non codice: una GUI deve poterla generare.
2. **Il core non nomina mai un plugin.** Nessun `if (type === "csv")` da nessuna parte.
3. **I contratti sono a lotti, asincroni e serializzabili.**
4. **I transformer non scrivono.** Leggono, anche dal database, ma non scrivono.
5. **Mai una query per riga.** I lookup sono in batch.
6. **Le connessioni le fornisce il core**, i plugin non le aprono e non vedono credenziali.
7. **SQL sempre parametrizzato**, identificatori escapati, operatori in whitelist.
8. **Un flusso = un file di config.** Un nome di flusso nel codice significa che manca un parametro.
9. **Le dipendenze puntano verso i contratti.**
