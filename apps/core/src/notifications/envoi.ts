// SPDX-License-Identifier: MIT
/** apps/core/src/notifications/envoi.ts — émission d'une notification : persistance puis événement live enrichi, sans jamais faire échouer l'appelant (shared_infra/notifications/push.py). */
import { intPy, prefixePy } from "@elpis/commun";
import type { Base } from "@elpis/db";

import { journal } from "../journal";
import { countUnread, createNotification } from "./stockage";

const log = journal("notif");

/** Corps borné dans l'événement live (le corps complet reste en base). */
export const LIVE_BODY_MAX = 280;

/** Publication sur le bus d'événements du process (`publish_event`) ; message `{type: "notification", data}`. */
export type PublierNotification = (message: Record<string, unknown>) => void | Promise<void>;

let publication: PublierNotification | null = null;

/** Branché au démarrage de main (bus système) ; absent, aucune notification live n'est émise. */
export function installerPublicationNotifications(publier: PublierNotification | null): void {
  publication = publier;
}

export interface OptionsNotification {
  readonly body?: string;
  readonly refType?: string;
  readonly refId?: number | string | null;
  /** Faux : persistance seule, sans événement live. */
  readonly live?: boolean;
}

/** `push_notification` : crée la notification puis pousse l'événement live ; rend son id, `null` si la création a échoué. */
export async function pousserNotification(
  base: Base,
  ownerUserId: number,
  kind: string,
  title: string,
  options: OptionsNotification = {},
): Promise<number | null> {
  const { body = "", refType = "", refId = null, live = true } = options;
  let nid: number;
  try {
    nid = await createNotification(base, ownerUserId, kind, title, body, refType, refId);
  } catch (e) {
    log.debug({ err: e }, `[notif] create_notification a échoué (uid=${ownerUserId} kind=${kind})`);
    return null;
  }
  if (live) await publierLive(base, ownerUserId, nid, kind, title, body, refType, refId);
  return nid;
}

async function publierLive(
  base: Base,
  ownerUserId: number,
  nid: number,
  kind: string,
  title: string,
  body: string,
  refType: string,
  refId: number | string | null,
): Promise<void> {
  const publier = publication;
  if (publier === null) {
    log.debug(
      `[notif] bus d'événements non branché : événement live non émis (uid=${ownerUserId} kind=${kind})`,
    );
    return;
  }
  try {
    await publier({
      type: "notification",
      data: {
        user_id: intPy(ownerUserId),
        id: nid,
        kind,
        title: prefixePy(title || "", 300),
        body: prefixePy(body || "", LIVE_BODY_MAX),
        ref_type: refType || "",
        ref_id: refId,
        unread: await countUnread(base, ownerUserId),
      },
    });
  } catch (e) {
    log.debug({ err: e }, `[notif] push live a échoué (uid=${ownerUserId} kind=${kind})`);
  }
}
