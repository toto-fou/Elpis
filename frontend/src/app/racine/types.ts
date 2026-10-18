// SPDX-License-Identifier: MIT
/** frontend/src/app/racine/types.ts — modules montés par la racine (surfaces typées), présents ou non selon la page. */
import type { setupAuth } from "../../features/auth/auth";
import type { setupChat } from "../../features/chat/coeur/chat";
import type { SurfaceAdmin } from "../../features/admin/console";
import type { setupAdminRuns } from "../../features/admin/executions";
import type { setupAdminSkins } from "../../features/admin/skins";
import type { SurfaceCode } from "../../features/code/code";
import type { SurfaceEditeur } from "../../features/editor/editeur";
import type { SurfaceMascotte } from "../../features/mascotte/mascotte";
import type { SurfaceReglages } from "../../features/reglages/reglages";
import type { SurfaceRoutines } from "../../features/routines/routines";
import type { SurfaceSkills } from "../../features/skills/skills";
import type { SurfaceAutomatisationStudio } from "../../features/studio/automatisation";
import type { SurfaceDialogueStudio } from "../../features/studio/dialogue";
import type { SurfaceMenuStudio } from "../../features/studio/menu";

export type ModuleAuth = ReturnType<typeof setupAuth>;
export type ModuleChat = ReturnType<typeof setupChat>;
export type ModuleSkinsAdmin = ReturnType<typeof setupAdminSkins>;
export type ModuleExecutions = ReturnType<typeof setupAdminRuns>;

/** Modules de la page : null quand la page ne les monte pas (console) ou que leur montage a échoué. */
export interface Modules {
  auth: ModuleAuth | null;
  chat: ModuleChat | null;
  editeur: SurfaceEditeur | null;
  admin: SurfaceAdmin | null;
  adminSkins: ModuleSkinsAdmin | null;
  adminRuns: ModuleExecutions | null;
  reglages: SurfaceReglages | null;
  skills: SurfaceSkills | null;
  routines: SurfaceRoutines | null;
  studio: SurfaceMenuStudio | null;
  studioChat: SurfaceDialogueStudio | null;
  studioAuto: SurfaceAutomatisationStudio | null;
  code: SurfaceCode | null;
  mascotte: SurfaceMascotte | null;
}
