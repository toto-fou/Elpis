// SPDX-License-Identifier: MIT
/** apps/core/test/interne-toolhost.test.ts — `/api/internal/*` de l'hôte d'outils rejouées contre le routeur Python (vecteurs) : gardes du jeton de service, refus, introspection, identité, identifiants git ; notification, ancres et PR du compte signé. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, creerGardes, creerJeton, dependancesParDefaut, installerAuth } from "@elpis/auth";
import { pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerCoffre, creerIdentite, IDENTITY_HEADER, sign, tokenDigest } from "@elpis/securite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { composer } from "../src/composition";
import { creerFamilleInterneToolhost, jetonServiceDuManifeste } from "../src/familles/interne-toolhost";
import { contexteUtilisateur, createConnector } from "../src/git/connecteurs";
import { brancherAdressesInterdites } from "../src/git/garde";
import { ouvrirPrPourHote } from "../src/git/pr";
import { installerPublicationNotifications } from "../src/notifications/envoi";
import { appTest, journalMuet } from "./aides";

const V = pyJsonLoads(readFileSync(new URL("./vecteurs/interne.json", import.meta.url), "utf-8")) as {
  svc: string;
  comptes: [string, number, Record<string, unknown>][];
  connecteurs: [string, string, string, string, string][];
  jetons_demandes: [string, string, string[] | null][];
  etapes: [string, string, Record<string, string>, unknown, boolean][];
  ids: Record<string, number>;
  jetons: Record<string, string>;
  reponses: { statut: number; corps: string; www: string | null }[];
};
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
// Écarts voulus (TS plus strict que le Python de référence) : connecteur gitlab.acme.io, dépôt sur gitlab.com.
const ECARTS: ReadonlyMap<string, string> = new Map([
  [
    "/api/internal/git/credential?user_id=3&remote_url=https://gitlab.com/x/y",
    '{"ok":true,"credential":null}',
  ],
]);
/** Écart voulu (faille corrigée) : l'identifiant git et les hôtes des comptes git sont lus pour le compte de l'enveloppe signée, jamais pour un `user_id` de la requête. */
const SANS_ENVELOPPE = '{"detail":"identity envelope missing or invalid"}';
const estRouteGitSignee = (chemin: string, entetes: Record<string, string>, sans: boolean): boolean =>
  !sans &&
  (chemin.startsWith("/api/internal/git/credential?") ||
    chemin.startsWith("/api/internal/git/connector-hosts")) &&
  entetes["authorization"] !== undefined;

