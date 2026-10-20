// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/rag.ts — page RAG : état partagé (droit RAG, collections, sélection, onglets, menus), événements `rag:*` du chat, flux `rag_job`, assemblage des sous-modules. */
import { computed, getCurrentScope, onScopeDispose, ref, watch } from "vue";
import type { CollectionVueRag, EtatRag } from "@elpis/contracts";

import type { ApiRag } from "./api";
import { texteEchec } from "./base";
import type { BaseRag, CtxRag, OngletRag, RefsRag } from "./base";
import { nomProposeCollection } from "./depot";
import type { FichierADeposer } from "./depot";
import { filtrerCollections } from "./filtres";
import { creerCommandeRag } from "./commande";
import { creerBac } from "./rag-bac";
import { creerDecoupage } from "./rag-decoupage";
import { creerDocuments } from "./rag-documents";
import type { EvenementTravail } from "./rag-documents";
import { creerPublier } from "./rag-publier";
import { creerReglages } from "./rag-reglages";
import { creerTester } from "./rag-tester";
import { creerSources } from "./sources-ui";
import type { MessageSources } from "./sources-ui";

/** Noms des événements `window` échangés avec le chat (contrat L5 / L6 / L7). */
export const EVT_DISCUTER = "rag:discuter";
export const EVT_COLLECTIONS = "rag:collections";
export const EVT_TRAVAIL = "rag:job";

export interface DepRag {
  /** Cible des événements `rag:*` ; `window` par défaut. */
  cible?: EventTarget;
  maintenant?: () => number;
  /** Période de la relecture des travaux actifs quand le flux système est muet (ms). */
  periodeSondageMs?: number;
  /** Pause de saisie avant le recalcul de l'aperçu d'un découpage (ms). */
  delaiApercuMs?: number;
}

const SONDAGE_DEFAUT_MS = 8000;

