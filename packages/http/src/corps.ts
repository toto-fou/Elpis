// SPDX-License-Identifier: MIT
/** packages/http/src/corps.ts — corps gardé en octets, décodé comme `json.loads` de Python et lu comme FastAPI 0.136. */
import { ErreurJsonPy, pyJsonLoads, pyJsonLoadsOctets, texteJsonPy } from "@elpis/commun";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { HttpError } from "./erreurs";
import { erreurValidation } from "./pydantic";

export { decoderJsonPy, ErreurJsonPy, ErreurLecturePy, pyJsonLoadsOctets, texteJsonPy } from "@elpis/commun";

declare module "fastify" {
  interface FastifyRequest {
    readonly corpsBrut: Buffer;
  }
}

type Decodage = { ok: true; valeur: unknown } | { ok: false; erreur: Error };

const VIDE = Buffer.alloc(0);
const octets = new WeakMap<FastifyRequest, Buffer>();
const decodages = new WeakMap<FastifyRequest, Decodage>();
const typesOriginaux = new WeakMap<FastifyRequest, string>();

const JETON = /^[\w!#$%&'*+.^`|~-]+$/;
const SOUS_TYPE = /^[\w!#$%&'*+.^`|~-]+\s*$/;

/** Grammaire de `ContentType` de Fastify 5 : un type qu'il refuse donne 415 avant tout analyseur, « * » compris. */
function typeAccepteParFastify(valeur: string): boolean {
  if (valeur === "" || valeur === "undefined") return false;
  const pointVirgule = valeur.indexOf(";");
  const media = (pointVirgule < 0 ? valeur : valeur.slice(0, pointVirgule)).toLowerCase();
  const barre = media.indexOf("/");
  if (barre < 0) return false;
  return JETON.test(media.slice(0, barre).trimStart()) && SOUS_TYPE.test(media.slice(barre + 1).trimEnd());
}

/** Corps en octets (sauf multipart) ; un Content-Type que Fastify refuserait est masqué le temps de la lecture, puis rendu. */
export function installerLecteurCorps(app: FastifyInstance): void {
  app.decorateRequest("corpsBrut", {
    getter(this: FastifyRequest) {
      return octets.get(this) ?? VIDE;
    },
  });
  app.addHook("onRequest", async (requete) => {
    const type = requete.raw.headers["content-type"];
    if (type !== undefined && !typeAccepteParFastify(type)) {
      typesOriginaux.set(requete, type);
      requete.raw.headers["content-type"] = "application/octet-stream";
    }
  });
  app.addHook("preValidation", async (requete) => {
    const type = typesOriginaux.get(requete);
    if (type !== undefined) requete.raw.headers["content-type"] = type;
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (requete, corps, fini) => {
    octets.set(requete, corps as Buffer);
    fini(null, corps);
  });
}

function decoder(requete: FastifyRequest): Decodage {
  const deja = decodages.get(requete);
  if (deja) return deja;
  let resultat: Decodage;
  try {
    resultat = { ok: true, valeur: pyJsonLoadsOctets(requete.corpsBrut) };
  } catch (e) {
    resultat = { ok: false, erreur: e instanceof Error ? e : new Error(String(e)) };
  }
  decodages.set(requete, resultat);
  return resultat;
}

/** `await request.json()` : JSON illisible ⇒ 400 « Corps JSON invalide » (gestionnaire de server/app.py), sinon panne 500. */
export function corpsJson(requete: FastifyRequest): unknown {
  const r = decoder(requete);
  if (r.ok) return r.valeur;
  if (r.erreur instanceof ErreurJsonPy)
    throw new HttpError(400, "Corps JSON invalide : " + r.erreur.message.slice(0, 200));
  throw r.erreur;
}

/** `await request.json()` gardé en valeurs Python (flottants entiers, grands entiers, ordre des clés), erreurs de `corpsJson`. */
export function corpsJsonValeurs(requete: FastifyRequest): unknown {
  corpsJson(requete);
  return pyJsonLoads(texteJsonPy(requete.corpsBrut));
}

const ESPACE_PY = (c: number): boolean =>
  (c >= 0x09 && c <= 0x0d) ||
  (c >= 0x1c && c <= 0x20) ||
  c === 0x85 ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000;

function rognerPy(s: string): string {
  let debut = 0;
  let fin = s.length;
  while (debut < fin && ESPACE_PY(s.charCodeAt(debut))) debut++;
  while (fin > debut && ESPACE_PY(s.charCodeAt(fin - 1))) fin--;
  return s.slice(debut, fin);
}

/** Type JSON pour FastAPI (`strict_content_type`) : `application/json` ou `application/*+json`, lu par `email.message`. */
function estTypeJson(valeur: string): boolean {
  const type = rognerPy(valeur.split(";", 1)[0] ?? "").toLowerCase();
  const parties = type.split("/");
  if (parties.length !== 2) return false;
  const [principal, sous = ""] = parties;
  return principal === "application" && (sous === "json" || sous.endsWith("+json"));
}

/** Corps d'un paramètre `Body` : absent (vide ou `null`), JSON décodé, ou octets si le type n'est pas JSON. */
export function lireCorps(requete: FastifyRequest): { present: false } | { present: true; valeur: unknown } {
  const brut = requete.corpsBrut;
  if (brut.length === 0) return { present: false };
  const type = requete.headers["content-type"];
  if (!type || !estTypeJson(type)) return { present: true, valeur: brut };
  const r = decoder(requete);
  if (r.ok) return r.valeur === null ? { present: false } : { present: true, valeur: r.valeur };
  if (r.erreur instanceof ErreurJsonPy) {
    throw erreurValidation([
      {
        type: "json_invalid",
        loc: ["body", r.erreur.pos],
        msg: "JSON decode error",
        input: {},
        ctx: { error: r.erreur.msgPy },
      },
    ]);
  }
  throw new HttpError(400, "There was an error parsing the body");
}
