// SPDX-License-Identifier: MIT
/** apps/toolhost/src/bac/interne.ts — routes internes du bac pour la console (hors des préfixes relayés par main : jamais atteintes depuis un navigateur) : mise de côté, remise en place, /work vidé et suppression du bac, et identifiants de sites, d'un compte supprimé. */
import {
  forgetPreviewIp,
  getUserSandbox,
  messageSuppression,
  mettreBacDeCote,
  nomMisDeCote,
  remettreBacMisDeCote,
  resetUserSandboxCache,
  supprimerBacMisDeCote,
  which,
  WORK_SUBDIR,
} from "@elpis/bac";
import { estDict, HttpError, pyJsonLoadsOctets } from "@elpis/commun";
import { config, pyJoin, realpathPy, safeSandboxName } from "@elpis/config";
import { deleteOwnerCredentials } from "@elpis/navigateur";
import { auditEvent, usernameFor } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { DefinitionRoute } from "../app";
import { baseHote } from "../base-hote";
import { reponseJson } from "../socle";
import { uidDe } from "./routes-me";

/** Horodatage de mise de côté posé par la console dans le corps (`stamp`) ; absent : l'heure de l'hôte, sauf si `exige`. */
function horodatageDuCorps(requete: FastifyRequest, exige: boolean): number {
  let corps: unknown;
  if (requete.corpsBrut.length > 0) {
    try {
      corps = pyJsonLoadsOctets(requete.corpsBrut);
    } catch {
      throw new HttpError(400, "corps JSON invalide");
    }
  }
  const brut = estDict(corps) ? corps["stamp"] : undefined;
  if (brut === undefined && !exige) return Date.now();
  if (typeof brut !== "number" || !Number.isSafeInteger(brut) || brut <= 0)
    throw new HttpError(400, "horodatage invalide");
  return brut;
}

/** Conteneur retiré, puis `P` et les instantanés renommés hors de portée des noms de comptes (récupérable par l'administrateur de l'hôte) ; refus → 502 avec la raison. */
async function mettreBacDeCoteDuCompte(
  requete: FastifyRequest,
  reponse: FastifyReply,
): Promise<FastifyReply> {
  const uid = uidDe(requete);
  const username = await usernameFor(uid);
  forgetPreviewIp(uid);
  const racine = realpathPy(config.SANDBOX_DIR);
  const sb = getUserSandbox(uid, username, pyJoin(pyJoin(racine, safeSandboxName(username)), WORK_SUBDIR));
  try {
    await sb.destroy().catch((e: unknown) => {
      throw new HttpError(502, messageSuppression(e));
    });
    const mis = await mettreBacDeCote(
      racine,
      safeSandboxName(username),
      uid,
      horodatageDuCorps(requete, false),
    ).catch((e: unknown) => {
      throw new HttpError(502, messageSuppression(e));
    });
    auditEvent({
      userId: uid,
      username,
      action: "user.sandbox.set_aside",
      details: { container: sb.containerName, renamed: mis.length > 0 },
    });
    return reponseJson(reponse, { ok: true, renamed: mis.length > 0 });
  } finally {
    resetUserSandboxCache(uid);
  }
}

/** `P` et instantanés mis de côté sous l'horodatage remis sous le nom du compte (la suppression en base a échoué) ; refus → 502. */
async function remettreBacDuCompte(requete: FastifyRequest, reponse: FastifyReply): Promise<FastifyReply> {
  const uid = uidDe(requete);
  const username = await usernameFor(uid);
  const stamp = horodatageDuCorps(requete, true);
  await remettreBacMisDeCote(realpathPy(config.SANDBOX_DIR), safeSandboxName(username), uid, stamp).catch(
    (e: unknown) => {
      throw new HttpError(502, messageSuppression(e));
    },
  );
  auditEvent({ userId: uid, username, action: "user.sandbox.restore", details: { stamp } });
  return reponseJson(reponse, { ok: true });
}

