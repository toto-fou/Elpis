// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/git/clone.ts — `git_clone` (git_tools.py) : clone par le relais authentifiant, avec le jeton du compte git de l'hôte lu par le core (aucun jeton n'est reçu de l'agent). */
import type { Dict } from "@elpis/commun";
import { prefixePy, reprPy, stripPy } from "@elpis/commun";
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

/** Marche à suivre rendue à l'agent quand un dépôt exige un identifiant : seul l'utilisateur en saisit, dans ses réglages. */
export const SANS_COMPTE_GIT =
  "Private repo? Ask the user to add a Git account for this host in Settings › Git accounts: " +
  "its token is then used automatically by clone / push / pull / git_submit. A token is never passed to a tool, nor in the URL.";

export interface ArgsClone {
  url: string;
  into_path: string;
  branch: string;
}

/** `PurePosixPath(p)` : absolu ?, parties sans `.` ni vides, `as_posix()`. */
function cheminPosix(brut: string): { absolu: boolean; parties: string[]; posix: string } {
  const p = etendreTilde(brut);
  const parties = p.split("/").filter((x) => x !== "" && x !== ".");
  const absolu = p.startsWith("/");
  return { absolu, parties, posix: (absolu ? "/" : "") + parties.join("/") || "." };
}

/** `git_clone` : dossier déduit de l'URL, jeton du compte git de l'hôte (lu par le core), clone par le relais. */
export async function gitClone(c: CompteGit, a: ArgsClone): Promise<Dict> {
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
    let cred: readonly [string, string] | null = null;
    if (uid)
      try {
        await c.esp.gitAnciensIdentifiants(uid, c.username);
        const d = await c.source.gitCredential({ user_id: uid, username: c.username }, url);
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
        ? "Check the Git account's token (the user updates it in Settings › Git accounts), the URL, or the network connectivity."
        : SANS_COMPTE_GIT;
      return errGit(
        "clone_failed",
        `git clone failed: ${prefixePy(detail, 400) || "no output"}. ${conseil}`,
        {
          remote: url,
          credentialed: avecJeton,
        },
      );
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
      next_step: `Call git_start_work(repo=${reprPy(rel)}, branch_intent='<describe>') to begin work.`,
    });
    if (jumeau) out["warning"] = jumeau;
    return out;
  } catch (e) {
    if (estErreurValeur(e)) return errGit(e.message);
    return errGit(`unexpected: ${strExc(e)}`);
  }
}
