// SPDX-License-Identifier: MIT
/** apps/core/src/familles/bureau.ts — `/api/desktop/*`, `/agent`, `/agent.ps1` : cibles du compte, capture annotée, action, OCR, lancement, scripts d'automatisation sur les postes du LAN, vision pour les scripts, paquets et installeurs (shared_infra/desktop/routes.py). */
import { creerJeton, exigerUtilisateur, getUsernameById, resoudreJeton } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import {
  arrondiEntierPy,
  arrondiPy,
  ErreurPython,
  estDict,
  floatPy,
  getPy,
  HttpError,
  intPy,
  lowerPy,
  ouPy as ou,
  reprPy,
  stripPy,
  strPy,
  texteOu,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, getDesktopTargets } from "@elpis/config";
import type { Base } from "@elpis/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import {
  actCore,
  agentReq,
  allowedTargets,
  archiveAgent,
  automationFileCore,
  automationStatusCore,
  b64decodePy,
  b64decodeStrict,
  bundleSlug,
  detect,
  getActiveTarget,
  installPs1,
  installSh,
  intOu,
  launchCore,
  listMonitorsCore,
  observeCore,
  paquetAutomatisation,
  pngSize,
  probeTreeCore,
  pushAutomationCore,
  readTextCore,
  rechargerCibles,
  registerDesktopFrameOwner,
  resolveTargetStrict,
  runAutomationCore,
  selectMonitorCore,
  setActiveTarget,
  startAutomationCore,
  waitStable,
  waitWindowCore,
} from "../bureau";
import { urlDeBase } from "../comptes/aides";
import { journal } from "../journal";
import { createNotification } from "../notifications/stockage";
import type { Famille } from "../routes";
import { jetonPresente } from "./cli";
import { utilisateur } from "./comptes";
import { corpsJsonValeurs, entrees, py, reponseJsonPy } from "@elpis/http";
import type { Borne } from "@elpis/http";

const log = journal("desktop");
/** Corps de `locate` : image de 16 Mio au plus en base64 (≈ 21,4 Mio), description et marge. */
const CORPS_LOCALISER_MAX = 32 * 1024 * 1024;

export interface DependancesBureau {
  readonly base: Base;
  readonly auth: DependancesAuth & DependancesJetons;
  /** Session web de `/api/desktop/locate` (`require_user_id`) ; par défaut, celle de l'application. */
  readonly session?: (req: FastifyRequest) => Promise<number>;
}

/** `_username_for` : nom du compte de la session, sinon de la base, sinon `user_<id>`. */
async function nomCompte(base: Base, req: FastifyRequest): Promise<string> {
  const uid = utilisateur(req);
  const connu = req.utilisateur?.username;
  if (connu) return connu;
  try {
    return (await getUsernameById(base, uid)) || `user_${uid}`;
  } catch {
    return `user_${uid}`;
  }
}

/** `await request.json()` gardé : corps illisible → `{}`. */
function corpsOuVide(req: FastifyRequest): unknown {
  try {
    return corpsJsonValeurs(req);
  } catch {
    return {};
  }
}

/** Corps en dict (sinon `{}`), comme `if not isinstance(body, dict): body = {}`. */
const corpsDict = (req: FastifyRequest): Dict => {
  const b = corpsOuVide(req);
  return estDict(b) ? b : {};
};

/** `str(body.get(cle) or "").strip()`. */
const champ = (b: Dict, cle: string): string => stripPy(texteOu(getPy(b, cle), ""));

