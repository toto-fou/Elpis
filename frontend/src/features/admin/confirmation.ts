// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/confirmation.ts — confirmation d'une action irréversible par la saisie d'un mot. */
import type { CtxAdmin } from "./types";

/** Demande de taper le mot ; sans dialogue de saisie dans l'hôte, la confirmation simple en danger. */
export function confirmerParMot(
  ctx: Pick<CtxAdmin, "openConfirm" | "openTypedConfirm">,
  titre: string,
  texte: string,
  mot: string,
  libelle: string,
): Promise<boolean> {
  return ctx.openTypedConfirm
    ? ctx.openTypedConfirm(titre, texte, mot, libelle)
    : ctx.openConfirm(titre, texte, true, libelle);
}
