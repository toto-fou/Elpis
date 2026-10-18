// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/git/travail.ts — outils d'intention de git_tools.py : git_inspect, git_start_work, git_commit, git_submit (push par le relais, PR ouverte par le core), git_abandon. */
import type { Dict } from "@elpis/commun";
import { BLANC_PY, lowerPy, prefixePy, reprPy, splitlinesPy, stripPy, strPy } from "@elpis/commun";
import { RelayRefused } from "@elpis/fichiers";
import { ok } from "@elpis/outils-mcp";

import { enAnglais } from "../anglais";
import { avecChangements } from "../changements";
import { releve } from "./action";
import {
  assurerConfig,
  baseParDefaut,
  BILAN_STAT,
  brancheAgent,
  brancheCourante,
  cheminSur,
  depotSur,
  entierPy,
  errGit,
  estBrancheAgent,
  estErreurValeur,
  estProtegee,
  executer,
  executerReseau,
  intentionValide,
  lectureGit,
  ligneEchec,
  politique,
  reussi,
  sortie,
  strExc,
  teteNonNee,
  tetePristine,
  tirer,
} from "./commun";
import type { CompteGit } from "./commun";
import { secretsDuDiff } from "./secrets";

/** Diff indexé lu pour la recherche de secrets (caractères) ; au-delà, scan incomplet signalé. */
const DIFF_SCANNE_MAX = 2_000_000;

/** `str.split()` sans argument : mots séparés par les blancs de Python. */
function motsPy(s: string): string[] {
  const t = stripPy(s);
  return t ? t.split(new RegExp(`${BLANC_PY}+`, "u")) : [];
}

/** `str.strip('"')` sur les deux bords. */
function sansGuillemets(s: string): string {
  return s.replace(/^"+|"+$/gu, "");
}

/** `(r.get("stderr", "") or …)[:n]` d'une enveloppe. */
function champ(r: Dict, cle: string, n: number): string {
  const v = r[cle];
  return prefixePy(typeof v === "string" ? v : "", n);
}

/** `ValueError` → enveloppe de son message ; toute autre panne → `unexpected: …`. */
async function garder(f: () => Promise<Dict>): Promise<Dict> {
  try {
    return await f();
  } catch (e) {
    if (estErreurValeur(e)) return errGit(e.message);
    return errGit(`unexpected: ${strExc(e)}`);
  }
}

