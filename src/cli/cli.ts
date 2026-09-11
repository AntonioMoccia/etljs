import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  ErrorCodes,
  EtlError,
  type Definition,
  type Manifest,
  type RunResult,
} from "../contracts/index.js";
import {
  createEngine,
  createFileInput,
  createPostgresProvider,
  describePlugin,
  preview,
  validate,
  type DbProvider,
  type Engine,
  type HostCtx,
} from "../core/index.js";
import { builtinPlugins } from "./builtins.js";
import { jsonLogger } from "./logger.js";
import { RejectFile } from "./rejects.js";

const USAGE = `etl-js - importazione dati guidata da una Definition JSON

  etl-js run <definition.json> [opzioni]
      --input <file>        sovrascrive source.config.input
      --dry-run             esegue tutto tranne la scrittura
      --limit <n>           si ferma dopo n righe lette
      --db <nome=url>       connessione per un database logico (ripetibile)
      --log <livello>       debug | info | warn | error   (default: info)
      --rejects <file.csv>  scrive le righe scartate col motivo, man mano

  etl-js plugins             elenca i plugin disponibili con il loro manifest
  etl-js describe <plugin>   stampa il JSON Schema della config di un plugin
  etl-js validate <def.json>
                            controlla una Definition senza eseguirla
  etl-js preview <def.json> [-n <righe>] [--input <file>]
                            mostra cosa esce dalle prime righe, senza scrivere

Le credenziali non si passano a riga di comando: --db accetta anche
"nome=env:NOME_VARIABILE" e la stringa viene letta dall'ambiente.
`;

/** Legge una Definition da file, con errori comprensibili invece di stack di JSON.parse. */
async function loadDefinition(path: string): Promise<Definition> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new EtlError(`Impossibile leggere la Definition ${path}`, {
      code: ErrorCodes.SOURCE_UNREADABLE,
      context: { path },
      cause: error,
    });
  }
  try {
    return JSON.parse(text) as Definition;
  } catch (error) {
    throw new EtlError(`La Definition ${path} non e' JSON valido`, {
      code: ErrorCodes.CONFIG_INVALID,
      context: { path },
      cause: error,
    });
  }
}

/** Risolve "nome=url" oppure "nome=env:VARIABILE". */
function parseDbOption(entry: string): [string, string] {
  const separator = entry.indexOf("=");
  if (separator <= 0) {
    throw new EtlError(`--db vuole la forma nome=url, ricevuto "${entry}"`, {
      code: ErrorCodes.INVALID_USAGE,
    });
  }
  const name = entry.slice(0, separator);
  const value = entry.slice(separator + 1);
  if (!value.startsWith("env:")) return [name, value];
  const variable = value.slice("env:".length);
  const fromEnv = process.env[variable];
  if (!fromEnv) {
    throw new EtlError(`La variabile d'ambiente ${variable} non e' impostata`, {
      code: ErrorCodes.INVALID_USAGE,
      context: { db: name, variable },
    });
  }
  return [name, fromEnv];
}

/**
 * Sovrascrive il riferimento alla sorgente. E' una riscrittura del DATO, non un
 * ramo nel motore: la Definition resta un JSON (I1).
 */
function withInput(definition: Definition, input: string): Definition {
  const config = (definition.source.config ?? {}) as Record<string, unknown>;
  return {
    ...definition,
    source: { ...definition.source, config: { ...config, input } },
  };
}

/**
 * La CLI legge dal filesystem, quindi risolve i `ref` come path. Un host che
 * tiene i file su object storage passa la propria risoluzione e i plugin non
 * cambiano (I6).
 */
const openInput = createFileInput();

/** Un engine con la libreria standard gia' collegata. */
function engineConPluginInclusi(): Engine {
  return createEngine().useAll(builtinPlugins);
}

function describePlugins(): Manifest[] {
  return engineConPluginInclusi().registry.list();
}

