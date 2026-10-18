// SPDX-License-Identifier: MIT
/** apps/toolhost/src/bac/routes-me.ts — `/api/sandbox/me` (sandbox/routes_lifecycle.py) : état du bac du compte, choix du profil réseau (imposition lue dans l'enveloppe), redémarrage, destruction. */
import {
  appelDocker,
  bacDuCompte,
  containerName,
  decoderRemplace,
  ensureImageLoaded,
  ExecError,
  forgetPreviewIp,
  profilRetenu,
  getImageLoadState,
  imageStateDict,
  labelFilter,
  loadAdminConfig,
  resetUserSandboxCache,
  resolveNetworkProfileIdReglages,
  retenirChoixProfil,
} from "@elpis/bac";
import type { ConfigSandbox, EtatBac, UserSandbox } from "@elpis/bac";
import {
  decoderUtf8,
  estDict,
  HttpError,
  nomTypePy,
  prefixePy,
  pyJsonLoadsOctets,
  reprPy,
  stripPy,
  suffixePy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { safeSandboxName } from "@elpis/config";
import { nonFinisEnNul } from "@elpis/http";
import {
  auditEvent,
  resolveForcedNetworkProfileId,
  resolveNetworkProfileId,
  usernameFor,
} from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { DefinitionRoute } from "../app";
import type { Journal } from "../journal";
import { reponseJson } from "../socle";

const DEMON_OK_TTL_S = 30;
const DEMON_KO_TTL_S = 5;
const STATS_TTL_S = 8;
let cacheDemon: { expire: number; ok: boolean; info: string } | null = null;
const cacheStats = new Map<number, { expire: number; valeur: unknown }>();

const maintenant = (): number => performance.now() / 1000;

/** Pour les tests : caches du démon et des statistiques vidés. */
export function oublierCachesMe(): void {
  cacheDemon = null;
  cacheStats.clear();
}

/** `require_user_id` sur l'hôte : l'identité vérifiée de l'enveloppe. */
export function uidDe(requete: FastifyRequest): number {
  return Math.trunc(requete.identite?.user_id ?? 0);
}

/** `_reglages_du_profil` : imposition et profil de l'enveloppe (l'hôte n'a pas la base des comptes), choix retenu compris. */
export function reglagesDuProfil(uid: number): Dict {
  return {
    forced_network_profile_id: resolveForcedNetworkProfileId(uid) ?? "",
    network_profile_id: profilRetenu(uid, resolveNetworkProfileId(uid) || ""),
  };
}

async function demonJoignable(sb: UserSandbox): Promise<[boolean, string]> {
  const t = maintenant();
  if (cacheDemon !== null && t < cacheDemon.expire) return [cacheDemon.ok, cacheDemon.info];
  let r: [boolean, string];
  try {
    r = await sb.daemonReachable();
  } catch (e) {
    r = [false, (e as Error).message];
  }
  cacheDemon = { expire: t + (r[0] ? DEMON_OK_TTL_S : DEMON_KO_TTL_S), ok: r[0], info: r[1] };
  return r;
}

async function statsEnCache(uid: number, sb: UserSandbox): Promise<unknown> {
  const t = maintenant();
  const deja = cacheStats.get(uid);
  if (deja && t < deja.expire) return deja.valeur;
  const valeur = await sb.stats();
  cacheStats.set(uid, { expire: t + STATS_TTL_S, valeur });
  return valeur;
}

/** `asyncio.wait_for` : l'appel reçoit le signal (annulé au délai, comme la `CancelledError`) et l'attente est rendue au délai. */
async function avecDelai<T>(ms: number, f: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  const appel = f(signal);
  appel.catch(() => undefined);
  return Promise.race([
    appel,
    new Promise<never>((_ok, ko) => {
      signal.addEventListener("abort", () => ko(signal.reason as Error), { once: true });
    }),
  ]);
}

function estDelai(e: unknown): boolean {
  return e instanceof Error && e.name === "TimeoutError";
}

/** `str(e)` de Python : vide pour un dépassement de délai (`TimeoutError()`). */
function texteErreur(e: unknown): string {
  return estDelai(e) ? "" : e instanceof Error ? e.message : String(e);
}

function id12(etat: EtatBac): string | null {
  return etat.container_id ? prefixePy(etat.container_id, 12) : null;
}

/** `GET /api/sandbox/me` : mode, limites, état de l'image, profils ; crée le conteneur une fois l'image chargée. */
async function meGet(requete: FastifyRequest, reponse: FastifyReply, log: Journal): Promise<FastifyReply> {
  const uid = uidDe(requete);
  const username = await usernameFor(uid);
  const reglages = reglagesDuProfil(uid);
  const cfg = loadAdminConfig();
  const sb = await bacDuCompte(uid, username);
  let impose = stripPy(String(reglages["forced_network_profile_id"] || ""));
  let profilId = resolveNetworkProfileIdReglages(reglages);
  const profils = cfg.network_profiles.map((p) => ({ ...p }));
  if (!profils.some((p) => p.id === profilId)) {
    profilId = profils.some((p) => p.id === "isolated") ? "isolated" : (profils[0]?.id ?? "isolated");
    impose = "";
  }
  const out: Dict = {
    user_mode: "docker",
    effective_mode: "docker",
    force_admin: cfg.force_user_docker,
    image: cfg.image,
    limits: {
      memory_mb: cfg.memory_mb,
      cpu_quota_pct: cfg.cpu_quota_pct,
      pids_max: cfg.pids_max,
      timeout_s: cfg.timeout_s,
    },
    idle_kill_hours: cfg.idle_kill_hours,
    image_status: imageStateDict(getImageLoadState()),
    network_profile_id: profilId,
    network_profiles: profils,
    network_profile_locked: Boolean(impose),
  };
  const [demonOk, demonInfo] = await demonJoignable(sb);
  out["daemon_ok"] = demonOk;
  out["daemon_info"] = demonInfo;
  if (!demonOk) {
    out["container"] = { error: "daemon injoignable" };
    return reponseJson(reponse, nonFinisEnNul(out));
  }
  let etatImage = getImageLoadState();
  if (etatImage.status === "not_checked") {
    try {
      etatImage = await ensureImageLoaded(cfg.image);
    } catch (e) {
      log.warn(`[sandbox] chargement d'image depuis GET /me : ${(e as Error).message}`);
    }
  }
  if (etatImage.status === "loading") {
    out["container"] = {
      exists: false,
      running: false,
      container_name: sb.containerName,
      pending: "image_loading",
    };
    return reponseJson(reponse, nonFinisEnNul(out));
  }
  if (etatImage.status === "loaded") {
    try {
      const st = await avecDelai(30_000, (signal) => sb.ensureRunning(signal));
      out["container"] = {
        exists: st.exists,
        running: st.running,
        container_id: id12(st),
        container_name: st.container_name,
        image: st.image,
        started_at: st.started_at,
      };
      if (st.running) out["stats"] = await statsEnCache(uid, sb);
    } catch (e) {
      out["container"] = estDelai(e)
        ? { exists: false, running: false, container_name: sb.containerName, pending: "container_starting" }
        : { error: texteErreur(e) };
    }
  } else {
    try {
      const st = await sb.status();
      out["container"] = { exists: st.exists, running: st.running, container_name: st.container_name };
    } catch {
      out["container"] = { running: false };
    }
  }
  return reponseJson(reponse, nonFinisEnNul(out));
}

/** `_force_cleanup_user_containers` : conteneurs ARRÊTÉS du compte (jamais un conteneur en marche) supprimés. */
async function nettoyerConteneursArretes(uid: number, log: Journal): Promise<number> {
  const r = await appelDocker(
    [
      "ps",
      "-a",
      ...labelFilter("user_id", String(uid)),
      "--filter",
      "status=exited",
      "--filter",
      "status=dead",
      "--filter",
      "status=created",
      "--format",
      "{{.ID}}",
    ],
    5_000,
    { binaire: "docker" },
  );
  if (r.delaiDepasse) throw Object.assign(new Error(""), { name: "TimeoutError" });
  const ids = stripPy(decoderUtf8(r.sortie))
    .split("\n")
    .filter((x) => x !== "");
  if (ids.length === 0) return 0;
  log.info(`[sandbox] cleanup forcé user_id=${uid} : ${ids.length} container(s) à détruire`);
  const rm = await appelDocker(["rm", "-fv", ...ids], 15_000, { binaire: "docker" });
  if (rm.delaiDepasse) throw Object.assign(new Error(""), { name: "TimeoutError" });
  resetUserSandboxCache(uid);
  return ids.length;
}

/** Journaux du conteneur après un démarrage raté : `docker logs --tail 30` (sorties jointes), sans le bruit « No such container ». */
async function journauxConteneur(username: string, log: Journal): Promise<string | null> {
  try {
    const r = await appelDocker(["logs", "--tail", "30", containerName(safeSandboxName(username))], 5_000, {
      binaire: "docker",
    });
    if (r.delaiDepasse) throw new Error("");
    const texte = stripPy(decoderRemplace(Buffer.concat([r.sortie, r.erreur])));
    if (texte && !texte.includes("No such container")) return suffixePy(texte, 2000);
  } catch (e) {
    log.warn(`[sandbox] impossible de récupérer logs : ${(e as Error).message}`);
  }
  return null;
}

/** `POST /api/sandbox/me` : mode (toujours docker) et profil réseau ; l'imposition de l'admin fait autorité (403). */
async function mePost(requete: FastifyRequest, reponse: FastifyReply, log: Journal): Promise<FastifyReply> {
  const uid = uidDe(requete);
  forgetPreviewIp(uid);
  const brut = pyJsonLoadsOctets(requete.corpsBrut);
  const corps = veritePy(brut) ? brut : {};
  if (!estDict(corps)) throw new TypeError(`'${nomTypePy(corps)}' object has no attribute 'get'`);
  let mode: unknown = Object.hasOwn(corps, "mode") ? corps["mode"] : null;
  let profilId: unknown = Object.hasOwn(corps, "network_profile_id") ? corps["network_profile_id"] : null;
  if (mode === null) mode = "docker";
  if (mode !== "folder" && mode !== "docker")
    throw new HttpError(400, `mode doit être 'docker' (reçu ${reprPy(mode)})`);
  if (mode === "folder") {
    log.info("[sandbox] mode 'folder' demandé par client legacy → forcé à 'docker'");
    mode = "docker";
  }
  const cfg: ConfigSandbox = loadAdminConfig();
  const ancienMode = "docker";
  const ancienProfil = profilRetenu(uid, resolveNetworkProfileId(uid) || "isolated");
  let impose = stripPy(String(reglagesDuProfil(uid)["forced_network_profile_id"] || ""));
  if (impose && !cfg.network_profiles.some((p) => p.id === impose)) impose = "";
  if (profilId === null) profilId = ancienProfil;
  if (impose && profilId !== impose)
    throw new HttpError(
      403,
      `Votre profil réseau est imposé par l'administrateur (${reprPy(impose)}) et ne peut pas être changé ici.`,
    );
  if (!cfg.network_profiles.some((p) => p.id === profilId))
    throw new HttpError(
      400,
      `Profil réseau ${reprPy(profilId)} introuvable. Disponibles : ${reprPy(cfg.network_profiles.map((p) => p.id))}`,
    );
  const profil = profilId as string;
  // Sans imposition transmise (main sans base), un changement de profil ne peut pas être vérifié : refusé.
  if (resolveForcedNetworkProfileId(uid) === null && profil !== ancienProfil)
    throw new HttpError(
      503,
      "Imposition du profil réseau non transmise par l'application : réessayez dans un instant.",
    );
  const username = await usernameFor(uid);
  log.info(
    ancienProfil !== profil
      ? `[sandbox] user_id=${uid} (${username}) — profil: ${ancienProfil} → ${profil}`
      : `[sandbox] user_id=${uid} : aucun changement (mode=docker profil=${profil})`,
  );
  auditEvent({
    userId: uid,
    username,
    action: "user.sandbox.mode",
    details: { mode, network_profile_id: profil },
  });
  retenirChoixProfil(uid, profil);
  const amorce: Dict = {};
  if (ancienMode === "docker" && ancienProfil !== profil) {
    log.info("[sandbox] profil changé : destruction du container existant pour recréation");
    try {
      const ancien = await bacDuCompte(uid, username);
      ancien.networkProfileId = ancienProfil;
      await ancien.destroy();
      log.info(
        `[sandbox] container détruit : elpis-sb-${username} (raison: changement profil ${ancienProfil} → ${profil})`,
      );
    } catch (e) {
      log.warn(`[sandbox] échec destruction ancien container : ${(e as Error).message}`);
    }
    resetUserSandboxCache(uid);
  }
  const etatImage = await ensureImageLoaded(cfg.image);
  amorce["image_status"] = imageStateDict(etatImage);
  if (etatImage.status === "loaded") {
    try {
      const sb = await bacDuCompte(uid, username);
      sb.networkProfileId = profil;
      log.info(
        `[sandbox] démarrage container avec profil=${profil} (mode=${String(sb.networkProfile.mode)})`,
      );
      const st = await avecDelai(60_000, (signal) => sb.ensureRunning(signal));
      amorce["container"] = { running: st.running, container_name: st.container_name, profile_id: profil };
    } catch (e) {
      const conteneur: Dict = { error: texteErreur(e) };
      amorce["container"] = conteneur;
      log.warn(`[sandbox] bootstrap échec user_id=${uid}: ${texteErreur(e)}`);
      const journaux =
        (e instanceof ExecError ? e.containerLogs : null) || (await journauxConteneur(username, log));
      if (journaux) {
        conteneur["logs"] = journaux;
        log.warn(`[sandbox] container logs (last) :\n${suffixePy(journaux, 1000)}`);
      }
      try {
        const n = estDelai(e) ? 0 : await nettoyerConteneursArretes(uid, log);
        if (n) log.info(`[sandbox] ${n} container(s) zombie(s) nettoyé(s)`);
      } catch (err) {
        log.warn(`[sandbox] cleanup zombie échec : ${texteErreur(err)}`);
      }
    }
  }
  return reponseJson(
    reponse,
    nonFinisEnNul({ ok: true, mode, network_profile_id: profil, bootstrap: amorce }),
  );
}

/** `POST /api/sandbox/me/restart` : conteneur détruit puis recréé (état corrompu, OOM). */
async function meRestart(
  requete: FastifyRequest,
  reponse: FastifyReply,
  log: Journal,
): Promise<FastifyReply> {
  const uid = uidDe(requete);
  forgetPreviewIp(uid);
  const username = await usernameFor(uid);
  const cfg = loadAdminConfig();
  const sb = await bacDuCompte(uid, username);
  const etat = await sb.status();
  if (!etat.exists)
    throw new HttpError(400, "Pas de container à redémarrer. Démarre-le d'abord dans tes paramètres.");
  const etatImage = await ensureImageLoaded(cfg.image, { blocking: true });
  if (etatImage.status !== "loaded")
    throw new HttpError(503, `Image indisponible : ${etatImage.error || etatImage.progress_msg}`);
  log.info(`[sandbox] restart demandé : ${sb.containerName} (profil=${sb.networkProfileId || "isolated"})`);
  let st: EtatBac;
  try {
    st = await sb.restart();
    log.info(`[sandbox] restart OK : ${String(st.container_name)} running=${st.running ? "True" : "False"}`);
  } catch (e) {
    log.error(`[sandbox] restart échec : ${texteErreur(e)}`);
    throw new HttpError(502, `Échec restart : ${texteErreur(e)}`);
  }
  auditEvent({
    userId: uid,
    username,
    action: "user.sandbox.restart",
    details: { container: st.container_name },
  });
  return reponseJson(
    reponse,
    nonFinisEnNul({
      ok: true,
      container: { running: st.running, container_name: st.container_name, container_id: id12(st) },
    }),
  );
}

/** `DELETE /api/sandbox/me` : conteneur détruit (RAM libérée), dossier gardé. */
async function meDelete(requete: FastifyRequest, reponse: FastifyReply): Promise<FastifyReply> {
  const uid = uidDe(requete);
  forgetPreviewIp(uid);
  const username = await usernameFor(uid);
  const sb = await bacDuCompte(uid, username);
  try {
    await sb.destroy();
  } catch (e) {
    throw new HttpError(502, `Échec destroy : ${texteErreur(e)}`);
  }
  auditEvent({
    userId: uid,
    username,
    action: "user.sandbox.destroy",
    details: { container: sb.containerName },
  });
  return reponseJson(reponse, { ok: true });
}

export function routesMe(log: Journal): DefinitionRoute[] {
  const route = (
    methode: "GET" | "POST" | "DELETE",
    chemin: string,
    traiter: (q: FastifyRequest, r: FastifyReply) => Promise<FastifyReply>,
  ): DefinitionRoute => ({ methode, chemin, processus: ["toolhost"], acces: "enveloppe", traiter });
  return [
    route("GET", "/api/sandbox/me", (q, r) => meGet(q, r, log)),
    route("POST", "/api/sandbox/me", (q, r) => mePost(q, r, log)),
    route("POST", "/api/sandbox/me/restart", (q, r) => meRestart(q, r, log)),
    route("DELETE", "/api/sandbox/me", meDelete),
  ];
}
