// SPDX-License-Identifier: MIT
/** apps/core/src/mode.ts — `APP_MODE` : le process main sert l'application, admin la console ; séparés au montage. */
import type { Journal } from "./journal";

export type ModeApp = "main" | "admin";

/** Absent ou invalide (`full` compris, non porté) ⇒ `main`, jamais `admin` : la console ne s'ouvre pas par oubli. */
export function resoudreModeApp(brut: string | undefined, journal?: Journal): ModeApp {
  const mode = (brut ?? "").trim().toLowerCase();
  if (!mode) return "main";
  if (mode === "main" || mode === "admin") return mode;
  journal?.warn(`APP_MODE='${brut}' invalide ou non pris en charge (main ou admin) — repli sur 'main'`);
  return "main";
}