describe.each(MOTEURS)("API interne de l'hôte d'outils (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let jeton = "";

  let dossierCoffre = "";

  beforeAll(async () => {
    dossierCoffre = mkdtempSync(join(tmpdir(), "elpis-interne-coffre-"));
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: join(dossierCoffre, "absente.key"),
      repli: join(dossierCoffre, ".vault.key"),
    });
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    for (const [nom, admin, reglages] of V.comptes) {
      const uid = await createUser(t.base, nom, `mdp-${nom}`, { isAdmin: admin === 1 ? 1 : 0 });
      await t.base.run("UPDATE users SET is_admin=?, settings_json=? WHERE id=?", [
        admin,
        JSON.stringify(reglages),
        uid,
      ]);
    }
    for (const [nom, type, hote, secret, login] of V.connecteurs)
      await createConnector(
        t.base,
        V.ids[nom] ?? 0,
        type,
        hote,
        { token: secret, username: login },
        { userId: V.ids[nom] ?? 0, username: nom },
      );
    const auth = { ...dependancesParDefaut(t.base, () => jeton) };
    for (const [nom, type, familles] of V.jetons_demandes) {
      const [, item] = await creerJeton(
        auth,
        V.ids[nom] ?? 0,
        type,
        "",
        familles ?? undefined,
        type === "tools" ? 5 : undefined,
      );
      await t.base.run("UPDATE tool_tokens SET token_hash=? WHERE id=?", [
        tokenDigest(V.jetons[type] ?? ""),
        item.id,
      ]);
    }
    app = await appTest({
      familles: [creerFamilleInterneToolhost({ auth, journal: journalMuet })],
      gardes: creerGardes(auth),
      extensions: [(a) => installerAuth(a, auth)],
    });
  });

  afterAll(async () => {
    await app.close();
    await t.fermer();
    rmSync(dossierCoffre, { recursive: true, force: true });
  });

  it("rejoue les étapes : mêmes statuts, mêmes corps, même WWW-Authenticate (vecteurs)", async () => {
    for (const [i, [methode, chemin, entetes, corps, sans]] of V.etapes.entries()) {
      jeton = sans ? "" : V.svc;
      const h: Record<string, string> = { ...entetes };
      let charge: string | undefined;
      if (typeof corps === "string" && corps.startsWith("<<")) charge = corps.slice(2, -2);
      else if (corps !== null && corps !== undefined) {
        charge = pyJsonDumps(corps, { ensureAscii: false });
        for (const [k, v] of Object.entries(V.jetons)) charge = charge.replaceAll(`<${k}>`, v);
      }
      if (charge !== undefined) h["content-type"] = "application/json";
      const r = await app.inject({
        method: methode as "GET" | "POST",
        url: chemin,
        headers: h,
        payload: charge,
      });
      const attendu = V.reponses[i];
      if (estRouteGitSignee(chemin, h, sans)) {
        expect(r.statusCode, `étape ${i} ${chemin}`).toBe(401);
        expect(r.body, `étape ${i} ${chemin}`).toBe(SANS_ENVELOPPE);
        continue;
      }
      const ecart = ECARTS.get(chemin);
      if (ecart !== undefined)
        expect(attendu?.corps, `écart toujours présent côté Python : ${chemin}`).not.toBe(ecart);
      expect(r.statusCode, `étape ${i} ${chemin}`).toBe(attendu?.statut);
      expect(r.body, `étape ${i} ${chemin}`).toBe(ecart ?? attendu?.corps);
      expect(r.headers["www-authenticate"] ?? null, `étape ${i}`).toBe(attendu?.www);
    }
  });

  it("notification et ancres du bureau : compte de l'enveloppe signée seulement, genre « automation », tailles bornées", async () => {
    const restaurer = surchargerConfig({ LOCAL_MCP_TOKEN: V.svc });
    jeton = V.svc;
    try {
      const env = (uid: number, nom: string, cle = V.svc): string =>
        sign(creerIdentite({ user_id: uid, username: nom }), cle);
      const appel = (
        methode: "GET" | "POST",
        url: string,
        corps: unknown,
        identite: string | null,
      ): Promise<{ statusCode: number; json: () => unknown }> =>
        app.inject({
          method: methode,
          url,
          headers: {
            authorization: `Bearer ${V.svc}`,
            ...(identite === null ? {} : { [IDENTITY_HEADER]: identite }),
            ...(corps === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(corps === undefined ? {} : { payload: JSON.stringify(corps) }),
        });
      const bob = V.ids["bob"] ?? 0;
      const notif = {
        title: "Automatisation « x » : 1/1 cible(s) réussie(s)",
        body: "vm1 : OK — fait",
        user_id: 1,
      };
      expect((await appel("POST", "/api/internal/notifications", notif, null)).statusCode).toBe(401);
      expect(
        (await appel("POST", "/api/internal/notifications", notif, env(bob, "bob", "autre"))).statusCode,
      ).toBe(401);
      expect((await appel("POST", "/api/internal/notifications", notif, env(bob, "alice"))).statusCode).toBe(
        403,
      );
      expect((await appel("POST", "/api/internal/notifications", notif, env(999, "bob"))).statusCode).toBe(
        403,
      );
      for (const mauvais of [
        { ...notif, kind: "security" },
        { ...notif, ref_type: "chat" },
        { ...notif, title: "" },
        { ...notif, title: "t".repeat(501) },
        { ...notif, body: "b".repeat(4001) },
      ])
        expect(
          (await appel("POST", "/api/internal/notifications", mauvais, env(bob, "bob"))).statusCode,
        ).toBe(422);
      const r = await appel("POST", "/api/internal/notifications", notif, env(bob, "bob"));
      expect(r.statusCode).toBe(200);
      const id = (r.json() as { id: number }).id;
      expect(
        await t.base.get(
          "SELECT owner_user_id, kind, title, body, ref_type, ref_id FROM notifications WHERE id=?",
          [id],
        ),
      ).toMatchObject({
        owner_user_id: bob,
        kind: "automation",
        title: notif.title,
        body: notif.body,
        ref_type: "automation",
        ref_id: null,
      });

      const ancre = {
        target: "vm1",
        query: "enregistrer",
        auto_id: "saveBtn",
        role: "button",
        center: [8, 5],
      };
      const lire = (uid: number, nom: string): Promise<unknown> =>
        appel(
          "GET",
          "/api/internal/desktop/anchor?target=vm1&query=enregistrer",
          undefined,
          env(uid, nom),
        ).then((x) => x.json());
      expect((await appel("POST", "/api/internal/desktop/anchor", ancre, null)).statusCode).toBe(401);
      expect(
        (await appel("POST", "/api/internal/desktop/anchor", { ...ancre, auto_id: "" }, env(bob, "bob")))
          .statusCode,
      ).toBe(422);
      expect(
        (
          await appel(
            "POST",
            "/api/internal/desktop/anchor",
            { ...ancre, target: "v".repeat(201) },
            env(bob, "bob"),
          )
        ).statusCode,
      ).toBe(422);
      expect((await appel("POST", "/api/internal/desktop/anchor", ancre, env(bob, "bob"))).statusCode).toBe(
        200,
      );
      expect(await lire(bob, "bob")).toEqual({
        ok: true,
        anchor: { auto_id: "saveBtn", role: "button", center: [8, 5] },
      });
      expect(await lire(V.ids["admin"] ?? 0, "admin")).toEqual({ ok: true, anchor: null });
      expect(
        (await appel("GET", "/api/internal/desktop/anchor?target=vm1", undefined, env(bob, "bob")))
          .statusCode,
      ).toBe(422);
    } finally {
      restaurer();
    }
  });

  it("PR : compte de l'enveloppe signée, identifiant de l'hôte exact, api_base gardée, jeton jamais rendu", async () => {
    const restaurer = surchargerConfig({ LOCAL_MCP_TOKEN: V.svc });
    jeton = V.svc;
    const recus: { methode: string; url: string; auth: string; type: string; corps: string }[] = [];
    let desactivees = false;
    const srv = createServer((req, res) => {
      let corps = "";
      req.on("data", (m: Buffer) => (corps += m.toString("utf-8")));
      req.on("end", () => {
        recus.push({
          methode: req.method ?? "",
          url: req.url ?? "",
          auth: req.headers.authorization ?? "",
          type: req.headers["content-type"] ?? "",
          corps,
        });
        if (desactivees) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("The target couldn't be found.");
        } else if (req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("[]");
        } else {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ html_url: "http://forge/o/r/pulls/4", number: 4 }));
        }
      });
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
    const hote = `127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const env = (uid: number, nom: string): string =>
        sign(creerIdentite({ user_id: uid, username: nom }), V.svc);
      const pr = async (
        corps: unknown,
        identite: string | null,
      ): Promise<{ statut: number; json: unknown }> => {
        const r = await app.inject({
          method: "POST",
          url: "/api/internal/git/pr",
          headers: {
            authorization: `Bearer ${V.svc}`,
            "content-type": "application/json",
            ...(identite === null ? {} : { [IDENTITY_HEADER]: identite }),
          },
          payload: JSON.stringify(corps),
        });
        expect(r.body).not.toContain("s3cret-pr");
        return { statut: r.statusCode, json: r.json() };
      };
      const uidA = await createUser(t.base, "pr-gitea", "mdp-pr-gitea");
      const uidB = await createUser(t.base, "pr-generique", "mdp-pr-generique");
      const uidC = await createUser(t.base, "pr-saisie", "mdp-pr-saisie");
      const acteur = { userId: null, username: null };
      await createConnector(t.base, uidA, "gitea", hote, { token: "s3cret-pr", username: "alice" }, acteur);
      await createConnector(t.base, uidB, "generic", hote, { token: "s3cret-pr" }, acteur);
      await createConnector(
        t.base,
        uidC,
        "gitea",
        hote,
        { token: "s3cret-pr", apiBase: `http://u:s3cret-pr@${hote}/api/v1` },
        acteur,
      );
      const demande = {
        remote_url: `http://${hote}/o/r.git`,
        head: "agent/x",
        base: "main",
        title: "Ajoute X",
        body: "corps",
        draft: true,
      };
      const repli = `https://${hote}/o/r/compare/main...agent/x`;
      expect((await pr(demande, null)).statut).toBe(401);
      expect((await pr(demande, env(uidA, "bob"))).statut).toBe(403);
      expect((await pr({ ...demande, title: "" }, env(uidA, "pr-gitea"))).statut).toBe(422);
      expect(
        await pr({ ...demande, remote_url: "https://github.com/o/r.git" }, env(uidA, "pr-gitea")),
      ).toEqual({
        statut: 200,
        json: {
          ok: true,
          result: {
            outcome: "fallback",
            provider: "github",
            host: "github.com",
            fallback_url: "https://github.com/o/r/compare/main...agent/x?expand=1",
          },
        },
      });
      expect((await pr(demande, env(uidA, "pr-gitea"))).json).toEqual({
        ok: true,
        result: {
          outcome: "blocked_api_base",
          api_base: `http://${hote}/api/v1`,
          reason: "blocked_ip (127.0.0.1)",
          fallback_url: repli,
        },
      });
      expect((await pr(demande, env(uidC, "pr-saisie"))).json).toEqual({
        ok: true,
        result: {
          outcome: "blocked_api_base",
          api_base: `http://***@${hote}/api/v1`,
          reason: "credentials_in_url",
          fallback_url: repli,
        },
      });
      for (const refusee of [
        { remote_url: `http://${hote}/o/r?x.git` },
        { remote_url: `http://${hote}/o/r/x.git` },
        { remote_url: `http://${hote}/../r.git` },
        { head: "agent/x&state=closed" },
        { base: "-main" },
        { base: "main..x" },
      ])
        expect(
          (await pr({ ...demande, ...refusee }, env(uidA, "pr-gitea"))).json,
          JSON.stringify(refusee),
        ).toMatchObject({
          ok: true,
          result: { outcome: "error", message: "unsafe_pr_target" },
        });
      expect(recus).toEqual([]);
      expect((await pr(demande, env(uidB, "pr-generique"))).json).toEqual({
        ok: true,
        result: { outcome: "no_api", provider_type: "generic", fallback_url: "" },
      });
      brancherAdressesInterdites(() => false);
      expect((await pr(demande, env(uidA, "pr-gitea"))).json).toEqual({
        ok: true,
        result: {
          outcome: "opened",
          provider_type: "gitea",
          pr_url: "http://forge/o/r/pulls/4",
          pr_number: 4,
          already_open: false,
        },
      });
      const basic = "Basic " + Buffer.from("alice:s3cret-pr").toString("base64");
      expect(recus).toEqual([
        { methode: "GET", url: "/api/v1/repos/o/r/pulls?state=open", auth: basic, type: "", corps: "" },
        {
          methode: "POST",
          url: "/api/v1/repos/o/r/pulls",
          auth: basic,
          type: "application/json",
          corps: '{"title": "Ajoute X", "body": "corps", "head": "agent/x", "base": "main"}',
        },
      ]);
      desactivees = true;
      expect((await pr(demande, env(uidA, "pr-gitea"))).json).toEqual({
        ok: true,
        result: {
          outcome: "failed",
          error_code: "pull_requests_disabled",
          error:
            'Pull Requests are DISABLED on this Gitea repository. Enable them: repository → Settings → "Units" tab (or Advanced) → check "Pull Requests", then retry.',
          status: 404,
          api_response: "None",
          fallback_url: repli,
        },
      });
      const muet = createServer(() => undefined);
      await new Promise<void>((ok) => muet.listen(0, "127.0.0.1", () => ok()));
      const hoteMuet = `127.0.0.1:${(muet.address() as AddressInfo).port}`;
      try {
        await createConnector(t.base, uidA, "gitea", hoteMuet, { token: "s3cret-pr" }, acteur);
        expect(
          await ouvrirPrPourHote(
            t.base,
            uidA,
            { ...demande, remote_url: `http://${hoteMuet}/o/r.git` },
            { echeanceMs: 300, contexte: contexteUtilisateur(acteur) },
          ),
        ).toMatchObject({ outcome: "failed", error_code: "pr_api_timeout", status: null });
      } finally {
        muet.closeAllConnections();
        await new Promise((ok) => muet.close(ok));
      }
    } finally {
      brancherAdressesInterdites(null);
      restaurer();
      await new Promise((ok) => srv.close(ok));
    }
  });

  it("un en-tête non ASCII est refusé en 401 (Python : 500 de hmac.compare_digest sur un texte non ASCII)", async () => {
    jeton = V.svc;
    for (const valeur of [`Bearer ${V.svc}\u00e9`, `Bearer \u00e9${V.svc}`, "Bearer \u00e9"]) {
      const r = await app.inject({
        method: "GET",
        url: "/api/internal/identity?username=bob",
        headers: { authorization: valeur },
      });
      expect([r.statusCode, r.headers["www-authenticate"], r.json()], valeur).toEqual([
        401,
        "Bearer",
        { detail: "jeton de service requis" },
      ]);
    }
  });

  it("identité par forme canonique (`canonical=1`) : à défaut du nom exact, le seul compte de cette forme ; plusieurs ou aucun : inconnu ; enveloppe refusée en anglais", async () => {
    jeton = V.svc;
    const lire = async (q: string): Promise<unknown> =>
      (
        await app.inject({
          method: "GET",
          url: `/api/internal/identity?${q}`,
          headers: { authorization: `Bearer ${V.svc}` },
        })
      ).json();
    const id = await t.base.insertId(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES ('jean.dupont', '', '', 0)",
    );
    expect(await lire("username=jeandupont")).toEqual({ ok: false });
    expect(await lire("username=jeandupont&canonical=1")).toMatchObject({
      ok: true,
      user_id: id,
      username: "jean.dupont",
    });
    await t.base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES ('jean@dupont', '', '', 0)",
    );
    expect(await lire("username=jeandupont&canonical=1")).toEqual({ ok: false });
    const r = await app.inject({
      method: "POST",
      url: "/api/internal/notifications",
      headers: { authorization: `Bearer ${V.svc}`, "content-type": "application/json" },
      payload: "{}",
    });
    expect([r.statusCode, r.json()]).toEqual([401, { detail: "identity envelope missing or invalid" }]);
  });
});

