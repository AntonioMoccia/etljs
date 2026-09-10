# Errori, eventi e scarti

Due cose diverse che e' facile confondere:

- una **riga** sbagliata non e' un errore del run: e' uno **scarto** (`Failed`), e il run prosegue;
- un **errore** (`EtlError`) ferma tutto, chiude la destinazione con rollback e viene lanciato.

Un file con mille righe brutte produce mille scarti e zero errori — a meno che non superi la soglia,
che e' il punto in cui la quantita' di scarti diventa un errore.

## `EtlError`

L'unico tipo di errore del motore. Classificato, instradabile e serializzabile, cosi' chi lo riceve
puo' deciderne il destino senza fare pattern matching sul messaggio.

```ts
class EtlError extends Error {
  code: string;                        // "READ_FAILED", "DB_ERROR", ...
  retryable: boolean;                  // ha senso riprovare?
  context: Record<string, unknown>;    // dati diagnostici, mai credenziali
  cause?: unknown;                     // l'errore originale
  toJSON(): Record<string, unknown>;
  static is(value): value is EtlError;
  withContext(extra): EtlError;
}
```

```ts
try {
  await run(definition, ctx);
} catch (error) {
  if (EtlError.is(error)) {
    if (error.retryable) return coda.rimetti(definition);
    registro.salva(error.toJSON());     // gia' pronto per il JSON
  }
  throw error;
}
```

`context` e' pensato per essere loggato: contiene il passo, il run, i numeri. Non contiene mai
credenziali ne' righe intere.

## I codici

### Del motore

| Codice | Quando | `retryable` |
|---|---|:---:|
| `CONFIG_INVALID` | una config non rispetta lo schema del plugin | no |
| `PLUGIN_NOT_FOUND` | il plugin non e' registrato ne' installabile per nome | no |
| `PROTOCOL_MISMATCH` | il plugin parla un protocollo diverso dal motore | no |
| `READ_FAILED` | il reader e' fallito mentre leggeva | dipende |
| `TRANSFORM_FAILED` | un transformer e' fallito su un lotto | no |
| `WRITE_FAILED` | il writer e' fallito aprendo, scrivendo o chiudendo | no |
| `DB_ERROR` | errore restituito dal database | se e' contesa o rete |
| `TOO_MANY_FAILED` | superata `policy.maxFailedRatio` | no |
| `SOURCE_UNREADABLE` | una sorgente non e' leggibile (es. il file della Definition) | si |
| `INVALID_USAGE` | uso improprio dell'API da parte dell'host o di un plugin | no |
| `ABORTED` | il run e' stato annullato | no |

Gli errori di `READ_FAILED`, `TRANSFORM_FAILED` e `WRITE_FAILED` portano nel contesto il **passo**
colpevole:

```json
{ "name": "EtlError", "code": "WRITE_FAILED",
  "message": "disco pieno",
  "retryable": false,
  "context": { "step": "postgres", "runId": "93885a05", "client": "acme" } }
```

Un host che riceve `"il run e' fallito"` non sa cosa fare. Uno che riceve `WRITE_FAILED` su
`postgres` sa dove guardare.

### Dei plugin

Compaiono nei `Failed`, non negli errori del run:

| Codice | Plugin | Significa |
|---|---|---|
| `CAST_FAILED` | `cast` | il valore non e' convertibile nel tipo richiesto |
| `FILTERED` | `filter` | riga eliminata da una regola (solo con `report: true`) |
| `RENAME_MISSING_COLUMN` | `rename` | colonna attesa e assente, con `strict: true` |
| `VALIDATION_FAILED` | `validate` | una regola di merito non e' rispettata |
| `LOOKUP_MISSING` | `lookup` | nessuna corrispondenza sul database |
| `LOOKUP_AMBIGUOUS` | `lookup` | piu' corrispondenze per la stessa chiave |
| `LOOKUP_KEY_EMPTY` | `lookup` | la riga non ha un valore per la chiave |
| `COLUMN_MISMATCH` | `postgres` | una riga porta una colonna che la tabella non ha |
| `REPLACE_KEY_MISSING` | `postgres` | la chiave di sostituzione non e' fra le colonne scritte |

Un plugin tuo puo' usare i propri codici: `code` e' una stringa aperta. Conviene che sia stabile e
maiuscolo, perche' e' quello su cui un host scrivera' i suoi `if`.

## `retryable`

Dice **se ha senso riprovare la stessa identica operazione**. E' vero per contesa, deadlock, timeout
e cadute di rete; e' falso per un vincolo violato o una colonna che non esiste — quelli non
migliorano riprovando, e ritentarli nasconde il problema.

Codici SQLSTATE considerati ritentabili dal driver Postgres: `40001` (serialization failure), `40P01`
(deadlock), `53300` (too many connections), `57P01` (admin shutdown), `08006` e `08003` (connessione).

