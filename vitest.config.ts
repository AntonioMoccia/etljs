import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// I test girano sui sorgenti e passano dagli **entry point pubblici**: se un
// subpath di `exports` sparisce o cambia forma, i test se ne accorgono.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^etljs$/, replacement: src("./src/core/index.ts") },
      { find: /^etljs\/contracts$/, replacement: src("./src/contracts/index.ts") },
      { find: /^etljs\/csv-reader$/, replacement: src("./src/csv-reader/index.ts") },
      { find: /^etljs\/postgres-writer$/, replacement: src("./src/postgres-writer/index.ts") },
      { find: /^etljs\/transformers$/, replacement: src("./src/transformers/index.ts") },
      { find: /^etljs\/lookup-transformer$/, replacement: src("./src/lookup-transformer/index.ts") },
      { find: /^etljs\/cli$/, replacement: src("./src/cli/index.ts") },
      { find: /^@etljs\/testing$/, replacement: src("./packages/testing/src/index.ts") },
    ],
  },
  test: { environment: "node", include: ["test/**/*.test.ts", "packages/testing/test/**/*.test.ts"] },
});
