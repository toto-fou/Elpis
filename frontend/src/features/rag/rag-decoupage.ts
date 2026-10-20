// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/rag-decoupage.ts — page RAG, fenêtre « Découpage » d'un document : découpage propre ou hérité, aperçu recalculé (antirebond), redécoupes, passages indexés, application et réindexation. */
import { computed, ref, watch } from "vue";
import { DECOUPAGE_RAG_DEFAUT } from "@elpis/contracts";
import type {
  DecoupageDocumentRag,
  DocumentRag,
  ParamsDecoupageRag,
  PassageListeRag,
} from "@elpis/contracts";

import type { ApercuDecoupageRag } from "./api";
import type { BaseRag } from "./base";
import {
  clePourDocument,
  creerAntirebond,
  decoupageDeDocument,
  empilerRedecoupe,
  erreursParams,
  indexDeBase,
  messageEchecDecoupage,
  normaliserParams,
  paramsDe,
  paramsPourExtension,
  retirerRedecoupe,
} from "./decoupage";
import type { RedecoupeRag } from "./decoupage";
import { inserer, sansAccents } from "./filtres";
import type { SurfaceDocuments } from "./rag-documents";

export const DELAI_APERCU_MS = 400;
export const PAGE_PASSAGES = 50;

export type OngletDecoupage = "apercu" | "indexes";
export type ModeDecoupage = "heriter" | "propre";

/** Redécoupe en cours de saisie : le passage visé (position dans l'aperçu) et les paramètres proposés. */
export interface PanneauRedecoupe {
  position: number;
  index: number;
  params: ParamsDecoupageRag;
}

const APERCU_VIDE: ApercuDecoupageRag = { passages: [], total: 0, tronque: false, avertissements: [] };

