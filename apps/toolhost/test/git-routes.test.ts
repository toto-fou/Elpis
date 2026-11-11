// SPDX-License-Identifier: MIT
/** apps/toolhost/test/git-routes.test.ts — routes Git de l'hôte de bout en bout (tests/sandbox/test_git_routes_agent_2026_09_29.py) : vrai agent Python sans conteneur, vrai git, relais TS, amont `git http-backend` joint par une adresse du réseau local. */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { createServer, connect } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { AgentClient, arreterRelais, oublierAnciensVus } from "@elpis/fichiers";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BacTest, dossierTemporaire, PYTHON } from "../../../packages/fichiers/test/aides";
import { BASIC, demarrerAmont, git, JETON } from "../../../packages/fichiers/test/amont-git";
import type { Amont } from "../../../packages/fichiers/test/amont-git";
import { creerAppToolhost } from "../src/app";
import { RAPPEL_ABSENT } from "../src/fichiers/commun";
import type { RappelFichiers } from "../src/fichiers/commun";
import { reglagesGit, routesGit } from "../src/git/routes";
import { configTest, entetes, journalMuet } from "./aides";

const IDS = { cred_user: "u", cred_token: JETON };

/** Adresse IPv4 privée de la machine : le relais refuse la boucle locale, le LAN est permis. */
function ipLan(): string | null {
  for (const liste of Object.values(networkInterfaces()))
    for (const a of liste ?? [])
      if (
        a.family === "IPv4" &&
        !a.internal &&
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(a.address)
      )
        return a.address;
  return null;
}

const IP = ipLan();

/** Relais TCP de `ip:port` vers l'amont en boucle locale. */
async function relaisTcp(ip: string, port: number): Promise<{ port: number; fermer(): Promise<void> }> {
  const s: Server = createServer((c) => {
    const u = connect(port, "127.0.0.1");
    c.pipe(u);
    u.pipe(c);
    c.on("error", () => u.destroy());
    u.on("error", () => c.destroy());
  });
  await new Promise<void>((ok) => s.listen(0, ip, ok));
  return {
    port: (s.address() as AddressInfo).port,
    fermer: () => new Promise((ok) => s.close(() => ok())),
  };
}

let racine: string;
let nettoyer: () => void;
let bac: BacTest;
let app: FastifyInstance;
let work: string;
let rappel: RappelFichiers;
const enregistres: unknown[][] = [];

async function monter(b: BacTest, r: Partial<RappelFichiers> = {}): Promise<FastifyInstance> {
  const agent = new AgentClient(b);
  rappel = {
    ...RAPPEL_ABSENT,
    enregistrerIdentifiantGit: async (compte, ...a) => {
      enregistres.push([compte.user_id, ...a]);
      return compte.username !== "";
    },
    ...r,
  };
  const a = await creerAppToolhost({
    tc: configTest(),
    familles: [
      {
        nom: "git",
        routes: routesGit({
          bac: { racine: async () => b.sandboxPath, agent: async () => agent },
          rappel,
          journal: journalMuet,
        }),
      },
    ],
    journal: journalMuet,
  });
  return a;
}

