// SPDX-License-Identifier: MIT
/** apps/core/src/familles/apparence.ts — skins activés, feuille et images d'un skin importé, servis à main et à l'admin (shared_infra/appearance/routes.py). */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { ligneUtilisateur } from "@elpis/auth";
import { encoderUtf8Py, HttpError } from "@elpis/commun";
import { PREFIXE_PERSO } from "@elpis/contracts";
import { corpsJson } from "@elpis/http";
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
  SkinExistsError,
} from "../apparence/skins";
import {
  enregistrerPerso,
  feuillePerso,
  listerPerso,
  persoActif,
  persoMax,
  supprimerPerso,
} from "../apparence/comptes-perso";
import type { SkinPerso } from "../apparence/comptes-perso";
import { evaluerSkinPerso } from "../apparence/perso";
import { estErreurOs } from "../skills/chemins";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { utilisateur } from "./comptes";
import { reponseJsonPy } from "@elpis/http";

export interface DependancesApparence {
  readonly base: Executeur;
}

function route(
  chemin: string,
  traiter: Traitement,
  methode: DefinitionRoute["methode"] = "GET",
): DefinitionRoute {
  return { methode, chemin, processus: ["main", "admin"], acces: "session", traiter };
}

const ENTETES_CSS = { "cache-control": "private, max-age=60", "x-content-type-options": "nosniff" };

/** Feuille servie avec son ETag, les mêmes en-têtes pour un skin importé et pour un habillage personnel. */
function servirCss(req: FastifyRequest, rep: FastifyReply, css: string): FastifyReply {
  const octets = encoderUtf8Py(css);
  return servir(req, rep, octets, "text/css; charset=utf-8", { etag: etag(octets), ...ENTETES_CSS });
}

/** Refus 403 quand l'administrateur a coupé les habillages personnels. */
function exigerPerso(): void {
  if (!persoActif()) throw new HttpError(403, "Les habillages personnels sont désactivés.");
}

/** Habillage du compte tel que l'interface le liste : même forme qu'un skin de `/api/skins`, plus `perso`. */
function entreePerso(p: SkinPerso): Record<string, unknown> {
  const { rev, ...reste } = p;
  return { ...reste, builtin: false, perso: true, css_url: `/api/skins/perso/${p.id}/skin.css?v=${rev}` };
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

/** Corps d'écriture : le manifeste, plus `overwrite` (booléen) qui n'en fait pas partie. */
function separer(corps: unknown): { habillage: unknown; ecraser: boolean } {
  if (corps === null || typeof corps !== "object" || Array.isArray(corps))
    return { habillage: corps, ecraser: false };
  const { overwrite, ...habillage } = corps as Record<string, unknown>;
  if (overwrite !== undefined && typeof overwrite !== "boolean")
    throw new HttpError(400, "overwrite : booléen attendu.");
  return { habillage, ecraser: overwrite === true };
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
        const uid = utilisateur(req);
        return reponseJsonPy(
          rep,
          {
            skins: [
              ...listSkins(),
              ...(persoActif()
                ? listerPerso(uid).map((p) => ({ ...entreePerso(p), id: `${PREFIXE_PERSO}${p.id}` }))
                : []),
            ],
            default: defaultSkin(),
            mascottes: mascotsCatalogue(),
          },
          { "cache-control": "no-cache" },
        );
      }),
      route("/api/skins/:skin_id/skin.css", async (req, rep) => {
        const skinId = (req.params as { skin_id: string }).skin_id;
        if (skinId && !ID_RE.test(skinId)) throw new HttpError(404, "Skin inconnu");
        await peutLire(req, skinId);
        const css = renderCss(skinId);
        if (css === null) throw new HttpError(404, "Skin inconnu");
        return servirCss(req, rep, css);
      }),
      route("/api/skins/perso", (req, rep) => {
        const uid = utilisateur(req);
        exigerPerso();
        return reponseJsonPy(
          rep,
          { skins: listerPerso(uid).map(entreePerso), max: persoMax() },
          { "cache-control": "no-cache" },
        );
      }),
      route(
        "/api/skins/perso/verifier",
        (req, rep) => {
          utilisateur(req);
          exigerPerso();
          const { habillage } = separer(corpsJson(req));
          return reponseJsonPy(rep, evaluerSkinPerso(habillage).rapport);
        },
        "POST",
      ),
      route(
        "/api/skins/perso",
        async (req, rep) => {
          const uid = utilisateur(req);
          exigerPerso();
          const { habillage, ecraser } = separer(corpsJson(req));
          const { rapport, manifeste } = evaluerSkinPerso(habillage);
          if (manifeste === null) throw new HttpError(400, rapport);
          const id = String(manifeste["id"]);
          let remplace: boolean | null;
          try {
            remplace = await enregistrerPerso(uid, manifeste, ecraser);
          } catch (e) {
            if (e instanceof SkinExistsError) throw new HttpError(409, e.message);
            throw e;
          }
          if (remplace === null)
            throw new HttpError(409, `Plafond atteint : ${persoMax()} habillages par compte.`);
          const cree = listerPerso(uid).find((p) => p.id === id);
          if (cree === undefined) throw new HttpError(500, "Habillage illisible après écriture.");
          return reponseJsonPy(rep, { ok: true, remplace, skin: entreePerso(cree), rapport });
        },
        "POST",
      ),
      route(
        "/api/skins/perso/:skin_id",
        async (req, rep) => {
          const uid = utilisateur(req);
          exigerPerso();
          if (!(await supprimerPerso(uid, (req.params as { skin_id: string }).skin_id)))
            throw new HttpError(404, "Habillage inconnu");
          return reponseJsonPy(rep, { ok: true });
        },
        "DELETE",
      ),
      route("/api/skins/perso/:skin_id/skin.css", (req, rep) => {
        const uid = utilisateur(req);
        exigerPerso();
        const f = feuillePerso(uid, (req.params as { skin_id: string }).skin_id);
        if (f === null) throw new HttpError(404, "Habillage inconnu");
        return servirCss(req, rep, f.css);
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
