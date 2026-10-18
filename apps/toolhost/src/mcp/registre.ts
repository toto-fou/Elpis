// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/registre.ts — familles portées en TS que l'hôte sait servir lui-même (`toolhost.json › familles_natives`). */
import { familleBrowser } from "./browser";
import { familleDesktop } from "./desktop";
import { familleFs } from "./fs/famille";
import { familleGit } from "./git/famille";
import type { FabriqueNative } from "./natives";
import { familleShell } from "./shell/outil";
import { familleSkillRun } from "./skill-run/outil";

export const FABRIQUES_NATIVES: Readonly<Record<string, FabriqueNative>> = {
  browser: familleBrowser,
  desktop: familleDesktop,
  fs: familleFs,
  git: familleGit,
  shell: familleShell,
  skill_run: familleSkillRun,
};
