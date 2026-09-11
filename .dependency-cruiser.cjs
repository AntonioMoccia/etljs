/**
 * Confini architetturali imposti dallo strumento, non dalla disciplina (I2, I9).
 *
 * Con il pacchetto unico i confini sono fra **cartelle di src/** invece che fra
 * workspace npm, ma le regole sono le stesse:
 *
 *   contracts  <-- core
 *   contracts  <-- csv, postgres, transforms, lookup   (mai fra loro, mai core)
 *   contracts  <-- cli --> core --> (niente plugin)
 */
const PLUGIN_DIRS = "csv-reader|postgres-writer|transformers|lookup-transformer";

module.exports = {
  forbidden: [
    {
      name: "contracts-e-una-foglia",
      comment: "I9: i contratti non dipendono da nessun'altra cartella.",
      severity: "error",
      from: { path: "^src/contracts/" },
      to: { path: "^src/(?!contracts/)" },
    },
    {
      name: "contracts-senza-dipendenze-npm",
      comment: "I9: i contratti devono restare a zero dipendenze runtime.",
      severity: "error",
      from: { path: "^src/contracts/" },
      to: {
        dependencyTypes: [
          "npm",
          "npm-dev",
          "npm-optional",
          "npm-peer",
          "npm-bundled",
          "npm-no-pkg",
          "npm-unknown",
        ],
      },
    },
    {
      name: "plugin-dipende-solo-da-contracts",
      comment:
        "I9: un plugin puo' importare solo se stesso e i contratti. Mai il core, mai un altro plugin.",
      severity: "error",
      from: { path: `^src/(${PLUGIN_DIRS})/` },
      to: { path: "^src/", pathNot: ["^src/contracts/", "^src/$1/"] },
    },
    {
      name: "core-non-conosce-i-plugin",
      comment: "I2/I9: il core non nomina mai un plugin concreto e non dipende dalla cli.",
      severity: "error",
      from: { path: "^src/core/" },
      to: { path: `^src/(${PLUGIN_DIRS}|cli)/` },
    },
    {
      name: "testing-dipende-solo-da-contracts",
      comment: "I9: l'harness serve a provare i plugin, non puo' tirarsi dietro il core.",
      severity: "error",
      from: { path: "^packages/testing/src/" },
      to: { path: "^src/", pathNot: "^src/contracts/" },
    },
    { name: "niente-cicli", severity: "error", from: {}, to: { circular: true } },
    {
      name: "niente-import-di-dist",
      comment: "Si importa il sorgente, mai il compilato.",
      severity: "error",
      from: {},
      to: { path: "^dist/" },
    },
    {
      name: "niente-orfani",
      severity: "warn",
      from: {
        orphan: true,
        path: "^(src|packages)/",
        pathNot: ["\\.d\\.ts$", "(^|/)tsconfig.*\\.json$"],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.tests.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    // Solo dist: i moduli npm devono restare nel grafo, altrimenti la regola
    // "contracts a zero dipendenze" non potrebbe scattare.
    exclude: { path: "(^|/)dist/" },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
