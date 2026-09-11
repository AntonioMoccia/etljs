# API

Tutto cio' che serve per usare `etljs` da un altro programma. Le firme sono quelle vere: se qualcosa
qui non combacia col codice, e' un bug della documentazione.

Il percorso normale e' `createEngine()`. Tutto il resto - `run`, `Registry`, i provider - e' il
livello sotto, utile quando l'applicazione ha esigenze sue.

```ts
import {
  createEngine, run, validate, describePlugin, listPlugins, preview,
  Registry, createFileInput, createPostgresProvider, withRetry,
} from "etljs";
import { csvReader } from "etljs/csv-reader";
import { postgresWriter } from "etljs/postgres-writer";
import { transformers } from "etljs/transformers";
import { lookupTransformer } from "etljs/lookup-transformer";
```

## `createEngine()`

Il modo normale di usare la libreria: si collegano i plugin e si esegue.

```ts
const engine = createEngine()
  .use(csvReader)
  .use(postgresWriter)
  .useAll(transformers);

const result = await engine.run(definition, ctx);
```

| Metodo | Cosa fa |
|---|---|
| `use(plugin)` | collega un plugin; restituisce l'engine, cosi' le chiamate si concatenano |
| `useAll(plugins)` | collega un elenco, comodo coi pacchetti che ne contengono piu' d'uno |
| `run(definition, ctx, options?)` | esegue con i plugin collegati |
| `registry` | il registry sottostante, per `describePlugin` e `listPlugins` |

**Il nome dice il tipo.** Ogni plugin incluso si esporta come `<nome><Tipo>`:

| Import | Tipo |
|---|---|
| `import { csvReader } from "etljs/csv-reader"` | reader |
| `import { postgresWriter } from "etljs/postgres-writer"` | writer |
| `import { lookupTransformer } from "etljs/lookup-transformer"` | transformer |
| `import { castTransformer, filterTransformer, ... } from "etljs/transformers"` | transformer |
| `import { transformers } from "etljs/transformers"` | i cinque insieme, per `useAll` |

Non ci sono default export: `use(csvReader)` dice cosa entra nella pipeline e con che ruolo, `use(csv)`
no. E' la stessa convenzione che conviene seguire in un plugin tuo.

E' una facciata sottile sopra `Registry` e `run()`: non aggiunge comportamento. Collegare due plugin
con lo stesso nome lancia, come fa `Registry.register`.

**Ogni engine ha la sua Registry.** Due engine nello stesso processo non si scambiano i plugin, il
che conta per un host che ne costruisce uno per tenant.

Le opzioni di `engine.run()` sono quelle di `run()` **meno** `registry`: il registry lo possiede
l'engine.

## `run(definition, ctx, options?)`

Il livello sotto `createEngine`: esegue un'importazione con un `Registry` che costruisci tu.

```ts
const registry = new Registry().register(csvReader).register(postgresWriter);
const result: RunResult = await run(definition, ctx, { registry });
```

`engine.run(...)` e' esattamente questa chiamata col registry dell'engine. Serve direttamente quando
il registry lo gestisce gia' l'applicazione, per esempio uno per tenant tenuto in cache.

### `ctx` — quello che fornisci tu

```ts
interface HostCtx {
  openInput?(ref: string): Promise<ByteStream>;       // i byte delle sorgenti
  db(name: string): ReadOnlyDb;                        // sola lettura
  dbWrite?(name: string): Promise<WriteTransaction>;   // solo per il writer
  secretRef(ref: string): string;
  log: Logger;
  signal: AbortSignal;
  runId?: string;                                      // se assente lo genera run()
}
```

`openInput` e `dbWrite` sono opzionali **qui**, non nel contratto dei plugin: se un reader ha bisogno
di leggere e non gliel'hai fornito, l'errore dice esattamente cosa manca invece di leggere di nascosto
dal filesystem.

Il core non passa mai `dbWrite` a reader e transformer: costruisce per loro una vista del contesto in
cui quel metodo **non esiste**.

### `options`

