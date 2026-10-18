// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/git/action.ts — `git_action` (git_tools.py) : init, clone, switch, stage, unstage, restore, fetch, pull, stash, merge, cherry_check ; aucun commit ni push ici. */
import type { Dict } from "@elpis/commun";
import { lowerPy, reprPy, splitlinesPy, stripPy } from "@elpis/commun";
import { AgentError, RelayRefused } from "@elpis/fichiers";
import { ok } from "@elpis/outils-mcp";

import { agentEnAnglais, enAnglais } from "../anglais";
import { avecChangements } from "../changements";
import {
  assurerConfig,
  brancheCourante,
  brancheValide,
  cheminSur,
  cwdConteneur,
  depotSur,
  echecGit,
  errGit,
  estErreurValeur,
  estProtegee,
  executer,
  executerReseau,
  INIT_SCAFFOLD_MSG,
  lectureGit,
  politique,
  refSure,
  reussi,
  sortie,
  strExc,
  tirer,
} from "./commun";
import type { CompteGit } from "./commun";
import { ErreurFichierGit } from "./requete";

export interface ArgsActionGit {
  repo: string;
  action: string;
  branch: string;
  paths: string[];
  create: boolean;
  message: string;
  target: string;
  strategy: string;
  dry_run: boolean;
}

/** Actions qui changent l'arbre de travail : relevées avant/après pour l'historique et les diffs du chat. */
const MUTANTES: ReadonlySet<string> = new Set([
  "switch",
  "restore",
  "pull",
  "stash",
  "stash_pop",
  "merge",
  "cherry_check",
]);

/** `_track_root` : relevé des changements autour d'une action mutante hors `dry_run` (outil sans `action` : toujours). */
export function releve(
  c: CompteGit,
  action: string | undefined,
  dryRun: boolean,
): (() => Promise<readonly [number | null, string] | null>) | null {
  if (action !== undefined && (!MUTANTES.has(action) || dryRun)) return null;
  if (!c.username) return null;
  return async () => [(await c.uid()) || null, c.username];
}

/** Conseil d'une action sortie en erreur, quand la cause n'est pas reconnue. */
const CONSEILS: Readonly<Record<string, string>> = {
  switch: "List the branches with git_query(action='branches'); pass create=True to create a new one.",
  stage: "Check the paths with git_query(action='status'); paths are relative to the repo root.",
  unstage: "Check the paths with git_query(action='status'); paths are relative to the repo root.",
  restore: "Check the paths with git_query(action='status'); paths are relative to the repo root.",
  stash_pop:
    "List the stashes with git_action(action='stash_list'); on conflicts, fix the files with git_write, then stage them.",
  merge: "Check the branch name with git_query(action='branches').",
};

/** Reprise d'une fusion arrêtée sur des conflits. */
const SORTIE_CONFLIT =
  "Resolve each file listed in 'conflicts' with git_write, stage it with git_action(action='stage'), then git_commit. To give up instead, run `git reset --merge` with execute_shell.";

/** `--ff-only` refusé : les branches ont divergé, rien n'a changé. */
function sansAvanceRapide(r: Dict): boolean {
  return /not possible to fast-forward/iu.test(`${sortie(r)}\n${String(r["stderr"] ?? "")}`);
}

/** Fusion sortie en erreur (harnais N-13, GI-08) : avance rapide impossible, conflits listés, ou cause de git. */
async function echecFusion(c: CompteGit, rp: string, b: string, courante: string, r: Dict): Promise<Dict> {
  const ici = courante || "HEAD";
  if (sansAvanceRapide(r))
    return echecGit(
      r,
      "not_fast_forward",
      `${reprPy(ici)} and ${reprPy(b)} have diverged, so a fast-forward is impossible; nothing was changed. Either create a merge commit: git_action(action='merge', branch=${reprPy(b)}, strategy='no-ff') (or strategy='squash', then git_commit), or rebase ${reprPy(ici)} onto ${reprPy(b)} instead of merging (\`git rebase ${b}\` with execute_shell).`,
      { branch: b, current_branch: ici },
    );
  const cr = await lectureGit(c, rp, ["diff", "--name-only", "--diff-filter=U"]);
  const conflits = splitlinesPy(sortie(cr)).filter((l) => stripPy(l));
  if (conflits.length)
    return echecGit(r, "merge_conflict", SORTIE_CONFLIT, {
      branch: b,
      current_branch: ici,
      conflicts: conflits,
    });
  return echecGit(r, "merge_failed", CONSEILS["merge"], { branch: b, current_branch: ici });
}

