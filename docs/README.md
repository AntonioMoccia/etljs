# Documentazione di etl-js

`etl-js` e' un motore di importazione dati a plugin: una **libreria senza stato** che si incorpora in
un'applicazione piu' grande. Legge una sorgente, trasforma le righe, le scrive in una destinazione
transazionale, e racconta a chi la usa che cosa e' successo.

Il caso d'uso che ne ha guidato ogni scelta: importare piani di consegna dai CSV dei clienti
collegandoli a ordini gia' presenti su un gestionale Postgres. **Un cliente non ha mai codice
proprio: ha un file di configurazione JSON.**

## Da dove cominciare

| Se vuoi... | Leggi |
|---|---|
| capire come funziona, in 10 minuti | [Concetti](concetti.md) |
| far girare il primo import | [Guida rapida](guida-rapida.md) |
| scrivere la configurazione di un cliente | [La Definition](definition.md) e [I plugin](plugin.md) |
| usare la libreria da un altro programma | [API](api.md) |
| capire un errore o gestire gli scarti | [Errori, eventi e scarti](errori.md) |
| aggiungere logica tua | [Scrivere un plugin](scrivere-un-plugin.md) |
| sapere cosa **non** fa | [Limiti](limiti.md) |

Documenti di progetto: [gli invarianti e le regole di lavoro](../CLAUDE.md), [lo stato delle
fasi](piano.md).

## La mappa in una figura

```
  Definition (JSON)                        Ctx (dall'host)
        |                                        |
        |                            openInput / db / dbWrite / secretRef
        v                                        |
   core.run() ------------------------------------
        |
        |   reader          transformer*              writer
        +--> csv ---Batch--> filter, rename, cast ---> postgres
             (streaming)     lookup, validate,          (transazione)
                             default
                                |
                                +--> Failed[] --> eventi --> file di scarto

   RunResult { read, written, failed, aborted, durationMs }
```

## I pacchetti

| Pacchetto | Contiene | Dipende da |
|---|---|---|
| `@etl-js/contracts` | tipi, `PROTOCOL_VERSION`, `EtlError`, utility SQL | **niente** |
| `@etl-js/core` | `run`, `validate`, `describe`, `preview`, loader, eventi, driver Postgres | contracts, ajv, pg |
| `@etl-js/testing` | `testTransformer`, `mockCtx`, `recordingDb` | contracts |
| `@etl-js/cli` | riga di comando | core + libreria standard |
| `@etl-js/plugin-csv` | reader CSV | contracts, csv-parse |
| `@etl-js/plugin-transforms` | `cast`, `filter`, `default`, `rename`, `validate` | contracts, zod |
| `@etl-js/plugin-lookup` | `lookup` | contracts, zod |
| `@etl-js/plugin-postgres` | writer Postgres | contracts, zod |

Il grafo punta tutto verso `contracts`, e non e' una convenzione: `npm run check:boundaries` lo
verifica, e sei test piantano un import proibito per assicurarsi che il controllo funzioni davvero.

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
8. **Un cliente = un file di config.** Un nome di cliente nel codice significa che manca un parametro.
9. **Le dipendenze puntano verso `contracts`.**
