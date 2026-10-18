// SPDX-License-Identifier: MIT
/** apps/core/src/evenements/routes.ts — `/api/system-events` (main et admin) et canal interne de main (`/api/internal/events`, `/status`). */
import { exigerUtilisateur, ligneUtilisateur, revaliderFlux } from "@elpis/auth";
import type { DependancesAuth, LigneUtilisateur } from "@elpis/auth";
import type { FastifyRequest } from "fastify";

import type { Journal } from "../journal";
import { LIVE_BODY_MAX } from "../notifications/envoi";
import type { DefinitionRoute, Famille } from "../routes";
import { servirCanal } from "./canal";
import type { CanalInterne } from "./canal";
import type { PipelineEvents } from "./pipeline";
import type { EmpreinteDemarrage } from "./redemarrage";
import { applySessionRevocation } from "./revocation";
import type { CiblesRevocation } from "./revocation";
import { servirFluxSse } from "./sse";
import type { Message, SystemEvents, VerifierSession } from "./systeme";
import { HttpError } from "@elpis/commun";
import { corpsJson } from "@elpis/http";

/** Identité du flux, lue après la garde `session` : compte, staff (`is_admin` 1 ou 2), revalidation périodique. */
export interface IdentiteFlux {
  readonly uid: number;
  readonly staff: boolean;
  readonly encoreValide?: VerifierSession;
}

export type ResoudreIdentite = (requete: FastifyRequest) => IdentiteFlux | Promise<IdentiteFlux>;

function estStaff(ligne: LigneUtilisateur | undefined): boolean {
  return ligne !== undefined && [1, 2].includes(Number(ligne.is_admin));
}

/** `api_system_events` : compte vérifié par la garde, staff relu en base ; revalidation `stream_session_still_valid`, rôle staff compris. */
export function identiteDeSession(dep: DependancesAuth): ResoudreIdentite {
  return async (requete) => {
    const uid = requete.utilisateur?.id ?? (await exigerUtilisateur(requete, dep));
    const staff = estStaff(await ligneUtilisateur(dep.base, uid));
    const loginTs = requete.session.get("_login_ts");
    const sid = requete.session.get("_sid");
    return {
      uid,
      staff,
      encoreValide: async () => {
        if (!(await revaliderFlux(dep, uid, loginTs, sid))) return false;
        return !staff || estStaff(await ligneUtilisateur(dep.base, uid));
      },
    };
  };
}

/** Événements de contrôle appliqués par main, jamais poussés aux navigateurs (`CONTROL_TYPES`). */
export const TYPES_CONTROLE: ReadonlySet<string> = new Set(["session_revoked", "model_cache_refresh"]);

/** Ce que l'admin peut publier dans main : le contrôle, la bannière de redémarrage et ses notifications, rien d'autre. */
export const TYPES_ADMIN: ReadonlySet<string> = new Set([...TYPES_CONTROLE, "restart", "notification"]);

const NOTIFICATION_INVALIDE = "Événement invalide : notification mal formée.";
const CHAMPS_NOTIFICATION: Readonly<Record<string, (v: unknown) => boolean>> = {
  user_id: (v) => Number.isSafeInteger(v) && (v as number) > 0,
  id: (v) => v === null || Number.isSafeInteger(v),
  kind: (v) => typeof v === "string",
  title: (v) => typeof v === "string" && Array.from(v).length <= 300,
  body: (v) => typeof v === "string" && Array.from(v).length <= LIVE_BODY_MAX,
  ref_type: (v) => typeof v === "string",
  ref_id: (v) => v === null || typeof v === "string" || Number.isSafeInteger(v),
  unread: (v) => Number.isSafeInteger(v) && (v as number) >= 0,
};

/** Notification de `pousserNotification` recopiée champ à champ (destinataire compris), `null` si sa forme diffère. */
export function notificationDeLAdmin(corps: Message): Message | null {
  const data = corps["data"];
  if (Object.keys(corps).some((k) => k !== "type" && k !== "data")) return null;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const champs = data as Record<string, unknown>;
  if (!Object.hasOwn(champs, "user_id")) return null;
  for (const [nom, valeur] of Object.entries(champs)) {
    const valide = Object.hasOwn(CHAMPS_NOTIFICATION, nom) ? CHAMPS_NOTIFICATION[nom] : undefined;
    if (valide === undefined || !valide(valeur)) return null;
  }
  return { type: "notification", data: { ...champs } };
}

