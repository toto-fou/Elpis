// SPDX-License-Identifier: MIT
/** apps/toolhost/src/bac/console.ts — routes internes `/api/internal/sandboxes/*` de la console : santé du démon, conteneurs des comptes, arrêt, destruction et GC des inactifs ; seul l'hôte lance docker. */
import { lstatSync, readdirSync, statSync } from "node:fs";

import {
  appelDocker,
  containerName,
  decoderRemplace,
  findImageArchive,
  forgetPreviewIp,
  labelFilter,
  labelTpl,
  resetUserSandboxCache,
  sousVerrouDeCycle,
  which,
} from "@elpis/bac";
import {
  decoderUtf8Py,
  ErreurJsonPy,
  ErreurPython,
  estErreurPython,
  HttpError,
  intPy,
  itemPy,
  journalDe,
  nomTypePy,
  poserCle,
  prefixePy,
  pyJsonLoads,
  splitlinesPy,
  stripPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, pyJoin, safeSandboxName } from "@elpis/config";
import { py, entrees } from "@elpis/http";
import { auditEvent, usernameFor } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { DefinitionRoute } from "../app";
import { reponseJson } from "../socle";
import { uidDe } from "./routes-me";

const log = journalDe("sandbox");
const INDICE_DEMON =
  "Le daemon Docker n'est pas joignable. Vérifie :\n" +
  "  • sudo systemctl status docker\n" +
  "  • L'utilisateur de l'app a-t-il le droit (groupe docker) ?\n" +
  "  • Le socket /var/run/docker.sock existe-t-il ?";
const FORMAT_PS =
  '{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}",' +
  '"state":"{{.State}}","status":"{{.Status}}","created":"{{.CreatedAt}}"}';

/** Délais des appels Docker (ms) et budget du GC (moins que le délai du core), réglables par les tests. */
export const delaisDocker = {
  budgetGc: 240_000,
  version: 10_000,
  image: 10_000,
  ps: 15_000,
  inspect: 5_000,
  stop: 15_000,
  rm: 20_000,
};

/** Démon (10 s), image chargée (10 s), archive sur disque ; l'état de chargement du process est ajouté par la console. */
async function controleSante(requete: FastifyRequest, reponse: FastifyReply): Promise<FastifyReply> {
  const image = entrees(requete, { query: { image: py.str() } }).query.image;
  const r = await appelDocker(["version", "--format", "{{.Server.Version}}"], delaisDocker.version);
  if (r.delaiDepasse)
    return reponseJson(reponse, {
      daemon_ok: false,
      error: "Timeout — le daemon Docker ne répond pas",
      hint: "Vérifie : sudo systemctl status docker",
    });
  if (r.code !== 0)
    return reponseJson(reponse, {
      daemon_ok: false,
      error: prefixePy(stripPy(decoderRemplace(r.erreur)).split("\n")[0] ?? "", 300),
      hint: INDICE_DEMON,
    });
  const version = stripPy(decoderUtf8Py(r.sortie));
  const r2 = await appelDocker(["image", "inspect", image], delaisDocker.image);
  const chargee = !r2.delaiDepasse && r2.code === 0;
  const archive = chargee ? null : findImageArchive(image);
  return reponseJson(reponse, {
    daemon_ok: true,
    server_version: version,
    image,
    image_loaded: chargee,
    archive_available: archive !== null,
    archive_path: archive,
  });
}

/** Conteneurs en marche étiquetés `elpis.user_id`, une ligne brute (nom, compte, étiquettes) par conteneur ; toute erreur de docker : aucune ligne. */
async function conteneursEnMarche(_requete: FastifyRequest, reponse: FastifyReply): Promise<FastifyReply> {
  const format =
    `{{.Names}}\t${labelTpl("user_id", true)}\t${labelTpl("username", true)}\t` +
    `${labelTpl("netcfg", true)}\t${labelTpl("spec", true)}\t${labelTpl("durci", true)}\t` +
    labelTpl("resolved", true);
  const r = await appelDocker(["ps", ...labelFilter("user_id"), "--format", format], delaisDocker.ps);
  const lignes: string[][] = [];
  if (!r.delaiDepasse && r.code === 0)
    for (const ligne of splitlinesPy(decoderRemplace(r.sortie))) {
      const parts = ligne.split("\t");
      if (parts.length >= 4) lignes.push(Array.from({ length: 7 }, (_, i) => parts[i] ?? ""));
    }
  return reponseJson(reponse, { containers: lignes });
}

/** Conteneurs étiquetés `elpis.user_id`, compte relu par `docker inspect` ; 502 si `docker ps` échoue. */
async function listerConteneurs(_requete: FastifyRequest, reponse: FastifyReply): Promise<FastifyReply> {
  const r = await appelDocker(
    ["ps", "-a", ...labelFilter("user_id"), "--format", FORMAT_PS],
    delaisDocker.ps,
  );
  if (r.delaiDepasse) throw new HttpError(502, "docker ps timeout");
  if (r.code !== 0) throw new HttpError(502, prefixePy(stripPy(decoderRemplace(r.erreur)), 300));
  const conteneurs: unknown[] = [];
  for (const brute of splitlinesPy(decoderUtf8Py(r.sortie))) {
    const ligne = stripPy(brute);
    if (!ligne) continue;
    let c: unknown;
    try {
      c = pyJsonLoads(ligne);
    } catch (e) {
      if (e instanceof ErreurJsonPy) continue;
      throw e;
    }
    const nom = itemPy(c, "name");
    if (typeof nom !== "string")
      throw new ErreurPython("TypeError", `expected str, bytes or os.PathLike object, not ${nomTypePy(nom)}`);
    const ri = await appelDocker(
      ["inspect", "--format", `${labelTpl("user_id")}|${labelTpl("username")}`, nom],
      delaisDocker.inspect,
    );
    const etiquette = stripPy(decoderUtf8Py(ri.sortie));
    const i = etiquette.indexOf("|");
    const [uidTexte, nomCompte] = i < 0 ? [etiquette, ""] : [etiquette.slice(0, i), etiquette.slice(i + 1)];
    let uid: number | null;
    try {
      uid = intPy(uidTexte);
    } catch (e) {
      if (!estErreurPython(e, "ValueError")) throw e;
      uid = null;
    }
    poserCle(c as Dict, "user_id", uid);
    poserCle(c as Dict, "username", nomCompte || null);
    conteneurs.push(c);
  }
  return reponseJson(reponse, { containers: conteneurs, count: conteneurs.length });
}