/** `git_inspect` : branche, base, politique, état sale, avance/retard, 5 derniers commits, remotes. */
export function gitInspect(c: CompteGit, a: { repo: string }): Promise<Dict> {
  return garder(async () => {
    const rp = await depotSur(c.esp, a.repo);
    const br = (await brancheCourante(c, rp)) || "";
    const base = await baseParDefaut(c, rp);
    const pol = await politique(c, rp);
    const st = await lectureGit(c, rp, ["status", "--porcelain=v1"], { timeout: 6, maxOut: 10_000 });
    let [indexes, modifies, nonSuivis] = [0, 0, 0];
    const fichiers: Dict[] = [];
    for (const ligne of splitlinesPy(sortie(st))) {
      if (!ligne) continue;
      const xy = prefixePy(ligne, 2);
      let p = sansGuillemets(stripPy([...ligne].slice(3).join("")));
      if (p.includes(" -> ")) p = sansGuillemets(stripPy(p.slice(p.indexOf(" -> ") + 4)));
      const [x, y] = [...xy];
      if (x !== " " && x !== "?") indexes++;
      if (y !== undefined && y !== " " && y !== "?") modifies++;
      if (xy === "??") nonSuivis++;
      if (fichiers.length < 30) fichiers.push({ xy, path: p });
    }
    let [avance, retard] = [0, 0];
    const ab = await lectureGit(c, rp, ["rev-list", "--left-right", "--count", "@{u}...HEAD"], {
      timeout: 4,
      maxOut: 200,
    });
    if (reussi(ab)) {
      const parties = motsPy(sortie(ab));
      const [g, d] = parties.map(entierPy);
      if (parties.length === 2 && g !== null && g !== undefined && d !== null && d !== undefined)
        [retard, avance] = [g, d];
    }
    const log = await lectureGit(c, rp, ["log", "-n", "5", "--pretty=format:%H%x7c%s%x7c%an%x7c%ar"], {
      timeout: 4,
      maxOut: 3000,
    });
    const commits: Dict[] = [];
    if (log["ok"] === true)
      for (const ligne of splitlinesPy(sortie(log))) {
        const p = ligne.split("|");
        if (p.length < 4) continue;
        commits.push({
          sha: prefixePy(p[0] ?? "", 8),
          subject: p[1],
          author: p[2],
          when: p.slice(3).join("|"),
        });
      }
    const rem = await lectureGit(c, rp, ["remote", "-v"], { timeout: 3, maxOut: 2000 });
    const remotes = new Map<string, string>();
    if (rem["ok"] === true)
      for (const ligne of splitlinesPy(sortie(rem))) {
        const p = motsPy(ligne);
        if (p.length >= 2 && !remotes.has(p[0] as string)) remotes.set(p[0] as string, p[1] as string);
      }
    return ok({
      branch: br,
      default_branch: base,
      is_protected_branch: estProtegee(br, pol),
      is_agent_branch: estBrancheAgent(br, pol),
      dirty: { staged: indexes, unstaged: modifies, untracked: nonSuivis, files: fichiers },
      ahead: avance,
      behind: retard,
      recent_commits: commits,
      remotes: [...remotes].map(([name, url]) => ({ name, url })),
      policy: pol,
    });
  });
}

/** `git_start_work` : config git, base protégée, pull ff-only non fatal, branche `agent/<intention>-<8 hex>` (réemployée si déjà dessus). */
export function gitStartWork(
  c: CompteGit,
  a: { repo: string; branch_intent: string; base: string },
): Promise<Dict> {
  return avecChangements("git", releve(c, undefined, false), () =>
    garder(async () => {
      const rp = await depotSur(c.esp, a.repo);
      const intention = intentionValide(a.branch_intent || "");
      const pol = await politique(c, rp);
      await assurerConfig(c, rp);
      const base = stripPy(a.base || "") || (await baseParDefaut(c, rp));
      if (!estProtegee(base, pol))
        return errGit(
          "base_not_protected",
          `Base branch ${reprPy(base)} is not in protected_branches. Agent branches must be cut from a protected branch (main/master/develop/etc). Either pass base='main' explicitly, or update .git-tool-policy.json.`,
          { base, protected: pol.protected_branches },
        );
      const cur = await brancheCourante(c, rp);
      const prefixe = pol.allowed_agent_prefixes[0] ?? "agent/";
      if (cur && cur.startsWith(prefixe)) {
        const reste = cur.slice(prefixe.length);
        if (`-${reste}-`.includes(`-${intention}-`) && reste.startsWith(intention + "-"))
          return ok({
            branch: cur,
            base,
            message: `Already on agent branch for intent ${reprPy(intention)} — reusing.`,
            reused: true,
          });
      }
      let baseSha = "";
      let noteTirage: string;
      if (await teteNonNee(c, rp)) {
        if (cur && cur !== base)
          return errGit(
            "empty_repo_base_mismatch",
            `Repo has no commit yet and HEAD is on unborn branch ${reprPy(cur)}, not ${reprPy(base)} — an unborn branch cannot be switched to. Pass base=${reprPy(cur)}, or make a first commit on ${reprPy(base)} first.`,
            { branch: cur, base },
          );
        noteTirage = "skipped (empty repo — no commit yet)";
      } else {
        const sw = await executer(c, rp, ["git", "switch", base], { timeout: 8 });
        if (!reussi(sw))
          return errGit(
            "switch_base_failed",
            `Couldn't switch to base branch ${reprPy(base)}. Check for uncommitted changes (use git_inspect first to see dirty state). stderr: ${champ(sw, "stderr", 200)}`,
          );
        const pl = await tirer(c, rp, "origin", base, "--ff-only", 20);
        noteTirage = reussi(pl)
          ? "ok"
          : `skipped (${prefixePy(String(pl["stderr"] || pl["fix"] || pl["error"] || "unknown"), 80)})`;
        const sha = await lectureGit(c, rp, ["rev-parse", "HEAD"], { timeout: 3, maxOut: 200 });
        baseSha = sha["ok"] === true ? prefixePy(stripPy(sortie(sha)), 8) : "";
      }
      const nouvelle = brancheAgent(intention, prefixe);
      const cr = await executer(c, rp, ["git", "switch", "-c", nouvelle], { timeout: 6 });
      if (!reussi(cr))
        return errGit(
          "create_branch_failed",
          `Could not create branch ${reprPy(nouvelle)}. stderr: ${champ(cr, "stderr", 200)}`,
        );
      return ok({
        branch: nouvelle,
        base,
        base_sha: baseSha,
        pull: noteTirage,
        ready: true,
        message: `Ready to work on ${reprPy(nouvelle)} (base: ${base}). Make your edits via fs.write_file or git_write, then git_commit, then git_submit.`,
      });
    }),
  );
}

