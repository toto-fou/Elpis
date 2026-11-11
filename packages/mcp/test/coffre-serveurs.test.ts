// SPDX-License-Identifier: MIT
/** packages/mcp/test/coffre-serveurs.test.ts — secrets des serveurs MCP vus du paquet, coffre simulé : valeur JSON, reprise des anciens champs (Fernet, clair, illisible), fusion « vide = inchangé » et retrait explicite, secret illisible ou retiré jamais écrasé sans saisie, anciens secrets montrés et gardés, vues sans valeur, journal et empreintes. */
import "./environnement";

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Base } from "@elpis/db";
import { configurerChiffrement, encrypt, Fernet } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appliquerSecretsPerso,
  authFingerprint,
  brancherCoffreMcp,
  mergePersonalMcp,
  personalPublic,
  personalToConfig,
  repriseHeritee,
  secretsDeJson,
  secretsEnJson,
  secretsHerites,
  secretsPerso,
  signalerServeurIgnore,
} from "../src";
import type { EtatSecrets } from "../src";
import { oublierAvertissementsPaires } from "../src/serveurs";
import { capturerJournal, coffreSimule } from "./aides";
import type { CoffreSimule } from "./aides";

const BASE = {} as Base;
const MOI = { userId: 7, username: "moi" };
let sim: CoffreSimule;
let dossier: string;

beforeEach(() => {
  sim = coffreSimule();
  brancherCoffreMcp(sim.coffre);
  dossier = mkdtempSync(join(tmpdir(), "elpis-mcp-coffre-"));
  configurerChiffrement({ cleEnv: Fernet.generateKey(), fichierCle: join(dossier, ".encryption_key") });
});

afterEach(() => {
  brancherCoffreMcp(null);
  rmSync(dossier, { recursive: true, force: true });
});

async function enregistrer(
  anciens: Record<string, unknown>[],
  recus: unknown[],
): Promise<Record<string, unknown>[]> {
  const secrets = new Map<string, EtatSecrets>();
  for (const s of anciens) secrets.set(String(s["id"]), await secretsPerso(BASE, 7, s));
  const fusion = await mergePersonalMcp(anciens, recus, { allowStdio: true, secrets });
  return appliquerSecretsPerso(BASE, 7, anciens, fusion, MOI);
}

describe("valeur d'un secret MCP", () => {
  it("JSON des parties non vides ; paires en liste ou en objet, noms vérifiés à la connexion ; texte brut = jeton", async () => {
    expect(secretsEnJson({ auth: "a", headers: [], env: [{ name: "K", value: "v" }] })).toBe(
      '{"auth":"a","env":[{"name":"K","value":"v"}]}',
    );
    const lu = secretsDeJson(
      '{"headers": {"X-K": "v", "Host": "h"}, "env": [{"name": "1A", "value": "x"}, {"name": ""}, 3]}',
    );
    expect(lu).toEqual({
      auth: "",
      headers: [
        { name: "X-K", value: "v" },
        { name: "Host", value: "h" },
      ],
      env: [{ name: "1A", value: "x" }],
    });
    const srv = { id: "v", type: "http", url: "https://v/mcp" };
    expect(await personalToConfig(srv, { allowStdio: true, secrets: lu })).toMatchObject({
      headers: { "X-K": "v" },
    });
    expect(
      await personalToConfig({ ...srv, type: "stdio", command: "x" }, { allowStdio: true, secrets: lu }),
    ).not.toHaveProperty("env");
    expect(secretsDeJson("  eyJ.jeton  ")).toEqual({ auth: "eyJ.jeton", headers: [], env: [] });
    expect(secretsDeJson('"texte"')).toEqual({ auth: '"texte"', headers: [], env: [] });
  });
});

