// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-executeurs.ts — `/api/admin` des exécuteurs et des hôtes d'outils : réglages des bacs à sable, santé Docker, conteneurs des comptes, GC ; affectations et migration entre hôtes (shared_infra/routes/admin/executors.py, toolhosts.py). */
import { getUserSettings, getUsernameById } from "@elpis/auth";
import { chargerConfigBac, configuredImage, containerName } from "@elpis/bac";
import { estDict, getPy, HttpError, intPy, ouPy, poserCle, prefixePy, stripPy, strPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { safeSandboxName } from "@elpis/config";
import type { Base } from "@elpis/db";
import { auditEvent } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import { lireConfigJson, modifierConfigJson } from "../administration/config-sous-verrou";
import {
  actionConteneur,
  configAssainie,
  conteneursPerimes,
  controleSante,
  gcIdleContainers,
  listerConteneurs,
  profilsAssainis,
  vueExecuteurs,
} from "../administration/executeurs";
import {
  hotesDeclares,
  listPlacements,
  migrateUser,
  sonderHote,
  unassign,
} from "../administration/hotes-outils";
import type { Journal } from "../journal";
import { resolveNetworkProfileId } from "../relais/identite";
import { assign, countsByHost } from "../relais/placement";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { syncUserMirror } from "../skills/bibliotheque";
import { corpsJsonValeurs, entrees, py, reponseJsonPy } from "@elpis/http";

export interface DependancesAdminExecuteurs {
  readonly base: Base;
  readonly journal: Journal;
  /** `_sync_user_mirror` après une migration ; par défaut le miroir des skills du compte. */
  readonly synchroniserMiroir?: (uid: number) => Promise<void>;
}

function route(methode: DefinitionRoute["methode"], chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode, chemin, processus: ["admin"], acces: "admin", traiter };
}

/** `audit_event(user_id=request.state.user_id, username=request.state.username, …)`. */
function auditer(req: FastifyRequest, action: string, details: Dict): void {
  auditEvent({
    userId: req.utilisateur?.id ?? null,
    username: req.utilisateur?.username ?? null,
    action,
    details,
  });
}

const idCompte = (req: FastifyRequest): number => entrees(req, { path: { user_id: py.int() } }).path.user_id;

/** Section `executors` de config.json relue fidèlement (`read_config_json() or {}`). */
function sectionExecuteurs(): unknown {
  return ouPy(getPy(lireConfigJson(), "executors"), {});
}

// ── Exécuteurs (executors.py) ────────────────────────────────────────────────

async function enregistrer(dep: DependancesAdminExecuteurs, req: FastifyRequest): Promise<Dict> {
  const corps = corpsJsonValeurs(req);
  const nouveau = estDict(corps) ? getPy(corps, "executors") : null;
  if (!estDict(nouveau)) throw new HttpError(400, "Body invalide : besoin de {executors: {...}}");
  const avertissements: string[] = [];
  const profils = profilsAssainis(nouveau, avertissements);
  let assainie: Dict = {};
  await modifierConfigJson((cfg) => {
    assainie = configAssainie(nouveau, ouPy(getPy(cfg, "executors"), {}), profils);
    poserCle(cfg, "executors", assainie);
  });
  auditer(req, "admin.executors.update", { force_user_docker: assainie["force_user_docker"] });
  const perimes = await conteneursPerimes(
    profils,
    (uid) => getUserSettings(dep.base, uid),
    (reglages) => resolveNetworkProfileId(reglages),
  );
  return { ok: true, config: assainie, warnings: avertissements, stale_containers: perimes };
}

async function sante(): Promise<Dict> {
  chargerConfigBac();
  return controleSante(configuredImage(getPy(sectionExecuteurs(), "image")));
}

/** `UserSandbox(uid, nom).stop()/destroy()` : 404 sans compte, configuration du bac relue comme le constructeur, puis la commande sous verrou. */
async function actionBac(
  dep: DependancesAdminExecuteurs,
  req: FastifyRequest,
  action: "stop" | "destroy",
): Promise<Dict> {
  const uid = idCompte(req);
  const nom = await getUsernameById(dep.base, uid);
  if (!nom) throw new HttpError(404, `User ${uid} introuvable`);
  chargerConfigBac();
  await actionConteneur(uid, containerName(safeSandboxName(nom)), action);
  auditer(req, `admin.sandbox.${action}`, { target_user_id: uid, target_username: nom });
  return { ok: true };
}

