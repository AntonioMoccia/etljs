import ajvModule from "ajv/dist/2020.js";
import formatsModule from "ajv-formats";
import type { ErrorObject, Options, ValidateFunction } from "ajv";
import type { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import {
  ErrorCodes,
  EtlError,
  type Definition,
  type Manifest,
  type Plugin,
  type PluginKind,
  type StepRef,
} from "../contracts/index.js";
import { defaultRegistry, type Registry } from "./registry.js";

export interface ValidateOptions {
  /** Dove cercare i plugin. Default: il registry di processo. */
  registry?: Registry;
}

export interface ValidationIssue {
  /** Punto esatto nella Definition: "source.config.path", "transform[1].type". */
  path: string;
  message: string;
  /** Codice stabile per chi legge da programma (una GUI, un test). */
  code: string;
  severity: "error" | "warn";
  context?: Record<string, unknown>;
}

export interface ValidationResult {
  /** false se c'e' almeno un rilievo di severita' error. */
  valid: boolean;
  issues: ValidationIssue[];
}

export const ValidationCodes = {
  MISSING: "MISSING",
  PLUGIN_NOT_FOUND: "PLUGIN_NOT_FOUND",
  PLUGIN_KIND_MISMATCH: "PLUGIN_KIND_MISMATCH",
  CONFIG_INVALID: "CONFIG_INVALID",
  /** La versione installata non e' quella con cui la Definition e' stata scritta. */
  VERSION_DRIFT: "VERSION_DRIFT",
} as const;

/**
 * Un'istanza di Ajv per processo, con la cache dei validatori compilati:
 * compilare uno schema costa, e gli schemi cambiano solo quando cambia un plugin.
 */
// ajv e ajv-formats sono CommonJS e assegnano sia `module.exports` sia
// `module.exports.default`: quale dei due arriva dipende da come li carica il
// runtime, quindi si accettano entrambi invece di scommettere.
type Interop<T> = T | { default: T };
const unwrap = <T,>(mod: Interop<T>): T =>
  (mod as { default?: T }).default ?? (mod as T);

const AjvCtor = unwrap(ajvModule as Interop<new (options?: Options) => Ajv2020>);
const addFormats = unwrap(formatsModule as Interop<FormatsPlugin>);

const ajv = addFormats(new AjvCtor({ allErrors: true, strict: false, allowUnionTypes: true }));
const compiled = new WeakMap<object, ValidateFunction>();

function validatorFor(manifest: Manifest): ValidateFunction | undefined {
  const schema = manifest.configSchema;
  if (typeof schema !== "object" || schema === null) return undefined;
  const cached = compiled.get(schema);
  if (cached) return cached;
  try {
    const validator = ajv.compile(schema as object);
    compiled.set(schema, validator);
    return validator;
  } catch (error) {
    throw new EtlError(
      `Il plugin "${manifest.name}" espone un configSchema che non e' un JSON Schema valido`,
      {
        code: ErrorCodes.INVALID_USAGE,
        context: { plugin: manifest.name },
        cause: error,
      },
    );
  }
}

/** Traduce l'errore di Ajv in un percorso dentro la Definition e in un messaggio in italiano. */
function issueFromAjv(base: string, error: ErrorObject): ValidationIssue {
  const pointer = error.instancePath.replace(/^\//, "").split("/").filter(Boolean).join(".");
  let path = pointer ? `${base}.${pointer}` : base;
  let message: string;

  switch (error.keyword) {
    case "required": {
      const missing = String((error.params as { missingProperty?: string }).missingProperty);
      path = pointer ? `${base}.${pointer}.${missing}` : `${base}.${missing}`;
      message = `campo obbligatorio mancante: ${missing}`;
      break;
    }
    case "additionalProperties": {
      const extra = String((error.params as { additionalProperty?: string }).additionalProperty);
      message = `chiave non prevista: ${extra}`;
      break;
    }
    case "type":
      message = `tipo errato: atteso ${String((error.params as { type?: string }).type)}`;
      break;
    case "enum": {
      const allowed = (error.params as { allowedValues?: unknown[] }).allowedValues ?? [];
      message = `valore non ammesso; validi: ${allowed.join(", ")}`;
      break;
    }
    default:
      message = error.message ?? "valore non valido";
  }

  return {
    path,
    message,
    code: ValidationCodes.CONFIG_INVALID,
    severity: "error",
    context: { keyword: error.keyword, ...error.params },
  };
}

/** Risolve uno stadio e ne valida la config, accumulando i rilievi invece di fermarsi al primo. */
function checkStep(
  step: StepRef | undefined,
  base: string,
  kind: PluginKind,
  registry: Registry,
  issues: ValidationIssue[],
): Plugin | undefined {
  if (!step || typeof step !== "object") {
    issues.push({
      path: base,
      message: `manca lo stadio ${base}`,
      code: ValidationCodes.MISSING,
      severity: "error",
    });
    return undefined;
  }
  if (typeof step.type !== "string" || step.type.length === 0) {
    issues.push({
      path: `${base}.type`,
      message: "il tipo del plugin e' obbligatorio",
      code: ValidationCodes.MISSING,
      severity: "error",
    });
    return undefined;
  }

  const plugin = registry.get(step.type);
  if (!plugin) {
    issues.push({
      path: `${base}.type`,
      message: `plugin "${step.type}" non disponibile`,
      code: ValidationCodes.PLUGIN_NOT_FOUND,
      severity: "error",
      context: { requested: step.type, available: registry.list().map((m) => m.name) },
    });
    return undefined;
  }
  if (plugin.manifest.kind !== kind) {
    issues.push({
      path: `${base}.type`,
      message: `"${step.type}" e' un ${plugin.manifest.kind}, qui serve un ${kind}`,
      code: ValidationCodes.PLUGIN_KIND_MISMATCH,
      severity: "error",
      context: { expected: kind, actual: plugin.manifest.kind },
    });
    return plugin;
  }

  const validator = validatorFor(plugin.manifest);
  if (validator && !validator(step.config ?? {})) {
    for (const error of validator.errors ?? []) {
      issues.push(issueFromAjv(`${base}.config`, error));
    }
  }
  return plugin;
}

/**
 * Controlla una Definition prima che il run parta: plugin esistenti, del tipo
 * giusto, con config conforme al loro schema. Non esegue nulla e non tocca il
 * database, quindi una GUI puo' chiamarla a ogni tasto premuto.
 */
export function validate(
  definition: Definition,
  options: ValidateOptions = {},
): ValidationResult {
  const registry = options.registry ?? defaultRegistry;
  const issues: ValidationIssue[] = [];

  if (typeof definition?.client !== "string" || definition.client.length === 0) {
    issues.push({
      path: "client",
      message: "il nome del flusso e' obbligatorio",
      code: ValidationCodes.MISSING,
      severity: "error",
    });
  }

  checkStep(definition?.source, "source", "reader", registry, issues);

  const transform = definition?.transform ?? [];
  if (!Array.isArray(transform)) {
    issues.push({
      path: "transform",
      message: "transform deve essere un elenco di stadi",
      code: ValidationCodes.CONFIG_INVALID,
      severity: "error",
    });
  } else {
    transform.forEach((step, index) => {
      checkStep(step, `transform[${index}]`, "transformer", registry, issues);
    });
  }

  checkStep(definition?.destination, "destination", "writer", registry, issues);

  const ratio = definition?.policy?.maxFailedRatio;
  if (ratio !== undefined && (typeof ratio !== "number" || !(ratio >= 0 && ratio <= 1))) {
    issues.push({
      path: "policy.maxFailedRatio",
      message: "deve essere un numero fra 0 e 1",
      code: ValidationCodes.CONFIG_INVALID,
      severity: "error",
      context: { value: ratio },
    });
  }

  // Lo scostamento di versione non impedisce il run: dice che il risultato
  // potrebbe non essere identico a quello di quando la Definition fu scritta.
  for (const [name, version] of Object.entries(definition?.manifestSnapshot ?? {})) {
    const plugin = registry.get(name);
    if (!plugin || plugin.manifest.version === version) continue;
    issues.push({
      path: `manifestSnapshot.${name}`,
      message: `la Definition fu scritta con ${name}@${version}, qui e' installato ${plugin.manifest.version}`,
      code: ValidationCodes.VERSION_DRIFT,
      severity: "warn",
      context: { plugin: name, expected: version, installed: plugin.manifest.version },
    });
  }

  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}

/** Come validate(), ma fallisce invece di riportare: utile prima di un run. */
export function assertValid(definition: Definition, options: ValidateOptions = {}): void {
  const result = validate(definition, options);
  if (result.valid) return;
  const errors = result.issues.filter((issue) => issue.severity === "error");
  const summary = errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  throw new EtlError(`Definition non valida - ${summary}`, {
    code: ErrorCodes.CONFIG_INVALID,
    context: { client: definition?.client, issues: errors },
  });
}

/**
 * JSON Schema della config di un plugin. E' cio' che permettera' a una GUI di
 * disegnare il modulo di configurazione senza sapere nulla del plugin.
 */
export function describePlugin(name: string, options: ValidateOptions = {}): unknown {
  const registry = options.registry ?? defaultRegistry;
  return registry.require(name).manifest.configSchema;
}

/** Manifest di tutti i plugin disponibili, in ordine di nome. */
export function listPlugins(options: ValidateOptions = {}): Manifest[] {
  return (options.registry ?? defaultRegistry).list();
}
