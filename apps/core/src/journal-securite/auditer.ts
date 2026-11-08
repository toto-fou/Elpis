// SPDX-License-Identifier: MIT
/** apps/core/src/journal-securite/auditer.ts — journal de sécurité d'une requête : compte et IP du client (X-Forwarded-For lu de droite à gauche, mandataires de confiance sautés), refus répétés agrégés par source et route, lectures d'un admin dédupliquées à part. */
import { ipDuClient } from "@elpis/auth";
import type { MotifRefus } from "@elpis/auth";
import { auditEvent, auditLecture, auditRafale, texteBorne } from "@elpis/securite";
import type { IssueAudit } from "@elpis/securite";
import type { FastifyInstance, FastifyRequest } from "fastify";

const SANS_ROUTE = "(no route)";
const signales = new WeakSet<FastifyRequest>();

/** IP du client (`ipDuClient`, mandataires de `ACCESS_LOG_TRUSTED_PROXIES`) : `req.ip` et chaque entrée de X-Forwarded-For validées, jamais une valeur non vérifiée. */
export function ipDeRequete(req: FastifyRequest): string {
  return ipDuClient(req);
}

export interface OptionsAuditRequete {
  issue?: IssueAudit;
  /** Compte à inscrire quand la requête n'en porte pas encore (connexion, déconnexion). */
  userId?: number | null;
  username?: string | null;
}

/** Une ligne du journal de sécurité pour la requête : compte de la session (ou celui donné) et IP du client. */
export function auditerRequete(
  req: FastifyRequest,
  action: string,
  details: Record<string, unknown> = {},
  o: OptionsAuditRequete = {},
): void {
  auditEvent({
    userId: o.userId !== undefined ? o.userId : (req.utilisateur?.id ?? null),
    username: o.username !== undefined ? o.username : (req.utilisateur?.username ?? null),
    action,
    details,
    ip: ipDeRequete(req),
    ...(o.issue ? { outcome: o.issue } : {}),
  });
}

/** Lecture du journal par un admin (recherche, page après page) : première tout de suite, suivantes de même `cle` comptées dans la minute, hors des quotas des refus. */
export function auditerLecture(
  req: FastifyRequest,
  action: string,
  cle: string,
  details: Record<string, unknown> = {},
): void {
  const ip = ipDeRequete(req);
  const uid = req.utilisateur?.id ?? null;
  auditLecture(`${ip}|${uid ?? "-"}|${cle}`, {
    userId: uid,
    username: req.utilisateur?.username ?? null,
    action,
    ip,
    details,
  });
}

/** Refus qui peut arriver en rafale : première occurrence tout de suite, suivantes résumées par minute (par action, IP, compte, méthode et motif de route). */
export function auditerRefus(
  req: FastifyRequest,
  action: string,
  details: Record<string, unknown> = {},
): void {
  const ip = ipDeRequete(req);
  const motif = (req.routeOptions as { url?: string } | undefined)?.url;
  const route = motif ?? SANS_ROUTE;
  const uid = req.utilisateur?.id ?? null;
  signales.add(req);
  auditRafale(`${ip}|${uid ?? "-"}|${req.method}|${route}`, {
    userId: uid,
    username: req.utilisateur?.username ?? null,
    action,
    outcome: "failure",
    ip,
    details: {
      method: req.method,
      route,
      ...(motif === undefined ? { path: texteBorne(req.url.split("?")[0] ?? "", 200) } : {}),
      ...details,
    },
  });
}

/** Tout 403 rendu sans refus déjà signalé (contrôles faits dans les traitements) : `auth.forbidden`, agrégé comme les autres refus. */
export function installerRefusGeneriques(app: FastifyInstance): void {
  app.addHook("onResponse", async (req, rep) => {
    if (rep.statusCode === 403 && !signales.has(req)) auditerRefus(req, "auth.forbidden", { status: 403 });
  });
}

/** `DependancesAuth.signalerRefus` du core : `auth.csrf.denied`, `auth.role.denied`, `auth.loopback.denied`, `auth.internal.denied`, `auth.service.denied`. */
export function signalerRefusAuth(
  req: FastifyRequest,
  motif: MotifRefus,
  details: Record<string, unknown>,
): void {
  auditerRefus(req, `auth.${motif}.denied`, details);
}
