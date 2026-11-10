// SPDX-License-Identifier: MIT
/** frontend/src/features/secrets/gestion.ts — table des secrets d'un propriétaire (Paramètres › Secrets pour le compte, console pour l'instance) : liste, menu ⋯, rotation, vérification, modification, création, suppression confirmée sur place ; domaine injecté dans les composants de la table. */
import type { CorpsCreationSecret, CorpsMajSecret, Secret } from "@elpis/contracts";
import { computed, inject, provide, ref } from "vue";
import type { InjectionKey, UnwrapNestedRefs } from "vue";

import type { ApiSecrets, PorteeCoffre } from "./api";
import { droitsDe, formulaireDe, formulaireModifie, formulaireVide, verdictFormulaire } from "./format";
import type { DroitsSecret, FormulaireSecret, GenreCreable } from "./format";

export type ModePanneau = "rotation" | "verifier" | "modifier";
export type ActionSecret = ModePanneau | "gerer";

/** Sous ce délai, un second clic sur « Supprimer » est un double-clic, pas une confirmation. */
export const GARDE_CONFIRMATION_MS = 400;

export interface DepsGestionSecrets {
  readonly api: ApiSecrets;
  readonly portee: PorteeCoffre;
  readonly toast?: (message: string, type?: string) => void;
  /** Ouvre l'endroit qui gère un secret de connecteur (onglet, panneau ou page). */
  readonly ouvrir?: (cible: string) => unknown;
  /** Avis aux autres vues (menu `/secret`, puces) : la liste a changé. */
  readonly notifier?: () => void;
  readonly maintenant?: () => number;
}

const parNom = (a: Secret, b: Secret): number => a.name.localeCompare(b.name);

