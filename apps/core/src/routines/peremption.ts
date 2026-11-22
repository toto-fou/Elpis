// SPDX-License-Identifier: MIT
/** apps/core/src/routines/peremption.ts — routine sautée faute de vérification récente du compte : raison du run et notification unique au propriétaire. */
import type { Base } from "@elpis/db";

import { pousserNotification } from "../notifications/envoi";

export const RAISON_PEREMPTION = "compte à reconnecter";
export const GENRE_PEREMPTION = "account_recheck";

/** Notifie le propriétaire une seule fois tant que la précédente n'est pas lue ; vrai si une notification vient d'être créée. */
export async function signalerPeremption(base: Base, uid: number): Promise<boolean> {
  const l = await base.valeurs<[number]>(
    "SELECT COUNT(*) FROM notifications WHERE owner_user_id=? AND kind=? AND read_at IS NULL",
    [uid, GENRE_PEREMPTION],
  );
  if (Number(l[0]?.[0] ?? 0) > 0) return false;
  const id = await pousserNotification(base, uid, GENRE_PEREMPTION, "Reconnexion nécessaire", {
    body: "Vos routines automatiques sont en pause : reconnectez-vous pour les reprendre. Sinon, demandez à votre administrateur.",
  });
  return id !== null;
}