async function nettoyer(req: FastifyRequest): Promise<Dict> {
  const arretes = await gcIdleContainers(chargerConfigBac().idle_kill_hours);
  auditer(req, "admin.sandbox.gc", { stopped: arretes });
  return { ok: true, stopped: arretes };
}

// ── Hôtes d'outils (toolhosts.py) ────────────────────────────────────────────

async function hotes(dep: DependancesAdminExecuteurs, rep: FastifyReply): Promise<FastifyReply> {
  const { hotes: declares, placement } = hotesDeclares();
  const sondes = await Promise.all([...declares].map(([id, spec]) => sonderHote(id, spec)));
  const comptes = await countsByHost();
  for (const s of sondes) s["accounts"] = comptes.get(strPy(s["id"])) ?? 0;
  const affectations = await listPlacements(dep.base);
  for (const pl of affectations) {
    try {
      pl["username"] = (await getUsernameById(dep.base, intPy(pl["user_id"]))) || "";
    } catch {
      pl["username"] = "";
    }
  }
  return reponseJsonPy(rep, {
    ok: true,
    hosts: sondes,
    placement: { ...placement },
    placements: affectations,
  });
}

/** `str((body or {}).get("host_id") or "").strip()` puis `_check_host` : 404 pour un hôte non déclaré. */
function hoteDemande(req: FastifyRequest): string {
  const hostId = stripPy(strPy(ouPy(getPy(ouPy(corpsJsonValeurs(req), {}), "host_id"), "")));
  if (!hotesDeclares().hotes.has(hostId)) throw new HttpError(404, `hôte inconnu : ${hostId}`);
  return hostId;
}

async function affecter(req: FastifyRequest): Promise<Dict> {
  const uid = idCompte(req);
  const hostId = hoteDemande(req);
  await assign(uid, hostId);
  auditer(req, "admin.toolhosts.assign", { user_id: uid, host_id: hostId });
  return { ok: true, user_id: uid, host_id: hostId };
}

async function migrer(dep: DependancesAdminExecuteurs, req: FastifyRequest): Promise<Dict> {
  const uid = idCompte(req);
  const hostId = hoteDemande(req);
  let res: Dict;
  try {
    res = await migrateUser(uid, hostId, dep.synchroniserMiroir ?? syncUserMirror);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    dep.journal.warn(`[toolhosts] migration de ${uid} vers ${hostId} : ${prefixePy(message, 300)}`);
    throw new HttpError(502, `migration impossible : ${message}`);
  }
  auditer(req, "admin.toolhosts.migrate", {
    user_id: uid,
    ...Object.fromEntries(Object.entries(res).filter(([k]) => k !== "ok")),
  });
  return res;
}

async function desaffecter(dep: DependancesAdminExecuteurs, req: FastifyRequest): Promise<Dict> {
  const uid = idCompte(req);
  await unassign(dep.base, uid);
  auditer(req, "admin.toolhosts.unassign", { user_id: uid });
  return { ok: true };
}

export function creerFamilleAdminExecuteurs(dep: DependancesAdminExecuteurs): Famille {
  return {
    nom: "admin-executeurs",
    routes: [
      route("GET", "/api/admin/executors", (_req, rep) =>
        reponseJsonPy(rep, vueExecuteurs(lireConfigJson())),
      ),
      route("POST", "/api/admin/executors", (req) => enregistrer(dep, req)),
      route("GET", "/api/admin/executors/healthcheck", () => sante()),
      route("GET", "/api/admin/sandbox/containers", async (_req, rep) =>
        reponseJsonPy(rep, await listerConteneurs()),
      ),
      route("POST", "/api/admin/sandbox/containers/:user_id/stop", (req) => actionBac(dep, req, "stop")),
      route("DELETE", "/api/admin/sandbox/containers/:user_id", (req) => actionBac(dep, req, "destroy")),
      route("POST", "/api/admin/sandbox/gc", (req) => nettoyer(req)),
      route("GET", "/api/admin/toolhosts", (_req, rep) => hotes(dep, rep)),
      route("POST", "/api/admin/toolhosts/placements/:user_id", (req) => affecter(req)),
      route("POST", "/api/admin/toolhosts/placements/:user_id/migrate", (req) => migrer(dep, req)),
      route("DELETE", "/api/admin/toolhosts/placements/:user_id", (req) => desaffecter(dep, req)),
    ],
  };
}
