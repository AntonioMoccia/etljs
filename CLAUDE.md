# etl-js

Motore di importazione dati a plugin, **libreria senza stato** destinata a essere incorporata in un
software piu' grande. Caso d'uso guida: importare piani di consegna da CSV dei clienti collegandoli a
ordini gia' presenti su un gestionale Postgres.

**Non fa parte di questo progetto:** GUI, server HTTP, autenticazione, coda/scheduling, persistenza di
run ed errori. Vivono nell'app che usa questa libreria. Se servono a un test, si mockano.

## Invarianti — non negoziabili

| #  | Invariante | Se violato |
|----|------------|------------|
| I1 | La config e' un **dato JSON serializzabile**, non codice | nessuna GUI potra' mai generarla |
| I2 | Il `core` non nomina mai un plugin concreto (nessun `if (type === 'csv')`, nessun import di un plugin) | il motore diventa un monolite |
| I3 | I contratti sono **batch, async, serializzabili** | niente lookup efficienti, DB, plugin remoti |
| I4 | I **transformer** sono side-effect free: leggono (anche dal DB via `ctx`), non scrivono | si perde l'idempotenza |
| I5 | **Mai una query per riga**: i lookup sono batch (`WHERE k = ANY($1)`) | inusabile a volumi reali |
| I6 | Le connessioni al DB le fornisce il `core` via `ctx`; un plugin non apre connessioni ne' vede credenziali (riceve `secretRef`) | impossibile gestire pool, transazioni, segreti |
| I7 | SQL sempre **parametrizzato**, identificatori escapati, operatori in whitelist | SQL injection |
| I8 | Un cliente = un file di config, **mai** un plugin. Nome di cliente nel codice = manca un parametro a un plugin generico | a 20 clienti, 20 pacchetti: progetto morto |
| I9 | Le dipendenze puntano verso `contracts`: `contracts` non dipende da nulla; i `plugin-*` dipendono solo da `contracts`, mai da `core`; `core` non dipende dai plugin | il grafo si accoppia |

I2 e I9 sono imposti da **dependency-cruiser** (`npm run check:boundaries`), non dalla disciplina.

## Regole di lavoro

- Si procede **una fase alla volta**; ogni fase ha un criterio di done verificabile (vedi `docs/piano.md`).
- Prima di dichiarare una fase completa: `npm run build && npm run typecheck:tests && npm test && npm run check:boundaries`
  devono passare (scorciatoia: `npm run check`).
- I test si scrivono **insieme** al codice, non dopo.
- **Se per aggiungere un transformer serve modificare `packages/core/src/pipeline.ts`, fermarsi e segnalarlo:
  l'astrazione e' sbagliata.** `pipeline.ts` cambia solo quando cambia il motore, mai quando cambia un plugin.
  Finora e' cambiato tre volte, e mai per un plugin: per il motore stesso, per validare prima di partire,
  per la soglia di scarto e la classificazione degli errori. Sei transformer non l'hanno toccato.
- Nessuna dipendenza nuova senza giustificazione scritta (vedi "Dipendenze" qui sotto). Si preferisce la
  libreria standard di Node.
- **Commenti in italiano, identificatori in inglese.** TypeScript `strict: true`, niente `any` implicito.

## Struttura

```
packages/
  contracts/        @etl-js/contracts   tipi + costanti/utility pure, ZERO dipendenze
  core/             @etl-js/core        registry, loader, pipeline, validate, describe, preview
  testing/          @etl-js/testing     harness per testare i plugin
  cli/              @etl-js/cli         usa core; nomina solo csv e postgres, il resto lo carica
  plugin-csv/       reader
  plugin-postgres/  writer: append, upsert, replace-by
  plugin-lookup/    transformer (cardine): collega al gestionale, in batch
  plugin-cast/ plugin-filter/ plugin-default/ plugin-rename/ plugin-validate/
```

I transformer **non** sono dipendenze della CLI: vengono caricati per nome dal loader quando una
Definition li cita. Se un giorno smettessero di funzionare cosi', il test
`cli > l'esempio completo e' valido con i plugin caricati da npm` diventerebbe rosso.