| Opzione | Default | Effetto |
|---|---|---|
| `registry` | `defaultRegistry` | Dove cercare i plugin (con `createEngine` lo fornisce l'engine) |
| `events` | — | Callback di osservazione |
| `runId` | generato | Identificativo del run |
| `dryRun` | `false` | Esegue tutto tranne la scrittura: la destinazione non viene aperta |
| `limitRows` | — | Ferma la lettura dopo N righe |
| `maxRejectsInResult` | `1000` | Quanti scarti tenere in `RunResult.rejects` |

### Cosa fa, nell'ordine

1. Risolve i plugin chiedendoli al registry.
2. Valida la Definition — **prima** di leggere una riga o aprire una transazione.
3. Apre la destinazione, se non e' dry-run.
4. Per ogni lotto: legge, trasforma, controlla la soglia di scarto, scrive, emette `onBatch`.
5. Chiama `flush()` sui transformer che ce l'hanno; cio' che ne esce attraversa i transformer
   successivi.
6. Chiude con `commit`, o con `rollback` se c'e' stato un errore o un annullamento.

### Quando lancia e quando no

| Situazione | Risultato |
|---|---|
| tutto bene | `RunResult` |
| `ctx.signal` annullato | `RunResult` con `aborted: true`, dopo il rollback |
| config invalida | lancia `EtlError` `CONFIG_INVALID`, senza aver aperto niente |
| soglia di scarto superata | lancia `EtlError` `TOO_MANY_FAILED`, dopo il rollback |
| errore di un plugin | lancia `EtlError` classificato col passo colpevole, dopo il rollback |

`aborted: true` significa **annullamento richiesto**, non fallimento. Un run che supera la soglia non
torna `aborted`: lancia.

## `validate(definition, options?)`

```ts
const { valid, issues } = validate(definition, { registry });
```

Non esegue niente e non tocca il database: una GUI puo' chiamarla a ogni tasto premuto. Riporta
**tutti** i rilievi insieme.

```ts
interface ValidationIssue {
  path: string;      // "transform[2].config.on"
  message: string;
  code: string;      // MISSING | PLUGIN_NOT_FOUND | PLUGIN_KIND_MISMATCH | CONFIG_INVALID | VERSION_DRIFT
  severity: "error" | "warn";
  context?: Record<string, unknown>;
}
```

`valid` e' falso solo se c'e' almeno un `error`. Uno scostamento da `manifestSnapshot` e' un `warn`:
non impedisce il run.

`assertValid(definition, options?)` fa lo stesso ma lancia invece di riportare.

## `describePlugin(name, options?)`

Alias: `describe`. Restituisce il JSON Schema della config di un plugin — quello che una GUI usa per
disegnare il modulo di configurazione.

```ts
const schema = describePlugin("csv", { registry });
```

## `listPlugins(options?)`

I manifest di tutti i plugin disponibili, ordinati per nome.

```ts
for (const m of listPlugins({ registry })) {
  console.log(m.name, m.kind, m.version, m.capabilities);
}
```

## `preview(definition, n, ctx, options?)`

```ts
const { rows, failed, read } = await preview(definition, 20, ctx, { registry });
```

Esegue la pipeline a vuoto sulle prime `n` righe della **sorgente** e restituisce cio' che sarebbe
stato scritto piu' cio' che sarebbe stato scartato. Non e' un ramo speciale del motore: e' `run()` in
dry-run con un limite e due handler.

`n` limita le righe **lette**, non quelle in uscita: se un filtro ne scarta meta', `rows` ne conterra'
meno di `n` e `failed` dira' perche'. Poiche' il reader lavora a lotti, `read` puo' superare `n`.

## `Registry`

```ts
const registry = new Registry()
  .register(csvPlugin)
  .registerAll(transforms);

registry.has("cast");            // boolean
registry.get("cast");            // Plugin | undefined
registry.require("cast", "transformer");  // Plugin, o lancia
registry.list();                 // Manifest[], ordinati per nome
registry.clear();
```

`register` verifica il protocollo e rifiuta due plugin diversi con lo stesso nome. Il registry
indicizza per **`manifest.name`**, non per nome del pacchetto o del modulo: un modulo puo' esportarne
molti (`etljs/transformers` ne porta cinque).

`defaultRegistry` e' l'istanza di processo, usata quando non ne passi una. Nella maggior parte dei
casi non serve toccare `Registry` direttamente: `createEngine()` ne costruisce una e la gestisce.

## `createFileInput(options?)`

Risolve un `ref` come file su disco. E' cio' che si mette in `ctx.openInput`.

```ts
const openInput = createFileInput({ baseDir: "/var/spool/import" });
```

**`baseDir` non e' un dettaglio.** Senza, un `input` che arriva da una Definition puo' leggere
qualunque file della macchina: `"../../.ssh/id_rsa"` e' un percorso valido come un altro. Se le
Definition le scrivi tu, puoi farne a meno; se arrivano da fuori, `baseDir` e' obbligatorio nei fatti.

`createMemoryInput({ "a.csv": "..." })` fa lo stesso da valori in memoria: comodo nei test.

## `createPostgresProvider(databases)`

```ts
const provider = await createPostgresProvider({
  database: {
    connectionString: process.env.DATABASE_URL!,
    max: 4,
    statementTimeoutMs: 30_000,
    retryAttempts: 3,
  },
});

const ctx = { db: (n) => provider.db(n), dbWrite: (n) => provider.dbWrite(n), ... };
await provider.close();
```

Ogni database logico ha **due pool**: uno in lettura e uno per le transazioni del writer. Il pool di
lettura si connette con `default_transaction_read_only=on`, quindi e' il server a rifiutare una
scrittura da un transformer — l'invariante non dipende dalla buona fede dei plugin.

Letture e connessioni vengono ritentate se l'errore si dichiara `retryable` (deadlock, contesa,
cadute di rete). **Le scritture dentro una transazione non si ritentano mai**: un'istruzione fallita
ha gia' abortito la transazione, e riprovarla nasconderebbe il motivo.

