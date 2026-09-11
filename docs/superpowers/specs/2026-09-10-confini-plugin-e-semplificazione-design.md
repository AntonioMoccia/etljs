> **Documento storico, superato.** Propone un assetto - meta-pacchetto `etl-js`, `@etl-js/loader`
> come pacchetto a se', plugin caricati per nome - che **non e' quello realizzato**. Il progetto ha
> preso una strada diversa: un pacchetto unico `etljs` con subpath per area, plugin collegati
> esplicitamente con `createEngine().use(...)` e nessun caricamento a runtime. I nomi di pacchetto
> citati qui dentro non esistono piu'. Vedi [la documentazione](../../README.md) per com'e' adesso;
> questo resta come registro delle alternative valutate.

# Confini dei plugin e semplificazione del motore

Data: 2026-09-10 (riscritto il 2026-09-11)
Stato: decisioni approvate, da pianificare

## In una pagina

**Che cos'e' etl-js.** Una libreria npm che prende il file di un flusso, lo trasforma e lo scrive
in una tabella. Non ha stato, non ha file di configurazione, non sa chi sia l'utente. Chi la usa -
un'applicazione, la CLI, una GUI - le passa connessioni, sorgenti e plugin. Resta un **repo suo,
pubblicabile**: il progetto piu' grande la installa.

**Che cosa si decide qui**, in tre gruppi:

| | |
|---|---|
| **Chi mantiene che cosa** | reader e writer sono liste corte che si chiudono da sole; i transformer no, quindi la libreria standard si chiude a sette e il resto lo scrive chi ha il problema |
| **Come i plugin arrivano al motore** | un plugin e' un oggetto, fornibile in tre modi; il motore non se li cerca da solo; un meta-pacchetto per chi vuole tutto pronto |
| **Che cosa si toglie** | i transformer diventano sessioni per run (unica cosa urgente, cambia il protocollo); via `secretRef`, `capabilities`, `category`; `createHostCtx` |

