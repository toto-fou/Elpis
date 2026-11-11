// SPDX-License-Identifier: MIT
/** apps/core/test/comptes.test.ts — routes de comptes : aides rejouées contre le Python, puis scénarios de bout en bout sur SQLite et PostgreSQL. */
import { pbkdf2Sync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { creerJeton, dependancesParDefaut, mergeUserSettings, revoquerOauthDuCompte } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { decoderUtf8Py, HttpError, messageErreurOs } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { hachageAJour, oublierConfigurationAudit, viderRafalesAudit, verifyPassword } from "@elpis/securite";
import type { FastifyInstance, FastifyRequest, LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  enteteSuppressionCookie,
  extensionImage,
  rejeterInterSite,
  urlDeBase,
  validerMotDePasse,
} from "../src/comptes/aides";
import { composer } from "../src/composition";
import { appTest, effacementUnifie, journalMuet, lignesAuditRecentes, lignesJournal } from "./aides";
import { REFUS_AVATAR_ASSISTANT } from "./ecart-avatar-assistant";

type Dict = Record<string, unknown>;
const V = JSON.parse(readFileSync(new URL("./vecteurs/comptes.json", import.meta.url), "utf-8")) as {
  maintenant: number;
  inter_site: { entetes: Record<string, string>; refus: boolean }[];
  effacements: {
    attributs: { cookie_name: string; same_site: string; https_only: boolean };
    entete: string;
  }[];
  images: { tete: string; extension: string | null }[];
  mots_de_passe: { politique: Dict; mot: string; ok?: boolean; statut?: number; detail?: string }[];
  bases: { url: string; valide: boolean }[];
  decodages: { hex: string; texte?: string; erreur?: string }[];
  erreurs_os: { code: string; message: string }[];
};

function issue(fn: () => void): { ok: true } | { statut: number; detail: unknown } {
  try {
    fn();
    return { ok: true };
  } catch (e) {
    if (e instanceof HttpError) return { statut: e.statusCode, detail: e.detail };
    throw e;
  }
}

describe("aides rejouées contre le Python", () => {
  it.each(V.inter_site.map((c) => [JSON.stringify(c.entetes), c] as const))(
    "_reject_cross_site %s",
    (_n, c) => {
      const r = issue(() => rejeterInterSite((nom) => c.entetes[nom], "serveur:8000"));
      expect("statut" in r).toBe(c.refus);
    },
  );

  it.each(V.effacements.map((c) => [c.attributs.cookie_name, c] as const))(
    "delete_cookie %s (forme unique du TS)",
    (_n, c) => {
      expect(enteteSuppressionCookie({ ...c.attributs, max_age: 1 }, V.maintenant)).toBe(
        effacementUnifie(c.entete),
      );
    },
  );

  it.each(V.images.map((c) => [c.tete, c] as const))("_detect_image_type %s", (_n, c) => {
    expect(extensionImage(Buffer.from(c.tete, "hex"))).toBe(c.extension);
  });

  it.each(V.mots_de_passe.map((c, i) => [i, c] as const))("validate_password %i", (_i, c) => {
    const r = issue(() => validerMotDePasse(c.mot, { security: { password_policy: c.politique } }));
    expect(r).toEqual(c.ok ? { ok: true } : { statut: c.statut, detail: c.detail });
  });

  it.each(V.bases.map((c) => [c.url, c] as const))("_SAFE_BASE_RE %j", (_n, c) => {
    const [schema = "", hote = ""] = c.url.split("://");
    const requete = { protocol: schema, headers: { host: hote }, socket: {} } as unknown as FastifyRequest;
    expect("ok" in issue(() => urlDeBase(requete))).toBe(c.valide);
  });

  it.each(V.decodages.map((c) => [c.hex, c] as const))("bytes.decode('utf-8') %s", (_n, c) => {
    const o = Buffer.from(c.hex, "hex");
    if (c.texte !== undefined) expect(decoderUtf8Py(o)).toBe(c.texte);
    else expect(() => decoderUtf8Py(o)).toThrow(c.erreur);
  });

  it.each(V.erreurs_os.map((c) => [c.code, c] as const))("str(OSError) %s", (_n, c) => {
    expect(messageErreurOs({ code: c.code }, "/a/b")).toBe(c.message);
  });
});

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(40, 7)]);
const B = "frontiereTest";
let audit: string;

beforeAll(() => {
  audit = mkdtempSync(join(tmpdir(), "elpis-audit-comptes-"));
  process.env["ELPIS_AUDIT_DIR"] = audit;
});

