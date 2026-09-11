# La Definition

Il formato del file che descrive un'importazione. E' JSON puro: nessuna funzione, nessuna
espressione, nessun riferimento a codice. Si versiona, si diffa, si valida, e una GUI potra'
generarlo.

## Forma completa

```json
{
  "client": "acme",
  "source":      { "type": "csv",      "config": { "input": "acme.csv" } },
  "transform": [ { "type": "rename",   "config": { "map": { "A": "a" } } } ],
  "destination": { "type": "postgres", "config": { "table": "landing" } },
  "policy": { "maxFailedRatio": 0.2, "rejectFile": true },
  "manifestSnapshot": { "csv": "0.1.0", "rename": "0.1.0", "postgres": "0.1.0" }
}
```

| Campo | Tipo | Obbligatorio | Significato |
|---|---|:---:|---|
| `client` | string | si | Chi manda i dati. Serve nei log e negli eventi; non cambia il comportamento |
| `source` | oggetto | si | Un solo reader |
| `transform` | array | no (default `[]`) | Zero o piu' transformer, **nell'ordine di esecuzione** |
| `destination` | oggetto | si | Un solo writer |
| `policy` | oggetto | no | Quanto sbagliato puo' essere il file |
| `manifestSnapshot` | oggetto | no | Nome plugin → versione con cui la Definition e' stata scritta |

## Gli stadi

Ogni stadio ha la stessa forma:

```json
{ "type": "<nome logico del plugin>", "config": { ... } }
```

