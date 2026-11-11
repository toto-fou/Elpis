// SPDX-License-Identifier: MIT
/** apps/core/test/secrets/stockage.test.ts — coffre « Secrets » en base (SQLite, PostgreSQL si ELPIS_TEST_PG) : création et règles (slug, portées, valeur), nom unique par propriétaire, « vide = inchangé », rotation, renommage rechiffré (AAD), élargissement de portée, vérification, suppression, rechiffrement de clé, journal sans valeur. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import {
  chiffrerSecret,
  configurerCoffre,
  configureAudit,
  lireCleCoffre,
  oublierConfigurationAudit,
} from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rechiffrerCoffre, secretsParCle } from "../../src/secrets/cle";
import { ErreurSecret } from "../../src/secrets/erreurs";
import { aadSecret, hoteExact, normaliserPortee } from "../../src/secrets/portee";
import {
  COLONNES_SECRET,
  dechiffrerLigne,
  creerSecret,
  listerSecrets,
  modifierSecret,
  rotation,
  supprimerSecret,
  verifierSecret,
} from "../../src/secrets/stockage";
import type { Acteur, LigneSecret } from "../../src/secrets/stockage";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

let dossier: string;
let journal: string;

beforeEach(() => {
  journal = mkdtempSync(join(tmpdir(), "elpis-coffre-journal-"));
  configureAudit({ service: "main", auditDir: journal, hmacKeyPath: "/nonexistent" });
});

afterEach(() => {
  oublierConfigurationAudit();
  rmSync(journal, { recursive: true, force: true });
});

/** Lignes du journal de sécurité d'une action, dans l'ordre d'écriture. */
function lignes(action: string): Record<string, unknown>[] {
  return readdirSync(journal)
    .filter((n) => n.endsWith(".jsonl"))
    .flatMap((n) => readFileSync(join(journal, n), "utf8").split("\n"))
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l["action"] === action);
}

function journalComplet(): string {
  return readdirSync(journal)
    .map((n) => readFileSync(join(journal, n), "utf8"))
    .join("");
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ErreurSecret) return `${e.statut} ${e.code}`;
    throw e;
  }
  return "aucune erreur";
}

describe("règles d'un secret (sans base)", () => {
  it("portées normalisées : origines exactes WHATWG dédoublonnées, hôte git, connecteur, serveur, jeton", () => {
    expect(
      normaliserPortee("web-login", {
        origins: ["HTTPS://Intranet.Example.LAN:443", "https://intranet.example.lan/", "http://idp.lan:8080"],
      }),
    ).toEqual({ origins: ["https://intranet.example.lan", "http://idp.lan:8080"] });
    expect(normaliserPortee("http-auth", { origins: ["https://bücher.lan"] })).toEqual({
      origins: ["https://xn--bcher-kva.lan"],
    });
    expect(normaliserPortee("git", { host: " Git.Example.LAN:2222 " })).toEqual({
      host: "git.example.lan:2222",
    });
    expect(normaliserPortee("llm", { connector_id: 3 })).toEqual({ connector_id: 3 });
    expect(normaliserPortee("mcp", { server: "shared-4" })).toEqual({ server: "shared-4" });
    expect(normaliserPortee("token", undefined)).toEqual({});
    expect(hoteExact("[fe80::1]:22")).toBe("[fe80::1]:22");
    for (const [genre, portee] of [
      ["web-login", { origins: [] }],
      ["web-login", { origins: ["https://a.lan/login"] }],
      ["web-login", { origins: ["https://u:p@a.lan"] }],
      ["web-login", { origins: ["https://a.lan?x=1"] }],
      ["web-login", { origins: ["ftp://a.lan"] }],
      ["web-login", { origins: ["https://a.lan"], extra: 1 }],
      ["http-auth", { origins: Array.from({ length: 11 }, (_, i) => `https://h${i}.lan`) }],
      ["git", { host: "https://git.lan" }],
      ["git", { host: "git.lan:0" }],
      ["git", { host: "git.lan:70000" }],
      ["llm", { connector_id: 0 }],
      ["mcp", { server: "a b" }],
      ["token", { origins: ["https://a.lan"] }],
    ] as const)
      expect(() => normaliserPortee(genre, portee), JSON.stringify(portee)).toThrow(/Invalid scope/u);
  });

  it("AAD : propriétaire (0 pour l'instance), genre, nom et empreinte des colonnes liées, dont chacune compte", () => {
    const liees = {
      scope_json: '{"origins":["https://a.lan"]}',
      policy_json: '{"subagents":true,"routines":false,"confirm_first_use":false,"tls":"strict"}',
      state: "active",
      version: 1,
      username: "adm",
    };
    const aad = aadSecret(7, "web-login", "intranet", liees);
    expect(aad).toMatch(/^vault\|v2\|7\|web-login\|intranet\|[0-9a-f]{64}$/u);
    expect(aadSecret(null, "llm", "openai", liees)).toMatch(/^vault\|v2\|0\|llm\|openai\|/u);
    for (const autre of [
      { scope_json: '{"origins":["https://b.lan"]}' },
      { policy_json: liees.policy_json.replace("strict", "insecure") },
      { state: "unverified" },
      { version: 2 },
      { username: null },
      { username: "root" },
    ])
      expect(aadSecret(7, "web-login", "intranet", { ...liees, ...autre }), JSON.stringify(autre)).not.toBe(
        aad,
      );
  });
});

