// SPDX-License-Identifier: MIT
/** apps/core/src/llm/metriques-moteur.ts — métriques Prometheus d'un moteur lues d'après son profil : cache KV, requêtes en cours et en attente, débit, cache de préfixe. */
import { arrondiPy } from "@elpis/commun";

import type { ProfilMoteur } from "./profils";

export interface Echantillon {
  readonly nom: string;
  readonly etiquettes: Readonly<Record<string, string>>;
  readonly valeur: number;
}

export interface JaugeKv {
  used: number;
  total: number;
  pct: number;
}

/** État de charge lu sur `/metrics` ; `null` = le moteur ne l'expose pas (ou métriques coupées). */
export interface EtatCharge {
  kv: JaugeKv | null;
  en_cours: number | null;
  en_attente: number | null;
  debit_tps: number | null;
  cache_prefixe_pct: number | null;
  /** Délai moyen du premier jeton (s) depuis la lecture précédente, sinon depuis le démarrage du moteur. */
  ttft_s: number | null;
  /** Jetons de prefill calculés par seconde entre deux lectures (hors cache de préfixe). */
  prefill_tps: number | null;
}

const RE_LIGNE = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{(.*)\})?\s+(\S+)/u;
const RE_ETIQUETTE = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/gu;

function valeurPrometheus(brut: string): number | null {
  if (brut === "+Inf") return Infinity;
  if (brut === "-Inf") return -Infinity;
  if (brut === "NaN") return NaN;
  const n = Number(brut);
  return Number.isFinite(n) ? n : null;
}

/** Texte d'exposition Prometheus → échantillons (nom normalisé `:` → `_`, étiquettes gardées). */
export function lireEchantillons(texte: string | null | undefined): Echantillon[] {
  const sortie: Echantillon[] = [];
  if (!texte) return sortie;
  for (const brute of texte.split(/\r?\n/u)) {
    const ligne = brute.trim();
    if (!ligne || ligne.startsWith("#")) continue;
    const m = RE_LIGNE.exec(ligne);
    if (m === null) continue;
    const valeur = valeurPrometheus(m[4] ?? "");
    if (valeur === null || Number.isNaN(valeur)) continue;
    const etiquettes: Record<string, string> = {};
    for (const e of (m[3] ?? "").matchAll(RE_ETIQUETTE))
      etiquettes[e[1] ?? ""] = (e[2] ?? "").replace(/\\(.)/gu, (_t, c: string) => (c === "n" ? "\n" : c));
    sortie.push({ nom: (m[1] ?? "").replaceAll(":", "_"), etiquettes, valeur });
  }
  return sortie;
}

/** Échantillons d'un nom (et des étiquettes demandées) ; le détail par priorité de SGLang (étiquette `priority` non vide) est écarté, le total suffit. */
function serie(
  echantillons: readonly Echantillon[],
  nom: string | null,
  etiquettes: Readonly<Record<string, string>> | null = null,
): Echantillon[] {
  if (!nom) return [];
  return echantillons.filter(
    (e) =>
      e.nom === nom &&
      !e.etiquettes["priority"] &&
      Object.entries(etiquettes ?? {}).every(([k, v]) => e.etiquettes[k] === v),
  );
}

/** Somme d'un nom ; avec `replique`, maximum des échantillons d'une même réplique (rangs TP qui répètent la valeur) puis somme des répliques. */
function somme(
  echantillons: readonly Echantillon[],
  nom: string | null,
  replique: string | null = null,
  etiquettes: Readonly<Record<string, string>> | null = null,
): number | null {
  const s = serie(echantillons, nom, etiquettes);
  if (!s.length) return null;
  if (replique === null) return s.reduce((t, e) => t + e.valeur, 0);
  const parReplique = new Map<string, number>();
  for (const e of s) {
    const k = e.etiquettes[replique] ?? "";
    parReplique.set(k, Math.max(parReplique.get(k) ?? -Infinity, e.valeur));
  }
  return [...parReplique.values()].reduce((t, v) => t + v, 0);
}

function moyenne(echantillons: readonly Echantillon[], nom: string | null): number | null {
  const s = serie(echantillons, nom);
  return s.length ? s.reduce((t, e) => t + e.valeur, 0) / s.length : null;
}

/** Capacité du cache KV en jetons d'après `vllm:cache_config_info` (`num_gpu_blocks` × `block_size`, par moteur). */
function capaciteKvInfo(echantillons: readonly Echantillon[], nom: string | null): number | null {
  let total = 0;
  for (const e of serie(echantillons, nom)) {
    const direct = Number(e.etiquettes["kv_cache_size_tokens"]);
    if (Number.isFinite(direct) && direct > 0) {
      total += direct;
      continue;
    }
    const blocs = Number(e.etiquettes["num_gpu_blocks"]);
    const taille = Number(e.etiquettes["block_size"]);
    if (Number.isFinite(blocs) && Number.isFinite(taille) && blocs > 0 && taille > 0) total += blocs * taille;
  }
  return total > 0 ? total : null;
}

const derniers = new Map<string, { jetons: number; t: number }>();