`type` non e' un nome di pacchetto npm: e' il nome che il plugin dichiara nel proprio manifest. Il
motore lo cerca nel registry; se non c'e', lo carica da npm per convenzione
(`@etl-js/plugin-<nome>` o `etl-js-plugin-<nome>`). Vedi [api.md](api.md#createloader).

`config` viene passata al plugin cosi' com'e' ed e' **il plugin** a validarla contro il proprio
schema. Il core non sa cosa ci sia dentro; sa solo controllarla contro il JSON Schema che il plugin
pubblica nel manifest.

La config di ogni plugin: [plugin.md](plugin.md).

### L'ordine dei transformer

L'ordine e' quello dell'array e conta. Le regole pratiche:

| Prima | Poi | Perche' |
|---|---|---|
| `filter` | `rename` | il filtro lavora sulle intestazioni originali del flusso |
| `rename` | `cast` | e' piu' leggibile convertire campi coi nomi definitivi |
| `cast` | `lookup` | la chiave di ricerca dev'essere del tipo giusto, o non trova nulla |
| `cast` | `validate` | `min: 1` su una stringa non significa niente |
| tutto il resto | `default` | marca cio' che e' sopravvissuto, provenienza compresa |

Uno stadio riceve solo quello che il precedente ha lasciato passare: le righe scartate da `filter` non
arrivano mai a `cast`.

## `policy`

```json
"policy": { "maxFailedRatio": 0.2, "rejectFile": true }
```

### `maxFailedRatio`

Numero fra 0 e 1: la frazione di righe scartate oltre la quale **il run viene annullato**. Confronta
`failed / read`, e conta sia gli scarti (`reject`) sia le segnalazioni (`warn`).

Il controllo avviene **dopo ogni lotto e prima di scriverlo**, e di nuovo a fine run. Quando scatta:

1. il lotto in corso non viene scritto;
2. la destinazione viene chiusa con **rollback**;
3. `run()` lancia un `EtlError` con codice `TOO_MANY_FAILED` e, nel contesto, i numeri esatti.

Non c'e' un numero minimo di righe prima che il controllo scatti: chi scrive `0.2` intende `0.2`
anche su un file di tre righe. Se serve un comportamento diverso, si toglie la soglia e si decide
nell'host guardando il `RunResult`.

Senza `maxFailedRatio` non c'e' soglia: si importa quel che si puo', qualunque sia la percentuale.

### `rejectFile`

Se `true`, `RunResult.rejects` contiene gli scarti col motivo. **E' limitato a 1000 righe** per non
far esplodere la memoria su un file interamente sbagliato; oltre quella soglia il motore lo scrive nel
log e tronca. Per averli tutti si ascolta l'evento `onRecordFailed`, che non ha limiti — la CLI lo fa
gia' con `--rejects`.

Il limite si cambia con `run(def, ctx, { maxRejectsInResult: 5000 })`.

## `manifestSnapshot`

```json
"manifestSnapshot": { "csv": "0.1.0", "lookup": "0.1.0" }
```

Fotografia delle versioni con cui la Definition e' stata scritta. `validate()` confronta con quelle
installate e segnala le differenze con severita' **warn**: non impedisce il run, dice che il risultato
potrebbe non essere identico a quello di allora.

Non serve elencare tutti i plugin: quelli assenti non vengono controllati.

## Il risultato

```ts
interface RunResult {
  runId: string;
  read: number;       // righe lette dalla sorgente
  written: number;    // righe consegnate alla destinazione
  failed: number;     // scarti + segnalazioni
  rejects?: Failed[]; // solo con policy.rejectFile
  aborted: boolean;   // vero se il run e' stato fermato da ctx.signal
  durationMs: number;
}
```

`read` non e' sempre `written + failed`: una riga segnalata con `warn` viene contata in `failed`
**e** scritta. Il conto che torna sempre e' `written = read - (righe rifiutate)`.

`aborted: true` significa **annullamento richiesto** (`ctx.signal`), non fallimento. Un run che
supera `maxFailedRatio` non torna `aborted`: lancia.

## Esempi

### Minimo che funziona

```json
{
  "client": "prova",
  "source":      { "type": "csv",      "config": { "input": "dati.csv" } },
  "transform":   [],
  "destination": { "type": "postgres", "config": { "table": "landing" } }
}
```

### Solo pulizia, senza database

Utile per capire cosa esce da un file, con `preview` o `--dry-run`:

```json
{
  "client": "prova",
  "source": { "type": "csv", "config": { "input": "sporco.csv", "delimiter": ";", "skipRows": 2 } },
  "transform": [
    { "type": "filter", "config": { "drop": [{ "allEmpty": true }, { "field": "Codice", "matches": "^TOTALE" }] } },
    { "type": "cast",   "config": { "Importo": { "number": { "decimal": ",", "thousands": "." } } } }
  ],
  "destination": { "type": "postgres", "config": { "table": "landing" } }
}
```

### Con provenienza e scarti

```json
{
  "client": "acme",
  "source": { "type": "csv", "config": { "input": "acme.csv", "delimiter": ";" } },
  "transform": [
    { "type": "validate", "config": { "rules": [{ "field": "codice", "required": true, "unique": true }] } },
    { "type": "default", "config": { "values": {
        "run_id":       { "fromMeta": "runId",  "when": "always" },
        "file_origine": { "fromMeta": "source", "when": "always" },
        "riga_origine": { "fromMeta": "offset", "when": "always" },
        "stato":        "da_confermare"
    } } }
  ],
  "destination": { "type": "postgres", "config": {
    "table": "landing", "strategy": "replace-by", "replaceKey": ["codice"] } },
  "policy": { "maxFailedRatio": 0.05, "rejectFile": true }
}
```

Dopo un import di questo tipo, `SELECT * FROM landing WHERE run_id = '...'` dice esattamente cosa ha
portato quell'esecuzione, e `riga_origine` rimanda alla riga del file.

## Validare senza eseguire

```bash
etl validate flussi/acme.json
```

```ts
import { validate } from "@etl-js/core";
const { valid, issues } = validate(definition, { registry });
```

Ogni rilievo porta `path` (il punto esatto: `transform[2].config.on`), `message`, `code` e
`severity`. `run()` chiama comunque `validate` da solo, dopo aver risolto i plugin e **prima** di
leggere una riga o aprire una transazione.
