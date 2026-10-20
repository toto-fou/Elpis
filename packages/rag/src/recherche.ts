// SPDX-License-Identifier: MIT
/** packages/rag/src/recherche.ts — recherche multi-collections : un embedding, une requête par collection, RRF, quasi-doublons, seuil adaptatif, reclassement, budget de temps. */
import { vecteurRequete } from "./bm25";
import { ErreurRag } from "./erreurs";
import type { ClientEmbeddings } from "./embeddings";
import type { ChargeUtile, ClientQdrant, FiltreRag, PointTrouve, RequeteQdrant } from "./qdrant";
import type { ClientReranker } from "./reranker";

export type ModeRecherche = "mixte" | "sens" | "mots";

/** Collection à interroger ; `meta` est rendue telle quelle dans chaque passage trouvé (auteur, nom, droits…). */
export interface CollectionCible<M = unknown> {
  id: string;
  nomQdrant: string;
  filtre?: FiltreRag | undefined;
  /** Client des embeddings de cette collection (modèle différent de `ParamsRecherche.embeddings`, pendant une migration). */
  embeddings?: ClientEmbeddings | undefined;
  meta?: M;
}

export interface OptionsReclassement {
  client: ClientReranker;
  candidats?: number;
  scoreMin?: number;
}

export interface ParamsRecherche<M = unknown> {
  qdrant: ClientQdrant;
  embeddings?: ClientEmbeddings | undefined;
  collections: readonly CollectionCible<M>[];
  requete: string;
  mode?: ModeRecherche;
  limite?: number;
  /** Filtre commun ; celui d'une collection (`CollectionCible.filtre`) le remplace. */
  filtres?: FiltreRag | undefined;
  budgetMs?: number;
  signal?: AbortSignal | undefined;
  reranker?: OptionsReclassement | undefined;
  /** `false` : désactivé ; sinon filtre à seuil de cosinus (0,88 par défaut). */
  quasiDoublons?: false | { seuil?: number };
  /** Seuil de base du mode `sens` (0,25 par défaut). */
  seuilBase?: number;
  rrfK?: number;
  prefetch?: number;
  garderVecteurs?: boolean;
}

export interface PassageTrouve<M = unknown> {
  collection: CollectionCible<M>;
  idPoint: string;
  /** Position finale, à partir de 1. */
  rang: number;
  /** Score natif dans la collection : cosinus (`sens`), RRF de Qdrant (`mixte`), BM25 (`mots`). */
  score: number;
  /** Score de la fusion entre collections (seulement si plusieurs collections ont répondu). */
  scoreFusion?: number;
  scoreReclassement?: number;
  charge: ChargeUtile;
  vecteur?: number[];
}

export interface ErreurCollection<M = unknown> {
  collection: CollectionCible<M>;
  code: string;
  message: string;
}

export interface ResultatRecherche<M = unknown> {
  /** Mode appliqué (`mixte` devient `mots` si l'embedding de la requête échoue). */
  mode: ModeRecherche;
  passages: PassageTrouve<M>[];
  erreurs: ErreurCollection<M>[];
  avertissements: string[];
  dureeMs: number;
}

const BUDGET_DEFAUT_MS = 10_000;
const LIMITE_DEFAUT = 8;
const LIMITE_MAX = 100;
const CANDIDATS_MIN = 20;
const CANDIDATS_MAX = 100;
const RERANK_CANDIDATS = 30;
const SEUIL_BASE_DEFAUT = 0.25;
const SEUIL_DOUBLON_DEFAUT = 0.88;
const RRF_K_DEFAUT = 60;
const FACTEUR_SEUIL = 0.6;
const ECART_PLAT = 0.05;

/** Seuil des résultats d'un classement par cosinus : `max(base, 0,6 × meilleur)`, sauf si les scores sont groupés (écart meilleur − moyenne < 0,05). */
export function seuilAdaptatif(scores: readonly number[], base: number): number {
  if (scores.length === 0) return base;
  const meilleur = Math.max(...scores);
  const moyenne = scores.reduce((somme, s) => somme + s, 0) / scores.length;
  return meilleur - moyenne < ECART_PLAT ? base : Math.max(base, FACTEUR_SEUIL * meilleur);
}