/** Sous-agent `pr` : remote `origin` vérifié AVANT de brancher ou de committer (harnais SA-21) ; `null` s'il existe. */
export function refusSansRemote(c: CompteGit, repo: string): Promise<Dict | null> {
  return garder(async () => {
    const rp = await depotSur(c.esp, repo);
    const rem = await lectureGit(c, rp, ["remote", "get-url", "origin"], { timeout: 3, maxOut: 1000 });
    if (stripPy(sortie(rem))) return {};
    return errGit(
      "no_remote: no 'origin' remote configured; checked before branching or committing, nothing was changed",
      "Return status blocked to the parent: the repository needs an 'origin' remote (added by the user) before a pull request can be opened.",
    );
  }).then((r) => (r["ok"] === false ? r : null));
}

/** `git_commit` : indexation selon `scope` puis commit ; refusé hors branche d'agent, sauf premier commit d'un dépôt vierge. */
export function gitCommit(
  c: CompteGit,
  a: { repo: string; message: string; scope: string; paths: string[]; allow_secrets?: boolean },
): Promise<Dict> {
  return garder(async () => {
    if (!a.message || !stripPy(a.message))
      return errGit(
        "message_empty",
        "Commit message required (imperative mood, e.g. 'Fix login redirect on 401').",
      );
    let msg = stripPy(a.message);
    if ([...msg].length > 2000) msg = prefixePy(msg, 1997) + "...";
    const rp = await depotSur(c.esp, a.repo);
    const pol = await politique(c, rp);
    const br = (await brancheCourante(c, rp)) || "";
    await assurerConfig(c, rp);
    const initial = await tetePristine(c, rp);
    if (!initial) {
      if (estProtegee(br, pol))
        return errGit(
          "protected_branch",
          `HEAD is on protected branch ${reprPy(br)}. Cannot commit. Call git_start_work(repo=${reprPy(a.repo)}, branch_intent='<describe-task>') to create an agent branch first.`,
          { branch: br },
        );
      if (!estBrancheAgent(br, pol))
        return errGit(
          "not_agent_branch",
          `Branch ${reprPy(br)} doesn't match an allowed agent prefix (${reprPy(pol.allowed_agent_prefixes)}). The agent can only commit on branches it created via git_start_work.`,
          { branch: br },
        );
    }
    const scope = lowerPy(a.scope || "auto");
    if (scope === "auto") {
      const stg = await executer(c, rp, ["git", "add", "-A"], { timeout: 10 });
      if (!reussi(stg)) return errGit("stage_failed", `git add -A failed: ${champ(stg, "stderr", 200)}`);
    } else if (scope === "paths") {
      if (!a.paths.length) return errGit("paths_required", "scope='paths' requires paths=[...].");
      const surs: string[] = [];
      for (const p of a.paths) {
        try {
          surs.push(cheminSur(p));
        } catch (e) {
          if (!estErreurValeur(e)) throw e;
          return errGit("bad_path", e.message, { path: p });
        }
      }
      const stg = await executer(c, rp, ["git", "add", "--", ...surs], { timeout: 10 });
      if (!reussi(stg)) return errGit("stage_failed", `git add failed: ${champ(stg, "stderr", 200)}`);
    }
    const chk = await lectureGit(c, rp, ["diff", "--cached", "--name-only"], { timeout: 4, maxOut: 10_000 });
    if (!splitlinesPy(sortie(chk)).some((l) => stripPy(l)))
      return errGit(
        "nothing_to_commit",
        `No staged changes for scope=${reprPy(scope)}. If you expected changes, check git_inspect to see the dirty state. For untracked files, use scope='auto' or stage explicitly via scope='paths'.`,
      );
    let incomplet = false;
    if (!a.allow_secrets) {
      const d = await executer(
        c,
        rp,
        [
          "git",
          "-c",
          "core.quotePath=false",
          "diff",
          "--cached",
          "-U0",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
        ],
        { timeout: 30, maxOut: DIFF_SCANNE_MAX },
      );
      if (!reussi(d))
        return errGit("secret_scan_failed", `git diff --cached failed: ${champ(d, "stderr", 200)}`);
      incomplet = d["truncated"] === true;
      const t = secretsDuDiff(sortie(d));
      if (t.length)
        return errGit(
          `secrets_detected: ${t.length} potential secret(s) in the staged changes; nothing was committed`,
          "Remove the secret (and rotate it if it is real) or keep its file out of the commit (.gitignore, scope='paths'), then commit again; the changes stay staged. For test fixtures or a false positive, pass allow_secrets=true.",
          { branch: br, findings: t.slice(0, 50), findings_total: t.length },
        );
    }
    const cm = await executer(c, rp, ["git", "commit", "-m", msg], { timeout: 10, libres: new Set([3]) });
    if (!reussi(cm)) return errGit("commit_failed", `git commit failed: ${champ(cm, "stderr", 300)}`);
    const sha = await lectureGit(c, rp, ["rev-parse", "HEAD"], { timeout: 3, maxOut: 200 });
    const stat = await lectureGit(c, rp, ["log", "-1", "--pretty=format:", "--stat", "--shortstat"], {
      timeout: 4,
      maxOut: 5000,
    });
    let [n, ajouts, retraits] = [0, 0, 0];
    for (const ligne of splitlinesPy(sortie(stat))) {
      const m = BILAN_STAT.exec(ligne);
      if (!m) continue;
      [n, ajouts, retraits] = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
      break;
    }
    const out = ok({
      sha: sha["ok"] === true ? prefixePy(stripPy(sortie(sha)), 8) : "",
      branch: br,
      files_changed: n,
      insertions: ajouts,
      deletions: retraits,
      message: msg,
      next_step: "When ready to ship for review, call git_submit(repo, title, body, base='main').",
    });
    if (incomplet)
      out["warning"] = `secret scan incomplete: the staged diff is larger than ${DIFF_SCANNE_MAX} characters`;
    if (initial) {
      out["initial_commit"] = true;
      out["note"] =
        "First real commit of a fresh repo — allowed on any branch. From now on, protected-branch rules apply: use git_start_work for further changes.";
    }
    return out;
  });
}