describe("reprise des anciens champs", () => {
  it("Fernet d'abord, clair ensuite ; parties utiles au type et au mode ; illisible signalé, gardé", () => {
    const autre = new Fernet(Fernet.generateKey()).encrypt(Buffer.from("x", "utf8"));
    const http = {
      id: "a",
      type: "http",
      auth_mode: "bearer",
      auth_enc: encrypt("t"),
      key_scheme: "fernet",
      headers_enc: autre,
      env_enc: encrypt('[{"name": "E", "value": "e"}]'),
      extra_scheme: "fernet",
      authorization: "Bearer ignoré",
    };
    expect(secretsHerites(http)).toEqual({
      valeur: { auth: "t", headers: [], env: [{ name: "E", value: "e" }] },
      illisibles: ["headers"],
      cleAbsente: false,
      mode: null,
    });
    expect(secretsHerites(http, () => ({ erreur: "cle_absente" }))).toMatchObject({
      valeur: { auth: "", headers: [] },
      illisibles: ["auth", "headers", "env"],
      cleAbsente: true,
    });
    expect(repriseHeritee(http)).toMatchObject({
      valeur: { auth: "t", headers: [], env: [] },
      illisibles: ["headers"],
      aReprendre: true,
      gardees: ["headers_enc", "extra_scheme"],
    });
    expect(repriseHeritee({ id: "b", type: "sse", authorization: "Bearer x" })).toMatchObject({
      valeur: { auth: "Bearer x" },
      mode: { auth_mode: "raw", auth_user: "" },
    });
    expect(
      repriseHeritee({ id: "b", type: "sse", auth_mode: "bearer", authorization: "Bearer x" }),
    ).toMatchObject({
      valeur: { auth: "x" },
      mode: { auth_mode: "bearer" },
    });
    expect(
      repriseHeritee({
        id: "c",
        type: "http",
        basic_auth: { username: "u", token: "p" },
        authorization: "A",
      }),
    ).toMatchObject({
      valeur: { auth: "p" },
      mode: { auth_mode: "basic", auth_user: "u" },
    });
    expect(
      repriseHeritee({ id: "d", type: "stdio", authorization: "A", headers: { X: "1" }, env: { TOK: "e" } }),
    ).toMatchObject({
      valeur: { auth: "", headers: [], env: [{ name: "TOK", value: "e" }] },
      mode: null,
    });
    expect(
      repriseHeritee({ id: "e", type: "http", auth_mode: "", auth_enc: "", key_scheme: "plain" }),
    ).toMatchObject({
      aReprendre: false,
      aVider: false,
      cles: ["auth_enc", "key_scheme"],
    });
    expect(repriseHeritee({ id: "f", type: "http" })).toBeNull();
  });
});

