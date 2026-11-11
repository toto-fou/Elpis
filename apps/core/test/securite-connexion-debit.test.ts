// SPDX-License-Identifier: MIT
/** apps/core/test/securite-connexion-debit.test.ts — `/api/login-lite` : échecs ralentis puis 429, comptés avant tout PBKDF2, par (nom, adresse) et par adresse, sans verrou de compte. */
import type * as Crypto from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Minuteurs from "node:timers/promises";

import { createUser, dependancesParDefaut, revoquerOauthDuCompte } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DebitConnexion, PAR_ADRESSE, PAR_NOM_ET_ADRESSE, SEAUX_MAX } from "../src/comptes/debit-connexion";
import { composer } from "../src/composition";
import { appTest, journalMuet, lignesAuditRecentes } from "./aides";

const suivi = vi.hoisted(() => ({ pbkdf2: 0, delais: [] as number[] }));

vi.mock("node:crypto", async (original) => {
  const reel = await original<typeof Crypto>();
  return {
    ...reel,
    pbkdf2: (...a: Parameters<typeof reel.pbkdf2>) => {
      suivi.pbkdf2++;
      reel.pbkdf2(a[0], a[1], 1, a[3], a[4], a[5]);
    },
  };
});

vi.mock("node:timers/promises", async (original) => {
  const reel = await original<typeof Minuteurs>();
  return {
    ...reel,
    setTimeout: (...a: Parameters<typeof reel.setTimeout>) => {
      const ms = a[0];
      if (ms === undefined || ms < 500) return reel.setTimeout(...a);
      suivi.delais.push(ms);
      return Promise.resolve();
    },
  };
});

const T0 = 1_800_000_000;
let audit: string;
const auditAvant = process.env["ELPIS_AUDIT_DIR"];

beforeAll(() => {
  audit = mkdtempSync(join(tmpdir(), "elpis-audit-"));
  process.env["ELPIS_AUDIT_DIR"] = audit;
  oublierConfigurationAudit();
});

afterAll(() => {
  if (auditAvant === undefined) delete process.env["ELPIS_AUDIT_DIR"];
  else process.env["ELPIS_AUDIT_DIR"] = auditAvant;
  oublierConfigurationAudit();
  rmSync(audit, { recursive: true, force: true });
});