export function creerDecoupage(
  base: BaseRag,
  documents: Pick<SurfaceDocuments, "documents" | "appliquerTravail">,
  delaiApercuMs: number = DELAI_APERCU_MS,
) {
  const { api } = base;
  const ouvert = ref(false);
  const doc = ref<DocumentRag | null>(null);
  const collectionId = ref<string | null>(null);
  const lecture = ref(false);
  const onglet = ref<OngletDecoupage>("apercu");
  const mode = ref<ModeDecoupage>("heriter");
  const params = ref<ParamsDecoupageRag>(paramsDe(DECOUPAGE_RAG_DEFAUT));
  const redecoupes = ref<RedecoupeRag[]>([]);
  const panneau = ref<PanneauRedecoupe | null>(null);
  const propreAuDepart = ref(false);
  /** Le découpage propre du document est lu (propriétaire) : tant qu'il ne l'est pas, rien ne s'applique. */
  const decoupageLu = ref(false);
  const cleInitiale = ref("heritage");
  const enCours = ref(false);
  const erreur = ref("");

  const apercu = ref<ApercuDecoupageRag>(APERCU_VIDE);
  const apercuCharge = ref(false);
  const apercuEnCours = ref(false);
  const apercuErreur = ref("");
  const depliesApercu = ref<number[]>([]);

  const indexes = ref<PassageListeRag[]>([]);
  const indexesTotal = ref(0);
  const indexesCharges = ref(false);
  const indexesEnCours = ref(false);
  const indexesErreur = ref("");
  const filtre = ref("");
  const depliesIndexes = ref<number[]>([]);

  let ouvertures = 0;
  let sequenceApercu = 0;
  let sequenceIndexes = 0;
  let peuplement = false;

  const decoupageCollection = computed(() => base.courante.value?.chunking ?? DECOUPAGE_RAG_DEFAUT);
  /** Paramètres que le document recevrait en héritant : la règle de son extension, sinon la base de la collection. */
  const paramsHerites = computed(() => paramsPourExtension(decoupageCollection.value, doc.value?.ext ?? ""));

  const erreursPropres = computed(() => (mode.value === "propre" ? erreursParams(params.value) : {}));
  const valide = computed(() => Object.keys(erreursPropres.value).length === 0);
  const decoupageActuel = computed<DecoupageDocumentRag | null>(() =>
    decoupageDeDocument(mode.value === "propre" ? params.value : null, redecoupes.value),
  );
  const modifie = computed(() => clePourDocument(decoupageActuel.value) !== cleInitiale.value);
  const peutAppliquer = computed(
    () =>
      !lecture.value &&
      decoupageLu.value &&
      valide.value &&
      modifie.value &&
      !enCours.value &&
      base.utilisable.value,
  );
  const peutRevenir = computed(
    () => !lecture.value && propreAuDepart.value && !enCours.value && base.utilisable.value,
  );
  const redecoupe = computed(() => redecoupes.value.length > 0);
  /** Paramètres effectifs du document, pour proposer une redécoupe. */
  const paramsEffectifs = computed(() => (mode.value === "propre" ? params.value : paramsHerites.value));

  /* Aperçu */

  async function calculerApercu(): Promise<void> {
    const id = collectionId.value;
    const d = doc.value;
    if (id === null || d === null || lecture.value) return;
    const mien = ++sequenceApercu;
    apercuEnCours.value = true;
    apercuErreur.value = "";
    const demande = decoupageActuel.value ?? { redecoupes: [] };
    const r = await api.apercuDecoupage(id, d.id, demande);
    if (mien !== sequenceApercu) return;
    apercuEnCours.value = false;
    apercuCharge.value = true;
    if (!r.ok) {
      apercuErreur.value = messageEchecDecoupage(r.code, r.message, "L’aperçu n’a pas pu être calculé.");
      return;
    }
    apercu.value = r.valeur;
    depliesApercu.value = [];
    base.ctx.announce?.(
      r.valeur.total > 1 ? `Aperçu : ${r.valeur.total} passages.` : `Aperçu : ${r.valeur.total} passage.`,
    );
  }

  const antirebond = creerAntirebond(() => void calculerApercu(), delaiApercuMs);

  /** Recalcule l'aperçu après une pause dans la saisie ; une saisie invalide n'interroge pas le serveur. */
  function replanifier(): void {
    antirebond.annuler();
    if (!ouvert.value || lecture.value) return;
    sequenceApercu++;
    if (!valide.value) {
      apercuEnCours.value = false;
      return;
    }
    apercuEnCours.value = true;
    antirebond.planifier();
  }

  watch(
    [mode, params, redecoupes],
    () => {
      if (!peuplement) replanifier();
    },
    { deep: true, flush: "sync" },
  );

  /* Redécoupes */

  function ouvrirRedecoupe(position: number): void {
    const p = apercu.value.passages[position];
    if (p === undefined || p.redecoupe_de !== null || lecture.value) return;
    panneau.value = {
      position,
      index: indexDeBase(apercu.value.passages, position),
      params: { ...paramsEffectifs.value },
    };
  }

  const erreursPanneau = computed(() => (panneau.value === null ? {} : erreursParams(panneau.value.params)));

  function fermerRedecoupe(): boolean {
    if (panneau.value === null) return false;
    panneau.value = null;
    return true;
  }

  function validerRedecoupe(): boolean {
    const p = panneau.value;
    if (p === null || Object.keys(erreursPanneau.value).length > 0) return false;
    redecoupes.value = empilerRedecoupe(redecoupes.value, {
      index: p.index,
      params: normaliserParams(p.params),
    });
    panneau.value = null;
    return true;
  }

  function defaireRedecoupe(position: number): void {
    const p = apercu.value.passages[position];
    if (p === undefined || p.redecoupe_de === null) return;
    redecoupes.value = retirerRedecoupe(redecoupes.value, p.redecoupe_de);
  }

  function annulerRedecoupes(): void {
    panneau.value = null;
    redecoupes.value = [];
  }

  function basculerApercu(position: number): void {
    depliesApercu.value = depliesApercu.value.includes(position)
      ? depliesApercu.value.filter((x) => x !== position)
      : [...depliesApercu.value, position];
  }

  /* Passages indexés */

  async function chargerIndexes(reprise = false): Promise<void> {
    const id = collectionId.value;
    const d = doc.value;
    if (id === null || d === null || indexesEnCours.value) return;
    if (reprise) {
      sequenceIndexes++;
      indexes.value = [];
      indexesTotal.value = 0;
    } else if (indexesCharges.value && indexes.value.length >= indexesTotal.value) return;
    const mien = sequenceIndexes;
    indexesEnCours.value = true;
    indexesErreur.value = "";
    const r = await api.passagesListe(id, d.id, indexes.value.length, PAGE_PASSAGES);
    if (mien !== sequenceIndexes) return;
    indexesEnCours.value = false;
    indexesCharges.value = true;
    if (!r.ok) {
      indexesErreur.value = messageEchecDecoupage(
        r.code,
        r.message,
        "Les passages n’ont pas pu être chargés.",
      );
      return;
    }
    indexes.value = [...indexes.value, ...r.valeur.passages];
    indexesTotal.value = r.valeur.total;
  }

  const indexesVisibles = computed(() => {
    const q = sansAccents(filtre.value.trim());
    if (q === "") return indexes.value;
    return indexes.value.filter((p) => sansAccents(`${p.texte} ${p.section ?? ""}`).includes(q));
  });
  const indexesRestants = computed(() => Math.max(0, indexesTotal.value - indexes.value.length));

  function basculerIndexe(position: number): void {
    depliesIndexes.value = depliesIndexes.value.includes(position)
      ? depliesIndexes.value.filter((x) => x !== position)
      : [...depliesIndexes.value, position];
  }

  function choisirOnglet(o: OngletDecoupage): void {
    if (lecture.value && o === "apercu") return;
    onglet.value = o;
    if (o === "indexes" && !indexesCharges.value) void chargerIndexes();
  }

  /* Ouverture, fermeture, application */

  /** Ouvre la fenêtre ; le propriétaire relit d'abord le découpage propre du document, puis l'aperçu part. */
  async function ouvrir(d: DocumentRag, enLecture = false): Promise<void> {
    const id = base.selection.value;
    if (id === null) return;
    const mienne = ++ouvertures;
    peuplement = true;
    antirebond.annuler();
    sequenceApercu++;
    sequenceIndexes++;
    doc.value = d;
    collectionId.value = id;
    lecture.value = enLecture;
    mode.value = "heriter";
    params.value = { ...paramsHerites.value };
    redecoupes.value = [];
    propreAuDepart.value = false;
    decoupageLu.value = false;
    cleInitiale.value = "heritage";
    panneau.value = null;
    erreur.value = "";
    apercu.value = APERCU_VIDE;
    apercuCharge.value = false;
    apercuErreur.value = "";
    apercuEnCours.value = !enLecture;
    depliesApercu.value = [];
    indexes.value = [];
    indexesTotal.value = 0;
    indexesCharges.value = false;
    indexesEnCours.value = false;
    indexesErreur.value = "";
    filtre.value = "";
    depliesIndexes.value = [];
    enCours.value = false;
    peuplement = false;
    ouvert.value = true;
    onglet.value = enLecture ? "indexes" : "apercu";
    if (enLecture) {
      void chargerIndexes();
      return;
    }
    const r = await api.decoupageDocument(id, d.id);
    if (mienne !== ouvertures) return;
    if (!r.ok) {
      apercuEnCours.value = false;
      erreur.value = messageEchecDecoupage(r.code, r.message, "Le découpage du document n’a pas pu être lu.");
      return;
    }
    const propre = r.valeur;
    peuplement = true;
    mode.value = propre?.params === undefined ? "heriter" : "propre";
    params.value = { ...(propre?.params ?? paramsHerites.value) };
    redecoupes.value = propre?.redecoupes.map((x) => ({ ...x })) ?? [];
    propreAuDepart.value = propre !== null && clePourDocument(propre) !== "heritage";
    cleInitiale.value = clePourDocument(propre);
    decoupageLu.value = true;
    peuplement = false;
    await calculerApercu();
  }

  function fermer(): boolean {
    if (!ouvert.value) return false;
    antirebond.annuler();
    ouvertures++;
    sequenceApercu++;
    sequenceIndexes++;
    ouvert.value = false;
    panneau.value = null;
    doc.value = null;
    return true;
  }

  /** Échap : la saisie d'une redécoupe d'abord, puis la fenêtre ; faux s'il n'y avait rien à fermer. */
  function echap(): boolean {
    if (!ouvert.value) return false;
    return fermerRedecoupe() || fermer();
  }

  /** Écrit le découpage (`null` : celui de la collection) et suit la réindexation par les événements du travail. */
  async function enregistrer(decoupage: DecoupageDocumentRag | null, phrase: string): Promise<boolean> {
    const id = collectionId.value;
    const d = doc.value;
    if (id === null || d === null || enCours.value) return false;
    enCours.value = true;
    erreur.value = "";
    const r = await api.appliquerDecoupage(id, d.id, decoupage);
    enCours.value = false;
    if (!r.ok) {
      erreur.value = messageEchecDecoupage(r.code, r.message, "Le découpage n’a pas pu être appliqué.");
      return false;
    }
    if (base.selection.value === id)
      documents.documents.value = inserer(documents.documents.value, r.valeur.document);
    if (r.valeur.job !== null) documents.appliquerTravail(r.valeur.job);
    base.info(phrase);
    fermer();
    return true;
  }

  async function appliquer(): Promise<boolean> {
    if (!peutAppliquer.value) return false;
    return enregistrer(decoupageActuel.value, "Découpage enregistré, réindexation lancée.");
  }

  async function revenir(): Promise<boolean> {
    if (!peutRevenir.value) return false;
    return enregistrer(null, "Le document suit de nouveau le découpage de la collection.");
  }

  return {
    ouvert,
    doc,
    lecture,
    onglet,
    mode,
    params,
    redecoupes,
    redecoupe,
    panneau,
    erreursPanneau,
    erreursPropres,
    paramsHerites,
    modifie,
    valide,
    peutAppliquer,
    peutRevenir,
    propreAuDepart,
    enCours,
    erreur,
    apercu,
    apercuCharge,
    apercuEnCours,
    apercuErreur,
    depliesApercu,
    indexes,
    indexesTotal,
    indexesCharges,
    indexesEnCours,
    indexesErreur,
    indexesVisibles,
    indexesRestants,
    filtre,
    depliesIndexes,
    ouvrir,
    fermer,
    echap,
    choisirOnglet,
    ouvrirRedecoupe,
    fermerRedecoupe,
    validerRedecoupe,
    defaireRedecoupe,
    annulerRedecoupes,
    basculerApercu,
    basculerIndexe,
    chargerIndexes,
    appliquer,
    revenir,
  };
}

export type SurfaceDecoupage = ReturnType<typeof creerDecoupage>;