export function creerGestionSecrets(dep: DepsGestionSecrets) {
  const maintenant = dep.maintenant ?? ((): number => Date.now());
  const secrets = ref<Secret[]>([]);
  const charge = ref(false);
  const chargement = ref(false);
  const erreurListe = ref("");
  const menu = ref<number | null>(null);
  const panneau = ref<{ id: number; mode: ModePanneau } | null>(null);
  const confirmer = ref<number | null>(null);
  const occupe = ref(false);
  /** Refus du serveur, sous la ligne concernée ou sous le formulaire de création. */
  const erreur = ref<{ cible: number | "nouveau"; message: string } | null>(null);
  const creation = ref<FormulaireSecret | null>(null);
  const edition = ref<FormulaireSecret | null>(null);
  const valeurRotation = ref("");
  let armeA = 0;

  const sale = computed(
    () =>
      valeurRotation.value !== "" || formulaireModifie(creation.value) || formulaireModifie(edition.value),
  );

  const droits = (s: Secret): DroitsSecret => droitsDe(s, dep.portee);

  function retenir(s: Secret): void {
    secrets.value = [...secrets.value.filter((x) => x.id !== s.id), s].sort(parNom);
  }

  function refus(cible: number | "nouveau", message: string, repli: string): void {
    erreur.value = { cible, message: message || repli };
  }

  async function charger(): Promise<void> {
    chargement.value = true;
    try {
      const r = await dep.api.lister(dep.portee);
      if (r.ok) {
        secrets.value = [...r.valeur].sort(parNom);
        erreurListe.value = "";
        charge.value = true;
      } else if (r.message) erreurListe.value = r.message;
    } finally {
      chargement.value = false;
    }
  }

  function basculerMenu(id: number): void {
    menu.value = menu.value === id ? null : id;
    confirmer.value = null;
  }

  function fermerMenu(): void {
    menu.value = null;
    confirmer.value = null;
  }

  function fermerPanneau(): void {
    if (panneau.value && erreur.value?.cible === panneau.value.id) erreur.value = null;
    panneau.value = null;
    edition.value = null;
    valeurRotation.value = "";
  }

  function choisir(id: number, action: ActionSecret): void {
    const s = secrets.value.find((x) => x.id === id);
    fermerMenu();
    if (!s) return;
    const d = droits(s);
    if (action === "gerer") {
      if (d.gere) void dep.ouvrir?.(d.gere.cible);
      return;
    }
    const permis =
      action === "rotation" ? d.rotation : action === "modifier" ? d.modification : d.verification;
    if (!permis) return;
    if (erreur.value?.cible !== "nouveau") erreur.value = null;
    valeurRotation.value = "";
    edition.value = action === "modifier" ? formulaireDe(s) : null;
    panneau.value = { id, mode: action };
  }

  async function tourner(id: number): Promise<void> {
    const valeur = valeurRotation.value;
    if (!valeur || occupe.value) return;
    occupe.value = true;
    try {
      const r = await dep.api.tourner(dep.portee, id, valeur);
      if (!r.ok) return refus(id, r.message, "Rotation refusée.");
      retenir(r.valeur);
      fermerPanneau();
      dep.toast?.(`${r.valeur.name} : version ${r.valeur.version}`, "success");
      dep.notifier?.();
    } finally {
      occupe.value = false;
    }
  }

  async function verifier(id: number): Promise<void> {
    if (occupe.value) return;
    occupe.value = true;
    try {
      const r = await dep.api.verifier(id);
      if (!r.ok) return refus(id, r.message, "Vérification refusée.");
      retenir(r.valeur);
      fermerPanneau();
      dep.toast?.(`${r.valeur.name} : ${r.valeur.state}`, "success");
      dep.notifier?.();
    } finally {
      occupe.value = false;
    }
  }

  /** Création ou modification (seuls les champs changés partent) ; les erreurs de champ restent affichées sans appel. */
  async function enregistrer(f: FormulaireSecret | null): Promise<boolean> {
    if (!f || occupe.value) return false;
    const v = verdictFormulaire(f);
    if (!v.corps) return false;
    const cible = f.id ?? "nouveau";
    if (f.id !== null && Object.keys(v.corps).length === 0) {
      fermerPanneau();
      return true;
    }
    occupe.value = true;
    try {
      const r =
        f.id === null
          ? await dep.api.creer(v.corps as CorpsCreationSecret)
          : await dep.api.modifier(f.id, v.corps as CorpsMajSecret);
      if (!r.ok) {
        refus(cible, r.message, "Enregistrement refusé.");
        return false;
      }
      retenir(r.valeur);
      if (f.id === null) {
        creation.value = null;
        if (erreur.value?.cible === "nouveau") erreur.value = null;
      } else fermerPanneau();
      dep.toast?.(`${r.valeur.name} : enregistré`, "success");
      dep.notifier?.();
      return true;
    } finally {
      occupe.value = false;
    }
  }

  /** Le même bouton arme puis confirme ; un second clic trop rapide (double-clic) ne compte pas. */
  async function clicSupprimer(id: number): Promise<void> {
    if (confirmer.value !== id) {
      confirmer.value = id;
      armeA = maintenant();
      return;
    }
    if (occupe.value || maintenant() - armeA < GARDE_CONFIRMATION_MS) return;
    occupe.value = true;
    try {
      const r = await dep.api.supprimer(dep.portee, id);
      const nom = secrets.value.find((x) => x.id === id)?.name ?? "";
      fermerMenu();
      if (!r.ok) return refus(id, r.message, "Suppression refusée.");
      secrets.value = secrets.value.filter((x) => x.id !== id);
      if (panneau.value?.id === id) fermerPanneau();
      if (erreur.value?.cible === id) erreur.value = null;
      dep.toast?.(`${nom} : supprimé`, "success");
      dep.notifier?.();
    } finally {
      occupe.value = false;
    }
  }

  function annulerSuppression(): void {
    confirmer.value = null;
  }

  function nouveau(kind: GenreCreable = "web-login"): void {
    creation.value = formulaireVide(kind);
    if (erreur.value?.cible === "nouveau") erreur.value = null;
  }

  function annulerCreation(): void {
    creation.value = null;
    if (erreur.value?.cible === "nouveau") erreur.value = null;
  }

  /** Échap : menu, confirmation, panneau puis formulaire de création ; faux s'il n'y avait rien d'ouvert. */
  function fermerCouche(): boolean {
    if (menu.value !== null) fermerMenu();
    else if (confirmer.value !== null) confirmer.value = null;
    else if (panneau.value) fermerPanneau();
    else if (creation.value) annulerCreation();
    else return false;
    return true;
  }

  /** Vue quittée (onglet, page, fenêtre) : rien ne reste ouvert ni saisi. */
  function reinitialiserVue(): void {
    fermerMenu();
    fermerPanneau();
    creation.value = null;
    erreur.value = null;
  }

  return {
    portee: dep.portee,
    secrets,
    charge,
    chargement,
    erreurListe,
    menu,
    panneau,
    confirmer,
    occupe,
    erreur,
    creation,
    edition,
    valeurRotation,
    sale,
    droits,
    charger,
    basculerMenu,
    fermerMenu,
    choisir,
    fermerPanneau,
    tourner,
    verifier,
    enregistrer,
    clicSupprimer,
    annulerSuppression,
    nouveau,
    annulerCreation,
    fermerCouche,
    reinitialiserVue,
  };
}

export type GestionSecrets = ReturnType<typeof creerGestionSecrets>;
/** Domaine vu des gabarits : refs déballées (`reactive`). */
export type DomaineSecrets = UnwrapNestedRefs<GestionSecrets>;

export const CLE_SECRETS: InjectionKey<DomaineSecrets> = Symbol("elpis:secrets");

export function fournirSecrets(g: DomaineSecrets): void {
  provide(CLE_SECRETS, g);
}

/** Lit le domaine fourni par l'onglet ou la page ; son absence est une erreur de montage. */
export function domaineSecrets(): DomaineSecrets {
  const g = inject(CLE_SECRETS, null);
  if (g === null) throw new Error("domaine des secrets non fourni");
  return g;
}