/** Cosinus de deux vecteurs de même dimension (0 si l'un est nul ou si les dimensions diffèrent). */
export function cosinus(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let ps = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    ps += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : ps / Math.sqrt(na * nb);
}

function frequencesMots(texte: string): Map<string, number> {
  const f = new Map<string, number>();
  for (const m of texte.toLowerCase().matchAll(/[\p{L}\p{N}_]{3,}/gu)) f.set(m[0], (f.get(m[0]) ?? 0) + 1);
  const norme = Math.sqrt([...f.values()].reduce((s, v) => s + v * v, 0)) || 1;
  for (const [k, v] of f) f.set(k, v / norme);
  return f;
}

function cosinusMots(a: Map<string, number>, b: Map<string, number>): number {
  let s = 0;
  for (const [k, v] of a) s += v * (b.get(k) ?? 0);
  return s;
}

/** Retire, dans l'ordre, les passages trop proches d'un passage déjà retenu : cosinus des vecteurs denses, ou des mots si un vecteur manque. */
export function retirerQuasiDoublons<T extends { vecteur?: number[] | undefined; charge: { text: string } }>(
  items: readonly T[],
  seuil = SEUIL_DOUBLON_DEFAUT,
): T[] {
  const gardes: { item: T; mots?: Map<string, number> }[] = [];
  for (const item of items) {
    const mots = (e: { item: T; mots?: Map<string, number> }): Map<string, number> =>
      (e.mots ??= frequencesMots(e.item.charge.text));
    const candidat: { item: T; mots?: Map<string, number> } = { item };
    const doublon = gardes.some((g) => {
      if (item.vecteur && g.item.vecteur?.length === item.vecteur.length)
        return cosinus(item.vecteur, g.item.vecteur) >= seuil;
      return cosinusMots(mots(candidat), mots(g)) >= seuil;
    });
    if (!doublon) gardes.push(candidat);
  }
  return gardes.map((g) => g.item);
}

/** Fusion RRF de plusieurs classements : somme de 1 / (k + rang) par élément ; égalités départagées par le meilleur rang puis l'ordre des listes. */
export function fusionnerRrf<T>(
  listes: readonly (readonly T[])[],
  cle: (t: T) => string,
  k = RRF_K_DEFAUT,
): { item: T; score: number }[] {
  const table = new Map<string, { item: T; score: number; meilleur: number; liste: number }>();
  listes.forEach((liste, l) => {
    liste.forEach((item, i) => {
      const id = cle(item);
      const courant = table.get(id);
      const part = 1 / (k + i + 1);
      if (courant) {
        courant.score += part;
        courant.meilleur = Math.min(courant.meilleur, i);
      } else {
        table.set(id, { item, score: part, meilleur: i, liste: l });
      }
    });
  });
  return [...table.values()]
    .sort((a, b) => b.score - a.score || a.meilleur - b.meilleur || a.liste - b.liste)
    .map(({ item, score }) => ({ item, score }));
}

/** Erreur du budget de temps (signal expiré) rendue en `ErreurRag` « delai » ; les autres erreurs passent telles quelles. */
function normaliser(e: unknown): unknown {
  if (e instanceof ErreurRag) return e;
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return new ErreurRag("delai", "budget de temps de la recherche dépassé");
  }
  return e;
}

function decrire(e: unknown): { code: string; message: string } {
  const n = normaliser(e);
  if (n instanceof ErreurRag) return { code: n.code, message: n.message };
  return { code: "erreur", message: n instanceof Error ? n.message : String(n) };
}

interface PlanCollection<M> {
  collection: CollectionCible<M>;
  mode: ModeRecherche;
  vecteur?: number[];
}

type VecteurOuEchec = { vecteur: number[] } | { echec: unknown };

