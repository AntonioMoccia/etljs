# etl-js

Motore di importazione dati a plugin, **libreria senza stato** destinata a essere incorporata in un
software piu' grande. Caso d'uso guida: importare file CSV di formati diversi, collegandoli
a dati gia' presenti su Postgres.

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
| I8 | Un flusso = un file di config, **mai** un plugin. Nome di flusso nel codice = manca un parametro a un plugin generico | a 20 flussi, 20 pacchetti: progetto morto |
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
  plugin-csv/         reader
  plugin-postgres/    writer: append, upsert, replace-by
  plugin-transforms/  libreria standard: cast, filter, default, rename, validate
  plugin-lookup/      transformer (cardine): collega al database, in batch
```

**Un pacchetto npm non e' un plugin.** E' un'unita' di distribuzione; il plugin e' un'unita' di
configurazione. Un pacchetto ne dichiara uno con `export const plugin` o molti con
`export const plugins: Plugin[]`, e il registry li indicizza per `manifest.name`. I cinque
transformer di base stanno insieme perche' si installano insieme; ognuno tiene la **propria**
`manifest.version`, cosi' modificarne uno non fa comparire `VERSION_DRIFT` sugli altri.

Il prezzo di tenerli separati lo si e' visto: `configOf` era riscritto cinque volte e "campo vuoto"
tre volte con due nomi diversi, gia' divergenti fra loro. Cio' che serve a piu' pacchetti sta in
`contracts` (`isBlank`, `createRunCache`, `configInvalid`), perche' un plugin non puo' importarne
un altro (I9).

I transformer **non** sono dipendenze della CLI: vengono caricati per nome dal loader quando una
Definition li cita. Se un giorno smettessero di funzionare cosi', il test
`cli > l'esempio completo e' valido con i plugin caricati da npm` diventerebbe rosso.

Grafo consentito: `contracts` <- `core`, `plugin-*`, `cli`, `testing`. I plugin dipendono **solo** da
`contracts`. Nessun plugin importa `core` o un altro plugin.

## Contratti

Le firme canoniche stanno in `packages/contracts/src/`. Non inventarne altre. Cinque estensioni deliberate
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
4. **`Ctx.openInput(ref): Promise<ByteStream>`**: il reader dice **quale** sorgente vuole, mai
   **come** aprirla. In sviluppo e in CLI il core la risolve come path (`createFileInput`); in
   produzione l'host la risolve su object storage e il plugin non cambia (I6). `ByteStream` e'
   `AsyncIterable<Uint8Array>` e non `NodeJS.ReadableStream` per due motivi: quel tipo obbligherebbe
   `contracts` a dipendere da `@types/node`, e uno `fs.ReadStream` soddisfa gia' la forma povera senza
   adattatori, insieme a uno stream web o a un iteratore su S3.
5. **`contracts` contiene anche costanti e utility pure** (`PROTOCOL_VERSION`, `EtlError`,
   `escapeIdentifier`, whitelist operatori), non solo tipi: se stessero in `core` i plugin non
   potrebbero usarle senza violare I9. Restano a zero dipendenze, e dependency-cruiser lo verifica.

## Dipendenze e loro giustificazione

| Pacchetto | Dipendenza | Perche' |
|-----------|------------|---------|
| contracts | *nessuna* | I9, verificato da dependency-cruiser |
| core | `ajv`, `ajv-formats` | il core valida le config contro il JSON Schema del manifest senza conoscere Zod ne' il plugin (I2) |
| core | `pg`, `pg-copy-streams` (optional) | il core e' l'unico a poter aprire connessioni (I6); import dinamico, cosi' chi non usa Postgres non li installa |
| plugin-* | `zod` | schema di config tipizzato + derivazione del JSON Schema con `z.toJSONSchema()` (zod v4, nessuna libreria di conversione a parte) |
| plugin-csv | `csv-parse` | streaming vero e quoting RFC 4180 corretto; il quoting a mano e' pieno di trappole |
| testing | *nessuna* | l'harness serve a provare i plugin, non puo' tirarsi dietro il core |
| dev | `typescript`, `vitest`, `dependency-cruiser` | build, test, confini |

Nota su `plugin-csv`: la dipendenza da Node si ferma a `node:stream` e `node:util`. Il plugin **non
importa `node:fs`**: i byte glieli da' il core tramite `ctx.openInput` (I6).

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
- `createFileInput({ baseDir })`: senza `baseDir` un `ref` che arriva da una Definition puo' leggere
  qualunque file della macchina. In un host che accetta Definition da fuori, `baseDir` non e' opzionale.
- Il BOM: `TextDecoder` lo toglie da solo, quindi il reader lo decodifica con `ignoreBOM: true` e
  decide lui. Cosi' `bom: false` funziona davvero, e si intercetta anche il caso vero, un file
  salvato UTF-8-BOM ma dichiarato latin1.
- Le scritture dentro una transazione **non** si ritentano mai: un'istruzione fallita ha gia' abortito
  la transazione. Si ritentano solo letture e connessioni, e solo se l'errore si dichiara `retryable`.

## Documentazione

`docs/` e' la documentazione per chi **usa** la libreria; questo file e' per chi la **modifica**.
Indice in [docs/README.md](docs/README.md). Non e' facoltativa: `test/documentazione.test.ts`
verifica che i link non siano rotti, che ogni plugin installato abbia la sua sezione, che ogni
opzione di config sia documentata e che ogni codice di errore sia spiegato. Aggiungere un'opzione
senza documentarla e' un test rosso.

## Comandi

```
npm run build             # tsc --build su tutti i workspace
npm run typecheck:tests   # type-check dei test (vitest non type-checka)
npm test                  # vitest run
npm run check:boundaries  # dependency-cruiser: I2 + I9
npm run check             # tutti e quattro
```
