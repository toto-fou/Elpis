// SPDX-License-Identifier: MIT
/** apps/core/test/ordonnanceur/scenario.ts — rejeu d'un scénario au format des goldens `ordonnanceur_*.json`. */
import { LLMCircuitOpen } from "../../src/llm/ordonnanceur/disjoncteur";
import { LLMQueueAborted } from "../../src/llm/ordonnanceur/file";
import type { LLMQueue, Priorite, Slot } from "../../src/llm/ordonnanceur/file";
import { EchecTransport, fileDeTest } from "./aides";

/** `enfants` (extension TS, absente des goldens) : sous-agents parallèles lancés pendant l'étape, chacun par un `withLLM` imbriqué. */
export type Etape = { generer?: number; outil?: number; echec_transport?: boolean; enfants?: Enfant[] };
export type Enfant = { modele: string; priorite?: Priorite; etapes: Etape[] };
export type Demande = {
  id: string;
  arrivee: number;
  serveur: string;
  modele: string;
  priorite?: Priorite;
  etapes: Etape[];
};
export type PolitiquePy = { max_models?: number; max_concurrency?: number };
export type Entrees = {
  harnais: "ordonnanceur";
  serveurs: Record<string, PolitiquePy>;
  mode?: "classic" | "optimized";
  demandes: Demande[];
  actions?: { a: number; annuler?: string; politique?: Record<string, PolitiquePy> }[];
  instantanes?: number[];
};
export type Instantane = Record<string, string[]>;
export type Sorties = { ordre: string[]; instantanes: Record<string, Instantane> };
/** Appelé après chaque événement du scénario (vérification d'invariants). */
export type Observateur = (q: LLMQueue, t: number, politiques: Record<string, PolitiquePy>) => void;

export const FINS = ["fin", "abandon", "refus_disjoncteur", "echec_transport"];
const CLES = {
  entrees: ["harnais", "serveurs", "mode", "demandes", "actions", "instantanes"],
  demande: ["id", "arrivee", "serveur", "modele", "priorite", "etapes"],
  etape: ["generer", "outil", "echec_transport", "enfants"],
  enfant: ["modele", "priorite", "etapes"],
  action: ["a", "annuler", "politique"],
};

/** Instant au format des goldens : arrondi au millième, écrit comme `%g`. */
export const instant = (t: number): string => String(Math.round(t * 1000) / 1000);

/** Vocabulaire fermé, comme le harnais Python : une clé inconnue est une erreur, jamais une option ignorée. */
export function verifier(entrees: Entrees): void {
  const cles = (quoi: keyof typeof CLES, o: object): void => {
    const inconnues = Object.keys(o).filter((k) => !CLES[quoi].includes(k));
    if (inconnues.length > 0) throw new Error(`${quoi} : clés inconnues ${inconnues.join(", ")}`);
  };
  const etapes = (es: Etape[]): void => {
    for (const e of es) {
      cles("etape", e);
      for (const x of e.enfants ?? []) {
        cles("enfant", x);
        etapes(x.etapes);
      }
    }
  };
  cles("entrees", entrees);
  for (const d of entrees.demandes) {
    cles("demande", d);
    etapes(d.etapes);
  }
  for (const a of entrees.actions ?? []) cles("action", a);
}

type Evenement = { t: number; rang: number; k: number; id: string; ev: string };

function photographier(journal: Evenement[], demandes: Demande[], t: number): Instantane {
  const photo: Record<string, string[]> = { en_attente: [], en_cours: [], en_generation: [], terminees: [] };
  const ranger = (cle: string, id: string): number | undefined => photo[cle]?.push(id);
  for (const d of demandes.filter((x) => x.arrivee <= t)) {
    const ev = journal.filter((e) => e.t <= t && e.id === d.id).map((e) => e.ev);
    const compte = (x: string): number => ev.filter((e) => e === x).length;
    if (ev.some((e) => FINS.includes(e))) ranger("terminees", d.id);
    else if (!ev.includes("admis")) ranger("en_attente", d.id);
    else {
      ranger("en_cours", d.id);
      if (compte("creneau") > compte("rend")) ranger("en_generation", d.id);
    }
  }
  if (photo["en_generation"]?.length === 0) delete photo["en_generation"];
  return photo;
}

