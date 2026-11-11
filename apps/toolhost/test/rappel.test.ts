// SPDX-License-Identifier: MIT
/** apps/toolhost/test/rappel.test.ts — client de rappel vers l'API interne du core (shared_infra/toolhost/client.py) : inactif sans URL, refus muets, cache court, secrets jamais journalisés. */
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { IMPORT_GARDE } from "@elpis/fichiers";
import { IDENTITY_HEADER, verify } from "@elpis/securite";
import { afterEach, describe, expect, it } from "vitest";

import { ClientRappel } from "../src/rappel";
import { journalMuet, lignesJournal, SVC } from "./aides";

interface Appel {
  methode: string;
  url: string;
  auth: string | undefined;
  identite?: string | undefined;
  corps: string;
}

const serveurs: Server[] = [];

afterEach(async () => {
  for (const s of serveurs.splice(0)) {
    s.closeAllConnections();
    await new Promise((fin) => s.close(fin));
  }
});

async function core(reponses: Record<string, [number, string]>): Promise<{ url: string; appels: Appel[] }> {
  const appels: Appel[] = [];
  const s = createServer((req, res) => {
    let corps = "";
    req.on("data", (m: Buffer) => (corps += m.toString()));
    req.on("end", () => {
      const identite = req.headers[IDENTITY_HEADER.toLowerCase()];
      appels.push({
        methode: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        identite: Array.isArray(identite) ? identite[0] : identite,
        corps,
      });
      const chemin = (req.url ?? "").split("?")[0] ?? "";
      const [statut, texte] = reponses[chemin] ?? [404, "{}"];
      res.writeHead(statut, { "content-type": "application/json" }).end(texte);
    });
  });
  await new Promise<void>((fin) => s.listen(0, "127.0.0.1", fin));
  serveurs.push(s);
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/`, appels };
}

describe("client de rappel", () => {
  it("inactif sans URL du core ou sans jeton : tout rend vide, aucun appel", async () => {
    for (const [appUrl, jeton] of [
      ["", SVC],
      ["http://127.0.0.1:1", ""],
    ] as const) {
      const c = new ClientRappel({ appUrl, jeton, journal: journalMuet });
      expect(c.actif).toBe(false);
      expect(await c.introspectToken("pcr_x")).toBeNull();
      expect(await c.identityForUsername("a")).toBeNull();
      expect(await c.gitCredential({ user_id: 1, username: "u" }, "https://h/r.git")).toBeNull();
      expect(await c.connectorHosts({ user_id: 1, username: "u" })).toEqual([]);
      expect(await c.identifiantGitDisponible({ user_id: 1, username: "u" }, "https://h/r.git")).toBe(false);
    }
  });

  it("formes du Python, jeton de service en Bearer, paramètres en requête, cache court", async () => {
    const c0 = await core({
      "/api/internal/tokens/introspect": [
        200,
        '{"ok":true,"user_id":"7","username":"bob","kind":null,"families":["git",3]}',
      ],
      "/api/internal/identity": [
        200,
        '{"ok":true,"user_id":7,"username":"bob","network_profile_id":null,"is_admin":1}',
      ],
      "/api/internal/git/credential": [
        200,
        '{"ok":true,"credential":{"username":"ci","token":"ghp_secret","host":"github.com"}}',
      ],
      "/api/internal/git/connector-hosts": [200, '{"ok":true,"hosts":["github.com","10.0.0.2:3000"]}'],
    });
    const c = new ClientRappel({ appUrl: c0.url, jeton: SVC, journal: journalMuet });
    expect(await c.introspectToken("ept_abc")).toEqual({
      user_id: 7,
      username: "bob",
      kind: "",
      families: ["git", "3"],
    });
    expect(await c.identityForUsername("bob")).toEqual({
      user_id: 7,
      username: "bob",
      network_profile_id: "",
      is_admin: true,
    });
    const bob = { user_id: 7, username: "bob" };
    expect(await c.gitCredential(bob, "https://github.com/o/r.git")).toEqual({
      username: "ci",
      token: "ghp_secret",
      host: "github.com",
    });
    expect(await c.connectorHosts(bob)).toEqual(["github.com", "10.0.0.2:3000"]);
    expect(c0.appels.map((a) => `${a.methode} ${a.url}`)).toEqual([
      "POST /api/internal/tokens/introspect",
      "GET /api/internal/identity?username=bob",
      "GET /api/internal/git/credential?remote_url=https%3A%2F%2Fgithub.com%2Fo%2Fr.git",
      "GET /api/internal/git/connector-hosts",
    ]);
    expect(c0.appels.every((a) => a.auth === `Bearer ${SVC}`)).toBe(true);
    expect(verify(c0.appels[2]?.identite, SVC)).toMatchObject(bob);
    expect(verify(c0.appels[3]?.identite, SVC)).toMatchObject(bob);
    expect(JSON.parse(c0.appels[0]?.corps ?? "")).toEqual({ token: "ept_abc" });
    await c.identityForUsername("bob");
    await c.connectorHosts(bob);
    await c.gitCredential(bob, "https://github.com/o/r.git");
    expect(c0.appels).toHaveLength(4);
    await c.gitCredential({ user_id: 7, username: "bob2" }, "https://github.com/o/r.git");
    await c.gitCredential({ user_id: 8, username: "bob" }, "https://github.com/o/r.git");
    expect(c0.appels).toHaveLength(6);
    expect(verify(c0.appels[5]?.identite, SVC)).toMatchObject({ user_id: 8, username: "bob" });
    expect(await c.gitCredential({ user_id: 7, username: "" }, "https://github.com/o/r.git")).toBeNull();
    expect(c0.appels).toHaveLength(6);
    c.viderCache();
    await c.connectorHosts(bob);
    expect(c0.appels).toHaveLength(7);
  });

  it("identifiant git : conversation et sous-agent de l'appel signés et dans la clé du cache (l'entrée du parent ne sert jamais à un sous-agent) ; présence sans lecture", async () => {
    const c0 = await core({
      "/api/internal/git/credential": [
        200,
        '{"ok":true,"credential":{"username":"ci","token":"ghp_secret","host":"github.com"}}',
      ],
      "/api/internal/git/credential/available": [200, '{"ok":true,"available":true}'],
    });
    const c = new ClientRappel({ appUrl: c0.url, jeton: SVC, journal: journalMuet });
    const url = "https://github.com/o/r.git";
    const parent = { user_id: 7, username: "bob", chat_id: "c-1" };
    const enfant = { ...parent, chat_id: "c-1#task-a1", subagent: { type: "explore", id: "a1" } };
    await c.gitCredential(parent, url);
    await c.gitCredential(parent, url);
    expect(c0.appels).toHaveLength(1);
    await c.gitCredential(enfant, url);
    await c.gitCredential({ ...enfant, subagent: { type: "explore", id: "a2" } }, url);
    await c.gitCredential({ ...parent, chat_id: "routine:3:run:9" }, url);
    expect(c0.appels).toHaveLength(4);
    expect(verify(c0.appels[0]?.identite, SVC)).toMatchObject(parent);
    expect(verify(c0.appels[0]?.identite, SVC)?.subagent).toBeUndefined();
    expect(verify(c0.appels[1]?.identite, SVC)).toMatchObject({
      chat_id: "c-1#task-a1",
      subagent: { type: "explore", id: "a1", browser_session: "isolated" },
    });
    expect(verify(c0.appels[3]?.identite, SVC)).toMatchObject({ chat_id: "routine:3:run:9" });
    expect(await c.identifiantGitDisponible(enfant, url)).toBe(true);
    expect(await c.identifiantGitDisponible(enfant, url)).toBe(true);
    expect(c0.appels.map((a) => a.url.split("?")[0])).toEqual([
      ...Array(4).fill("/api/internal/git/credential"),
      "/api/internal/git/credential/available",
    ]);
    expect(verify(c0.appels[4]?.identite, SVC)).toMatchObject({ subagent: { type: "explore", id: "a1" } });
    expect(await c.identifiantGitDisponible({ user_id: 7, username: "" }, url)).toBe(false);
    expect(c0.appels).toHaveLength(5);
  });

  it("PR : issue du core rendue telle quelle, refus 4xx → `rejected`, 5xx ou réponse sans issue → injoignable", async () => {
    const compte = { user_id: 7, username: "bob" };
    const demande = {
      remote_url: "https://h/o/r.git",
      head: "agent/x",
      base: "main",
      title: "t",
      body: "",
      draft: true,
    };
    const ouvrir = async (statut: number, texte: string): Promise<unknown> => {
      const c0 = await core({ "/api/internal/git/pr": [statut, texte] });
      return new ClientRappel({ appUrl: c0.url, jeton: SVC, journal: journalMuet }).ouvrirPr(compte, demande);
    };
    expect(await ouvrir(200, '{"ok":true,"result":{"outcome":"no_api","provider_type":"generic"}}')).toEqual({
      outcome: "no_api",
      provider_type: "generic",
    });
    expect(await ouvrir(422, '{"detail":[]}')).toEqual({ outcome: "rejected", status: 422 });
    expect(await ouvrir(401, "{}")).toEqual({ outcome: "rejected", status: 401 });
    expect(await ouvrir(500, "{}")).toBeNull();
    expect(await ouvrir(200, '{"ok":true,"result":{"pas":"d\'issue"}}')).toBeNull();
  });

  it("refus, `ok` faux, réponse mal formée ou core injoignable : vide, journalisé sans secret", async () => {
    lignesJournal.length = 0;
    const c0 = await core({
      "/api/internal/tokens/introspect": [401, '{"detail":"jeton de service requis"}'],
      "/api/internal/identity": [200, '{"ok":true,"username":"sans-id"}'],
      "/api/internal/git/credential": [200, '{"ok":false}'],
      "/api/internal/git/connector-hosts": [200, "pas du json"],
    });
    const c = new ClientRappel({ appUrl: c0.url, jeton: SVC, journal: journalMuet });
    expect(await c.introspectToken("ept_secret_du_client")).toBeNull();
    expect(await c.identityForUsername("x")).toBeNull();
    expect(await c.gitCredential({ user_id: 3, username: "x" }, "https://h/r.git?jeton=secret")).toBeNull();
    expect(await c.connectorHosts({ user_id: 3, username: "x" })).toEqual([]);
    const mort = new ClientRappel({
      appUrl: "http://127.0.0.1:1",
      jeton: SVC,
      journal: journalMuet,
      delaiMs: 500,
    });
    expect(await mort.identityForUsername("x")).toBeNull();
    const journal = lignesJournal.join("\n");
    expect(journal).toContain("[toolhost.client] POST /api/internal/tokens/introspect → 401");
    expect(journal).toContain("injoignable");
    for (const secret of [SVC, "ept_secret_du_client", "jeton=secret"]) expect(journal).not.toContain(secret);
  });

  it("quota du compte (en cache), identifiant git enregistré et anciens identifiants importés (jamais en cache)", async () => {
    lignesJournal.length = 0;
    const c0 = await core({
      "/api/internal/sandbox/quota": [200, '{"ok":true,"quota_mb":"250"}'],
      "/api/internal/git/credential": [200, '{"ok":true,"saved":true,"connector_id":4,"host":"h"}'],
      "/api/internal/git/legacy-credentials": [200, '{"ok":true,"created":2}'],
    });
    const c = new ClientRappel({ appUrl: c0.url, jeton: SVC, journal: journalMuet });
    expect(await c.quotaCompte(7)).toBe(250);
    expect(await c.quotaCompte(7)).toBe(250);
    expect(await c.quotaCompte(0)).toBeNull();
    const bob = { user_id: 7, username: "bob" };
    expect(await c.enregistrerIdentifiantGit(bob, "https://h/r.git", "u", "jeton-secret", "gitea")).toBe(
      true,
    );
    expect(await c.enregistrerIdentifiantGit(bob, "https://h/r.git", "u", "", "")).toBe(false);
    expect(await c.enregistrerIdentifiantGit(bob, "https://h/r.git", "u", "jeton-secret", "")).toBe(true);
    for (const sans of [
      { user_id: 0, username: "bob" },
      { user_id: 7, username: "" },
    ])
      expect(await c.enregistrerIdentifiantGit(sans, "https://h/r.git", "u", "jeton-secret", "")).toBe(false);
    expect(await c.importAncien(bob, Buffer.from('{"github":{"token":"t"}}'))).toBe(2);
    expect(await c.importAncien({ user_id: 7, username: "" }, Buffer.from("{}"))).toBe(-1);
    expect(c0.appels.map((a) => `${a.methode} ${a.url}`)).toEqual([
      "GET /api/internal/sandbox/quota?user_id=7",
      "POST /api/internal/git/credential",
      "POST /api/internal/git/credential",
      "POST /api/internal/git/legacy-credentials",
    ]);
    expect(verify(c0.appels[1]?.identite, SVC)).toMatchObject(bob);
    expect(JSON.parse(c0.appels[1]?.corps ?? "")).toEqual({
      target: "https://h/r.git",
      username: "u",
      token: "jeton-secret",
      provider_type: "gitea",
      origine: "editeur",
    });
    expect(JSON.parse(c0.appels[2]?.corps ?? "")).toMatchObject({ provider_type: "", origine: "editeur" });
    const refuse = await core({
      "/api/internal/git/credential": [
        200,
        '{"ok":true,"saved":false,"connector_id":null,"host":"","refus":"editor_only"}',
      ],
      "/api/internal/git/legacy-credentials": [200, '{"ok":true,"created":1,"refused":1}'],
    });
    const r = new ClientRappel({ appUrl: refuse.url, jeton: SVC, journal: journalMuet });
    expect(await r.enregistrerIdentifiantGit(bob, "https://h/r.git", "u", "jeton-secret", "")).toBe(false);
    expect(await r.importAncien(bob, Buffer.from('{"gitea":{"token":"t","url":"https://h"}}'))).toBe(
      IMPORT_GARDE,
    );
    expect(verify(c0.appels[3]?.identite, SVC)).toMatchObject(bob);
    expect(JSON.parse(c0.appels[3]?.corps ?? "")).toEqual({
      data_b64: Buffer.from('{"github":{"token":"t"}}').toString("base64"),
    });
    const vide = await core({
      "/api/internal/sandbox/quota": [200, '{"ok":true,"quota_mb":null}'],
      "/api/internal/git/credential": [500, "{}"],
      "/api/internal/git/legacy-credentials": [200, '{"ok":false}'],
    });
    const d = new ClientRappel({ appUrl: vide.url, jeton: SVC, journal: journalMuet });
    expect(await d.quotaCompte(7)).toBeNull();
    const reponses: Record<string, [number, string]> = { "/api/internal/sandbox/quota": [500, "{}"] };
    const muet = new ClientRappel({ appUrl: (await core(reponses)).url, jeton: SVC, journal: journalMuet });
    expect(await muet.quotaCompte(7)).toBeUndefined();
    reponses["/api/internal/sandbox/quota"] = [200, '{"ok":true,"quota_mb":40}'];
    muet.viderCache();
    expect(await muet.quotaCompte(7)).toBe(40);
    reponses["/api/internal/sandbox/quota"] = [200, '{"ok":true,"quota_mb":"x"}'];
    muet.viderCache();
    expect(await muet.quotaCompte(7)).toBe(40);
    expect(
      await d.enregistrerIdentifiantGit(
        { user_id: 7, username: "bob" },
        "https://h/r.git",
        "u",
        "jeton-secret",
        "",
      ),
    ).toBe(false);
    expect(await d.importAncien({ user_id: 7, username: "bob" }, Buffer.from("{}"))).toBe(-1);
    expect(
      await new ClientRappel({ appUrl: "", jeton: SVC, journal: journalMuet }).importAncien(
        { user_id: 7, username: "bob" },
        Buffer.alloc(0),
      ),
    ).toBe(-1);
    expect(lignesJournal.join("\n")).not.toContain("jeton-secret");
  });

  it("jobs de fond : refus du core rendus tels quels, liste sans `ok`, lot acquitté ; enveloppe du compte, statut HTTP", async () => {
    const compte = { user_id: 7, username: "bob" };
    const c0 = await core({
      "/api/internal/jobs": [
        200,
        '{"ok":false,"error":"limit_exceeded","message":"m","active":[{"job_id":"j-00000001"}],"max_jobs":3}',
      ],
      "/api/internal/jobs/state": [200, '{"ok":false,"error":"job_not_found"}'],
      "/api/internal/jobs/events": [200, '{"ok":true,"acked_seq":4,"accepted":1,"rejected":0}'],
    });
    const c = new ClientRappel({ appUrl: c0.url, jeton: SVC, journal: journalMuet });
    expect(await c.enregistrerJob(compte, { chat_id: "c", command: "x" })).toEqual({
      ok: false,
      error: "limit_exceeded",
      message: "m",
      active: [{ job_id: "j-00000001" }],
      max_jobs: 3,
    });
    expect(await c.etatJob(compte, { job_id: "j-00000001", state: "running", pid: 5 })).toEqual({
      ok: false,
      error: "job_not_found",
    });
    expect(await c.evenementsJobs(compte, [{ seq: 4, n: 2n }], 4)).toMatchObject({ acked_seq: 4 });
    expect(JSON.parse(c0.appels[2]?.corps ?? "{}")).toEqual({ events: [{ seq: 4, n: 2 }], last_seq: 4 });
    expect(verify(c0.appels[0]?.identite, SVC)).toMatchObject({ user_id: 7, username: "bob" });
    expect(await c.jobsDuCompte(compte, "c")).toBeNull();
    const c1 = await core({ "/api/internal/jobs": [200, '{"jobs":[],"active_jobs":0,"max_jobs":3}'] });
    const d = new ClientRappel({ appUrl: c1.url, jeton: SVC, journal: journalMuet });
    expect(await d.jobsDuCompte(compte, "c")).toEqual({ jobs: [], active_jobs: 0, max_jobs: 3 });
    expect(c1.appels[0]?.url).toBe("/api/internal/jobs?chat_id=c");
    const c2 = await core({ "/api/internal/jobs": [422, '{"detail":[]}'] });
    const statut = { code: 0 };
    expect(
      await new ClientRappel({ appUrl: c2.url, jeton: SVC, journal: journalMuet }).enregistrerJob(
        compte,
        {},
        statut,
      ),
    ).toBeNull();
    expect(statut.code).toBe(422);
  });
});
