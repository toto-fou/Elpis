// SPDX-License-Identifier: MIT
/** apps/core/src/familles.ts — familles de routes du core, dans l'ordre d'enregistrement. */
import { creerFamilleInterface } from "./familles/interface";
import { familleSysteme } from "./familles/systeme";
import type { ModeApp } from "./mode";
import type { Famille } from "./routes";

export function famillesParDefaut(mode: ModeApp): readonly Famille[] {
  return [familleSysteme, creerFamilleInterface(mode)];
}
