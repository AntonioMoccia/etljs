# Confini dei plugin e semplificazione del motore

Data: 2026-09-10
Stato: approvato in discussione, da pianificare

## La domanda

Tre domande, che sono la stessa domanda:

1. **Che cosa copre un plugin?**
2. **Chi lo sviluppa?**
3. **Come si riduce la complessita' del motore**, visto che sara' incorporato in un'applicazione
   piu' grande e affiancato a una GUI che permettera' anche di installare i plugin?

Che **chiunque possa scrivere un plugin** e' deciso: e' l'identita' del pacchetto (D0) ed e' cio' che
D3 e D5 servono a proteggere. Restano invece aperte per scelta due domande diverse: **di chi ci si
fida** (chi scrive un plugin che gira sul vostro processo: solo il team, integratori noti, o
chiunque pubblichi su npm) e **dove girera' il motore** (installazione interna, SaaS multi-tenant,
on-premise). Le decisioni qui sotto sono prese in modo da non richiedere quella risposta oggi e da
non precluderne nessuna domani - D4 in particolare esiste per questo.

---

## D0 - Che cos'e' questo pacchetto

Una **libreria installabile in un altro progetto**, **sempre estendibile tramite plugin**, e
**utilizzabile anche tramite una GUI se l'utente lo vuole**.

Le tre parti non sono descrittive, sono vincolanti:

- **installabile in un altro progetto**: l'ospite comanda. Il motore non apre connessioni, non
  decide dove stanno i file, non pianifica, non ricorda. Gia' vero (I6), qui confermato.
- **sempre estendibile**: l'estendibilita' e' una proprieta' del prodotto, non una comodita'. Ne
  discende D3 (se la libreria standard cresce su richiesta, "estendere" diventa "aspettare che lo
  aggiungano loro") e ne discende l'urgenza di D5 (un protocollo si aggiusta finche' nessuno lo usa
  da fuori).
- **GUI se l'utente vuole**: la GUI non e' un plugin e non e' un accessorio. E' un **ospite** nel
  senso tecnico - chi *contiene* il motore - e nello scenario piu' probabile e' addirittura **il
  prodotto**, con etl-js come suo motore interno. Ne discende D4: se fosse il motore a caricare da
  se' i plugin, la GUI che "installa i plugin" starebbe combattendo con lui invece di decidere.

Gli ospiti sono almeno tre - un'applicazione che incorpora la libreria, la CLI, una GUI - e nessuno
e' privilegiato. La cerniera e' sempre la stessa: **l'ospite costruisce il `Ctx` e consegna i
plugin, il motore esegue.**

## D1 - La regola di copertura

| | Copre | Varia con |
|---|---|---|
| **host** | credenziali, dove stanno i byte, quando parte un run, dove finiscono i risultati | l'ambiente |
| **core** | lotti, transazioni, soglie, classificazione degli errori, validazione | mai |
| **plugin** | cio' che cambia da cliente a cliente **ed e' esprimibile come dato** | il cliente |

E' la regola gia' implicita in I1/I2/I6: qui viene scritta perche' sia applicabile a una richiesta
nuova senza doverla dedurre ogni volta.

## D2 - Reader e writer sono liste chiuse: non serve limitarli

**Un reader copre solo il formato**, mai la provenienza: aprire la sorgente e' gia' compito
dell'host via `ctx.openInput`. Se un cliente passa da FTP a S3, nessun plugin cambia. Un reader
nuovo serve solo per un *formato* nuovo, e i formati al mondo sono pochi: `csv`, `excel`,
`json/ndjson`, `xml`, tracciato a lunghezza fissa.

**Un writer copre destinazione e strategia**: `postgres`, `mysql`, `sqlserver`, eventualmente
`file`. Anche questa lista si chiude da sola.

Conseguenza: **nessuna regola d'ammissione serve per reader e writer.** Un reader o un writer nuovo
si aggiunge quando un caso reale lo richiede, senza doverlo giustificare contro una regola: la lista
si esaurisce da sola. Il problema di catalogo esiste solo per i transformer.

## D3 - La libreria standard dei transformer e' chiusa

La libreria standard e' **finita**: `cast`, `filter`, `default`, `rename`, `validate`, `lookup`,
piu' `dedup` (vedi D3.1). Non cresce su richiesta.

**Regola d'ammissione**, da scrivere in `CLAUDE.md`:

> Entra nella libreria standard solo un transformer che serve ad **almeno tre clienti diversi** e
> che **non nomina nessun dominio**. Tutto il resto e' un plugin che vive nel repo di chi ne ha
> bisogno.

La risposta a "chi sviluppa i plugin" discende da qui: **la libreria standard il team, il lungo
periodo chiunque abbia il problema.** Il costo di manutenzione del progetto resta finito e noto.

La regola regge solo se scrivere un plugin resta facile: ~60 righe e un `npm install`. Ogni
decisione successiva in questo documento e' compatibile con quel vincolo, e due lo migliorano
(D6, D7: due concetti in meno da spiegare nel tutorial).

### D3.1 - `dedup` entra, con `keep: "first"`

Serve a tutti (non a un cliente) e chiude un difetto reale: `upsert` con la stessa chiave due volte
nello stesso file fa fallire l'intero run con *"ON CONFLICT DO UPDATE command cannot affect row a
second time"*, e un CSV di gestionale con una riga esportata due volte e' la norma.

Tiene la **prima** occorrenza, non l'ultima: "prima" e' in streaming, "ultima" richiederebbe di
tenere tutto il file in memoria. Chi ha bisogno che vinca l'ultima riga usa la strategia
`replace-by`, che cancella e reinserisce e quindi tollera i duplicati per costruzione.

## D4 - Il motore non carica codice

Oggi il core, davanti a `"type": "beta-codici"`, va a cercare su npm `@etl-js/plugin-beta-codici` e
lo importa: **decide di eseguire codice in base a una stringa che sta in un file di
configurazione.** In un'installazione interna non e' un problema; in un SaaS multi-tenant lo e'.

`loadPlugin`, `loadPluginPackage`, `createLoader`, `candidateSpecifiers`, `DEFAULT_PREFIXES` e il
tipo `PluginModule` **escono dal core** e vanno in un pacchetto proprio, **`@etl-js/loader`**, che
dipende da `core` e `contracts`. Il core tiene `Registry` e il tipo `PluginResolver`, e riceve i
plugin gia' pronti.

Un pacchetto proprio e non `@etl-js/cli`: per D0 la GUI e' un ospite alla pari, e con il loader
dentro la CLI una **interfaccia grafica dovrebbe dipendere da una interfaccia a riga di comando**
per poter installare un plugin. CLI e GUI lo usano entrambe alla pari; chi incorpora la libreria in
un'applicazione che i plugin li conosce gia' non lo installa affatto. E' anche cio' che rende D4 un
fatto invece di una promessa: "il motore non carica codice" diventa vero **strutturalmente**, perche'
il codice che carica codice sta in un pacchetto che devi installare apposta.

Tre guadagni:

- il modello di fiducia diventa una scelta di **chi installa**: la GUI passa tutto (interno), solo
  gli approvati per quel cliente (SaaS), o un bundle fisso (on-premise). **La decisione rimandata
  resta rimandabile.**
- `core` smette di contenere un `import()` dinamico, che e' un fastidio concreto per chiunque
  impacchetti la GUI con Vite o webpack;
- la GUI che "installa i plugin" ha un posto naturale dove farlo, fuori dal motore.

## D5 - I transformer diventano sessioni per run

Oggi un transformer e' un oggetto unico e globale. Lo stato che due plugin devono ricordare fra un
lotto e l'altro (`lookup`: le chiavi gia' cercate; `validate`: i valori gia' visti) finisce quindi in
variabili di modulo, e attorno a quelle sono cresciuti cinque epicicli:

- `createRunCache` in `contracts`, con LRU sugli ultimi 8 run per non perdere memoria;
- `configId()` in `lookup`, chiave costruita con `JSON.stringify` perche' due `lookup` nella stessa
  Definition non si mescolino;
- due `WeakMap` per non ripassare da Zod la stessa config a ogni lotto;
- `flush()` usato in **entrambi** i plugin per liberare memoria invece che per emettere la coda;
- meta' di `configReader` in `plugin-transforms`.

Nuova forma, simmetrica a quella del writer:

```ts
export interface TransformSession {
  transform(batch: Batch): Promise<TransformResult>;
  /** Per chi accumula: emette la coda a fine run. */
  flush?(): Promise<TransformResult>;
}

export interface Transformer {
  open(config: unknown, ctx: Ctx): Promise<TransformSession>;
}
```

Conseguenze:

- la config si valida **una volta**, in `open`, e quindi anche **prima della prima riga letta**;
- la cache di `lookup` e' un campo dell'oggetto: niente LRU, niente prefissi, nessuna perdita di
  memoria possibile, due `lookup` nella stessa Definition indipendenti per costruzione;
- `flush()` significa una cosa sola;
- niente `close()`: la sessione muore quando il run la lascia andare. Se un giorno un transformer
  terra' una risorsa, si aggiungera' allora.
- i tre tipi diventano simmetrici e spiegabili in una riga: reader = un generatore per run,
  transformer = una sessione per run, writer = una sessione per run.

`Reader` **non** cambia: `read(config, ctx)` restituisce gia' un iterabile per run, e il suo stato
vive nel generatore.

`flush()` **resta nel protocollo** pur non avendo oggi un utente reale, e per un motivo preciso: D3
sposta fuori dal repo i transformer non standard, e il caso "raggruppa le righe figlie sotto la
testata" e' plausibile in questo dominio e impossibile senza `flush`. Toglierlo chiuderebbe la porta
proprio a chi abbiamo appena deciso di incoraggiare.

**Costo:** `PROTOCOL_VERSION` passa a 2, e cambiano i 6 transformer, `pipeline.ts`, l'harness di
test e la documentazione. **Va fatto per primo**: e' l'unica decisione irreversibile del documento,
perche' dal primo plugin scritto fuori dal repo in poi il protocollo non si cambia piu'.

## D6 - Via `ctx.secretRef`

Nessun plugin lo usa: lo implementano host e test, e il core si limita a ripassarlo. Toglierlo non
indebolisce I6, lo **rafforza** - il plugin non vede credenziali ne' in chiaro ne' per riferimento.
Se un domani servira' (un plugin che chiama un'API con una chiave), si rimette.

## D7 - Via `Manifest.capabilities` e `Manifest.category`

Scritti da otto plugin, letti da nessuno, validati da nessuno. La GUI non esiste ancora: quando
esistera' sapra' dire che cosa le serve per raggruppare i plugin, e un elenco chiuso deciso allora
sara' migliore di uno inventato oggi al buio. Intanto sono due campi che ogni autore di plugin
compila senza sapere perche'.

## D8 - La GUI si costruisce sopra `preview()`

Il `configSchema` del manifest permette alla GUI di disegnare il form di ogni stadio, ma **non le
dice quali campi della riga esistono all'ingresso di quello stadio**: non puo' offrire un menu con
`ordine_cliente, data_consegna, quantita`.

Si sceglie **`preview()`**: la GUI chiede un file d'esempio e mostra i campi veri, stadio per stadio.
Empirico, gia' implementato, zero aggiunte al protocollo.

**Come**, in concreto: per sapere che campi entrano nello stadio *k*, la GUI chiama `preview()` su
una Definition con i **primi k-1** transformer. Il risultato e' provatamente lo stesso che darebbe il
run intero, perche' i transformer sono side-effect free (I4): rieseguire i primi stadi sulle stesse
righe non puo' dare un esito diverso. **E' I4 a rendere possibile questa GUI**, non solo
l'idempotenza dei run.

Il costo e' trascurabile e vale la pena dirlo, perche' a occhio sembra alto: `preview` si ferma al
**primo lotto** che raggiunge `limitRows`, quindi sei chiamate su un campione di venti righe sono
sei letture di un lotto, non sei letture del file.

**Via d'uscita, se un giorno servisse:** un evento `onStepBatch` emesso da `pipeline.ts` dopo ogni
transformer, e un campo per stadio nel `PreviewResult`. Sono poche righe e - cosa che qui conta -
**non e' un cambio di protocollo**: `RunEvents` e' rivolto all'host, non ai plugin, quindi si puo'
aggiungere in qualsiasi momento senza rompere nessun plugin esistente. Non si fa ora perche'
sarebbe API costruita per un consumatore che non esiste ancora e non puo' essere intervistato -
lo stesso motivo per cui D6 e D7 tolgono roba.

Gli **scarti** sono gia' attribuiti per stadio: `onRecordFailed` porta il campo `step`. Il buco
riguarda solo le righe sopravvissute.

Si **scarta** l'alternativa (dichiarare i campi in uscita nel manifest): sarebbe lavoro su ogni
plugin e non potrebbe mai essere accurato, perche' i campi di `rename` dipendono dalla config e
quelli di `lookup` dal database.

---

## Cosa non cambia