`pg` e `pg-copy-streams` sono dipendenze opzionali, importate solo quando servono: se non li hai
installati, l'errore lo dice.

## `withRetry(operation, options?)`

```ts
const rows = await withRetry(() => db.query(sql, params), { attempts: 3, baseMs: 100 });
```

Ritenta **solo** cio' che l'errore stesso dichiara `retryable`. Attesa esponenziale con jitter pieno:
senza il jitter, dieci worker caduti insieme tornerebbero a bussare nello stesso istante.

| Opzione | Default |
|---|---|
| `attempts` | `3` |
| `baseMs` | `100` |
| `maxMs` | `10000` |
| `signal` | — (un run annullato non viene ritentato) |
| `sleep`, `random` | i veri (iniettabili nei test) |

## Eventi

```ts
await run(definition, ctx, { events: {
  onRunStart:     (e) => { e.runId; e.client; e.steps; e.dryRun; },
  onBatch:        (e) => { e.batch; e.read; e.written; e.failed; },
  onRecordFailed: (e) => { e.step; e.failed; },
  onRunEnd:       (e) => { e.result; e.error; },
} });
```

Sono **osservazione**, non partecipazione: sono sincroni, il motore non ne aspetta l'esito e ingoia i
loro errori. Un bug nella tua barra di avanzamento non deve poter annullare un'importazione.

Corollario: non usarli per lavoro transazionale. Se una procedura deve girare dentro la transazione
dei dati, il posto e' il writer.

`onRecordFailed` non ha limiti: e' il modo giusto di raccogliere **tutti** gli scarti, mentre
`RunResult.rejects` e' troncato. Dettagli in [errori.md](errori.md).

## Tipi

Dal pacchetto `etljs/contracts`:

| Tipo | Cos'e' |
|---|---|
| `Row`, `Batch`, `BatchMeta`, `Failed`, `Severity` | i dati che scorrono |
| `Ctx`, `WriterCtx`, `ByteStream`, `ReadOnlyDb`, `WriteTransaction`, `Logger` | il contesto |
| `Reader`, `Transformer`, `Writer`, `WriteSession` | i contratti dei plugin |
| `Plugin`, `ReaderPlugin`, `TransformerPlugin`, `WriterPlugin`, `Manifest`, `PluginModule` | i plugin |
| `Definition`, `StepRef`, `Policy`, `RunResult` | la configurazione e il risultato |
| `EtlError`, `ErrorCodes`, `configInvalid` | gli errori |
| `escapeIdentifier`, `escapeQualifiedName`, `sqlOperator`, `SQL_OPERATORS`, `placeholders` | utility SQL |
| `isBlank`, `createRunCache` | utility comuni ai plugin |
| `PROTOCOL_VERSION` | la versione del protocollo |
