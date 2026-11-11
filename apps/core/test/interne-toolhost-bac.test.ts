// SPDX-License-Identifier: MIT
/** apps/core/test/interne-toolhost-bac.test.ts — routes internes propres au TS appelées par l'hôte d'outils (quota du bac, identifiant git saisi au clone de l'éditeur pour le compte de l'enveloppe signée, anciens `.git-credentials.json`), et `save_git_credential` / `import_legacy_git_credentials` rejoués contre le Python (vecteurs ; jetons dans le coffre). */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, creerGardes, dependancesParDefaut, installerAuth } from "@elpis/auth";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerCoffre, creerIdentite, IDENTITY_HEADER, sign } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerFamilleInterneToolhost } from "../src/familles/interne-toolhost";
import { createConnector } from "../src/git/connecteurs";
import { importLegacyGitCredentials, saveGitCredential } from "../src/git/resolveur";
import { COLONNES_SECRET, dechiffrerLigne } from "../src/secrets/stockage";
import type { LigneSecret } from "../src/secrets/stockage";
import { appTest, journalMuet } from "./aides";

const V = JSON.parse(readFileSync(new URL("./vecteurs/git-resolveur.json", import.meta.url), "utf-8")) as {
  etapes: (["save", number, string, string, string, string] | ["import", number, string])[];
  valeurs: (number | null)[];
  lignes: Record<string, unknown>[];
};
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const SVC = "jeton-de-service-bac";
const LIGNES =
  "SELECT id, owner_user_id, provider_type, host, api_base, label, username, token_enc, token_scheme, secret_id FROM git_connectors ORDER BY id";