describe("POST /api/login-lite : débit", () => {
  let t: BaseDeTest;
  let racine: string;
  let app: FastifyInstance;
  let horloge = T0;

  const essai = (username: string, password: unknown, remoteAddress = "10.0.0.5", xff?: string) =>
    app.inject({
      method: "POST",
      url: "/api/login-lite",
      remoteAddress,
      headers: xff === undefined ? {} : { "x-forwarded-for": xff },
      payload: { username, password },
    });

  const monter = async (): Promise<void> => {
    const dep = {
      ...dependancesParDefaut(t.base),
      config: () => ({}),
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax",
        https_only: false,
        max_age: 86400,
      }),
      secret: () => "secret-de-test",
      jetonService: () => "",
      revoquerOauth: (uid: number) => revoquerOauthDuCompte(t.base, uid, T0),
      maintenant: () => horloge,
    };
    app = await appTest({ ...(await composer("main", t.base, journalMuet, dep, racine)) });
  };

  beforeEach(async () => {
    horloge = T0;
    suivi.pbkdf2 = 0;
    suivi.delais.length = 0;
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    racine = mkdtempSync(join(tmpdir(), "elpis-racine-"));
    await monter();
  });

  afterEach(async () => {
    await app.close();
    await t.fermer();
    rmSync(racine, { recursive: true, force: true });
  });

  it.each([
    ["compte existant", "alice"],
    ["nom inconnu", "nobody"],
  ])("%s : échecs ralentis, puis 429 avec Retry-After, sans PBKDF2", async (_n, nom) => {
    await createUser(t.base, "alice", "bon-mot");
    suivi.pbkdf2 = 0;
    for (let i = 0; i < PAR_NOM_ET_ADRESSE.capacite; i++) {
      const r = await essai(nom, "faux");
      expect([r.statusCode, r.json()]).toEqual([401, { detail: "invalid credentials" }]);
    }
    expect(suivi.delais).toEqual([500, 1000, 2000, 2000, 2000, 2000]);
    expect(suivi.pbkdf2).toBe(PAR_NOM_ET_ADRESSE.capacite);
    const refus = await essai(nom, "faux");
    expect([refus.statusCode, refus.headers["retry-after"], refus.json()]).toEqual([
      429,
      "300",
      { detail: "Trop de tentatives de connexion : réessayez dans quelques minutes." },
    ]);
    expect(suivi.pbkdf2).toBe(PAR_NOM_ET_ADRESSE.capacite);
  });

  it("le bon mot de passe aussi attend la fin du blocage, puis un essai revient à chaque recharge", async () => {
    await createUser(t.base, "alice", "bon-mot");
    for (let i = 0; i < PAR_NOM_ET_ADRESSE.capacite; i++) await essai("alice", "faux");
    expect((await essai("alice", "bon-mot")).statusCode).toBe(429);
    horloge += 100;
    expect(Number((await essai("alice", "faux")).headers["retry-after"])).toBeOneOf([200, 201]);
    horloge += 200;
    expect((await essai("alice", "faux")).statusCode).toBe(401);
    expect((await essai("alice", "faux")).statusCode).toBe(429);
    horloge += 300;
    expect((await essai("alice", "bon-mot")).statusCode).toBe(200);
  });

  it("requêtes simultanées : comptées à l'arrivée, le surplus n'atteint jamais PBKDF2", async () => {
    const reponses = await Promise.all(Array.from({ length: 30 }, () => essai("nobody", "faux")));
    const statuts = reponses.map((r) => r.statusCode);
    expect(statuts.filter((s) => s === 401)).toHaveLength(PAR_NOM_ET_ADRESSE.capacite);
    expect(statuts.filter((s) => s === 429)).toHaveLength(30 - PAR_NOM_ET_ADRESSE.capacite);
    expect(suivi.pbkdf2).toBe(PAR_NOM_ET_ADRESSE.capacite);
  });

  it("pas de verrou de compte : une autre adresse entre, même compte, même pendant le blocage", async () => {
    await createUser(t.base, "admin", "bon-mot");
    for (let i = 0; i <= PAR_NOM_ET_ADRESSE.capacite; i++) await essai("admin", "faux", "10.0.0.66");
    expect((await essai("admin", "faux", "10.0.0.66")).statusCode).toBe(429);
    expect((await essai("admin", "bon-mot", "10.0.0.1")).statusCode).toBe(200);
  });

  it("adresse : X-Forwarded-For ignoré hors mandataire, celui de Caddy distingue les clients", async () => {
    for (let i = 0; i < PAR_NOM_ET_ADRESSE.capacite; i++)
      expect((await essai("nobody", "faux", "10.0.0.9", `192.0.2.${i}`)).statusCode).toBe(401);
    expect((await essai("nobody", "faux", "10.0.0.9", "192.0.2.200")).statusCode).toBe(429);
    for (let i = 0; i < PAR_NOM_ET_ADRESSE.capacite; i++)
      expect((await essai("nobody", "faux", "127.0.0.1", "10.0.0.7")).statusCode).toBe(401);
    expect((await essai("nobody", "faux", "127.0.0.1", "10.0.0.7")).statusCode).toBe(429);
    expect((await essai("nobody", "faux", "127.0.0.1", "10.0.0.8")).statusCode).toBe(401);
  });

  it("adresse : X-Forwarded-For invalide derrière Caddy, celle du mandataire, jamais le texte reçu", async () => {
    for (let i = 0; i < PAR_NOM_ET_ADRESSE.capacite; i++)
      expect((await essai("nobody", "faux", "127.0.0.1", `pas-une-ip-${i}`)).statusCode).toBe(401);
    expect((await essai("nobody", "faux", "127.0.0.1", "pas-une-ip-x")).statusCode).toBe(429);
    const ips = lignesAuditRecentes({ limit: 500 })
      .map((l) => (l as { ip?: string }).ip ?? "")
      .filter((ip) => ip.startsWith("pas-une-ip"));
    expect(ips).toEqual([]);
  });

  it("une réussite remet le couple à neuf", async () => {
    await createUser(t.base, "alice", "bon-mot");
    for (let i = 0; i < PAR_NOM_ET_ADRESSE.capacite - 1; i++) await essai("alice", "faux");
    expect((await essai("alice", "bon-mot")).statusCode).toBe(200);
    suivi.delais.length = 0;
    for (let i = 0; i < PAR_NOM_ET_ADRESSE.capacite; i++)
      expect((await essai("alice", "faux")).statusCode).toBe(401);
    expect(suivi.delais).toEqual([500, 1000, 2000, 2000, 2000, 2000]);
    expect((await essai("alice", "faux")).statusCode).toBe(429);
  });

  it("par adresse : plus large, tous noms confondus ; une autre adresse n'est pas touchée", async () => {
    for (let i = 0; i < PAR_ADRESSE.capacite; i++)
      expect((await essai(`nom${i}`, "faux")).statusCode).toBe(401);
    const refus = await essai("encore-un", "faux");
    expect([refus.statusCode, refus.headers["retry-after"]]).toEqual([429, "15"]);
    expect((await essai("encore-un", "faux", "10.0.0.6")).statusCode).toBe(401);
  });

  it("amorçage distant : mot de passe initial accepté après les échecs, reste refusé pendant le blocage", async () => {
    for (let i = 0; i < PAR_NOM_ET_ADRESSE.capacite; i++)
      expect((await essai("admin", "devine")).statusCode).toBe(401);
    const initial = readFileSync(join(racine, "user_db", ".bootstrap_admin"), "utf8").trim();
    expect((await essai("admin", initial)).statusCode).toBe(429);
    horloge += PAR_NOM_ET_ADRESSE.rechargeS;
    const ok = await essai("admin", initial);
    expect([ok.statusCode, ok.json()]).toEqual([
      200,
      { ok: true, is_admin: true, must_change_password: true },
    ]);
  });

  it("amorçage local : possible même si une autre adresse a épuisé ses essais", async () => {
    for (let i = 0; i <= PAR_NOM_ET_ADRESSE.capacite; i++) await essai("admin", "devine");
    const ok = await essai("admin", "choisi", "127.0.0.1");
    expect([ok.statusCode, ok.json()]).toEqual([
      200,
      { ok: true, is_admin: true, must_change_password: false },
    ]);
  });

  it("panne pendant la vérification : réessayer ne compte pas comme un échec", async () => {
    await createUser(t.base, "alice", "bon-mot");
    const panne = vi.spyOn(t.base, "get").mockRejectedValue(new Error("base indisponible"));
    for (let i = 0; i < PAR_NOM_ET_ADRESSE.capacite + 2; i++)
      expect((await essai("alice", "bon-mot")).statusCode).toBe(500);
    panne.mockRestore();
    expect((await essai("alice", "bon-mot")).statusCode).toBe(200);
    expect(suivi.delais).toEqual([]);
  });

  it("mot de passe non textuel : même statut pour un nom inconnu et un compte, sans essai compté", async () => {
    await createUser(t.base, "alice", "bon-mot");
    suivi.pbkdf2 = 0;
    for (let i = 0; i < PAR_NOM_ET_ADRESSE.capacite + 2; i++) {
      expect((await essai("alice", 5)).statusCode).toBe(500);
      expect((await essai("nobody", 5)).statusCode).toBe(500);
    }
    expect(suivi.pbkdf2).toBe(0);
    expect((await essai("alice", "bon-mot")).statusCode).toBe(200);
  });

  it("audit : une ligne quand la limite est atteinte, aucune par refus 429", async () => {
    const lignes = (): number =>
      lignesAuditRecentes({ limit: 500 }).filter(
        (l) => (l as { details?: { reason?: unknown } }).details?.reason === "rate_limited",
      ).length;
    const avant = lignes();
    for (let i = 0; i < PAR_NOM_ET_ADRESSE.capacite + 5; i++) await essai("nobody", "faux");
    expect(lignes() - avant).toBe(1);
  });
});

