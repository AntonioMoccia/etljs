import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// I test girano sui sorgenti (niente build preventiva): l'alias mappa il nome
// pubblico del pacchetto sul suo src/, come farebbe il symlink di npm workspaces.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@etl-js\/([a-z0-9-]+)$/,
        replacement: fileURLToPath(new URL("./packages/$1/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"],
  },
});
