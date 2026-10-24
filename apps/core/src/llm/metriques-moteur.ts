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
}

const RE_LIGNE = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{(.*)\})?\s+(\S+)/u;
const DEBUT_NOM = /^[A-Za-z_]$/u;
const SUITE_NOM = /^[A-Za-z0-9_]$/u;

/** Paires `nom="valeur"` comme un matchAll de /([A-Za-z_]\w*)="((?:[^"\\]|\\.)*)"/gu, en temps linéaire. */
function pairesEtiquettes(bloc: string): [string, string][] {
  const paires: [string, string][] = [];
  let i = 0;
  while (i < bloc.length) {
    if (!DEBUT_NOM.test(bloc.charAt(i))) {
      i++;
      continue;
    }
    let fin = i + 1;
    while (fin < bloc.length && SUITE_NOM.test(bloc.charAt(fin))) fin++;
    if (bloc.startsWith('="', fin)) {
      let j = fin + 2;
      while (j < bloc.length && bloc.charAt(j) !== '"') {
        if (bloc.charAt(j) !== "\\") j++;
        else if (j + 1 < bloc.length && !"\n\r\u2028\u2029".includes(bloc.charAt(j + 1))) j += 2;
        else break;
      }
      if (bloc.charAt(j) === '"') {
        paires.push([bloc.slice(i, fin), bloc.slice(fin + 2, j)]);
        i = j + 1;
        continue;
      }
    }
    i = fin;
  }
  return paires;
}

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
    for (const [nom, brut] of pairesEtiquettes(m[3] ?? ""))
      etiquettes[nom] = brut.replace(/\\(.)/gu, (_t, c: string) => (c === "n" ? "\n" : c));
    sortie.push({ nom: (m[1] ?? "").replaceAll(":", "_"), etiquettes, valeur });
  }
  return sortie;
}

/** Échantillons d'un nom ; le détail par priorité de SGLang (étiquette `priority` non vide) est écarté, le total suffit. */
function serie(echantillons: readonly Echantillon[], nom: string | null): Echantillon[] {
  if (!nom) return [];
  return echantillons.filter((e) => e.nom === nom && !e.etiquettes["priority"]);
}

function somme(echantillons: readonly Echantillon[], nom: string | null): number | null {
  const s = serie(echantillons, nom);
  return s.length ? s.reduce((t, e) => t + e.valeur, 0) : null;
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

/** Oublie les compteurs mémorisés (tests, changement de moteur). */
export function oublierDebits(): void {
  derniers.clear();
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
  let utilises = somme(echantillons, n.kvUtilises);
  const total = somme(echantillons, n.kvTotal) ?? capaciteKvInfo(echantillons, n.kvInfo) ?? capaciteConnue;
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
  let debit = somme(ech, n.debit);
  if (debit === null && n.jetonsGeneres)
    debit = debitDepuisCompteur(
      `${options.cle ?? profil.type}|${n.jetonsGeneres}`,
      somme(ech, n.jetonsGeneres),
      options.maintenant ?? performance.now() / 1000,
    );
  let cache = moyenne(ech, n.tauxCache);
  if (cache === null) {
    const requetes = somme(ech, n.cacheRequetes);
    const succes = somme(ech, n.cacheSucces);
    if (requetes !== null && succes !== null && requetes > 0) cache = succes / requetes;
  }
  const enCours = somme(ech, n.enCours);
  const enAttente = somme(ech, n.enAttente);
  return {
    kv: jaugeKv(profil, ech, options.capaciteKv ?? 0),
    en_cours: enCours === null ? null : Math.trunc(enCours),
    en_attente: enAttente === null ? null : Math.trunc(enAttente),
    debit_tps: arrondi1(debit),
    cache_prefixe_pct: cache === null ? null : arrondi1(cache * 100),
  };
}

/** Le moteur expose-t-il au moins une des métriques que son profil attend ? */
export function metriquesReconnues(profil: ProfilMoteur, texte: string | null | undefined): boolean {
  const attendus = new Set(Object.values(profil.metriques).filter((v): v is string => typeof v === "string"));
  return lireEchantillons(texte).some((e) => attendus.has(e.nom));
}
