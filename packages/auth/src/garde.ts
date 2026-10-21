// SPDX-License-Identifier: MIT
/** packages/auth/src/garde.ts — require_user_id, rôles, et gardes d'accès du socle (session, staff, admin, loopback, service, interne). */

import { HttpError, intPy, stripPy, veritePy } from "@elpis/commun";
import type { AttributsCookie } from "@elpis/config";
import type { Executeur } from "@elpis/db";
import { egauxEnTempsConstant, jetonInterne } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import { estLocalDirect } from "./local";
import { estRevoquee } from "./revocations";
import { fluxEncoreValide, validerSession } from "./session";
import type { DependancesSession, LigneUtilisateur, Session } from "./session";

declare module "fastify" {
  interface FastifyRequest {
    session: Session;
    sessionInitialeVide: boolean;
    utilisateur?: { id: number; username: string | null };
    identiteToolhost?: { userId: number; username: string };
  }
}

export interface DependancesAuth {
  base: Executeur;
  config(): unknown;
  attributsCookie(): AttributsCookie;
  secret(): string;
  jetonService(): string;
  maintenant?(): number;
}

export const CHEMINS_SI_MOT_DE_PASSE_A_CHANGER = new Set([
  "/api/users/change-password",
  "/api/me-lite",
  "/api/logout-lite",
]);

export function maintenant(dep: DependancesAuth): number {
  return dep.maintenant ? dep.maintenant() : Date.now() / 1000;
}

export async function ligneUtilisateur(x: Executeur, uid: number): Promise<LigneUtilisateur | undefined> {
  return x.get<LigneUtilisateur>("SELECT * FROM users WHERE id=?", [uid]);
}

/** Portes de session branchées sur la base de `dep` (lecture du compte, révocation par `_sid`). */
export function dependancesSession(dep: DependancesAuth): DependancesSession {
  return {
    config: () => dep.config(),
    utilisateur: (uid) => ligneUtilisateur(dep.base, uid),
    revoquee: (sid) => estRevoquee(dep.base, sid),
    maintenant: () => maintenant(dep),
  };
}

/** Chemin comparé à la liste blanche : motif de la route, jamais un `%2F` décodé que le routeur n'a pas vu. */
function chemin(requete: FastifyRequest): string {
  const motif = (requete.routeOptions as { url?: string } | undefined)?.url;
  if (motif !== undefined) return motif;
  const brut = requete.url.split("?")[0] ?? "";
  try {
    return /%2f/iu.test(brut) ? brut : decodeURIComponent(brut);
  } catch {
    return brut;
  }
}

/** `require_user_id` : identité du toolhost d'abord, puis session valide ; 403 si le mot de passe doit changer. */
export async function exigerUtilisateur(requete: FastifyRequest, dep: DependancesAuth): Promise<number> {
  const th = requete.identiteToolhost;
  if (th) {
    requete.utilisateur = { id: th.userId, username: th.username };
    return th.userId;
  }
  const brut = requete.session.get("user_id");
  if (!veritePy(brut)) throw new HttpError(401, "not logged in");
  let uid: number;
  try {
    uid = intPy(brut);
  } catch {
    requete.session.vider();
    throw new HttpError(401, "not logged in");
  }
  const v = await validerSession(requete.session, uid, dependancesSession(dep));
  if (!v.valide) throw new HttpError(401, "session revoked or expired");
  const ligne = v.ligne;
  requete.utilisateur = { id: uid, username: ligne?.username ?? null };
  if (veritePy(ligne?.must_change_pwd) && !CHEMINS_SI_MOT_DE_PASSE_A_CHANGER.has(chemin(requete))) {
    throw new HttpError(403, "must_change_password");
  }
  return uid;
}