describe.each(MOTEURS)("résolveur git et routes internes du bac (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let ids: number[] = [];
  let dossierCoffre = "";
  const acteur = { userId: null, username: null };

  /** Jeton du compte git lu dans le coffre (secret relié par `secret_id`), `null` sans secret. */
  const jetonDuCoffre = async (cid: unknown): Promise<string | null> => {
    const colonnes = COLONNES_SECRET.split(", ")
      .map((c) => `v.${c}`)
      .join(", ");
    const s = await t.base.get<LigneSecret & Record<string, unknown>>(
      `SELECT ${colonnes} FROM git_connectors c JOIN vault_secrets v ON v.id = c.secret_id WHERE c.id = ?`,
      [Number(cid)],
    );
    return s ? dechiffrerLigne(s) : null;
  };

  beforeAll(async () => {
    dossierCoffre = mkdtempSync(join(tmpdir(), "elpis-bac-coffre-"));
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: join(dossierCoffre, "absente.key"),
      repli: join(dossierCoffre, ".vault.key"),
    });
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    ids = [];
    for (const nom of ["alice", "bob", "carol"]) ids.push(await createUser(t.base, nom, `mdp-${nom}`));
    const auth = { ...dependancesParDefaut(t.base, () => SVC) };
    app = await appTest({
      familles: [creerFamilleInterneToolhost({ auth, journal: journalMuet })],
      gardes: creerGardes(auth),
      extensions: [(a) => installerAuth(a, auth)],
    });
  });

  afterAll(async () => {
    await app?.close();
    await t?.fermer();
    rmSync(dossierCoffre, { recursive: true, force: true });
  });

  it("save_git_credential et import_legacy_git_credentials : mêmes valeurs, mêmes connecteurs que le Python", async () => {
    expect(ids).toEqual([1, 2, 3]);
    const valeurs: (number | null)[] = [];
    for (const e of V.etapes) {
      if (e[0] === "save")
        valeurs.push(await saveGitCredential(t.base, e[1], e[2], e[3], e[4], e[5], acteur));
      else {
        const brut = e[2];
        const donnees = brut.endsWith(":b64")
          ? Buffer.from(brut.slice(0, -4), "base64")
          : Buffer.from(brut, "utf-8");
        valeurs.push(await importLegacyGitCredentials(t.base, e[1], donnees, acteur));
      }
    }
    expect(valeurs).toEqual(V.valeurs);
    const brutes = await t.base.all<Record<string, unknown>>(LIGNES);
    expect(brutes.every((l) => l["token_enc"] === "" && l["token_scheme"] === "vault")).toBe(true);
    // Écart voulu : le jeton que le Python gardait en clair est dans le coffre ; relu, il est le même.
    const lignes = await Promise.all(
      brutes.map(async ({ secret_id: sid, ...l }) => ({
        ...l,
        id: Number(l["id"]),
        owner_user_id: Number(l["owner_user_id"]),
        token_enc: await jetonDuCoffre(l["id"]),
        token_scheme: sid === null ? "sans secret" : "plain",
      })),
    );
    expect(lignes).toEqual(V.lignes);
  });

  /** POST interne git (`credential` ou `legacy-credentials`) au nom de `compte` (enveloppe signée au jeton de service). */
  const enregistrer = (
    corps: unknown,
    compte = { user_id: ids[1] ?? 0, username: "bob" },
    route = "credential",
  ) =>
    app.inject({
      method: "POST",
      url: `/api/internal/git/${route}`,
      headers: {
        authorization: `Bearer ${SVC}`,
        "content-type": "application/json",
        [IDENTITY_HEADER]: sign(creerIdentite(compte), SVC),
      },
      payload: JSON.stringify(corps),
    });

  const appeler = (methode: "GET" | "POST", url: string, corps?: unknown, jeton = SVC) =>
    app.inject({
      method: methode,
      url,
      headers: {
        authorization: `Bearer ${jeton}`,
        ...(corps !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(corps !== undefined ? { payload: JSON.stringify(corps) } : {}),
    });

  it("quota du bac : surcharge du compte, sinon null ; jeton de service exigé", async () => {
    await t.base.run("UPDATE users SET settings_json=? WHERE id=?", [
      JSON.stringify({ sandbox_quota_mb: "250" }),
      2,
    ]);
    await t.base.run("UPDATE users SET settings_json=? WHERE id=?", [
      JSON.stringify({ sandbox_quota_mb: "x" }),
      3,
    ]);
    expect((await appeler("GET", "/api/internal/sandbox/quota?user_id=2")).json()).toEqual({
      ok: true,
      quota_mb: 250,
    });
    expect((await appeler("GET", "/api/internal/sandbox/quota?user_id=1")).json()).toEqual({
      ok: true,
      quota_mb: null,
    });
    expect((await appeler("GET", "/api/internal/sandbox/quota?user_id=3")).json()).toEqual({
      ok: true,
      quota_mb: null,
    });
    expect((await appeler("GET", "/api/internal/sandbox/quota?user_id=99")).json()).toEqual({
      ok: true,
      quota_mb: null,
    });
    expect((await appeler("GET", "/api/internal/sandbox/quota")).statusCode).toBe(400);
    expect(
      (await appeler("GET", "/api/internal/sandbox/quota?user_id=2", undefined, "autre")).statusCode,
    ).toBe(401);
  });

  it("identifiant saisi au clone de l'éditeur enregistré pour l'hôte ; anciens identifiants importés ; refus", async () => {
    const restaurer = surchargerConfig({ LOCAL_MCP_TOKEN: SVC });
    try {
      let r = await enregistrer({
        origine: "editeur",
        target: "https://forge.lan/o/r.git",
        username: " u ",
        token: "secret",
        provider_type: "",
      });
      const enregistre = r.json() as { connector_id: number };
      expect(enregistre).toEqual({
        ok: true,
        saved: true,
        connector_id: expect.any(Number),
        host: "forge.lan",
      });
      const l = await t.base.get<Record<string, unknown>>(
        "SELECT id, provider_type, host, username, token_enc, label FROM git_connectors WHERE owner_user_id=? AND host=?",
        [2, "forge.lan"],
      );
      expect(l).toMatchObject({
        provider_type: "gitea",
        host: "forge.lan",
        username: "u",
        token_enc: "",
        label: "auto",
      });
      expect(await jetonDuCoffre(l?.["id"])).toBe("secret");
      r = await enregistrer({
        origine: "editeur",
        target: "Forge.LAN:3000",
        token: "autre",
      });
      const second = r.json() as { connector_id: number };
      expect(second).toEqual({
        ok: true,
        saved: true,
        connector_id: expect.any(Number),
        host: "forge.lan:3000",
      });
      expect(second.connector_id).not.toBe(enregistre.connector_id);
      r = await enregistrer({
        origine: "editeur",
        target: "https://Forge.lan/o/autre.git",
        token: "neuf",
      });
      expect(r.json()).toEqual({
        ok: true,
        saved: true,
        connector_id: enregistre.connector_id,
        host: "forge.lan",
      });
      expect(await jetonDuCoffre(enregistre.connector_id)).toBe("neuf");
      r = await enregistrer({ origine: "editeur", target: "", token: "x" });
      expect(r.json()).toEqual({ ok: true, saved: false, connector_id: null, host: "" });
      r = await enregistrer({
        origine: "editeur",
        target: "https://forge.lan/x@evil.example/o/r.git",
        token: "x",
      });
      expect(r.json()).toEqual({ ok: true, saved: false, connector_id: null, host: "" });
      expect(
        await t.base.get("SELECT id FROM git_connectors WHERE owner_user_id=? AND host=?", [
          2,
          "evil.example",
        ]),
      ).toBeUndefined();
      expect(
        (await appeler("POST", "/api/internal/git/credential", { target: "h", token: "x" })).statusCode,
      ).toBe(401);
      expect(
        (
          await enregistrer(
            { origine: "editeur", target: "h", token: "x" },
            { user_id: ids[1] ?? 0, username: "carol" },
          )
        ).statusCode,
      ).toBe(403);
      r = await enregistrer({
        origine: "editeur",
        user_id: ids[2],
        target: "https://forge3.lan/o/r.git",
        token: "x",
      });
      expect(r.json()).toMatchObject({ ok: true, saved: true, host: "forge3.lan" });
      expect(
        await t.base.all("SELECT owner_user_id FROM git_connectors WHERE host=?", ["forge3.lan"]),
      ).toEqual([{ owner_user_id: ids[1] }]);
      const ancien = Buffer.from(
        JSON.stringify({ gitlab: { token: "gl", url: "https://gl.lan/x" } }),
      ).toString("base64");
      r = await enregistrer({ user_id: ids[2], data_b64: ancien }, undefined, "legacy-credentials");
      expect(r.json()).toEqual({ ok: true, created: 0, refused: 1 });
      expect(await t.base.get("SELECT id FROM git_connectors WHERE host=?", ["gl.lan"])).toBeUndefined();
      const zoe = await createUser(t.base, "zoe", "mdp-zoe", { isAdmin: 1 });
      for (const h of ["gl.lan", "forge2.lan"])
        await createConnector(t.base, zoe, "gitea", h, { token: "z" }, acteur);
      r = await enregistrer({ user_id: ids[2], data_b64: ancien }, undefined, "legacy-credentials");
      expect(r.json()).toEqual({ ok: true, created: 1 });
      expect(
        await t.base.all(
          "SELECT owner_user_id, label FROM git_connectors WHERE host=? AND owner_user_id<>?",
          ["gl.lan", zoe],
        ),
      ).toEqual([{ owner_user_id: ids[1], label: "imported" }]);
      r = await enregistrer({ data_b64: ancien }, undefined, "legacy-credentials");
      expect(r.json()).toEqual({ ok: true, created: 0 });
      const booleen = Buffer.from(
        JSON.stringify({ gitea: { token: "t", user: true, url: "https://forge2.lan" } }),
      ).toString("base64");
      r = await enregistrer({ data_b64: booleen }, undefined, "legacy-credentials");
      expect(r.json()).toEqual({ ok: true, created: 1 });
      const echec = Buffer.from(JSON.stringify({ github: { token: 5 } })).toString("base64");
      expect((await enregistrer({ data_b64: echec }, undefined, "legacy-credentials")).json()).toEqual({
        ok: false,
      });
      for (const corps of [{ data_b64: "pas$base64" }, { user_id: 2 }, [1]])
        expect((await enregistrer(corps, undefined, "legacy-credentials")).statusCode).toBe(400);
      expect(
        (await appeler("POST", "/api/internal/git/legacy-credentials", { user_id: 2, data_b64: ancien }))
          .statusCode,
      ).toBe(401);
      expect(
        (await appeler("POST", "/api/internal/git/legacy-credentials", { data_b64: ancien }, "x")).statusCode,
      ).toBe(401);
    } finally {
      restaurer();
    }
  });

  it("hors du clone de l'éditeur (origine absente ou autre) : jamais rien d'enregistré, même pour un hôte déjà enregistré ou un connecteur `auto`", async () => {
    const restaurer = surchargerConfig({ LOCAL_MCP_TOKEN: SVC });
    try {
      const admin = await createUser(t.base, "dora", "mdp-dora", { isAdmin: 1 });
      await createConnector(t.base, admin, "gitea", "adm.lan:3000", { token: "a" }, acteur);
      const propre = await createConnector(
        t.base,
        ids[1] ?? 0,
        "gitlab",
        "propre.lan",
        { token: "p" },
        acteur,
      );
      const auto = await createConnector(
        t.base,
        ids[1] ?? 0,
        "gitea",
        "auto.lan",
        { token: "q", label: "auto" },
        acteur,
      );
      const refus = { ok: true, saved: false, connector_id: null, host: "", refus: "editor_only" };
      for (const origine of [undefined, "agent", "Editeur", 1])
        for (const target of [
          "https://agent.lan/o/r.git",
          "https://ADM.lan:3000/o/r.git",
          "propre.lan",
          "auto.lan",
        ])
          expect(
            (await enregistrer({ origine, target, token: "x" })).json(),
            `${String(origine)} ${target}`,
          ).toEqual(refus);
      for (const host of ["agent.lan", "adm.lan:3000"])
        expect(
          await t.base.get("SELECT id FROM git_connectors WHERE owner_user_id=? AND host=?", [
            ids[1] ?? 0,
            host,
          ]),
        ).toBeUndefined();
      expect(await jetonDuCoffre(propre)).toBe("p");
      expect(await jetonDuCoffre(auto)).toBe("q");
      const editeur = await enregistrer({ origine: "editeur", target: "propre.lan", token: "saisi" });
      expect(editeur.json()).toMatchObject({ saved: true, connector_id: propre });
      expect(await jetonDuCoffre(propre)).toBe("saisi");
    } finally {
      restaurer();
    }
  });
});