/** `max(bas, min(haut, int(v or defaut)))`, illisible → `defaut`. */
function borne(v: unknown, defaut: number, bas: number, haut: number): number {
  try {
    return Math.max(bas, Math.min(haut, intPy(ou(v, defaut))));
  } catch (e) {
    if (e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError")) return defaut;
    throw e;
  }
}

/** Champs de trame communs (capture, act, launch…) : propriété du jeton enregistrée, URL, dimensions, signature. */
async function champsTrame(res: Dict, username: string, target: string): Promise<Dict> {
  const jeton = getPy(res, "frame_token");
  if (veritePy(jeton)) await registerDesktopFrameOwner(strPy(jeton), username);
  const ts = Math.trunc(Date.now());
  return {
    image_url: veritePy(jeton) ? `/api/desktop/frame/${strPy(jeton)}?t=${ts}` : "",
    img_w: ou(getPy(res, "img_w"), 0),
    img_h: ou(getPy(res, "img_h"), 0),
    target: ou(getPy(res, "target"), target),
    sig: ou(getPy(res, "sig"), ""),
    ts,
  };
}

/** Échec d'une primitive : 400 avec le code (ou le défaut), le message et éventuellement le correctif. */
function echec(rep: FastifyReply, res: Dict, code: string, message: unknown, avecFix: boolean): FastifyReply {
  const corps: Dict = {
    ok: false,
    error: getPy(res, "error", code),
    message: getPy(res, "message", message),
  };
  if (avecFix) corps["fix"] = getPy(res, "fix");
  return reponseJsonPy(rep.code(400), corps);
}

const echoue = (res: Dict): boolean => res["ok"] === false;

/** Nom de fichier d'un en-tête : Starlette encode en latin-1 et lève au-delà. */
function latin1(valeur: string): string {
  if ([...valeur].some((c) => (c.codePointAt(0) ?? 0) > 0xff))
    throw new Error("'latin-1' codec can't encode characters in header value");
  return valeur;
}

export function creerFamilleBureau(dep: DependancesBureau): Famille {
  const { base } = dep;
  const sessionWeb = dep.session ?? ((req: FastifyRequest) => exigerUtilisateur(req, dep.auth));
  const comptesVision = new WeakMap<FastifyRequest, number>();

  /** `_vision_credentials` : URL de l'instance + jeton de vision du compte (`evt_`, 12 h) ; `vision: false` → rien. */
  const credentialsVision = async (req: FastifyRequest, b: Dict): Promise<[string, string]> => {
    if (!veritePy(getPy(b, "vision", true))) return ["", ""];
    try {
      const [jeton] = await creerJeton(dep.auth, utilisateur(req), "vision", "vision");
      return [urlDeBase(req), jeton];
    } catch (e) {
      log.warn({ err: e }, "[desktop] jeton de vision non créé");
      return ["", ""];
    }
  };

  const cibles = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    const username = await nomCompte(base, req);
    rechargerCibles();
    const sures = (await allowedTargets(getDesktopTargets(false), username)).map((t) => ({
      name: t.name,
      os: t.os ?? "linux",
      default: veritePy(t.default),
    }));
    return reponseJsonPy(rep, { targets: sures, count: sures.length });
  };

  const cibleActive = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> =>
    reponseJsonPy(rep, { target: await getActiveTarget(await nomCompte(base, req)) });

  const choisirCible = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    const username = await nomCompte(base, req);
    const b = corpsOuVide(req);
    const target = estDict(b) ? champ(b, "target") : "";
    if (target && !(await allowedTargets(getDesktopTargets(true), username)).some((t) => t.name === target))
      throw new HttpError(400, `cible inconnue : ${target}`);
    await setActiveTarget(username, target);
    return reponseJsonPy(rep, { ok: true, target });
  };

  const ecrans = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    const { target } = entrees(req, { query: { target: py.str().defaut("") } }).query;
    const res = await listMonitorsCore(await nomCompte(base, req), target);
    if (echoue(res))
      return reponseJsonPy(rep.code(400), {
        ok: false,
        error: getPy(res, "error", "monitors_failed"),
        message: getPy(res, "message"),
      });
    return reponseJsonPy(rep, {
      ok: true,
      monitors: ou(getPy(res, "monitors"), []),
      selected: getPy(res, "selected", 1),
    });
  };

  const choisirEcran = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    const username = await nomCompte(base, req);
    const b = corpsOuVide(req);
    const target = estDict(b) ? champ(b, "target") : "";
    let ecran = 1;
    if (estDict(b))
      try {
        ecran = intPy(getPy(b, "monitor", 1));
      } catch (e) {
        if (!(e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError"))) throw e;
        ecran = 1;
      }
    const res = await selectMonitorCore(username, target, ecran);
    if (echoue(res))
      return reponseJsonPy(rep.code(400), { ok: false, error: getPy(res, "error", "select_failed") });
    return reponseJsonPy(rep, { ok: true, selected: getPy(res, "selected", ecran) });
  };

  const capturer = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    const username = await nomCompte(base, req);
    const b = corpsOuVide(req);
    let [target, prompt, scope] = ["", "", ""];
    let [useVision, useTree, stabiliser] = [true, true, false];
    let delaiStabilite = 4000;
    if (estDict(b)) {
      target = champ(b, "target");
      prompt = champ(b, "prompt");
      const brut = veritePy(getPy(b, "raw"));
      useVision = veritePy(getPy(b, "use_vision", !brut));
      useTree = veritePy(getPy(b, "use_tree", true));
      stabiliser = veritePy(getPy(b, "settle"));
      delaiStabilite = borne(getPy(b, "settle_timeout_ms"), 4000, 500, 15000);
      scope = lowerPy(champ(b, "scope"));
    }
    if (scope !== "focus" && scope !== "monitor" && scope !== "desktop") scope = "monitor";
    let maxNodes = intPy(config.DESKTOP_STUDIO_MAX_NODES || 2000);
    if (estDict(b) && getPy(b, "max_nodes") !== null)
      try {
        maxNodes = Math.max(100, Math.min(5000, intPy(getPy(b, "max_nodes"))));
      } catch (e) {
        if (!(e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError"))) throw e;
      }
    if (stabiliser) await waitStable(username, target, { timeoutMs: delaiStabilite }).catch(() => undefined);
    const res = await observeCore(username, target, {
      prompt,
      use_vision: useVision,
      use_tree: useTree,
      scope,
      max_nodes: maxNodes,
    });
    if (echoue(res)) {
      log.warn(
        `[desktop_capture] échec user=${username} target=${reprPy(target || "(défaut)")} → ` +
          `${strPy(getPy(res, "error"))} : ${strPy(getPy(res, "message"))}`,
      );
      return echec(rep, res, "capture_failed", "capture failed", true);
    }
    const jeton = getPy(res, "frame_token");
    if (veritePy(jeton)) await registerDesktopFrameOwner(strPy(jeton), username);
    const ts = Math.trunc(Date.now());
    return reponseJsonPy(rep, {
      ok: true,
      image_url: veritePy(jeton) ? `/api/desktop/frame/${strPy(jeton)}?t=${ts}` : "",
      img_w: ou(getPy(res, "img_w"), 0),
      img_h: ou(getPy(res, "img_h"), 0),
      boxes: ou(getPy(res, "elements"), []),
      target: ou(getPy(res, "target"), target),
      sig: ou(getPy(res, "sig"), ""),
      ts,
      note: getPy(res, "note"),
      tree_nodes: ou(getPy(res, "tree_nodes"), 0),
      tree_capped: veritePy(getPy(res, "tree_capped")),
    });
  };

  const lire = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    const username = await nomCompte(base, req);
    const b = corpsOuVide(req);
    let [target, query, elementId] = ["", "", ""];
    let region: unknown = null;
    if (estDict(b)) {
      [target, query, elementId] = [champ(b, "target"), champ(b, "query"), champ(b, "element_id")];
      const r = getPy(b, "region");
      if (Array.isArray(r) && r.length >= 4) region = r;
    }
    const res = await readTextCore(username, target, query, elementId, region);
    if (echoue(res)) return echec(rep, res, "read_failed", "read failed", true);
    return reponseJsonPy(rep, {
      ok: true,
      text: ou(getPy(res, "text"), ""),
      region: getPy(res, "region"),
      box: getPy(res, "box"),
      chars: ou(getPy(res, "chars"), 0),
    });
  };

  const agir = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    const username = await nomCompte(base, req);
    const b = corpsDict(req);
    const target = champ(b, "target");
    const op = champ(b, "op");
    if (!op) throw new HttpError(400, "op required");
    let stabilite = intPy(config.DESKTOP_STUDIO_ACT_SETTLE_MS || 0);
    if (getPy(b, "settle_ms") !== null)
      try {
        stabilite = Math.max(0, Math.min(10000, intPy(getPy(b, "settle_ms"))));
      } catch (e) {
        if (!(e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError"))) throw e;
      }
    const observerApres = veritePy(getPy(b, "observe_after", true));
    let scope = lowerPy(champ(b, "scope"));
    if (scope !== "focus" && scope !== "monitor" && scope !== "desktop") scope = "monitor";
    const texte = (cle: string, defaut = ""): string => texteOu(getPy(b, cle), defaut);
    const optionnel = (cle: string): number | null => entierOptionnel(getPy(b, cle));
    const kw: Dict = {
      op,
      settle_ms: stabilite,
      element_id: texte("element_id"),
      query: texte("query"),
      auto_id: texte("auto_id"),
      name: texte("name"),
      control_type: texte("control_type"),
      x: optionnel("x"),
      y: optionnel("y"),
      x2: optionnel("x2"),
      y2: optionnel("y2"),
      text: texte("text"),
      keys: texte("keys"),
      button: texte("button", "left"),
      clicks: intOu(getPy(b, "clicks"), 1),
      dy: intOu(getPy(b, "dy"), 0),
      modifiers: texte("modifiers"),
      observe_after: observerApres,
      semantic_click: op === "type" || op === "paste",
      expect_sig: texte("expect_sig"),
    };
    const res = await actCore(username, target, kw);
    const champsArbre = async (): Promise<Dict> => {
      if (!observerApres || op === "copy") return {};
      const sonde = await probeTreeCore(username, target, scope, intPy(config.DESKTOP_STUDIO_MAX_NODES || 0));
      if (echoue(sonde) || veritePy(getPy(sonde, "error")))
        return { boxes: [], tree_nodes: 0, tree_capped: false };
      return {
        boxes: ou(getPy(sonde, "elements"), []),
        tree_nodes: intPy(ou(getPy(sonde, "tree_nodes"), 0)),
        tree_capped: veritePy(getPy(sonde, "tree_capped")),
      };
    };
    if (getPy(res, "error") === "type_no_effect")
      return reponseJsonPy(rep, {
        ok: true,
        warning: "type_no_effect",
        message: ou(getPy(res, "message"), "la saisie n'a peut-être pas atteint le champ"),
        op,
        method: getPy(res, "method"),
        ...(await champsTrame(res, username, target)),
        ...(await champsArbre()),
      });
    if (getPy(res, "error") === "stale_frame")
      return reponseJsonPy(rep.code(409), {
        ok: false,
        error: "stale_frame",
        message: ou(getPy(res, "message"), "l'écran a changé depuis la capture"),
        ...(await champsTrame(res, username, target)),
        ...(await champsArbre()),
      });
    if (echoue(res)) {
      log.warn(
        `[desktop_act] échec user=${username} target=${reprPy(target || "(défaut)")} op=${op} → ` +
          `${strPy(getPy(res, "error"))} : ${strPy(getPy(res, "message"))}`,
      );
      return echec(rep, res, "act_failed", "action failed", true);
    }
    return reponseJsonPy(rep, {
      ok: true,
      op: ou(getPy(res, "op"), op),
      point: getPy(res, "point"),
      text: getPy(res, "text"),
      method: getPy(res, "method"),
      settle_ms: getPy(res, "settle_ms"),
      ...(await champsTrame(res, username, target)),
      ...(await champsArbre()),
    });
  };

  const lancer = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    const username = await nomCompte(base, req);
    const b = corpsDict(req);
    const target = champ(b, "target");
    const app = stripPy(texteOu(ou(getPy(b, "app"), getPy(b, "path")), ""));
    if (!app) throw new HttpError(400, "app required");
    const args = texteOu(getPy(b, "args"), "");
    const delai = borne(getPy(b, "timeout_ms"), 15000, 1000, 120000);
    const res = await launchCore(username, target, { app, args, timeout_ms: delai });
    if (echoue(res)) {
      log.warn(
        `[desktop_launch] échec user=${username} target=${reprPy(target || "(défaut)")} app=${reprPy(app)} → ` +
          strPy(getPy(res, "error")),
      );
      return reponseJsonPy(rep.code(400), {
        ok: false,
        error: getPy(res, "error", "launch_failed"),
        message: getPy(res, "message"),
      });
    }
    const trame = await champsTrame(res, username, target);
    return reponseJsonPy(rep, {
      ok: true,
      launched: getPy(res, "launched"),
      found: veritePy(getPy(res, "found")),
      title: getPy(res, "title"),
      auto_id: getPy(res, "auto_id"),
      interaction_state: getPy(res, "interaction_state"),
      ...trame,
    });
  };

  const attendreFenetre = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    const username = await nomCompte(base, req);
    const b = corpsDict(req);
    const target = champ(b, "target");
    const [titre, aid, classe] = ["title_re", "auto_id", "class_name"].map((k) =>
      texteOu(getPy(b, k), ""),
    ) as [string, string, string];
    const pret = veritePy(getPy(b, "ready", true));
    if (!(titre || aid || classe)) throw new HttpError(400, "title_re/auto_id/class_name required");
    const delai = borne(getPy(b, "timeout_ms"), 15000, 1000, 300000);
    const res = await waitWindowCore(username, target, {
      title_re: titre,
      auto_id: aid,
      class_name: classe,
      ready: pret,
      timeout_ms: delai,
    });
    if (echoue(res))
      return reponseJsonPy(rep.code(400), { ok: false, error: getPy(res, "error", "wait_failed") });
    return reponseJsonPy(rep, {
      ok: true,
      found: veritePy(getPy(res, "found")),
      interaction_state: ou(getPy(res, "interaction_state"), ""),
      title: ou(getPy(res, "title"), ""),
      auto_id: ou(getPy(res, "auto_id"), ""),
    });
  };

  const archive = async (_req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    const zip = await archiveAgent(strPy(config.PROJECT_ROOT));
    if (zip === null) throw new HttpError(404, "desktop-agent sources not found on server");
    return rep
      .header("content-disposition", 'attachment; filename="desktop-agent.zip"')
      .type("application/zip")
      .send(zip);
  };

  const libsEt = (b: Dict, cle: string): Dict => {
    const v = getPy(b, cle);
    return estDict(v) ? v : {};
  };

  const executer = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    const username = await nomCompte(base, req);
    const b = corpsDict(req);
    const name = texteOu(getPy(b, "name"), "automatisation");
    const code = texteOu(getPy(b, "code"), "");
    if (!stripPy(code)) throw new HttpError(400, "code required");
    const target = champ(b, "target");
    const brutArgs = getPy(b, "args");
    const args = Array.isArray(brutArgs) ? brutArgs.filter((a) => typeof a === "string") : [];
    const [url, jeton] = await credentialsVision(req, b);
    const push = await pushAutomationCore(
      username,
      target,
      name,
      code,
      libsEt(b, "libs"),
      libsEt(b, "assets"),
    );
    if (veritePy(getPy(push, "error")))
      return reponseJsonPy(rep.code(400), {
        ok: false,
        error: getPy(push, "error"),
        message: getPy(push, "message"),
      });
    const st = await startAutomationCore(username, target, name, {
      dry_run: getPy(b, "dry_run"),
      trace: getPy(b, "trace"),
      repeat: intOu(getPy(b, "repeat"), 0),
      args,
      elpis_url: url,
      elpis_token: jeton,
    });
    if (veritePy(getPy(st, "error")))
      return reponseJsonPy(rep.code(400), {
        ok: false,
        error: getPy(st, "error"),
        message: getPy(st, "message"),
      });
    return reponseJsonPy(rep, {
      ok: true,
      run_id: getPy(st, "run_id"),
      target: getPy(st, "target"),
      name: getPy(st, "name"),
      push_errors: ou(getPy(push, "push_errors"), []),
    });
  };

  const etatExecution = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    const { target, run_id: runId } = entrees(req, {
      query: { target: py.str().defaut(""), run_id: py.str().defaut("") },
    }).query;
    const username = await nomCompte(base, req);
    if (!runId) throw new HttpError(400, "run_id required");
    const st = await automationStatusCore(username, target, runId);
    if (veritePy(getPy(st, "error")))
      return reponseJsonPy(rep.code(400), {
        ok: false,
        error: getPy(st, "error"),
        message: getPy(st, "message"),
      });
    return reponseJsonPy(rep, st);
  };

  const arreterExecution = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    const username = await nomCompte(base, req);
    const b = corpsDict(req);
    const cible = await resolveTargetStrict(texteOu(getPy(b, "target"), ""), username);
    if (!cible) throw new HttpError(400, "cible inconnue");
    return reponseJsonPy(
      rep,
      await agentReq(cible, "/run_stop", { run_id: texteOu(getPy(b, "run_id"), "") }),
    );
  };

  const fichierRapport = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    const { target, path: chemin } = entrees(req, {
      query: { target: py.str().defaut(""), path: py.str().defaut("") },
    }).query;
    const username = await nomCompte(base, req);
    const segments = chemin.replaceAll("\\", "/").split("/");
    if (
      !chemin ||
      segments.some((x) => x === "..") ||
      chemin.startsWith("/") ||
      chemin.startsWith("\\") ||
      (segments[0] ?? "").includes(":")
    )
      throw new HttpError(400, "path invalide");
    const r = await automationFileCore(username, target, chemin);
    if (veritePy(getPy(r, "error")) || !veritePy(getPy(r, "content_b64")))
      throw new HttpError(404, ou(getPy(r, "message"), "fichier introuvable"));
    const contenu = r["content_b64"];
    if (typeof contenu !== "string")
      throw new TypeError("argument should be a bytes-like object or ASCII string");
    const donnees = b64decodePy(contenu);
    const ext = lowerPy(chemin.slice(chemin.lastIndexOf(".") + 1));
    const enLigne: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      json: "application/json",
    };
    rep
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'; img-src data:");
    if (Object.hasOwn(enLigne, ext)) return rep.type(enLigne[ext] ?? "").send(donnees);
    const brut = chemin.replaceAll("\\", "/");
    const nom = (brut.slice(brut.lastIndexOf("/") + 1) || "fichier").replaceAll('"', "");
    return rep
      .header("content-disposition", latin1(`attachment; filename="${nom}"`))
      .type("application/octet-stream")
      .send(donnees);
  };

  const matrice = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    const username = await nomCompte(base, req);
    const uid = utilisateur(req);
    const b = corpsDict(req);
    const code = texteOu(getPy(b, "code"), "");
    const brutes = getPy(b, "targets");
    const targets = Array.isArray(brutes)
      ? brutes.filter((t) => stripPy(texteOu(t, ""))).map((t) => strPy(t))
      : [];
    if (!stripPy(code) || targets.length === 0) throw new HttpError(400, "code et targets requis");
    const [url, jeton] = await credentialsVision(req, b);
    const delai = Math.max(30, Math.min(3600, intOu(getPy(b, "timeout_s"), 600)));
    const doc = await runAutomationCore(
      username,
      targets,
      texteOu(getPy(b, "name"), "automatisation"),
      code,
      {
        dry_run: getPy(b, "dry_run"),
        trace: getPy(b, "trace"),
        timeout_s: delai,
        libs: libsEt(b, "libs"),
        assets: libsEt(b, "assets"),
        notify_user_id: uid,
        notifier: async (u, titre, corps) => {
          await createNotification(base, u, "automation", titre, corps, "automation", null);
        },
        elpis_url: url,
        elpis_token: jeton,
      },
    );
    return reponseJsonPy(rep, doc);
  };

  /** Session web ou jeton de vision (401 sinon), vérifié avant la lecture du corps comme le Python. */
  const compteVision = async (req: FastifyRequest): Promise<number> => {
    const connu = comptesVision.get(req);
    if (connu !== undefined) return connu;
    let uid: number | null;
    try {
      uid = await sessionWeb(req);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      const tok = jetonPresente(req);
      uid = tok ? ((await resoudreJeton(dep.auth, tok, ["vision", "opencode"]))?.user_id ?? null) : null;
    }
    if (uid === null) throw new HttpError(401, "auth requise (session ou jeton de vision)");
    comptesVision.set(req, uid);
    return uid;
  };

  const localiser = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    await compteVision(req);
    const b = corpsDict(req);
    const decrire = champ(b, "describe");
    const img = getPy(b, "image_b64");
    if (!decrire || typeof img !== "string" || !img) throw new HttpError(400, "describe et image_b64 requis");
    let png: Buffer;
    try {
      png = b64decodeStrict(img);
    } catch {
      throw new HttpError(400, "image_b64 invalide");
    }
    if (png.length > 16 * 1024 * 1024) throw new HttpError(413, "image trop volumineuse");
    if (!config.VISION_ENDPOINT_URL)
      return reponseJsonPy(rep.code(503), {
        ok: false,
        error: "no_vision",
        message: "aucun modèle de vision configuré (Admin → Vision & Desktop)",
      });
    const [w, h] = pngSize(png);
    const r = await detect(png, {
      endpoint: config.VISION_ENDPOINT_URL,
      fmt: config.VISION_FORMAT,
      prompt: decrire,
      model: config.VISION_MODEL,
      responseMap: config.VISION_RESPONSE_MAP,
      timeout: config.VISION_TIMEOUT_SEC,
      nativeW: w,
      nativeH: h,
      passes: 1,
    });
    let meilleur: [number[], number, string] | null = null;
    for (const e of r.elements) {
      const boite: unknown = getPy(e, "box");
      if (!Array.isArray(boite) || boite.length < 4) continue;
      const conf = floatPy(ou(getPy(e, "confidence"), 0));
      if (meilleur === null || conf > meilleur[1])
        meilleur = [
          boite.slice(0, 4).map((v) => arrondiEntierPy(floatPy(v))),
          conf,
          texteOu(getPy(e, "label"), ""),
        ];
    }
    if (meilleur === null)
      return reponseJsonPy(rep.code(404), {
        ok: false,
        error: "not_found",
        message: `« ${decrire} » introuvable par la vision`,
      });
    return reponseJsonPy(rep, {
      ok: true,
      box: meilleur[0],
      confidence: versFlottantPy(arrondiPy(meilleur[1], 3)),
      label: meilleur[2],
    });
  };

  const paquet = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    utilisateur(req);
    const b = corpsDict(req);
    const code = texteOu(getPy(b, "code"), "");
    if (!stripPy(code)) throw new HttpError(400, "code required");
    const slug = bundleSlug(ou(getPy(b, "name"), ""));
    const os = lowerPy(champ(b, "os")).startsWith("lin") ? "linux" : "windows";
    const zip = await paquetAutomatisation(strPy(config.PROJECT_ROOT), {
      code,
      slug,
      os,
      wheels: veritePy(getPy(b, "include_wheels")),
      libs: libsEt(b, "libs"),
      assets: libsEt(b, "assets"),
    });
    if (zip === null) throw new HttpError(404, "runtime elpis_auto introuvable sur le serveur");
    return rep
      .header("content-disposition", `attachment; filename="${slug}.zip"`)
      .type("application/zip")
      .send(zip);
  };

  const scriptSh = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> =>
    rep.type("text/x-shellscript; charset=utf-8").send(installSh(urlDeBase(req)));

  const scriptPs1 = async (req: FastifyRequest, rep: FastifyReply): Promise<unknown> => {
    const script = installPs1(urlDeBase(req));
    if (/\P{ASCII}/u.test(script)) log.warn("install.ps1 contient des caractères non-ASCII");
    return rep.type("text/plain; charset=utf-8").send(script);
  };

  const route = (
    methode: "GET" | "POST",
    chemin: string,
    acces: "session" | "public",
    traiter: (req: FastifyRequest, rep: FastifyReply) => Promise<unknown>,
    corps?: Borne,
  ) => ({ methode, chemin, processus: ["main"] as const, acces, traiter, ...(corps ? { corps } : {}) });

  return {
    nom: "bureau",
    routes: [
      route("GET", "/api/desktop/targets", "session", cibles),
      route("GET", "/api/desktop/active-target", "session", cibleActive),
      route("POST", "/api/desktop/active-target", "session", choisirCible),
      route("GET", "/api/desktop/monitors", "session", ecrans),
      route("POST", "/api/desktop/select-monitor", "session", choisirEcran),
      route("POST", "/api/desktop/capture", "session", capturer),
      route("POST", "/api/desktop/read", "session", lire),
      route("POST", "/api/desktop/act", "session", agir),
      route("POST", "/api/desktop/launch", "session", lancer),
      route("POST", "/api/desktop/wait-window", "session", attendreFenetre),
      route("GET", "/api/desktop/agent-bundle", "public", archive),
      route("POST", "/api/desktop/run-automation", "session", executer),
      route("GET", "/api/desktop/run-automation/status", "session", etatExecution),
      route("POST", "/api/desktop/run-automation/stop", "session", arreterExecution),
      route("GET", "/api/desktop/run-file", "session", fichierRapport),
      route("POST", "/api/desktop/run-automation-matrix", "session", matrice),
      route("POST", "/api/desktop/locate", "public", localiser, {
        limite: CORPS_LOCALISER_MAX,
        message: "image trop volumineuse",
        avant: async (req) => void (await compteVision(req)),
      }),
      route("POST", "/api/desktop/automation-bundle", "session", paquet),
      route("GET", "/api/desktop/install.sh", "public", scriptSh),
      route("GET", "/api/desktop/install.ps1", "public", scriptPs1),
      route("GET", "/agent", "public", scriptSh),
      route("GET", "/agent.ps1", "public", scriptPs1),
    ],
  };
}

/** `_opt_int(v, None)` : absent, vide ou illisible → `null` ; un infini lève comme Python. */
function entierOptionnel(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  try {
    return intPy(v);
  } catch (e) {
    if (e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError")) return null;
    throw e;
  }
}