/** `stream_session_still_valid` sur la base : compte supprimé = flux coupé, panne transitoire = flux gardé. */
export function revaliderFlux(
  dep: DependancesAuth,
  uid: number,
  loginTs: unknown,
  sid: unknown,
): Promise<boolean> {
  return fluxEncoreValide(uid, loginTs, sid, {
    config: () => dep.config(),
    revoquee: (s) => estRevoquee(dep.base, s),
    maintenant: () => maintenant(dep),
    sessionMinTs: async (id) => {
      const r = await dep.base.get<{ m: number | null }>(
        "SELECT session_min_ts AS m FROM users WHERE id = ?",
        [id],
      );
      return r === undefined ? undefined : (r.m ?? null);
    },
  });
}

/** `_require_admin` / `_require_staff` / `_require_admin_or_mod` : rôle relu en base (`is_admin` : 1 admin, 2 modérateur). */
export async function exigerRole(
  requete: FastifyRequest,
  dep: DependancesAuth,
  roles: readonly number[],
  message: string,
): Promise<number> {
  const uid = await exigerUtilisateur(requete, dep);
  const moi = await ligneUtilisateur(dep.base, uid);
  if (!moi || !roles.includes(Number(moi.is_admin))) throw new HttpError(403, message);
  return uid;
}

/** `Authorization: Bearer <jeton>` comparé à temps constant (`hmac.compare_digest`). */
function bearerAccepte(requete: FastifyRequest, jeton: string): boolean {
  const auth = stripPy(String(requete.headers.authorization ?? ""));
  const recu = Buffer.from(stripPy(auth.slice(7)));
  const attendu = Buffer.from(jeton);
  return auth.toLowerCase().startsWith("bearer ") && egauxEnTempsConstant(recu, attendu);
}

/** `require_service_token` : Bearer égal au jeton de service (503 s'il n'y en a pas, 401 sinon). */
export function exigerJetonService(requete: FastifyRequest, jeton: string): void {
  if (!jeton) throw new HttpError(503, "aucun jeton de service configuré");
  if (!bearerAccepte(requete, jeton))
    throw new HttpError(401, "jeton de service requis", { "WWW-Authenticate": "Bearer" });
}

/** Canal main ↔ admin : boucle locale directe (403 sinon) ET Bearer égal au jeton interne (401 sinon, 503 sans secret). */
export function exigerJetonInterne(requete: FastifyRequest, jeton: string): void {
  if (!estLocalDirect(requete.socket.remoteAddress, requete.headers)) {
    requete.log.warn(
      `[interne] ${requete.method} ${requete.url} refusée depuis ${String(requete.socket.remoteAddress)}`,
    );
    throw new HttpError(403, "Endpoint restricted to loopback");
  }
  if (!jeton) throw new HttpError(503, "aucun jeton interne configuré");
  if (!bearerAccepte(requete, jeton))
    throw new HttpError(401, "jeton interne requis", { "WWW-Authenticate": "Bearer" });
}

export type GardeAuth = (requete: FastifyRequest, reponse: FastifyReply) => Promise<void>;

export function creerGardes(
  dep: DependancesAuth,
): Readonly<Record<"session" | "staff" | "admin" | "loopback" | "service" | "interne", GardeAuth>> {
  return {
    session: async (r) => {
      await exigerUtilisateur(r, dep);
    },
    staff: async (r) => {
      await exigerRole(r, dep, [1, 2], "Staff required");
    },
    admin: async (r) => {
      await exigerRole(r, dep, [1], "Admin required");
    },
    loopback: async (r) => {
      if (!estLocalDirect(r.socket.remoteAddress, r.headers)) {
        r.log.warn(`[loopback] ${r.method} ${r.url} refusée depuis ${String(r.socket.remoteAddress)}`);
        throw new HttpError(403, "Endpoint restricted to loopback");
      }
    },
    service: async (r) => {
      exigerJetonService(r, dep.jetonService());
    },
    interne: async (r) => {
      exigerJetonInterne(r, jetonInterne(dep.secret()));
    },
  };
}
