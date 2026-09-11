import type { Batch, TransformResult } from "./rows.js";
import type { Ctx } from "./ctx.js";

/**
 * Legge la sorgente in streaming: un CSV da 2 GB non si carica in memoria.
 * La config arriva come `unknown` perche' il core non conosce lo schema del
 * plugin; il plugin la valida con il proprio schema (I1).
 */
export interface Reader {
  read(config: unknown, ctx: Ctx): AsyncIterable<Batch>;
}

/**
 * Trasforma un lotto. Puo' LEGGERE dal database via ctx, mai scrivere (I4):
 * un run ripetuto deve dare lo stesso risultato.
 */
export interface Transformer {
  transform(batch: Batch, config: unknown, ctx: Ctx): Promise<TransformResult>;
  /** Per i transformer che accumulano stato (dedup, aggregazioni): emette la coda. */
  flush?(ctx: Ctx): Promise<TransformResult>;
}

/** Sessione di scrittura: `close(false)` significa rollback. */
export interface WriteSession {
  write(batch: Batch): Promise<void>;
  close(commit: boolean): Promise<void>;
}

/** Factory: apre una sessione (tipicamente una transazione) per un singolo run. */
export interface Writer {
  open(config: unknown, ctx: Ctx): Promise<WriteSession>;
}

export type PluginKind = "reader" | "transformer" | "writer";

/**
 * Carta d'identita' di un plugin: e' cio' che il core legge per validare,
 * descrivere e versionare senza sapere nulla dell'implementazione (I2).
 */
export interface Manifest {
  /** Nome logico usato nelle Definition (es. "csv"). */
  name: string;
  version: string;
  kind: PluginKind;
  /** Deve combaciare con PROTOCOL_VERSION, altrimenti il loader rifiuta. */
  protocol: number;
  /** JSON Schema della config: alimenta describe() e una futura GUI. */
  configSchema: unknown;
  capabilities?: string[];
  category?: string;
}

export interface ReaderPlugin {
  manifest: Manifest & { kind: "reader" };
  impl: Reader;
}
export interface TransformerPlugin {
  manifest: Manifest & { kind: "transformer" };
  impl: Transformer;
}
export interface WriterPlugin {
  manifest: Manifest & { kind: "writer" };
  impl: Writer;
}

/** Unione discriminata su `manifest.kind`. */
export type Plugin = ReaderPlugin | TransformerPlugin | WriterPlugin;

/**
 * Forma di un modulo che esporta plugin. Un modulo puo' contenerne **uno** o
 * **piu' d'uno**: un pacchetto e' un'unita' di distribuzione, un plugin
 * un'unita' di configurazione, e non c'e' motivo perche' coincidano
 * (`etljs/transformers` ne porta cinque).
 *
 * Serve a chi scrive un caricatore proprio. Il motore non legge questa forma:
 * i plugin glieli passa chi lo usa, con `use()`.
 *
 * Convenzione dei nomi, seguita da tutti i plugin inclusi: il nome
 * dell'export dice **cosa** fa e **di che tipo** e', cosi' si legge
 * dall'import - `csvReader`, `postgresWriter`, `castTransformer`.
 */
export interface PluginModule {
  plugins?: Plugin[];
  plugin?: Plugin;
  default?: Plugin;
}

/** Il plugin corrispondente a un dato `kind`, per evitare cast nei chiamanti. */
export type PluginOfKind<K extends PluginKind> = Extract<Plugin, { manifest: { kind: K } }>;

/** L'implementazione corrispondente a un dato `kind`. */
export type ImplOfKind<K extends PluginKind> = PluginOfKind<K>["impl"];