describe("DebitConnexion", () => {
  it("mémoire bornée : le plafond tient, les seaux redevenus pleins partent au ménage", () => {
    const d = new DebitConnexion();
    for (let i = 0; i < SEAUX_MAX + 500; i++) d.prendre(`n${i}`, `a${i}`, T0);
    expect(d.taille).toBe(2 * SEAUX_MAX);
    d.prendre("dernier", "ailleurs", T0 + PAR_NOM_ET_ADRESSE.capacite * PAR_NOM_ET_ADRESSE.rechargeS);
    expect(d.taille).toBe(2);
  });

  it("nom très long : la clé reste de taille fixe", () => {
    const d = new DebitConnexion();
    const essai = d.prendre("x".repeat(64 * 1024), "a", T0);
    expect(essai.cleNom.length).toBeLessThan(64);
  });

  it("réussite : l'adresse ne récupère que le jeton de cet essai", () => {
    const d = new DebitConnexion();
    let dernier = d.prendre("n0", "a", T0);
    for (let i = 1; i < PAR_ADRESSE.capacite; i++) dernier = d.prendre(`n${i}`, "a", T0);
    expect(d.attenteS("autre", "a", T0)).toBeGreaterThan(0);
    d.reussite(dernier, T0);
    expect(d.attenteS("autre", "a", T0)).toBe(0);
    d.prendre("autre", "a", T0);
    expect(d.attenteS("encore", "a", T0)).toBeGreaterThan(0);
  });

  it("annulation : les deux jetons reviennent", () => {
    const d = new DebitConnexion();
    for (let i = 0; i < 40; i++) d.annulation(d.prendre("n", "a", T0), T0);
    expect(d.attenteS("n", "a", T0)).toBe(0);
    expect(d.prendre("n", "a", T0).delaiMs).toBe(0);
  });
});