/** Demande d'ouverture de PR rendue par le core (`/api/internal/git/pr`) ; `null` : core injoignable. */
export interface IssuePr {
  readonly outcome: "fallback" | "blocked_api_base" | "no_api" | "failed" | "opened" | "error" | "rejected";
  readonly [champ: string]: unknown;
}

/** Ce que l'hôte demande au core pour ouvrir la PR : le jeton de l'API de PR ne quitte jamais main. */
export interface PortPr {
  ouvrirPr(
    compte: { user_id: number; username: string },
    demande: { remote_url: string; head: string; base: string; title: string; body: string; draft: boolean },
  ): Promise<IssuePr | null>;
}

// Corps de PR transmis au core au plus (les forges plafonnent bien en dessous).
const CORPS_MAX = 200_000;

const SANS_JETON =
  " (no Git Connector provides a token for this host: add one in Settings, or use an SSH remote)";

/** `git_submit` : branche d'agent poussée par le relais (seule elle peut bouger), puis PR ouverte par le core ou URL de repli. */
export function gitSubmit(
  c: CompteGit,
  pr: PortPr | null,
  a: { repo: string; title: string; body: string; base: string; draft: boolean },
): Promise<Dict> {
  return garder(async () => {
    if (!a.title || !stripPy(a.title))
      return errGit("title_required", "PR title is required (max 256 chars).");
    const titre = prefixePy(stripPy(a.title), 256);
    const rp = await depotSur(c.esp, a.repo);
    const pol = await politique(c, rp);
    const br = (await brancheCourante(c, rp)) || "";
    if (estProtegee(br, pol))
      return errGit(
        "protected_branch",
        `HEAD on ${reprPy(br)} is protected. Submit only from agent branches.`,
        {
          branch: br,
        },
      );
    if (!estBrancheAgent(br, pol))
      return errGit(
        "not_agent_branch",
        `Branch ${reprPy(br)} doesn't match agent prefix. Use git_start_work first.`,
        {
          branch: br,
        },
      );
    const rem = await lectureGit(c, rp, ["remote", "get-url", "origin"], { timeout: 3, maxOut: 1000 });
    const remote = stripPy(sortie(rem));
    if (!remote)
      return errGit(
        "no_remote",
        "No 'origin' remote configured. Add one via `git remote add origin <url>` (currently not exposed as a tool — ask the user to do it).",
      );
    const uid = await c.uid();
    let jeton = false;
    if (uid)
      try {
        await c.esp.gitAnciensIdentifiants(uid, c.username);
        jeton = Boolean((await c.source.gitCredential(uid, remote))?.["token"]);
      } catch {
        jeton = false;
      }
    let urlPush: string;
    try {
      urlPush = await c.esp.gitRemoteUrl(rp, "origin", { push: true });
    } catch (e) {
      if (e instanceof RelayRefused) return errGit(e.code, enAnglais(e.message));
      throw e;
    }
    const pu = await executerReseau(c, rp, ["push", "--no-follow-tags", "-u", "origin", "HEAD"], {
      url: urlPush,
      pushRefs: [`refs/heads/${br}`],
      timeout: 30,
    });
    if (!reussi(pu)) {
      const note = jeton ? "" : SANS_JETON;
      if (pu["error"] === "timeout" || pu["returncode"] === 124)
        return errGit(
          "push_timeout",
          `'git push' to ${reprPy(remote)} did not answer within 30s: the remote is probably unreachable (host or network down) or stuck on authentication${note}. Check that origin answers before retrying (retrying unchanged hits the same timeout).`,
          { branch: br, remote, returncode: pu["returncode"] ?? null, timed_out: true },
        );
      let detail = stripPy(String(pu["stderr"] || pu["stdout"] || pu["fix"] || pu["message"] || ""));
      if (!detail) detail = `git returned no output: probably a silent authentication failure${note}`;
      return errGit(
        "push_failed",
        `git push failed: ${prefixePy(detail, 400)}. Common causes: missing credentials (Git Connector / SSH key), force-push required (NOT enabled automatically), or a remote that refuses.`,
        { branch: br, remote, returncode: pu["returncode"] ?? null },
      );
    }
    const base = stripPy(a.base || "") || (await baseParDefaut(c, rp));
    const av = await lectureGit(c, rp, ["rev-list", "--count", `origin/${base}..HEAD`], {
      timeout: 4,
      maxOut: 200,
    });
    const pousses = entierPy(stripPy(sortie(av) || "0")) ?? 0;
    let corps: string;
    if (!a.body || !stripPy(a.body)) {
      const cm = await lectureGit(c, rp, ["log", `origin/${base}..HEAD`, "--pretty=format:* %s"], {
        timeout: 4,
        maxOut: 4000,
      });
      corps =
        "(auto-generated by Elpis git_submit)\n\n" +
        `## Commits in this PR\n${sortie(cm)}\n\n` +
        "## Notes\nEdit this description with context, validation steps, and screenshots if applicable.";
    } else corps = stripPy(a.body);
    if (!uid)
      return errGit(
        "unknown_account",
        `Pushed to origin/${br}, but the account ${reprPy(c.username)} is unknown to the application: PR not opened, open it manually.`,
        { branch: br, commits_pushed: pousses },
      );
    const demande = {
      remote_url: remote,
      head: br,
      base,
      title: titre.toWellFormed(),
      body: prefixePy(corps, CORPS_MAX).toWellFormed(),
      draft: a.draft,
    };
    const issue =
      pr === null
        ? null
        : await pr.ouvrirPr({ user_id: uid, username: c.username }, demande).catch(() => null);
    if (issue === null)
      return errGit(
        "pr_service_unavailable",
        `Pushed to origin/${br}, but the application could not be reached to open the PR: run git_submit again later, or open it manually.`,
        { branch: br, commits_pushed: pousses },
      );
    return issuePr(issue, br, pousses, base, a.draft);
  });
}

