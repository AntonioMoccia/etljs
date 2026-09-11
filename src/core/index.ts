/**
 * etljs - il motore. Sa eseguire una Definition, non sa quali plugin
 * esistano: li riceve gia' pronti (Registry) o li carica per nome (fase 2).
 */
export { run, type RunOptions } from "./pipeline.js";
export { createEngine, type Engine, type EngineRunOptions } from "./engine.js";
export { Registry, defaultRegistry, assertUsableManifest } from "./registry.js";
export {
  validate,
  assertValid,
  describePlugin,
  // La specifica chiama questa funzione `describe`; il nome canonico e'
  // `describePlugin` perche' `describe` collide con la globale di vitest nei test.
  describePlugin as describe,
  listPlugins,
  ValidationCodes,
  type ValidateOptions,
  type ValidationIssue,
  type ValidationResult,
} from "./validate.js";
export { preview, type PreviewResult } from "./preview.js";
export { withRetry, type RetryOptions } from "./retry.js";
export {
  createFileInput,
  createMemoryInput,
  type InputResolver,
  type FileInputOptions,
} from "./input.js";
export {
  readOnlyCtx,
  writerCtx,
  nullLogger,
  type HostCtx,
} from "./context.js";
export type {
  RunEvents,
  RunStartEvent,
  BatchEvent,
  RecordFailedEvent,
  RunEndEvent,
} from "./events.js";
export {
  createPostgresProvider,
  type DbProvider,
  type PostgresDbConfig,
} from "./db/postgres.js";
export { encodeCopyRow, encodeCopyValue } from "./db/copy-text.js";
