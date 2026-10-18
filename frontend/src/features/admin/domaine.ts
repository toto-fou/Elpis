// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/domaine.ts — domaine de la console injecté dans ses composants SFC : surfaces de `setupAdmin`, des skins et des exécutions, plus les clés de la racine historique (app.js) que leurs gabarits lisent. */
import { inject, onMounted, provide } from "vue";
import type { InjectionKey, ShallowUnwrapRef } from "vue";

import { journal } from "../../platform/journal";
import type { ReglagesApp } from "../reglages/types";
import type { SurfaceAdmin } from "./console";
import type { setupAdminRuns } from "./executions";
import type { SurfaceReglages } from "../reglages/reglages";
import type { setupAdminSkins } from "./skins";

/** Clés de la racine (app.js, auth, chat, réglages) lues par les gabarits de la console. */
export interface RacineAdmin {
  user: { username: string; role?: string; avatar?: string | null; [cle: string]: unknown };
  settings: ReglagesApp;
  showSidebar: boolean;
  showNewUserModal: boolean;
  newUserForm: { username: string; password: string; role: string };
  createUserAdmin(): unknown;
  mainAppUrl: string;
  goToMainApp(): unknown;
  logout(): unknown;
  showRunDetails(
    idExecution: number | string,
    ids: (number | string)[],
    options?: { admin?: boolean },
  ): unknown;
  appIconPresets: readonly string[];
}

type Surface<T> = ShallowUnwrapRef<Omit<T, `_${string}`>>;

export type DomaineAdmin = Surface<SurfaceAdmin> &
  Surface<ReturnType<typeof setupAdminSkins>> &
  Surface<ReturnType<typeof setupAdminRuns>> &
  Surface<SurfaceReglages> &
  RacineAdmin;

export const CLE_ADMIN: InjectionKey<DomaineAdmin> = Symbol("elpis:admin");

/** Clés de la racine, complètes à la compilation ; `adminTab` témoigne de la surface de `setupAdmin`. */
const CLES: Readonly<Record<keyof RacineAdmin | "adminTab", true>> = {
  user: true,
  settings: true,
  showSidebar: true,
  showNewUserModal: true,
  newUserForm: true,
  createUserAdmin: true,
  mainAppUrl: true,
  goToMainApp: true,
  logout: true,
  showRunDetails: true,
  appIconPresets: true,
  adminTab: true,
};

/** Lit le domaine fourni par un ancêtre ; son absence est une erreur de montage. */
export function domaineAdmin(): DomaineAdmin {
  const valeur = inject(CLE_ADMIN, null);
  if (valeur === null) throw new Error("domaine de la console non fourni");
  return valeur;
}

export function clesAbsentesAdmin(racine: object): string[] {
  return Object.keys(CLES).filter((k) => !(k in racine));
}

/** Fournit le domaine depuis la racine historique ; à appeler dans son `setup`. */
export function fournirDomaineAdmin(racine: object): void {
  provide(CLE_ADMIN, racine as DomaineAdmin);
  onMounted(() => {
    const absentes = clesAbsentesAdmin(racine);
    if (absentes.length) journal.avertir(`[console] domaine : absent de la racine : ${absentes.join(", ")}`);
  });
}
