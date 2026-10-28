// SPDX-License-Identifier: MIT
/** frontend/src/app/racine/domaine.ts — domaines injectés de la racine elle-même : couche commune (toasts, fenêtre, menu contextuel) et cartes de connexion. */
import { inject, provide } from "vue";
import type { InjectionKey } from "vue";

import type { EtatFenetre, MenuContextuel, Toast } from "./chrome";
import type { SurfaceApprobations } from "./approbations";
import type { SurfaceCreds } from "./creds";
import type { SurfaceProcedures } from "./procedures";

export interface DomaineChrome {
  systemAlert: string;
  announcerText: string;
  announcerAssertive: boolean;
  toasts: Toast[];
  removeToast(id: number, avecExpiration?: boolean): void;
  modalState: EtatFenetre;
  modalInputRef: HTMLInputElement | null;
  modalCancelRef: HTMLButtonElement | null;
  modalDialogRef: HTMLElement | null;
  onModalTabKey(e: KeyboardEvent): void;
  handleModalSubmit(): void;
  handleModalChoice(id: string): void;
  modalTypedBlocked(): boolean;
  handleModalCancel(): void;
  contextMenu: MenuContextuel;
  onContextMenuKeydown(e: KeyboardEvent): void;
  handleContextAction(action: string): void;
  /** Sélection multiple de l'explorateur (absente sur la console, qui n'a pas d'éditeur). */
  explorerMultiCount?: (item: unknown) => number;
}

export interface DomaineConnexion {
  user: unknown;
  mustChangePassword: boolean;
  loginConfig: Record<string, unknown>;
  loginForm: { username: string; password: string };
  loginError: string;
  isLoading: boolean;
  newPasswordForce: string;
  login(): unknown;
  submitForcePasswordChange(): unknown;
}

export const CLE_CHROME: InjectionKey<DomaineChrome> = Symbol("elpis:racine:chrome");
export const CLE_CONNEXION: InjectionKey<DomaineConnexion> = Symbol("elpis:racine:connexion");
export const CLE_CREDS: InjectionKey<SurfaceCreds> = Symbol("elpis:racine:creds");
export const CLE_PROCEDURES: InjectionKey<SurfaceProcedures> = Symbol("elpis:racine:procedures");
export const CLE_APPROBATIONS: InjectionKey<SurfaceApprobations> = Symbol("elpis:racine:approbations");

/** Fournit les domaines de la racine depuis son objet (identifiants /creds et accords des procédures seulement si elle les porte : la console n'en a pas) ; à appeler dans le `setup` de la racine. */
export function fournirDomainesRacine(racine: object): void {
  provide(CLE_CHROME, racine as DomaineChrome);
  provide(CLE_CONNEXION, racine as DomaineConnexion);
  if ("creds" in racine) provide(CLE_CREDS, racine.creds as SurfaceCreds);
  if ("procedures" in racine) provide(CLE_PROCEDURES, racine.procedures as SurfaceProcedures);
  if ("approbations" in racine) provide(CLE_APPROBATIONS, racine.approbations as SurfaceApprobations);
}

export function domaineRacine<T>(cle: InjectionKey<T>): T {
  const valeur = inject(cle, null);
  if (valeur === null) throw new Error(`domaine de la racine non fourni : ${String(cle.description)}`);
  return valeur;
}