export function creerRag(api: ApiRag, refs: RefsRag, ctx: CtxRag, dep: DepRag = {}) {
  const cible: EventTarget = dep.cible ?? window;
  const maintenant = dep.maintenant ?? ((): number => Date.now());
  const etat = ref<EtatRag | null>(null);
  const collections = ref<CollectionVueRag[]>([]);
  const chargementListe = ref(false);
  const erreurListe = ref("");
  const listeChargee = ref(false);
  const filtre = ref("");
  const selection = ref<string | null>(null);
  const onglet = ref<OngletRag>("documents");
  const menuOuvert = ref<string | null>(null);
  const masqueesVisibles = ref(false);
  let sondage: ReturnType<typeof setInterval> | null = null;

  const ouverte = computed(() => refs.currentView.value === "rag");
  const autorise = computed(() => etat.value?.allowed === true);
  const utilisable = computed(() => etat.value?.usable === true);
  const courante = computed(() => collections.value.find((c) => c.id === selection.value) ?? null);
  const estProprietaire = computed(() => courante.value?.role === "proprietaire");
  const mes = computed(() => collections.value.filter((c) => c.role === "proprietaire"));
  const partagees = computed(() => collections.value.filter((c) => c.role === "lecteur" && !c.hidden));
  const masquees = computed(() => collections.value.filter((c) => c.role === "lecteur" && c.hidden));
  const mesFiltrees = computed(() => filtrerCollections(mes.value, filtre.value));
  const partageesFiltrees = computed(() => filtrerCollections(partagees.value, filtre.value));
  const masqueesFiltrees = computed(() => filtrerCollections(masquees.value, filtre.value));
  /** Première visite : aucune collection à soi et rien de sélectionné. */
  const premiereVisite = computed(
    () => listeChargee.value && mes.value.length === 0 && courante.value === null,
  );

  const notifierCollections = (): void => {
    cible.dispatchEvent(new CustomEvent(EVT_COLLECTIONS));
  };

  async function rafraichirEtat(): Promise<void> {
    const r = await api.etat();
    if (r.ok) etat.value = r.valeur;
  }

  function remplacerCollection(c: CollectionVueRag): void {
    const i = collections.value.findIndex((x) => x.id === c.id);
    if (i < 0) collections.value = [...collections.value, c];
    else collections.value = collections.value.map((x) => (x.id === c.id ? c : x));
  }

  async function rafraichirCollection(id: string): Promise<boolean> {
    const r = await api.collection(id);
    if (r.ok) {
      remplacerCollection(r.valeur);
      return true;
    }
    if (r.code === "collection_introuvable") {
      retirerLocalement(id);
      return false;
    }
    return collections.value.some((c) => c.id === id);
  }

  function retirerLocalement(id: string): void {
    collections.value = collections.value.filter((c) => c.id !== id);
    if (selection.value === id) selection.value = choixParDefaut();
  }

  /** Collection à montrer quand rien n'est choisi : la première des miennes. */
  function choixParDefaut(): string | null {
    return mes.value[0]?.id ?? null;
  }

  const base: BaseRag = {
    api,
    ctx,
    etat,
    selection,
    courante,
    estProprietaire,
    utilisable,
    onglet,
    remplacerCollection,
    rafraichirCollection,
    rafraichirEtat,
    notifierCollections,
    erreur: (m) => ctx.showToast(m, "error"),
    info: (m) => ctx.showToast(m, "success"),
    maintenant,
  };

  const documents = creerDocuments(base);
  const tester = creerTester(base);
  const publier = creerPublier(base);
  const bac = creerBac(base, documents.accueillirImport);
  const decoupage = creerDecoupage(base, documents, dep.delaiApercuMs);
  const reglages = creerReglages(
    base,
    async () => {
      const id = selection.value;
      if (id !== null) retirerLocalement(id);
      void rafraichirEtat();
      notifierCollections();
      base.info("Collection supprimée.");
    },
    async () => {
      const id = selection.value;
      if (id === null) return;
      await rafraichirCollection(id);
      await documents.charger(id);
      void rafraichirEtat();
    },
  );

  const nouvelle = {
    ouvert: ref(false),
    nom: ref(""),
    description: ref(""),
    erreur: ref(""),
    enCours: ref(false),
    fichiers: ref<FichierADeposer[]>([]),
    /** Action à enchaîner après la création : ouvrir l'import du bac. */
    suite: ref<"import" | null>(null),
  };

  async function chargerCollections(): Promise<void> {
    chargementListe.value = true;
    erreurListe.value = "";
    const r = await api.collections();
    chargementListe.value = false;
    if (!r.ok) {
      erreurListe.value = texteEchec(r, "Les collections n’ont pas pu être chargées.");
      return;
    }
    collections.value = r.valeur;
    listeChargee.value = true;
    if (selection.value !== null && !collections.value.some((c) => c.id === selection.value))
      selection.value = null;
    if (selection.value === null) selection.value = choixParDefaut();
  }

  async function charger(): Promise<void> {
    await Promise.all([rafraichirEtat(), chargerCollections(), documents.chargerTravaux()]);
  }

  function demarrerSondage(): void {
    if (sondage !== null) return;
    sondage = setInterval(() => {
      if (ouverte.value && !document.hidden && documents.travaux.value.length > 0)
        void documents.chargerTravaux();
    }, dep.periodeSondageMs ?? SONDAGE_DEFAUT_MS);
  }

  function arreterSondage(): void {
    if (sondage !== null) clearInterval(sondage);
    sondage = null;
  }

  async function ouvrirPage(ciblee?: string): Promise<void> {
    const avant = selection.value;
    // La visionneuse est un volet du chat : elle ne reste pas ouverte sous la page.
    sources.fermer();
    refs.currentView.value = "rag";
    menuOuvert.value = null;
    demarrerSondage();
    await charger();
    // `/rag open <collection>` : la page s'ouvre sur cette collection, onglet Documents.
    if (ciblee !== undefined && collections.value.some((c) => c.id === ciblee)) {
      onglet.value = "documents";
      selection.value = ciblee;
    }
    // Même collection qu'à la fermeture : le changement de sélection n'a rien relu, les documents ont pu bouger.
    if (selection.value !== null && selection.value === avant) await documents.charger(selection.value);
  }

  const ouvrir = (): Promise<void> => ouvrirPage();
  const ouvrirSur = (id: string): Promise<void> => ouvrirPage(id);

  function fermer(): void {
    decoupage.fermer();
    refs.currentView.value = "chat";
    menuOuvert.value = null;
    arreterSondage();
  }

  function selectionner(id: string): void {
    menuOuvert.value = null;
    if (selection.value === id) return;
    selection.value = id;
  }

  function choisirOnglet(o: OngletRag): void {
    if (o === "reglages" && !estProprietaire.value) return;
    onglet.value = o;
    menuOuvert.value = null;
    if (o === "reglages") reglages.charger(courante.value);
  }

  // Changer de collection remet à zéro les écrans qui lui sont propres, puis charge ses documents.
  watch(
    selection,
    (id) => {
      decoupage.fermer();
      documents.remiseAZero();
      tester.remiseAZero();
      reglages.charger(courante.value);
      if (onglet.value === "reglages" && courante.value?.role !== "proprietaire") onglet.value = "documents";
      if (id !== null) void documents.charger(id);
    },
    { flush: "sync" },
  );

  /* Création */

  function ouvrirNouvelle(fichiers: readonly FichierADeposer[] = [], puisImporter = false): void {
    if (!utilisable.value) return;
    nouvelle.suite.value = puisImporter ? "import" : null;
    nouvelle.nom.value = fichiers.length > 0 ? nomProposeCollection(fichiers) : "";
    nouvelle.description.value = "";
    nouvelle.erreur.value = "";
    nouvelle.fichiers.value = [...fichiers];
    nouvelle.ouvert.value = true;
  }

  async function creerNouvelle(): Promise<boolean> {
    const nom = nouvelle.nom.value.trim();
    if (nom === "" || nouvelle.enCours.value) {
      nouvelle.erreur.value = nom === "" ? "Le nom est obligatoire." : nouvelle.erreur.value;
      return false;
    }
    nouvelle.enCours.value = true;
    nouvelle.erreur.value = "";
    const r = await api.creer(nom, nouvelle.description.value);
    nouvelle.enCours.value = false;
    if (!r.ok) {
      nouvelle.erreur.value =
        r.code === "nom_deja_pris"
          ? "Vous avez déjà une collection de ce nom."
          : r.code === "quota_collections"
            ? "Vous avez atteint le nombre maximal de collections."
            : texteEchec(r, "La collection n’a pas pu être créée.");
      return false;
    }
    nouvelle.ouvert.value = false;
    remplacerCollection(r.valeur);
    onglet.value = "documents";
    selection.value = r.valeur.id;
    notifierCollections();
    void rafraichirEtat();
    const fichiers = nouvelle.fichiers.value;
    nouvelle.fichiers.value = [];
    if (nouvelle.suite.value === "import") void bac.ouvrir();
    if (fichiers.length > 0) await documents.deposer(fichiers, r.valeur.id);
    return true;
  }

  /* Collections partagées */

  async function masquer(c: CollectionVueRag, hidden: boolean): Promise<void> {
    const r = await api.masquer(c.id, hidden);
    if (!r.ok) {
      base.erreur(texteEchec(r, "L’action a échoué."));
      return;
    }
    remplacerCollection(r.valeur);
    if (hidden && selection.value === c.id) selection.value = choixParDefaut();
    notifierCollections();
  }

  /** « Discuter avec » : l'événement est tout ce que la page fait, le chat (L6) ouvre un chat neuf. */
  function discuter(c: CollectionVueRag | null = courante.value): void {
    if (c === null) return;
    cible.dispatchEvent(new CustomEvent(EVT_DISCUTER, { detail: { id: c.id, name: c.name } }));
  }

  /* Dialogues, menus, Échap */

  const dialogueOuvert = computed(
    () => publier.ouvert.value || nouvelle.ouvert.value || bac.ouvert.value || decoupage.ouvert.value,
  );

  function fermerNouvelle(): boolean {
    if (!nouvelle.ouvert.value) return false;
    nouvelle.ouvert.value = false;
    nouvelle.fichiers.value = [];
    return true;
  }

  /** Ferme le dialogue du dessus ; vrai s'il y en avait un. */
  function fermerDialogue(): boolean {
    return publier.fermer() || bac.fermer() || decoupage.echap() || fermerNouvelle();
  }

  /** Échap sur la page : un menu ouvert d'abord ; faux si la page peut se fermer. */
  function echapPage(): boolean {
    if (menuOuvert.value === null) return false;
    menuOuvert.value = null;
    return true;
  }

  function basculerMenu(id: string): void {
    menuOuvert.value = menuOuvert.value === id ? null : id;
  }

  /* Sources d'une réponse, commande /rag */

  const chat = (): ReturnType<NonNullable<CtxRag["chatPourRag"]>> => ctx.chatPourRag?.() ?? null;
  const sources = creerSources({
    api,
    fetchAuth: (url, init, soft) => ctx.fetchAuth?.(url, init, soft) ?? Promise.resolve(null),
    messages: () => (refs.messages?.value ?? []) as readonly MessageSources[],
    collections: () => chat()?.ragChat.accessibles.value ?? [],
    ragActif: () => (chat()?.ragChat.selection.value.length ?? 0) > 0,
    fermerEditeur: () => ctx.fermerEditeur?.(),
    annoncer: (message) => ctx.announce?.(message),
  });
  const commande = creerCommandeRag({
    api,
    chat,
    ouvrirPage: (id) => (id === undefined ? ouvrir() : ouvrirSur(id)),
    enGeneration: () => ctx.enGeneration?.() ?? false,
    notifierCollections,
    maintenant,
  });
  // Une autre conversation n'a pas les sources de la précédente.
  if (refs.currentChatId) watch(refs.currentChatId, () => sources.fermer());

  /* Flux système et déconnexion */

  const surEvenement = (e: Event): void => {
    const d = (e as CustomEvent<EvenementTravail>).detail;
    if (d !== undefined && d !== null && typeof d === "object" && "job" in d) documents.surTravail(d);
  };
  cible.addEventListener(EVT_TRAVAIL, surEvenement);

  function reinitialiser(): void {
    arreterSondage();
    etat.value = null;
    collections.value = [];
    listeChargee.value = false;
    selection.value = null;
    onglet.value = "documents";
    filtre.value = "";
    menuOuvert.value = null;
    masqueesVisibles.value = false;
    documents.travaux.value = [];
    decoupage.fermer();
    fermerDialogue();
    sources.fermer();
  }

  let idCompte: unknown = null;
  watch(
    refs.user,
    (u) => {
      const id = u === null || typeof u !== "object" ? null : ((u as { id?: unknown }).id ?? "?");
      if (id === idCompte) return;
      idCompte = id;
      reinitialiser();
      if (id !== null) void rafraichirEtat();
    },
    { immediate: true },
  );

  function liberer(): void {
    cible.removeEventListener(EVT_TRAVAIL, surEvenement);
    arreterSondage();
  }
  if (getCurrentScope() !== undefined) onScopeDispose(liberer);

  return {
    etat,
    autorise,
    utilisable,
    ouverte,
    collections,
    chargementListe,
    erreurListe,
    listeChargee,
    filtre,
    mes,
    partagees,
    masquees,
    mesFiltrees,
    partageesFiltrees,
    masqueesFiltrees,
    masqueesVisibles,
    selection,
    courante,
    estProprietaire,
    premiereVisite,
    onglet,
    menuOuvert,
    documents,
    tester,
    reglages,
    publier,
    bac,
    decoupage,
    nouvelle,
    dialogueOuvert,
    sources,
    commande,
    ouvrir,
    ouvrirSur,
    fermer,
    selectionner,
    choisirOnglet,
    ouvrirNouvelle,
    creerNouvelle,
    fermerNouvelle,
    masquer,
    discuter,
    fermerDialogue,
    echapPage,
    basculerMenu,
    rafraichirEtat,
    charger,
    reinitialiser,
    liberer,
  };
}

export type SurfaceRag = ReturnType<typeof creerRag>;