const auditAvant = process.env["ELPIS_AUDIT_DIR"];

/** Lignes récentes du journal de sécurité, plus récentes d'abord. */
const recentes = (n: number): Record<string, unknown>[] =>
  lignesAuditRecentes({ limit: n }) as Record<string, unknown>[];

/** Texte brut de tous les fichiers du journal de sécurité. */
function texteAudit(): string {
  return readdirSync(audit)
    .map((f) => readFileSync(join(audit, f), "utf8"))
    .join("");
}

afterAll(() => {
  if (auditAvant === undefined) delete process.env["ELPIS_AUDIT_DIR"];
  else process.env["ELPIS_AUDIT_DIR"] = auditAvant;
  oublierConfigurationAudit();
  rmSync(audit, { recursive: true, force: true });
});

function formulaire(fichier: Buffer, type = "image/png", nom = "a.png"): { headers: Dict; payload: Buffer } {
  return {
    headers: { "content-type": `multipart/form-data; boundary=${B}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${B}\r\nContent-Disposition: form-data; name="file"; filename="${nom}"\r\nContent-Type: ${type}\r\n\r\n`,
      ),
      fichier,
      Buffer.from(`\r\n--${B}--\r\n`),
    ]),
  };
}

function cookie(r: LightMyRequestResponse): string {
  const tous = ([] as string[]).concat(r.headers["set-cookie"] ?? []);
  const session = tous.find((c) => /^mcpwebui_session=(?!null;|"";)/u.test(c));
  return (session ?? "").split(";")[0] ?? "";
}

