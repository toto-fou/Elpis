// SPDX-License-Identifier: MIT
/** apps/toolhost/test/git-famille.test.ts — famille git de l'hôte : définitions du golden, outils contre le vrai agent Python et le relais (sans conteneur), PR et identifiants par rappel au core, jeton jamais hors de l'hôte exact. */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { AgentClient, arreterRelais, fileEntry } from "@elpis/fichiers";
import { ouvrirEnMemoire, ServeurOutils } from "@elpis/outils-mcp";
import type { Golden } from "@elpis/outils-mcp";
import goldenGit from "@elpis/outils-mcp/goldens/git.json" with { type: "json" };
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BacTest, dossierTemporaire, PYTHON } from "../../../packages/fichiers/test/aides";
import { BASIC, demarrerAmont, git, JETON } from "../../../packages/fichiers/test/amont-git";
import type { Amont } from "../../../packages/fichiers/test/amont-git";
import { brancherRappelProfil, Espace, installerFabriqueEspace } from "../src/mcp/espace";
import { errGit, intentionValide, slugIntention } from "../src/mcp/git/commun";
import { familleGit } from "../src/mcp/git/famille";
import { DIFF_APERCU } from "../src/mcp/git/requete";
import type { RappelGit } from "../src/mcp/git/famille";
import type { IssuePr } from "../src/mcp/git/travail";

/** Première IPv4 non locale : l'amont n'y est pas critique (la garde `critical_only` du relais refuse la boucle). */
const LAN =
  Object.values(networkInterfaces())
    .flat()
    .find((i) => i?.family === "IPv4" && !i.internal)?.address ?? null;

const META = { username: "alice", user_id: "7" };

let racine = "";
let nettoyer: () => void = () => undefined;
let bac: BacTest;
let amont: Amont | null = null;

beforeEach(() => {
  [racine, nettoyer] = dossierTemporaire("elpis-git-famille-");
  bac = new BacTest(racine, "alice");
  vi.stubEnv("APP_FILE_HISTORY_DIR", path.join(racine, "fh"));
  vi.stubEnv("FSTOOLS_FLOCK", "0");
  installerFabriqueEspace(async () => new Espace(bac.sandboxPath, 7, new AgentClient(bac)));
});

afterEach(async () => {
  installerFabriqueEspace(null);
  brancherRappelProfil(null);
  vi.unstubAllEnvs();
  await amont?.fermer();
  amont = null;
  await bac.arreter();
  await arreterRelais();
  nettoyer();
});

interface Faux {
  readonly rappel: RappelGit;
  readonly prs: unknown[];
  readonly enregistres: unknown[];
  /** Présences vérifiées sans lecture du jeton (messages des outils). */
  readonly presences: unknown[];
  issue: IssuePr | null | undefined;
}