/** Un vecteur de requête par client d'embeddings distinct (une collection peut avoir le sien, après un changement de modèle). */
async function vecteursDeRequete<M>(
  p: ParamsRecherche<M>,
  requete: string,
  signal: AbortSignal,
): Promise<Map<ClientEmbeddings, VecteurOuEchec>> {
  const clients = new Set<ClientEmbeddings>();
  for (const c of p.collections) {
    const e = c.embeddings ?? p.embeddings;
    if (!e)
      throw new ErreurRag("parametres", `le mode « ${p.mode ?? "mixte"} » exige un client d'embeddings`);
    clients.add(e);
  }
  const sortie = new Map<ClientEmbeddings, VecteurOuEchec>();
  await Promise.all(
    [...clients].map(async (e) => {
      try {
        sortie.set(e, { vecteur: await e.embedderRequete(requete, { signal }) });
      } catch (echec) {
        if (p.signal?.aborted) throw echec;
        sortie.set(e, { echec });
      }
    }),
  );
  return sortie;
}

/** Recherche dans une ou plusieurs collections ; une collection en erreur est signalée dans `erreurs` sans interrompre les autres. */
export async function rechercher<M = unknown>(p: ParamsRecherche<M>): Promise<ResultatRecherche<M>> {
  const debut = performance.now();
  const requete = p.requete.trim();
  const mode = p.mode ?? "mixte";
  const limite = Math.min(LIMITE_MAX, Math.max(1, Math.floor(p.limite ?? LIMITE_DEFAUT)));
  const budget = AbortSignal.timeout(Math.max(1, p.budgetMs ?? BUDGET_DEFAUT_MS));
  const signal = p.signal ? AbortSignal.any([p.signal, budget]) : budget;
  const avertissements: string[] = [];
  const erreurs: ErreurCollection<M>[] = [];
  const termine = (modeAppliquee: ModeRecherche, passages: PassageTrouve<M>[]): ResultatRecherche<M> => ({
    mode: modeAppliquee,
    passages,
    erreurs,
    avertissements,
    dureeMs: Math.round(performance.now() - debut),
  });
  if (requete === "" || p.collections.length === 0) return termine(mode, []);

  const vecteurs =
    mode === "mots"
      ? new Map<ClientEmbeddings, VecteurOuEchec>()
      : await vecteursDeRequete(p, requete, signal);
  const signales = new Set<ClientEmbeddings>();
  const plans: PlanCollection<M>[] = [];
  for (const collection of p.collections) {
    const client = collection.embeddings ?? p.embeddings;
    const obtenu = client ? vecteurs.get(client) : undefined;
    if (mode === "mots") plans.push({ collection, mode });
    else if (obtenu && "vecteur" in obtenu) plans.push({ collection, mode, vecteur: obtenu.vecteur });
    else if (mode === "mixte") {
      plans.push({ collection, mode: "mots" });
      if (client && !signales.has(client)) {
        signales.add(client);
        const motif = decrire(obtenu && "echec" in obtenu ? obtenu.echec : undefined).message;
        avertissements.push(`embeddings indisponibles (${motif}) : recherche par mots seulement`);
      }
    } else {
      erreurs.push({ collection, ...decrire(obtenu && "echec" in obtenu ? obtenu.echec : undefined) });
    }
  }

  const reclassement = p.reranker;
  const reservoir = reclassement ? Math.max(limite, reclassement.candidats ?? RERANK_CANDIDATS) : limite;
  const candidats = Math.min(CANDIDATS_MAX, Math.max(CANDIDATS_MIN, limite * 3, reservoir));
  const doublons = p.quasiDoublons === false ? null : (p.quasiDoublons?.seuil ?? SEUIL_DOUBLON_DEFAUT);
  const creux = vecteurRequete(requete);
  const requeteQdrant = (plan: PlanCollection<M>): RequeteQdrant => {
    if (plan.mode === "mots" || !plan.vecteur) return { mode: "creux", creux };
    return plan.mode === "sens"
      ? { mode: "dense", vecteur: plan.vecteur }
      : { mode: "mixte", vecteur: plan.vecteur, creux };
  };
  const reponses = await Promise.allSettled(
    plans.map((plan) =>
      p.qdrant.interroger(plan.collection.nomQdrant, requeteQdrant(plan), {
        limite: candidats,
        filtre: plan.collection.filtre ?? p.filtres,
        avecVecteur: doublons !== null || p.garderVecteurs === true,
        ...(p.prefetch !== undefined ? { prefetch: p.prefetch } : {}),
        signal,
      }),
    ),
  );
  if (p.signal?.aborted) throw p.signal.reason as unknown;

  const listes: PassageTrouve<M>[][] = [];
  reponses.forEach((r, i) => {
    const plan = plans[i];
    if (!plan) return;
    if (r.status === "rejected") {
      erreurs.push({ collection: plan.collection, ...decrire(r.reason) });
      return;
    }
    const seuil =
      plan.mode === "sens"
        ? seuilAdaptatif(
            r.value.map((x) => x.score),
            p.seuilBase ?? SEUIL_BASE_DEFAUT,
          )
        : -Infinity;
    listes.push(r.value.filter((pt) => pt.score >= seuil).map((pt) => passageDe(plan.collection, pt)));
  });

  const repondantes = listes.filter((l) => l.length > 0);
  let classes: PassageTrouve<M>[] =
    repondantes.length <= 1
      ? repondantes.flat()
      : fusionnerRrf(repondantes, (x) => `${x.collection.id}:${x.idPoint}`, p.rrfK ?? RRF_K_DEFAUT).map(
          ({ item, score }) => ({ ...item, scoreFusion: score }),
        );
  if (doublons !== null) classes = retirerQuasiDoublons(classes, doublons);
  classes = classes.slice(0, reservoir);

  if (reclassement && classes.length >= 2) {
    classes = await reclasser(requete, classes, limite, reclassement, signal, avertissements, p.signal);
  }
  const passages = classes.slice(0, limite).map((x, i) => {
    const { vecteur: v, ...reste } = x;
    return { ...reste, rang: i + 1, ...(p.garderVecteurs && v ? { vecteur: v } : {}) };
  });
  const toutEnMots = plans.length > 0 && plans.every((plan) => plan.mode === "mots");
  return termine(toutEnMots ? "mots" : mode, passages);
}

