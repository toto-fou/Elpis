// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/rag-bac.ts — page RAG, « Importer depuis la sandbox » : sélecteur des fichiers du bac acceptés par le RAG, import par lots de 500 chemins. */
import { CHEMINS_PAR_IMPORT_RAG_MAX, EXTENSIONS_RAG } from "@elpis/contracts";
import type { NoeudArbre, ResultatDepotRag, TravailRag } from "@elpis/contracts";
import { computed, ref, shallowRef } from "vue";

import type { BaseRag } from "./base";
import { extensionDe } from "./depot";
import { accorder, formaterTaille } from "./format";

export interface LigneBac {
  chemin: string;
  nom: string;
  dossier: boolean;
  profondeur: number;
  ouvert: boolean;
  /** Fichiers acceptés sous ce dossier (ou 1 pour un fichier). */
  fichiers: number;
  etat: "aucun" | "partiel" | "tous";
  taille: string;
}

const ADMIS = new Set<string>(EXTENSIONS_RAG);

export function estAdmis(chemin: string): boolean {
  return ADMIS.has(extensionDe(chemin));
}

/** Chemins des fichiers acceptés sous un nœud (le nœud lui-même s'il est un fichier accepté). */
export function fichiersAdmis(n: NoeudArbre): string[] {
  if (n.type === "file") return estAdmis(n.path) ? [n.path] : [];
  return (n.children ?? []).flatMap(fichiersAdmis);
}

function sansAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Lignes visibles : arbre déplié à la demande, ou liste à plat des fichiers dont le chemin contient le texte. */
export function lignesBac(
  arbre: readonly NoeudArbre[],
  ouverts: ReadonlySet<string>,
  selection: ReadonlySet<string>,
  texte: string,
): LigneBac[] {
  const q = sansAccents(texte.trim());
  const sortie: LigneBac[] = [];
  const etat = (admis: string[]): LigneBac["etat"] => {
    const n = admis.filter((p) => selection.has(p)).length;
    return n === 0 ? "aucun" : n === admis.length ? "tous" : "partiel";
  };
  if (q !== "") {
    const tous = arbre.flatMap((n) => fichiersAdmis(n));
    for (const chemin of tous.filter((p) => sansAccents(p).includes(q))) {
      sortie.push({
        chemin,
        nom: chemin,
        dossier: false,
        profondeur: 0,
        ouvert: false,
        fichiers: 1,
        etat: etat([chemin]),
        taille: "",
      });
    }
    return sortie;
  }
  const visiter = (liste: readonly NoeudArbre[], profondeur: number): void => {
    for (const n of liste) {
      const admis = fichiersAdmis(n);
      if (admis.length === 0) continue;
      const dossier = n.type === "folder";
      const ouvert = dossier && ouverts.has(n.path);
      sortie.push({
        chemin: n.path,
        nom: n.name,
        dossier,
        profondeur,
        ouvert,
        fichiers: admis.length,
        etat: etat(admis),
        taille: !dossier && n.size !== undefined ? formaterTaille(n.size) : "",
      });
      if (ouvert) visiter(n.children ?? [], profondeur + 1);
    }
  };
  visiter(arbre, 0);
  return sortie;
}

function trouver(arbre: readonly NoeudArbre[], chemin: string): NoeudArbre | null {
  for (const n of arbre) {
    if (n.path === chemin) return n;
    const dedans = trouver(n.children ?? [], chemin);
    if (dedans !== null) return dedans;
  }
  return null;
}

export function creerBac(
  base: BaseRag,
  accueillir: (id: string, r: ResultatDepotRag[], job: TravailRag | null, erreur: string) => void,
) {
  const ouvert = ref(false);
  const chargement = ref(false);
  const erreur = ref("");
  const arbre = shallowRef<NoeudArbre[]>([]);
  const tronque = ref(false);
  const filtre = ref("");
  const ouverts = ref(new Set<string>());
  const selection = ref(new Set<string>());
  const enCours = ref(false);

  const lignes = computed(() => lignesBac(arbre.value, ouverts.value, selection.value, filtre.value));
  const nombre = computed(() => selection.value.size);
  const phrase = computed(() =>
    nombre.value === 0
      ? "Aucun fichier choisi"
      : accorder(nombre.value, "fichier choisi", "fichiers choisis"),
  );
  const peutImporter = computed(() => nombre.value > 0 && !enCours.value);

  async function ouvrir(): Promise<void> {
    if (!base.estProprietaire.value) return;
    selection.value = new Set();
    ouverts.value = new Set();
    filtre.value = "";
    erreur.value = "";
    ouvert.value = true;
    chargement.value = true;
    const r = await base.api.arbreBac();
    chargement.value = false;
    if (!r.ok) {
      erreur.value = "La sandbox n’est pas accessible pour le moment.";
      arbre.value = [];
      return;
    }
    arbre.value = r.valeur.items;
    tronque.value = r.valeur.truncated;
  }

  function fermer(): boolean {
    if (!ouvert.value) return false;
    ouvert.value = false;
    return true;
  }

  function deplier(chemin: string): void {
    const s = new Set(ouverts.value);
    if (!s.delete(chemin)) s.add(chemin);
    ouverts.value = s;
  }

  /** Coche ou décoche un fichier, ou tous les fichiers acceptés d'un dossier. */
  function basculer(chemin: string): void {
    const noeud = trouver(arbre.value, chemin);
    const admis = noeud !== null ? fichiersAdmis(noeud) : estAdmis(chemin) ? [chemin] : [];
    const s = new Set(selection.value);
    const tousCoches = admis.length > 0 && admis.every((p) => s.has(p));
    for (const p of admis) {
      if (tousCoches) s.delete(p);
      else s.add(p);
    }
    selection.value = s;
  }

  async function importer(): Promise<boolean> {
    const id = base.selection.value;
    if (id === null || !peutImporter.value) return false;
    enCours.value = true;
    erreur.value = "";
    const chemins = [...selection.value];
    const resultats: ResultatDepotRag[] = [];
    let job: TravailRag | null = null;
    let echec = "";
    for (let i = 0; i < chemins.length; i += CHEMINS_PAR_IMPORT_RAG_MAX) {
      const r = await base.api.importerBac(id, chemins.slice(i, i + CHEMINS_PAR_IMPORT_RAG_MAX));
      if (!r.ok) {
        echec =
          r.code === "sandbox_indisponible"
            ? "La sandbox n’est pas accessible pour le moment."
            : r.message !== ""
              ? r.message
              : "L’import a échoué.";
        break;
      }
      resultats.push(...r.valeur.results);
      job = r.valeur.job ?? job;
    }
    enCours.value = false;
    if (echec !== "" && resultats.length === 0) {
      erreur.value = echec;
      return false;
    }
    ouvert.value = false;
    accueillir(id, resultats, job, echec);
    await base.rafraichirCollection(id);
    void base.rafraichirEtat();
    return echec === "";
  }

  return {
    ouvert,
    chargement,
    erreur,
    arbre,
    tronque,
    filtre,
    ouverts,
    selection,
    enCours,
    lignes,
    nombre,
    phrase,
    peutImporter,
    ouvrir,
    fermer,
    deplier,
    basculer,
    importer,
  };
}

export type SurfaceBac = ReturnType<typeof creerBac>;
