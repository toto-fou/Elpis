// SPDX-License-Identifier: MIT
/** frontend/src/features/auth/session.ts — machine d'état de la session, génération et nettoyage des ressources par propriétaire. */
import type { Role } from "@elpis/contracts";

import { journal } from "../../platform/journal";

export interface Compte {
  readonly id: number;
  readonly username: string;
  readonly is_admin: boolean;
  readonly role: Role;
  readonly avatar: string | null;
}

/** Fin de session : `deconnexion` est volontaire, `expiration` subie (401, SSE, cookie échu), `mot_de_passe` un 403 de changement forcé. */
export type RaisonFin = "deconnexion" | "expiration" | "mot_de_passe";

export type EtatSession =
  | { readonly statut: "inconnu"; readonly generation: number }
  | { readonly statut: "deconnecte"; readonly generation: number; readonly raison: RaisonFin | null }
  | { readonly statut: "mot_de_passe_a_changer"; readonly generation: number }
  | { readonly statut: "connecte"; readonly generation: number; readonly compte: Compte };

/** Conséquences d'une fin de session : l'affichage se détache toujours, le run serveur n'est arrêté que sur départ volontaire. */
export function consequencesFin(raison: RaisonFin): {
  readonly detacherAffichage: true;
  readonly arreterRun: boolean;
} {
  return { detacherAffichage: true, arreterRun: raison === "deconnexion" };
}

type Nettoyage = () => void;

export interface Horloge {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

const horlogeGlobale: Horloge = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
};

/** Ressources d'un module (timers, écouteurs, connexions) libérées ensemble, au plus tard à la fin de la génération. */
export class Proprietaire {
  readonly #nettoyages = new Set<Nettoyage>();
  #libere = false;

  readonly nom: string;
  readonly generation: number;
  readonly #horloge: Horloge;
  readonly #auLiberer: (p: Proprietaire) => void;

  constructor(nom: string, generation: number, horloge: Horloge, auLiberer: (p: Proprietaire) => void) {
    this.nom = nom;
    this.generation = generation;
    this.#horloge = horloge;
    this.#auLiberer = auLiberer;
  }

  get actif(): boolean {
    return !this.#libere;
  }

  /** Enregistre un nettoyage ; appelé tout de suite si le propriétaire est déjà libéré. Renvoie de quoi le faire plus tôt. */
  ajouter(fn: Nettoyage): Nettoyage {
    if (this.#libere) {
      fn();
      return () => {};
    }
    let fait = false;
    const unique = (): void => {
      if (fait) return;
      fait = true;
      this.#nettoyages.delete(unique);
      fn();
    };
    this.#nettoyages.add(unique);
    return unique;
  }

  minuterie(fn: () => void, ms: number): Nettoyage {
    if (this.#libere) return () => {};
    let annuler: Nettoyage = () => {};
    const id = this.#horloge.setTimeout(() => {
      annuler();
      fn();
    }, ms);
    annuler = this.ajouter(() => this.#horloge.clearTimeout(id));
    return annuler;
  }

  intervalle(fn: () => void, ms: number): Nettoyage {
    if (this.#libere) return () => {};
    const id = this.#horloge.setInterval(fn, ms);
    return this.ajouter(() => this.#horloge.clearInterval(id));
  }

  ecouter(cible: EventTarget, type: string, fn: EventListener, options?: AddEventListenerOptions): Nettoyage {
    if (this.#libere) return () => {};
    cible.addEventListener(type, fn, options);
    return this.ajouter(() => cible.removeEventListener(type, fn, options));
  }

  liberer(): void {
    if (this.#libere) return;
    this.#libere = true;
    const liste = [...this.#nettoyages];
    this.#nettoyages.clear();
    for (const fn of liste) {
      try {
        fn();
      } catch (e) {
        journal.erreur(`[session] nettoyage de ${this.nom} :`, e);
      }
    }
    this.#auLiberer(this);
  }
}

export type Abonne = (etat: EtatSession, precedent: EtatSession) => void;

/** Session du navigateur : chaque ouverture ou fin incrémente la génération, ce qui périme les réponses et ressources antérieures. */
export class GestionnaireSession {
  #etat: EtatSession = { statut: "inconnu", generation: 0 };
  readonly #abonnes = new Set<Abonne>();
  readonly #proprietaires = new Set<Proprietaire>();

  readonly #horloge: Horloge;

  constructor(horloge: Horloge = horlogeGlobale) {
    this.#horloge = horloge;
  }

  get etat(): EtatSession {
    return this.#etat;
  }

  get generation(): number {
    return this.#etat.generation;
  }

  get compte(): Compte | null {
    return this.#etat.statut === "connecte" ? this.#etat.compte : null;
  }

  estCourante(generation: number): boolean {
    return generation === this.#etat.generation;
  }

  /** Session ouverte pour `compte` ; même compte déjà connecté : génération gardée (requêtes en vol toujours valables). */
  ouvrir(compte: Compte): void {
    const e = this.#etat;
    if (e.statut === "connecte" && e.compte.id === compte.id) {
      this.#poser({ statut: "connecte", generation: e.generation, compte });
      return;
    }
    this.#changerGeneration({ statut: "connecte", generation: e.generation + 1, compte });
  }

  motDePasseAChanger(): boolean {
    if (this.#etat.statut === "mot_de_passe_a_changer") return false;
    this.#changerGeneration({ statut: "mot_de_passe_a_changer", generation: this.#etat.generation + 1 });
    return true;
  }

  /** Aucune session (premier `/api/me-lite`, ou après un refus de connexion) sans fin à traiter. */
  constaterDeconnecte(): void {
    const e = this.#etat;
    if (e.statut === "deconnecte") return;
    if (e.statut === "inconnu") {
      this.#poser({ statut: "deconnecte", generation: e.generation, raison: null });
      return;
    }
    this.#changerGeneration({ statut: "deconnecte", generation: e.generation + 1, raison: null });
  }

  /** Termine la session ; vrai seulement pour l'appel qui a fait la transition (un seul traitement des 401 concurrents). */
  fermer(raison: RaisonFin): boolean {
    const e = this.#etat;
    if (e.statut !== "connecte" && e.statut !== "mot_de_passe_a_changer") return false;
    this.#changerGeneration({ statut: "deconnecte", generation: e.generation + 1, raison });
    return true;
  }

  /** 401 reçu par une requête partie à `generation` : ignoré si la session a déjà changé depuis. */
  signalerExpiration(generation: number): boolean {
    if (!this.estCourante(generation)) return false;
    return this.fermer("expiration");
  }

  surChangement(fn: Abonne): () => void {
    this.#abonnes.add(fn);
    return () => this.#abonnes.delete(fn);
  }

  /** Propriétaire lié à la génération courante : libéré à son terme. */
  proprietaire(nom: string): Proprietaire {
    const p = new Proprietaire(nom, this.#etat.generation, this.#horloge, (x) =>
      this.#proprietaires.delete(x),
    );
    this.#proprietaires.add(p);
    return p;
  }

  #changerGeneration(suivant: EtatSession): void {
    const vieux = [...this.#proprietaires].filter((p) => p.generation !== suivant.generation);
    for (const p of vieux) p.liberer();
    this.#poser(suivant);
  }

  #poser(suivant: EtatSession): void {
    const precedent = this.#etat;
    this.#etat = suivant;
    for (const fn of [...this.#abonnes]) {
      try {
        fn(suivant, precedent);
      } catch (e) {
        journal.erreur("[session] abonné :", e);
      }
    }
  }
}
