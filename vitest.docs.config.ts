import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

/**
 * I controlli sulla documentazione girano solo a comando (`npm run check:docs`),
 * non dentro `npm test`. Vedi il commento in cima a tools/documentazione.test.ts.
 *
 * `include` viene **sostituito**, non aggiunto: mergeConfig concatenerebbe gli
 * elenchi e finirebbe per rieseguire tutta la suite.
 */
export default defineConfig({
  ...base,
  test: { ...base.test, include: ["tools/**/*.test.ts"] },
});