/** Débit de génération (jetons/s) depuis le compteur cumulé du moteur, entre deux lectures de la même clé. */
function debitDepuisCompteur(cle: string, jetons: number | null, maintenant: number): number | null {
  if (jetons === null) return null;
  const avant = derniers.get(cle);
  derniers.set(cle, { jetons, t: maintenant });
  if (avant === undefined || maintenant <= avant.t || jetons < avant.jetons) return null;
  return (jetons - avant.jetons) / (maintenant - avant.t);
}

const derniersTtft = new Map<string, { somme: number; compte: number }>();

/** Délai moyen du premier jeton : sur les requêtes finies depuis la lecture précédente de la même clé, sinon depuis le démarrage. */
function ttftMoyen(cle: string, sommeS: number | null, compte: number | null): number | null {
  if (sommeS === null || compte === null || !(compte > 0)) return null;
  const avant = derniersTtft.get(cle);
  derniersTtft.set(cle, { somme: sommeS, compte });
  if (avant !== undefined && compte > avant.compte && sommeS >= avant.somme)
    return (sommeS - avant.somme) / (compte - avant.compte);
  return sommeS / compte;
}

/** Oublie les compteurs mémorisés (tests, changement de moteur). */
export function oublierDebits(): void {
  derniers.clear();
  derniersTtft.clear();
}

function arrondi1(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : arrondiPy(v, 1);
}

/** Jauge KV d'après le profil : fraction du moteur si exposée, sinon utilisés ÷ capacité ; capacité lue sur les métriques ou donnée par l'appelant. */
export function jaugeKv(
  profil: ProfilMoteur,
  echantillons: readonly Echantillon[],
  capaciteConnue = 0,
): JaugeKv | null {
  const n = profil.metriques;
  const ratio = moyenne(echantillons, n.kvRatio);
  let utilises = somme(echantillons, n.kvUtilises, n.etiquetteReplique);
  const total =
    somme(echantillons, n.kvTotal, n.etiquetteReplique) ??
    capaciteKvInfo(echantillons, n.kvInfo) ??
    capaciteConnue;
  if (!(total > 0)) return null;
  utilises ??= ratio !== null ? Math.round(ratio * total) : 0;
  const pct = ratio !== null ? ratio * 100 : (utilises / total) * 100;
  return { used: Math.trunc(utilises), total: Math.trunc(total), pct: arrondiPy(pct, 1) };
}

/** État de charge d'un moteur ; `cle` distingue les serveurs pour le débit calculé entre deux lectures. */
export function etatCharge(
  profil: ProfilMoteur,
  texte: string | null | undefined,
  options: { cle?: string; capaciteKv?: number; maintenant?: number } = {},
): EtatCharge {
  const ech = lireEchantillons(texte);
  const n = profil.metriques;
  const rep = n.etiquetteReplique;
  const cle = options.cle ?? profil.type;
  const maintenant = options.maintenant ?? performance.now() / 1000;
  let debit = somme(ech, n.debit, rep);
  if (debit === null && n.jetonsGeneres)
    debit = debitDepuisCompteur(`${cle}|${n.jetonsGeneres}`, somme(ech, n.jetonsGeneres, rep), maintenant);
  let cache = moyenne(ech, n.tauxCache);
  if (cache === null) {
    const requetes = somme(ech, n.cacheRequetes);
    const succes = somme(ech, n.cacheSucces);
    if (requetes !== null && succes !== null && requetes > 0) cache = succes / requetes;
  }
  const enCours = somme(ech, n.enCours, rep);
  const enAttente = somme(ech, n.enAttente, rep);
  const prefill = n.prefillJetons
    ? debitDepuisCompteur(
        `${cle}|${n.prefillJetons}`,
        somme(ech, n.prefillJetons, rep, n.etiquettesPrefill),
        maintenant,
      )
    : null;
  const ttft = n.ttft ? ttftMoyen(cle, somme(ech, `${n.ttft}_sum`), somme(ech, `${n.ttft}_count`)) : null;
  return {
    kv: jaugeKv(profil, ech, options.capaciteKv ?? 0),
    en_cours: enCours === null ? null : Math.trunc(enCours),
    en_attente: enAttente === null ? null : Math.trunc(enAttente),
    debit_tps: arrondi1(debit),
    cache_prefixe_pct: cache === null ? null : arrondi1(cache * 100),
    ttft_s: ttft === null || !Number.isFinite(ttft) ? null : arrondiPy(ttft, 2),
    prefill_tps: arrondi1(prefill),
  };
}

/** Le moteur expose-t-il au moins une des métriques que son profil attend ? */
export function metriquesReconnues(profil: ProfilMoteur, texte: string | null | undefined): boolean {
  const n = profil.metriques;
  const attendus = new Set(
    [
      n.enCours,
      n.enAttente,
      n.kvRatio,
      n.kvUtilises,
      n.kvTotal,
      n.kvInfo,
      n.debit,
      n.jetonsGeneres,
      n.tauxCache,
      n.cacheRequetes,
      n.cacheSucces,
      n.prefillJetons,
      n.ttft ? `${n.ttft}_count` : null,
    ].filter((v): v is string => typeof v === "string"),
  );
  return lireEchantillons(texte).some((e) => attendus.has(e.nom));
}
