// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/rag-reglages.ts — page RAG, onglet Réglages : nom, description, découpage et règles par extension, OCR (brouillon validé), zone de danger (vider, supprimer après saisie du nom). */
import { computed, reactive, ref } from "vue";
import {
  DECOUPAGE_RAG_DEFAUT,
  DESCRIPTION_COLLECTION_RAG_MAX,
  EXTENSIONS_RAG,
  NOM_COLLECTION_RAG_MAX,
} from "@elpis/contracts";
import type { CollectionVueRag, ParamsDecoupageRag } from "@elpis/contracts";

import type { CorpsMajCollection } from "./api";
import { texteEchec } from "./base";
import type { BaseRag } from "./base";
import {
  clePourCollection,
  decoupageDeBrouillon,
  erreursParams,
  erreursRegles,
  normaliserParams,
  paramsDe,
  reglesDe,
} from "./decoupage";
import type { ErreursParams, RegleExtension } from "./decoupage";

export interface BrouillonReglages {
  name: string;
  description: string;
  ocr: boolean;
  decoupage: ParamsDecoupageRag;
  regles: RegleExtension[];
}

export interface ErreursReglages {
  name?: string;
  description?: string;
  decoupage: ErreursParams;
  /** Erreur de l'extension d'une règle, par clé de ligne. */
  regles: Record<number, string>;
  /** Erreurs des valeurs d'une règle, par clé de ligne. */
  reglesParams: Record<number, ErreursParams>;
}

let derniereCle = 0;
const cleSuivante = (): number => ++derniereCle;

export function brouillonDe(c: CollectionVueRag): BrouillonReglages {
  const d = c.chunking;
  return {
    name: c.name,
    description: c.description,
    ocr: c.ocr,
    decoupage: paramsDe(d),
    regles: reglesDe(d, cleSuivante),
  };
}

/** Erreurs de saisie par champ ; `aDesErreurs` dit si le brouillon est enregistrable. */
export function erreursBrouillon(b: BrouillonReglages): ErreursReglages {
  const e: ErreursReglages = {
    decoupage: erreursParams(b.decoupage),
    regles: erreursRegles(b.regles),
    reglesParams: {},
  };
  const nom = b.name.trim();
  if (nom === "") e.name = "Le nom est obligatoire.";
  else if (nom.length > NOM_COLLECTION_RAG_MAX) e.name = `${NOM_COLLECTION_RAG_MAX} caractères au plus.`;
  if (b.description.length > DESCRIPTION_COLLECTION_RAG_MAX)
    e.description = `${DESCRIPTION_COLLECTION_RAG_MAX} caractères au plus.`;
  for (const r of b.regles) {
    const p = erreursParams(r.params);
    if (Object.keys(p).length > 0) e.reglesParams[r.cle] = p;
  }
  return e;
}

export function aDesErreurs(e: ErreursReglages): boolean {
  return (
    e.name !== undefined ||
    e.description !== undefined ||
    Object.keys(e.decoupage).length > 0 ||
    Object.keys(e.regles).length > 0 ||
    Object.keys(e.reglesParams).length > 0
  );
}

/** Corps du PATCH : seulement ce qui a changé par rapport à la collection ; vide si rien n'a bougé. */
export function corpsDifference(b: BrouillonReglages, c: CollectionVueRag): CorpsMajCollection {
  const corps: CorpsMajCollection = {};
  if (b.name.trim() !== c.name) corps.name = b.name.trim();
  if (b.description !== c.description) corps.description = b.description;
  if (b.ocr !== c.ocr) corps.ocr = b.ocr;
  const voulu = decoupageDeBrouillon(b.decoupage, b.regles);
  if (clePourCollection(voulu) !== clePourCollection(c.chunking)) corps.chunking = voulu;
  return corps;
}

const REFUS_NOM = "Vous avez déjà une collection de ce nom.";