/** `P` et instantanés mis de côté sous l'horodatage supprimés, /work vidé par le root du conteneur si l'hôte n'en a pas le droit ; refus → 502 avec la raison. */
async function supprimerBacMisDeCoteDuCompte(
  requete: FastifyRequest,
  reponse: FastifyReply,
): Promise<FastifyReply> {
  const uid = uidDe(requete);
  const username = await usernameFor(uid);
  const stamp = horodatageDuCorps(requete, true);
  const dossier = realpathPy(config.SANDBOX_DIR);
  const sb = getUserSandbox(uid, username, pyJoin(pyJoin(dossier, nomMisDeCote(uid, stamp)), WORK_SUBDIR));
  try {
    const [supprime, erreur] = await supprimerBacMisDeCote(dossier, uid, stamp, () => sb.purge());
    if (erreur !== null) throw new HttpError(502, erreur);
    auditEvent({ userId: uid, username, action: "user.sandbox.discard", details: { deleted: supprime } });
    return reponseJson(reponse, { ok: true, deleted: supprime });
  } finally {
    resetUserSandboxCache(uid);
  }
}

/** /work du bac mis de côté sous l'horodatage vidé par le root du conteneur (fichiers à l'UID du conteneur), conteneur retiré, action de l'admin auditée ; sans docker, rien à faire ; refus → 502. */
async function purgerTravail(requete: FastifyRequest, reponse: FastifyReply): Promise<FastifyReply> {
  const uid = uidDe(requete);
  const username = await usernameFor(uid);
  const stamp = horodatageDuCorps(requete, true);
  const dossier = pyJoin(realpathPy(config.SANDBOX_DIR), nomMisDeCote(uid, stamp));
  const sb = getUserSandbox(uid, username, pyJoin(dossier, WORK_SUBDIR));
  try {
    if (which("docker") === null) return reponseJson(reponse, { ok: true });
    await sb.purge().catch((e: unknown) => {
      throw new HttpError(502, messageSuppression(e));
    });
    auditEvent({
      userId: uid,
      username,
      action: "admin.sandbox.purge_work",
      details: { container: sb.containerName, stamp },
    });
    return reponseJson(reponse, { ok: true });
  } finally {
    resetUserSandboxCache(uid);
  }
}

/** Identifiants de sites du compte de l'enveloppe retirés de la base de l'hôte (distincte de celle du core quand `db_path` est posé). */
async function purgerCompte(requete: FastifyRequest, reponse: FastifyReply): Promise<FastifyReply> {
  const uid = uidDe(requete);
  const username = await usernameFor(uid);
  const base = baseHote();
  if (base === null) throw new HttpError(503, "base de l'hôte indisponible");
  const credentials = await deleteOwnerCredentials(base, username);
  auditEvent({ userId: uid, username, action: "user.toolhost.purge", details: { credentials } });
  return reponseJson(reponse, { ok: true, credentials });
}

export function routesInternes(): DefinitionRoute[] {
  return [
    {
      methode: "POST",
      chemin: "/api/internal/sandbox/set-aside",
      processus: ["toolhost"],
      acces: "enveloppe",
      traiter: mettreBacDeCoteDuCompte,
    },
    {
      methode: "POST",
      chemin: "/api/internal/sandbox/restore",
      processus: ["toolhost"],
      acces: "enveloppe",
      traiter: remettreBacDuCompte,
    },
    {
      methode: "POST",
      chemin: "/api/internal/sandbox/discard",
      processus: ["toolhost"],
      acces: "enveloppe",
      traiter: supprimerBacMisDeCoteDuCompte,
    },
    {
      methode: "POST",
      chemin: "/api/internal/sandbox/purge-work",
      processus: ["toolhost"],
      acces: "enveloppe",
      traiter: purgerTravail,
    },
    {
      methode: "POST",
      chemin: "/api/internal/account/purge",
      processus: ["toolhost"],
      acces: "enveloppe",
      traiter: purgerCompte,
    },
  ];
}