/** Réponse de `git_submit` selon l'issue rendue par le core (messages du Python). */
function issuePr(r: IssuePr, br: string, pousses: number, base: string, draft: boolean): Dict {
  const s = (cle: string): string => (typeof r[cle] === "string" ? (r[cle] as string) : "");
  const brut = (cle: string, defaut: string): string => (Object.hasOwn(r, cle) ? strPy(r[cle]) : defaut);
  switch (r.outcome) {
    case "error":
      return errGit(
        s("message") || "unexpected: pr_service_error",
        s("hint"),
        s("hint") ? { branch: br, commits_pushed: pousses } : {},
      );
    case "rejected":
      return errGit(
        "pr_request_rejected",
        `Pushed to origin/${br}, but the application refused the PR request (HTTP ${brut("status", "?")}): open the PR manually.`,
        { branch: br, commits_pushed: pousses },
      );
    case "fallback": {
      const provider = s("provider") || "unknown";
      const hote = s("host");
      const message =
        provider === "unknown"
          ? `Pushed to origin/${br}, but the host ${reprPy(hote)} is not recognized automatically (self-hosted). To open the PR WITHOUT typing a token, register a Git Connector with the right provider_type (e.g. 'gitea') for this host in Settings → Git Connectors.`
          : `Pushed to origin/${br}. No Git Connector for ${hote || provider}: open the PR via fallback_url, or add a connector in Settings → Git Connectors.`;
      return ok({ branch: br, commits_pushed: pousses, provider, fallback_url: s("fallback_url"), message });
    }
    case "blocked_api_base":
      return errGit(
        "blocked_api_base",
        `The connector API (${reprPy(s("api_base"))}) is refused by the SSRF guard: ${s("reason")}. Fix the api_base of the Git Connector in Settings → Git Connectors.`,
        { branch: br, commits_pushed: pousses, fallback_url: s("fallback_url") },
      );
    case "no_api":
      return ok({
        branch: br,
        commits_pushed: pousses,
        provider: s("provider_type"),
        fallback_url: s("fallback_url"),
        message: `Connector ${reprPy(s("provider_type"))} has no PR API — open the PR via fallback_url.`,
      });
    case "failed":
      return errGit(
        r["error_code"] ?? "pr_open_failed",
        `PR API call failed: ${brut("error", "unknown")}. Status: ${brut("status", "None")}. Push succeeded though — you can open the PR manually via fallback_url.`,
        {
          fallback_url: s("fallback_url"),
          branch: br,
          commits_pushed: pousses,
          api_response: s("api_response"),
        },
      );
    case "opened":
      return ok({
        branch: br,
        commits_pushed: pousses,
        provider: s("provider_type"),
        pr_url: r["pr_url"] ?? null,
        pr_number: r["pr_number"] ?? null,
        draft,
        already_open: r["already_open"] ?? false,
        base,
        message: `PR opened: ${brut("pr_url", "None")} (draft=${draft ? "True" : "False"}). Hand this URL to a human for review/merge.`,
      });
    default:
      return errGit(
        "pr_service_error",
        `Pushed to origin/${br}, but the application returned an unknown PR outcome (${reprPy(brut("outcome", ""))}): open the PR manually.`,
        { branch: br, commits_pushed: pousses },
      );
  }
}