describe("jeton de service", () => {
  it("entrée toolhost du manifeste d'abord, puis LOCAL_MCP_TOKEN", () => {
    const dossier = mkdtempSync(join(tmpdir(), "elpis-manifeste-"));
    const restaurer = surchargerConfig({ LOCAL_MCP_TOKEN: "  local  " });
    try {
      vi.stubEnv("APP_MCP_MANIFEST", join(dossier, "absent.json"));
      expect(jetonServiceDuManifeste()).toBe("local");
      const manifeste = join(dossier, "mcp.json");
      writeFileSync(
        manifeste,
        JSON.stringify({
          version: 1,
          mcpServers: {
            outils: {
              type: "http",
              url: "http://127.0.0.1:8765/mcp",
              headers: { Authorization: "Bearer du-manifeste" },
              "x-elpis": { role: "toolhost", families: ["fs"] },
            },
          },
        }),
      );
      vi.stubEnv("APP_MCP_MANIFEST", manifeste);
      expect(jetonServiceDuManifeste()).toBe("du-manifeste");
    } finally {
      vi.unstubAllEnvs();
      restaurer();
      rmSync(dossier, { recursive: true, force: true });
    }
  });
});

describe("composer sans `dep`", () => {
  it("la garde `service` prend le jeton de l'entrée toolhost du manifeste, sinon LOCAL_MCP_TOKEN", async () => {
    const t = ouvrirBaseDeTest("sqlite");
    const dossier = mkdtempSync(join(tmpdir(), "elpis-composer-jeton-"));
    const restaurer = surchargerConfig({ LOCAL_MCP_TOKEN: "jeton-local" });
    try {
      await initialiserBase(t.base);
      const manifeste = join(dossier, "mcp.json");
      writeFileSync(
        manifeste,
        JSON.stringify({
          version: 1,
          mcpServers: {
            outils: {
              type: "http",
              url: "http://127.0.0.1:8765/mcp",
              headers: { Authorization: "Bearer jeton-du-manifeste" },
              "x-elpis": { role: "toolhost", families: ["fs"] },
            },
          },
        }),
      );
      vi.stubEnv("APP_MCP_MANIFEST", manifeste);
      const c = await composer("main", t.base, journalMuet);
      const garde = c.gardes.service;
      if (garde === undefined) throw new Error("garde service absente");
      const avec = (j: string): Promise<void> | void =>
        garde({ headers: { authorization: `Bearer ${j}` } } as FastifyRequest, {} as FastifyReply);
      await expect(Promise.resolve(avec("jeton-du-manifeste"))).resolves.toBeUndefined();
      await expect(Promise.resolve().then(() => avec("jeton-local"))).rejects.toMatchObject({
        statusCode: 401,
      });
      vi.stubEnv("APP_MCP_MANIFEST", join(dossier, "absent.json"));
      await expect(Promise.resolve(avec("jeton-local"))).resolves.toBeUndefined();
    } finally {
      installerPublicationNotifications(null);
      vi.unstubAllEnvs();
      restaurer();
      await t.fermer();
      rmSync(dossier, { recursive: true, force: true });
    }
  });
});
