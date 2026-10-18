// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/git/clone.ts — `git_clone` et `git_set_credential` (git_tools.py) : clone par le relais authentifiant, identifiant saisi enregistré par le core pour l'hôte du dépôt. */
import type { Dict } from "@elpis/commun";
import { lowerPy, prefixePy, reprPy, stripPy } from "@elpis/commun";
import { AgentError } from "@elpis/fichiers";
import { ok } from "@elpis/outils-mcp";

import { agentEnAnglais } from "../anglais";
import {
  baseParDefaut,
  brancheValide,
  errGit,
  estErreurValeur,
  etendreTilde,
  executerReseau,
  reussi,
  strExc,
} from "./commun";
import type { CompteGit } from "./commun";

/** Identifiant enregistré par le core : id du connecteur (`null` : refusé), hôte, raison d'un refus (`host_not_registered`). */
export interface IdentifiantEnregistre {
  readonly connector_id: number | null;
  readonly host: string;
  readonly refus: string | null;
}

/** `save_git_credential` par le core pour le compte (enveloppe signée), origine « agent » ; `null` : core injoignable. */
export type EnregistrerIdentifiant = (
  compte: { readonly user_id: number; readonly username: string },
  cible: string,
  utilisateur: string,
  jeton: string,
  typeFournisseur: string,
) => Promise<IdentifiantEnregistre | null>;

const HOTE_NON_ENREGISTRE =
  "No Git Connector exists for this host yet (neither the account's nor an admin's), and a tool cannot create one. " +
  "Ask the user to add this connector with their token in Settings → Git Connectors; clone / push / pull / git_submit will then use it AUTOMATICALLY (no need to pass the token again).";

const CONNECTEUR_EXISTANT =
  "A Git Connector entered in Settings (or imported) already exists for this host, and a tool does not modify it. " +
  "Its token is already used AUTOMATICALLY by clone / push / pull / git_submit; to change it, the user edits it in Settings → Git Connectors.";
/** Marche à suivre rendue à l'agent pour chaque refus du core. */
const REFUS: ReadonlyMap<string, string> = new Map([
  ["host_not_registered", HOTE_NON_ENREGISTRE],
  ["connector_exists", CONNECTEUR_EXISTANT],
]);

export interface ArgsClone {
  url: string;
  into_path: string;
  branch: string;
  username: string;
  token: string;
}

/** `PurePosixPath(p)` : absolu ?, parties sans `.` ni vides, `as_posix()`. */
function cheminPosix(brut: string): { absolu: boolean; parties: string[]; posix: string } {
  const p = etendreTilde(brut);
  const parties = p.split("/").filter((x) => x !== "" && x !== ".");
  const absolu = p.startsWith("/");
  return { absolu, parties, posix: (absolu ? "/" : "") + parties.join("/") || "." };
}

