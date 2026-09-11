import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// I test girano sui sorgenti e passano dagli **entry point pubblici**: se un
// subpath di `exports` sparisce o cambia forma, i test se ne accorgono.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^etl-js$/, replacement: src("./src/core/index.ts") },
      { find: /^etl-js\/contracts$/, replacement: src("./src/contracts/index.ts") },
      { find: /^etl-js\/csv$/, replacement: src("./src/csv/index.ts") },
      { find: /^etl-js\/postgres$/, replacement: src("./src/postgres/index.ts") },
      { find: /^etl-js\/transforms$/, replacement: src("./src/transforms/index.ts") },
      { find: /^etl-js\/lookup$/, replacement: src("./src/lookup/index.ts") },
      { find: /^etl-js\/cli$/, replacement: src("./src/cli/index.ts") },
      { find: /^@etl-js\/testing$/, replacement: src("./packages/testing/src/index.ts") },
    ],
  },
  test: { environment: "node", include: ["test/**/*.test.ts", "packages/testing/test/**/*.test.ts"] },
});
