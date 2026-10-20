// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/base.ts — page RAG : socle commun des sous-modules (API, contexte, collection courante, avis aux autres écrans). */
import type { ComputedRef, Ref } from "vue";
import type { CollectionVueRag, EtatRag } from "@elpis/contracts";

import type { ApiRag, ResultatRag } from "./api";
import type { ChatPourRag } from "./commande";

/** Ce que la page lit de la racine du chat. */
export interface RefsRag {
  currentView: Ref<string>;
  user: Ref<unknown>;
  /** Fil du chat courant et son identifiant : sources, visionneuse (absents des tests de la page). */
  messages?: Ref<readonly unknown[]>;
  currentChatId?: Ref<string | null>;
}

/** Ce que la page demande à la racine : toasts, confirmations, annonces d'accessibilité. */
export interface CtxRag {
  showToast(message: string, type?: string): void;
  openConfirm(titre: string, texte: string, danger?: boolean, libelle?: string): Promise<boolean>;
  openTypedConfirm(titre: string, texte: string, mot: string, libelle?: string): Promise<boolean>;
  announce?(message: string, assertive?: boolean): void;
  /** Pages rendues de la visionneuse (octets, avec la session). */
  fetchAuth?(url: string, init?: RequestInit, soft?: boolean): Promise<Response | null>;
  /** Le chat monte avant le RAG : ses collections actives, ses pièces jointes et son fil, lus à l'appel. */
  chatPourRag?(): ChatPourRag | null;
  fermerEditeur?(): void;
  enGeneration?(): boolean;
}

export type OngletRag = "documents" | "tester" | "reglages";

export interface BaseRag {
  readonly api: ApiRag;
  readonly ctx: CtxRag;
  readonly etat: Ref<EtatRag | null>;
  readonly selection: Ref<string | null>;
  readonly courante: ComputedRef<CollectionVueRag | null>;
  readonly estProprietaire: ComputedRef<boolean>;
  readonly utilisable: ComputedRef<boolean>;
  readonly onglet: Ref<OngletRag>;
  /** Remplace une collection de la liste (ou l'ajoute) par sa version du serveur. */
  remplacerCollection(c: CollectionVueRag): void;
  /** Relit une collection, la remplace dans la liste ; vrai si elle existe encore. */
  rafraichirCollection(id: string): Promise<boolean>;
  rafraichirEtat(): Promise<void>;
  /** Avis aux menus du chat : une collection a été créée, supprimée, renommée, publiée ou masquée. */
  notifierCollections(): void;
  erreur(message: string): void;
  info(message: string): void;
  maintenant(): number;
}

/** Message d'un échec à montrer à l'utilisateur, jamais vide. */
export function texteEchec<T>(r: Extract<ResultatRag<T>, { ok: false }>, parDefaut: string): string {
  return r.message !== "" ? r.message : parDefaut;
}

/** Une ligne d'un menu déroulant de la page. */
export interface ItemMenuRag {
  id: string;
  libelle: string;
  icone?: string;
  danger?: boolean;
  desactive?: boolean;
  /** Défini : l'item est un choix exclusif (`menuitemradio`), coché si vrai. */
  actif?: boolean;
  separateurAvant?: boolean;
}
