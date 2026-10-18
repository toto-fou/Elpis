// SPDX-License-Identifier: MIT
/** apps/core/src/familles/apparence.ts — skins activés, feuille et images d'un skin importé, servis à main et à l'admin (shared_infra/appearance/routes.py). */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { ligneUtilisateur } from "@elpis/auth";
import { encoderUtf8Py, HttpError } from "@elpis/commun";
import type { Executeur } from "@elpis/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import {
  assetPath,
  assetType,
  defaultSkin,
  detectImage,
  ID_RE,
  IMAGE_MIME,
  isEnabled,
  listSkins,
  mascotsCatalogue,
  renderCss,
} from "../apparence/skins";
import { estErreurOs } from "../skills/chemins";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { utilisateur } from "./comptes";
import { reponseJsonPy } from "@elpis/http";

export interface DependancesApparence {
  readonly base: Executeur;
}

function route(chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode: "GET", chemin, processus: ["main", "admin"], acces: "session", traiter };
}

/** ETag : 20 premiers chiffres hexadécimaux du SHA-1 du contenu. */
function etag(octets: Buffer): string {
  return `"${createHash("sha1").update(octets).digest("hex").slice(0, 20)}"`;
}

/** Corps, ou 304 si le client a déjà cette version (`If-None-Match` comparé tel quel). */
function servir(
  req: FastifyRequest,
  rep: FastifyReply,
  octets: Buffer,
  type: string,
  entetes: Record<string, string>,
): FastifyReply {
  if (req.headers["if-none-match"] === entetes["etag"]) return rep.code(304).headers(entetes).send();
  return rep.type(type).headers(entetes).send(octets);
}

export function creerFamilleApparence(dep: DependancesApparence): Famille {
  const estAdmin = async (uid: number): Promise<boolean> => {
    const moi = await ligneUtilisateur(dep.base, uid);
    return moi !== undefined && Number(moi.is_admin) === 1;
  };
  /** `_may_read` : skin activé, ou aperçu réservé à un administrateur. */
  const peutLire = async (req: FastifyRequest, skinId: string): Promise<void> => {
    const uid = utilisateur(req);
    if (isEnabled(skinId)) return;
    if (!(await estAdmin(uid))) throw new HttpError(404, "Skin inconnu");
  };
  return {
    nom: "apparence",
    routes: [
      route("/api/skins", (req, rep) => {
        utilisateur(req);
        return reponseJsonPy(
          rep,
          { skins: listSkins(), default: defaultSkin(), mascottes: mascotsCatalogue() },
          { "cache-control": "no-cache" },
        );
      }),
      route("/api/skins/:skin_id/skin.css", async (req, rep) => {
        const skinId = (req.params as { skin_id: string }).skin_id;
        if (skinId && !ID_RE.test(skinId)) throw new HttpError(404, "Skin inconnu");
        await peutLire(req, skinId);
        const css = renderCss(skinId);
        if (css === null) throw new HttpError(404, "Skin inconnu");
        const octets = encoderUtf8Py(css);
        return servir(req, rep, octets, "text/css; charset=utf-8", {
          etag: etag(octets),
          "cache-control": "private, max-age=60",
          "x-content-type-options": "nosniff",
        });
      }),
      route("/api/skins/:skin_id/assets/:name", async (req, rep) => {
        const { skin_id: skinId, name } = req.params as { skin_id: string; name: string };
        const chemin = assetPath(skinId, name);
        if (chemin === null) throw new HttpError(404, "Image inconnue");
        await peutLire(req, skinId);
        let octets: Buffer;
        try {
          octets = readFileSync(chemin);
        } catch (e) {
          if (estErreurOs(e)) throw new HttpError(404, "Image inconnue");
          throw e;
        }
        const type = detectImage(octets.subarray(0, 16));
        if (type === null || type !== assetType(name)) throw new HttpError(404, "Image inconnue");
        return servir(req, rep, octets, IMAGE_MIME[type] ?? "application/octet-stream", {
          etag: etag(octets),
          "cache-control": "private, max-age=300",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'",
        });
      }),
    ],
  };
}