- I nove invarianti, tutti. D4 e D6 rafforzano I6; D5 non tocca I4 (la sessione riceve un `Ctx` in
  sola lettura come oggi).
- I sette pacchetti esistenti: sono unita' di distribuzione, e chi vuole `plugin-csv` non deve
  tirarsi dietro Postgres. Nessuno viene fuso; D4 ne aggiunge un ottavo (`loader`), e lo aggiunge
  proprio per tenere separato cio' che oggi e' mescolato.
- `contracts` a zero dipendenze e le regole di dependency-cruiser.
- `EtlError` e la classificazione degli errori.
- La forma di un run: una sorgente, N transformer, una destinazione.

## Impatto

| Pacchetto | Che cosa cambia |
|---|---|
| `contracts` | `Transformer`/`TransformSession` (D5), `PROTOCOL_VERSION` 2, via `run-cache.ts`, via `secretRef`, via `capabilities`/`category`, via `PluginModule` |
| `core` | `pipeline.ts` apre e usa le sessioni; `context.ts` senza `secretRef`; `loader.ts` esce |
| `loader` (nuovo) | accoglie `loadPlugin`, `createLoader`, i prefissi npm e `PluginModule` |
| `cli` | usa `@etl-js/loader`; `builtins.ts` e la costruzione del `Ctx` si adeguano |
| `plugin-transforms` | 5 transformer a sessione, `configReader` dimezzato, `seenByRun` sparisce; nasce `dedup` |
| `plugin-lookup` | a sessione: spariscono `cachesByRun`, `configId`, `parsedConfigs` |
| `plugin-csv`, `plugin-postgres` | solo `protocol: 2` nel manifest |
| `testing` | harness a sessione, `mockCtx` senza `secretRef` |
| `docs/`, `CLAUDE.md` | regola d'ammissione (D3), nuovo protocollo, `dedup`, i campi tolti |

Il conto: **sei concetti in meno nei contratti**, tutto lo stato globale mutabile dei plugin, e il
motore che smette di caricare codice da solo.

Nessuna finestra di compatibilita' fra protocollo 1 e 2: non esiste ancora un plugin fuori da questo
repo. E' esattamente il motivo per cui si fa adesso.

## Ordine dei lavori

1. **D5** - transformer a sessione, protocollo 2. Per primo perche' irreversibile.
2. **D3.1** - `dedup` scritto sulla nuova API: e' anche la prova che l'API nuova regge, e chiude il
   difetto dell'`upsert` con chiavi duplicate.
3. **D4** - il loader esce dal core e diventa `@etl-js/loader`; nasce la regola dependency-cruiser
   che impedisce a `core` di tornare a dipenderne.
4. **D6 + D7** - `secretRef`, `capabilities`, `category` via.
5. **D1 + D3 + D8** - la regola d'ammissione e la scelta su `preview` in `CLAUDE.md` e `docs/`.

Ogni passo si chiude con `npm run check` verde: e' il criterio di done gia' in uso nel progetto.

## Rischi

| Rischio | Mitigazione |
|---|---|
| D5 tocca tutti i transformer insieme | Sono 6 file piccoli con test propri; la suite e' verde oggi e deve restarlo a ogni passo |
| La regola d'ammissione verra' aggirata sotto la pressione di un cliente che paga | Sta scritta in `CLAUDE.md` accanto agli invarianti, dove si legge prima di aggiungere codice |
| `flush()` resta senza utenti reali anche dopo | Accettato: e' l'unico modo per lasciare aperto il caso aggregazione a chi scrive plugin fuori dal repo |
| Il loader spostato rompe il caricamento per nome | Il test `cli > l'esempio completo e' valido con i plugin caricati da npm` lo copre gia' |
| Un ottavo pacchetto e' un pacchetto in piu' da pubblicare e versionare | Accettato: e' il prezzo per cui D4 e' strutturale e non una promessa. Chi non carica plugin dinamicamente non lo installa |

## Fuori scopo

Difetti noti, gia' rilevati, che **non** fanno parte di questo documento e vanno pianificati a
parte:

- una colonna inattesa fa fallire il run intero invece di scartare la riga (`writer.ts`,
  `#resolveColumns`);
- `RunResult.written` conta le righe consegnate al writer, non quelle committate;
- la pipeline e' sequenziale: mentre il `COPY` va in rete, reader e transformer sono fermi;
- non c'e' CI, e le due suite Postgres si saltano in silenzio senza `PG_TEST_URL`.