/** Arrêt ou destruction du conteneur du compte de l'enveloppe (action de l'admin, auditée comme telle), sous le verrou de cycle de vie ; sans docker rien à faire, le résultat de docker est ignoré. */
async function agirSurBac(
  requete: FastifyRequest,
  reponse: FastifyReply,
  action: "stop" | "destroy",
): Promise<FastifyReply> {
  const uid = uidDe(requete);
  if (which("docker") === null) return reponseJson(reponse, { ok: true });
  const username = await usernameFor(uid);
  const conteneur = containerName(safeSandboxName(username));
  const [args, delaiMs] =
    action === "stop"
      ? ([["stop", "-t", "5", conteneur], delaisDocker.stop] as const)
      : ([["rm", "-fv", conteneur], delaisDocker.rm] as const);
  try {
    await sousVerrouDeCycle(uid, () => appelDocker(args, delaiMs));
  } finally {
    if (action === "destroy") {
      forgetPreviewIp(uid);
      resetUserSandboxCache(uid);
    }
  }
  auditEvent({ userId: uid, username, action: `admin.sandbox.${action}`, details: { container: conteneur } });
  return reponseJson(reponse, { ok: true });
}

/** Dernière activité du `/work` d'un compte : mtime du dossier et des journaux de `.bg/` (liens non suivis) ; 0 si illisible. */
function derniereActivite(travail: string): number {
  let dernier: number;
  try {
    dernier = statSync(travail).mtimeMs / 1000;
  } catch {
    dernier = 0;
  }
  try {
    const bg = pyJoin(travail, ".bg");
    if (statSync(bg).isDirectory() && !lstatSync(bg).isSymbolicLink()) {
      for (const nom of readdirSync(bg)) {
        try {
          dernier = Math.max(dernier, lstatSync(pyJoin(bg, nom)).mtimeMs / 1000);
        } catch {
          continue;
        }
      }
    }
  } catch {
    // dossier .bg absent ou illisible
  }
  return dernier;
}

/** Arrête les conteneurs dont le `/work` est inactif depuis `idle_kill_hours` (plus d'arrêt après `budgetGc` : rend ce qui est arrêté) ; rend leurs noms. */
export async function arreterInactifs(
  idleKillHours: number,
  maintenant = Date.now() / 1000,
): Promise<string[]> {
  if (which("docker") === null) return [];
  const seuil = idleKillHours * 3600;
  if (seuil <= 0) return [];
  const r = await appelDocker(["ps", ...labelFilter("user_id"), "--format", "{{.Names}}"], delaisDocker.ps);
  if (r.delaiDepasse || r.code !== 0) return [];
  const arretes: string[] = [];
  const echeance = Date.now() + delaisDocker.budgetGc;
  for (const brut of splitlinesPy(decoderUtf8Py(r.sortie))) {
    if (Date.now() >= echeance) break;
    const nom = stripPy(brut);
    if (!nom) continue;
    const r2 = await appelDocker(["inspect", "--format", labelTpl("username"), nom], delaisDocker.inspect);
    if (r2.delaiDepasse || r2.code !== 0) continue;
    const compte = stripPy(decoderUtf8Py(r2.sortie));
    const dernier = derniereActivite(pyJoin(pyJoin(config.SANDBOX_DIR, compte), "work"));
    if (maintenant - dernier > seuil) {
      await appelDocker(["stop", "-t", "5", nom], delaisDocker.stop);
      arretes.push(nom);
      log.info(`[sandbox-gc] container stoppé (idle ${Math.trunc(maintenant - dernier)}s) : ${nom}`);
    }
  }
  return arretes;
}

async function nettoyer(requete: FastifyRequest, reponse: FastifyReply): Promise<FastifyReply> {
  const heures = entrees(requete, { query: { idle_kill_hours: py.float() } }).query.idle_kill_hours;
  return reponseJson(reponse, { stopped: await arreterInactifs(heures) });
}

export function routesConsole(): DefinitionRoute[] {
  const route = (
    methode: "GET" | "POST",
    chemin: string,
    traiter: DefinitionRoute["traiter"],
  ): DefinitionRoute => ({ methode, chemin, processus: ["toolhost"], acces: "enveloppe", traiter });
  return [
    route("GET", "/api/internal/sandboxes/health", controleSante),
    route("GET", "/api/internal/sandboxes/running", conteneursEnMarche),
    route("GET", "/api/internal/sandboxes/containers", listerConteneurs),
    route("POST", "/api/internal/sandboxes/stop", (q, r) => agirSurBac(q, r, "stop")),
    route("POST", "/api/internal/sandboxes/destroy", (q, r) => agirSurBac(q, r, "destroy")),
    route("POST", "/api/internal/sandboxes/gc", nettoyer),
  ];
}
