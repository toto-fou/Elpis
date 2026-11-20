// SPDX-License-Identifier: MIT
/** apps/toolhost/test/git-regle.test.ts — règle Git du profil réseau vue par les outils git : clone, action, push et PR refusés hors règle sans conseil anti-SSRF, portées des comptes Git demandées au core, PR ouverte sur l'URL du push. */
import { networkInterfaces } from "node:os";
import path from "node:path";

import { configBacDepuis, profilParId } from "@elpis/bac";
import type { ProfilReseau } from "@elpis/bac";
import type { Dict } from "@elpis/commun";
import { AgentClient, arreterRelais } from "@elpis/fichiers";
import { ouvrirEnMemoire, ServeurOutils } from "@elpis/outils-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BacTest, dossierTemporaire, PYTHON } from "../../../packages/fichiers/test/aides";
import { demarrerAmont, git, JETON } from "../../../packages/fichiers/test/amont-git";
import type { Amont } from "../../../packages/fichiers/test/amont-git";
import { brancherRappelProfil, Espace, installerFabriqueEspace } from "../src/mcp/espace";
import { familleGit } from "../src/mcp/git/famille";
import type { RappelGit } from "../src/mcp/git/famille";

/** Première IPv4 non locale (la garde du relais refuse la boucle). */
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
  [racine, nettoyer] = dossierTemporaire("elpis-git-regle-");
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

const profil = (git_access: string, git_servers: string[] = []): ProfilReseau =>
  profilParId(
    configBacDepuis({ network_profiles: [{ id: "p", name: "P", mode: "bridge", git_access, git_servers }] }),
    "p",
  );

interface Faux {
  readonly rappel: RappelGit;
  readonly prs: [Dict, Dict][];
  readonly portees: { host: string; path: string; exact?: boolean }[];
  portee: { host: string; path: string; exact?: boolean }[];
  appelsPortees: number;
}