/** Nom d'un dossier à créer à la racine du bac (`init`, `clone`) ; `null` s'il est valable. */
function nomInvalide(repo: string): Dict | null {
  if (!repo)
    return errGit("repo required", "Pass repo='<n>' — a folder name to create at your sandbox root (/work).");
  if (repo.includes("/") || repo.includes("\\") || repo.includes(".."))
    return errGit(
      `invalid repo name: ${reprPy(repo)}`,
      "Repo name must be a single folder name (no slashes, no '..').",
    );
  if (!/^[A-Za-z0-9._-]+$/u.test(repo))
    return errGit(
      `invalid repo name: ${reprPy(repo)}`,
      "Allowed chars: letters, digits, dot, dash, underscore.",
    );
  if (repo.startsWith(".") || repo === ".git")
    return errGit(`invalid repo name: ${reprPy(repo)}`, "Cannot start with '.' or be named '.git'.");
  return null;
}

async function initOuClone(c: CompteGit, act: string, a: ArgsActionGit): Promise<Dict> {
  const refus = nomInvalide(a.repo);
  if (refus) return refus;
  const repo = a.repo;
  let existe: boolean;
  try {
    existe = (await c.esp.stat(repo))["kind"] !== "missing";
  } catch (e) {
    if (!(e instanceof AgentError)) throw e;
    return errGit(e.code, agentEnAnglais(e.code, e.message));
  }
  if (act === "init") {
    if (existe)
      return errGit(
        `repo_exists: ${repo}`,
        `Folder already exists. Use a different repo name or remove it first via manage_files(action='delete', path=${reprPy(repo)}, recursive=True).`,
      );
    const branche = a.branch ? brancheValide(a.branch) : "main";
    const cmd = ["git", "init", "-q", "-b", branche, repo];
    if (a.dry_run)
      return ok({ dry_run: true, action: "init", repo, would_run: cmd, would_create: cwdConteneur(repo) });
    const jumeau = await c.esp.jumeauUnicode(repo);
    const r = await executer(c, "", cmd);
    if (reussi(r)) {
      await assurerConfig(c, repo);
      const sc = await executer(c, repo, ["git", "commit", "--allow-empty", "-m", INIT_SCAFFOLD_MSG]);
      r["repo"] = repo;
      r["repo_path"] = cwdConteneur(repo);
      r["initial_branch"] = branche;
      r["branch_materialized"] = reussi(sc);
      r["hint"] =
        `Repo initialized — branch '${branche}' exists (scaffold commit). Add files with git_write(repo='${repo}', action='write', path='...', content='...'), then commit with git_commit (the FIRST real commit is allowed directly on '${branche}'; afterwards use git_start_work).`;
      if (jumeau) r["warning"] = jumeau;
    }
    return r;
  }
  if (!a.target)
    return errGit(
      "target required",
      "Pass target='<https-url>' (https:// only). Example: target='https://github.com/user/repo.git'",
    );
  const url = stripPy(a.target);
  if (existe)
    return errGit(
      `repo_exists: ${repo}`,
      `Folder already exists at ${repo}. Pick another repo name or delete it first.`,
    );
  const cmd = ["git", "clone", "--depth", "50"];
  if (a.branch) cmd.push("--branch", brancheValide(a.branch), "--single-branch");
  cmd.push("--", url, repo);
  if (a.dry_run)
    return ok({
      dry_run: true,
      action: "clone",
      repo,
      url,
      would_run: cmd,
      would_create: cwdConteneur(repo),
    });
  const jumeau = await c.esp.jumeauUnicode(repo);
  const r = await executerReseau(c, "", cmd.slice(1), { url, timeout: 120 });
  if (["blocked_remote", "scheme_not_relayed", "malformed_url"].includes(String(r["error"])))
    return errGit(
      `clone_url_blocked: ${String(r["fix"] || r["message"])}`,
      "Only http(s) URLs are accepted: no ssh/file, no embedded credentials, and the host must not resolve to a loopback or link-local address (SSRF protection).",
    );
  if (!reussi(r)) {
    const detail = String(r["stderr"] || r["stdout"] || r["fix"] || r["error"] || "");
    return errGit("clone_failed", `git clone failed: ${[...detail].slice(0, 400).join("")}`, {
      remote: url,
      repo,
      returncode: r["returncode"] ?? null,
    });
  }
  r["repo"] = repo;
  r["repo_path"] = cwdConteneur(repo);
  r["url"] = url;
  r["hint"] =
    `Cloned successfully. List files with git_query(repo='${repo}', action='files') or browse with list_files(path='${repo}').`;
  if (jumeau) r["warning"] = jumeau;
  return r;
}

