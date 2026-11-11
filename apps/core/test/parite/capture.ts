// SPDX-License-Identifier: MIT
/** apps/core/test/parite/capture.ts — capture de parité côté TS : anonymisation des réponses, forme, compatibilité, signature et comparaison, comme shared_infra/observability/capture_parite.py. */
import { createHmac } from "node:crypto";

import {
  clesOrdonnees,
  egalPy,
  FlottantPy,
  pyJsonDumps,
  pyJsonLoads,
  reprPy,
  splitlinesPy,
  stripPy,
  strPy,
  texteJsonPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { FastifyInstance } from "fastify";

export const CORPS_MAX = 256 * 1024;
const EVENEMENTS_MAX = 500;

const CLES_STRUCTURE = new Set([
  "type",
  "kind",
  "status",
  "role",
  "mode",
  "ok",
  "error_kind",
  "stop_reason",
  "finish_reason",
  "method",
  "format",
  "content_type",
  "mime",
  "engine",
  "family",
  "visibility",
  "scope",
  "event",
  "level",
  "priority",
  "op",
  "trigger",
  "transport",
  "strategy",
]);
const CLES_IDS = new Set([
  "id",
  "chat_id",
  "run_id",
  "project_id",
  "routine_id",
  "message_id",
  "call_id",
  "tool_call_id",
  "task_id",
  "parent_id",
  "folder_id",
  "skill_id",
  "agent_id",
  "job_id",
  "file_id",
]);
const SECRET =
  /pass(word|wd)?|token|secret|api[_-]?key|authori[sz]ation|cookie|csrf|credential|private|totp|otp|pin$|bearer|_enc$|^enc_|signature|^key$|_key$|^sid$|session|^code$|^state$|nonce|verifier|challenge/i;
const IDENTITE =
  /user(_?name)?$|user_?id$|^uid$|e?mail|login|display_name|owner|author|ip$|^ip_|user_agent|remote_addr|^host$/i;
const OPAQUE = /^[A-Za-z0-9_\-:.]{1,40}$/u;
const ENUM = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/u;
const CLE_CODE = /^[a-z][a-z0-9_]{0,39}$/u;

const estObjet = (v: unknown): v is Dict =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof FlottantPy);

/** Liste blanche : structure, identifiants opaques, nombres et booléens passent ; noms pseudonymisés. */
export class Anonymiseur {
  private readonly cle: Buffer;

  constructor(cle: Uint8Array) {
    this.cle = Buffer.from(cle);
  }

  pseudonyme(valeur: unknown): string {
    return `<utilisateur:${createHmac("sha256", this.cle).update(strPy(valeur), "utf8").digest("hex").slice(0, 8)}>`;
  }

  nomDeCle(k: unknown): string {
    return typeof k === "string" && CLE_CODE.test(k) ? k : "<cle>";
  }

  valeur(cle: string, v: unknown): unknown {
    if (estObjet(v)) {
      const out: Dict = {};
      for (const k of clesOrdonnees(v)) {
        const nom = this.nomDeCle(k);
        if (!Object.hasOwn(out, nom)) out[nom] = this.valeur(nom, v[k]);
      }
      return out;
    }
    if (Array.isArray(v)) return v.map((x) => this.valeur(cle, x));
    if (v === null || v === undefined || typeof v === "boolean") return v ?? null;
    if (SECRET.test(cle)) return "<secret>";
    if (IDENTITE.test(cle)) return this.pseudonyme(v);
    if (typeof v !== "string") return v;
    if (CLES_IDS.has(cle) && OPAQUE.test(v)) return v;
    if (CLES_STRUCTURE.has(cle) && ENUM.test(v)) return v;
    return `<texte:${Array.from(v).length}>`;
  }

  corps(brut: Uint8Array, typeContenu: string, taille: number | null = null): unknown {
    if (!brut.length) return null;
    const ct = stripPy(typeContenu.split(";")[0] ?? "").toLowerCase();
    if (ct.endsWith("json") && !ct.includes("ndjson")) {
      try {
        return { json: this.valeur("", pyJsonLoads(texteJsonPy(brut))) };
      } catch {
        // pas du JSON : relevé comme un autre type
      }
    }
    if (ct.includes("ndjson") || ct.includes("event-stream"))
      return {
        evenements: this.evenements(splitlinesPy(new TextDecoder("utf-8", { ignoreBOM: true }).decode(brut))),
      };
    return { type: ct, taille: taille ?? brut.length };
  }

  evenements(lignes: Iterable<string>): unknown[] {
    const out: unknown[] = [];
    for (let ligne of lignes) {
      ligne = stripPy(ligne);
      if (ligne.startsWith("data:")) ligne = stripPy(ligne.slice(5));
      if (!ligne || ["event:", "id:", "retry:", ":"].some((p) => ligne.startsWith(p))) continue;
      let ev: unknown;
      try {
        ev = pyJsonLoads(ligne);
      } catch {
        continue;
      }
      if (estObjet(ev) && ev["type"] === "ping") continue;
      out.push(this.valeur("", ev));
      if (out.length >= EVENEMENTS_MAX) break;
    }
    return out;
  }
}