describe("fusion des serveurs perso", () => {
  const neuf = {
    id: "s",
    name: "S",
    type: "http",
    url: "https://s/mcp",
    auth_mode: "header",
    auth_user: "X-Cle",
    auth_secret: "c1",
    headers: [{ name: "X-Autre", value: "h1" }],
  };

  it("vide = inchangé, rien d'écrit ; jeton fait de blancs = inchangé ; liste nulle ou vidée = paires retirées ; retrait du serveur", async () => {
    let liste = await enregistrer([], [neuf]);
    const id = liste[0]?.["secret_id"] as number;
    expect(sim.secrets.get(id)?.v).toEqual({
      auth: "c1",
      headers: [{ name: "X-Autre", value: "h1" }],
      env: [],
    });
    const vue = personalPublic(liste[0], await secretsPerso(BASE, 7, liste[0]));
    expect(vue).toMatchObject({ has_auth: true, headers: [{ name: "X-Autre", value: "", has_value: true }] });
    expect(vue).not.toHaveProperty("secret_id");
    liste = await enregistrer(liste, [{ ...vue, auth_secret: "   " }]);
    expect(sim.secrets.get(id)?.version).toBe(1);
    expect(
      await personalToConfig(liste[0], { allowStdio: true, secrets: sim.secrets.get(id)?.v ?? null }),
    ).toMatchObject({
      headers: { "X-Autre": "h1", "X-Cle": "c1" },
    });
    liste = await enregistrer(liste, [{ ...vue, headers: null }]);
    expect(sim.secrets.get(id)?.v).toEqual({ auth: "c1", headers: [], env: [] });
    liste = await enregistrer(liste, [{ ...vue, auth_mode: "", headers: [] }]);
    expect(liste[0]).not.toHaveProperty("secret_id");
    expect(sim.secrets.size).toBe(0);
    liste = await enregistrer(liste, [neuf]);
    expect(sim.secrets.size).toBe(1);
    await enregistrer(liste, []);
    expect(sim.secrets.size).toBe(0);
  });

  it("secret illisible : gardé sans saisie (liste vide comprise), remplacé par une saisie ; chiffré hérité illisible gardé et signalé", async () => {
    let liste = await enregistrer([], [neuf]);
    const id = liste[0]?.["secret_id"] as number;
    sim.pannes.set(id, "undecryptable");
    const vue = personalPublic(liste[0], await secretsPerso(BASE, 7, liste[0]));
    expect(vue).toMatchObject({ has_auth: false, headers: [], secret_error: "undecryptable" });
    liste = await enregistrer(liste, [{ ...vue, auth_mode: "header", headers: [] }]);
    expect(liste[0]?.["secret_id"]).toBe(id);
    expect(sim.secrets.get(id)?.version).toBe(1);
    expect((await enregistrer(liste, [{ ...vue, auth_secret: "c2" }]))[0]?.["secret_id"]).toBe(id);
    expect(sim.secrets.get(id)).toMatchObject({ version: 2, v: { auth: "c2", headers: [] } });

    const autre = new Fernet(Fernet.generateKey()).encrypt(Buffer.from("perdu", "utf8"));
    const herite = {
      id: "h",
      name: "H",
      type: "http",
      url: "https://h/mcp",
      auth_mode: "raw",
      auth_enc: autre,
      key_scheme: "fernet",
      secret_error: "undecryptable",
    };
    const vueH = personalPublic(herite, await secretsPerso(BASE, 7, herite));
    expect(vueH).toMatchObject({ has_auth: false, secret_error: "undecryptable" });
    expect(vueH).not.toHaveProperty("auth_enc");
    const gardee = await enregistrer([herite], [vueH]);
    expect(gardee[0]).toMatchObject({ auth_enc: autre, key_scheme: "fernet", secret_error: "undecryptable" });
    expect(gardee[0]).not.toHaveProperty("secret_id");
    const resaisie = await enregistrer(gardee, [{ ...vueH, auth_secret: "neuf" }]);
    expect(resaisie[0]).not.toHaveProperty("auth_enc");
    expect(resaisie[0]).not.toHaveProperty("secret_error");
    expect(sim.secrets.get(resaisie[0]?.["secret_id"] as number)?.v.auth).toBe("neuf");
  });

  it("ancien basic_auth : l'utilisateur suit le mot de passe repris, sauf saisie", async () => {
    const ancien = {
      id: "b",
      name: "B",
      type: "sse",
      url: "https://b/sse",
      basic_auth: { username: "lu", password: "lp" },
    };
    const recu = { id: "b", name: "B", type: "sse", url: "https://b/sse", auth_mode: "basic" };
    const [repris] = await enregistrer([ancien], [recu]);
    expect(repris).toMatchObject({ auth_mode: "basic", auth_user: "lu" });
    expect(sim.secrets.get(repris?.["secret_id"] as number)?.v.auth).toBe("lp");
    const [saisi] = await enregistrer([ancien], [{ ...recu, auth_user: "autre" }]);
    expect(saisi).toMatchObject({ auth_user: "autre" });
  });

  it("ancien clair lisible repris au coffre à l'enregistrement ; secret d'un autre compte jamais lu", async () => {
    const ancien = {
      id: "o",
      name: "O",
      type: "sse",
      url: "https://o/sse",
      auth_mode: "raw",
      authorization: "Bearer vieux",
    };
    const liste = await enregistrer(
      [ancien],
      [{ id: "o", name: "O", type: "sse", url: "https://o/sse", auth_mode: "raw" }],
    );
    expect(liste[0]).not.toHaveProperty("authorization");
    expect(sim.secrets.get(liste[0]?.["secret_id"] as number)?.v.auth).toBe("Bearer vieux");
    expect((await secretsPerso(BASE, 8, liste[0])).erreur).toBe("missing");
    expect((await secretsPerso(BASE, null, liste[0])).erreur).toBe("missing");
  });
});