/** Core simulé : le jeton de l'amont, les portées des comptes Git réglables, PR notées. */
function faux(): Faux {
  const f = { prs: [], portees: [], portee: [], appelsPortees: 0 } as unknown as Faux;
  const hote = (url: string): string => url.replace(/^https?:\/\//u, "").split("/")[0] ?? "";
  const rappel: RappelGit = {
    actif: true,
    identityForUsername: (u) =>
      Promise.resolve(u === "alice" ? { user_id: 7, network_profile_id: "isolated" } : null),
    gitCredential: (_compte, url) =>
      Promise.resolve(
        amont && hote(url) === hote(amont.url)
          ? { username: "u", token: JETON, host: hote(amont.url) }
          : null,
      ),
    identifiantGitDisponible: (_compte, url) =>
      Promise.resolve(Boolean(amont && hote(url) === hote(amont.url))),
    connectorHosts: () => Promise.resolve([]),
    connectorScopes: () => {
      f.appelsPortees += 1;
      return Promise.resolve(f.portee);
    },
    ouvrirPr: (compte, d) => {
      f.prs.push([compte as unknown as Dict, d as unknown as Dict]);
      return Promise.resolve({
        outcome: "opened",
        provider_type: "gitea",
        pr_url: "http://forge/o/r/pulls/1",
        pr_number: 1,
        already_open: false,
      });
    },
  };
  return Object.assign(f, { rappel });
}

async function client(rappel: RappelGit): Promise<{ c: Client; fermer: () => Promise<void> }> {
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

const REFUS_SERVEURS =
  "repository refused: this repository is not allowed for this sandbox; only the administrator can allow it.";
const REFUS_COMPTES =
  "repository refused: none of the user's Git accounts covers it; the user can add one in Settings › Secrets › Git accounts, or ask the administrator.";

describe.skipIf(!PYTHON || !LAN)("règle Git du profil dans les outils git", () => {
  const hote = (): string =>
    (amont?.url ?? "").slice("http://".length, (amont?.url ?? "").indexOf("/", "http://".length));
  const aucuneRequete = (): void => expect(amont?.vus).toEqual([]);

  it("git_clone hors des serveurs choisis : git_rule_refused, texte anglais sans conseil anti-SSRF, aucune requête", async () => {
    amont = await demarrerAmont(racine, true, LAN ?? "");
    bac.networkProfile = profil("servers", ["autre.lan"]);
    const { c, fermer } = await client(faux().rappel);
    try {
      const r = await appeler(c, "git_clone", { url: amont.url, into_path: "copie" });
      expect(r).toMatchObject({ ok: false, error: "git_rule_refused" });
      expect(String(r["message"])).toBe(`git_rule_refused: ${REFUS_SERVEURS}`);
      expect(JSON.stringify(r)).not.toMatch(/SSRF|loopback|link-local|clone_url_blocked/iu);
      aucuneRequete();
    } finally {
      await fermer();
    }
  }, 60_000);

  it("git_action clone : même refus ; init et dépôts locaux ne sont pas concernés", async () => {
    amont = await demarrerAmont(racine, true, LAN ?? "");
    bac.networkProfile = profil("servers", []);
    const { c, fermer } = await client(faux().rappel);
    try {
      const r = await appeler(c, "git_action", { repo: "copie", action: "clone", target: amont.url });
      expect(r).toMatchObject({ ok: false, error: "git_rule_refused" });
      expect(String(r["message"])).toContain(REFUS_SERVEURS);
      expect(JSON.stringify(r)).not.toMatch(/SSRF/iu);
      expect(await appeler(c, "git_action", { repo: "local", action: "init" })).toMatchObject({ ok: true });
      aucuneRequete();
    } finally {
      await fermer();
    }
  }, 60_000);

  it("comptes Git : sans compte qui couvre, refus avec le conseil d'en ajouter un ; portées demandées au core pour le compte signé", async () => {
    amont = await demarrerAmont(racine, true, LAN ?? "");
    bac.networkProfile = profil("accounts");
    const f = faux();
    const { c, fermer } = await client(f.rappel);
    try {
      const r = await appeler(c, "git_clone", { url: amont.url, into_path: "copie" });
      expect(r).toMatchObject({ ok: false, error: "git_rule_refused" });
      expect(String(r["message"])).toBe(`git_rule_refused: ${REFUS_COMPTES}`);
      expect(f.appelsPortees).toBe(1);
      aucuneRequete();
    } finally {
      await fermer();
    }
  }, 60_000);

  it("comptes Git : un compte qui couvre le dépôt permet le clone", async () => {
    amont = await demarrerAmont(racine, true, LAN ?? "");
    bac.networkProfile = profil("accounts");
    const f = faux();
    f.portee = [{ host: hote(), path: "depot", exact: false }];
    const { c, fermer } = await client(f.rappel);
    try {
      expect(await appeler(c, "git_clone", { url: amont.url, into_path: "copie" })).toMatchObject({
        ok: true,
      });
    } finally {
      await fermer();
    }
  }, 60_000);

  it("serveurs choisis : le serveur listé permet le clone ; le push d'un dépôt cloné est refusé quand la règle change, la PR n'est pas demandée", async () => {
    amont = await demarrerAmont(racine, true, LAN ?? "");
    bac.networkProfile = profil("servers", [hote()]);
    const f = faux();
    const { c, fermer } = await client(f.rappel);
    try {
      expect(await appeler(c, "git_clone", { url: amont.url, into_path: "copie" })).toMatchObject({
        ok: true,
      });
      await appeler(c, "git_start_work", { repo: "copie", branch_intent: "fix-b" });
      await appeler(c, "git_write", { repo: "copie", action: "write", path: "b.txt", content: "b\n" });
      expect(await appeler(c, "git_commit", { repo: "copie", message: "fix: b" })).toMatchObject({
        ok: true,
      });
      bac.networkProfile = profil("servers", ["autre.lan"]);
      const s = await appeler(c, "git_submit", { repo: "copie", title: "Corrige b" });
      expect(s).toMatchObject({ ok: false, error: "git_rule_refused" });
      expect(String(s["message"])).toContain(REFUS_SERVEURS);
      expect(f.prs).toEqual([]);
    } finally {
      await fermer();
    }
  }, 60_000);

  it("git_submit : la PR est demandée pour l'URL du push, pas celle du fetch", async () => {
    amont = await demarrerAmont(racine, true, LAN ?? "");
    const f = faux();
    const { c, fermer } = await client(f.rappel);
    try {
      expect(await appeler(c, "git_clone", { url: amont.url, into_path: "copie" })).toMatchObject({
        ok: true,
      });
      git(
        path.join(bac.sandboxPath, "copie"),
        "config",
        "remote.origin.url",
        `http://${hote()}/ailleurs.git`,
      );
      git(path.join(bac.sandboxPath, "copie"), "config", "remote.origin.pushurl", amont.url);
      const br = String(
        (await appeler(c, "git_start_work", { repo: "copie", branch_intent: "fix-b" }))["branch"],
      );
      await appeler(c, "git_write", { repo: "copie", action: "write", path: "b.txt", content: "b\n" });
      await appeler(c, "git_commit", { repo: "copie", message: "fix: b" });
      const s = await appeler(c, "git_submit", { repo: "copie", title: "Corrige b" });
      expect(s).toMatchObject({ ok: true, branch: br });
      expect(f.prs).toHaveLength(1);
      expect(f.prs[0]?.[1]["remote_url"]).toBe(amont.url);
    } finally {
      await fermer();
    }
  }, 60_000);
});
