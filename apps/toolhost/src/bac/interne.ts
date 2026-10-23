// SPDX-License-Identifier: MIT
/** apps/toolhost/src/bac/interne.ts — routes internes du bac pour la console (hors des préfixes relayés par main : jamais atteintes depuis un navigateur) : suppression du bac et des identifiants de sites d'un compte supprimé. */
import {
  forgetPreviewIp,
  getUserSandbox,
  messageSuppression,
  resetUserSandboxCache,
  supprimerDossierBac,
  WORK_SUBDIR,
} from "@elpis/bac";
import { HttpError } from "@elpis/commun";
import { config, pyJoin, realpathPy, safeSandboxName } from "@elpis/config";
import { deleteOwnerCredentials } from "@elpis/navigateur";
import { auditEvent, usernameFor } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { DefinitionRoute } from "../app";
import { baseHote } from "../base-hote";
import { reponseJson } from "../socle";
import { uidDe } from "./routes-me";

/** Conteneur du compte de l'enveloppe retiré, puis `P` supprimé ici comme sur la console (/work vidé par le root du conteneur si l'hôte n'en a pas le droit) ; refus → 502 avec la raison. */
async function supprimerBac(requete: FastifyRequest, reponse: FastifyReply): Promise<FastifyReply> {
  const uid = uidDe(requete);
  const username = await usernameFor(uid);
  forgetPreviewIp(uid);
  const dossier = realpathPy(pyJoin(config.SANDBOX_DIR, safeSandboxName(username)));
  const sb = getUserSandbox(uid, username, pyJoin(dossier, WORK_SUBDIR));
  try {
    await sb.destroy().catch((e: unknown) => {
      throw new HttpError(502, messageSuppression(e));
    });
    const [supprime, erreur] = await supprimerDossierBac(dossier, () => sb.purge());
    if (erreur !== null) throw new HttpError(502, erreur);
    auditEvent({
      userId: uid,
      username,
      action: "user.sandbox.delete",
      details: { container: sb.containerName, deleted: supprime },
    });
    return reponseJson(reponse, { ok: true, deleted: supprime });
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
      chemin: "/api/internal/sandbox/delete",
      processus: ["toolhost"],
      acces: "enveloppe",
      traiter: supprimerBac,
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