describe("anciens secrets encore en place (revue V3c)", () => {
  const ancien = (): Record<string, unknown> => ({
    id: "f",
    name: "F",
    type: "http",
    url: "https://f/mcp",
    visible: true,
    auth_mode: "bearer",
    auth_user: "",
    auth_enc: encrypt("tok-f"),
    key_scheme: "fernet",
    headers_enc: encrypt('[{"name": "X-Tenant", "value": "acme"}]'),
    extra_scheme: "fernet",
    secret_error: "not_migrated",
  });
  const clair = { id: "p", name: "P", type: "sse", url: "https://p/sse", headers: { "X-Api-Key": "k2" } };
  const sansMode = { id: "a", name: "A", type: "sse", url: "https://a/sse", authorization: "Bearer abc" };

  it("vue : noms des anciens secrets lisibles et mode implicite montrés, drapeau gardé", async () => {
    expect(personalPublic(ancien(), await secretsPerso(BASE, 7, ancien()))).toMatchObject({
      has_auth: true,
      headers: [{ name: "X-Tenant", value: "", has_value: true }],
      secret_error: "not_migrated",
    });
    expect(personalPublic(clair)).toMatchObject({
      headers: [{ name: "X-Api-Key", value: "", has_value: true }],
      secret_error: "not_migrated",
    });
    expect(personalPublic(sansMode)).toMatchObject({ auth_mode: "raw", auth_user: "", has_auth: true });
  });

  it("enregistrement sans rien de neuf (vue renvoyée, liste vide) : anciens jeton, en-têtes et mode gardés, repris au coffre", async () => {
    for (const recu of [
      (v: Record<string, unknown>) => v,
      (v: Record<string, unknown>) => ({ ...v, headers: [] }),
      (v: Record<string, unknown>) => ({ ...v, visible: false, headers: undefined }),
    ]) {
      sim.secrets.clear();
      const anciens = [ancien(), clair, sansMode];
      const vues = anciens.map((s) => personalPublic(s));
      const liste = await enregistrer(anciens, vues.map(recu));
      const valeur = (i: number): unknown => sim.secrets.get(liste[i]?.["secret_id"] as number)?.v;
      expect(valeur(0)).toEqual({ auth: "tok-f", headers: [{ name: "X-Tenant", value: "acme" }], env: [] });
      expect(valeur(1)).toEqual({ auth: "", headers: [{ name: "X-Api-Key", value: "k2" }], env: [] });
      expect(valeur(2)).toMatchObject({ auth: "Bearer abc" });
      expect(liste[2]).toMatchObject({ auth_mode: "raw" });
      for (const e of liste) {
        expect(e).not.toHaveProperty("secret_error");
        expect(e).not.toHaveProperty("auth_enc");
        expect(e).not.toHaveProperty("headers_enc");
      }
    }
  });

  it("nouvelles valeurs saisies pour une partie : elles la remplacent, les autres anciennes parties restent", async () => {
    const vue = personalPublic(ancien());
    const [e] = await enregistrer([ancien()], [{ ...vue, headers: [{ name: "X-Neuf", value: "n" }] }]);
    expect(sim.secrets.get(e?.["secret_id"] as number)?.v).toEqual({
      auth: "tok-f",
      headers: [{ name: "X-Neuf", value: "n" }],
      env: [],
    });
  });

  it("secret retiré du coffre : gardé et signalé sans saisie, jamais vidé ; une saisie en crée un neuf", async () => {
    let liste = await enregistrer(
      [],
      [{ id: "m", name: "M", type: "http", url: "https://m/mcp", auth_mode: "bearer", auth_secret: "t" }],
    );
    const id = liste[0]?.["secret_id"] as number;
    sim.secrets.delete(id);
    const vue = personalPublic(liste[0], await secretsPerso(BASE, 7, liste[0]));
    expect(vue).toMatchObject({ secret_error: "missing" });
    liste = await enregistrer(liste, [vue]);
    expect(liste[0]?.["secret_id"]).toBe(id);
    expect((await secretsPerso(BASE, 7, liste[0])).erreur).toBe("missing");
    liste = await enregistrer(liste, [{ ...vue, auth_secret: "t2" }]);
    expect(liste[0]?.["secret_id"]).not.toBe(id);
    expect(sim.secrets.get(liste[0]?.["secret_id"] as number)?.v.auth).toBe("t2");
  });
});

describe("journal et empreintes (revue V3c)", () => {
  it("serveur ignoré signalé une fois par motif, pas à chaque tour", () => {
    const journal = capturerJournal();
    oublierAvertissementsPaires();
    for (let i = 0; i < 3; i++) signalerServeurIgnore("S", "missing");
    signalerServeurIgnore("S", "undecryptable");
    expect(journal.filter((l) => l.niveau === "warn").map((l) => l.message)).toEqual([
      "serveur MCP 'S' ignoré : secret absent du coffre",
      "serveur MCP 'S' ignoré : secret illisible avec la clé actuelle du coffre",
    ]);
    oublierAvertissementsPaires();
  });

  it("empreinte d'auth : HMAC à clé propre au process, stable, jamais le SHA-256 nu", () => {
    const cfg = { type: "http", url: "https://e/mcp", authorization: "Bearer court" };
    const nu = createHash("sha256")
      .update('{"authorization": "Bearer court", "basic_auth": null, "env": null, "headers": null}', "utf8")
      .digest("hex")
      .slice(0, 12);
    expect(authFingerprint(cfg)).toBe(authFingerprint({ ...cfg }));
    expect(authFingerprint(cfg)).not.toBe(nu);
    expect(authFingerprint(cfg)).not.toBe(authFingerprint({ ...cfg, authorization: "Bearer autre" }));
  });
});
