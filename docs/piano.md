# Piano a fasi

Ogni fase e' completa quando il suo criterio e' soddisfatto **e** `npm run check` passa
(build, typecheck dei test, test, confini).

| Fase | Obiettivo | Criterio di done | Stato |
|------|-----------|------------------|-------|
| 0 | Fondazione: monorepo, contracts, core, cli, plugin-csv, plugin-postgres, dependency-cruiser, vitest | l'esempio gira in dry-run; `check:boundaries` fallisce se un plugin importa `core`; almeno un test verde | fatta |
| 1 | Manifest e auto-descrizione: `describe`, `validate`, `listPlugins` | una config invalida e' rifiutata con messaggio chiaro; `describe('csv')` ritorna lo schema | fatta |
| 2 | Loader dinamico: `await import(name)`, check protocollo, registry come cache | si aggiunge un plugin per nome senza toccare `core`; protocollo incompatibile da' errore diagnostico | fatta |
| 3 | `lookup`: query batch `= ANY($1)`, cache per run, `onMissing` | presenti/assenti/misti coperti da test; `pipeline.ts` non toccato | fatta |
| 4 | `cast`, `filter`, `default`, `rename` | casi felici e di errore per ognuno; `pipeline.ts` intatto | fatta |
| 5 | `validate` e scarto: severity, provenienza, `maxFailedRatio`, file di scarto | file al 10% invalido -> import parziale; al 40% -> run annullato | fatta |
| 6 | Errori ed eventi: `EtlError` classificato, eventi run, log strutturato, retry con jitter | un host ricostruisce avanzamento ed errori dai soli eventi | fatta |
| 7 | Writer `replace-by`/`upsert`: staging + transazione | re-import per chiave non duplica; errore a meta' -> rollback totale | fatta |
| 8 | Harness `@etl-js/testing`: `testTransformer`, `mockCtx` | i test dei plugin girano senza servizi esterni; esempi documentati | fatta |

Una deviazione dall'ordine: **`@etl-js/testing` e' stato costruito prima della fase 3**, non alla 8.
Sei plugin avevano bisogno dello stesso harness, e scriverlo sei volte per poi buttarlo non aveva senso.
Alla fase 8 sono arrivati i suoi test e la documentazione.

## Come si prova che gli invarianti reggono

Non a parole: ogni invariante ha qualcosa che fallisce se lo violi.

| Invariante | Cosa lo verifica |
|------------|------------------|
| I1 config = dato | `core.validate()` lavora su JSON puro; `describe()` produce JSON Schema |
| I2 il core non conosce i plugin | `test/boundaries.test.ts` pianta un import proibito in `core` e pretende che depcruise fallisca; `test/loader-npm.test.ts` esegue l'esempio con un registry **vuoto** |
| I3 batch/async/serializzabili | le date escono come stringhe ISO, non come `Date` |
| I4 transformer senza effetti | `pipeline.test.ts` verifica che il `ctx` dei transformer **non abbia** `dbWrite`; il pool di lettura si connette con `default_transaction_read_only=on` |
| I5 mai una query per riga | `lookup.test.ts` conta le interrogazioni: una per lotto, zero se il lotto e' in cache |
| I6 connessioni dal core | il writer riceve una transazione gia' aperta; nessun plugin importa `pg` |
| I7 SQL parametrizzato | i test controllano che i valori **non** compaiano nel testo dell'istruzione e che gli identificatori ostili siano quotati |
| I8 un cliente = un file | `examples/acme.json` non contiene nulla di specifico ad Acme se non i valori |
| I9 grafo delle dipendenze | `npm run check:boundaries`, con cinque sonde che ne verificano il funzionamento |

`pipeline.ts` e' cambiato solo tre volte, e mai per un plugin: fase 0 (il motore), fase 1 (validare
prima di partire), fase 5 e 6 (soglia di scarto e classificazione degli errori). Aggiungere sei
transformer non l'ha toccato.

## Cosa non e' stato verificato in questo ambiente

Non c'e' Postgres ne' Docker su questa macchina. Il percorso verso un database vero e' coperto da due
suite che si saltano da sole senza `PG_TEST_URL`:

- `packages/core/test/postgres.integration.test.ts` - `COPY`, transazioni, sola lettura imposta dal
  server, identificatori ostili.
- `test/postgres-e2e.test.ts` - `replace-by` che non duplica, rollback totale, `upsert`.

```bash
PG_TEST_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

Cio' che si puo' provare senza database e' provato senza database: la codifica dei valori per `COPY`
(dove stanno i bug veri: tabulatori, a capo, backslash, `\N` letterale, date, NaN) ha dieci test
propri, e le forme dell'SQL prodotto dal writer sono verificate su una transazione finta.

## Dopo le fasi

Tre cambi arrivati dopo il piano, tutti su richiesta e tutti con la suite verde a fine lavoro:

- **`ctx.openInput`**: il reader non apre piu' file da se'. `plugin-csv` e' passato a `csv-parse` e
  `config.path` e' diventato `config.input`.
- **`@etl-js/plugin-transforms`**: i cinque transformer di base in un pacchetto solo, e
  `PluginModule.plugins` perche' il loader sappia gestirlo. `lookup` e' rimasto separato.
- **`IngestError` e' diventato `EtlError`.**

## Debiti dichiarati

- `RunResult.rejects` e' limitato a 1000 righe per non far esplodere la memoria su un file
  interamente sbagliato; per averli tutti si ascolta l'evento `onRecordFailed`, che non ha limiti.
  La CLI lo fa gia' con `--rejects`.
- Il reader CSV assume che il file stia su disco. Uno `stdin`/S3 sarebbe un altro reader, non una
  modifica a questo.
- `lookup` confronta le chiavi convertendole in stringa: se la colonna del gestionale e' numerica,
  `cast` deve girare **prima** del lookup. La Definition d'esempio lo fa.
