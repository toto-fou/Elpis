// SPDX-License-Identifier: MIT
/** apps/core/src/relais/apercu.ts — jeton d'URL de l'aperçu « Web » (`/api/sandbox/pv|pvs/<jeton>/…`), port de preview_token.py. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { ErreurPython, intPy } from "@elpis/commun";
import { config } from "@elpis/config";

import { utilisateur } from "../familles/comptes";
import type { Famille } from "../routes";
import { CHEMIN_JETON_APERCU, estAscii, PREVIEW_PREFIXES } from "./chemins";
import { routeIntrouvable } from "@elpis/http";

export const TTL_S = 3600;

/** `_no_cache` des routes du bac à sable. */
const SANS_CACHE = {
  "cache-control": "no-cache, no-store, must-revalidate",
  pragma: "no-cache",
  expires: "0",
};

export interface OptionsJeton {
  secret?: string;
  maintenant?: number;
}

function cle(secret: string): Buffer {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from("elpis-preview-token\0", "utf8"), Buffer.from(secret, "utf8")]))
    .digest();
}

function signature(corps: string, secret: string): string {
  return createHmac("sha256", cle(secret)).update(corps, "utf8").digest("hex").slice(0, 32);
}

/** `hmac.compare_digest` sur deux textes : TypeError si l'un n'est pas ASCII, longueurs différentes → faux. */
function compareTextes(a: string, b: string): boolean {
  if (!estAscii(a) || !estAscii(b)) {
    throw new ErreurPython("TypeError", "comparing strings with non-ASCII characters is not supported");
  }
  const x = Buffer.from(a, "latin1");
  const y = Buffer.from(b, "latin1");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `(jeton, expiration epoch)`, signé avec la clé dérivée du secret de session. */
export function makePreviewToken(userId: number, ttl = TTL_S, options: OptionsJeton = {}): [string, number] {
  const exp = Math.floor(options.maintenant ?? Date.now() / 1000) + intPy(ttl);
  const corps = `${intPy(userId)}-${exp}`;
  return [`${corps}-${signature(corps, options.secret ?? config.SESSION_SECRET)}`, exp];
}

/** Identifiant du jeton, ou `null` (forme, signature, expiré) ; une signature non ASCII lève comme en Python. */
export function checkPreviewToken(jeton: string, options: OptionsJeton = {}): number | null {
  const parties = jeton.split("-");
  if (parties.length !== 3) return null;
  const [uidTexte = "", expTexte = "", sig = ""] = parties;
  let uid: number;
  let exp: number;
  try {
    uid = intPy(uidTexte);
    exp = intPy(expTexte);
  } catch (e) {
    if (e instanceof ErreurPython && (e.type === "ValueError" || e.type === "TypeError")) return null;
    throw e;
  }
  const secret = options.secret ?? config.SESSION_SECRET;
  if (!compareTextes(sig, signature(`${uid}-${exp}`, secret))) return null;
  if (exp < (options.maintenant ?? Date.now() / 1000)) return null;
  return uid;
}

/** Propriétaire d'un chemin d'aperçu (décodé) d'après le jeton de son premier segment. */
export function previewPathUid(chemin: string, options: OptionsJeton = {}): number | null {
  for (const p of PREVIEW_PREFIXES) {
    if (chemin.startsWith(p)) return checkPreviewToken(chemin.slice(p.length).split("/")[0] ?? "", options);
  }
  return null;
}

/** `GET /api/sandbox/preview-token` servi par main (jamais relayé) ; autre méthode : 405 de Starlette décidé avant le corps, jamais relayée. */
export const familleJetonApercu: Famille = {
  nom: "jeton-apercu",
  routes: [
    {
      methode: "GET",
      chemin: CHEMIN_JETON_APERCU,
      processus: ["main"],
      acces: "session",
      traiter: (requete, reponse) => {
        const [token, expires] = makePreviewToken(utilisateur(requete));
        void reponse.headers(SANS_CACHE);
        return { token, expires };
      },
    },
    {
      methode: ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      chemin: CHEMIN_JETON_APERCU,
      processus: ["main"],
      acces: "public",
      motifsStarlette: [],
      traiter: routeIntrouvable,
    },
  ],
};