/** Core simulé : identité d'alice, jeton du compte git pour l'hôte de l'amont seulement (compte signé noté), PR notées. */
function faux(
  o: {
    jeton?: boolean;
    issue?: IssuePr | null;
  } = {},
): Faux {
  const prs: unknown[] = [];
  const enregistres: unknown[] = [];
  const presences: unknown[] = [];
  const f = { prs, enregistres, presences, issue: o.issue } as Faux;
  const hote = (url: string): string => url.replace(/^https?:\/\//u, "").split("/")[0] ?? "";
  const rappel: RappelGit = {
    actif: true,
    identityForUsername: (u) =>
      Promise.resolve(u === "alice" ? { user_id: 7, network_profile_id: "isolated" } : null),
    gitCredential: (compte, url) => {
      enregistres.push([compte, url]);
      return Promise.resolve(
        o.jeton && amont && hote(url) === hote(amont.url)
          ? { username: "u", token: JETON, host: hote(amont.url) }
          : null,
      );
    },
    identifiantGitDisponible: (compte, url) => {
      presences.push([compte, url]);
      return Promise.resolve(Boolean(o.jeton && amont && hote(url) === hote(amont.url)));
    },
    connectorHosts: () => Promise.resolve([]),
    ouvrirPr: (compte, d) => {
      prs.push([compte, d]);
      return Promise.resolve(
        f.issue === undefined
          ? {
              outcome: "opened",
              provider_type: "gitea",
              pr_url: "http://forge/o/r/pulls/1",
              pr_number: 1,
              already_open: false,
            }
          : f.issue,
      );
    },
  };
  return Object.assign(f, { rappel });
}

async function client(rappel: RappelGit | null): Promise<{ c: Client; fermer: () => Promise<void> }> {
  const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
  const fam = familleGit({ rappel });
  serveur.enregistrerFamille(fam.famille, fam.outils);
  const cnx = await ouvrirEnMemoire(serveur, { famille: "git" });
  const c = new Client({ name: "test", version: "1" });
  await c.connect(cnx.transport);
  return { c, fermer: () => cnx.fermer() };
}

async function appeler(c: Client, outil: string, args: Dict): Promise<Dict> {
  const rep = (await c.callTool({ name: outil, arguments: args, _meta: META })) as Dict;
  const sc = rep["structuredContent"] as Dict | undefined;
  const texte = ((rep["content"] as Dict[])[0]?.["text"] as string | undefined) ?? "{}";
  return (sc?.["result"] as Dict | undefined) ?? (JSON.parse(texte) as Dict);
}

const travail = (rel: string): string => path.join(bac.sandboxPath, rel);

describe("famille git : définition", () => {
  it("tools/list rend les définitions du golden Python, à l'identique et dans l'ordre", () => {
    const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
    const fam = familleGit({});
    serveur.enregistrerFamille(fam.famille, fam.outils);
    expect(fam.famille).toBe("git");
    expect(serveur.lister({ jeton: null, famille: "git" }).tools).toEqual((goldenGit as Golden).outils);
  });
});

describe("aucun outil git ne reçoit d'identifiant", () => {
  it("git_set_credential n'existe plus ; git_clone refuse username et token (schéma fermé)", async () => {
    const f = faux();
    const { c, fermer } = await client(f.rappel);
    try {
      const noms = (await c.listTools()).tools.map((o) => o.name);
      expect(noms).not.toContain("git_set_credential");
      expect(noms).toHaveLength(10);
      const clone = (await c.listTools()).tools.find((o) => o.name === "git_clone");
      expect(Object.keys((clone?.inputSchema.properties ?? {}) as Dict)).toEqual([
        "url",
        "into_path",
        "branch",
      ]);
      expect(String(clone?.description)).toContain("Settings \u203a Git accounts");
      const r = (await c.callTool({
        name: "git_clone",
        arguments: { url: "https://forge.lan/o/r.git", token: "pat-secret" },
        _meta: META,
      })) as Dict;
      expect(r["isError"]).toBe(true);
      expect(f.enregistres).toEqual([]);
      expect(f.presences).toEqual([]);
    } finally {
      await fermer();
    }
  });
});

describe.skipIf(!PYTHON)("dépôt local par l'agent du bac", () => {
  it("init, écriture suivie dans l'historique, branche d'agent, commit, inspection, abandon", async () => {
    const { c, fermer } = await client(faux().rappel);
    try {
      expect(await appeler(c, "git_query", { repo: "", action: "repos" })).toEqual({
        ok: true,
        repos: [],
        count: 0,
        sandbox_root: "/work",
      });
      expect(await appeler(c, "git_action", { repo: "proj", action: "init" })).toMatchObject({ ok: true });
      const w = await appeler(c, "git_write", {
        repo: "proj",
        action: "write",
        path: "src/a.py",
        content: "x = 1\n",
      });
      expect(w).toMatchObject({ ok: true, path: "src/a.py", bytes: 6, action: "overwrite" });
      expect(readFileSync(travail("proj/src/a.py"), "utf-8")).toBe("x = 1\n");
      expect(((await fileEntry(7, "proj/src/a.py")) as Dict | null)?.["versions"]).toHaveLength(1);
      const sw = await appeler(c, "git_start_work", { repo: "proj", branch_intent: "add-a" });
      expect(sw["ok"]).toBe(true);
      const br = String(sw["branch"]);
      expect(br).toMatch(/^agent\/add-a-[0-9a-f]{8}$/u);
      expect(await appeler(c, "git_commit", { repo: "proj", message: "feat: a" })).toMatchObject({
        ok: true,
        branch: br,
      });
      expect(await appeler(c, "git_inspect", { repo: "proj" })).toMatchObject({ ok: true, branch: br });
      expect(String((await appeler(c, "git_query", { repo: "proj", action: "log" }))["stdout"])).toContain(
        "feat: a",
      );
      expect(await appeler(c, "git_abandon", { repo: "proj" })).toMatchObject({
        ok: true,
        deleted_branch: br,
      });
      expect(await appeler(c, "git_submit", { repo: "proj", title: "x" })).toMatchObject({
        ok: false,
        error: "protected_branch",
      });
    } finally {
      await fermer();
    }
  });
});

describe("codes d'erreur stables (harnais B-07)", () => {
  it("le code est la tête du message, sans ses données ; le message garde le détail", () => {
    for (const [message, code] of [
      ["Invalid branch_intent 'probe change' — must be lowercase", "invalid_branch_intent"],
      ["Invalid branch_intent 'autre chose' — must be lowercase", "invalid_branch_intent"],
      ["bad_regex: missing ), unterminated subpattern at position 0", "bad_regex"],
      ["Invalid path: '/etc/passwd'. Use a path RELATIVE to the repo root", "invalid_path"],
      ["Repo not found: projet. Use git_query(action='repos')", "repo_not_found"],
      ["too_large: 123456B", "too_large"],
      ["unexpected: 'int' object has no attribute 'get'", "unexpected"],
      ["repo must be a RELATIVE path, not absolute. Got: '/x'.", "repo_not_relative"],
      ["repo path may not contain '..' (path traversal). Got: 'a/..'.", "repo_traversal"],
      ["target required (ref to pick)", "target_required"],
      [
        "'utf-8' codec can't encode character '\\ud800' in position 3: surrogates not allowed",
        "invalid_text",
      ],
      ["clone_url_blocked: Dépôt refusé (anti-SSRF) : credentials_in_url", "clone_url_blocked"],
      ["protected_branch", "protected_branch"],
      ["", "git_error"],
    ] as const)
      expect([message, errGit(message)]).toEqual([message, { ok: false, error: code, message }]);
  });
});

describe.skipIf(!PYTHON)("codes stables de bout en bout (harnais B-07)", () => {
  it("codes stables de bout en bout : intention, regex, dépôt absent", async () => {
    const { c, fermer } = await client(faux().rappel);
    try {
      expect(await appeler(c, "git_action", { repo: "proj", action: "init" })).toMatchObject({ ok: true });
      expect(await appeler(c, "git_start_work", { repo: "proj", branch_intent: "?!" })).toMatchObject({
        ok: false,
        error: "invalid_branch_intent",
      });
      await appeler(c, "git_write", { repo: "proj", action: "write", path: "a.txt", content: "a\n" });
      expect(
        await appeler(c, "git_write", {
          repo: "proj",
          action: "replace",
          path: "a.txt",
          find: "(",
          regex: true,
        }),
      ).toMatchObject({ ok: false, error: "bad_regex" });
      expect(await appeler(c, "git_query", { repo: "absent", action: "status" })).toMatchObject({
        ok: false,
        error: "repo_not_found",
      });
    } finally {
      await fermer();
    }
  });
});

describe("branch_intent mis en slug avant validation (harnais B-17)", () => {
  it("minuscules, accents ôtés, blancs et _ en -, le reste retiré ; refus seulement si le slug reste invalide", () => {
    for (const [brut, slug] of [
      ["probe change", "probe-change"],
      ["  Fix_Login  Validation ", "fix-login-validation"],
      ["Corriger l'été", "corriger-lete"],
      ["add/csv:export!", "addcsvexport"],
      ["--déjà--fait--", "deja-fait"],
    ] as const)
      expect([brut, slugIntention(brut), intentionValide(brut)]).toEqual([brut, slug, slug]);
    const long = "a".repeat(30) + " " + "b".repeat(30);
    expect(() => intentionValide(long)).toThrow(`Try branch_intent='${"a".repeat(30)}-${"b".repeat(10)}'.`);
    for (const brut of ["?!", "é", "ab"]) {
      expect(() => intentionValide(brut)).toThrow(/^Invalid branch_intent .* Examples:/u);
      expect(() => intentionValide(brut)).not.toThrow(/Try branch_intent/u);
    }
    expect(() => intentionValide("   ")).toThrow(/^branch_intent required/u);
  });
});

describe.skipIf(!PYTHON)("git_start_work accepte une intention à normaliser (harnais B-17)", () => {
  it("« Probe change » donne la branche agent/probe-change-<hex>", async () => {
    const { c, fermer } = await client(faux().rappel);
    try {
      expect(await appeler(c, "git_action", { repo: "proj", action: "init" })).toMatchObject({ ok: true });
      const sw = await appeler(c, "git_start_work", { repo: "proj", branch_intent: "Probe change" });
      expect(sw).toMatchObject({ ok: true });
      expect(String(sw["branch"])).toMatch(/^agent\/probe-change-[0-9a-f]{8}$/u);
    } finally {
      await fermer();
    }
  });
});

describe.skipIf(!PYTHON)("git_commit refuse un secret indexé (harnais B-06)", () => {
  it("jeton et .env : refus secrets_detected, findings masqués, rien de commité ; allow_secrets=true force", async () => {
    const jeton = ["gh", "p_", "Zq8Rt3Lm2Kp9Xv4Nb7Wc1Hy6Jd3Fs5Ga0Qe8"].join("");
    const motDePasse = ["s3cr", "et-Pa", "ss!"].join("");
    const { c, fermer } = await client(faux().rappel);
    try {
      expect(await appeler(c, "git_action", { repo: "proj", action: "init" })).toMatchObject({ ok: true });
      await appeler(c, "git_write", {
        repo: "proj",
        action: "write",
        path: "a.py",
        content: `k = "${jeton}"\n`,
      });
      await appeler(c, "git_write", {
        repo: "proj",
        action: "write",
        path: ".env",
        content: `DEBUG=1\nDB_PASSWORD=${motDePasse}\n`,
      });
      const r = await appeler(c, "git_commit", { repo: "proj", message: "feat: a" });
      expect(r).toMatchObject({ ok: false, error: "secrets_detected", findings_total: 2 });
      expect(r["findings"]).toEqual([
        { file: ".env", line: 2, kind: "env_secret", preview: "DB_PASSWORD=****(12 chars)" },
        { file: "a.py", line: 1, kind: "github_token", preview: "ghp_****(40 chars)" },
      ]);
      expect(JSON.stringify(r)).not.toContain(jeton.slice(4));
      expect(JSON.stringify(r)).not.toContain(motDePasse);
      expect(
        String((await appeler(c, "git_query", { repo: "proj", action: "log" }))["stdout"]),
      ).not.toContain("feat: a");
      expect(
        await appeler(c, "git_commit", { repo: "proj", message: "feat: a", allow_secrets: true }),
      ).toMatchObject({ ok: true });
      const sw = await appeler(c, "git_start_work", { repo: "proj", branch_intent: "sans-secret" });
      expect(sw).toMatchObject({ ok: true });
      await appeler(c, "git_write", { repo: "proj", action: "write", path: "b.py", content: "x = 1\n" });
      const propre = await appeler(c, "git_commit", { repo: "proj", message: "feat: b" });
      expect(propre).toMatchObject({ ok: true });
      expect(Object.hasOwn(propre, "warning")).toBe(false);
    } finally {
      await fermer();
    }
  });
});

describe.skipIf(!PYTHON)("git_write ne touche jamais un dossier git (harnais B-05)", () => {
  it("chemin direct, casse, sous-dépôt, liens vers .git (relatif, absolu, autre dépôt) : refusés ; fichiers voisins écrits", async () => {
    const { c, fermer } = await client(faux().rappel);
    try {
      for (const repo of ["proj", "autre"])
        expect(await appeler(c, "git_action", { repo, action: "init" })).toMatchObject({ ok: true });
      const config = readFileSync(travail("proj/.git/config"), "utf-8");
      mkdirSync(travail("proj/sous/.git"), { recursive: true });
      symlinkSync(".git/config", travail("proj/lien-config"));
      symlinkSync(".git", travail("proj/lien-dossier"));
      symlinkSync(travail("autre/.git"), travail("proj/lien-autre"));
      const refus = [
        { action: "write", path: ".git/hooks/pre-commit", content: "x" },
        { action: "write", path: "./.git/config", content: "x" },
        { action: "write", path: ".GIT/config", content: "x" },
        { action: "write", path: "sous/.git/config", content: "x" },
        { action: "write", path: "lien-config", content: "x" },
        { action: "write", path: "lien-dossier/hooks/pre-commit", content: "x" },
        { action: "write", path: "lien-autre/config", content: "x" },
        { action: "write", path: ".git/config", content: "x", dry_run: true },
        { action: "write", path: ".git/config", content: "x", mode: "append" },
        { action: "replace", path: ".git/config", find: "[core]", replace: "[x]" },
      ];
      for (const args of refus)
        expect([args, await appeler(c, "git_write", { repo: "proj", ...args })]).toMatchObject([
          args,
          { ok: false, error: "path_in_git_dir", path: args.path },
        ]);
      expect(readFileSync(travail("proj/.git/config"), "utf-8")).toBe(config);
      expect(existsSync(travail("proj/.git/hooks/pre-commit"))).toBe(false);
      expect(existsSync(travail("proj/.GIT"))).toBe(false);
      expect(existsSync(travail("autre/.git/config.lock"))).toBe(false);
      expect(readFileSync(travail("autre/.git/config"), "utf-8")).not.toContain("x");
      for (const path of [".gitignore", ".github/workflows/ci.yml", "src/.gitkeep", "git/config"])
        expect(
          await appeler(c, "git_write", { repo: "proj", action: "write", path, content: "ok\n" }),
        ).toMatchObject({
          ok: true,
          path,
        });
    } finally {
      await fermer();
    }
  });
});

/** Dépôt `proj` : premier commit sur main, branche d'agent avec un commit, main avancé à côté (comme par un humain) ; HEAD sur la branche d'agent. */
async function divergents(c: Client): Promise<string> {
  await appeler(c, "git_action", { repo: "proj", action: "init" });
  await appeler(c, "git_write", { repo: "proj", action: "write", path: "f.txt", content: "1\n" });
  expect(await appeler(c, "git_commit", { repo: "proj", message: "f" })).toMatchObject({ ok: true });
  const br = String(
    (await appeler(c, "git_start_work", { repo: "proj", branch_intent: "diverge" }))["branch"],
  );
  await appeler(c, "git_write", { repo: "proj", action: "write", path: "f.txt", content: "2\n" });
  expect(await appeler(c, "git_commit", { repo: "proj", message: "agent" })).toMatchObject({ ok: true });
  git(travail("proj"), "checkout", "-q", "main");
  writeFileSync(travail("proj/f.txt"), "3\n");
  git(travail("proj"), "commit", "-qam", "main");
  git(travail("proj"), "checkout", "-q", br);
  return br;
}

describe.skipIf(!PYTHON)(
  "commande git en échec : jamais ok: true (écart voulu au Python, harnais N-13, GI-08)",
  () => {
    it("merge ff-only impossible : not_fast_forward, alternatives proposées, rien de changé ; conflit d'un no-ff listé", async () => {
      const { c, fermer } = await client(faux().rappel);
      try {
        const br = await divergents(c);
        const tete = git(travail("proj"), "rev-parse", "HEAD");
        const r = await appeler(c, "git_action", { repo: "proj", action: "merge", branch: "main" });
        expect(r).toMatchObject({
          ok: false,
          error: "not_fast_forward",
          returncode: 128,
          branch: "main",
          current_branch: br,
        });
        expect(String(r["message"])).toMatch(/^not_fast_forward: fatal: Not possible to fast-forward/u);
        expect(String(r["fix"])).toContain("strategy='no-ff'");
        expect(String(r["fix"])).toContain("`git rebase main`");
        expect(git(travail("proj"), "rev-parse", "HEAD")).toBe(tete);
        const cf = await appeler(c, "git_action", {
          repo: "proj",
          action: "merge",
          branch: "main",
          strategy: "no-ff",
        });
        expect(cf).toMatchObject({ ok: false, error: "merge_conflict", returncode: 1, conflicts: ["f.txt"] });
        expect(String(cf["fix"])).toContain("git reset --merge");
        expect(cf["message"]).toBe("merge_conflict: CONFLICT (content): Merge conflict in f.txt");
        git(travail("proj"), "merge", "--abort");
      } finally {
        await fermer();
      }
    });

    it("autres actions et requêtes en erreur : code stable, code de retour gardé ; grep sans résultat reste un succès", async () => {
      const { c, fermer } = await client(faux().rappel);
      try {
        await divergents(c);
        const echecs: [string, Dict, string][] = [
          ["git_action", { action: "switch", branch: "absente" }, "switch_failed"],
          ["git_action", { action: "stage", paths: ["absent.txt"] }, "stage_failed"],
          ["git_action", { action: "restore", paths: ["absent.txt"] }, "restore_failed"],
          ["git_action", { action: "stash_pop" }, "stash_pop_failed"],
          ["git_action", { action: "merge", branch: "absente" }, "merge_failed"],
          ["git_action", { action: "cherry_check", target: "absente" }, "cherry_check_failed"],
          ["git_query", { action: "show", target: "absente" }, "unknown_ref"],
          ["git_query", { action: "log", target: "absente" }, "unknown_ref"],
          ["git_query", { action: "diff", target: "absente" }, "unknown_ref"],
          ["git_query", { action: "blame", target: "absent.txt" }, "blame_failed"],
          ["git_query", { action: "find_text", pattern: "re:(" }, "find_text_failed"],
        ];
        for (const [outil, args, code] of echecs) {
          const r = await appeler(c, outil, { repo: "proj", ...args });
          expect([outil, args, r]).toMatchObject([outil, args, { ok: false, error: code }]);
          expect([outil, args, r["returncode"]]).not.toEqual([outil, args, 0]);
          expect(String(r["message"]).startsWith(`${code}: `)).toBe(true);
        }
        expect(await appeler(c, "git_query", { repo: "proj", action: "grep", pattern: "zzz" })).toMatchObject(
          {
            ok: true,
            returncode: 1,
            stdout: "",
          },
        );
      } finally {
        await fermer();
      }
    });
  },
);

describe.skipIf(!PYTHON)("diff et show bornés (écart voulu au Python, harnais N-14, GI-12)", () => {
  it("6 000 lignes : stat complet, début coupé sur une fin de ligne, taille totale et hint ; petit diff entier", async () => {
    const { c, fermer } = await client(faux().rappel);
    try {
      await appeler(c, "git_action", { repo: "proj", action: "init" });
      await appeler(c, "git_write", { repo: "proj", action: "write", path: "a.txt", content: "a\n" });
      await appeler(c, "git_commit", { repo: "proj", message: "a" });
      await appeler(c, "git_start_work", { repo: "proj", branch_intent: "gros-diff" });
      const lignes = Array.from({ length: 6000 }, (_, i) => `line ${String(i + 1).padStart(4, "0")}`);
      await appeler(c, "git_write", {
        repo: "proj",
        action: "write",
        path: "big.txt",
        content: lignes.join("\n") + "\n",
      });
      await appeler(c, "git_commit", { repo: "proj", message: "big" });
      for (const args of [
        { action: "diff", target: "HEAD~1" },
        { action: "show", target: "HEAD" },
      ]) {
        const d = await appeler(c, "git_query", { repo: "proj", ...args });
        expect([args, d]).toMatchObject([
          args,
          {
            ok: true,
            returncode: 0,
            truncated: true,
            files_changed: 1,
            insertions: 6000,
            deletions: 0,
            stat: " big.txt | 6000 ++++++++++++++++++++\n 1 file changed, 6000 insertions(+)",
            stat_truncated: false,
          },
        ]);
        expect(Number(d["total_chars"])).toBeGreaterThan(60_000);
        expect(Number(d["total_lines"])).toBeGreaterThan(6000);
        const [montre, marque] = String(d["stdout"]).split("...[truncated: ");
        expect(montre?.endsWith("\n")).toBe(true);
        expect(montre?.length).toBe(d["shown_chars"]);
        expect(Number(d["shown_chars"])).toBeLessThanOrEqual(DIFF_APERCU);
        expect(marque).toBe(
          `${Number(d["total_chars"]) - Number(d["shown_chars"])} of ${String(d["total_chars"])} characters omitted]`,
        );
        expect(String(d["hint"])).toContain("target2");
        expect(JSON.stringify(d).length).toBeLessThan(10_000);
      }
      writeFileSync(travail("proj/a.txt"), "b\n");
      const petit = await appeler(c, "git_query", { repo: "proj", action: "diff" });
      expect(petit).toMatchObject({ ok: true, returncode: 0, truncated: false });
      expect(String(petit["stdout"])).toContain("-a\n+b\n");
      expect("stat" in petit).toBe(false);
    } finally {
      await fermer();
    }
  });
});

describe.skipIf(!PYTHON)(
  "git_action(merge) et git_action(pull, branch) refusent une branche protégée (écart voulu au Python, harnais N-12)",
  () => {
    it("main : ff-only, no-ff, squash et dry_run refusés, main intact ; release/* et .git-tool-policy.json suivis ; branche d'agent permise", async () => {
      const { c, fermer } = await client(faux().rappel);
      try {
        await appeler(c, "git_action", { repo: "proj", action: "init" });
        await appeler(c, "git_write", { repo: "proj", action: "write", path: "f.txt", content: "1\n" });
        await appeler(c, "git_commit", { repo: "proj", message: "f" });
        const br = String(
          (await appeler(c, "git_start_work", { repo: "proj", branch_intent: "fusion" }))["branch"],
        );
        await appeler(c, "git_write", { repo: "proj", action: "write", path: "g.txt", content: "g\n" });
        expect(await appeler(c, "git_commit", { repo: "proj", message: "g" })).toMatchObject({ ok: true });
        expect(
          await appeler(c, "git_action", { repo: "proj", action: "switch", branch: "main" }),
        ).toMatchObject({
          ok: true,
        });
        const tete = git(travail("proj"), "rev-parse", "main");
        for (const extra of [{}, { strategy: "no-ff" }, { strategy: "squash" }, { dry_run: true }]) {
          const r = await appeler(c, "git_action", { repo: "proj", action: "merge", branch: br, ...extra });
          expect([extra, r]).toMatchObject([
            extra,
            { ok: false, error: "protected_branch", branch: "main", merge_branch: br },
          ]);
          expect(String(r["fix"])).toContain("git_submit");
          expect(String(r["fix"])).toContain(`\`git merge ${br}\` with execute_shell`);
        }
        for (const extra of [{}, { strategy: "merge" }, { strategy: "rebase" }, { dry_run: true }]) {
          const r = await appeler(c, "git_action", { repo: "proj", action: "pull", branch: br, ...extra });
          expect([extra, r]).toMatchObject([
            extra,
            { ok: false, error: "protected_branch", branch: "main", pull_branch: br },
          ]);
          expect(String(r["fix"])).toContain("git_start_work");
        }
        for (const extra of [{}, { branch: "main" }])
          expect(
            await appeler(c, "git_action", { repo: "proj", action: "pull", dry_run: true, ...extra }),
          ).toMatchObject({ ok: true, dry_run: true });
        expect(git(travail("proj"), "rev-parse", "main")).toBe(tete);
        expect(git(travail("proj"), "status", "--porcelain")).toBe("");
        git(travail("proj"), "checkout", "-q", "-b", "release/1", "main");
        expect(await appeler(c, "git_action", { repo: "proj", action: "merge", branch: br })).toMatchObject({
          ok: false,
          error: "protected_branch",
          branch: "release/1",
        });
        git(travail("proj"), "checkout", "-q", "-b", "integration", "main");
        writeFileSync(
          travail("proj/.git-tool-policy.json"),
          JSON.stringify({ protected_branches: ["integration"] }),
        );
        expect(await appeler(c, "git_action", { repo: "proj", action: "merge", branch: br })).toMatchObject({
          ok: false,
          error: "protected_branch",
          branch: "integration",
        });
        git(travail("proj"), "checkout", "-q", br);
        expect(
          await appeler(c, "git_action", { repo: "proj", action: "merge", branch: "main" }),
        ).toMatchObject({
          ok: true,
          returncode: 0,
        });
      } finally {
        await fermer();
      }
    });
  },
);

describe.skipIf(!PYTHON)(
  "git_abandon sauvegarde avant de jeter (écart voulu au Python, harnais N-16, GI-14)",
  () => {
    it("changements indexés, non indexés, non suivis et commit non fusionné : réfs de sauvegarde, commande de reprise qui rend tout", async () => {
      const { c, fermer } = await client(faux().rappel);
      try {
        await appeler(c, "git_action", { repo: "proj", action: "init" });
        await appeler(c, "git_write", { repo: "proj", action: "write", path: "a.txt", content: "a\n" });
        await appeler(c, "git_commit", { repo: "proj", message: "a" });
        const br = String(
          (await appeler(c, "git_start_work", { repo: "proj", branch_intent: "abandon" }))["branch"],
        );
        await appeler(c, "git_write", { repo: "proj", action: "write", path: "b.txt", content: "b\n" });
        await appeler(c, "git_commit", { repo: "proj", message: "commit b" });
        writeFileSync(travail("proj/a.txt"), "a2\n");
        await appeler(c, "git_action", { repo: "proj", action: "stage", paths: ["a.txt"] });
        writeFileSync(travail("proj/b.txt"), "b2\n");
        writeFileSync(travail("proj/c.txt"), "c\n");
        const r = await appeler(c, "git_abandon", { repo: "proj" });
        const prefixe = `refs/elpis/abandoned/${br}-`;
        expect(r).toMatchObject({
          ok: true,
          returned_to: "main",
          deleted_branch: br,
          saved: {
            changes: { files_total: 3, files: ["M  a.txt", " M b.txt", "?? c.txt"] },
            branch: { unmerged_commits: 1 },
          },
        });
        const saved = r["saved"] as { changes: Dict; branch: Dict };
        expect(String(saved.branch["ref"])).toMatch(new RegExp(`^${prefixe}\\d{8}T\\d{6}Z$`, "u"));
        expect(saved.changes["ref"]).toBe(`${String(saved.branch["ref"])}-changes`);
        expect(r["recover"]).toBe(
          `git switch -c ${br} ${String(saved.branch["ref"])} && git cherry-pick --no-commit ${String(saved.changes["ref"])}`,
        );
        expect(existsSync(travail("proj/c.txt"))).toBe(false);
        expect(git(travail("proj"), "branch", "--list", br)).toBe("");
        for (const cmd of String(r["recover"]).split(" && "))
          git(travail("proj"), ...cmd.split(" ").slice(1));
        expect(git(travail("proj"), "branch", "--show-current").trim()).toBe(br);
        expect(git(travail("proj"), "log", "--format=%s").split("\n")).toContain("commit b");
        for (const [f, v] of [
          ["a.txt", "a2\n"],
          ["b.txt", "b2\n"],
          ["c.txt", "c\n"],
        ])
          expect([f, readFileSync(travail(`proj/${f}`), "utf-8")]).toEqual([f, v]);
      } finally {
        await fermer();
      }
    });

    it("rien à sauver sur un arbre propre sans commit ; keep_branch : branche gardée, changements sauvés quand même", async () => {
      const { c, fermer } = await client(faux().rappel);
      try {
        await appeler(c, "git_action", { repo: "proj", action: "init" });
        await appeler(c, "git_write", { repo: "proj", action: "write", path: "a.txt", content: "a\n" });
        await appeler(c, "git_commit", { repo: "proj", message: "a" });
        await appeler(c, "git_start_work", { repo: "proj", branch_intent: "vide" });
        const vide = await appeler(c, "git_abandon", { repo: "proj" });
        expect(vide).toMatchObject({ ok: true, saved: { changes: null, branch: null }, recover: null });
        expect(String(vide["note"])).toContain("Nothing needed saving");
        const br = String(
          (await appeler(c, "git_start_work", { repo: "proj", branch_intent: "garde" }))["branch"],
        );
        writeFileSync(travail("proj/x.txt"), "x\n");
        const r = await appeler(c, "git_abandon", { repo: "proj", keep_branch: true });
        expect(r).toMatchObject({ ok: true, kept_branch: br, deleted_branch: null, saved: { branch: null } });
        const chg = String((r["saved"] as { changes: Dict }).changes["ref"]);
        expect(r["recover"]).toBe(`git switch ${br} && git cherry-pick --no-commit ${chg}`);
        expect(existsSync(travail("proj/x.txt"))).toBe(false);
        for (const cmd of String(r["recover"]).split(" && "))
          git(travail("proj"), ...cmd.split(" ").slice(1));
        expect(readFileSync(travail("proj/x.txt"), "utf-8")).toBe("x\n");
      } finally {
        await fermer();
      }
    });
  },
);

describe.skipIf(!PYTHON || !LAN)("réseau par le relais authentifiant", () => {
  it("clone avec le jeton du connecteur de l'hôte exact ; submit pousse la seule branche d'agent et demande la PR au core sans jeton", async () => {
    amont = await demarrerAmont(racine, true, LAN ?? "");
    const f = faux({ jeton: true });
    const { c, fermer } = await client(f.rappel);
    try {
      expect(await appeler(c, "git_clone", { url: amont.url, into_path: "copie" })).toMatchObject({
        ok: true,
      });
      expect(readFileSync(travail("copie/a.txt"), "utf-8")).toBe("a\n");
      expect(readFileSync(travail("copie/.git/config"), "utf-8")).not.toContain(JETON);
      const br = String(
        (await appeler(c, "git_start_work", { repo: "copie", branch_intent: "fix-b" }))["branch"],
      );
      await appeler(c, "git_write", { repo: "copie", action: "write", path: "b.txt", content: "b\n" });
      expect(await appeler(c, "git_commit", { repo: "copie", message: "fix: b" })).toMatchObject({
        ok: true,
      });
      const s = await appeler(c, "git_submit", { repo: "copie", title: "Corrige b" });
      expect(s).toMatchObject({
        ok: true,
        branch: br,
        commits_pushed: 1,
        provider: "gitea",
        pr_url: "http://forge/o/r/pulls/1",
        pr_number: 1,
        draft: true,
        already_open: false,
        base: "main",
        message:
          "PR opened: http://forge/o/r/pulls/1 (draft=True). Hand this URL to a human for review/merge.",
      });
      expect(f.prs).toHaveLength(1);
      const [compte, demande] = f.prs[0] as [Dict, Dict];
      expect(compte).toEqual({ user_id: 7, username: "alice" });
      expect(demande).toMatchObject({
        remote_url: amont.url,
        head: br,
        base: "main",
        title: "Corrige b",
        draft: true,
      });
      expect(String(demande["body"])).toContain("* fix: b");
      expect(JSON.stringify(f.prs)).not.toContain(JETON);
      expect(git(path.join(amont.racine, "depot.git"), "branch", "--list")).toContain(br);
      expect(amont.vus.every(([, , a]) => a === undefined || a === BASIC)).toBe(true);
      expect(amont.vus.some(([, , a]) => a === BASIC)).toBe(true);
      // Présence vérifiée sans lecture par clone et submit ; jeton lu pour les seules opérations réseau (clone, push).
      expect(f.presences).toEqual([
        [{ user_id: 7, username: "alice" }, amont.url],
        [{ user_id: 7, username: "alice" }, amont.url],
      ]);
      expect(f.enregistres.every((e) => (e as unknown[])[1] === amont?.url)).toBe(true);
    } finally {
      await fermer();
    }
  }, 60_000);

  it("dépôt privé sans compte git pour l'hôte : clone refusé, le modèle doit demander à l'utilisateur d'ajouter un compte git ; identifiant demandé pour le compte signé", async () => {
    amont = await demarrerAmont(racine, true, LAN ?? "");
    const f = faux({ jeton: false });
    const { c, fermer } = await client(f.rappel);
    try {
      const r = await appeler(c, "git_clone", { url: amont.url, into_path: "prive" });
      expect(r).toMatchObject({ ok: false, error: "clone_failed", credentialed: false });
      expect(String(r["fix"])).toContain(
        "Ask the user to add a Git account for this host in Settings › Git accounts",
      );
      expect(new Set(f.enregistres.map((e) => JSON.stringify(e)))).toEqual(
        new Set([JSON.stringify([{ user_id: 7, username: "alice" }, amont.url])]),
      );
      expect(f.presences).toEqual([[{ user_id: 7, username: "alice" }, amont.url]]);
    } finally {
      await fermer();
    }
  }, 60_000);

  it("issue du core autre qu'une PR ouverte : injoignable, refus, issue inconnue ou cible refusée ; branche poussée quand même", async () => {
    amont = await demarrerAmont(racine, false, LAN ?? "");
    const f = faux({ issue: null });
    const { c, fermer } = await client(f.rappel);
    try {
      await appeler(c, "git_clone", { url: amont.url, into_path: "copie" });
      const br = String(
        (await appeler(c, "git_start_work", { repo: "copie", branch_intent: "fix-c" }))["branch"],
      );
      await appeler(c, "git_write", { repo: "copie", action: "write", path: "c.txt", content: "c\n" });
      await appeler(c, "git_commit", { repo: "copie", message: "fix: c" });
      expect(await appeler(c, "git_submit", { repo: "copie", title: "Corrige c" })).toMatchObject({
        ok: false,
        error: "pr_service_unavailable",
        branch: br,
        commits_pushed: 1,
      });
      for (const [issue, code] of [
        [{ outcome: "rejected", status: 422 }, "pr_request_rejected"],
        [{ outcome: "bizarre" }, "pr_service_error"],
        [{ outcome: "error", message: "unsafe_pr_target", hint: "h" }, "unsafe_pr_target"],
        [{ outcome: "error", message: "unexpected: 'int' object has no attribute 'get'" }, "unexpected"],
      ] as const) {
        f.issue = issue as unknown as IssuePr;
        const r = await appeler(c, "git_submit", { repo: "copie", title: "Corrige c" });
        expect(r, code).toMatchObject({ ok: false, error: code });
        expect(JSON.stringify(r), code).not.toContain("PR opened");
      }
      expect(existsSync(travail("copie/c.txt"))).toBe(true);
      expect(git(path.join(amont.racine, "depot.git"), "branch", "--list")).toContain(br);
    } finally {
      await fermer();
    }
  }, 60_000);
});
