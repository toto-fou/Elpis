// SPDX-License-Identifier: MIT
/** packages/contracts/test/toolhost/git.test.ts — contrats des routes git du bac rejoués contre l'hôte d'outils réel : agent Python sans conteneur, vrai git, amont `git http-backend` joint par une adresse du réseau local. */
import { mkdirSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";

import { AgentClient, arreterRelais, oublierAnciensVus } from "@elpis/fichiers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dossierTemporaire } from "../../../../apps/toolhost/test/aides";
import { BacTest, PYTHON } from "../../../fichiers/test/aides";
import { demarrerAmont, git, JETON } from "../../../fichiers/test/amont-git";
import type { Amont } from "../../../fichiers/test/amont-git";
import { appelerHote, hoteTest, routesDuDomaine, verifierToolhost } from "./aides";
import type { HoteTest } from "./aides";

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

/** Relais TCP de `ip:port` vers l'amont en boucle locale (le relais git refuse la boucle locale). */
async function relaisTcp(ip: string, port: number): Promise<{ port: number; fermer(): Promise<void> }> {
  const s: Server = createServer((c) => {
    const u = connect(port, "127.0.0.1");
    c.pipe(u);
    u.pipe(c);
    c.on("error", () => u.destroy());
    u.on("error", () => c.destroy());
  });
  await new Promise<void>((ok) => s.listen(0, ip, ok));
  return { port: (s.address() as AddressInfo).port, fermer: () => new Promise((ok) => s.close(() => ok())) };
}

let racine = "";
let nettoyer: () => void = () => undefined;
let bac: BacTest;
let h: HoteTest;
let work = "";
const couvertes = new Set<string>();

async function ok(methode: "GET" | "POST", route: string, donnees: Record<string, unknown> = {}) {
  const url =
    `/api/sandbox/git/${route}` +
    (methode === "GET" && Object.keys(donnees).length
      ? `?${new URLSearchParams(donnees as Record<string, string>).toString()}`
      : "");
  const r = await appelerHote(h, methode, url, methode === "POST" ? donnees : undefined);
  return { statut: r.statut, corps: verifierToolhost(methode, url, r, couvertes) as Record<string, unknown> };
}

beforeEach(async () => {
  [racine, nettoyer] = dossierTemporaire("elpis-ct-git-");
  bac = new BacTest(racine, "hugo");
  work = bac.sandboxPath;
  oublierAnciensVus();
  const agent = new AgentClient(bac);
  h = await hoteTest(undefined, { bacFichiers: { racine: async () => work, agent: async () => agent } });
});

afterEach(async () => {
  await h.fermer();
  await bac.arreter();
  await arreterRelais();
  nettoyer();
});

/** `git init` par la route, branche initiale `main`. */
async function initialiser(dir: string, donnees: Record<string, unknown> = {}): Promise<void> {
  await ok("POST", "init", { dir, ...donnees });
  git(path.join(work, dir), "symbolic-ref", "HEAD", "refs/heads/main");
}

function ecrire(depot: string, fichier: string, contenu: string, message: string): void {
  writeFileSync(path.join(work, depot, fichier), contenu);
  git(path.join(work, depot), "add", fichier);
  git(path.join(work, depot), "commit", "-q", "-m", message);
}

describe.skipIf(!PYTHON)("contrats REST : git du bac, routes locales (hôte d'outils réel)", () => {
  it("dépôts, état, branches, journal, diffs, arbre, lecture d'un fichier d'un commit", async () => {
    expect((await ok("GET", "status", { repo: "absent" })).corps).toEqual({ is_repo: false });
    await initialiser("p", { user_name: "Moi", user_email: "moi@example.org" });
    ecrire("p", "a.txt", "a\n", "premier");
    ecrire("p", "b.txt", "b\n", "second");
    git(path.join(work, "p"), "branch", "dev");
    writeFileSync(path.join(work, "p", "a.txt"), "a2\n");
    writeFileSync(path.join(work, "p", "nouveau.txt"), "n\n");
    writeFileSync(path.join(work, "p", "b.txt"), "b2\n");
    git(path.join(work, "p"), "add", "b.txt");
    expect((await ok("GET", "repos")).corps["repos"]).toHaveLength(1);
    const statut = (await ok("GET", "status", { repo: "p" })).corps;
    expect(statut).toMatchObject({ is_repo: true, branch: "main" });
    expect((await ok("GET", "branches", { repo: "p" })).corps).toMatchObject({
      current: "main",
      local: ["dev", "main"],
    });
    const journal = (await ok("GET", "log", { repo: "p", n: "5" })).corps["commits"] as { hash: string }[];
    expect(journal).toHaveLength(2);
    await ok("GET", "diff", { repo: "p", path: "a.txt" });
    await ok("GET", "diff", { repo: "p", staged: "1" });
    const hash = journal[0]?.hash ?? "";
    expect((await ok("GET", "commit-diff", { repo: "p", hash })).corps["files"]).toHaveLength(1);
    expect((await ok("GET", "show-file", { repo: "p", hash, path: "a.txt" })).corps).toEqual({
      content: "a\n",
    });
    expect((await ok("GET", "tree", { repo: "p" })).corps["items"]).toHaveLength(3);
    expect((await ok("GET", "show-file", { repo: "p", hash })).statut).toBe(400);
  }, 60_000);

  it("index, validation, branches, fusion avec conflit puis résolution, remisage, rebase, restauration", async () => {
    await initialiser("q");
    git(path.join(work, "q"), "config", "user.name", "Moi");
    git(path.join(work, "q"), "config", "user.email", "moi@example.org");
    ecrire("q", "f.txt", "base\n", "base");
    await ok("POST", "config", { repo: "q", "user.name": "Moi", "user.email": "moi@example.org" });
    writeFileSync(path.join(work, "q", "g.txt"), "g\n");
    await ok("POST", "stage", { repo: "q", paths: ["g.txt"] });
    await ok("POST", "unstage", { repo: "q", paths: ["g.txt"] });
    await ok("POST", "discard", { repo: "q", paths: ["g.txt"] });
    writeFileSync(path.join(work, "q", "g.txt"), "g\n");
    await ok("POST", "stage", { repo: "q" });
    expect((await ok("POST", "commit", { repo: "q", message: "ajout g" })).corps["ok"]).toBe(true);
    expect((await ok("POST", "commit", { repo: "q", message: "" })).statut).toBe(400);
    await ok("POST", "checkout", { repo: "q", branch: "autre", create: true });
    ecrire("q", "f.txt", "autre\n", "côté autre");
    await ok("POST", "checkout", { repo: "q", branch: "main" });
    ecrire("q", "f.txt", "principal\n", "côté main");
    const apercu = (await ok("GET", "merge-preview", { repo: "q", branch: "autre" })).corps;
    expect(apercu["commits"]).toHaveLength(1);
    const fusion = (await ok("POST", "merge", { repo: "q", branch: "autre" })).corps;
    expect(fusion).toMatchObject({ ok: false, conflicts: true, conflicted_files: ["f.txt"] });
    await ok("POST", "merge-abort", { repo: "q" });
    await ok("POST", "merge", { repo: "q", branch: "autre" });
    expect((await ok("POST", "merge-resolve", { repo: "q", strategy: "theirs" })).corps).toMatchObject({
      resolved: 1,
      all_resolved: true,
    });
    await ok("POST", "checkout", { repo: "q", branch: "neuve", create: true });
    ecrire("q", "h.txt", "h\n", "sur neuve");
    await ok("POST", "checkout", { repo: "q", branch: "main" });
    expect((await ok("POST", "merge", { repo: "q", branch: "neuve" })).corps).toMatchObject({
      ok: true,
      conflicts: false,
    });
    writeFileSync(path.join(work, "q", "f.txt"), "modifié\n");
    expect((await ok("POST", "stash", { repo: "q", action: "push", message: "m" })).statut).toBe(200);
    expect((await ok("POST", "stash", { repo: "q", action: "list" })).corps["stashes"]).toHaveLength(1);
    await ok("POST", "stash", { repo: "q", action: "pop" });
    git(path.join(work, "q"), "checkout", "--", "f.txt");
    await ok("POST", "checkout", { repo: "q", branch: "autre" });
    ecrire("q", "i.txt", "i\n", "sur autre");
    await ok("POST", "rebase", { repo: "q", branch: "main" });
    const dernier = (await ok("GET", "log", { repo: "q", n: "3" })).corps["commits"] as { hash: string }[];
    await ok("POST", "restore-commit", { repo: "q", hash: dernier[2]?.hash ?? "" });
    await ok("POST", "revert-last", { repo: "q" });
    git(path.join(work, "q"), "remote", "add", "local", path.join(work, "p"));
    expect((await ok("POST", "fetch", { repo: "q" })).corps).toEqual({ ok: true, skipped: ["local"] });
    await ok("POST", "remote", { repo: "q", url: "http://192.0.2.50/x.git", name: "origin" });
  }, 90_000);

  it("cloner dans un dossier existant non vide est refusé", async () => {
    mkdirSync(path.join(work, "plein"));
    writeFileSync(path.join(work, "plein", "x"), "x");
    expect((await ok("POST", "clone", { url: "http://192.0.2.50/x.git", dir: "plein" })).statut).toBe(409);
  }, 30_000);
});

describe.skipIf(!PYTHON || !IP)(
  "contrats REST : git du bac, réseau par le relais (amont du réseau local)",
  () => {
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

    it("clone, tirer, pousser, récupérer", async () => {
      const identifiants = { cred_user: "u", cred_token: JETON };
      expect(
        (await ok("POST", "clone", { url, dir: "copie", ...identifiants, provider_type: "gitea" })).corps,
      ).toMatchObject({
        ok: true,
        repo: "copie",
      });
      writeFileSync(path.join(amont.src, "c.txt"), "c\n");
      git(amont.src, "add", "c.txt");
      git(amont.src, "commit", "-q", "-m", "c");
      git(amont.src, "push", "-q", path.join(amont.racine, "depot.git"), "main");
      expect((await ok("POST", "pull", { repo: "copie", ...identifiants, rebase: false })).statut).toBe(200);
      writeFileSync(path.join(work, "copie", "b.txt"), "b\n");
      await ok("POST", "stage", { repo: "copie" });
      await ok("POST", "commit", { repo: "copie", message: "b" });
      expect((await ok("POST", "push", { repo: "copie", ...identifiants })).corps).toMatchObject({
        ok: true,
      });
      expect((await ok("POST", "push", { repo: "copie", ...identifiants })).corps).toEqual({
        ok: true,
        message: "Déjà à jour",
      });
      git(path.join(work, "copie"), "remote", "add", "local", amont.src);
    }, 90_000);

    it("toutes les routes du domaine ont été interrogées", () => {
      const attendues = routesDuDomaine("bac-git");
      expect([...couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
    });
  },
);