/** Signature de forme : clés et types, jamais les valeurs ; entiers et flottants confondus. */
export function forme(obj: unknown): unknown {
  if (estObjet(obj)) {
    const out: Dict = {};
    for (const k of [...clesOrdonnees(obj)].sort()) out[k] = forme(obj[k]);
    return out;
  }
  if (Array.isArray(obj)) {
    const formes: unknown[] = [];
    for (const x of obj) {
      const f = forme(x);
      if (!formes.some((g) => egalPy(g, f))) formes.push(f);
    }
    const cle = (f: unknown): string => pyJsonDumps(f, { sortKeys: true });
    return { liste: formes.sort((a, b) => (cle(a) < cle(b) ? -1 : cle(a) > cle(b) ? 1 : 0)) };
  }
  if (typeof obj === "boolean") return "bool";
  if (typeof obj === "number" || typeof obj === "bigint" || obj instanceof FlottantPy) return "number";
  return obj === null || obj === undefined ? "null" : "str";
}

/** Formes compatibles : `null` va avec tout, une liste vide avec toute liste, sinon mêmes clés, récursivement. */
export function compatibles(a: unknown, b: unknown): boolean {
  if (a === "null" || b === "null" || egalPy(a, b)) return true;
  if (estObjet(a) && estObjet(b)) {
    const [ka, kb] = [Object.keys(a), Object.keys(b)];
    if (ka.length === 1 && ka[0] === "liste" && kb.length === 1 && kb[0] === "liste") {
      const [la, lb] = [a["liste"] as unknown[], b["liste"] as unknown[]];
      if (!la.length || !lb.length) return true;
      return (
        la.every((x) => lb.some((y) => compatibles(x, y))) &&
        lb.every((x) => la.some((y) => compatibles(x, y)))
      );
    }
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && compatibles(a[k], b[k]));
  }
  return false;
}

/** Statut, type de contenu, troncature, forme du corps ou suite compactée des types d'événements et leurs formes. */
export function signature(capture: Dict): Dict {
  const rep = capture["reponse"] as Dict;
  const corps = (rep["corps"] ?? {}) as Dict;
  const enTetes = (rep["en_tetes"] ?? {}) as Dict;
  const ct = stripPy(strPy(enTetes["content-type"] ?? "").split(";")[0] ?? "").toLowerCase();
  const sig: Dict = { statut: rep["statut"], type: ct, tronque: Boolean(rep["tronque"]) };
  if (Object.hasOwn(corps, "json")) sig["forme"] = forme(corps["json"]);
  else if (Object.hasOwn(corps, "evenements")) {
    const types: unknown[] = [];
    const parType = new Map<string, unknown[]>();
    for (const e of corps["evenements"] as unknown[]) {
      const t = estObjet(e) ? (e["type"] ?? null) : null;
      if (!types.length || !egalPy(types.at(-1), t)) types.push(t);
      const k = t === null ? "None" : strPy(t);
      parType.set(k, [...(parType.get(k) ?? []), e]);
    }
    sig["evenements"] = types;
    const formes: Dict = {};
    for (const k of [...parType.keys()].sort()) formes[k] = forme(parType.get(k));
    sig["formes"] = formes;
  }
  return sig;
}

/** Écarts entre deux captures d'une même requête (vide = parité de forme). */
export function comparer(attendu: Dict, obtenu: Dict): string[] {
  const [a, b] = [signature(attendu), signature(obtenu)];
  const ecarts: string[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (
      (k === "forme" || k === "formes") &&
      Object.hasOwn(a, k) &&
      Object.hasOwn(b, k) &&
      compatibles(a[k], b[k])
    )
      continue;
    if (!egalPy(a[k] ?? null, b[k] ?? null))
      ecarts.push(`${k} : ${reprPy(a[k] ?? null)} ≠ ${reprPy(b[k] ?? null)}`);
  }
  return ecarts;
}

const MARQUE = /^<(?:texte:\d+|secret|utilisateur:[0-9a-f]{8}|cle)>$/u;

/** Valeur qui porte une marque d'anonymisation (la requête d'origine n'est plus reconstituable). */
function marquee(v: unknown): boolean {
  if (typeof v === "string") return MARQUE.test(v);
  if (Array.isArray(v)) return v.some(marquee);
  if (estObjet(v)) return Object.keys(v).some((k) => k === "<cle>" || marquee(v[k]));
  return false;
}

function segment(v: unknown, chemin: boolean): string | null {
  if (v === null || v === undefined || marquee(v) || typeof v === "boolean") return null;
  const texte = strPy(v);
  return chemin ? texte.split("/").map(encodeURIComponent).join("/") : encodeURIComponent(texte);
}

export type Rejeu = { rejouee: true; ecarts: string[] } | { rejouee: false; raison: string };

