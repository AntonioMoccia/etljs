# Riferimento dei plugin

Ogni sezione documenta la `config` di uno stadio della Definition. Lo schema autoritativo e' sempre
quello del manifest: `etl describe <nome>` lo stampa, ed e' quello che il motore usa per validare.

| Nome | Tipo | Pacchetto |
|---|---|---|
| [`csv`](#csv) | reader | `etl-js/csv-reader` |
| [`filter`](#filter) | transformer | `etl-js/transformers` |
| [`rename`](#rename) | transformer | `etl-js/transformers` |
| [`cast`](#cast) | transformer | `etl-js/transformers` |
| [`default`](#default) | transformer | `etl-js/transformers` |
| [`validate`](#validate) | transformer | `etl-js/transformers` |
| [`lookup`](#lookup) | transformer | `etl-js/lookup-transformer` |
| [`postgres`](#postgres) | writer | `etl-js/postgres-writer` |

---

## csv

Legge un CSV in streaming. Non apre il file: chiede i byte a `ctx.openInput(input)`, che l'host
risolve come path, come oggetto su storage o come vuole lui.

| Campo | Tipo | Default | Note |
|---|---|---|---|
| `input` | string | **obbligatorio** | Riferimento alla sorgente, risolto dall'host |
| `delimiter` | string | `","` | Separatore di campo |
| `quote` | string (1 car.) | `"\""` | Carattere di quoting |
| `encoding` | `"utf8"` \| `"latin1"` | `"utf8"` | latin1 copre i CSV esportati con impostazioni locali europee |
| `skipRows` | intero ≥ 0 | `0` | Righe di preambolo da buttare **prima** dell'intestazione |
| `header` | boolean \| string[] | `true` | Vedi sotto |
| `trim` | boolean | `true` | Toglie gli spazi ai bordi di ogni campo |
| `batchSize` | 1..100000 | `1000` | Righe per lotto |
| `bom` | boolean | `true` | Toglie il BOM iniziale, se presente |

### `header`

| Valore | Effetto |
|---|---|
| `true` | la prima riga utile porta i nomi delle colonne |
| `["a", "b"]` | nomi imposti; il file non ha intestazione |
| `false` | chiavi posizionali `c0`, `c1`, `c2`, ... |

### `skipRows` conta le righe come le conti tu

Comprese quelle vuote. Un file cosi':

```
File di dati - ACME S.p.A.     <- 1
Generato il 03/02/2026              <- 2
                                    <- 3 (vuota, conta lo stesso)
Codice;Data                      <- 4, l'intestazione
```

vuole `skipRows: 3`. Se le righe vuote non contassero, dovresti aprire il file e contare due volte.

### Righe con un numero di campi diverso dall'intestazione

Entrano comunque: i campi che mancano restano assenti, quelli in piu' vengono ignorati. **Il reader
legge, non giudica**: se una riga corta e' un problema, lo dice `validate` con una regola `required`.
Cosi' un file con una riga storta non abbatte l'importazione.

### Il BOM

Con `bom: true` (default) il BOM iniziale viene tolto, e viene riconosciuto anche il caso vero dei
sistemi esterni: file salvato **UTF-8 con BOM ma dichiarato latin1**, dove il BOM arriva come tre
caratteri anziche' uno.

Attenzione: `trim: true` toglie comunque U+FEFF, che e' uno spazio a tutti gli effetti. Per
conservare il BOM servono `bom: false` **e** `trim: false`.

### Esempio

```json
{ "type": "csv", "config": {
  "input": "acme.csv", "delimiter": ";", "encoding": "latin1", "skipRows": 3 } }
```

---

## filter

Butta via le righe che non sono dati: intestazioni ripetute, totali, righe vuote, righe senza chiave.

| Campo | Tipo | Default | Note |
|---|---|---|---|
| `keep` | regola[] | — | Tiene **solo** le righe che soddisfano almeno una regola |
| `drop` | regola[] | — | Scarta le righe che soddisfano almeno una regola |
| `report` | boolean | `false` | Se vero le righe filtrate compaiono fra gli scarti con severita' `warn` |

Prima si applica `keep`, poi `drop`: cosi' `drop` puo' togliere casi da dentro cio' che `keep` ha
selezionato.

### Una regola

Dentro una regola le condizioni valgono **tutte insieme** (AND); fra regole diverse basta che ne
corrisponda **una** (OR).

| Condizione | Tipo | Significato |
|---|---|---|
| `field` | string | Il campo su cui guardare. Obbligatorio, tranne con `allEmpty` |
| `empty` | boolean | Il campo e' assente, null o solo spazi |
| `notEmpty` | boolean | L'opposto |
| `equals` / `notEquals` | valore | Confronto per stringa |
| `matches` | string | Espressione regolare sul valore |
| `ignoreCase` | boolean | Rende `matches` insensibile alle maiuscole (default `false`) |
| `in` | valore[] | Il valore e' fra questi |
| `gt` `gte` `lt` `lte` | number | Confronto numerico; un valore non numerico non soddisfa mai |
| `allEmpty` | boolean | **Tutti** i campi della riga sono vuoti |

Una regola senza condizioni scarterebbe tutto: e' un errore di config, non un comportamento. Anche
un'espressione regolare malformata lo e'.

### Esempi

```json
{ "type": "filter", "config": { "drop": [
  { "allEmpty": true },
  { "field": "Codice", "empty": true },
  { "field": "Codice", "matches": "^(TOTALE|TOT\\.)", "ignoreCase": true }
] } }
```

```json
{ "type": "filter", "config": {
  "keep": [{ "field": "tipo", "in": ["attivo", "sospeso"] }],
  "drop": [{ "field": "qta", "lt": 1 }],
  "report": true
} }
```

Di default un filtro **non lascia traccia**: e' il suo mestiere buttare via. Con `report: true` ogni
riga eliminata diventa un `Failed` con codice `FILTERED` e severita' `warn`, quindi finisce nel file
di scarto e **conta** nella soglia `maxFailedRatio`.

---

## rename

Dalle intestazioni del file di origine ai nomi usati dal database. E' il plugin che rende inutile scrivere
un pacchetto per flusso.

| Campo | Tipo | Default | Note |
|---|---|---|---|
| `map` | oggetto | **obbligatorio** | `"intestazione del file di origine": "nome interno"` |
| `keepUnmapped` | boolean | `true` | Se falso tiene **solo** i campi nominati nella mappa |
| `drop` | string[] | — | Campi da eliminare |
| `strict` | boolean | `false` | Se vero, una colonna attesa e assente **scarta la riga** |
| `trimKeys` | boolean | `false` | Toglie gli spazi ai bordi delle intestazioni prima di confrontarle |

I campi escono nell'ordine della mappa, poi gli altri: una landing table deve avere colonne
prevedibili, non l'ordine casuale del file.

Due colonne che finiscono sullo stesso nome sono una config invalida: perderebbero un dato in silenzio.

Con `strict: true` la riga incompleta diventa un `Failed` con codice `RENAME_MISSING_COLUMN`.

```json
{ "type": "rename", "config": {
  "map": { "Codice": "codice", "Data": "data_documento" },
  "trimKeys": true,
  "drop": ["Note interne"]
} }
```

---

## cast

Converte i valori grezzi nei tipi che il database si aspetta. La config e' una **mappa campo →
conversione**; i campi non nominati restano intatti.

```json
{ "type": "cast", "config": {
  "data_documento": { "date": "dd/MM/yyyy" },
  "quantita":      { "number": { "decimal": ",", "thousands": "." } },
  "urgente":       { "boolean": { "true": ["si", "x"], "false": ["no", ""] } }
} }
```

### Le conversioni

| Chiave | Produce | Opzioni |
|---|---|---|
| `date` | stringa ISO `"2026-02-03"` | il formato, es. `"dd/MM/yyyy"` |
| `datetime` | stringa ISO `"2026-02-03T14:30:00"`, **senza fuso** | il formato |
| `week` | il **lunedi'** di quella settimana ISO, come data ISO | il formato, es. `"ww/yyyy"` |
| `number` | numero | `decimal`, `thousands`, `strip` |
| `integer` | numero intero; i decimali sono un errore, non un troncamento | come `number` |
| `boolean` | booleano | `true`, `false`: gli elenchi di parole ammesse |
| `string` | stringa | `trim`, `case` (`"upper"` \| `"lower"`) |

Le date escono come **stringhe**, non come oggetti `Date`: un `Batch` deve restare serializzabile.

### I formati

| Token | Significa | | Token | Significa |
|---|---|---|---|---|
| `yyyy` | anno a 4 cifre | | `HH` `H` | ore |
| `yy` | anno a 2 cifre (00-68 → 2000+, 69-99 → 1900+) | | `mm` `m` | minuti |
| `MM` `M` | mese | | `ss` `s` | secondi |
| `dd` `d` | giorno | | `ww` `w` | numero di settimana ISO |
| `W` | la lettera `W` letterale, per `"yyyy-Www"` | | | |

Tutto il resto e' un carattere letterale. Una lettera che non e' un token e' una **config invalida**:
`"gg/mm/aaaa"` viene rifiutato con un messaggio che dice quale carattere non va.

Una data che non esiste non diventa il mese successivo: `31/02/2026` e' un errore, non il 3 marzo.

### Le settimane

`{ "week": "ww/yyyy" }` con valore `"07/2026"` produce `"2026-02-09"`, il lunedi' di quella settimana.

La settimana 1 del 2026 comincia il **29 dicembre 2025**, secondo ISO 8601: un dato marcato
"settimana 1" non appartiene a gennaio. Una settimana che in quell'anno non esiste (la 53 in un anno
che ne ha 52) e' un errore.

### I numeri

| Opzione | Effetto |
|---|---|
| `decimal` | separatore decimale del flusso, default `"."` |
| `thousands` | separatore delle migliaia; se assente, nessuno |
| `strip` | caratteri da togliere prima di leggere (es. `"%"`, `"€"`) |

Le parentesi contabili valgono un segno meno: `"(7,5)"` diventa `-7.5`, come nei fogli di calcolo da
cui questi CSV vengono esportati.

### Vuoti ed errori

Ogni conversione accetta due opzioni in piu':

| Opzione | Default | Effetto |
|---|---|---|
| `nullable` | `false` | Un valore vuoto diventa `null` invece di essere un errore |
| `onError` | `"reject"` | `reject`: scarta e segnala. `warn`: tiene la riga con `null` e segnala. `skip`: scarta in silenzio |

Un campo vuoto **non nullable** e' un errore, non uno zero silenzioso: e' la differenza fra "il
flusso non ha mandato la quantita'" e "la quantita' e' zero".

Gli scarti hanno codice `CAST_FAILED` e il motivo dice quale campo e perche':
`campo "quantita": "n/d" non e' un numero`.

---

## default

Riempie i campi che il flusso non manda. **Non scarta mai nulla**: se un campo obbligatorio manca ed
e' un problema, lo dice `validate`.

```json
{ "type": "default", "config": { "values": {
  "stato":        "da_confermare",
  "origine":      { "value": "acme", "when": "always" },
  "codice":       { "fromField": "Codice" },
  "run_id":       { "fromMeta": "runId",  "when": "always" },
  "file_origine": { "fromMeta": "source", "when": "always" },
  "riga_origine": { "fromMeta": "offset", "when": "always" }
} } }
```

Ogni voce di `values` e' una di queste:

| Forma | Significato |
|---|---|
| un valore (`"x"`, `12`, `true`, `null`) | il valore da mettere |
| `{ "value": ..., "when": ... }` | come sopra, con la condizione |
| `{ "fromField": "altro campo" }` | copia il valore di un altro campo della riga; se assente, `null` |
| `{ "fromMeta": "runId" \| "source" \| "offset" }` | la provenienza della riga |

### `when`

| Valore | Riempie... |
|---|---|
| `"empty"` (default) | se la chiave manca, oppure se il valore e' vuoto o null |
| `"missing"` | **solo** se la chiave manca; una stringa vuota resta vuota |
| `"always"` | sempre, sovrascrivendo |

### La provenienza

`fromMeta` e' il modo per marcare ogni riga con da dove viene, senza che il motore debba conoscere le
tue colonne:

- `runId` — l'identificativo dell'esecuzione;
- `source` — il file (o la chiave su storage) da cui viene la riga;
- `offset` — il numero di riga nella sorgente, 0-based.

Dopo un import, `SELECT * FROM landing WHERE run_id = '...'` dice esattamente cosa ha portato
quell'esecuzione, e `riga_origine` rimanda alla riga del file.

---

## validate

Controlla le regole di merito sui dati **gia' convertiti**. Ogni regola dice da se' se una violazione
ferma la riga o si limita a segnalarla.

```json
{ "type": "validate", "config": { "rules": [
  { "field": "quantita",      "min": 1,             "severity": "reject" },
  { "field": "data_documento", "notBefore": "today", "severity": "warn" },
  { "field": "codice",        "required": true, "unique": true }
] } }
```

| Campo | Tipo | Default | Note |
|---|---|---|---|
| `rules` | regola[] | **obbligatorio** | Almeno una; si applicano tutte, nell'ordine |

### Una regola

| Chiave | Tipo | Controlla |
|---|---|---|
| `field` | string | **obbligatorio**: il campo |
| `severity` | `"reject"` \| `"warn"` | default `"reject"`: nel dubbio il dato non entra |
| `message` | string | Motivo su misura al posto di quello automatico |
| `required` | boolean | Il campo c'e' e non e' vuoto |
| `min` / `max` | number | Intervallo numerico |
| `minLength` / `maxLength` | intero | Lunghezza del testo |
| `matches` | string | Espressione regolare |
| `ignoreCase` | boolean | Per `matches` |
| `in` | valore[] | Valori ammessi |
| `notBefore` / `notAfter` | data ISO oppure `"today"` | Intervallo di date |
| `unique` | boolean | Il valore non si ripete **in questo run** |

**Un campo vuoto non fa scattare i controlli di merito.** `min: 1` su un campo assente non produce
nulla: se l'assenza e' un problema, si aggiunge `required: true`. Cosi' "manca" e "e' sbagliato"
restano due segnalazioni diverse.

Le date si confrontano come stringhe ISO: se un campo non e' nel formato `yyyy-MM-dd`, la regola lo
segnala invece di lasciarlo passare. `cast` va eseguito prima.

`unique` ricorda i valori per tutta la durata del run e libera la memoria alla fine. Segnala la
**seconda** occorrenza, non la prima.

Una riga che viola due regole produce due segnalazioni ma viene scartata una volta sola. Il codice e'
sempre `VALIDATION_FAILED`.

---

## lookup

Collega le righe a dati gia' presenti su un database, **in batch**. E' il plugin che rende utile
tutto il resto: senza, un CSV di flussi di dati non sa a quale anagrafica appartiene.

```json
{ "type": "lookup", "config": {
  "db": "principale",
  "table": "anagrafica",
  "on": ["codice"],
  "select": "anagrafica_id",
  "onMissing": "reject"
} }
```

| Campo | Tipo | Default | Note |
|---|---|---|---|
| `db` | string | **obbligatorio** | Nome logico del database, risolto dall'host |
| `table` | string | **obbligatorio** | Tabella da cercare, anche `schema.tabella` |
| `on` | chiave[] | **obbligatorio** | Chiavi di ricerca |
| `select` | vedi sotto | **obbligatorio** | Colonne da riportare |
| `onMissing` | `reject` \| `warn` \| `skip` | `"reject"` | Cosa fare se non c'e' corrispondenza |
| `onDuplicate` | `reject` \| `first` | `"reject"` | Cosa fare se ce n'e' piu' d'una |
| `filter` | condizione[] | — | Condizioni aggiuntive sulla tabella cercata |

### `on`

```json
"on": ["codice"]                                    // campo e colonna si chiamano uguale
"on": [{ "field": "codice", "column": "codice" }]   // nomi diversi
"on": ["anno", "numero"]                                    // chiave composta
```

### `select`

```json
"select": "anagrafica_id"                                    // una colonna, stesso nome
"select": ["anagrafica_id", "stato"]                         // piu' colonne, stessi nomi
"select": { "anagrafica_id": "id_database", "stato": "s" } // colonna -> campo di destinazione
```

### `onMissing`

| Valore | Effetto |
|---|---|
| `reject` | la riga esce dal flusso e viene segnalata (`LOOKUP_MISSING`, severita' `reject`) |
| `warn` | la riga **resta**, i campi cercati sono `null`, e viene segnalata (severita' `warn`) |
| `skip` | la riga sparisce, in silenzio |

Una riga senza valore per la chiave non viene nemmeno chiesta al database: e' trattata secondo la
stessa politica, con codice `LOOKUP_KEY_EMPTY`.

### `onDuplicate`

Se il database restituisce piu' righe per la stessa chiave, `reject` (default) scarta la riga con
codice `LOOKUP_AMBIGUOUS`: scegliere a caso corromperebbe i dati in silenzio. `first` prende la prima
corrispondenza, quando sai che va bene.

### `filter`

Condizioni aggiuntive sulla tabella cercata. Gli operatori sono in whitelist: qualunque cosa fuori da
questo elenco e' una config invalida, non un passaggio a SQL grezzo.

| Operatore | SQL | | Operatore | SQL |
|---|---|---|---|---|
| `eq` | `=` | | `gte` | `>=` |
| `neq` | `<>` | | `like` | `LIKE` |
| `lt` | `<` | | `ilike` | `ILIKE` |
| `lte` | `<=` | | `is_null` | `IS NULL` |
| `gt` | `>` | | `is_not_null` | `IS NOT NULL` |

```json
"filter": [{ "column": "stato", "op": "eq", "value": "aperto" }]
```

### Come interroga il database

Con **una chiave**, una sola interrogazione per lotto:

```sql
SELECT "codice", "anagrafica_id" FROM "anagrafica" WHERE "codice" = ANY($1)
```

Con **chiavi composte**, sempre una sola, con tutti i valori come parametri:

```sql
SELECT ... FROM "anagrafica" WHERE ("anno", "numero") IN (($1, $2), ($3, $4))
```

Nessun valore finisce mai nel testo dell'istruzione; gli identificatori vengono quotati. Se le chiavi
di un lotto superassero il limite di parametri di Postgres, l'interrogazione viene spezzata — **mai**
per riga.

C'e' una **cache per run**: la stessa chiave non viene chiesta due volte, nemmeno fra lotti diversi.
Un lotto interamente in cache non interroga affatto il database. La cache viene liberata a fine run.

### Il tipo delle chiavi

Le chiavi si confrontano convertendole in stringa. Se la colonna del database e' numerica, **`cast`
deve girare prima di `lookup`**, o non trovera' nulla.

---

## postgres

Scrive in una tabella di atterraggio (*landing table*), dentro una transazione. Promuovere i dati
nelle tabelle di dominio e' compito dell'host: l'ETL non si accoppia al modello del database.

| Campo | Tipo | Default | Note |
|---|---|---|---|
| `table` | string | **obbligatorio** | Tabella di atterraggio, anche `schema.tabella` |
| `db` | string | `"default"` | Nome logico del database |
| `columns` | string[] | — | Colonne e loro ordine; se assente si usano le chiavi del primo lotto |
| `strategy` | `append` \| `upsert` \| `replace-by` | `"append"` | Vedi sotto |
| `replaceKey` | string[] | — | Obbligatoria con `replace-by` |
| `conflictKey` | string[] | — | Obbligatoria con `upsert` |
| `truncate` | boolean | `false` | Svuota la destinazione prima di caricare; solo con `append` |

### Le strategie

**`append`** — carica dritto nella destinazione con `COPY`. Il caso semplice e il piu' veloce.

**`replace-by`** — *"l'origine ha rimandato i dati di queste chiavi"*. Carica in una tabella
temporanea, poi, nella stessa transazione:

```sql
DELETE FROM "landing" AS t
USING (SELECT DISTINCT "anagrafica_id" FROM staging) AS s
WHERE t."anagrafica_id" = s."anagrafica_id";

INSERT INTO "landing" ("anagrafica_id", ...) SELECT "anagrafica_id", ... FROM staging;
```

Cancella **solo le chiavi presenti nel file**: le chiavi non citate restano dove sono. Rimandare lo
stesso file due volte lascia la tabella identica.

**`upsert`** — `INSERT ... ON CONFLICT (chiave) DO UPDATE SET ...`, con le colonne della chiave escluse
dall'aggiornamento. Se le uniche colonne sono la chiave, diventa `ON CONFLICT DO NOTHING`.

### La forma delle righe

Le colonne si fissano al **primo lotto** (o le detta `columns`). Da li' in poi:

- una colonna assente in una riga successiva diventa `null`;
- una colonna **sconosciuta** interrompe il caricamento con `COLUMN_MISMATCH`, invece di perdere il
  dato in silenzio.

Con `replace-by` o `upsert`, la chiave deve essere fra le colonne scritte: altrimenti la sostituzione
colpirebbe righe sbagliate, e il writer si ferma con `REPLACE_KEY_MISSING`.

### Transazionalita'

Tutto avviene in una transazione sola: caricamento, cancellazione e reinserimento. `close(false)` —
che il motore chiama in caso di errore o di soglia di scarto superata — fa rollback e non lascia
niente, nemmeno la tabella temporanea.

```json
{ "type": "postgres", "config": {
  "db": "principale",
  "table": "landing_righe",
  "strategy": "replace-by",
  "replaceKey": ["anagrafica_id"]
} }
```
