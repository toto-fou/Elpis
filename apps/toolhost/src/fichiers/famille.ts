// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/famille.ts — famille des routes de fichiers, Git et Office du bac (`/api/sandbox/*`), sous jeton de service et enveloppe ; corps bornés comme le Python les refuse. */
import { cheminDecode, installerCorpsBorne } from "@elpis/http";

import type { Famille } from "../app";
import { routesGit } from "../git/routes";
import { routesOffice } from "../office/routes";
import type { ContexteFichiers } from "./commun";
import { SAVE_MAX_BYTES, UPLOAD_CHUNK_HARD_CAP } from "./ecriture";
import { routesFichiers } from "./routes";

export function creerFamilleFichiers(ctx: ContexteFichiers): Famille {
  return {
    nom: "fichiers",
    routes: [...routesFichiers(ctx), ...routesGit(ctx), ...routesOffice(ctx)],
    contexte: (app) =>
      installerCorpsBorne(app, (q) => {
        const chemin = cheminDecode(q);
        if (q.method === "POST" && chemin === "/api/sandbox/save")
          return {
            limite: SAVE_MAX_BYTES * 2,
            message: `Contenu trop volumineux pour l'éditeur (${SAVE_MAX_BYTES / (1024 * 1024)} Mo max)`,
          };
        if (q.method === "POST" && chemin === "/api/sandbox/upload-chunk")
          return { limite: UPLOAD_CHUNK_HARD_CAP, message: "Chunk trop volumineux" };
        return null;
      }),
  };
}