/** Rende un rilievo di validazione in una riga leggibile da un operatore. */
function formatIssue(issue: { severity: string; path: string; message: string }): string {
  const mark = issue.severity === "error" ? "errore" : "avviso";
  return `  ${mark}  ${issue.path}: ${issue.message}`;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  if (command === "plugins") {
    process.stdout.write(`${JSON.stringify(describePlugins(), null, 2)}\n`);
    return 0;
  }

  if (command === "describe") {
    const name = rest[0];
    if (!name) {
      process.stderr.write(`Manca il nome del plugin\n\n${USAGE}`);
      return 1;
    }
    const schema = describePlugin(name, { registry: engineConPluginInclusi().registry });
    process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
    return 0;
  }

  if (command === "validate") {
    const path = rest[0];
    if (!path) {
      process.stderr.write(`Manca il percorso della Definition\n\n${USAGE}`);
      return 1;
    }
    const definition = await loadDefinition(path);
    const result = validate(definition, { registry: engineConPluginInclusi().registry });
    if (result.issues.length === 0) {
      process.stdout.write(`${path}: nessun rilievo\n`);
      return 0;
    }
    const lines = result.issues.map(formatIssue).join("\n");
    const stream = result.valid ? process.stdout : process.stderr;
    stream.write(`${path}: ${result.issues.length} rilievi\n${lines}\n`);
    return result.valid ? 0 : 1;
  }

  if (command === "preview") {
    return previewCommand(rest);
  }

  if (command !== "run") {
    process.stderr.write(`Comando sconosciuto: ${command}\n\n${USAGE}`);
    return 1;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      input: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string" },
      db: { type: "string", multiple: true, default: [] },
      log: { type: "string", default: "info" },
      rejects: { type: "string" },
    },
  });

  const definitionPath = positionals[0];
  if (!definitionPath) {
    process.stderr.write(`Manca il percorso della Definition\n\n${USAGE}`);
    return 1;
  }

  let definition = await loadDefinition(definitionPath);
  if (values.input) definition = withInput(definition, values.input);

  const dryRun = values["dry-run"] === true;
  const log = jsonLogger((values.log as "info") ?? "info", { client: definition.client });

  const databases = Object.fromEntries(
    (values.db ?? []).map((entry) => {
      const [name, connectionString] = parseDbOption(entry);
      return [name, { connectionString }];
    }),
  );

  let provider: DbProvider | undefined;
  if (Object.keys(databases).length > 0) {
    provider = await createPostgresProvider(databases);
  }

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const ctx: HostCtx = {
    openInput,
    db: (name) => {
      if (!provider) {
        throw new EtlError(
          `Serve una connessione al database "${name}": passala con --db ${name}=<url>`,
          { code: ErrorCodes.INVALID_USAGE, context: { db: name } },
        );
      }
      return provider.db(name);
    },
    secretRef: (ref) => {
      const value = process.env[ref];
      if (!value) {
        throw new EtlError(`Segreto "${ref}" non presente nell'ambiente`, {
          code: ErrorCodes.INVALID_USAGE,
          context: { ref },
        });
      }
      return value;
    },
    log,
    signal: controller.signal,
    ...(provider ? { dbWrite: (name: string) => provider.dbWrite(name) } : {}),
  };

  const rejectFile = values.rejects ? new RejectFile(values.rejects) : undefined;
  const engine = engineConPluginInclusi();
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new EtlError(`--limit vuole un intero positivo, ricevuto "${values.limit}"`, {
      code: ErrorCodes.INVALID_USAGE,
    });
  }

  try {
    const result: RunResult = await engine.run(definition, ctx, {
      dryRun,
      ...(limit === undefined ? {} : { limitRows: limit }),
      events: {
        onRunStart: (event) =>
          log.info("run avviato", { runId: event.runId, steps: event.steps, dryRun: event.dryRun }),
        onRecordFailed: (event) => {
          rejectFile?.add(event.failed);
          log.warn("riga scartata", {
            step: event.step,
            code: event.failed.code,
            offset: event.failed.offset,
            reason: event.failed.reason,
          });
        },
        onRunEnd: (event) =>
          log.info("run concluso", {
            runId: event.runId,
            read: event.result.read,
            written: event.result.written,
            failed: event.result.failed,
          }),
      },
    });
    const written = await rejectFile?.close();
    process.stdout.write(
      `${JSON.stringify({ ...result, ...(written === undefined ? {} : { rejectFile: values.rejects, rejectRows: written }) }, null, 2)}\n`,
    );
    return result.aborted ? 2 : 0;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    // Anche un run annullato lascia il suo file di scarto: e' li' che si legge
    // perche' e' stato annullato.
    await rejectFile?.close().catch(() => undefined);
    await provider?.close();
  }
}

/** Anteprima: legge poche righe e mostra cosa ne uscirebbe, senza scrivere. */
async function previewCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      input: { type: "string" },
      n: { type: "string", short: "n", default: "10" },
    },
  });

  const path = positionals[0];
  if (!path) {
    process.stderr.write(`Manca il percorso della Definition\n\n${USAGE}`);
    return 1;
  }

  const rows = Number(values.n);
  if (!Number.isInteger(rows) || rows <= 0) {
    throw new EtlError(`-n vuole un intero positivo, ricevuto "${values.n}"`, {
      code: ErrorCodes.INVALID_USAGE,
    });
  }

  let definition = await loadDefinition(path);
  if (values.input) definition = withInput(definition, values.input);

  const result = await preview(
    definition,
    rows,
    {
      openInput,
      db: (name) => {
        throw new EtlError(
          `L'anteprima richiede il database "${name}": usa "run --dry-run --db ${name}=<url>"`,
          { code: ErrorCodes.INVALID_USAGE, context: { db: name } },
        );
      },
      secretRef: (ref) => process.env[ref] ?? "",
      log: jsonLogger("warn", { client: definition.client }),
      signal: new AbortController().signal,
    },
    { registry: engineConPluginInclusi().registry },
  );

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}