/** Même scénario que `tests/llm_core/ordonnanceur_harness.py` : chaque demande passe par `withLLM` (chemin outils). */
export async function rejouer(
  entrees: Entrees,
  observer?: Observateur,
): Promise<Sorties & { finies: Set<string> }> {
  verifier(entrees);
  const politiques = structuredClone(entrees.serveurs);
  const versPolitique = (p: PolitiquePy = {}) => ({
    maxModels: p.max_models ?? 1,
    maxConcurrency: p.max_concurrency ?? 1,
  });
  const { h, q } = fileDeTest(
    {},
    { politique: (s) => versPolitique(politiques[s]), modeConfigure: () => entrees.mode },
  );
  const journal: Evenement[] = [];
  const compteurs = new Map<string, number>();
  const finies = new Set<string>();
  const noter = (d: Demande, ev: string): void => {
    const k = (compteurs.get(d.id) ?? 0) + 1;
    compteurs.set(d.id, k);
    journal.push({ t: h.t, rang: entrees.demandes.indexOf(d), k, id: d.id, ev });
    if (FINS.includes(ev)) finies.add(d.id);
    observer?.(q, h.t, politiques);
  };
  const controleurs = new Map(entrees.demandes.map((d) => [d.id, new AbortController()]));
  const instantanes: Record<string, Instantane> = {};
  const optimise = entrees.mode === "optimized";

  const enfant = (d: Demande, x: Enfant) =>
    q.withLLM(
      x.modele,
      x.priorite ?? "high",
      undefined,
      async (s) => {
        for (const e of x.etapes)
          await (e.outil === undefined ? s.appelLLM(() => generer(e)) : h.attendre(e.outil));
      },
      { moteur: { id: d.serveur, enFile: true }, outils: true },
    );
  const generer = async (e: Etape): Promise<void> => {
    observer?.(q, h.t, politiques);
    await h.attendre(e.generer ?? 0);
  };
  const etape = async (d: Demande, e: Etape, slot: Slot): Promise<void> => {
    if (e.enfants) {
      await Promise.all(e.enfants.map((x) => enfant(d, x)));
      return;
    }
    if (e.outil !== undefined) return h.attendre(e.outil);
    if (e.echec_transport) throw new EchecTransport("serveur injoignable (scénario)");
    await slot.appelLLM(async () => {
      if (optimise) noter(d, "creneau");
      await h.attendre(e.generer ?? 0);
    });
    if (optimise) noter(d, "rend");
  };

  const lancer = async (d: Demande): Promise<void> => {
    const options = { moteur: { id: d.serveur, enFile: true }, outils: true };
    try {
      const signal = controleurs.get(d.id)?.signal;
      await q.withLLM(
        d.modele,
        d.priorite ?? "high",
        signal,
        async (slot) => {
          noter(d, "admis");
          for (const e of d.etapes) await etape(d, e, slot);
        },
        options,
      );
      noter(d, "fin");
    } catch (e) {
      if (e instanceof LLMCircuitOpen) noter(d, "refus_disjoncteur");
      else if (e instanceof LLMQueueAborted) noter(d, "abandon");
      else if (e instanceof EchecTransport) noter(d, "echec_transport");
      else throw e;
    }
  };

  const lancees: Promise<void>[] = [];
  for (const d of entrees.demandes) h.planifier(d.arrivee, () => lancees.push(lancer(d)));
  for (const a of entrees.actions ?? []) {
    h.planifier(a.a, () => {
      if (a.annuler) controleurs.get(a.annuler)?.abort();
      for (const [s, p] of Object.entries(a.politique ?? {})) {
        politiques[s] = { ...politiques[s], ...p };
        q.setPolicy(s, versPolitique(politiques[s]));
      }
    });
  }
  for (const t of entrees.instantanes ?? [])
    h.planifier(t, () => (instantanes[`t=${instant(t)}`] = photographier(journal, entrees.demandes, t)));
  await h.avancer();
  if (finies.size === entrees.demandes.length) await Promise.all(lancees);
  const ordre = journal.sort((a, b) => a.t - b.t || a.rang - b.rang || a.k - b.k);
  return { ordre: ordre.map((e) => `t=${instant(e.t)} ${e.id} ${e.ev}`), instantanes, finies };
}