async function appel(
  methode: "GET" | "POST",
  route: string,
  donnees?: Dict,
): Promise<{ statut: number; corps: Dict }> {
  const url =
    `/api/sandbox/git/${route}` +
    (methode === "GET" && donnees
      ? `?${new URLSearchParams(donnees as Record<string, string>).toString()}`
      : "");
  const r = await app.inject({
    method: methode,
    url,
    headers: {
      ...entetes(1, "alice"),
      ...(methode === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(methode === "POST" ? { payload: JSON.stringify(donnees ?? {}) } : {}),
  });
  return { statut: r.statusCode, corps: r.json() as Dict };
}

function refs(depot: string): string[] {
  return spawnSync("git", ["for-each-ref", "--format=%(refname)"], { cwd: depot, encoding: "utf-8" })
    .stdout.split(/\s+/u)
    .filter(Boolean);
}

function depotLocal(nom = "p"): string {
  git(work, "init", "-q", "-b", "main", nom);
  const p = path.join(work, nom);
  writeFileSync(path.join(p, "a.txt"), "a\n");
  git(p, "add", "a.txt");
  git(p, "commit", "-q", "-m", "a");
  return p;
}

beforeEach(async () => {
  [racine, nettoyer] = dossierTemporaire("elpis-git-routes-");
  bac = new BacTest(racine, "alice");
  work = bac.sandboxPath;
  enregistres.length = 0;
  oublierAnciensVus();
  app = await monter(bac);
});

afterEach(async () => {
  reglagesGit.sortie = 8 << 20;
  await app.close();
  await bac.arreter();
  await arreterRelais();
  nettoyer();
});

describe.skipIf(!PYTHON || !IP)("réseau par le relais (amont du réseau local)", () => {
  let amont: Amont;
  let relais: { port: number; fermer(): Promise<void> };
  let url = "";

  beforeEach(async () => {
    amont = await demarrerAmont(racine);
    relais = await relaisTcp(IP as string, Number(new URL(amont.url).port));
    url = `http://${IP}:${relais.port}/depot.git`;
  });

  afterEach(async () => {
    await relais.fermer();
    await amont.fermer();
  });

  it("clone, pull, push, fetch : identifiants saisis après le 401, jamais écrits ; enregistrés pour l'hôte", async () => {
    let r = await appel("POST", "clone", { url, dir: "copie", ...IDS, provider_type: "gitea" });
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    expect(r.corps).toEqual({
      ok: true,
      repo: "copie",
      message: "Cloné dans copie/",
      credentials_saved: true,
    });
    expect(enregistres).toEqual([[1, url, "u", JETON, "gitea"]]);
    const config = readFileSync(path.join(work, "copie", ".git", "config"), "utf-8");
    expect(config).toContain(url);
    expect(config).not.toContain(JETON);
    expect(amont.vus[0]?.[2]).toBeUndefined();
    expect(amont.vus.slice(1).every(([, , a]) => a === BASIC)).toBe(true);

    writeFileSync(path.join(amont.src, "c.txt"), "c\n");
    git(amont.src, "add", "c.txt");
    git(amont.src, "commit", "-q", "-m", "c");
    git(amont.src, "push", "-q", path.join(amont.racine, "depot.git"), "main");
    r = await appel("POST", "pull", { repo: "copie", ...IDS });
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    expect(readFileSync(path.join(work, "copie", "c.txt"), "utf-8")).toBe("c\n");

    writeFileSync(path.join(work, "copie", "b.txt"), "b\n");
    expect((await appel("POST", "stage", { repo: "copie" })).statut).toBe(200);
    r = await appel("POST", "commit", { repo: "copie", message: "b" });
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    r = await appel("POST", "push", { repo: "copie", ...IDS });
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    const log = spawnSync("git", ["log", "-1", "--format=%s|%an", "main"], {
      cwd: path.join(amont.racine, "depot.git"),
      encoding: "utf-8",
    });
    expect(log.stdout.trim()).toBe("b|alice");

    git(path.join(work, "copie"), "remote", "add", "local", amont.src);
    amont.vus.length = 0;
    r = await appel("POST", "fetch", { repo: "copie", ...IDS });
    expect(r.statut, JSON.stringify(r.corps)).toBe(400);
    expect(amont.vus.length).toBeGreaterThan(0);
    expect(amont.vus.every(([, , a]) => a === undefined)).toBe(true);
    await app.close();
    app = await monter(bac, {
      gitCredential: async () => ({ username: "u", token: JETON, host: `${IP}:${relais.port}` }),
    });
    r = await appel("POST", "fetch", { repo: "copie" });
    expect(r).toEqual({ statut: 200, corps: { ok: true, skipped: ["local"] } });
  }, 90_000);

  it("push : configuration de git suivie, rien de nouveau → « Déjà à jour »", async () => {
    expect((await appel("POST", "clone", { url, dir: "copie", ...IDS })).statut).toBe(200);
    const c = path.join(work, "copie");
    git(c, "branch", "autre");
    git(c, "config", "remote.origin.push", "refs/heads/*:refs/heads/revue/*");
    git(c, "tag", "-a", "v1", "-m", "v1");
    git(c, "config", "push.followTags", "true");
    let r = await appel("POST", "push", { repo: "copie", ...IDS });
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    expect(refs(path.join(amont.racine, "depot.git"))).toEqual([
      "refs/heads/main",
      "refs/heads/revue/autre",
      "refs/heads/revue/main",
      "refs/tags/v1",
    ]);
    r = await appel("POST", "push", { repo: "copie", ...IDS });
    expect(r).toEqual({ statut: 200, corps: { ok: true, message: "Déjà à jour" } });
  }, 90_000);

  it("push : suppression refusée en 409, rejet de l'amont en 400, réécriture non demandée en 409", async () => {
    expect((await appel("POST", "clone", { url, dir: "copie", ...IDS })).statut).toBe(200);
    const c = path.join(work, "copie");
    git(c, "config", "remote.origin.push", ":refs/heads/main");
    let r = await appel("POST", "push", { repo: "copie", ...IDS });
    expect(r.statut).toBe(409);
    expect(r.corps["detail"]).toContain("suppression de refs/heads/main refusée");
    expect(refs(path.join(amont.racine, "depot.git"))).toEqual(["refs/heads/main"]);
    git(c, "config", "--unset", "remote.origin.push");

    writeFileSync(path.join(amont.src, "z.txt"), "z\n");
    git(amont.src, "add", "z.txt");
    git(amont.src, "commit", "-q", "-m", "z");
    git(amont.src, "push", "-q", path.join(amont.racine, "depot.git"), "main");
    writeFileSync(path.join(c, "b.txt"), "b\n");
    git(c, "add", "b.txt");
    git(c, "commit", "-q", "-m", "b");
    r = await appel("POST", "push", { repo: "copie", ...IDS });
    expect(r.statut, JSON.stringify(r.corps)).toBe(400);
    expect(r.corps["detail"]).toContain("rejected");
    git(c, "config", "remote.origin.push", "+refs/heads/main:refs/heads/main");
    r = await appel("POST", "push", { repo: "copie", ...IDS });
    expect(r.statut).toBe(409);
    expect(r.corps["detail"]).toContain("forcée");
  }, 90_000);

  it("clone : cible occupée 409, échec 400 sans reste, nom invalide 400 ; nouvelle branche poussée et suivie", async () => {
    mkdirSync(path.join(work, "plein"));
    writeFileSync(path.join(work, "plein", "x"), "x");
    expect((await appel("POST", "clone", { url, dir: "plein", ...IDS })).statut).toBe(409);
    const r = await appel("POST", "clone", { url: url.replace("depot.git", "absent.git"), ...IDS });
    expect(r.statut).toBe(400);
    expect(existsSync(path.join(work, "absent"))).toBe(false);
    expect((await appel("POST", "clone", { url, dir: "../x", ...IDS })).statut).toBe(400);

    expect((await appel("POST", "clone", { url, dir: "copie", ...IDS })).statut).toBe(200);
    expect((await appel("POST", "checkout", { repo: "copie", branch: "neuve", create: true })).statut).toBe(
      200,
    );
    expect((await appel("POST", "push", { repo: "copie", ...IDS })).statut).toBe(200);
    expect(refs(path.join(amont.racine, "depot.git"))).toContain("refs/heads/neuve");
    const suivi = spawnSync("git", ["rev-parse", "--abbrev-ref", "neuve@{upstream}"], {
      cwd: path.join(work, "copie"),
      encoding: "utf-8",
    }).stdout.trim();
    expect(suivi).toBe("origin/neuve");
  }, 90_000);
});

describe.skipIf(!PYTHON)("routes locales par l'agent", () => {
  it("refus du relais et de la garde : sans remote 400, métadonnées 403, file:// 403", async () => {
    depotLocal();
    let r = await appel("POST", "push", { repo: "p" });
    expect(r.statut).toBe(400);
    expect(r.corps["detail"]).toContain("introuvable");
    git(path.join(work, "p"), "remote", "add", "origin", "http://169.254.169.254/x.git");
    r = await appel("POST", "push", { repo: "p" });
    expect(r.statut).toBe(403);
    expect(r.corps["detail"]).toContain("anti-SSRF");
    expect((await appel("POST", "remote", { repo: "p", url: "file:///etc/passwd" })).statut).toBe(403);
    expect((await appel("POST", "remote", { repo: "p", url: "http://127.0.0.1:9/x.git" })).statut).toBe(403);
  }, 60_000);

  it("dépôts du bac et branche courante (HEAD détachée, worktree, dépôt dans un dépôt)", async () => {
    git(work, "init", "-q", "-b", "main", "a");
    git(path.join(work, "a"), "commit", "-q", "--allow-empty", "-m", "x");
    git(path.join(work, "a"), "checkout", "-q", "--detach");
    git(work, "init", "-q", "-b", "dev", "g/b");
    git(path.join(work, "a"), "worktree", "add", "-q", "-b", "arbre", path.join(work, "w", "arbre"));
    const r = await appel("GET", "repos");
    expect(r.statut).toBe(200);
    const repos = Object.fromEntries((r.corps["repos"] as Dict[]).map((x) => [x["path"], x["branch"]]));
    expect(repos).toEqual({ a: "(HEAD)", "g/b": "dev", "w/arbre": "arbre" });
  }, 60_000);

  it("init dans un sous-dossier ; abandon de modifications sans sortir du dépôt ni suivre un lien", async () => {
    let r = await appel("POST", "init", { dir: "neuf/sous", user_name: "Moi" });
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    expect(existsSync(path.join(work, "neuf", "sous", ".git"))).toBe(true);
    writeFileSync(path.join(work, "neuf", "sous", "tmp.txt"), "x");
    writeFileSync(path.join(work, "garde.txt"), "x");
    r = await appel("POST", "discard", { repo: "neuf/sous", paths: ["tmp.txt", "../../garde.txt"] });
    expect(r.statut).toBe(200);
    expect(existsSync(path.join(work, "neuf", "sous", "tmp.txt"))).toBe(false);
    expect(existsSync(path.join(work, "garde.txt"))).toBe(true);

    const p = depotLocal("r");
    mkdirSync(path.join(work, "autre"));
    writeFileSync(path.join(work, "autre", "precieux.txt"), "x");
    symlinkSync("../autre", path.join(p, "lnk"));
    mkdirSync(path.join(p, "vrai"));
    writeFileSync(path.join(p, "vrai", "neuf.txt"), "x");
    r = await appel("POST", "discard", { repo: "r", paths: ["lnk/precieux.txt", "vrai/neuf.txt"] });
    expect(r.statut).toBe(200);
    expect(existsSync(path.join(work, "autre", "precieux.txt"))).toBe(true);
    expect(existsSync(path.join(p, "vrai", "neuf.txt"))).toBe(false);
  }, 60_000);

  it("`~` est un nom de dépôt ; status, branches, log, diff, arbre, commit-diff, show-file", async () => {
    git(work, "init", "-q", "-b", "main", "~");
    let r = await appel("GET", "status", { repo: "~" });
    expect(r.corps["is_repo"]).toBe(true);
    expect(r.corps["branch"]).toBe("main");
    expect((await appel("GET", "status")).corps).toEqual({ is_repo: false });

    const p = depotLocal();
    const h = spawnSync("git", ["rev-parse", "HEAD"], { cwd: p, encoding: "utf-8" }).stdout.trim();
    r = await appel("GET", "commit-diff", { repo: "p", hash: h });
    expect(r.corps["files"]).toEqual([{ status: "A", path: "a.txt" }]);
    expect(r.corps["truncated"]).toBe(false);
    expect(r.corps["author"]).toBe("t");
    writeFileSync(path.join(p, "gros.txt"), "x".repeat(5000));
    git(p, "add", "gros.txt");
    git(p, "commit", "-q", "-m", "gros");
    reglagesGit.sortie = 1000;
    r = await appel("GET", "show-file", { repo: "p", hash: "HEAD", path: "gros.txt" });
    expect(r.statut).toBe(413);
    writeFileSync(path.join(p, "gros.txt"), "y".repeat(5000));
    expect((await appel("GET", "diff", { repo: "p" })).corps["truncated"]).toBe(true);
    reglagesGit.sortie = 8 << 20;
    r = await appel("GET", "status", { repo: "p" });
    expect(r.corps["modified"]).toEqual([{ path: "gros.txt", status: "M", add: 1, del: 1 }]);
    r = await appel("GET", "log", { repo: "p", n: "1" });
    expect((r.corps["commits"] as Dict[]).map((c) => c["message"])).toEqual(["gros"]);
    r = await appel("GET", "tree", { repo: "p" });
    expect((r.corps["items"] as Dict[]).map((i) => i["name"])).toEqual(["a.txt", "gros.txt"]);
    expect((await appel("POST", "checkout", { repo: "p", branch: "feat", create: true })).statut).toBe(200);
    expect((await appel("GET", "branches", { repo: "p" })).corps["current"]).toBe("feat");
    expect((await appel("POST", "checkout", { repo: "p", branch: "-x", create: true })).statut).toBe(400);
  }, 60_000);

  it("pull d'une branche qui suit une branche locale : fusion seule, sans réseau", async () => {
    const p = depotLocal();
    git(p, "checkout", "-q", "-b", "feature", "--track", "main");
    git(p, "checkout", "-q", "main");
    writeFileSync(path.join(p, "b.txt"), "b\n");
    git(p, "add", "b.txt");
    git(p, "commit", "-q", "-m", "b");
    git(p, "checkout", "-q", "feature");
    const r = await appel("POST", "pull", { repo: "p" });
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    expect(existsSync(path.join(p, "b.txt"))).toBe(true);
  }, 60_000);

  it("restauration d'un commit : sale → 409, forcée → sauvegarde étiquetée ; annulation du dernier commit", async () => {
    const p = depotLocal();
    const premier = spawnSync("git", ["rev-parse", "HEAD"], { cwd: p, encoding: "utf-8" }).stdout.trim();
    writeFileSync(path.join(p, "a.txt"), "deux\n");
    git(p, "commit", "-q", "-am", "deux");
    writeFileSync(path.join(p, "a.txt"), "sale\n");
    let r = await appel("POST", "restore-commit", { repo: "p", hash: premier });
    expect(r.statut).toBe(409);
    r = await appel("POST", "restore-commit", { repo: "p", hash: premier, force: true });
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    expect(String(r.corps["backup_ref"])).toMatch(/^restore-backup-\d+$/u);
    expect(readFileSync(path.join(p, "a.txt"), "utf-8")).toBe("a\n");
    expect(refs(p)).toContain(`refs/tags/${String(r.corps["backup_ref"])}`);
    r = await appel("POST", "revert-last", { repo: "p" });
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    expect(readFileSync(path.join(p, "a.txt"), "utf-8")).toBe("deux\n");
  }, 60_000);

  it("rafraîchissement passif : conteneur arrêté → 503, ni redémarré ni agent lancé", async () => {
    depotLocal();
    let reveils = 0;
    const arrete = new (class extends BacTest {
      override async ensureRunning() {
        reveils++;
        return super.ensureRunning();
      }
    })(racine, "alice");
    arrete.running = false;
    await app.close();
    app = await monter(arrete);
    for (const [route, q] of [
      ["status", { repo: "p" }],
      ["repos", {}],
      ["tree", { repo: "p" }],
    ] as const)
      expect((await appel("GET", route, q)).statut, route).toBe(503);
    expect(reveils).toBe(0);
    expect(arrete.demarrages).toBe(0);
  }, 60_000);
});
