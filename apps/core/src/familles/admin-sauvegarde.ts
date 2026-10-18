// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-sauvegarde.ts — console › Système › Données : sauvegarde téléchargée, restauration, envoi distant et sa configuration (routes/admin/lifecycle.py). */
import { rmSync } from "node:fs";
import { basename, dirname } from "node:path";

import { ErreurZip, getPy, HttpError, intPy, longueurPy, ouPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";
import { send } from "@fastify/send";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { Journal } from "../journal";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { dossiersInstance, restoreFromZip } from "../ops/restauration";
import type { DossiersRestauration } from "../ops/restauration";
import { backupIncomplete, estPortee, makeBackupZip } from "../ops/sauvegarde";
import {
  getRemoteConfig,
  keyFingerprint,
  normalizeRemoteConfig,
  runSend,
  runTest,
  saveRemoteConfig,
  storeRsyncPassword,
  storeSshKey,
  validateRemoteConfig,
} from "../ops/sauvegarde-distante";
import {
  corpsJson,
  corpsJsonValeurs,
  entrees,
  lireFormulaire,
  py,
  reponseJsonPy,
  valeursFormulaire,
} from "@elpis/http";

const MO = 1024 * 1024;

export interface DependancesSauvegarde {
  readonly base: Base;
  readonly journal?: Journal;
  /** Environnement relu à chaque restauration (`APP_MAX_RESTORE_MB`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Dossiers de l'instance (tests) ; défaut : ceux de la configuration. */
  readonly dossiers?: () => DossiersRestauration;
}

function route(methode: "GET" | "POST", chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode, chemin, processus: ["admin"], acces: "admin", traiter };
}

/** `(body or {})` : un corps vrai qui n'est pas un dict fait lever `.get` (AttributeError → 500). */
function champ(corps: unknown, cle: string): unknown {
  return getPy(ouPy(corps, {}), cle);
}

export function creerFamilleSauvegarde(dep: DependancesSauvegarde): Famille {
  const env = (): NodeJS.ProcessEnv => dep.env ?? process.env;
  const journal = dep.journal;

  /** `FileResponse(..., background=os.remove)` : archive servie puis supprimée à la fermeture de la réponse. */
  const telecharger = async (req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> => {
    const { query } = entrees(req, { query: { scope: py.str().defaut("full") } });
    if (!estPortee(query.scope)) throw new HttpError(400, "scope invalide");
    const { chemin, nom } = await makeBackupZip(dep.base, query.scope, journal ? { journal } : {});
    rep.raw.once("close", () => rmSync(chemin, { force: true }));
    const r = await send(req.raw, encodeURIComponent(basename(chemin)), {
      root: dirname(chemin),
      index: false,
      dotfiles: "allow",
      cacheControl: false,
      contentType: false,
    });
    if (r.type === "error" && r.statusCode >= 500) throw r.metadata.error;
    if (r.type !== "file" && r.statusCode !== 412 && r.statusCode !== 416) throw new HttpError(404);
    const entetes: Record<string, string> = { ...(r.headers as Record<string, string>) };
    if (r.statusCode !== 304 && r.statusCode !== 416) entetes["content-type"] = "application/zip";
    entetes["content-disposition"] = `attachment; filename="${nom}"`;
    if (backupIncomplete(nom)) entetes["x-backup-incomplete"] = "1";
    return rep.code(r.statusCode).headers(entetes).send(r.stream);
  };

  /** `file: UploadFile = File(...)`, `scope: str = Form("full")` ; fichier borné par `APP_MAX_RESTORE_MB`, restauration hors archive illisible. */
  const restaurer = async (req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> => {
    let provisoire: number;
    try {
      provisoire = intPy(env()["APP_MAX_RESTORE_MB"] ?? "500") * MO;
    } catch {
      provisoire = 500 * MO;
    }
    const formulaire = await lireFormulaire(req, { limiteFichier: Math.max(0, provisoire) + 1 });
    const { file, scope } = valeursFormulaire(formulaire, {
      file: { type: "fichier", requis: true },
      scope: { type: "texte", requis: false },
    });
    const portee = scope ?? "full";
    if (!estPortee(portee)) throw new HttpError(400, "scope invalide");
    const max = intPy(env()["APP_MAX_RESTORE_MB"] ?? "500") * MO;
    if (file.taille > max)
      throw new HttpError(413, `Fichier trop volumineux (plafond : ${Math.floor(max / MO)} Mo).`);
    if (file.taille === 0) throw new HttpError(400, "Fichier vide");
    let resultat;
    try {
      resultat = await restoreFromZip(
        file.chemin,
        portee,
        (dep.dossiers ?? dossiersInstance)(),
        dep.base,
        journal,
      );
    } catch (e) {
      if (e instanceof ErreurZip && e.type === "BadZipFile") throw new HttpError(400, "Fichier ZIP invalide");
      throw e;
    }
    return rep.send({
      ok: true,
      scope: portee,
      restored: resultat.restored.length,
      errors: resultat.errors,
      restart_required: resultat.restored.some((r) => r.startsWith("db/") || r.startsWith("user_db/")),
    });
  };

  const lireConfig = (_req: FastifyRequest, rep: FastifyReply): FastifyReply =>
    reponseJsonPy(rep, getRemoteConfig(), { "cache-control": "no-cache" });

  const enregistrerConfig = async (req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> => {
    const corps = corpsJsonValeurs(req);
    const [ok, err] = validateRemoteConfig(normalizeRemoteConfig(corps));
    if (!ok && veritePy(champ(corps, "enabled"))) throw new HttpError(400, err);
    return reponseJsonPy(rep, { ok: true, config: await saveRemoteConfig(corps) });
  };

  const cle = async (req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> => {
    const texte = ouPy(champ(corpsJson(req), "key"), "");
    if (typeof texte !== "string" || !texte.includes("PRIVATE KEY"))
      throw new HttpError(400, "Clé privée invalide (format PEM/OpenSSH attendu)");
    const chemin = storeSshKey(texte);
    return rep.send({ ok: true, fingerprint: await keyFingerprint(chemin) });
  };

  const motDePasse = (req: FastifyRequest, rep: FastifyReply): FastifyReply => {
    const mdp = champ(corpsJson(req), "password");
    if (typeof mdp !== "string" || longueurPy(mdp) > 1024) throw new HttpError(400, "Mot de passe invalide");
    let present: boolean;
    try {
      present = storeRsyncPassword(mdp);
    } catch (e) {
      if (e instanceof Error && e.name === "ValueError") throw new HttpError(400, e.message);
      throw e;
    }
    return rep.send({ ok: true, password_present: present });
  };

  const tester = async (_req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> =>
    reponseJsonPy(rep, await runTest());

  const envoyer = async (req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> => {
    let corps: unknown;
    try {
      corps = corpsJsonValeurs(req);
    } catch {
      corps = {};
    }
    const res: Dict = await runSend(dep.base, champ(corps, "scope"), journal ? { journal } : {});
    return reponseJsonPy(rep, res);
  };

  return {
    nom: "admin-sauvegarde",
    routes: [
      route("GET", "/api/admin/backup", telecharger),
      route("POST", "/api/admin/restore", restaurer),
      route("GET", "/api/admin/backup/remote", lireConfig),
      route("POST", "/api/admin/backup/remote", enregistrerConfig),
      route("POST", "/api/admin/backup/remote/key", cle),
      route("POST", "/api/admin/backup/remote/password", motDePasse),
      route("POST", "/api/admin/backup/remote/test", tester),
      route("POST", "/api/admin/backup/remote/send", envoyer),
    ],
  };
}
