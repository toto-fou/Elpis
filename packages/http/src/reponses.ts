// SPDX-License-Identifier: MIT
/** packages/http/src/reponses.ts — corps JSON des réponses comme `JSONResponse` de Starlette : NaN, ±inf ou demi-paire ⇒ panne 500. */
import { clesOrdonnees, estDict, FlottantPy, noterOrdreDesCles, objetNu, pyJsonDumps } from "@elpis/commun";
import type { FastifyReply } from "fastify";

const DEMI_PAIRE = /\\ud[89a-f][0-9a-f]{2}/g;

/** Flottant non fini (que `JSON.stringify` écrit `null`), `toJSON` compris ; jamais appelé sur un cycle, qui a déjà levé. */
function contientNonFini(racine: unknown): boolean {
  const pile: unknown[] = [racine];
  while (pile.length > 0) {
    let v = pile.pop();
    if (v !== null && typeof v === "object" && typeof (v as { toJSON?: unknown }).toJSON === "function")
      v = (v as { toJSON: () => unknown }).toJSON();
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return true;
    } else if (v !== null && typeof v === "object") {
      for (const x of Array.isArray(v) ? v : Object.values(v)) pile.push(x);
    }
  }
  return false;
}

/** Demi-paire isolée : `JSON.stringify` l'écrit `\udXXX`, après un nombre pair de `\` (sinon c'est du texte échappé). */
function contientDemiPaire(texte: string): boolean {
  DEMI_PAIRE.lastIndex = 0;
  for (let m = DEMI_PAIRE.exec(texte); m !== null; m = DEMI_PAIRE.exec(texte)) {
    let barres = 0;
    for (let j = m.index - 1; texte.charCodeAt(j) === 0x5c; j--) barres++;
    if (barres % 2 === 0) return true;
  }
  return false;
}

/** `json.dumps(allow_nan=False)` puis `.encode("utf-8")` de `JSONResponse.render` : lève là où Starlette lève. */
export function serialiserReponse(charge: unknown): string {
  const texte = JSON.stringify(charge) as string | undefined;
  if (texte === undefined) return "null";
  if (texte.includes("null") && contientNonFini(charge))
    throw new Error("Out of range float values are not JSON compliant");
  if (contientDemiPaire(texte))
    throw new Error("'utf-8' codec can't encode character: surrogates not allowed");
  return texte;
}

/** `JSONResponse` d'une valeur relue par pyJsonLoads (FlottantPy, bigint, ordre Python des clés) : écrite par pyJsonDumps. */
export function reponseJsonPy(
  reponse: FastifyReply,
  valeur: unknown,
  entetes: Readonly<Record<string, string>> = {},
): FastifyReply {
  const texte = pyJsonDumps(valeur, { ensureAscii: false, separators: [",", ":"], allowNan: false });
  if (!texte.isWellFormed()) throw new Error("'utf-8' codec can't encode character: surrogates not allowed");
  return reponse.headers(entetes).type("application/json; charset=utf-8").send(texte);
}

/** Réponse d'une route annotée (`-> Dict[str, Any]`) : le modèle de réponse de FastAPI écrit NaN et ±inf en `null` (E19). */
export function nonFinisEnNul(v: unknown): unknown {
  if (v instanceof FlottantPy) return Number.isFinite(v.valeur) ? v : null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.map(nonFinisEnNul);
  if (!estDict(v)) return v;
  const cles = clesOrdonnees(v);
  const out = objetNu();
  for (const k of cles) out[k] = nonFinisEnNul(v[k]);
  noterOrdreDesCles(out, cles);
  return out;
}

/** `reponseJsonPy` d'une route annotée : NaN et ±inf en `null`. */
export function repondreAnnote(rep: FastifyReply, valeur: unknown): FastifyReply {
  return reponseJsonPy(rep, nonFinisEnNul(valeur));
}
