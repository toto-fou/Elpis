// SPDX-License-Identifier: MIT
/** packages/contracts/scripts/generer.ts — écrit les schémas JSON des contrats dans dist/schemas (les .d.ts viennent de tsc). */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { schemasJson } from "../src/schemas";

const sortie = new URL("../dist/schemas/", import.meta.url);
rmSync(sortie, { recursive: true, force: true });
mkdirSync(sortie, { recursive: true });
for (const [nom, schema] of Object.entries(schemasJson())) {
  writeFileSync(new URL(`${nom}.schema.json`, sortie), JSON.stringify(schema, null, 2) + "\n");
}
process.stdout.write(
  `${Object.keys(schemasJson()).length} schémas JSON dans packages/contracts/dist/schemas\n`,
);