Grafo consentito: `contracts` <- `core`, `plugin-*`, `cli`, `testing`. I plugin dipendono **solo** da
`contracts`. Nessun plugin importa `core` o un altro plugin.

## Contratti

Le firme canoniche stanno in `packages/contracts/src/`. Non inventarne altre. Quattro estensioni deliberate
rispetto alla specifica iniziale, documentate qui perche' non siano riscoperte come "deviazioni":

1. **`WriterCtx extends Ctx`** aggiunge `dbWrite(name): Promise<WriteTransaction>`. `Ctx.db()` resta in
   sola lettura (I4/I6); il core passa un `WriterCtx` **solo** al writer della destinazione. `Writer.open`
   continua a dichiarare `ctx: Ctx`: `WriterCtx` ne e' un sottotipo.
2. **`WriteTransaction.bulkLoad(table, columns, rows)`** invece di esporre `COPY` nei contratti: il
   `COPY ... FROM STDIN` lo costruisce il driver dentro `core`, cosi' i contratti restano generici e
   l'escaping degli identificatori sta in un solo posto (I7).
3. **`Ctx.runId`**: ogni `Batch` deve dichiarare da quale run proviene
   (`Batch.meta.runId`) ed e' il reader a costruire i Batch, quindi il runId deve
   arrivargli dal contesto. `run()` lo genera se l'host non ne fornisce uno.
4. **`contracts` contiene anche costanti e utility pure** (`PROTOCOL_VERSION`, `IngestError`,
   `escapeIdentifier`, whitelist operatori), non solo tipi: se stessero in `core` i plugin non
   potrebbero usarle senza violare I9. Restano a zero dipendenze, e dependency-cruiser lo verifica.

## Dipendenze e loro giustificazione

| Pacchetto | Dipendenza | Perche' |
|-----------|------------|---------|
| contracts | *nessuna* | I9, verificato da dependency-cruiser |
| core | `ajv`, `ajv-formats` | il core valida le config contro il JSON Schema del manifest senza conoscere Zod ne' il plugin (I2) |
| core | `pg`, `pg-copy-streams` (optional) | il core e' l'unico a poter aprire connessioni (I6); import dinamico, cosi' chi non usa Postgres non li installa |
| plugin-* | `zod` | schema di config tipizzato + derivazione del JSON Schema con `z.toJSONSchema()` (zod v4, nessuna libreria di conversione a parte) |
| testing | *nessuna* | l'harness serve a provare i plugin, non puo' tirarsi dietro il core |
| dev | `typescript`, `vitest`, `dependency-cruiser` | build, test, confini |

Il parsing CSV e' scritto a mano (`plugin-csv/src/parser.ts`): serve streaming vero, delimitatore e
encoding configurabili e `skipRows`; sono ~150 righe testabili e ci evitano una dipendenza runtime nel
plugin piu' usato.

## Dove stanno le decisioni gia' prese

- Le **date** escono da `cast` come stringhe ISO (`"2026-02-03"`), non come oggetti `Date`: un Batch
  deve restare serializzabile (I3).
- La **provenienza** di una riga (run, file, numero di riga) si aggiunge con `default` e `fromMeta`:
  e' un valore in una config, non un ramo nel motore (I2).
- `preview(def, n)`: `n` limita le righe **lette dalla sorgente**, non quelle in uscita. La domanda a
  cui risponde e' "che cosa succede alle prime n righe di questo file?".
- `onMissing` di `lookup`: `reject` scarta e segnala, `skip` scarta in silenzio, `warn` tiene la riga
  coi campi a null e segnala.
- La soglia `maxFailedRatio` non ha un numero minimo di righe prima di scattare: chi scrive `0.2`
  intende `0.2` anche su un file di tre righe.
- Le scritture dentro una transazione **non** si ritentano mai: un'istruzione fallita ha gia' abortito
  la transazione. Si ritentano solo letture e connessioni, e solo se l'errore si dichiara `retryable`.

## Comandi

```
npm run build             # tsc --build su tutti i workspace
npm run typecheck:tests   # type-check dei test (vitest non type-checka)
npm test                  # vitest run
npm run check:boundaries  # dependency-cruiser: I2 + I9
npm run check             # tutti e quattro
```
