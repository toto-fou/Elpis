// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/rag-tester.ts — page RAG, onglet Tester : question, mode, nombre de passages, reclassement, carte des passages et passages que l'assistant recevrait. */
import { computed, ref } from "vue";
import { LIMITE_RECHERCHE_RAG_MAX, MODES_RECHERCHE_RAG, REGLAGE_RAG_CHAT_DEFAUT } from "@elpis/contracts";
import type { ModeRechercheRag } from "@elpis/contracts";

import type { RechercheRag } from "./api";
import { texteEchec } from "./base";
import type { BaseRag } from "./base";
import { celluleDuPassage, cellulesBande, formaterDuree } from "./format";

export const LIBELLES_MODE: Readonly<Record<ModeRechercheRag, string>> = {
  mixte: "Mixte",
  sens: "Par le sens",
  mots: "Mots exacts",
};

/** Cellules d'une bande de la carte : une par passage, regroupées au-delà de `CELLULES_CARTE_MAX`. */
export const CELLULES_CARTE_MAX = 48;

export interface CelluleCarte {
  /** Rang du meilleur passage de la cellule, ou `null` si elle n'en porte aucun. */
  rang: number | null;
  retenu: boolean;
  /** Le rang s'écrit au-dessus de la cellule : passage retenu qui n'a pas de voisin mieux classé (sinon les numéros se recouvrent). */
  etiquette: boolean;
}

export interface LigneCarte {
  documentId: string;
  nom: string;
  cellules: CelluleCarte[];
  passages: number;
}

/** Lignes de la carte « Où se trouvent les passages », dans l'ordre du meilleur rang de chaque document. */
export function lignesCarte(r: RechercheRag): LigneCarte[] {
  return r.map
    .filter((d) => d.hits.length > 0)
    .map((d) => {
      const n = cellulesBande(d.chunk_count, CELLULES_CARTE_MAX);
      const cellules: CelluleCarte[] = Array.from({ length: n }, () => ({
        rang: null,
        retenu: false,
        etiquette: false,
      }));
      for (const h of d.hits) {
        const c = cellules[celluleDuPassage(h.chunk_index, Math.max(d.chunk_count, 1), n)];
        if (c === undefined) continue;
        if (c.rang === null || h.rank < c.rang) {
          c.rang = h.rank;
          c.retenu = h.retained;
        }
      }
      cellules.forEach((c, i) => {
        const voisin = (j: number): number => cellules[j]?.rang ?? Infinity;
        c.etiquette = c.retenu && c.rang !== null && c.rang < Math.min(voisin(i - 1), voisin(i + 1));
      });
      return { documentId: d.document_id, nom: d.document_name, cellules, passages: d.hits.length };
    })
    .sort(
      (a, b) =>
        Math.min(...a.cellules.map((c) => c.rang ?? Infinity)) -
        Math.min(...b.cellules.map((c) => c.rang ?? Infinity)),
    );
}

export function creerTester(base: BaseRag) {
  const requete = ref("");
  const mode = ref<ModeRechercheRag>(REGLAGE_RAG_CHAT_DEFAUT.mode);
  const limite = ref<number>(REGLAGE_RAG_CHAT_DEFAUT.top_k);
  const reclasser = ref(false);
  const chargement = ref(false);
  const resultat = ref<RechercheRag | null>(null);
  const requeteAffichee = ref("");
  const erreur = ref("");
  let sequence = 0;

  const reclassementDispo = computed(() => base.etat.value?.reranker.enabled === true);
  const carte = computed(() => (resultat.value === null ? [] : lignesCarte(resultat.value)));
  const trouves = computed(() => (resultat.value?.map ?? []).reduce((n, d) => n + d.hits.length, 0));
  const resume = computed(() => {
    const r = resultat.value;
    if (r === null) return "";
    const docs = carte.value.length;
    return `${trouves.value} ${trouves.value > 1 ? "passages trouvés" : "passage trouvé"} dans ${docs} ${docs > 1 ? "documents" : "document"} · ${formaterDuree(r.duration_ms)}`;
  });
  const autresDocuments = computed(() =>
    Math.max(0, (base.courante.value?.doc_count ?? 0) - carte.value.length),
  );

  function remiseAZero(): void {
    sequence++;
    resultat.value = null;
    erreur.value = "";
    chargement.value = false;
  }

  function pas(delta: number): void {
    limite.value = Math.max(1, Math.min(LIMITE_RECHERCHE_RAG_MAX, limite.value + delta));
  }

  function choisirMode(m: ModeRechercheRag): void {
    if ((MODES_RECHERCHE_RAG as readonly string[]).includes(m)) mode.value = m;
  }

  async function chercher(): Promise<void> {
    const id = base.selection.value;
    const q = requete.value.trim();
    if (id === null || q === "" || chargement.value) return;
    const mien = ++sequence;
    chargement.value = true;
    erreur.value = "";
    const r = await base.api.rechercher(id, {
      requete: q,
      mode: mode.value,
      limite: limite.value,
      reclasser: reclasser.value && reclassementDispo.value,
    });
    if (mien !== sequence) return;
    chargement.value = false;
    if (!r.ok) {
      erreur.value = texteEchec(r, "La recherche a échoué.");
      resultat.value = null;
      return;
    }
    resultat.value = r.valeur;
    requeteAffichee.value = q;
    base.ctx.announce?.(`${r.valeur.passages.length} passages retenus.`);
  }

  return {
    requete,
    mode,
    limite,
    reclasser,
    chargement,
    resultat,
    requeteAffichee,
    erreur,
    reclassementDispo,
    carte,
    trouves,
    resume,
    autresDocuments,
    remiseAZero,
    pas,
    choisirMode,
    chercher,
  };
}

export type SurfaceTester = ReturnType<typeof creerTester>;