/** Préfixe des réfs de sauvegarde de `git_abandon` : hors des branches, jamais poussées. */
const REF_ABANDON = "refs/elpis/abandoned/";

/** Horodatage UTC compact d'une réf de sauvegarde (`20261017T172400Z`). */
function horodatage(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d+Z$/u, "Z");
}

interface Sauvegarde {
  readonly changes: Dict | null;
  readonly branch: Dict | null;
}

/** Sauvegardes faites avant tout rejet (harnais N-16) : changements non commités (indexés, non indexés, non suivis) en commit hors branche, tête d'une branche non fusionnée à supprimer ; une étape en échec rend le refus, rien n'est jeté. */
async function sauverAvantAbandon(
  c: CompteGit,
  rp: string,
  br: string,
  base: string,
  garderBranche: boolean,
): Promise<Sauvegarde | { refus: Dict }> {
  const ref = `${REF_ABANDON}${br}-${horodatage()}`;
  const refus = (etape: string, r: Dict): { refus: Dict } => ({
    refus: errGit(
      `abandon_not_saved: ${etape} failed (${r["ok"] === true ? ligneEchec(r) : strPy(r["message"])}); nothing was discarded`,
      "The branch and its changes are untouched (uncommitted changes may now be staged). Fix the cause, or keep the work with git_commit, then retry git_abandon.",
      { branch: br },
    ),
  });
  const st = await lectureGit(c, rp, ["status", "--porcelain=v1"], { timeout: 10, maxOut: 100_000 });
  if (!reussi(st)) return refus("git status", st);
  const tete = await lectureGit(c, rp, ["rev-parse", "HEAD"], { timeout: 4, maxOut: 200 });
  if (!reussi(tete)) return refus("git rev-parse HEAD", tete);
  const sha = stripPy(sortie(tete));
  const sale = splitlinesPy(sortie(st)).filter((l) => stripPy(l));
  let changes: Dict | null = null;
  if (sale.length) {
    await assurerConfig(c, rp);
    const ajout = await executer(c, rp, ["git", "add", "-A"], { timeout: 60 });
    if (!reussi(ajout)) return refus("git add -A", ajout);
    const arbre = await executer(c, rp, ["git", "write-tree"], { timeout: 30 });
    if (!reussi(arbre)) return refus("git write-tree", arbre);
    const msg = `git_abandon: uncommitted changes of ${br}`;
    const cm = await executer(c, rp, ["git", "commit-tree", stripPy(sortie(arbre)), "-p", sha, "-m", msg], {
      timeout: 30,
      libres: new Set([6]),
    });
    if (!reussi(cm)) return refus("git commit-tree", cm);
    const sauve = stripPy(sortie(cm));
    const maj = await executer(c, rp, ["git", "update-ref", `${ref}-changes`, sauve, ""], { timeout: 10 });
    if (!reussi(maj)) return refus("git update-ref", maj);
    changes = {
      ref: `${ref}-changes`,
      sha: prefixePy(sauve, 8),
      files: sale.slice(0, 50),
      files_total: sale.length,
    };
  }
  let branche: Dict | null = null;
  if (!garderBranche) {
    const n = await lectureGit(c, rp, ["rev-list", "--count", `${base}..${sha}`], {
      timeout: 10,
      maxOut: 200,
    });
    const enAvance = reussi(n) ? entierPy(stripPy(sortie(n))) : null;
    if (enAvance !== 0) {
      const maj = await executer(c, rp, ["git", "update-ref", ref, sha, ""], { timeout: 10 });
      if (!reussi(maj)) return refus("git update-ref", maj);
      branche = { ref, sha: prefixePy(sha, 8), unmerged_commits: enAvance };
    }
  }
  return { changes, branch: branche };
}