/** Requête de la capture rejouée sur l'app TS (`entetes` : le compte ; `concret` : chemin réel quand la capture a effacé ses paramètres), réponse anonymisée comme en Python, signatures comparées. */
export async function rejouerCapture(
  app: FastifyInstance,
  capture: Dict,
  entetes: Readonly<Record<string, string>>,
  a: Anonymiseur,
  concret?: string,
): Promise<Rejeu> {
  const gabarit = strPy(capture["gabarit"]);
  if (gabarit === "<non routé>") return { rejouee: false, raison: "non routé" };
  const req = (capture["requete"] ?? {}) as Dict;
  const params = (req["params"] ?? {}) as Dict;
  let manque = "";
  const chemin =
    concret ??
    gabarit.replace(/\{([A-Za-z_][A-Za-z0-9_]*)(?::([a-z]+))?\}/gu, (_m, nom: string, conv?: string) => {
      const s = segment(params[nom], conv === "path");
      if (s === null) manque ||= `paramètre ${nom}`;
      return s ?? "";
    });
  const query: string[] = [];
  for (const paire of (req["query"] ?? []) as unknown[][]) {
    const [k, v] = [paire[0], paire[1]];
    const [sk, sv] = [k === "<cle>" ? null : segment(k, false), segment(v, false)];
    if (sk === null || sv === null) manque ||= `query ${strPy(k)}`;
    else query.push(`${sk}=${sv}`);
  }
  const corpsReq = req["corps"] as Dict | null | undefined;
  let payload: string | undefined;
  if (corpsReq !== null && corpsReq !== undefined) {
    if (!Object.hasOwn(corpsReq, "json")) manque ||= "corps non JSON";
    else if (marquee(corpsReq["json"])) manque ||= "corps anonymisé";
    else payload = pyJsonDumps(corpsReq["json"]);
  }
  if (manque) return { rejouee: false, raison: manque };
  const enTetesReq = (req["en_tetes"] ?? {}) as Dict;
  const headers: Record<string, string> = { ...entetes };
  for (const k of ["content-type", "accept"])
    if (typeof enTetesReq[k] === "string") headers[k] = enTetesReq[k];
  if (payload !== undefined) headers["content-type"] ??= "application/json";
  const r = await app.inject({
    method: strPy(capture["methode"]) as "GET",
    url: chemin + (query.length ? `?${query.join("&")}` : ""),
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
  const brut = r.rawPayload.subarray(0, CORPS_MAX);
  const ct = strPy(r.headers["content-type"] ?? "");
  const obtenu: Dict = {
    reponse: {
      statut: r.statusCode,
      en_tetes: ct ? { "content-type": ct } : {},
      corps: a.corps(brut, ct),
      tronque: brut.length >= CORPS_MAX,
    },
  };
  return { rejouee: true, ecarts: comparer(capture, obtenu) };
}

/** Requête réelle d'un parcours de recette (identifiants-chemins.jsonl) : process, chemin concret, compte, statut. */
export interface RequeteConcrete {
  process: string;
  methode: string;
  chemin: string;
  qui: string | null;
  statut: number;
}

function motifGabarit(g: string): RegExp {
  const parties = g.split(/(\{[A-Za-z_][A-Za-z0-9_]*(?::[a-z]+)?\})/u);
  const corps = parties
    .map((p, i) =>
      i % 2 ? (p.endsWith(":path}") ? ".+" : "[^/]+") : p.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
    )
    .join("");
  return new RegExp(`^${corps}$`, "u");
}

/** Chaque capture reçoit la k-ième requête réelle de sa clé (process, méthode, gabarit le plus littéral, classe de statut), comme l'échantillon des K premières du middleware. */
export function attribuerChemins(
  captures: readonly Dict[],
  requetes: readonly RequeteConcrete[],
): (RequeteConcrete | null)[] {
  const gabarits = new Map<string, { g: string; motif: RegExp; litteral: number }[]>();
  for (const c of captures) {
    const g = strPy(c["gabarit"]);
    const k = `${strPy(c["process"])} ${strPy(c["methode"])}`;
    const liste = gabarits.get(k) ?? [];
    if (g !== "<non routé>" && !liste.some((x) => x.g === g))
      liste.push({ g, motif: motifGabarit(g), litteral: g.replace(/\{[^}]*\}/gu, "").length });
    gabarits.set(k, liste);
  }
  const files = new Map<string, RequeteConcrete[]>();
  for (const r of requetes) {
    if (r.statut <= 0) continue;
    const meilleur = (gabarits.get(`${r.process} ${r.methode}`) ?? [])
      .filter((x) => x.motif.test(r.chemin))
      .sort((a, b) => b.litteral - a.litteral)[0];
    if (!meilleur) continue;
    const cle = `${r.process} ${r.methode} ${meilleur.g} ${Math.floor(r.statut / 100)}xx`;
    files.set(cle, [...(files.get(cle) ?? []), r]);
  }
  const pris = new Map<string, number>();
  return captures.map((c) => {
    const statut = Number((c["reponse"] as Dict | undefined)?.["statut"] ?? 0);
    const cle = `${strPy(c["process"])} ${strPy(c["methode"])} ${strPy(c["gabarit"])} ${Math.floor(statut / 100)}xx`;
    const i = pris.get(cle) ?? 0;
    pris.set(cle, i + 1);
    return files.get(cle)?.[i] ?? null;
  });
}