export interface ContexteMain {
  readonly canal: CanalInterne;
  readonly empreinte: EmpreinteDemarrage;
  readonly cibles: CiblesRevocation;
  readonly rafraichirModeles?: () => void;
  readonly pingCanalMs?: number;
}

export interface ContexteRoutes {
  readonly systemEvents: SystemEvents;
  readonly pipelineEvents: PipelineEvents;
  readonly identite: ResoudreIdentite;
  readonly arret: AbortSignal;
  readonly journal?: Journal;
  readonly surOuvertureFlux?: () => void;
  readonly pingMs?: number;
  readonly graceArretMs?: number;
  readonly main?: ContexteMain;
}

function entete(requete: FastifyRequest, nom: string): string | undefined {
  const valeur = requete.headers[nom];
  return Array.isArray(valeur) ? valeur[0] : valeur;
}

/** Crochet d'ouverture d'un flux (sonde des modèles) : un échec est journalisé, jamais propagé. */
function signalerOuverture(ctx: ContexteRoutes, chemin: string): void {
  try {
    ctx.surOuvertureFlux?.();
  } catch (e) {
    ctx.journal?.warn({ err: e }, `${chemin} : crochet d'ouverture en échec`);
  }
}

function routesMain(ctx: ContexteRoutes, main: ContexteMain): DefinitionRoute[] {
  return [
    {
      methode: "GET",
      chemin: "/api/internal/events",
      processus: ["main"],
      acces: "interne",
      traiter: (requete, reponse) => {
        signalerOuverture(ctx, "/api/internal/events");
        return servirCanal(reponse, main.canal, entete(requete, "last-event-id"), {
          arret: ctx.arret,
          graceMs: ctx.graceArretMs,
          pingMs: main.pingCanalMs,
          journal: ctx.journal,
        });
      },
    },
    {
      methode: "POST",
      chemin: "/api/internal/events",
      processus: ["main"],
      acces: "interne",
      traiter: async (requete) => {
        const corps = corpsJson(requete);
        const type =
          corps !== null && typeof corps === "object" && !Array.isArray(corps)
            ? (corps as Message)["type"]
            : undefined;
        if (typeof type !== "string" || type === "") {
          throw new HttpError(400, "Événement invalide : champ « type » requis.");
        }
        if (!TYPES_ADMIN.has(type))
          throw new HttpError(400, `Type d'événement refusé sur ce canal : ${type}`);
        const message = corps as Message;
        if (type === "session_revoked") await applySessionRevocation(message, main.cibles);
        else if (type === "model_cache_refresh") main.rafraichirModeles?.();
        else if (type === "notification") {
          const notification = notificationDeLAdmin(message);
          if (notification === null) throw new HttpError(400, NOTIFICATION_INVALIDE);
          ctx.systemEvents.broadcast(notification, { relais: false });
        } else ctx.systemEvents.broadcast(message, { relais: false });
        return { ok: true };
      },
    },
    {
      methode: "GET",
      chemin: "/api/internal/status",
      processus: ["main"],
      acces: "interne",
      traiter: () => main.empreinte.statut(),
    },
  ];
}

/** Routes du bus ; celles du canal interne n'existent que dans main. */
export function familleEvenements(ctx: ContexteRoutes): Famille {
  const flux: DefinitionRoute = {
    methode: "GET",
    chemin: "/api/system-events",
    processus: ["main", "admin"],
    acces: "session",
    traiter: async (requete, reponse) => {
      const identite = await ctx.identite(requete);
      signalerOuverture(ctx, "/api/system-events");
      await servirFluxSse(
        reponse,
        (signal) =>
          ctx.systemEvents.listen({
            isStaff: identite.staff,
            userId: identite.uid,
            validityCheck: identite.encoreValide,
            signal,
          }),
        { pingMs: ctx.pingMs, journal: ctx.journal, arret: ctx.arret, graceMs: ctx.graceArretMs },
      );
    },
  };
  return { nom: "evenements", routes: ctx.main ? [flux, ...routesMain(ctx, ctx.main)] : [flux] };
}
