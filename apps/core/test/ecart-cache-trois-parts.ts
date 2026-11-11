// SPDX-License-Identifier: MIT
/** apps/core/test/ecart-cache-trois-parts.ts — écart voulu au Python : entrée en trois parts (lu du cache, écrit, hors cache) et « Requêtes servies par le cache » à la place de « Réutilisation du cache KV ». */
import { pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { expect } from "vitest";

import { couleur } from "../src/observabilite/series";

/** Widgets dont les données changent : comparés par invariants au Python, pas à l'octet. */
export const WIDGETS_CACHE: ReadonlySet<string> = new Set([
  "usage_cache",
  "usage_input_timeline",
  "usage_by_model",
  "usage_top_users",
  "kpi_kv_prefix_reuse",
]);

/** Texte JSON avec les non-ASCII échappés comme `json.dumps` (vecteurs écrits par pyJsonDumps). */
function echappe(s: string): string {
  return s.replace(/[\u007f-￿]/gu, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

const TITRES: readonly [string, string][] = [
  ["Réutilisation du cache KV", "Requêtes servies par le cache"],
  ["Entrée — cache vs utile", "Entrée — cache lu, écrit, hors cache"],
];

/** Titres, défaut et purge du widget des requêtes réécrits dans une référence Python (UTF-8 ou échappée, compacte ou espacée). */
export function layoutTroisParts(texte: string): string {
  let s = texte;
  for (const [avant, apres] of TITRES)
    s = s.replaceAll(`"${avant}"`, `"${apres}"`).replaceAll(`"${echappe(avant)}"`, `"${echappe(apres)}"`);
  return s.replace(
    /("id": ?"kpi_kv_prefix_reuse",[^}]*?"default": ?)false(, ?"purge": ?)\{"target": ?"metric_events", ?"event_types": ?\["kv_prefix_reuse_pct"\]\}/gu,
    (_m, debut: string, purge: string) => `${debut}true${purge}null`,
  );
}

/** Découpe Python complétée du cache écrit (borné à l'entrée hors cache lu) et du reste, dans l'ordre des clés du TS. */
export function decoupeTroisParts(texte: string): string {
  const d = pyJsonLoads(texte) as Dict;
  const [entree, lu] = [Number(d["input"]), Number(d["cache"])];
  const ecrit = Math.min(Number(d["cache_creation"]), entree - lu);
  const out: Dict = {};
  for (const [k, v] of Object.entries(d)) {
    out[k] = v;
    if (k === "cache_creation") Object.assign(out, { cache_write: ecrit, uncached: entree - lu - ecrit });
  }
  return pyJsonDumps(out);
}

/** Fin de l'objet JSON qui commence en `i` (accolade ouvrante), chaînes et échappements compris. */
function finObjet(s: string, i: number): number {
  let profondeur = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"') {
      for (j++; j < s.length && s[j] !== '"'; j++) if (s[j] === "\\") j++;
    } else if (c === "{") profondeur++;
    else if (c === "}" && --profondeur === 0) return j;
  }
  return s.length - 1;
}

/** Données des widgets de l'écart remplacées par `null` (clé suivie d'un objet), pour comparer le reste à l'octet. */
export function masquerWidgets(texte: string): string {
  let s = texte;
  for (const id of WIDGETS_CACHE) {
    const motif = new RegExp(`"${id}": ?\\{`, "gu");
    let m: RegExpExecArray | null;
    while ((m = motif.exec(s)) !== null) {
      const debut = m.index + m[0].length - 1;
      s = s.slice(0, debut) + "null" + s.slice(finObjet(s, debut) + 1);
      motif.lastIndex = debut;
    }
  }
  return s;
}

const nombres = (ds: Dict | undefined): number[] => ((ds?.["data"] ?? []) as unknown[]).map(Number);

function serie(w: Dict, label: string): Dict | undefined {
  return (w["datasets"] as Dict[]).find((d) => d["label"] === label);
}