describe.each(MOTEURS)("routes de comptes (%s)", (moteur) => {
  let t: BaseDeTest;
  let racine: string;
  let app: FastifyInstance;
  let config: Dict;
  let dep: DependancesAuth & DependancesJetons;

  const login = (username: string, password: string, remoteAddress = "10.0.0.5") =>
    app.inject({ method: "POST", url: "/api/login-lite", remoteAddress, payload: { username, password } });

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    racine = mkdtempSync(join(tmpdir(), "elpis-racine-"));
    config = {};
    const defaut = dependancesParDefaut(t.base);
    dep = {
      ...defaut,
      config: () => config,
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax",
        https_only: false,
        max_age: 86400,
      }),
      secret: () => "secret-de-test",
      jetonService: () => "",
      revoquerOauth: (uid) => revoquerOauthDuCompte(t.base, uid, Date.now() / 1000),
    };
    const c = await composer("main", t.base, journalMuet, dep, racine);
    app = await appTest({ ...c });
  });

  afterEach(async () => {
    await app.close();
    await t.fermer();
    rmSync(racine, { recursive: true, force: true });
  });

  it("amorçage local : le premier login « admin » crée l'administrateur, sans changement de mot de passe", async () => {
    const r = await login("admin", "choisi", "127.0.0.1");
    expect([r.statusCode, r.json()]).toEqual([
      200,
      { ok: true, is_admin: true, must_change_password: false },
    ]);
    expect(recentes(2).map((l) => [l["action"], l["details"]])).toEqual([
      ["auth.login", { user_agent: "lightMyRequest", reason: null }],
      ["auth.bootstrap", { mode: "local", target_user_id: 1, must_change: false }],
    ]);
    const me = await app.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: cookie(r) } });
    expect(me.headers["cache-control"]).toBe("no-cache");
    expect(me.json()).toEqual({
      logged_in: true,
      id: 1,
      username: "admin",
      is_admin: true,
      role: "admin",
      avatar: null,
    });
  });

  it("amorçage distant : mot de passe initial écrit en 0600, exigé, puis changement forcé", async () => {
    const refus = await login("admin", "devine");
    expect([refus.statusCode, refus.json()]).toEqual([401, { detail: "invalid credentials" }]);
    const fichier = join(racine, "user_db", ".bootstrap_admin");
    expect(statSync(fichier).mode & 0o777).toBe(0o600);
    expect(lignesAuditRecentes({ limit: 1 })[0]).toMatchObject({
      action: "auth.login.denied",
      ip: "10.0.0.5",
      details: { reason: "bootstrap_locked" },
    });
    const initial = readFileSync(fichier, "utf8").trim();
    const ok = await login("admin", initial);
    expect(ok.json()).toEqual({ ok: true, is_admin: true, must_change_password: true });
    expect(recentes(2)[1]).toMatchObject({
      action: "auth.bootstrap",
      user_id: 1,
      username: "admin",
      ip: "10.0.0.5",
      details: { mode: "file", target_user_id: 1, must_change: true },
    });
    expect(existsSync(fichier)).toBe(false);
    const me = await app.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: cookie(ok) } });
    expect(me.json()).toEqual({ logged_in: false, must_change_password: true, id: 1, username: "admin" });
    expect(
      (await app.inject({ method: "GET", url: "/api/users/lite", headers: { cookie: cookie(ok) } })).json(),
    ).toEqual({
      detail: "must_change_password",
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/auth/check", headers: { cookie: cookie(ok) } })).json(),
    ).toEqual({
      detail: "not authenticated",
    });
  });

  it("connexion avec un hachage d'avant PBKDF2 versionné (150 000 itérations) : acceptée puis rehachée au format courant, une seule fois ; mauvais mot de passe : rien de réécrit", async () => {
    await login("admin", "a", "127.0.0.1");
    const sel = "00112233445566778899aabbccddeeff";
    const ancien = pbkdf2Sync("ancien-secret", Buffer.from(sel, "hex"), 150_000, 32, "sha256").toString(
      "hex",
    );
    await t.base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES (?, ?, ?, 0, 0)",
      ["carla", sel, ancien],
    );
    const lire = async (): Promise<string> =>
      String((await t.base.valeurs("SELECT pass_hash FROM users WHERE username='carla'"))[0]?.[0]);
    expect((await login("carla", "faux")).statusCode).toBe(401);
    expect(await lire()).toBe(ancien);
    const ok = await login("carla", "ancien-secret");
    expect([ok.statusCode, ok.json()]).toEqual([
      200,
      { ok: true, is_admin: false, must_change_password: false },
    ]);
    const rehache = await lire();
    expect(rehache).toMatch(/^pbkdf2_sha256\$600000\$[0-9a-f]{32}\$[0-9a-f]{64}$/u);
    expect(hachageAJour(rehache)).toBe(true);
    expect(await verifyPassword("ancien-secret", "inutile", rehache)).toBe(true);
    expect((await login("carla", "ancien-secret")).statusCode).toBe(200);
    expect(await lire()).toBe(rehache);
  });

  it("refus de connexion : instance vierge sans « admin », mauvais mot de passe, corps invalides", async () => {
    expect((await login("Identifiant-Tape-1", "x")).statusCode).toBe(401);
    expect(lignesAuditRecentes({ limit: 1 })[0]).toMatchObject({
      user_id: null,
      username: null,
      details: { reason: "bootstrap_denied" },
    });
    expect(recentes(1)[0]?.["details"]).not.toHaveProperty("identifier_hash");
    expect(texteAudit()).not.toContain("Identifiant-Tape-1");
    await login("admin", "a", "127.0.0.1");
    expect((await login("admin", "faux")).statusCode).toBe(401);
    expect(lignesAuditRecentes({ limit: 1 })[0]).toMatchObject({ details: { reason: "bad_password" } });
    const brut = (payload: string) =>
      app.inject({
        method: "POST",
        url: "/api/login-lite",
        headers: { "content-type": "application/json" },
        payload,
      });
    expect((await brut("[1]")).json()).toEqual({ detail: "Corps JSON invalide : objet attendu" });
    expect((await brut('{"username": "admin"}')).json()).toEqual({ detail: "username/password required" });
    expect((await brut("{")).statusCode).toBe(400);
    expect((await brut('{"username": 5, "password": "x"}')).statusCode).toBe(500);
  });

  it("déconnexion : _sid révoqué, cookie effacé deux fois (route, puis session) sous une forme unique (HttpOnly, Max-Age=0), audit « logout »", async () => {
    const c = await (async () => {
      await login("admin", "a", "127.0.0.1");
      return cookie(await login("admin", "a"));
    })();
    const r = await app.inject({ method: "POST", url: "/api/logout-lite", headers: { cookie: c } });
    expect(r.json()).toEqual({ ok: true });
    const tous = r.headers["set-cookie"] as string[];
    expect(tous).toHaveLength(2);
    expect(tous[0]).toMatch(
      /^mcpwebui_session=""; path=\/; expires=\w{3}, \d\d \w{3} \d{4} [\d:]{8} GMT; Max-Age=0; httponly; samesite=lax$/u,
    );
    expect(tous[1]).toBe(
      'mcpwebui_session=""; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; httponly; samesite=lax',
    );
    expect(
      (await app.inject({ method: "GET", url: "/api/users/lite", headers: { cookie: c } })).statusCode,
    ).toBe(401);
    expect(lignesAuditRecentes({ limit: 1 })[0]).toMatchObject({
      action: "auth.logout",
      outcome: "success",
      user_id: 1,
      username: "admin",
      ip: "127.0.0.1",
      details: { user_agent: "lightMyRequest" },
    });
    const deconnexions = (): number => recentes(1000).filter((l) => l["action"] === "auth.logout").length;
    const avant = deconnexions();
    for (let i = 0; i < 3; i++) await app.inject({ method: "POST", url: "/api/logout-lite" });
    expect(deconnexions()).toBe(avant);
  });

  it("changement de mot de passe : cross-site refusé, politique, autres sessions et jetons coupés", async () => {
    await login("admin", "ancien", "127.0.0.1");
    const ici = cookie(await login("admin", "ancien"));
    const ailleurs = cookie(await login("admin", "ancien"));
    await creerJeton(dep, 1, "opencode", "poste");
    const changer = (corps: Dict, entetes: Dict = {}, c = ici) =>
      app.inject({
        method: "POST",
        url: "/api/users/change-password",
        headers: { cookie: c, ...entetes },
        payload: corps,
      });
    expect((await changer({ new_password: "n" }, { "sec-fetch-site": "same-site" })).json()).toEqual({
      detail: "Requête cross-site refusée.",
    });
    expect((await changer({})).json()).toEqual({ detail: "Mot de passe requis" });
    expect((await changer({ new_password: "n" })).json()).toEqual({ detail: "Ancien mot de passe requis" });
    expect((await changer({ new_password: "n", old_password: "faux" })).json()).toEqual({
      detail: "Ancien mot de passe incorrect",
    });
    config = { security: { password_policy: { min_length: 8 } } };
    expect((await changer({ new_password: "court", old_password: "ancien" })).json()).toEqual({
      detail: "Le mot de passe doit faire au moins 8 caractères.",
    });
    const ok = await changer({ new_password: "nouveau-long", old_password: "ancien" });
    expect(ok.json()).toEqual({ ok: true });
    const suite = cookie(ok) || ici;
    expect(
      (await app.inject({ method: "GET", url: "/api/users/lite", headers: { cookie: suite } })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/users/lite", headers: { cookie: ailleurs } })).statusCode,
    ).toBe(401);
    expect(await t.base.all("SELECT id FROM tool_tokens")).toEqual([]);
    expect((await login("admin", "nouveau-long")).statusCode).toBe(200);
  });

  it("journal : compte inconnu réduit à une empreinte, mot de passe jamais écrit, changement de mot de passe audité", async () => {
    await login("admin", "a", "127.0.0.1");
    expect((await login("fantome", "Secret-Fantome-1")).statusCode).toBe(401);
    expect(lignesAuditRecentes({ limit: 1 })[0]).toMatchObject({
      action: "auth.login.denied",
      outcome: "failure",
      user_id: null,
      username: null,
      ip: "10.0.0.5",
      details: { reason: "unknown_user" },
    });
    expect(recentes(1)[0]?.["details"]).not.toHaveProperty("identifier_hash");
    const cle = join(racine, "audit.key");
    const cleAvant = process.env["ELPIS_AUDIT_KEY_PATH"];
    writeFileSync(cle, "k".repeat(32));
    process.env["ELPIS_AUDIT_KEY_PATH"] = cle;
    oublierConfigurationAudit();
    try {
      expect((await login("fantome", "Secret-Fantome-1")).statusCode).toBe(401);
      expect(lignesAuditRecentes({ limit: 1 })[0]).toMatchObject({
        username: null,
        details: { reason: "unknown_user", identifier_hash: expect.stringMatching(/^[0-9a-f]{16}$/u) },
      });
    } finally {
      if (cleAvant === undefined) delete process.env["ELPIS_AUDIT_KEY_PATH"];
      else process.env["ELPIS_AUDIT_KEY_PATH"] = cleAvant;
      oublierConfigurationAudit();
    }
    expect((await login("admin", "Secret-Mauvais-2")).statusCode).toBe(401);
    expect(lignesAuditRecentes({ limit: 1 })[0]).toMatchObject({
      action: "auth.login.denied",
      user_id: 1,
      username: "admin",
      details: { reason: "bad_password" },
    });
    const c = cookie(await login("admin", "a"));
    const changer = (corps: Dict) =>
      app.inject({
        method: "POST",
        url: "/api/users/change-password",
        headers: { cookie: c },
        payload: corps,
      });
    viderRafalesAudit();
    await changer({ new_password: "Secret-Nouveau-3" });
    expect(lignesAuditRecentes({ limit: 1 })[0]).toMatchObject({
      action: "auth.password.change.denied",
      user_id: 1,
      details: { reason: "missing_old_password" },
    });
    viderRafalesAudit();
    await changer({ new_password: "Secret-Nouveau-3", old_password: "faux" });
    expect(lignesAuditRecentes({ limit: 1 })[0]).toMatchObject({
      details: { reason: "bad_old_password" },
    });
    config = { security: { password_policy: { min_length: 30 } } };
    viderRafalesAudit();
    await changer({ new_password: "Secret-Nouveau-3", old_password: "a" });
    expect(lignesAuditRecentes({ limit: 1 })[0]).toMatchObject({ details: { reason: "policy" } });
    config = {};
    expect((await changer({ new_password: "Secret-Nouveau-3", old_password: "a" })).statusCode).toBe(200);
    expect(lignesAuditRecentes({ limit: 1 })[0]).toMatchObject({
      action: "auth.password.change",
      outcome: "success",
      user_id: 1,
      username: "admin",
      ip: "127.0.0.1",
    });
    const brut = texteAudit();
    for (const secret of ["Secret-Fantome-1", "Secret-Mauvais-2", "Secret-Nouveau-3"])
      expect(brut).not.toContain(secret);
    expect(brut).not.toContain('"fantome"');
  });

  it("changement de mot de passe : même politique que la création de compte ; sans politique configurée (défaut du Python) 5 caractères passent", async () => {
    await login("admin", "ancien", "127.0.0.1");
    let c = cookie(await login("admin", "ancien"));
    let actuel = "ancien";
    const changer = async (nouveau: string) => {
      const r = await app.inject({
        method: "POST",
        url: "/api/users/change-password",
        headers: { cookie: c },
        payload: { new_password: nouveau, old_password: actuel },
      });
      if (r.statusCode === 200) {
        actuel = nouveau;
        c = cookie(r) || c;
      }
      return [r.statusCode, r.json()];
    };
    expect(await changer("abcde")).toEqual([200, { ok: true }]);
    config = {
      security: {
        password_policy: {
          min_length: 10,
          require_uppercase: true,
          require_lowercase: true,
          require_numbers: true,
          require_special: true,
        },
      },
    };
    const refus = (detail: string) => [400, { detail }];
    expect(await changer("Abcde1!")).toEqual(refus("Le mot de passe doit faire au moins 10 caractères."));
    expect(await changer("abcdefghij1!")).toEqual(
      refus("Le mot de passe doit contenir au moins une majuscule (A-Z)."),
    );
    expect(await changer("ABCDEFGHIJ1!")).toEqual(
      refus("Le mot de passe doit contenir au moins une minuscule (a-z)."),
    );
    expect(await changer("Abcdefghij!!")).toEqual(
      refus("Le mot de passe doit contenir au moins un chiffre (0-9)."),
    );
    expect(await changer("Abcdefghij12")).toEqual(
      refus("Le mot de passe doit contenir au moins un caractère spécial."),
    );
    expect(await changer("Abcdefghij1!")).toEqual([200, { ok: true }]);
  });

  it("liste « lite » : l'administrateur voit tout le monde, un compte seulement ses groupes", async () => {
    await login("admin", "a", "127.0.0.1");
    const admin = cookie(await login("admin", "a"));
    for (const nom of ["bob", "carol"]) {
      await t.base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) SELECT ?, pass_salt, pass_hash, 0, 0 FROM users WHERE id=1",
        [nom],
      );
    }
    const g = await t.base.insertId('INSERT INTO "groups"(name, description, created_at) VALUES (?,?,?)', [
      "dev",
      "",
      0,
    ]);
    await t.base.run("INSERT INTO user_groups(user_id, group_id) VALUES (2, ?), (1, ?)", [g, g]);
    const bob = cookie(await login("bob", "a"));
    const voir = async (c: string) =>
      (await app.inject({ method: "GET", url: "/api/users/lite", headers: { cookie: c } })).json<{
        users: { username: string }[];
        my_groups: { name: string }[];
      }>();
    expect((await voir(admin)).users.map((u) => u.username)).toEqual(["bob", "carol"]);
    const vu = await voir(bob);
    expect(vu.users.map((u) => u.username)).toEqual(["admin"]);
    expect(vu.my_groups.map((x) => x.name)).toEqual(["dev"]);
  });

  it("avatars : signature exigée, ancien fichier remplacé, servi, supprimé ; noms dangereux refusés", async () => {
    await login("admin", "a", "127.0.0.1");
    const c = cookie(await login("admin", "a"));
    const poster = (corps: { headers: Dict; payload: Buffer }, url = "/api/settings/avatar") =>
      app.inject({ method: "POST", url, headers: { cookie: c, ...corps.headers }, payload: corps.payload });
    expect((await poster(formulaire(PNG, "text/plain"))).json()).toEqual({
      detail: "Le fichier doit être une image",
    });
    expect((await poster(formulaire(Buffer.from("pas une image"), "image/png"))).json()).toEqual({
      detail: "Fichier image invalide (signature non reconnue).",
    });
    expect((await poster(formulaire(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])))).json()).toEqual({
      detail: "Fichier trop volumineux (plafond : 5 Mo).",
    });
    const premier = (await poster(formulaire(PNG))).json<{ avatar: string }>().avatar;
    expect(premier).toMatch(/^1_\d+\.png$/u);
    const dossier = join(racine, "user_db", "avatars");
    expect(readFileSync(join(dossier, premier))).toEqual(PNG);
    writeFileSync(join(dossier, "1_0.png"), PNG);
    await t.base.run("UPDATE users SET avatar='1_0.png' WHERE id=1");
    await poster(formulaire(PNG));
    expect(existsSync(join(dossier, "1_0.png"))).toBe(false);
    const servi = await app.inject({ method: "GET", url: `/avatars/${premier}` });
    expect([servi.statusCode, servi.headers["content-type"], servi.rawPayload]).toEqual([
      200,
      "image/png",
      PNG,
    ]);
    for (const [url, statut] of [
      ["/avatars/..%5Cx", 400],
      ["/avatars/a..b", 400],
      ["/avatars/inconnu.png", 404],
      ["/avatars/a%2Fb", 404],
    ] as const)
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(statut);
    // Écart voulu : l'avatar de l'assistant est le logo de l'application, l'envoi est refusé sans rien écrire.
    const bot = await poster(formulaire(PNG), "/api/settings/assistant-avatar");
    expect([bot.statusCode, bot.json()]).toEqual([403, { detail: REFUS_AVATAR_ASSISTANT }]);
    expect(readdirSync(dossier).filter((n) => n.startsWith("bot_"))).toEqual([]);
    const reglages = (await t.base.get("SELECT settings_json AS s FROM users WHERE id=1"))?.s;
    expect(JSON.parse(String(reglages || "{}"))).toEqual({});
    const actuel = String((await t.base.get("SELECT avatar FROM users WHERE id=1"))?.avatar);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/settings/avatar", headers: { cookie: c } })).json(),
    ).toEqual({ ok: true });
    expect(existsSync(join(dossier, actuel))).toBe(false);
    expect((await t.base.get("SELECT avatar FROM users WHERE id=1"))?.avatar).toBeNull();
  });

  it("jetons : création (422 sur type ou demande refusés), liste, politique, URL tirées du Host", async () => {
    await login("admin", "a", "127.0.0.1");
    const c = cookie(await login("admin", "a"));
    const creer = (corps: unknown) =>
      app.inject({ method: "POST", url: "/api/tokens", headers: { cookie: c }, payload: corps as Dict });
    expect((await creer({ kind: "vision" })).json()).toEqual({ detail: "Type de jeton inconnu." });
    expect((await creer({ families: ["chart"] })).json()).toEqual({
      detail: "Famille non autorisée : chart.",
    });
    expect((await creer({ families: [] })).json()).toEqual({
      detail: "Cochez au moins une famille d'outils.",
    });
    const outils = await creer({ name: " CI ", families: ["git", "fs"], days: "" });
    expect(outils.statusCode).toBe(200);
    const { token, item } = outils.json<{ token: string; item: Dict }>();
    expect(token).toMatch(/^ept_/u);
    expect(item).toMatchObject({ kind: "tools", name: "CI", families: ["fs", "git"], hint: token.slice(-4) });
    const oc = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie: c, "content-type": "application/json" },
      payload: '{"kind": "opencode"',
    });
    expect(oc.statusCode).toBe(422);
    expect((await creer({ kind: "opencode", name: "poste" })).json<{ item: Dict }>().item).toMatchObject({
      name: "poste",
    });
    const liste = await app.inject({
      method: "GET",
      url: "/api/tokens",
      headers: { cookie: c, host: "elpis.lan:8080" },
    });
    const l = liste.json<{
      tokens: Dict[];
      policy: Dict;
      opencode_enabled: boolean;
      bridge_url: string;
      tools_url: string;
    }>();
    expect(l.tokens.map((x) => x["name"])).toEqual(["poste", "CI"]);
    expect(l.policy).toMatchObject({ tools_enabled: true, max_days: 90, max_per_user: 20 });
    expect((l.policy["families"] as Dict[])[0]).toEqual({ name: "fs", label: "fs" });
    expect([l.opencode_enabled, l.bridge_url, l.tools_url]).toEqual([
      true,
      "http://elpis.lan:8080/api/mcp-bridge",
      "http://elpis.lan:8080/api/tools",
    ]);
    const id = Number(item["id"]);
    const regen = await app.inject({
      method: "POST",
      url: `/api/tokens/00${id}/regenerate`,
      headers: { cookie: c },
    });
    const nouveau = regen.json<{ token: string; item: Dict }>();
    expect(nouveau.token).not.toBe(token);
    expect(nouveau.item).toMatchObject({ name: "CI", families: ["fs", "git"] });
    expect(
      (
        await app.inject({ method: "POST", url: `/api/tokens/${id}/regenerate`, headers: { cookie: c } })
      ).json(),
    ).toEqual({
      detail: "Jeton introuvable.",
    });
    expect(
      (
        await app.inject({ method: "POST", url: "/api/tokens/abc/regenerate", headers: { cookie: c } })
      ).json(),
    ).toEqual({
      detail: [
        {
          type: "int_parsing",
          loc: ["path", "token_id"],
          msg: "Input should be a valid integer, unable to parse string as an integer",
          input: "abc",
        },
      ],
    });
    config = { mcp: { tokens: { tools_enabled: false } } };
    const refus = await app.inject({
      method: "POST",
      url: `/api/tokens/${Number(nouveau.item["id"])}/regenerate`,
      headers: { cookie: c },
    });
    expect([refus.statusCode, refus.json()]).toEqual([
      422,
      { detail: "Les jetons d'outils sont désactivés par l'administrateur." },
    ]);
    config = {};
    const supprimer = (n: number) =>
      app.inject({ method: "DELETE", url: `/api/tokens/${n}`, headers: { cookie: c } });
    expect((await supprimer(Number(nouveau.item["id"]))).json()).toEqual({ ok: true });
    expect((await supprimer(Number(nouveau.item["id"]))).json()).toEqual({ detail: "Jeton introuvable." });
    const hote = await app.inject({
      method: "GET",
      url: "/api/tokens",
      headers: { cookie: c, host: "h;rm -rf" },
    });
    expect([hote.statusCode, hote.json()]).toEqual([400, { detail: "Hôte invalide." }]);
  });

  it("changement forcé sans ancien mot de passe, puis connecté ; modérateur ; auth/check 204", async () => {
    await login("admin", "a", "127.0.0.1");
    await t.base.run("UPDATE users SET must_change_pwd=1, is_admin=2 WHERE id=1");
    const c = cookie(await login("admin", "a"));
    const r = await app.inject({
      method: "POST",
      url: "/api/users/change-password",
      headers: { cookie: c },
      payload: { new_password: "neuf" },
    });
    expect(r.json()).toEqual({ ok: true });
    expect((await t.base.get("SELECT must_change_pwd AS m FROM users WHERE id=1"))?.m).toBe(0);
    const suite = cookie(r) || c;
    expect(
      (await app.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: suite } })).json(),
    ).toEqual({
      logged_in: true,
      id: 1,
      username: "admin",
      is_admin: true,
      role: "moderator",
      avatar: null,
    });
    const check = await app.inject({ method: "GET", url: "/api/auth/check", headers: { cookie: suite } });
    expect([check.statusCode, check.body]).toEqual([204, ""]);
    const sans = await app.inject({ method: "POST", url: "/api/logout-lite" });
    expect(([] as string[]).concat(sans.headers["set-cookie"] ?? [])).toHaveLength(1);
  });

  it("mot de passe changé : autorisations OAuth coupées et décompte journalisé ; mot de passe non textuel", async () => {
    await login("admin", "a", "127.0.0.1");
    const c = cookie(await login("admin", "a"));
    await t.base.run("INSERT INTO oauth_clients(client_id, name, created_at) VALUES ('c1', 'Client', 0)");
    await t.base.run(
      "INSERT INTO oauth_tokens(grant_id, user_id, client_id, kind, token_hash, created_at, expires_at) VALUES ('g1', 1, 'c1', 'refresh', 'h1', 0, ?)",
      [Date.now() / 1000 + 3600],
    );
    lignesJournal.length = 0;
    const r = await app.inject({
      method: "POST",
      url: "/api/users/change-password",
      headers: { cookie: c },
      payload: { new_password: "b", old_password: "a" },
    });
    expect(r.json()).toEqual({ ok: true });
    expect(await t.base.all("SELECT id FROM oauth_tokens")).toEqual([]);
    expect(lignesJournal.join("\n")).toContain("[tokens] compte 1 : 0 jeton(s) et 1 application(s) révoqués");
    const inconnu = await app.inject({
      method: "POST",
      url: "/api/login-lite",
      payload: { username: "nobody", password: 5 },
    });
    expect([inconnu.statusCode, inconnu.json()]).toEqual([401, { detail: "invalid credentials" }]);
    expect(lignesAuditRecentes({ limit: 1 })[0]).toMatchObject({
      username: null,
      details: { reason: "unknown_user" },
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/login-lite",
          payload: { username: "admin", password: [1] },
        })
      ).statusCode,
    ).toBe(500);
  });

  it("avatars : confinement par liens symboliques ; avatars d'assistant déjà déposés conservés (envoi refusé)", async () => {
    await login("admin", "a", "127.0.0.1");
    const c = cookie(await login("admin", "a"));
    const dossier = join(racine, "user_db", "avatars");
    mkdirSync(dossier, { recursive: true });
    const dehors = join(racine, "secret.png");
    writeFileSync(dehors, PNG);
    symlinkSync(dehors, join(dossier, "lien.png"));
    symlinkSync(join(racine, "absent.png"), join(dossier, "pendant.png"));
    for (const [url, statut] of [
      ["/avatars/lien.png", 400],
      ["/avatars/pendant.png", 400],
      ["/avatars/", 404],
    ] as const)
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(statut);
    const autre = join(dossier, "2_1.png");
    writeFileSync(autre, PNG);
    await mergeUserSettings(t.base, 1, (s) => void (s["assistant_avatar"] = "2_1.png"));
    const poster = () =>
      app.inject({
        method: "POST",
        url: "/api/settings/assistant-avatar",
        headers: { cookie: c, ...formulaire(PNG).headers },
        payload: formulaire(PNG).payload,
      });
    expect((await poster()).statusCode).toBe(403);
    expect(existsSync(autre)).toBe(true);
    writeFileSync(join(dossier, "bot_1_5.png"), PNG);
    await mergeUserSettings(t.base, 1, (s) => void (s["assistant_avatar"] = "bot_1_5.png"));
    expect((await poster()).statusCode).toBe(403);
    expect(existsSync(join(dossier, "bot_1_5.png"))).toBe(true);
    expect((await app.inject({ method: "GET", url: "/avatars/bot_1_5.png" })).statusCode).toBe(200);
    const plage = await app.inject({
      method: "GET",
      url: "/avatars/2_1.png",
      headers: { range: "bytes=999-1000" },
    });
    expect([plage.statusCode, plage.headers["content-range"]]).toEqual([416, `bytes */${PNG.length}`]);
  });

  it("aide : guide utilisateur ou documentation développeur, message si absente", async () => {
    await login("admin", "a", "127.0.0.1");
    const c = cookie(await login("admin", "a"));
    const lire = (q: string) =>
      app.inject({ method: "GET", url: `/api/help/readme${q}`, headers: { cookie: c } });
    expect((await lire("")).json()).toEqual({
      content: "# Fichier docs/fr/user-guide.md introuvable\n\nAucune documentation n'a été trouvée.",
      doc: "user",
    });
    mkdirSync(join(racine, "docs"));
    writeFileSync(join(racine, "docs", "architecture.md"), "# Archi");
    expect((await lire("?doc=%20DEV%20")).json()).toEqual({ content: "# Archi", doc: "dev" });
    expect((await lire("?doc=dev&doc=user")).json<{ doc: string }>().doc).toBe("user");
    mkdirSync(join(racine, "docs", "fr"));
    writeFileSync(join(racine, "docs", "fr", "user-guide.md"), Buffer.from("ok\xff", "latin1"));
    expect((await lire("")).json()).toEqual({
      content:
        "# Erreur de lecture\n\nImpossible de lire le fichier: 'utf-8' codec can't decode byte 0xff in position 2: invalid start byte",
      doc: "user",
    });
  });
});
