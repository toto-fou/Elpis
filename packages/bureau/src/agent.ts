// SPDX-License-Identifier: MIT
/** packages/bureau/src/agent.ts — agent bureau des postes du LAN : cibles permises au compte, résolution par nom (jamais d'URL venue du client), transport HTTP et erreurs harmonisées (desktop_tools, desktop/access). */
import { estDict, getPy, pyJsonLoads, stripPy, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, getDesktopTargets, reloadDesktopConfigFromDisk } from "@elpis/config";
import type { CibleDesktop } from "@elpis/config";
import { Agent, request } from "undici";

import { agentUtilisateur, err } from "./ports";
import {
  contexteRequests,
  corpsJsonRequests,
  ErreurRequests,
  texteJsonRequests,
  traduire,
  validerUrl,
  verifierSchema,
} from "./requetes";
import { getActiveTarget } from "./session";

export type Cible = CibleDesktop;

/** Comptes vus du bureau (`get_user` : administrateur ?) ; absent, personne n'est administrateur (le `except` de Python). */
export interface ComptesBureau {
  estAdmin(nom: string): Promise<boolean>;
}

let comptes: ComptesBureau | null = null;

export function installerComptesBureau(port: ComptesBureau | null): void {
  comptes = port;
}

async function estAdmin(nom: string): Promise<boolean> {
  try {
    return comptes !== null && (await comptes.estAdmin(nom));
  } catch {
    return false;
  }
}

/** `_toolkit.ok`. */
export function ok(champs: Dict = {}): Dict {
  return { ok: true, ...champs };
}

/** `target_allowed` : `access: list` = administrateurs et `allowed_users` ; identité inconnue refusée. */
export async function targetAllowed(
  cible: Cible | null | undefined,
  username: string,
  admin: boolean | null = null,
): Promise<boolean> {
  if (!cible) return false;
  if ((cible.access || "all") !== "list") return true;
  const nom = stripPy(username || "");
  if (!nom) return false;
  if ((cible.allowed_users ?? []).includes(nom)) return true;
  return admin === null ? estAdmin(nom) : admin;
}

/** `allowed_targets` : cibles permises au compte, dans l'ordre de la configuration. */
export async function allowedTargets(cibles: readonly Cible[], username: string): Promise<Cible[]> {
  const admin = username ? await estAdmin(stripPy(username)) : false;
  const permises: Cible[] = [];
  for (const c of cibles) if (await targetAllowed(c, username, admin)) permises.push(c);
  return permises;
}

/** `reload_desktop_config_from_disk` sans échec : la dernière configuration connue reste en place. */
export function rechargerCibles(): void {
  try {
    reloadDesktopConfigFromDisk();
  } catch {
    return;
  }
}

/** `_resolve_target` : nom explicite > cible active du compte > cible `default` > première permise ; `null` sans cible. */
export async function resolveTarget(name: string, username = ""): Promise<Cible | null> {
  rechargerCibles();
  let nom = name;
  if (!nom && username) {
    try {
      nom = (await getActiveTarget(username)) || "";
    } catch {
      nom = "";
    }
  }
  const cibles = await allowedTargets(getDesktopTargets(false), username);
  if (nom) for (const c of cibles) if (c.name === nom) return c;
  for (const c of cibles) if (c.default) return c;
  return cibles[0] ?? null;
}

/** `_resolve_target_strict` : un nom explicite inconnu ne retombe jamais sur une autre machine. */
export async function resolveTargetStrict(name: string, username = ""): Promise<Cible | null> {
  const cible = await resolveTarget(name, username);
  const nom = stripPy(strPy(name ?? ""));
  if (cible && nom && cible.name !== nom) return null;
  return cible;
}

export function noTargetErr(): Dict {
  return err("no_target", "no desktop control target is configured", {
    fix: "add one in Admin → Vision & Desktop (name, OS, agent URL)",
    nextAction: "ask the user to configure a target, then retry",
  });
}

export function unknownTargetErr(name: string): Dict {
  if (!stripPy(strPy(name ?? ""))) return noTargetErr();
  return err("no_target", `cible inconnue : « ${name} »`, {
    fix: "use a target name from Admin → Vision & Desktop (exact spelling)",
    retryable: false,
  });
}

/** Points de terminaison en lecture pure : rejoués sur erreur réseau ; tout le reste est mutant (jamais rejoué). */
export const RETRY_ON_CONN: ReadonlySet<string> = new Set([
  "/health",
  "/monitors",
  "/screenshot",
  "/ui_tree",
  "/windows",
  "/clipboard_get",
  "/wait_window",
  "/wait_element",
]);
/** Sur délai de lecture, les `/wait_*` ne sont pas rejoués : l'attente aurait doublé. */
export const RETRY_ON_TIMEOUT: ReadonlySet<string> = new Set(
  [...RETRY_ON_CONN].filter((e) => e !== "/wait_window" && e !== "/wait_element"),
);
const CONNEXION = new Set(["ConnectionError", "ConnectTimeout", "SSLError", "ProxyError"]);
const DELAI = new Set(["ReadTimeout", "Timeout"]);

/** Attente entre deux essais ; remplaçable par les tests. */
export const ATTENTE_AGENT = { dormir: (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)) };

type Reponse = { statut: number; corps: Uint8Array; typeContenu: string | null };

const agents = new Map<number, Agent>();