/** Les trois parts recomposent l'entrée du Python : lu = ancien « cache », écrit + hors cache = ancien reste. */
function partsDeLEntree(o: Dict, r: Dict, cache: string, reste: string, nom: string): void {
  const [lu, ecrit, hors] = [
    nombres(serie(o, "Lu du cache")),
    nombres(serie(o, "Écrit en cache")),
    nombres(serie(o, "Hors cache")),
  ];
  expect(lu, `${nom} : lu du cache`).toEqual(nombres(serie(r, cache)));
  expect(
    ecrit.map((e, i) => e + (hors[i] ?? 0)),
    `${nom} : écrit + hors cache`,
  ).toEqual(nombres(serie(r, reste)));
  expect(
    [...ecrit, ...hors].every((v) => Number.isInteger(v) && v >= 0),
    `${nom} : entiers positifs`,
  ).toBe(true);
}

/** Un widget de l'écart comparé à sa référence Python par invariants ; `heures` = fenêtre demandée. */
export function verifierTroisParts(id: string, obtenu: unknown, reference: unknown, heures: number): void {
  const [o, r] = [obtenu as Dict, reference as Dict];
  const nom = `${id} (${heures} h)`;
  if (id === "kpi_kv_prefix_reuse") {
    const fenetre = heures === 168 ? "7 j" : heures === 720 ? "30 j" : "24 h";
    expect(o, nom).toEqual({
      value: "—",
      unit: "aucune requête mesurée",
      color: "slate",
      icon: "ph-recycle",
      detail: `sur ${fenetre}`,
    });
  } else if (id === "usage_cache") {
    const { detail: _d, ...reste } = r;
    expect({ ...o, detail: undefined }, nom).toEqual({ ...reste, detail: undefined });
    const ancien = /^(.+) en cache · .+ utiles(?: · (.+) mis en cache)?$/u.exec(String(r["detail"] ?? ""));
    if (ancien === null) expect(o["detail"], nom).toBe(r["detail"]);
    else
      expect(String(o["detail"]), nom).toMatch(
        new RegExp(`^${ancien[1]} lus${ancien[2] ? ` · ${ancien[2]} écrits` : ""} · .+ hors cache$`, "u"),
      );
  } else if (id === "usage_input_timeline") {
    expect(o["labels"], nom).toEqual(r["labels"]);
    expect((o["datasets"] as Dict[]).map((d) => [d["label"], d["backgroundColor"], d["stack"]])).toEqual([
      ["Lu du cache", `rgba(${couleur(0)},0.75)`, "all"],
      ["Écrit en cache", `rgba(${couleur(5)},0.75)`, "all"],
      ["Hors cache", `rgba(${couleur(1)},0.75)`, "all"],
    ]);
    partsDeLEntree(o, r, "Cache", "Utile", nom);
  } else {
    expect([o["labels"], o["meta"]], nom).toEqual([r["labels"], r["meta"]]);
    expect((o["datasets"] as Dict[]).map((d) => [d["label"], d["backgroundColor"]])).toEqual([
      ["Lu du cache", `rgba(${couleur(0)},0.8)`],
      ["Écrit en cache", `rgba(${couleur(5)},0.8)`],
      ["Hors cache", `rgba(${couleur(1)},0.8)`],
      ["Réflexion", `rgba(${couleur(2)},0.8)`],
      ["Réponse", `rgba(${couleur(3)},0.8)`],
    ]);
    partsDeLEntree(o, r, "Cache", "Entrée utile", nom);
    for (const l of ["Réflexion", "Réponse"]) expect(serie(o, l), `${nom} : ${l}`).toEqual(serie(r, l));
  }
}

/** Corps de route (tableau de bord `data`, rapport `widgets`) : widgets de l'écart vérifiés par invariants contre le Python. */
export function verifierCorps(obtenu: string, attendu: string, heures: number): void {
  if (![...WIDGETS_CACHE].some((id) => new RegExp(`"${id}": ?\\{`, "u").test(attendu))) return;
  const [o, a] = [pyJsonLoads(obtenu) as Dict, pyJsonLoads(attendu) as Dict];
  for (const cle of ["data", "widgets"]) {
    const [wo, wa] = [o[cle] as Dict | undefined, a[cle] as Dict | undefined];
    if (!wo || !wa) continue;
    for (const id of WIDGETS_CACHE)
      if (wa[id] !== null && typeof wa[id] === "object") verifierTroisParts(id, wo[id], wa[id], heures);
  }
}
