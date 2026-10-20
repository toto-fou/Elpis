// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/rag-publier.ts — page RAG, boîte « Publier » : visibilité, groupes du compte (« Tous les comptes » pour un admin), ouverture des sources, refus du serveur en clair. */
import { computed, ref } from "vue";
import type { VisibiliteRag } from "@elpis/contracts";

import type { GroupesPublication } from "./api";
import type { BaseRag } from "./base";
import {
  basculerGroupe,
  choixInchange,
  choixInitial,
  corpsPublication,
  messageRefusPublication,
  phraseComptes,
  validerChoix,
} from "./publication";
import type { ChoixPublication } from "./publication";

export function creerPublier(base: BaseRag) {
  const ouvert = ref(false);
  const choix = ref<ChoixPublication>({ visibility: "private", groupIds: [], allowSourceOpen: false });
  const groupes = ref<GroupesPublication>({ groups: [], can_publish_all: false, accounts: 0 });
  const chargement = ref(false);
  const enCours = ref(false);
  const erreur = ref("");

  const peutPublierTous = computed(() => groupes.value.can_publish_all);
  const phrase = computed(() => phraseComptes(choix.value, groupes.value.groups, groupes.value.accounts));
  const invalide = computed(() => validerChoix(choix.value, groupes.value.groups, peutPublierTous.value));
  const inchange = computed(() =>
    base.courante.value === null ? true : choixInchange(choix.value, base.courante.value),
  );
  const bouton = computed(() => (choix.value.visibility === "private" ? "Rendre privée" : "Publier"));
  const peutConfirmer = computed(
    () => !chargement.value && !enCours.value && invalide.value === null && !inchange.value,
  );

  async function ouvrir(): Promise<void> {
    const c = base.courante.value;
    if (c === null || !base.estProprietaire.value) return;
    choix.value = choixInitial(c);
    erreur.value = "";
    ouvert.value = true;
    chargement.value = true;
    const r = await base.api.groupesPublication();
    chargement.value = false;
    if (!r.ok) {
      erreur.value = r.message !== "" ? r.message : "Les groupes n’ont pas pu être chargés.";
      return;
    }
    groupes.value = r.valeur;
  }

  function fermer(): boolean {
    if (!ouvert.value) return false;
    ouvert.value = false;
    return true;
  }

  function choisir(v: VisibiliteRag): void {
    choix.value = { ...choix.value, visibility: v };
    erreur.value = "";
  }

  function basculer(id: number): void {
    choix.value = { ...choix.value, groupIds: basculerGroupe(choix.value.groupIds, id) };
    erreur.value = "";
  }

  function ouvrirSources(v: boolean): void {
    choix.value = { ...choix.value, allowSourceOpen: v };
  }

  async function confirmer(): Promise<boolean> {
    const c = base.courante.value;
    if (c === null || !peutConfirmer.value) return false;
    enCours.value = true;
    erreur.value = "";
    const r = await base.api.publier(c.id, corpsPublication(choix.value));
    enCours.value = false;
    if (!r.ok) {
      erreur.value = messageRefusPublication(r.code, r.message !== "" ? r.message : null);
      return false;
    }
    base.remplacerCollection(r.valeur.collection);
    ouvert.value = false;
    base.notifierCollections();
    base.info(
      r.valeur.collection.visibility === "private" ? "Collection rendue privée." : "Collection publiée.",
    );
    return true;
  }

  return {
    ouvert,
    choix,
    groupes,
    chargement,
    enCours,
    erreur,
    peutPublierTous,
    phrase,
    invalide,
    inchange,
    bouton,
    peutConfirmer,
    ouvrir,
    fermer,
    choisir,
    basculer,
    ouvrirSources,
    confirmer,
  };
}

export type SurfacePublier = ReturnType<typeof creerPublier>;