async function cherryCheck(c: CompteGit, rp: string, cible: string): Promise<Dict> {
  if (!cible) return errGit("target required (ref to pick)");
  const ref = refSure(cible);
  const st = await lectureGit(c, rp, ["status", "--porcelain=v1"], { timeout: 6, maxOut: 10_000 });
  if (st["ok"] !== true) return st;
  const sale = splitlinesPy(sortie(st)).filter((l) => stripPy(l));
  if (sale.length)
    return errGit(
      "dirty_tree",
      "cherry_check undoes its trial pick with 'reset --hard', which would also discard your uncommitted changes. Commit or stash them first (action='stash'), then retry.",
      { action: "cherry_check", target: ref, dirty: sale.slice(0, 50) },
    );
  const r = await executer(c, rp, ["git", "cherry-pick", "--no-commit", ref]);
  const cr = await lectureGit(c, rp, ["diff", "--name-only", "--diff-filter=U"]);
  const conflits = splitlinesPy(sortie(cr)).filter((l) => stripPy(l));
  await executer(c, rp, ["git", "cherry-pick", "--abort"]);
  await executer(c, rp, ["git", "reset", "--hard", "HEAD"]);
  if (!conflits.length && !reussi(r))
    return echecGit(
      r,
      "cherry_check_failed",
      "Pass a single non-merge commit as target (SHA, tag, branch); list them with git_query(action='log').",
      { action: "cherry_check", target: ref },
    );
  return ok({
    action: "cherry_check",
    target: ref,
    would_apply_cleanly: !conflits.length,
    conflicts: conflits,
    note: "This was a simulation. No changes were kept.",
    raw: r,
  });
}