export function creerReglages(
  base: BaseRag,
  apresSuppression: () => Promise<void>,
  apresVidage: () => Promise<void>,
) {
  const brouillon = reactive<BrouillonReglages>({
    name: "",
    description: "",
    ocr: false,
    decoupage: paramsDe(DECOUPAGE_RAG_DEFAUT),
    regles: [],
  });
  const enCours = ref(false);
  const erreur = ref("");

  const erreurs = computed(() => erreursBrouillon(brouillon));
  const corps = computed(() =>
    base.courante.value === null ? {} : corpsDifference(brouillon, base.courante.value),
  );
  const modifie = computed(() => Object.keys(corps.value).length > 0);
  const enregistrable = computed(() => modifie.value && !aDesErreurs(erreurs.value) && !enCours.value);
  const ocrDispo = computed(() => base.etat.value?.extractor.ocr !== false);

  function charger(c: CollectionVueRag | null): void {
    if (c !== null) Object.assign(brouillon, brouillonDe(c));
    erreur.value = "";
  }

  /** Nouvelle règle : le premier type de fichier sans règle, avec le découpage de base comme point de départ. */
  function ajouterRegle(): number {
    const cle = cleSuivante();
    const prises = brouillon.regles.map((r) => r.ext);
    const ext = EXTENSIONS_RAG.find((e) => !prises.includes(e)) ?? "";
    brouillon.regles.push({ cle, ext, params: normaliserParams(brouillon.decoupage) });
    return cle;
  }

  function retirerRegle(cle: number): void {
    brouillon.regles = brouillon.regles.filter((r) => r.cle !== cle);
  }

  async function enregistrer(): Promise<boolean> {
    const c = base.courante.value;
    if (c === null || !enregistrable.value) return false;
    if (corps.value.chunking !== undefined && c.doc_count > 0) {
      const ok = await base.ctx.openConfirm(
        "Réindexer les documents ?",
        "Le découpage change : les documents concernés seront réindexés. La recherche reste disponible pendant l’opération.",
        false,
        "Enregistrer et réindexer",
      );
      if (!ok) return false;
    }
    enCours.value = true;
    erreur.value = "";
    const r = await base.api.maj(c.id, corps.value);
    enCours.value = false;
    if (!r.ok) {
      erreur.value =
        r.code === "nom_deja_pris" ? REFUS_NOM : texteEchec(r, "Les réglages n’ont pas pu être enregistrés.");
      return false;
    }
    base.remplacerCollection(r.valeur.collection);
    charger(r.valeur.collection);
    base.notifierCollections();
    base.info(r.valeur.job === null ? "Réglages enregistrés." : "Réglages enregistrés, réindexation lancée.");
    return true;
  }

  function annuler(): void {
    charger(base.courante.value);
  }

  async function vider(): Promise<void> {
    const c = base.courante.value;
    if (c === null) return;
    const ok = await base.ctx.openConfirm(
      "Vider la collection ?",
      `Tous les documents de « ${c.name} » seront supprimés. La collection, sa description et sa publication restent.`,
      true,
      "Vider",
    );
    if (!ok) return;
    const r = await base.api.vider(c.id);
    if (!r.ok) {
      base.erreur(texteEchec(r, "La collection n’a pas pu être vidée."));
      return;
    }
    base.info(r.valeur.deleted === 1 ? "1 document supprimé." : `${r.valeur.deleted} documents supprimés.`);
    await apresVidage();
  }

  async function supprimer(): Promise<void> {
    const c = base.courante.value;
    if (c === null) return;
    const ok = await base.ctx.openTypedConfirm(
      "Supprimer la collection ?",
      `La collection « ${c.name} », ses documents et leur indexation seront supprimés définitivement. Saisissez son nom pour confirmer.`,
      c.name,
      "Supprimer",
    );
    if (!ok) return;
    const r = await base.api.supprimer(c.id);
    if (!r.ok) {
      base.erreur(texteEchec(r, "La collection n’a pas pu être supprimée."));
      return;
    }
    await apresSuppression();
  }

  return {
    brouillon,
    enCours,
    erreur,
    erreurs,
    modifie,
    enregistrable,
    ocrDispo,
    charger,
    ajouterRegle,
    retirerRegle,
    enregistrer,
    annuler,
    vider,
    supprimer,
  };
}

export type SurfaceReglages = ReturnType<typeof creerReglages>;