/** `git_clone` : dossier déduit de l'URL, identifiant saisi (prioritaire, enregistré après un clone réussi) ou du connecteur, clone par le relais. */
export async function gitClone(
  c: CompteGit,
  enregistrer: EnregistrerIdentifiant | null,
  a: ArgsClone,
): Promise<Dict> {
  try {
    const url = stripPy(a.url || "");
    let dest = a.into_path;
    if (!dest) {
      const m = /\/([^/]+?)(?:\.git)?\/?$/u.exec(url);
      if (!m) return errGit("cannot_infer_path", "Pass into_path='<dir>' explicitly.");
      dest = m[1] as string;
    }
    const p = cheminPosix(dest);
    if (p.absolu || p.parties.includes(".."))
      return errGit("bad_into_path", "into_path must be relative + no '..'.");
    const rel = p.posix;
    let e: Dict;
    let eg: Dict;
    try {
      [e = {}, eg = {}] = await c.esp.stats([rel, `${rel}/.git`]);
    } catch (x) {
      if (!(x instanceof AgentError)) throw x;
      return errGit(x.code, agentEnAnglais(x.code, x.message));
    }
    if (e["kind"] === "error")
      return errGit(
        "target_outside_sandbox",
        `into_path is not usable in the sandbox: ${String(e["error"] ?? "None")}`,
      );
    if (e["kind"] !== "missing") {
      if (eg["kind"] === "dir" || eg["kind"] === "file")
        return errGit(
          "repo_exists",
          `A git repo already exists at ${dest}. Use git_start_work to begin work, or pick a different into_path.`,
        );
      return errGit(
        "path_exists",
        `${dest} already exists (non-empty). Pick a different into_path or clean up first.`,
      );
    }
    const uid = await c.uid();
    const saisi = Boolean(a.token && stripPy(a.token));
    let cred: readonly [string, string] | null = null;
    if (saisi) cred = [stripPy(a.username || ""), stripPy(a.token)];
    else if (uid)
      try {
        await c.esp.gitAnciensIdentifiants(uid, c.username);
        const d = await c.source.gitCredential(uid, url);
        if (d && d["token"]) cred = [String(d["username"] ?? ""), String(d["token"])];
      } catch {
        cred = null;
      }
    const avecJeton = Boolean(cred?.[1]);
    const cmd = ["git", "clone"];
    if (a.branch) cmd.push("--branch", brancheValide(a.branch), "--single-branch");
    cmd.push("--", url, rel);
    const jumeau = await c.esp.jumeauUnicode(rel);
    const cl = await executerReseau(c, "", cmd.slice(1), {
      url,
      timeout: 120,
      auth: avecJeton ? cred : null,
    });
    if (["blocked_remote", "scheme_not_relayed", "malformed_url"].includes(String(cl["error"])))
      return errGit(
        `clone_url_blocked: ${String(cl["fix"] || cl["message"])}`,
        "Only http(s) URLs allowed (no ssh/file/git:, no embedded creds) and the host must not resolve to a loopback or link-local address (SSRF protection).",
      );
    if (!reussi(cl)) {
      const detail = stripPy(String(cl["stderr"] || cl["stdout"] || cl["fix"] || ""));
      const conseil = avecJeton
        ? "Check the connector's token, the URL, or the network connectivity."
        : "Private repo? Register a Git Connector for this host in Settings → Git Connectors: its token will be used AUTOMATICALLY (no need to pass it here, and the URL cannot carry it).";
      return errGit(
        "clone_failed",
        `git clone failed: ${prefixePy(detail, 400) || "no output"}. ${conseil}`,
        {
          remote: url,
          credentialed: avecJeton,
        },
      );
    }
    let enregistre = false;
    let refus: string | null = null;
    if (saisi && uid && enregistrer)
      try {
        const r = await enregistrer({ user_id: uid, username: c.username }, url, a.username, a.token, "");
        enregistre = Boolean(r?.connector_id);
        refus = r?.refus ?? null;
      } catch {
        enregistre = false;
      }
    let base: string;
    try {
      base = await baseParDefaut(c, rel);
    } catch {
      base = "?";
    }
    const out = ok({
      path: rel,
      remote: url,
      default_branch: base,
      credentials_saved: enregistre,
      next_step: `Call git_start_work(repo=${reprPy(rel)}, branch_intent='<describe>') to begin work.`,
    });
    if (jumeau) out["warning"] = jumeau;
    const note = refus === null ? undefined : REFUS.get(refus);
    if (note !== undefined) out["credentials_note"] = note;
    return out;
  } catch (e) {
    if (estErreurValeur(e)) return errGit(e.message);
    return errGit(`unexpected: ${strExc(e)}`);
  }
}

/** `git_set_credential` : identifiant d'un hôte enregistré par le core (compte de l'appel, jamais `no_user` sur un hôte distant). */
export async function gitSetCredential(
  c: CompteGit,
  enregistrer: EnregistrerIdentifiant | null,
  a: { target: string; token: string; username: string; provider_type: string },
): Promise<Dict> {
  try {
    if (!a.target || !stripPy(a.target))
      return errGit("target_required", "Pass a repo URL or a host (e.g. 'git.example.lan:3000').");
    if (!a.token || !stripPy(a.token)) return errGit("token_required", "token (PAT/password) required.");
    const uid = await c.uid();
    if (!uid) return errGit("no_user", "User not found.");
    const r = enregistrer
      ? await enregistrer(
          { user_id: uid, username: c.username },
          a.target,
          a.username,
          a.token,
          a.provider_type,
        )
      : null;
    if (r === null)
      return errGit(
        "credential_store_unavailable",
        "The application could not be reached to store the credential; retry in a moment.",
      );
    const note = r.refus === null ? undefined : REFUS.get(r.refus);
    if (r.refus !== null && note !== undefined) return errGit(r.refus, note, { host: lowerPy(r.host) });
    if (!r.connector_id)
      return errGit("bad_target", "Cannot deduce the host from 'target': pass a repo URL or 'host:port'.");
    const h = lowerPy(r.host);
    return ok({
      connector_id: r.connector_id,
      host: h,
      message: `Git credentials stored for ${reprPy(h)}. clone / push / pull / git_submit on this host will use them AUTOMATICALLY (no need to pass them again).`,
    });
  } catch (e) {
    return errGit(`unexpected: ${strExc(e)}`);
  }
}