`withRetry` (vedi [api.md](api.md#withretry)) ritenta **solo** cio' che si dichiara ritentabile.
**Le scritture dentro una transazione non si ritentano mai**: un'istruzione fallita ha gia' abortito
la transazione.

## Gli scarti

```ts
interface Failed {
  row: Row;            // la riga com'era
  reason: string;      // per un operatore
  code: string;        // per un programma
  severity: "reject" | "warn";
  offset: number;      // la riga nella sorgente
  runId?: string;      // compilati dal motore
  source?: string;
}
```

**`reject` scarta la riga, `warn` la lascia passare segnalandola.** Entrambi contano in
`RunResult.failed` e nella soglia `maxFailedRatio`: una segnalazione non e' gratis.

`reason` e' per un umano e nomina il campo e il valore:

```
campo "quantita": 0 e' sotto il minimo 1
nessuna corrispondenza in ordini per ordine_cliente=ORD-9999
"31/02/2026" non e' una data esistente
```

`runId`, `source` e `offset` li compila il motore, non il plugin che ha scartato: e' il motore a
sapere in quale run e su quale file si sta lavorando.

### Raccoglierli

Due modi, e la differenza conta:

| Modo | Limite | Quando |
|---|---|---|
| `RunResult.rejects` (con `policy.rejectFile`) | **1000 righe**, poi tronca e lo scrive nel log | file normali, ispezione al volo |
| evento `onRecordFailed` | nessuno | sempre, se ti servono tutti |

```ts
const scarti: Failed[] = [];
await run(definition, ctx, {
  events: { onRecordFailed: (e) => scarti.push(e.failed) },
});
```

Il limite di `rejects` esiste perche' un file interamente sbagliato non deve far esplodere la memoria
del processo. Si cambia con `maxRejectsInResult`.

### Il file di scarto della CLI

```bash
etl run definizione.json --rejects scarti.csv
```

Scrive **man mano che gli scarti arrivano**, non alla fine:

```csv
run_id;file;riga;severita;codice;motivo;riga_originale
"93885a05";"acme.csv";"3";"reject";"VALIDATION_FAILED";"campo ""quantita"": 0 e' sotto il minimo 1";"{""Ordine"":""ORD-3""}"
```

`riga_originale` e' la riga com'era in JSON: nessun dato si perde, e il cliente puo' ricevere il file
esattamente delle righe da correggere.

Il file di scarto viene chiuso anche quando il run **fallisce**: e' li' che si legge perche' e' fallito.

## Gli eventi

```ts
interface RunEvents {
  onRunStart?(e):     void;  // runId, client, steps, dryRun
  onBatch?(e):        void;  // batch, read, written, failed  (totali progressivi)
  onRecordFailed?(e): void;  // step, failed
  onRunEnd?(e):       void;  // result, error?
}
```

**Sono sincroni e best-effort.** Il motore non ne aspetta l'esito e ingoia i loro errori: un bug
nella barra di avanzamento non deve annullare un'importazione. Il rovescio della medaglia e' che non
puoi usarli per lavoro che deve riuscire.

`onRunEnd` viene emesso **sempre**, anche quando il run fallisce, e in quel caso porta anche l'errore.
Un host puo' ricostruire l'intero andamento dai soli eventi:

```ts
const stato = { letto: 0, scritto: 0, scarti: [] as Failed[] };

await run(definition, ctx, { events: {
  onRunStart:     (e) => barra.inizia(e.steps),
  onBatch:        (e) => { stato.letto = e.read; stato.scritto = e.written; barra.aggiorna(e); },
  onRecordFailed: (e) => stato.scarti.push(e.failed),
  onRunEnd:       (e) => e.error ? registro.fallito(e.error) : registro.riuscito(e.result),
} });
```

## Il log

`ctx.log` e' un logger strutturato: i plugin non stampano nulla, dicono cosa e' successo e con quali
campi. E' l'host a decidere dove finisce.

```ts
interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}
```

Il motore crea logger figli a ogni passo, quindi ogni riga di log porta gia' `runId`, `client` e
`step` senza che il plugin debba occuparsene.

La CLI ne fornisce uno che scrive **una riga JSON per evento su stderr**, cosi' stdout resta pulito
per il risultato e il comando si puo' mettere in pipe:

```
{"severity":"warn","message":"riga scartata","client":"acme","runId":"93885a...","step":"validate","code":"VALIDATION_FAILED","offset":3}
```

## Cosa fare secondo il codice

| Codice | Cosa conviene fare |
|---|---|
| `CONFIG_INVALID` | correggere la Definition; non riprovare |
| `PLUGIN_NOT_FOUND` | installare il pacchetto che l'errore suggerisce |
| `PROTOCOL_MISMATCH` | aggiornare il plugin o il motore |
| `TOO_MANY_FAILED` | guardare il file di scarto: di solito e' il file del cliente, non la config |
| `READ_FAILED` retryable | riprovare piu' tardi: la sorgente non era raggiungibile |
| `DB_ERROR` retryable | rimettere in coda, con backoff |
| `WRITE_FAILED` `COLUMN_MISMATCH` | il cliente ha aggiunto una colonna: aggiornare `rename` o `columns` |
| `INVALID_USAGE` | e' un errore di chi ha scritto l'host o il plugin |
