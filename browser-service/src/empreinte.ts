// SPDX-License-Identifier: MIT
/** browser-service/src/empreinte.ts — `node browser-service/dist/empreinte.mjs` : le bundle voisin vient-il des sources du dépôt (`ELPIS_RACINE`, sinon deux niveaux au-dessus) ? Pour l'installeur et le diagnostic, sans charger le service. */
import path from "node:path";

import { verifierEmpreinteBundle } from "@elpis/commun/empreinte";

const dossier = import.meta.dirname;
process.exitCode = verifierEmpreinteBundle(dossier, path.resolve(dossier, "..", ".."), (ligne) => {
  process.stdout.write(`${ligne}\n`);
});
