# Concetti

Dieci minuti per il modello mentale. Tutto il resto della documentazione presuppone questa pagina.

## Il problema

Venti origini diverse mandano ogni settimana un file CSV, e devono confluire tutte nella **stessa
tabella**. Le colonne si somigliano ma non sono mai uguali: una scrive `Codice`, un'altra `Cod. Art.`;
una usa il punto e virgola, un'altra la virgola; le date sono `03/02/2026` o `2026-02-03` o
"settimana 7"; le quantita' hanno la virgola decimale e il punto delle migliaia. In cima al file c'e'
l'intestazione del sistema che l'ha esportato, in fondo una riga di totali.

Quei dati vanno collegati a record che esistono gia' sul database, e riscritti ogni volta che
l'origine rimanda il file aggiornato, **senza duplicare nulla**.

La tentazione e' scrivere uno script per ogni origine. A venti origini sono venti script che nessuno
ricorda, ognuno col suo bug. `etl-js` esiste per fare in modo che un'origine sia **un file JSON**.

## La Definition

E' la descrizione completa di un'importazione: da dove leggere, cosa fare alle righe, dove scrivere.

```json
{
  "client": "acme",
  "source":      { "type": "csv",      "config": { ... } },
  "transform": [ { "type": "filter",   "config": { ... } },
                 { "type": "cast",     "config": { ... } } ],
  "destination": { "type": "postgres", "config": { ... } },
  "policy": { "maxFailedRatio": 0.2, "rejectFile": true }
}
```

Tre cose da notare, perche' sono l'intero progetto in miniatura:

**E' un dato, non codice.** Nessuna funzione, nessuna espressione: solo valori. Si versiona in git,
si diffa, si valida, e un giorno una GUI potra' generarla.

**Non nomina il flusso da nessuna parte se non in `client`.** Non c'e' `"tipo": "csv-acme"`. Se ti
trovi a scrivere il nome di un flusso dentro un plugin, manca un parametro alla config.

**I `type` sono nomi logici, non pacchetti npm.** Il motore non sa cosa sia `"cast"`: lo cerca fra i
plugin che gli hai collegato con `createEngine().use(...)`. Non c'e' un solo `if` sul tipo, in tutto
il core.

Riferimento completo: [definition.md](definition.md).

## Il flusso di un run

```
reader --> Batch --> transformer --> Batch --> transformer --> Batch --> writer
```

**Reader.** Legge la sorgente e produce lotti di righe, in streaming. Non apre file: i byte glieli da'
il core (vedi `openInput` piu' sotto). Un CSV da due giga non si carica in memoria.

**Transformer.** Riceve un lotto, restituisce un lotto (le righe sopravvissute) piu' un elenco di
righe fallite col motivo. Puo' leggere dal database, non puo' scrivere. E' sostituibile, componibile,
e non sa nulla di chi sta prima o dopo di lui.

**Writer.** Apre una sessione, che di norma e' una transazione. Riceve i lotti. Alla fine viene chiuso
con `commit` o con `rollback`. Se qualcosa va storto a meta', non resta niente a terra.

Il motore (`run`) mette in fila questi tre e conta. Non sa cosa siano.

## Batch, Row, Failed

```ts
type Row = Record<string, unknown>;

interface Batch {
  rows: Row[];
  meta: { runId: string; source: string; offset: number };
}

interface Failed {
  row: Row;
  reason: string;      // per un operatore: "campo quantita: 0 e' sotto il minimo 1"
  code: string;        // per un programma: "VALIDATION_FAILED"
  severity: "reject" | "warn";
  offset: number;      // la riga nel file
  runId?: string;      // compilati dal motore
  source?: string;
}
```

**Una riga e' un sacchetto di valori senza tipo.** Il tipo glielo danno i transformer: dal reader
arriva tutto stringa, `cast` la trasforma in numeri e date.

**`meta.offset` e' l'indice della prima riga del lotto**, contato dalla prima riga di dati. Sommato
all'indice dentro il lotto da' il numero di riga nel file: e' cosi' che uno scarto sa dire *"riga
47 del file"*.

**Si ragiona sempre a lotti.** Non esiste una API per riga singola, e non e' una scelta di stile: e'
cio' che rende possibile fare **una** interrogazione al database per mille righe invece di mille.

**`reject` scarta la riga, `warn` la lascia passare segnalandola.** La decisione sta nella config di
ogni regola, non nel motore.

## Il Ctx: tutto cio' che un plugin non puo' fare da solo

```ts
interface Ctx {
  runId: string;
  openInput(ref: string): Promise<ByteStream>;   // i byte della sorgente
  db(name: string): ReadOnlyDb;                  // sola lettura
  secretRef(ref: string): string;                // mai la credenziale grezza
  log: Logger;
  signal: AbortSignal;
}
```

Un plugin **non apre file e non apre connessioni**. Li chiede al contesto, che glieli passa gia'
pronti. Il motivo non e' purezza: e' che in sviluppo il file sta su disco e in produzione su object
storage, e il plugin deve funzionare identico in entrambi i casi. Lo stesso per il database: pool,
transazioni e credenziali sono cose dell'host.

Due dettagli che valgono piu' di una regola scritta:

- Il `Ctx` che ricevono reader e transformer **non ha** `dbWrite`. Non e' una convenzione: quel
  metodo proprio non esiste su quell'oggetto. Un transformer non puo' scrivere nemmeno volendo.
- La connessione in lettura si apre con `default_transaction_read_only=on`. Se un transformer
  provasse a chiamare una procedura che scrive, e' **Postgres** a rifiutare.

## Le politiche: cosa fare quando i dati sono sbagliati

Un file di un flusso e' sbagliato in parte quasi sempre. La domanda non e' "e' valido?", ma "quanto
puo' essere sbagliato prima che convenga fermarsi?".

```json
"policy": { "maxFailedRatio": 0.2, "rejectFile": true }
```

Sotto la soglia il run va a termine e importa il buono; sopra la soglia il run **viene annullato e la
destinazione riceve rollback**. La differenza fra "importa quel che puoi" e "non toccare niente" e'
un numero nella config, non una decisione presa da chi ha scritto il motore.

## Chi decide cosa

E' la domanda che risolve la maggior parte dei dubbi:

| Decisione | Chi |
|---|---|
| Che formato ha il file di questo flusso | la **Definition** |
| Come si legge un CSV | il **plugin** `csv` |
| Se una riga e' accettabile | il **plugin** `validate`, secondo le regole della Definition |
| Quanti scarti tollerare | la **policy** nella Definition |
| Dove sta il file, come ci si connette al DB, dove finiscono i log | l'**host**, via `Ctx` |
| L'ordine dei passaggi e i conteggi | il **core** |
| Cosa fare del risultato: riprovare, notificare, promuovere i dati | l'**host** |

Il core non decide **niente** che riguardi i dati. Conta, mette in fila, e riporta.

## Cosa non c'e', di proposito

Non ci sono GUI, server HTTP, autenticazione, code, scheduler, ne' persistenza dei run. Sono cose
dell'applicazione che usa questa libreria. `etl-js` esegue un'importazione e restituisce un
`RunResult`: sta a chi la chiama decidere se salvarlo, mostrarlo o riprovare.

Dettagli e alternative: [limiti.md](limiti.md).
