// SPDX-License-Identifier: MIT
/** apps/core/src/familles/outils.ts — `POST /api/tools/extract-text` : texte d'un fichier envoyé, UTF-8 sinon latin-1, 2 Mo au plus (routes/tools.py). */
import { readFile } from "node:fs/promises";

import { HttpError, longueurPy, messageErreurOs, texteUtf8 } from "@elpis/commun";

import type { Famille } from "../routes";
import { lireFormulaire, valeursFormulaire } from "@elpis/http";

export const MAX_EXTRACTION = 2 * 1024 * 1024;

export const familleOutils: Famille = {
  nom: "outils",
  routes: [
    {
      methode: "POST",
      chemin: "/api/tools/extract-text",
      processus: ["main"],
      acces: "session",
      traiter: async (req) => {
        const { file } = valeursFormulaire(await lireFormulaire(req), {
          file: { type: "fichier", requis: true },
        });
        if (file.taille > MAX_EXTRACTION)
          throw new HttpError(
            413,
            `Fichier trop volumineux (plafond : ${Math.floor(MAX_EXTRACTION / (1024 * 1024))} Mo).`,
          );
        let octets: Buffer;
        try {
          octets = await readFile(file.chemin);
        } catch (e) {
          throw new HttpError(500, `Erreur lecture fichier: ${messageErreurOs(e, file.chemin)}`);
        }
        const texte = texteUtf8(octets) ?? octets.toString("latin1");
        return { ok: true, filename: file.filename, content: texte, size: longueurPy(texte) };
      },
    },
  ],
};