describe.each(MOTEURS)("coffre en base (%s)", (moteur) => {
  let t: BaseDeTest;
  let alice = 0;
  let bob = 0;
  let acteur: Acteur;

  beforeEach(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-coffre-cle-"));
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: join(dossier, "absente.key"),
      repli: join(dossier, ".vault.key"),
    });
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    const ajouter = (nom: string): Promise<number> =>
      t.base.insertId("INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES (?, '', '', 0)", [
        nom,
      ]);
    alice = await ajouter("alice");
    bob = await ajouter("bob");
    acteur = { userId: alice, username: "alice", ip: "10.0.0.5" };
  });

  afterEach(async () => {
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  const intranet = {
    name: "intranet-admin",
    kind: "web-login",
    scope: { origins: ["https://intranet.example.lan:8443"] },
    username: "admin",
    value: "Mot-de-passe-1!",
  };

  /** Ligne lue directement en base. */
  const brut = async (id: number): Promise<LigneSecret> =>
    (await t.base.get<LigneSecret & Record<string, unknown>>(
      `SELECT ${COLONNES_SECRET} FROM vault_secrets WHERE id = ?`,
      [id],
    )) as LigneSecret;
  /** Valeur claire d'une ligne, déchiffrée avec l'AAD de ses colonnes. */
  const clair = async (id: number): Promise<string> => dechiffrerLigne(await brut(id));

  it("création : métadonnées seules, politique par défaut, valeur chiffrée liée à son AAD ; journal sans valeur", async () => {
    const s = await creerSecret(t.base, alice, intranet, acteur);
    expect(s).toMatchObject({
      name: "intranet-admin",
      kind: "web-login",
      owner: "user",
      scope: { origins: ["https://intranet.example.lan:8443"] },
      username: "admin",
      state: "active",
      version: 1,
      policy: { subagents: true, routines: false, confirm_first_use: false, tls: "strict" },
      key_current: true,
      use_count: 0,
      last_used_at: null,
      rotated_at: null,
    });
    expect(JSON.stringify(s)).not.toContain("Mot-de-passe");
    expect(Object.keys(s)).not.toContain("secret_enc");
    const b = await brut(s.id);
    expect(b.secret_enc).toMatch(/^v1\.[0-9a-f]{8}\./u);
    expect(await clair(s.id)).toBe("Mot-de-passe-1!");
    expect(() => dechiffrerLigne({ ...b, user_id: bob })).toThrow(ErreurSecret);
    expect(lignes("vault.secret.created").at(-1)).toMatchObject({
      user_id: alice,
      ip: "10.0.0.5",
      details: { secret_id: s.id, name: "intranet-admin", kind: "web-login", owner: "user" },
    });
    expect(journalComplet()).not.toContain("Mot-de-passe");
    expect(journalComplet()).not.toContain(b.secret_enc);
  });

  it("refus de création : nom, genre, portée, valeur, métadonnées ; nom unique par propriétaire", async () => {
    expect(await code(creerSecret(t.base, alice, { ...intranet, name: "Intranet" }, acteur))).toBe(
      "422 secret_name_invalid",
    );
    expect(await code(creerSecret(t.base, alice, { ...intranet, name: "a".repeat(49) }, acteur))).toBe(
      "422 secret_name_invalid",
    );
    expect(await code(creerSecret(t.base, alice, { ...intranet, kind: "totp" }, acteur))).toBe(
      "422 secret_request_invalid",
    );
    expect(await code(creerSecret(t.base, alice, { ...intranet, scope: { host: "a.lan" } }, acteur))).toBe(
      "422 secret_scope_invalid",
    );
    expect(await code(creerSecret(t.base, alice, { ...intranet, value: "" }, acteur))).toBe(
      "422 secret_value_required",
    );
    expect(await code(creerSecret(t.base, alice, { ...intranet, value: "x".repeat(16_385) }, acteur))).toBe(
      "422 secret_value_invalid",
    );
    expect(
      await code(creerSecret(t.base, alice, { ...intranet, meta: { a: "x".repeat(5000) } }, acteur)),
    ).toBe("422 secret_meta_invalid");
    await creerSecret(t.base, alice, intranet, acteur);
    expect(await code(creerSecret(t.base, alice, intranet, acteur))).toBe("409 secret_name_taken");
    await creerSecret(t.base, bob, intranet, { userId: bob, username: "bob" });
    await creerSecret(t.base, null, { ...intranet, kind: "llm", scope: { connector_id: 2 } }, acteur);
    expect(await code(creerSecret(t.base, null, { ...intranet, kind: "token", scope: {} }, acteur))).toBe(
      "409 secret_name_taken",
    );
    expect((await listerSecrets(t.base, alice)).map((s) => s.name)).toEqual(["intranet-admin"]);
    expect((await listerSecrets(t.base, null)).map((s) => [s.owner, s.kind])).toEqual([["instance", "llm"]]);
  });

  it("modification : valeur vide inchangée, nouvelle valeur = version n+1 ; identifiant ou nom changés rechiffrent ; métadonnées seules, non", async () => {
    const s = await creerSecret(t.base, alice, intranet, acteur);
    const encAvant = (await brut(s.id)).secret_enc;
    const m1 = await modifierSecret(t.base, alice, s.id, { value: "", username: "root" }, acteur);
    expect(m1).toMatchObject({ version: 1, username: "root", rotated_at: null });
    expect((await brut(s.id)).secret_enc).not.toBe(encAvant);
    expect(await clair(s.id)).toBe("Mot-de-passe-1!");
    const avantMeta = (await brut(s.id)).secret_enc;
    await modifierSecret(t.base, alice, s.id, { meta: { note: "x" } }, acteur);
    expect((await brut(s.id)).secret_enc).toBe(avantMeta);
    const m2 = await modifierSecret(t.base, alice, s.id, { name: "intranet-root" }, acteur);
    expect(m2).toMatchObject({ name: "intranet-root", version: 1 });
    expect((await brut(s.id)).secret_enc).not.toBe(avantMeta);
    expect(await clair(s.id)).toBe("Mot-de-passe-1!");
    const m3 = await modifierSecret(t.base, alice, s.id, { value: "Nouveau-2!", username: null }, acteur);
    expect(m3).toMatchObject({ version: 2, username: null });
    expect(m3.rotated_at).not.toBeNull();
    expect(await clair(s.id)).toBe("Nouveau-2!");
    expect(lignes("vault.secret.updated").map((l) => (l["details"] as { fields: string[] }).fields)).toEqual([
      ["username"],
      ["meta"],
      ["name"],
      ["username", "value"],
    ]);
    const autre = await creerSecret(t.base, alice, { ...intranet, name: "autre" }, acteur);
    expect(await code(modifierSecret(t.base, alice, autre.id, { name: "intranet-root" }, acteur))).toBe(
      "409 secret_name_taken",
    );
    expect(await code(modifierSecret(t.base, bob, s.id, { username: "x" }, acteur))).toBe(
      "404 secret_unknown",
    );
    expect(journalComplet()).not.toContain("Nouveau-2!");
  });

  it("élargir la portée ou passer en TLS non vérifié exige la valeur ; la restreindre, non", async () => {
    const s = await creerSecret(
      t.base,
      alice,
      { ...intranet, scope: { origins: ["https://app.lan", "https://idp.lan"] } },
      acteur,
    );
    expect(
      await code(
        modifierSecret(
          t.base,
          alice,
          s.id,
          { scope: { origins: ["https://app.lan", "https://evil.lan"] } },
          acteur,
        ),
      ),
    ).toBe("422 secret_value_required");
    expect(await code(modifierSecret(t.base, alice, s.id, { policy: { tls: "insecure" } }, acteur))).toBe(
      "422 secret_value_required",
    );
    const reduit = await modifierSecret(
      t.base,
      alice,
      s.id,
      { scope: { origins: ["https://app.lan"] } },
      acteur,
    );
    expect(reduit.scope).toEqual({ origins: ["https://app.lan"] });
    const large = await modifierSecret(
      t.base,
      alice,
      s.id,
      {
        scope: { origins: ["https://app.lan", "https://new.lan"] },
        policy: { tls: "insecure" },
        value: "v2",
      },
      acteur,
    );
    expect(large).toMatchObject({ version: 2, policy: { tls: "insecure", subagents: true } });
    expect(lignes("vault.secret.updated").at(-1)?.["details"]).toMatchObject({
      fields: ["scope", "policy", "value"],
      scope: { origins: ["https://app.lan", "https://new.lan"] },
      tls: "insecure",
    });
    const policeSeule = await modifierSecret(t.base, alice, s.id, { policy: { subagents: false } }, acteur);
    expect(policeSeule.policy).toEqual({
      subagents: false,
      routines: false,
      confirm_first_use: false,
      tls: "insecure",
    });
    const git = await creerSecret(
      t.base,
      alice,
      { ...intranet, name: "git", kind: "git", scope: { host: "git.lan" } },
      acteur,
    );
    expect(
      await code(modifierSecret(t.base, alice, git.id, { scope: { host: "git.evil.lan" } }, acteur)),
    ).toBe("422 secret_value_required");
  });

  it("rotation, vérification, suppression ; secrets d'instance à part ; journal de chaque action", async () => {
    const s = await creerSecret(t.base, alice, { ...intranet, state: "unverified" }, acteur);
    expect(s.state).toBe("unverified");
    const r = await rotation(t.base, alice, s.id, "Tourne-3!", acteur);
    expect(r.version).toBe(2);
    expect(r.rotated_at).not.toBeNull();
    expect(await code(rotation(t.base, alice, s.id, "", acteur))).toBe("422 secret_value_required");
    expect((await verifierSecret(t.base, alice, s.id, acteur)).state).toBe("active");
    await verifierSecret(t.base, alice, s.id, acteur);
    expect(lignes("vault.secret.verified")).toHaveLength(1);
    expect(lignes("vault.secret.rotated").at(-1)?.["details"]).toMatchObject({ secret_id: s.id, version: 2 });
    const inst = await creerSecret(
      t.base,
      null,
      { ...intranet, kind: "mcp", scope: { server: "shared-1" } },
      acteur,
    );
    expect(await code(rotation(t.base, alice, inst.id, "x", acteur))).toBe("404 secret_unknown");
    expect(await code(supprimerSecret(t.base, null, s.id, acteur))).toBe("404 secret_unknown");
    await supprimerSecret(t.base, null, inst.id, acteur);
    await supprimerSecret(t.base, alice, s.id, acteur);
    expect(await listerSecrets(t.base, alice)).toEqual([]);
    expect(lignes("vault.secret.deleted").map((l) => (l["details"] as { owner: string }).owner)).toEqual([
      "instance",
      "user",
    ]);
  });

  it("chiffré déplacé sur une autre ligne : indéchiffrable (AAD), renommage refusé sans nouvelle valeur", async () => {
    const a = await creerSecret(t.base, alice, intranet, acteur);
    const b = await creerSecret(t.base, alice, { ...intranet, name: "b" }, acteur);
    await t.base.run("UPDATE vault_secrets SET secret_enc = ? WHERE id = ?", [
      (await brut(a.id)).secret_enc,
      b.id,
    ]);
    expect(await code(modifierSecret(t.base, alice, b.id, { name: "b2" }, acteur))).toBe(
      "409 secret_undecryptable",
    );
    expect((await modifierSecret(t.base, alice, b.id, { name: "b2", value: "neuve" }, acteur)).name).toBe(
      "b2",
    );
  });

  it("clé changée : key_current faux ; rekey rechiffre les secrets de l'ancienne clé, sans toucher aux autres", async () => {
    const ancienne = join(dossier, "ancienne.key");
    const octets = randomBytes(32);
    writeFileSync(ancienne, `${octets.toString("base64")}\n`);
    configurerCoffre({
      cleEnv: octets.toString("base64"),
      systeme: join(dossier, "x"),
      repli: join(dossier, "r"),
    });
    const s = await creerSecret(t.base, alice, intranet, acteur);
    await creerSecret(t.base, null, { ...intranet, kind: "token", scope: {} }, acteur);
    const tierce = lireCleCoffre(ancienne);
    const nouvelle = randomBytes(32);
    configurerCoffre({
      cleEnv: nouvelle.toString("base64"),
      systeme: join(dossier, "x"),
      repli: join(dossier, "r"),
    });
    expect((await listerSecrets(t.base, alice))[0]?.key_current).toBe(false);
    const etranger = await t.base.insertId(
      "INSERT INTO vault_secrets (user_id, kind, name, scope_json, secret_enc, kid, created_at, updated_at) VALUES (?, 'token', 'etranger', '{}', ?, 'ffffffff', 0, 0)",
      [bob, "v1.ffffffff.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA"],
    );
    writeFileSync(join(dossier, "nouvelle.key"), nouvelle.toString("hex"));
    const courante = lireCleCoffre(join(dossier, "nouvelle.key"));
    const rapport = await rechiffrerCoffre(t.base, tierce, courante);
    expect(rapport).toEqual({ rechiffres: 2, echecs: 0, restants: 1 });
    expect((await listerSecrets(t.base, alice))[0]?.key_current).toBe(true);
    expect(await clair(s.id)).toBe("Mot-de-passe-1!");
    expect((await brut(etranger)).kid).toBe("ffffffff");
    const c = await secretsParCle(t.base);
    expect([c.total, c.instance, c.parKid.get(courante.kid), c.parKid.get("ffffffff")]).toEqual([3, 1, 2, 1]);
    expect(chiffrerSecret("x", "a", courante)).toMatch(new RegExp(`^v1\\.${courante.kid}\\.`, "u"));
  });

  it("200 secrets au plus par propriétaire ; compte supprimé : ses secrets partent avec lui (clé étrangère)", async () => {
    for (let i = 0; i < 200; i++)
      await t.base.run(
        "INSERT INTO vault_secrets (user_id, kind, name, scope_json, secret_enc, kid, created_at, updated_at) VALUES (?, 'token', ?, '{}', 'x', 'k', 0, 0)",
        [bob, `n${i}`],
      );
    expect(await code(creerSecret(t.base, bob, { ...intranet, name: "un-de-trop" }, acteur))).toBe(
      "409 secret_limit",
    );
    await creerSecret(t.base, alice, intranet, acteur);
    await t.base.run("DELETE FROM users WHERE id = ?", [bob]);
    expect(Number((await t.base.get<{ n: number }>("SELECT COUNT(*) AS n FROM vault_secrets"))?.n)).toBe(1);
  });

  it("colonnes liées écrites hors du module (portée, politique, état, version, identifiant, nom, compte, genre) : indéchiffrable", async () => {
    const s = await creerSecret(t.base, alice, { ...intranet, state: "unverified" }, acteur);
    const avant = await brut(s.id);
    const ecarts: [string, string, unknown][] = [
      [
        "scope_json",
        "scope_json = ?",
        '{"origins":["https://intranet.example.lan:8443","https://evil.lan"]}',
      ],
      ["policy_json", "policy_json = ?", avant.policy_json.replace('"strict"', '"insecure"')],
      ["policy_json", "policy_json = ?", avant.policy_json.replace('"subagents":true', '"subagents":false')],
      ["state", "state = ?", "active"],
      ["version", "version = ?", 2],
      ["username", "username = ?", "root"],
      ["name", "name = ?", "autre-nom"],
      ["user_id", "user_id = ?", bob],
      ["kind", "kind = ?", "http-auth"],
    ];
    for (const [nom, set, valeur] of ecarts) {
      await t.base.run(`UPDATE vault_secrets SET ${set} WHERE id = ?`, [valeur as string, s.id]);
      expect(await code(clair(s.id)), nom).toBe("409 secret_undecryptable");
      await t.base.run(
        "UPDATE vault_secrets SET scope_json = ?, policy_json = ?, state = ?, version = ?, username = ?, name = ?, user_id = ?, kind = ? WHERE id = ?",
        [
          avant.scope_json,
          avant.policy_json,
          avant.state,
          avant.version,
          avant.username,
          avant.name,
          avant.user_id,
          avant.kind,
          s.id,
        ],
      );
      expect(await clair(s.id), nom).toBe("Mot-de-passe-1!");
    }
  });

  it("écritures du module (vérification, politique, portée réduite, rotation) : toujours lisible ; un ancien chiffré restauré ne l'est plus", async () => {
    const s = await creerSecret(t.base, alice, { ...intranet, state: "unverified" }, acteur);
    const v1 = (await brut(s.id)).secret_enc;
    expect((await verifierSecret(t.base, alice, s.id, acteur)).state).toBe("active");
    expect(await clair(s.id)).toBe("Mot-de-passe-1!");
    await t.base.run("UPDATE vault_secrets SET secret_enc = ? WHERE id = ?", [v1, s.id]);
    expect(await code(clair(s.id))).toBe("409 secret_undecryptable");
    await rotation(t.base, alice, s.id, "Tourne-2!", acteur);
    const v2 = (await brut(s.id)).secret_enc;
    await modifierSecret(t.base, alice, s.id, { policy: { subagents: false } }, acteur);
    expect(await clair(s.id)).toBe("Tourne-2!");
    await rotation(t.base, alice, s.id, "Tourne-3!", acteur);
    await t.base.run("UPDATE vault_secrets SET secret_enc = ? WHERE id = ?", [v2, s.id]);
    expect(await code(clair(s.id))).toBe("409 secret_undecryptable");
    expect(await code(verifierSecret(t.base, alice, s.id, acteur))).toBe("aucune erreur");
    await rotation(t.base, alice, s.id, "Tourne-4!", acteur);
    const large = await creerSecret(
      t.base,
      alice,
      { ...intranet, name: "large", scope: { origins: ["https://a.lan", "https://b.lan"] } },
      acteur,
    );
    const avantReduction = (await brut(large.id)).secret_enc;
    await modifierSecret(t.base, alice, large.id, { scope: { origins: ["https://a.lan"] } }, acteur);
    expect(await clair(large.id)).toBe("Mot-de-passe-1!");
    await t.base.run("UPDATE vault_secrets SET secret_enc = ? WHERE id = ?", [avantReduction, large.id]);
    expect(await code(clair(large.id))).toBe("409 secret_undecryptable");
    expect(await code(modifierSecret(t.base, alice, large.id, { name: "large-2" }, acteur))).toBe(
      "409 secret_undecryptable",
    );
    const importe = await creerSecret(
      t.base,
      alice,
      { ...intranet, name: "importe", state: "unverified" },
      acteur,
    );
    await t.base.run("UPDATE vault_secrets SET username = 'autre' WHERE id = ?", [importe.id]);
    expect(await code(verifierSecret(t.base, alice, importe.id, acteur))).toBe("409 secret_undecryptable");
  });

  it("clé perdue alors que des secrets existent : aucune clé de repli posée, refus 503 ; coffre vide : repli posé", async () => {
    const repli = join(dossier, "repli", ".vault.key");
    configurerCoffre({ systeme: join(dossier, "absente.key"), repli });
    await creerSecret(t.base, alice, intranet, acteur);
    expect(readFileSync(repli, "latin1")).toMatch(/^[A-Za-z0-9+/]{43}=\n$/u);
    rmSync(repli);
    configurerCoffre({ systeme: join(dossier, "absente.key"), repli });
    const s2 = { ...intranet, name: "deuxieme" };
    expect(await code(creerSecret(t.base, alice, s2, acteur))).toBe("503 secret_key_unavailable");
    expect(await code(rotation(t.base, alice, 1, "x", acteur))).toMatch(
      /^(503 secret_key_unavailable|404 secret_unknown)$/u,
    );
    expect(readdirSync(join(dossier, "repli")).filter((n) => n === ".vault.key")).toEqual([]);
    await t.base.run("DELETE FROM vault_secrets");
    expect((await creerSecret(t.base, alice, s2, acteur)).key_current).toBe(true);
    expect(readdirSync(join(dossier, "repli"))).toContain(".vault.key");
  });

  it("confirm_first_use n'est pas encore appliqué : demandé à la création ou à la modification, refusé", async () => {
    expect(
      await code(creerSecret(t.base, alice, { ...intranet, policy: { confirm_first_use: true } }, acteur)),
    ).toBe("422 secret_meta_invalid");
    const s = await creerSecret(t.base, alice, { ...intranet, policy: { confirm_first_use: false } }, acteur);
    expect(
      await code(modifierSecret(t.base, alice, s.id, { policy: { confirm_first_use: true } }, acteur)),
    ).toBe("422 secret_meta_invalid");
  });
});
