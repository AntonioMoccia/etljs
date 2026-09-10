#!/usr/bin/env node
import { IngestError } from "@etl-js/contracts";
import { main } from "./cli.js";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Un errore del motore e' gia' classificato: lo si stampa come dato,
    // cosi' chi invoca la CLI da un altro programma puo' leggerlo.
    if (IngestError.is(error)) {
      process.stderr.write(`${JSON.stringify(error.toJSON(), null, 2)}\n`);
    } else {
      process.stderr.write(`${String(error)}\n`);
    }
    process.exitCode = 1;
  });
