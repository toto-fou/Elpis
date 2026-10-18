// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/notifications.ts — centre de notifications du compte (`/api/notifications*`). */
import { z } from "zod";

import { entier, horodatage } from "./commun";

export const schemaNotification = z.object({
  id: entier,
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  ref_type: z.string(),
  ref_id: z.union([entier, z.string()]).nullable(),
  read_at: horodatage.nullable(),
  created_at: horodatage,
});
export type Notification = z.infer<typeof schemaNotification>;

export const schemaReponseNotifications = z.object({ items: z.array(schemaNotification), unread: entier });
export type ReponseNotifications = z.infer<typeof schemaReponseNotifications>;
export const schemaReponseNonLues = z.object({ count: entier });
/** Marquage lu/non lu et suppression d'une notification : le compteur restant. */
export const schemaReponseNotificationModifiee = z.object({ ok: z.literal(true), unread: entier });
export const schemaReponseToutLu = z.object({ ok: z.literal(true), marked: entier, unread: z.literal(0) });
export const schemaReponseToutEffacer = z.object({
  ok: z.literal(true),
  cleared: entier,
  unread: z.literal(0),
});
