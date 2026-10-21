// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/registre.ts — familles portées en TS que l'hôte sert lui-même quand `toolhost.json › families` les nomme. */
import { familleBrowser } from "./browser";
import { familleDesktop } from "./desktop";
import { familleFs } from "./fs/famille";
import { familleGit } from "./git/famille";
import type { FabriqueNative } from "./natives";
import { familleOffice } from "./office/famille";
import { familleShell } from "./shell/outil";
import { familleSkillRun } from "./skill-run/outil";

export const FABRIQUES_NATIVES: Readonly<Record<string, FabriqueNative>> = {
  browser: familleBrowser,
  desktop: familleDesktop,
  fs: familleFs,
  git: familleGit,
  office: familleOffice,
  shell: familleShell,
  skill_run: familleSkillRun,
};
