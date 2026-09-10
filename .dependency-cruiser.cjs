/**
 * Confini architetturali imposti dallo strumento, non dalla disciplina (I2, I9).
 *
 *   contracts  <-- core
 *   contracts  <-- plugin-*        (i plugin NON vedono core ne' altri plugin)
 *   contracts  <-- cli --> core --> (niente plugin)
 */
module.exports = {
  forbidden: [
    {
      name: "contracts-e-una-foglia",
      comment:
        "I9: @etl-js/contracts non dipende da nulla, ne' da altri workspace ne' da npm.",
      severity: "error",
      from: { path: "^packages/contracts/src/" },
      to: { path: "^packages/(?!contracts/)" },
    },
    {
      name: "contracts-senza-dipendenze-npm",
      comment: "I9: contracts deve restare a zero dipendenze runtime.",
      severity: "error",
      from: { path: "^packages/contracts/src/" },
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
        "I9: un plugin puo' importare solo se stesso e @etl-js/contracts. Mai core, mai un altro plugin.",
      severity: "error",
      from: { path: "^packages/(plugin-[^/]+)/src/" },
      to: {
        path: "^packages/",
        pathNot: ["^packages/contracts/src/", "^packages/$1/src/"],
      },
    },
    {
      name: "testing-dipende-solo-da-contracts",
      comment:
        "I9: l'harness serve a provare i plugin, quindi non puo' tirarsi dietro il core.",
      severity: "error",
      from: { path: "^packages/testing/src/" },
      to: { path: "^packages/", pathNot: ["^packages/contracts/src/", "^packages/testing/src/"] },
    },
    {
      name: "core-non-conosce-i-plugin",
      comment:
        "I2/I9: il core non nomina mai un plugin concreto e non dipende dalla cli.",
      severity: "error",
      from: { path: "^packages/core/src/" },
      to: { path: "^packages/(plugin-[^/]+|cli|testing)/" },
    },
    {
      name: "niente-cicli",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "niente-import-di-dist",
      comment: "Si importa il pacchetto per nome, mai il suo dist/ o il suo src/ per path.",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^packages/[^/]+/(dist)/" },
    },
    {
      name: "niente-orfani",
      severity: "warn",
      from: {
        orphan: true,
        path: "^packages/",
        pathNot: ["\\.d\\.ts$", "(^|/)tsconfig.*\\.json$"],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.tests.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"] },
    // Niente includeOnly: i moduli npm devono restare nel grafo, altrimenti
    // la regola "contracts a zero dipendenze" non potrebbe scattare.
    exclude: { path: "(^|/)dist/" },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
