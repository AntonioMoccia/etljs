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
      { find: /^etl-js\/csv-reader$/, replacement: src("./src/csv-reader/index.ts") },
      { find: /^etl-js\/postgres-writer$/, replacement: src("./src/postgres-writer/index.ts") },
      { find: /^etl-js\/transformers$/, replacement: src("./src/transformers/index.ts") },
      { find: /^etl-js\/lookup-transformer$/, replacement: src("./src/lookup-transformer/index.ts") },
      { find: /^etl-js\/cli$/, replacement: src("./src/cli/index.ts") },
      { find: /^@etl-js\/testing$/, replacement: src("./packages/testing/src/index.ts") },
    ],
  },
  test: { environment: "node", include: ["test/**/*.test.ts", "packages/testing/test/**/*.test.ts"] },
});
