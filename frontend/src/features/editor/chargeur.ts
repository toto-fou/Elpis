// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/chargeur.ts — chargement à la demande de Monaco (chunk séparé), partagé par l'éditeur et le Studio. */
import type { Monaco } from "./monaco";

let enCours: Promise<Monaco> | null = null;

/** Importe le chunk Monaco une fois ; un échec purge la mémoïsation pour permettre un nouvel essai. */
export function chargerMonaco(): Promise<Monaco> {
  enCours ??= import("./monaco")
    .then((m) => m.installerMonaco())
    .catch((err: unknown) => {
      enCours = null;
      throw err;
    });
  return enCours;
}
