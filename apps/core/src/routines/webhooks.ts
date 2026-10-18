// SPDX-License-Identifier: MIT
/** apps/core/src/routines/webhooks.ts — pièces pures de la livraison webhook (scheduling/routes_webhooks.py) : résumé d'événement, branche visée, limiteur de débit par IP. */
import {
  ErreurPython,
  estDict,
  lire,
  longueurPy,
  prefixePy,
  pyJsonDumps,
  reprPy,
  splitlinesPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";

export const CORPS_MAX = 1024 * 1024;
export const CTX_CAP = 2000;
export const FENETRE_DEBIT_S = 60.0;
export const DEBIT_MAX = 120;
const IPS_MAX = 1024;
const CLES_GIT = ["repository", "pull_request", "head_commit", "pusher", "ref"];

const asDict = (v: unknown): Dict => (estDict(v) ? v : {});
const asStr = (v: unknown): string => (typeof v === "string" ? v : "");

/** `json.dumps` du payload ; `str(payload)` si Python lèverait TypeError/ValueError. */
function serialiser(payload: Dict, indent?: number): string {
  try {
    return pyJsonDumps(
      payload,
      indent === undefined ? { ensureAscii: false } : { ensureAscii: false, indent },
    );
  } catch (e) {
    if (e instanceof TypeError || (e instanceof ErreurPython && e.type === "ValueError"))
      return reprPy(payload);
    throw e;
  }
}

/** `_event_summary` : champs Git choisis, sinon le JSON du payload (lisible s'il tient), borné à 2000 caractères. */
export function resumeEvenement(event: string, payload: Dict): string {
  const lignes = [`- type : ${event || "inconnu"}`];
  if (!CLES_GIT.some((k) => Object.hasOwn(payload, k))) {
    if (veritePy(payload)) {
      let corps = serialiser(payload);
      if (longueurPy(corps) <= CTX_CAP - 200) corps = serialiser(payload, 2);
      if (longueurPy(corps) > CTX_CAP - 200)
        corps = prefixePy(corps, CTX_CAP - 200) + "\n… (payload tronqué)";
      lignes.push("- payload :\n```json\n" + corps + "\n```");
    }
    return prefixePy(lignes.join("\n"), CTX_CAP);
  }
  const depot = asStr(lire(asDict(lire(payload, "repository")), "full_name"));
  if (depot) lignes.push(`- dépôt : ${depot}`);
  const ref = asStr(lire(payload, "ref"));
  if (ref) lignes.push(`- ref : ${ref}`);
  const pr = asDict(lire(payload, "pull_request"));
  if (veritePy(pr)) {
    const base = asStr(lire(asDict(lire(pr, "base")), "ref"));
    const tete = asStr(lire(asDict(lire(pr, "head")), "ref"));
    const numero = Object.hasOwn(pr, "number") ? strPy(pr["number"]) : "?";
    lignes.push(`- pull request #${numero} : ${prefixePy(stripPy(asStr(lire(pr, "title"))), 200)}`);
    if (base || tete) lignes.push(`- branches : ${tete} → ${base}`);
    if (veritePy(lire(payload, "action"))) lignes.push(`- action : ${strPy(payload["action"])}`);
  }
  const commit = asDict(lire(payload, "head_commit"));
  if (veritePy(lire(commit, "message"))) {
    const premiere = splitlinesPy(stripPy(strPy(commit["message"])))[0];
    if (premiere === undefined) throw new ErreurPython("IndexError", "list index out of range");
    lignes.push("- dernier commit : " + prefixePy(premiere, 200));
  }
  const auteur =
    asStr(lire(asDict(lire(payload, "pusher")), "login")) ||
    asStr(lire(asDict(lire(payload, "sender")), "login"));
  if (auteur) lignes.push(`- auteur : ${auteur}`);
  return prefixePy(lignes.join("\n"), CTX_CAP);
}

/** `_branch_of` : PR → branche cible (base), push → `refs/heads/x` sans préfixe, sinon la ref telle quelle. */
export function brancheDe(_event: string, payload: Dict): string | null {
  const pr = asDict(lire(payload, "pull_request"));
  if (veritePy(pr)) return asStr(lire(asDict(lire(pr, "base")), "ref")) || null;
  const ref = asStr(lire(payload, "ref"));
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  return ref || null;
}

/** `_rate_limited` : fenêtre glissante par IP, propre au process ; IP inactives purgées au-delà de 1024. */
export class LimiteurDebit {
  private readonly seaux = new Map<string, number[]>();

  limite(ip: string, maintenant: number = Date.now() / 1000): boolean {
    let seau = this.seaux.get(ip);
    if (seau === undefined) {
      seau = [];
      this.seaux.set(ip, seau);
    }
    const seuil = maintenant - FENETRE_DEBIT_S;
    while (seau.length && (seau[0] as number) < seuil) seau.shift();
    if (seau.length >= DEBIT_MAX) return true;
    seau.push(maintenant);
    if (this.seaux.size > IPS_MAX)
      for (const [k, v] of [...this.seaux])
        if (!v.length || (v[v.length - 1] as number) < seuil) this.seaux.delete(k);
    return false;
  }
}