/** Session réutilisée (keep-alive, 16 connexions par hôte), un pool par délai de connexion. */
function agentHttp(delaiMs: number): Agent {
  let a = agents.get(delaiMs);
  if (a === undefined) {
    a = new Agent({
      connect: { timeout: delaiMs, secureContext: contexteRequests() },
      connections: 16,
      allowH2: false,
    });
    agents.set(delaiMs, a);
  }
  return a;
}

/** Ferme les connexions gardées vers les agents (arrêt du process, tests). */
export async function fermerAgentsBureau(): Promise<void> {
  const tous = [...agents.values()];
  agents.clear();
  await Promise.allSettled(tous.map((a) => a.close()));
}

async function envoyer(
  brute: string,
  methode: string,
  corps: Buffer | null,
  delaiS: number,
): Promise<Reponse> {
  const url = validerUrl(brute);
  verifierSchema(url);
  try {
    new URL(url);
  } catch (e) {
    throw new ErreurRequests("InvalidURL", `Invalid URL '${url}'`, { cause: e });
  }
  const ms = Math.max(1, Math.round(delaiS * 1000));
  const entetes: Record<string, string> = {
    accept: "*/*",
    "user-agent": agentUtilisateur(),
    "x-elpis-timeout": strPy(delaiS),
  };
  if (corps !== null) entetes["content-type"] = "application/json";
  let recues = false;
  try {
    const r = await request(url, {
      method: methode as "GET",
      headers: entetes,
      body: corps ?? undefined,
      dispatcher: agentHttp(ms),
      headersTimeout: ms,
      bodyTimeout: ms,
    });
    recues = true;
    const octets = new Uint8Array(await r.body.arrayBuffer());
    const type = r.headers["content-type"];
    return {
      statut: r.statusCode,
      corps: octets,
      typeContenu: Array.isArray(type) ? type.join(", ") : (type ?? null),
    };
  } catch (e) {
    throw traduire(e, recues);
  }
}

/** `_agent_err_message` : motif d'une réponse en erreur (`detail`, `error`, `message`), sinon `null`. */
export function agentErrMessage(r: Reponse): string | null {
  let corps: unknown;
  try {
    corps = pyJsonLoads(texteJsonRequests(r));
  } catch {
    return null;
  }
  if (!estDict(corps)) return null;
  for (const k of ["detail", "error", "message"]) {
    const v = getPy(corps, k);
    if (typeof v === "string" && stripPy(v)) return v;
  }
  return null;
}

/** `_agent_req` : appel de l'agent ; rejeu borné (`desktop.transport_retries`) des seules lectures sur erreur réseau, réponse JSON ou `err()` harmonisé. */
export async function agentReq(
  cible: Cible,
  endpoint: string,
  payload: Dict | null = null,
  methode: "GET" | "POST" = "POST",
  timeout: number | null = null,
): Promise<Dict> {
  const url = cible.agent_url.replace(/\/+$/, "") + endpoint;
  const t = timeout ?? config.DESKTOP_AGENT_TIMEOUT_SEC;
  const essais = config.DESKTOP_TRANSPORT_RETRIES;
  let tentative = 0;
  let r: Reponse;
  for (;;) {
    try {
      r = await envoyer(url, methode, methode === "GET" ? null : corpsJsonRequests(payload ?? {}), t);
      break;
    } catch (e) {
      const nom = e instanceof Error ? e.name : "";
      if (CONNEXION.has(nom)) {
        if (tentative < essais && RETRY_ON_CONN.has(endpoint)) {
          tentative += 1;
          await ATTENTE_AGENT.dormir(300 * tentative);
          continue;
        }
        return err(
          "agent_unreachable",
          `control-agent for '${cible.name}' is unreachable at ${cible.agent_url}`,
          { fix: "check the agent is running on the target and agent_url/port are correct", retryable: true },
        );
      }
      if (DELAI.has(nom)) {
        if (tentative < essais && RETRY_ON_TIMEOUT.has(endpoint)) {
          tentative += 1;
          await ATTENTE_AGENT.dormir(300 * tentative);
          continue;
        }
        return err("agent_timeout", `control-agent for '${cible.name}' timed out after ${t}s`, {
          fix: "the target may be busy; retry, or raise desktop.agent_timeout_sec",
          retryable: true,
        });
      }
      return err("agent_error", e instanceof Error ? e.message : strPy(e));
    }
  }
  if (r.statut === 501)
    return err("agent_unsupported", agentErrMessage(r) || "the agent cannot perform this on the target", {
      fix:
        "this op may be unavailable on the target's session (e.g. Wayland " +
        "input blocked), OR the control-agent on the VM is OUTDATED and does " +
        "not implement this op yet — redeploy desktop-agent and restart it",
      endpoint,
    });
  if (r.statut === 503)
    return err("agent_busy", agentErrMessage(r) || "the control-agent is busy or an operation is stuck", {
      fix: "wait for the current op to finish, or restart the agent on the VM (run.bat)",
      endpoint,
      retryable: false,
    });
  if (r.statut !== 200)
    return err("agent_http_error", agentErrMessage(r) || `control-agent returned ${r.statut}`, {
      status: r.statut,
    });
  let data: unknown;
  try {
    data = pyJsonLoads(texteJsonRequests(r));
  } catch {
    return err("agent_bad_response", "control-agent returned non-JSON");
  }
  if (estDict(data) && data["ok"] === false && veritePy(getPy(data, "error")))
    return err("agent_op_failed", strPy(data["error"]));
  return estDict(data) ? data : { ok: true, result: data };
}