**Che cosa resta fuori**: autenticazione e ruoli (nell'ospite), chi puo' scrivere dove (nei `GRANT`
di Postgres), le Definition (nel progetto ospite), la GUI (un progetto a se').

**Due incognite restano aperte per scelta** - di chi ci si fida e dove girera' il motore - e le
decisioni qui sotto sono prese in modo da non richiedere quella risposta oggi.

---

## Che cos'e' questo pacchetto

Tre affermazioni, tutte vincolanti:

- **Installabile in un altro progetto.** L'ospite comanda: il motore non apre connessioni, non
  decide dove stanno i file, non pianifica, non ricorda. Gia' vero (I6), qui confermato.
- **Sempre estendibile.** L'estendibilita' e' una proprieta' del prodotto, non una comodita'. Da
  qui discendono la chiusura della libreria standard (se cresce su richiesta, "estendere" diventa
  "aspettare che lo aggiungano loro") e l'urgenza del cambio di protocollo (un protocollo si
  aggiusta finche' nessuno lo usa da fuori).
- **GUI se l'utente vuole.** La GUI non e' un plugin ne' un accessorio: e' un **ospite**, cioe' chi
  *contiene* il motore, e nello scenario piu' probabile e' il prodotto, con etl-js come suo motore.

Gli ospiti sono almeno tre - un'applicazione, la CLI, una GUI - e nessuno e' privilegiato. La
cerniera e' sempre la stessa: **l'ospite costruisce il `Ctx` e consegna i plugin, il motore esegue.**

**Dove vive:** un repo suo, pubblicato su npm; il progetto con autenticazione e GUI lo installa come
qualunque dipendenza. Non e' una preferenza organizzativa: e' l'unica forma in cui "importabile in
qualsiasi progetto" e' vera *per costruzione*. Un pacchetto che non puo' vedere il progetto grande
non puo' esserne contaminato, e il fallimento tipico - il prodotto che colonizza la libreria finche'
nessun altro puo' piu' usarla - diventa impossibile invece che sconsigliato.

---

# A. Chi mantiene che cosa

## A1 - La regola di copertura

| | Copre | Varia con |
|---|---|---|
| **host** | credenziali, dove stanno i byte, quando parte un run, dove finiscono i risultati | l'ambiente |
| **core** | lotti, transazioni, soglie, classificazione degli errori, validazione | mai |
| **plugin** | cio' che cambia da flusso a flusso **ed e' esprimibile come dato** | il flusso |

E' la regola gia' implicita in I1/I2/I6: qui viene scritta perche' sia applicabile a una richiesta
nuova senza doverla dedurre ogni volta.

## A2 - Reader e writer non hanno bisogno di regole

**Un reader copre solo il formato**, mai la provenienza: aprire la sorgente e' gia' compito
dell'host via `ctx.openInput`. Se un'origine passa da FTP a S3, nessun plugin cambia. Un reader
nuovo serve solo per un *formato* nuovo, e i formati sono pochi: `csv`, `excel`, `json/ndjson`,
`xml`, tracciato a lunghezza fissa.

**Un writer copre destinazione e strategia**: `postgres`, `mysql`, `sqlserver`, eventualmente
`file`.

Entrambe le liste si esauriscono da sole: se ne aggiunge uno quando un caso reale lo richiede,
senza doverlo giustificare contro nessuna regola. **Il problema di catalogo esiste solo per i
transformer.**

## A3 - La libreria standard dei transformer si chiude a sette

`cast`, `filter`, `default`, `rename`, `validate`, `lookup`, piu' `dedup` (A4). Non cresce su
richiesta.

**Regola d'ammissione**, da scrivere in `CLAUDE.md`:

> Entra nella libreria standard solo un transformer che serve ad **almeno tre flussi diversi** e
> che **non nomina nessun dominio**. Tutto il resto e' un plugin che vive nel repo di chi ne ha
> bisogno.

Da qui la risposta a "chi sviluppa i plugin": **la libreria standard il team, tutto il resto chi ha
il problema.** Il costo di manutenzione del progetto resta finito e noto.

La regola regge solo se scrivere un plugin resta facile - vedi B2, che lo rende un file senza
dipendenze.

## A4 - `dedup` entra, con `keep: "first"`

Serve a tutti e chiude un difetto reale: `upsert` con la stessa chiave due volte nello stesso file
fa fallire l'intero run con *"ON CONFLICT DO UPDATE command cannot affect row a second time"*, e un
CSV di sistemi esterni con una riga esportata due volte e' la norma.

Tiene la **prima** occorrenza: "prima" e' in streaming, "ultima" richiederebbe tutto il file in
memoria. Chi ha bisogno che vinca l'ultima riga usa la strategia `replace-by`, che cancella e
reinserisce e quindi tollera i duplicati per costruzione.

---

# B. Come i plugin arrivano al motore

## B1 - Un plugin e' un oggetto, non un pacchetto

`Plugin` e' `{ manifest, impl }`. La sensazione che "un plugin = un pacchetto npm" nasce solo dal
fatto che oggi l'unico modo di caricarne uno per nome passa dal loader npm. Tolto quel loader dal
motore (B3), la convenzione npm diventa **una strategia di caricamento fra tre**:

| Modo | Cerimonia | Per chi |
|---|---|---|
| **Registrazione diretta**: l'ospite importa l'oggetto e chiama `registry.register(plugin)` | zero, funziona gia' oggi | un'applicazione che incorpora etl-js e ha i propri transformer di dominio |
| **Da una cartella**: il loader importa i `.js` da una cartella indicata dall'ospite | un file, nessun package.json | il plugin custom di un flusso; la GUI che li fa "installare" |
| **Da npm**: come oggi | package.json, versione, pubblicazione | plugin destinati a essere condivisi e versionati |

## B2 - Un plugin custom e' un file senza dipendenze

**Il core valida gia' la config per conto del plugin**: se il manifest porta un JSON Schema,
`validate()` lo compila con Ajv e controlla la Definition prima che il run parta. Zod, nei plugin
standard, serve a *derivare* quello schema, non e' un obbligo.

Un transformer custom completo e' quindi un file, senza dipendenze e senza build: un `manifest` con
un JSON Schema scritto a mano e un `impl.open` che restituisce un oggetto con `transform`. Una
ventina di righe. Va in `docs/scrivere-un-plugin.md` con l'esempio completo, perche' e' la prova che
"sempre estendibile" non e' uno slogan.

## B3 - Il motore non carica codice

Oggi il core, davanti a `"type": "beta-codici"`, cerca su npm `@etl-js/plugin-beta-codici` e lo
importa: **decide di eseguire codice in base a una stringa che sta in un file di configurazione.**

`loadPlugin`, `loadPluginPackage`, `createLoader`, `candidateSpecifiers`, `DEFAULT_PREFIXES` e il
tipo `PluginModule` escono dal core e vanno in **`@etl-js/loader`**, pacchetto proprio che dipende
da `core` e `contracts`. Il core tiene `Registry` e il tipo `PluginResolver`, e riceve i plugin gia'
pronti.

Un pacchetto proprio e non `@etl-js/cli`: la GUI e' un ospite alla pari, e con il loader dentro la
CLI **una interfaccia grafica dipenderebbe da una interfaccia a riga di comando** per installare un
plugin. Ed e' cio' che rende la promessa un fatto: "il motore non carica codice" diventa vero
strutturalmente, perche' il codice che carica codice sta in un pacchetto che devi installare
apposta.

Tre guadagni:

- il modello di fiducia diventa una scelta di **chi installa** - tutto (interno), solo gli approvati
  per quel flusso (SaaS), un bundle fisso (on-premise): **la decisione rimandata resta
  rimandabile**;
- `core` smette di contenere un `import()` dinamico, fastidio concreto per chi impacchetta la GUI
  con Vite o webpack;
- la GUI che "installa i plugin" ha un posto naturale dove farlo, fuori dal motore.

### B3.1 - Caricamento da cartella

In `@etl-js/loader`: `createDirectoryLoader({ dir })` restituisce un `PluginResolver` che risolve un
nome logico in `<dir>/<nome>.js` (o `<dir>/<nome>/index.js`), piu' `scanDirectory(dir)` per
elencare cio' che c'e' - la GUI ne ha bisogno per mostrare i plugin disponibili.

**Il nome arriva da una Definition, quindi va trattato come ostile**: si rifiuta qualunque nome che
contenga `/`, `\` o `..`, e il percorso risolto deve restare dentro `dir`. Stessa classe di bug da
cui `createFileInput({ baseDir })` gia' difende, stessa difesa.

E una nota da scrivere una volta in `docs/` e non ripetere: caricare un file **e' eseguire codice
arbitrario** nel processo dell'ospite. In un'installazione interna e' normale amministrazione; in un
SaaS decide l'ospite se un tenant possa caricare codice. E' la decisione che B3 ha gia' messo nelle
mani giuste: qui si documenta, non si aggiunge nessun meccanismo.

## B4 - Un meta-pacchetto `etl-js` come porta d'ingresso

Oggi incorporare etl-js significa installare `core`, `plugin-csv`, `plugin-postgres`,
`plugin-transforms`, `plugin-lookup` e sapere come assemblarli. La modularita' e' giusta, ma non
deve essere **l'unico** modo di entrare.

Nasce `packages/etl-js/`: dipende dal core e dai plugin standard, ri-esporta `run`, `preview`,
`validate`, `createHostCtx` e offre una `Registry` gia' popolata. `npm i etl-js`, un import, e si
parte. I pacchetti granulari restano per chi vuole solo il reader CSV.

Diventa anche **l'unico punto del progetto in cui dei plugin concreti sono nominati** - ruolo che
oggi ha `packages/cli/src/builtins.ts`, che sparisce: la CLI dipendera' dal meta-pacchetto. Un posto
solo invece di due che possono divergere.

Due dettagli pratici, non rimandabili:

- il pacchetto **privato di radice si chiama gia' `etl-js`**: va rinominato (per esempio
  `etl-js-monorepo`, non viene mai pubblicato) perche' il nome resti libero;
- la disponibilita' del nome `etl-js` su npm va verificata prima di impegnarcisi.

Le regole di dependency-cruiser si estendono: `core` non deve dipendere ne' da `loader` ne' da
`etl-js`, come gia' non dipende dai plugin e dalla CLI.

---

# C. Che cosa si toglie

## C1 - I transformer diventano sessioni per run *(l'unica urgente)*

Oggi un transformer e' un oggetto unico e globale. Lo stato che due plugin devono ricordare fra un
lotto e l'altro (`lookup`: le chiavi gia' cercate; `validate`: i valori gia' visti) finisce quindi
in variabili di modulo, e attorno a quelle sono cresciuti cinque epicicli:

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

- la config si valida **una volta**, in `open`, quindi anche **prima della prima riga letta**;
- la cache di `lookup` e' un campo dell'oggetto: niente LRU, niente prefissi, nessuna perdita di
  memoria possibile, due `lookup` nella stessa Definition indipendenti per costruzione;
- `flush()` significa una cosa sola;
- niente `close()`: la sessione muore quando il run la lascia andare;
- i tre tipi diventano simmetrici e spiegabili in una riga: reader = un generatore per run,
  transformer = una sessione per run, writer = una sessione per run.

`Reader` **non** cambia: `read(config, ctx)` restituisce gia' un iterabile per run.

`flush()` **resta nel protocollo** pur non avendo oggi un utente reale, e per un motivo preciso: A3
sposta fuori dal repo i transformer non standard, e il caso "raggruppa le righe figlie sotto la
testata" e' plausibile in questo dominio e impossibile senza `flush`. Toglierlo chiuderebbe la porta
proprio a chi si e' deciso di incoraggiare.

**Costo:** `PROTOCOL_VERSION` passa a 2; cambiano i 6 transformer, `pipeline.ts`, l'harness e la
documentazione. **Va fatto per primo**: e' l'unica decisione irreversibile del documento, perche'
dal primo plugin scritto fuori dal repo in poi il protocollo non si cambia piu'. Non serve nessuna
finestra di compatibilita': oggi quel plugin non esiste.

## C2 - Via `ctx.secretRef`

Nessun plugin lo usa: lo implementano host e test, e il core si limita a ripassarlo. Toglierlo non
indebolisce I6, lo **rafforza** - il plugin non vede credenziali ne' in chiaro ne' per riferimento.
Se un domani servira', si rimette.

## C3 - Via `Manifest.capabilities` e `Manifest.category`

Scritti da otto plugin, letti da nessuno, validati da nessuno. Quando la GUI esistera' sapra' dire
che cosa le serve per raggruppare i plugin, e un elenco chiuso deciso allora sara' migliore di uno
inventato oggi al buio. Intanto sono due campi che ogni autore compila senza sapere perche' - e per
B2 ogni campo inutile nel manifest e' una domanda in piu' nel tutorial.

## C4 - `createHostCtx`: incorporare deve costare cinque righe, non venticinque

Costruire un `HostCtx` richiede oggi ~25 righe, e la CLI le scrive **due volte** - in `run` e in
`preview` - con comportamenti leggermente diversi. C2 ne toglie gia' una, lasciando quattro campi:
`openInput`, `db`, `log`, `signal`, piu' `dbWrite` se si scrive.

```ts
export function createHostCtx(options: {
  databases?: Record<string, PostgresDbConfig>;
  baseDir?: string;
  log?: Logger;
  signal?: AbortSignal;
}): Promise<{ ctx: HostCtx; close(): Promise<void> }>;
```

Nessun accoppiamento nuovo: `createFileInput` e `createPostgresProvider` stanno gia' nel core. Ed e'
**solo** una comodita': costruire il `Ctx` a mano resta pienamente supportato, ed e' quello che fara'
ogni ospite con un proprio pool, un proprio object storage o una propria politica di autorizzazione.
La comodita' non deve diventare la via benedetta, altrimenti riporta dentro il motore le decisioni
che I6 tiene fuori.

---

# D. Che cosa resta fuori

## D1 - Autenticazione e autorizzazione

Il progetto piu' grande avra' utenti, ruoli e permessi. Il motore no. L'autorizzazione tocca quattro
superfici:

| Cosa si autorizza | Dove si applica | Stato |
|---|---|---|
| quali plugin puo' usare un utente | la `Registry` che l'ospite consegna | coperto da B3 |
| quali database logici puo' raggiungere | `ctx.db(name)`: e' l'ospite a mappare i nomi logici | coperto da I6 |
| quali file puo' leggere | `ctx.openInput` + `createFileInput({ baseDir })` | coperto |
| **su quale tabella puo' scrivere** | **niente glielo impedisce** | vedi sotto |

Il buco: una Definition dichiara `"table": "landing_piani"` e il writer ci scrive. Se un domani le
Definition arrivano dagli utenti, `"table": "utenti"` e' altrettanto valida. L'ospite non puo'
controllarlo dall'esterno senza sapere che quel campo e' un nome di tabella - cioe' senza far
entrare la conoscenza dei plugin nell'ospite, che e' il male che I2 evita.

**La risposta e' quella gia' usata per I4: la fa rispettare il database.** L'ospite consegna una
connessione il cui ruolo Postgres ha i `GRANT` solo sulle tabelle permesse, e il server rifiuta il
resto, esattamente come oggi rifiuta le scritture dei transformer con
`default_transaction_read_only=on`. Zero modifiche al motore, e l'autorizzazione finisce nell'unico
posto che non si puo' aggirare.

L'ospite **puo'** leggere `definition.destination.config.table` per dare un errore comprensibile
prima di partire: e' cortesia verso l'utente, non sicurezza, e va scritto cosi' perche' nessuno lo
scambi per un controllo.

**Tracciabilita':** "chi ha caricato che cosa" e' gia' rispondibile senza che il motore sappia chi
sia un utente. L'ospite genera il `runId` e lo passa nel `Ctx`; il transformer `default` con
`fromMeta` lo scrive dentro ogni riga insieme al file di origine e al numero di riga. All'ospite
basta ricordare la coppia runId -> utente.

### I10 - Nessun concetto di identita' nel motore

> Il motore non conosce utenti, tenant, ruoli, permessi, sessioni. Se qualcuno propone un
> `tenantId` nei contratti o un `permissions` nel `Ctx`, l'autorizzazione sta entrando nel posto
> sbagliato: va spostata nell'ospite, nella `Registry`, nel `Ctx` o nei `GRANT`.

Da aggiungere alla tabella degli invarianti in `CLAUDE.md`. A differenza di I2 e I9 non e'
verificabile da dependency-cruiser: la difesa strutturale e' che etl-js sta in un repo suo e non puo'
importare nulla dal progetto grande. Il resto e' revisione del codice.

## D2 - etl-js non ha file di configurazione

Domanda inevitabile quando si installa da npm: "dove metto i file di configurazione?". Risposta:
**non ce ne sono.** Niente `.etlrc`, niente da copiare dopo l'install, niente da leggere da
`node_modules`.

- La **Definition** e' un argomento di `run(definition, ctx)`: un **oggetto**, non un percorso. E'
  un dato dell'**applicazione ospite** e vive dove l'ospite tiene i suoi dati - una riga nel
  database della GUI, un file nel repo dell'app, un oggetto su object storage. Solo la CLI la legge
  da un file, perche' una CLI deve pur prendere un argomento.
- Le **credenziali** non le vede mai (I6): le mette l'ospite nel `Ctx`.
- L'**elenco dei plugin** e' la `Registry` che costruisce l'ospite.

E' cio' che "libreria senza stato" gia' significa in `CLAUDE.md`, detto in modo utilizzabile.

**Corollario da scrivere accanto a I8:** le Definition diventano venti file quando i flussi sono
venti. Stanno nel progetto ospite, **mai** dentro il pacchetto. `examples/` resta quello che e'.

## D3 - La GUI si costruisce sopra `preview()`

Il `configSchema` permette alla GUI di disegnare il form di ogni stadio, ma **non le dice quali
campi della riga esistono all'ingresso di quello stadio**: non puo' offrire un menu con
`codice, data_documento, quantita`.

Si sceglie **`preview()`**: per sapere che campi entrano nello stadio *k*, la GUI chiama `preview()`
su una Definition con i **primi k-1** transformer. Il risultato e' provatamente identico a quello
del run intero, perche' i transformer sono side-effect free (I4): rieseguire i primi stadi sulle
stesse righe non puo' dare un esito diverso. **E' I4 a rendere possibile questa GUI**, non solo
l'idempotenza dei run.

Il costo e' trascurabile e va detto perche' a occhio sembra alto: `preview` si ferma al **primo
lotto** che raggiunge `limitRows`, quindi sei chiamate su un campione di venti righe sono sei
letture di un lotto, non sei letture del file.

**Via d'uscita, se un giorno servisse:** un evento `onStepBatch` emesso da `pipeline.ts` dopo ogni
transformer. Sono poche righe e **non e' un cambio di protocollo** - `RunEvents` guarda l'host, non
i plugin - quindi si aggiunge in qualsiasi momento. Non si fa ora perche' sarebbe API costruita per
un consumatore che non esiste ancora: lo stesso motivo per cui C2 e C3 tolgono roba.

Gli **scarti** sono gia' attribuiti per stadio: `onRecordFailed` porta il campo `step`. Il buco
riguarda solo le righe sopravvissute.

---

## Cosa non cambia

- I nove invarianti, tutti. B3 e C2 rafforzano I6; C1 non tocca I4. D1 ne **aggiunge** uno, I10.
- I sette pacchetti esistenti: sono unita' di distribuzione, e chi vuole `plugin-csv` non deve
  tirarsi dietro Postgres. **Nessuno viene fuso.** Se ne aggiungono due, per motivi opposti fra
  loro: `loader` per tenere **fuori** dal motore il codice che carica codice, `etl-js` per dare una
  porta d'ingresso a chi non vuole assemblare niente.
- `contracts` a zero dipendenze e le regole di dependency-cruiser.
- `EtlError` e la classificazione degli errori.
- La forma di un run: una sorgente, N transformer, una destinazione.

## Impatto

| Pacchetto | Che cosa cambia |
|---|---|
| `contracts` | `Transformer`/`TransformSession` (C1), `PROTOCOL_VERSION` 2, via `run-cache.ts`, via `secretRef`, via `capabilities`/`category`, via `PluginModule` |
| `core` | `pipeline.ts` apre e usa le sessioni; `context.ts` senza `secretRef`; `loader.ts` esce; nasce `createHostCtx` |
| `loader` (nuovo) | `loadPlugin`, `createLoader`, i prefissi npm, `PluginModule`, `createDirectoryLoader` |
| `etl-js` (nuovo) | meta-pacchetto: core + plugin standard, registry pronta, ri-esporta l'API |
| `plugin-transforms` | 5 transformer a sessione, `configReader` dimezzato, `seenByRun` sparisce; nasce `dedup` |
| `plugin-lookup` | a sessione: spariscono `cachesByRun`, `configId`, `parsedConfigs` |
| `plugin-csv`, `plugin-postgres` | solo `protocol: 2` nel manifest |
| `cli` | dipende dal meta-pacchetto; `builtins.ts` sparisce; una sola costruzione del `Ctx` |
| `testing` | harness a sessione, `mockCtx` senza `secretRef` |
| `docs/`, `CLAUDE.md` | regola d'ammissione, protocollo 2, `dedup`, i campi tolti, I10, i `GRANT`, dove vivono le Definition, l'esempio di plugin custom |

Il conto: **sei concetti in meno nei contratti**, tutto lo stato globale mutabile dei plugin, e il
motore che smette di caricare codice da solo.

## Ordine dei lavori

1. **C1** - transformer a sessione, protocollo 2. Per primo perche' irreversibile.
2. **A4** - `dedup` sulla nuova API: chiude il difetto dell'`upsert` ed e' la prova che l'API regge.
3. **B3** - il loader esce dal core e diventa `@etl-js/loader`; nasce la regola dependency-cruiser
   che impedisce a `core` di tornare a dipenderne.
4. **C2 + C3 + C4** - le rimozioni e `createHostCtx`; la CLI smette di costruire il contesto due
   volte.
5. **B4 + B3.1** - il meta-pacchetto, la rinomina del pacchetto di radice, `builtins.ts` che
   sparisce, il caricamento da cartella con la difesa dai nomi ostili.
6. **Documentazione** - A1, A3, B2, D1/I10, D2, D3 in `CLAUDE.md` e `docs/`.

Ogni passo si chiude con `npm run check` verde: e' il criterio di done gia' in uso nel progetto.

## Rischi

| Rischio | Mitigazione |
|---|---|
| C1 tocca tutti i transformer insieme | Sono 6 file piccoli con test propri; la suite e' verde oggi e deve restarlo a ogni passo |
| La regola d'ammissione verra' aggirata sotto la pressione di un flusso che paga | Sta scritta in `CLAUDE.md` accanto agli invarianti, dove si legge prima di aggiungere codice |
| `flush()` resta senza utenti reali anche dopo | Accettato: e' l'unico modo per lasciare aperto il caso aggregazione a chi scrive plugin fuori dal repo |
| Il loader spostato rompe il caricamento per nome | Il test `cli > l'esempio completo e' valido con i plugin caricati da npm` lo copre gia' |
| Due pacchetti in piu' da pubblicare e versionare | Accettato: e' il prezzo per cui B3 e' strutturale e B4 esiste. Chi non ne ha bisogno non li installa |

## Fuori scopo

Difetti noti, gia' rilevati, da pianificare a parte:

- una colonna inattesa fa fallire il run intero invece di scartare la riga (`writer.ts`,
  `#resolveColumns`);
- `RunResult.written` conta le righe consegnate al writer, non quelle committate;
- la pipeline e' sequenziale: mentre il `COPY` va in rete, reader e transformer sono fermi;
- non c'e' CI, e le due suite Postgres si saltano in silenzio senza `PG_TEST_URL`.