async function actionDepot(c: CompteGit, act: string, a: ArgsActionGit): Promise<Dict> {
  const rp = await depotSur(c.esp, a.repo);
  const lancer = (cmd: string[], libres?: ReadonlySet<number>): Promise<Dict> =>
    a.dry_run
      ? Promise.resolve(ok({ dry_run: true, would_run: cmd }))
      : executer(c, rp, cmd, libres ? { libres } : {});
  switch (act) {
    case "switch": {
      if (!a.branch) return errGit("branch required");
      const b = brancheValide(a.branch);
      return lancer(a.create ? ["git", "switch", "-c", b] : ["git", "switch", b]);
    }
    case "stage":
      return lancer(a.paths.length ? ["git", "add", "--", ...a.paths.map(cheminSur)] : ["git", "add", "-A"]);
    case "unstage":
      return lancer(["git", "reset", "HEAD", "--", ...a.paths.map(cheminSur)]);
    case "restore":
      if (!a.paths.length) return errGit("paths required", "paths=[...] to restore.");
      return lancer(["git", "restore", "--", ...a.paths.map(cheminSur)]);
    case "fetch":
    case "pull": {
      const remote = a.target || "origin";
      refSure(remote);
      const b = a.branch ? brancheValide(a.branch) : "";
      if (act === "fetch") {
        const cmd = ["git", "fetch", "--no-recurse-submodules", remote, ...(b ? [b] : [])];
        if (a.dry_run) return ok({ dry_run: true, would_run: cmd });
        let url: string;
        try {
          url = await c.esp.gitRemoteUrl(rp, remote);
        } catch (e) {
          if (e instanceof RelayRefused) return errGit(e.code, enAnglais(e.message));
          throw e;
        }
        return executerReseau(c, rp, cmd.slice(1), { url, timeout: 60 });
      }
      const mode = (
        { "ff-only": "--ff-only", rebase: "--rebase", merge: "--no-rebase" } as Record<string, string>
      )[lowerPy(a.strategy || "ff-only")];
      if (mode === undefined) return errGit("bad strategy", "ff-only|merge|rebase");
      const ici = b ? (await brancheCourante(c, rp)) || "" : "";
      if (b && b !== ici && estProtegee(ici, await politique(c, rp)))
        return errGit(
          `protected_branch: HEAD is on protected branch ${reprPy(ici)}; git_action never pulls another branch into it (any strategy, dry_run included)`,
          `Pull into your own work branch instead: git_start_work(repo, branch_intent), then git_action(action="pull", branch=${reprPy(b)}); changes reach a protected branch through git_submit. Only if the user explicitly asks for it, run \`git pull ${remote} ${b}\` with execute_shell.`,
          { branch: ici, pull_branch: b },
        );
      if (a.dry_run)
        return ok({ dry_run: true, would_run: ["git", "pull", mode, remote, ...(b ? [b] : [])] });
      const r = await tirer(c, rp, remote, b, mode, 60);
      if (!sansAvanceRapide(r)) return r;
      return echecGit(
        r,
        "not_fast_forward",
        "Your branch and the remote have diverged, so a fast-forward is impossible; nothing was changed. Retry with strategy='rebase' (replays your commits on top of the remote) or strategy='merge' (creates a merge commit).",
      );
    }
    case "stash": {
      const cmd = ["git", "stash", "push", "-u"];
      let libres: ReadonlySet<number> | undefined;
      if (a.message) {
        if ([...a.message].length > 200) return errGit("message too long (max 200)");
        cmd.push("-m", a.message);
        libres = new Set([cmd.length - 1]);
      }
      return lancer(cmd, libres);
    }
    case "stash_pop":
      return lancer(["git", "stash", "pop"]);
    case "stash_list":
      return lectureGit(c, rp, ["stash", "list"]);
    case "merge": {
      if (!a.branch) return errGit("branch required");
      const b = brancheValide(a.branch);
      const option = (
        { "ff-only": "--ff-only", "no-ff": "--no-ff", squash: "--squash" } as Record<string, string>
      )[lowerPy(a.strategy || "ff-only")];
      if (option === undefined) return errGit("bad strategy", "ff-only|no-ff|squash");
      const ici = (await brancheCourante(c, rp)) || "";
      if (estProtegee(ici, await politique(c, rp)))
        return errGit(
          `protected_branch: HEAD is on protected branch ${reprPy(ici)}; git_action never merges into it (any strategy, dry_run included)`,
          `Changes reach a protected branch through review: from the agent branch, git_submit(repo, title, body) pushes it and opens a pull request. Only if the user explicitly asks for a local merge, run \`git merge ${b}\` with execute_shell.`,
          { branch: ici, merge_branch: b },
        );
      const cmd = ["git", "merge", option, b];
      if (a.dry_run)
        return ok({
          dry_run: true,
          would_run: cmd,
          hint: "Merge is destructive; inspect 'conflicts' action after if strategy!=ff-only.",
        });
      const r = await executer(c, rp, cmd);
      return r["ok"] === true && !reussi(r) ? echecFusion(c, rp, b, ici, r) : r;
    }
    case "cherry_check":
      return cherryCheck(c, rp, a.target);
    default:
      return errGit(
        "unknown action",
        "switch|stage|unstage|restore|fetch|pull|stash|stash_pop|stash_list|merge|cherry_check",
      );
  }
}

/** `git_action`, sous le relevé des changements des actions mutantes ; une commande sortie en erreur n'est jamais un succès. */
export function gitAction(c: CompteGit, a: ArgsActionGit): Promise<Dict> {
  return avecChangements("git", releve(c, a.action, a.dry_run), async () => {
    try {
      const act = lowerPy(stripPy(a.action || ""));
      const r =
        act === "init" || act === "clone" ? await initOuClone(c, act, a) : await actionDepot(c, act, a);
      return echecGit(r, `${act}_failed`, CONSEILS[act] ?? "");
    } catch (e) {
      if (estErreurValeur(e) || (e instanceof ErreurFichierGit && e.name === "FileNotFoundError"))
        return errGit(e.message);
      return errGit(`unexpected: ${strExc(e)}`);
    }
  });
}