function passageDe<M>(collection: CollectionCible<M>, pt: PointTrouve): PassageTrouve<M> {
  const sortie: PassageTrouve<M> = {
    collection,
    idPoint: pt.id,
    rang: 0,
    score: pt.score,
    charge: pt.charge,
  };
  if (pt.vecteur) sortie.vecteur = pt.vecteur;
  return sortie;
}

async function reclasser<M>(
  requete: string,
  classes: PassageTrouve<M>[],
  limite: number,
  options: OptionsReclassement,
  signal: AbortSignal,
  avertissements: string[],
  appelant: AbortSignal | undefined,
): Promise<PassageTrouve<M>[]> {
  if (signal.aborted) {
    avertissements.push("budget de temps épuisé : reclassement ignoré");
    return classes;
  }
  try {
    const scores = await options.client.classer(
      requete,
      classes.map((c) => c.charge.text),
      { topN: limite, signal },
    );
    const retenus = scores.filter((s) => options.scoreMin === undefined || s.score >= options.scoreMin);
    if (retenus.length === 0) {
      avertissements.push("reclassement : tous les scores sous le minimum, ordre d'origine gardé");
      return classes;
    }
    return retenus.flatMap((s) => {
      const c = classes[s.index];
      return c ? [{ ...c, scoreReclassement: s.score }] : [];
    });
  } catch (e) {
    if (appelant?.aborted) throw e;
    avertissements.push(`reclassement indisponible (${decrire(e).message}) : ordre d'origine gardé`);
    return classes;
  }
}