/** Commande exacte qui rend le travail abandonné : branche recréée (ou retrouvée), puis changements réappliqués, indexés. */
function commandeReprise(br: string, s: Sauvegarde, brancheExiste: boolean): string | null {
  const chg = s.changes ? String(s.changes["ref"]) : null;
  const depuis = s.branch ? String(s.branch["ref"]) : chg ? `${chg}~1` : null;
  const cmds: string[] = [];
  if (brancheExiste) {
    if (chg) cmds.push(`git switch ${br}`);
  } else if (depuis) cmds.push(`git switch -c ${br} ${depuis}`);
  if (chg) cmds.push(`git cherry-pick --no-commit ${chg}`);
  return cmds.length ? cmds.join(" && ") : null;
}

/** `git_abandon` : changements en attente et commits non fusionnés sauvegardés sous `refs/elpis/abandoned/` (écart voulu au Python, qui les jetait), puis jetés ; retour à la base, branche d'agent supprimée (sauf `keep_branch`). */
export function gitAbandon(c: CompteGit, a: { repo: string; keep_branch: boolean }): Promise<Dict> {
  return avecChangements("git", releve(c, undefined, false), () =>
    garder(async () => {
      const rp = await depotSur(c.esp, a.repo);
      const pol = await politique(c, rp);
      const br = (await brancheCourante(c, rp)) || "";
      if (estProtegee(br, pol))
        return errGit(
          "protected_branch",
          `HEAD is on protected ${reprPy(br)}. Nothing to abandon — you're already on the base.`,
          { branch: br },
        );
      if (!estBrancheAgent(br, pol))
        return errGit(
          "not_agent_branch",
          `Branch ${reprPy(br)} isn't an agent branch (no allowed prefix match). Refusing to discard — use a fine-grained tool if this is intentional.`,
          { branch: br },
        );
      const base = await baseParDefaut(c, rp);
      const s = await sauverAvantAbandon(c, rp, br, base, a.keep_branch);
      if ("refus" in s) return s.refus;
      await executer(c, rp, ["git", "reset", "--hard", "HEAD"], { timeout: 6 });
      await executer(c, rp, ["git", "clean", "-fd"], { timeout: 6 });
      const sw = await executer(c, rp, ["git", "switch", base], { timeout: 6 });
      if (!reussi(sw))
        return errGit(
          "switch_base_failed",
          `Couldn't switch to base ${reprPy(base)}: ${champ(sw, "stderr", 200)}`,
          { saved: s, recover: commandeReprise(br, s, true) },
        );
      let supprimee: string | null = null;
      if (!a.keep_branch) {
        const dl = await executer(c, rp, ["git", "branch", "-D", br], { timeout: 4 });
        if (reussi(dl)) supprimee = br;
      }
      const sauve = s.changes !== null || s.branch !== null;
      return ok({
        returned_to: base,
        deleted_branch: supprimee,
        kept_branch: a.keep_branch ? br : null,
        saved: s,
        recover: commandeReprise(br, s, supprimee === null),
        note: sauve
          ? "Pending changes and unmerged commits were saved under refs/elpis/abandoned/ before being discarded (see 'saved'); run 'recover' with execute_shell to get them back. You can start fresh via git_start_work."
          : "Nothing needed saving (clean tree, no unmerged commit). You can start fresh via git_start_work.",
      });
    }),
  );
}
