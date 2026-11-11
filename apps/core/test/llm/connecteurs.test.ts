// SPDX-License-Identifier: MIT
/** apps/core/test/llm/connecteurs.test.ts — connecteurs LLM : vecteurs Python (presets, liste blanche, vues sans clé, champs de création, cloud fermé par défaut aux comptes non admin ; clés dans le coffre) et magasin en base, SQLite et PostgreSQL. */
import "./environnement-fournisseurs";

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ErreurCle, ErreurPython, HttpError } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerChiffrement, configurerCoffre } from "@elpis/securite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  allowedProviderTypes,
  bumpLastUsed,
  champsDeCreation,
  champsDeLimites,
  cloudProviderTypes,
  compteAdmin,
  connectorIdsByWire,
  createConnector,
  deleteSharedConnector,
  deleteUserConnector,
  getMeta,
  getSecretForUser,
  getSharedSecret,
  getUserSecret,
  limitsOf,
  listSharedConnectors,
  listUserConnectors,
  nettoyer,
  portConnecteurs,
  posOrNone,
  presetsPublics,
  PROVIDER_PRESETS,
  PROVIDER_TYPES,
  typesOuverts,
  updateSharedConnector,
  updateUserConnector,
  vueAvecCle,
  vuePublique,
} from "../../src/llm/connecteurs";
import { EngineUnavailable, resolveLlmTarget } from "../../src/llm/cible";
import { installerConnecteurs } from "../../src/llm/ports";
import { ErreurSecret } from "../../src/secrets/erreurs";
import { listerSecrets } from "../../src/secrets/stockage";
import { lireVecteurs } from "../vecteurs-moteur";

type Dict = Record<string, unknown>;
type Issue = { valeur: unknown } | { erreur: string } | { http: [number, unknown] };

const V = lireVecteurs<{
  provider_types: string[];
  presets: Dict;
  presets_publics: Dict;
  cloud: string[];
  autorises: ({ config: unknown } & Issue)[];
  pos_or_none: ({ entree: unknown } & Issue)[];
  limits_of: ({ ligne: Dict } & Issue)[];
  publiques: ({ ligne: Dict } & Issue)[];
  avec_cle: ({ ligne: Dict } & Issue)[];
  nettoyages: ({ entree: unknown; n: number } & Issue)[];
  creations: ({ corps: unknown; admin: boolean; liste: unknown } & Issue)[];
  limites_admin: ({ corps: unknown } & Issue)[];
}>("llm-connecteurs");

/** Issue d'un appel : valeur, classe d'erreur Python, ou statut et détail HTTP. */
function issue(f: () => unknown): Issue {
  try {
    return { valeur: f() };
  } catch (e) {
    if (e instanceof HttpError) return { http: [e.statusCode, e.detail] };
    if (e instanceof ErreurPython) return { erreur: e.type };
    if (e instanceof ErreurCle) return { erreur: "KeyError" };
    throw e;
  }
}

function attendu(c: Issue): Issue {
  if ("valeur" in c) return { valeur: c.valeur };
  if ("http" in c) return { http: c.http };
  return { erreur: c.erreur };
}

const REFUS_TYPE: Issue = { http: [403, "Ce fournisseur n'est pas autorisé pour les utilisateurs"] };

/** Écart voulu (0.1.0) : liste absente, vide ou invalide = aucun type cloud ouvert aux comptes non admin (le Python les ouvrait tous). */
function attenduCloudFerme(c: Issue): Issue {
  return "valeur" in c && JSON.stringify(c.valeur) === JSON.stringify(V.cloud) ? { valeur: [] } : attendu(c);
}

/** Écart voulu (coffre) : une ligne sans secret du coffre n'a pas de clé utilisable ; une ancienne `api_key_enc` est signalée (`key_error`), jamais lue. */
function attenduCoffre(c: { ligne: Dict } & Issue, avecCle: boolean): Issue {
  if (!("valeur" in c)) return attendu(c);
  const erreur = c.ligne["api_key_enc"] ? "legacy_pending" : null;
  const out: Dict = {};
  for (const [k, v] of Object.entries(c.valeur as Dict)) {
    out[k] = k === "has_key" ? false : k === "api_key" ? "" : v;
    if (k === (avecCle ? "api_key" : "has_key")) out["key_error"] = erreur;
  }
  return { valeur: out };
}

/** Même écart à la création : un compte non admin sans liste explicite reçoit le refus de type au lieu du connecteur. */
function attenduCreation(c: { admin: boolean; liste: unknown } & Issue): Issue {
  const sansListe = !Array.isArray(c.liste) || c.liste.length === 0;
  return !c.admin && sansListe && "valeur" in c ? REFUS_TYPE : attendu(c);
}

describe("vecteurs Python", () => {
  it("presets et types : mêmes valeurs, même ordre", () => {
    expect([...PROVIDER_TYPES]).toEqual(V.provider_types);
    expect(Object.keys(PROVIDER_PRESETS)).toEqual(Object.keys(V.presets));
    expect(PROVIDER_PRESETS).toEqual(V.presets);
    expect(presetsPublics()).toEqual(V.presets_publics);
    expect(cloudProviderTypes()).toEqual(V.cloud);
  });

  it.each(V.autorises.map((c, i) => [i, c] as const))("allowed_provider_types %i", (_i, c) => {
    expect(
      issue(() => allowedProviderTypes(c.config)),
      JSON.stringify(c.config),
    ).toEqual(attenduCloudFerme(c));
  });

  it("types ouverts : tous les cloud pour un administrateur, la liste blanche pour les autres", () => {
    const liste = { llm: { allowed_provider_types: ["mistral"] } };
    expect(typesOuverts(true, {})).toEqual(V.cloud);
    expect(typesOuverts(true, liste)).toEqual(V.cloud);
    expect(typesOuverts(false, {})).toEqual([]);
    expect(typesOuverts(false, liste)).toEqual(["mistral"]);
  });

  it("_pos_or_none et _limits_of", () => {
    for (const c of V.pos_or_none)
      expect(
        issue(() => posOrNone(c.entree)),
        JSON.stringify(c),
      ).toEqual(attendu(c));
    for (const c of V.limits_of)
      expect(
        issue(() => limitsOf(c.ligne)),
        JSON.stringify(c),
      ).toEqual(attendu(c));
  });

  it("vues publique (sans clé) et avec clé : mêmes champs, même ordre, `key_error` en plus", () => {
    for (const c of V.publiques) {
      const r = issue(() => vuePublique(c.ligne));
      const a = attenduCoffre(c, false);
      expect(r).toEqual(a);
      if ("valeur" in r)
        expect(Object.keys(r.valeur as Dict)).toEqual(Object.keys((a as { valeur: Dict }).valeur));
      expect(JSON.stringify(r)).not.toContain('"api_key"');
    }
    for (const c of V.avec_cle) {
      const r = issue(() => vueAvecCle(c.ligne));
      const a = attenduCoffre(c, true);
      expect(r).toEqual(a);
      if ("valeur" in r)
        expect(Object.keys(r.valeur as Dict)).toEqual(Object.keys((a as { valeur: Dict }).valeur));
    }
  });

  it("_clean", () => {
    for (const c of V.nettoyages)
      expect(
        issue(() => nettoyer(c.entree, c.n)),
        JSON.stringify(c).slice(0, 80),
      ).toEqual(attendu(c));
  });

  it.each(V.creations.map((c, i) => [i, c] as const))("_resolve_create_fields %i", (_i, c) => {
    const config = c.liste === null ? {} : { llm: { allowed_provider_types: c.liste } };
    const r = issue(() => champsDeCreation(c.corps, c.admin, () => allowedProviderTypes(config)));
    expect(r, JSON.stringify(c.corps).slice(0, 120)).toEqual(attenduCreation(c));
  });

  it("_limit_fields", () => {
    for (const c of V.limites_admin)
      expect(
        issue(() => champsDeLimites(c.corps)),
        JSON.stringify(c.corps),
      ).toEqual(attendu(c));
  });
});

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
let dossierCle: string;

/** Clé du coffre des essais, ou chemin absent pour un coffre indisponible. */
function coffre(indisponible = false): void {
  configurerCoffre(
    indisponible
      ? { fichier: path.join(dossierCle, "absente", "vault.key"), repli: path.join(dossierCle, ".vault.key") }
      : {
          cleEnv: randomBytes(32).toString("base64"),
          systeme: path.join(dossierCle, "absente.key"),
          repli: path.join(dossierCle, ".vault.key"),
        },
  );
}

beforeAll(() => {
  dossierCle = mkdtempSync(path.join(tmpdir(), "elpis-cle-connecteurs-"));
  configurerChiffrement({ cleEnv: "unit-test-master-key", fichierCle: path.join(dossierCle, ".k") });
  coffre();
});

afterAll(() => {
  rmSync(dossierCle, { recursive: true, force: true });
});

describe.each(MOTEURS)("magasin des connecteurs (%s)", (moteur) => {
  let t: BaseDeTest;

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    for (const [id, nom] of [
      [1, "alice"],
      [2, "bob"],
    ] as const)
      await t.base.run(
        "INSERT INTO users(id, username, pass_salt, pass_hash, created_at, is_admin) VALUES (?,?,?,?,?,?)",
        [id, nom, "s", "h", 1, 0],
      );
  });

  afterEach(async () => {
    await t.fermer();
  });

  const perso = (base = t.base, proprietaire = 1) =>
    createConnector(base, {
      scope: "user",
      owner_user_id: proprietaire,
      provider_type: "anthropic",
      wire: "anthropic",
      base_url: "https://api.anthropic.com",
      api_key: "sk-ant-SECRET",
      label: "claude",
    });

  it("clé dans le coffre, jamais dans la vue publique ni en clair en base, déchiffrée côté serveur", async () => {
    const cid = await perso();
    const pub = (await listUserConnectors(t.base, 1))[0] as Dict;
    expect([pub["has_key"], pub["key_error"]]).toEqual([true, null]);
    expect(Object.keys(pub)).not.toContain("api_key");
    expect(Object.keys(pub)).not.toContain("api_key_enc");
    const brut = (await t.base.get(
      "SELECT api_key_enc, key_scheme, secret_id FROM llm_connectors WHERE id=?",
      [cid],
    )) as Dict;
    expect([brut["key_scheme"], brut["api_key_enc"]]).toEqual(["vault", ""]);
    expect((await listerSecrets(t.base, 1)).map((s) => [s.id, s.kind, s.scope])).toEqual([
      [Number(brut["secret_id"]), "llm", { connector_id: cid }],
    ]);
    expect(JSON.stringify(await t.base.all("SELECT * FROM vault_secrets"))).not.toContain("sk-ant-SECRET");
    expect((await getSecretForUser(t.base, 1, cid))?.["api_key"]).toBe("sk-ant-SECRET");
  });

  it("CRUD et IDOR : chacun ses connecteurs perso, les partagés pour tous", async () => {
    const cid = await createConnector(t.base, {
      scope: "user",
      owner_user_id: 1,
      provider_type: "openai",
      wire: "openai",
      base_url: "https://api.openai.com/v1",
      api_key: "k",
      label: "gpt",
    });
    const sid = await createConnector(t.base, {
      scope: "shared",
      provider_type: "vllm",
      wire: "openai",
      base_url: "http://x:8000/v1",
      label: "vLLM",
    });
    expect((await listUserConnectors(t.base, 1)).map((c) => c["id"])).toEqual([cid]);
    expect(await listUserConnectors(t.base, 2)).toEqual([]);
    expect((await listSharedConnectors(t.base)).map((c) => c["id"])).toEqual([sid]);
    expect(await getUserSecret(t.base, 2, cid)).toBeNull();
    expect(await updateUserConnector(t.base, 2, cid, { label: "hax" })).toBe(false);
    expect(await deleteUserConnector(t.base, 2, cid)).toBe(false);
    expect(await getSecretForUser(t.base, 2, cid)).toBeNull();
    expect(await getSecretForUser(t.base, 2, sid)).not.toBeNull();
    expect(await updateUserConnector(t.base, 1, cid, { label: "renamed" })).toBe(true);
    expect((await getSecretForUser(t.base, 1, cid))?.["api_key"]).toBe("k");
    expect((await listUserConnectors(t.base, 1)).map((c) => c["label"])).toEqual(["renamed"]);
    expect(await updateUserConnector(t.base, 1, cid, {})).toBe(false);
    expect(await updateUserConnector(t.base, 1, cid, { label: null, enabled: null })).toBe(false);
    expect(await updateSharedConnector(t.base, cid, { label: "x" })).toBe(false);
    expect(await getSharedSecret(t.base, cid)).toBeNull();
    const partage = (await getSharedSecret(t.base, sid)) as Dict;
    expect([partage["id"], partage["api_key"], Object.hasOwn(partage, "has_key")]).toEqual([sid, "", false]);
    expect(await deleteSharedConnector(t.base, cid)).toBe(false);
    expect(await deleteUserConnector(t.base, 1, cid)).toBe(true);
    expect(await deleteSharedConnector(t.base, sid)).toBe(true);
  });

  it("mise à jour : nouvelle clé rechiffrée, désactivation, limites présentes écrites (vide = NULL), date", async () => {
    const sid = await createConnector(t.base, {
      scope: "shared",
      provider_type: "llamacpp",
      wire: "openai",
      base_url: "http://l",
      max_models: 3,
      context_window: "0",
      max_concurrency: "x",
    });
    let meta = (await getMeta(t.base, sid)) as Dict;
    expect([meta["max_models"], meta["context_window"], meta["max_concurrency"], meta["enabled"]]).toEqual([
      3,
      null,
      null,
      true,
    ]);
    const avant = meta["updated_at"] as number;
    await new Promise((ok) => setTimeout(ok, 5));
    expect(
      await updateSharedConnector(t.base, sid, {
        enabled: false,
        api_key: "nouvelle",
        max_models: "",
        context_window: 65536,
      }),
    ).toBe(true);
    meta = (await getMeta(t.base, sid)) as Dict;
    expect([meta["max_models"], meta["context_window"], meta["enabled"], meta["has_key"]]).toEqual([
      null,
      65536,
      false,
      true,
    ]);
    expect(meta["updated_at"] as number).toBeGreaterThan(avant);
    expect((await getSharedSecret(t.base, sid))?.["api_key"]).toBe("nouvelle");
    expect(await getMeta(t.base, 999)).toBeNull();
  });

  it("listes triées par libellé puis id ; identifiants par dialecte", async () => {
    for (const [label, wire] of [
      ["b", "openai"],
      ["a", "anthropic"],
      ["b", "openai"],
    ] as const)
      await createConnector(t.base, {
        scope: "shared",
        provider_type: "generic",
        wire,
        base_url: "http://g",
        label,
      });
    expect((await listSharedConnectors(t.base)).map((c) => [c["label"], c["id"]])).toEqual([
      ["a", 2],
      ["b", 1],
      ["b", 3],
    ]);
    expect(await connectorIdsByWire(t.base, "openai")).toEqual([1, 3]);
    expect(await connectorIdsByWire(t.base, "anthropic")).toEqual([2]);
  });

  it("dernier usage posé au mieux ; port du moteur branché sur la base", async () => {
    const cid = await perso();
    await bumpLastUsed(t.base, cid);
    expect((await getMeta(t.base, cid))?.["last_used"]).toBeTypeOf("number");
    const port = portConnecteurs(t.base);
    expect((await port.getSecretForUser(1, cid))?.api_key).toBe("sk-ant-SECRET");
    expect(await port.getSecretForUser(2, cid)).toBeNull();
    expect(await port.getMeta(cid)).toMatchObject({ id: cid, has_key: true, context_window: null });
    expect(await port.allowedProviderTypes(1)).toEqual([]);
    await t.base.exec("DROP TABLE llm_connectors");
    await expect(bumpLastUsed(t.base, cid)).resolves.toBeUndefined();
  });

  it("cloud fermé par défaut : connecteur perso d'un compte non admin refusé à la résolution, celui d'un administrateur servi", async () => {
    await t.base.run("UPDATE users SET is_admin=? WHERE id=?", [1, 2]);
    await t.base.run(
      "INSERT INTO users(id, username, pass_salt, pass_hash, created_at, is_admin) VALUES (?,?,?,?,?,?)",
      [3, "carole", "s", "h", 1, 2],
    );
    expect([
      await compteAdmin(t.base, 1),
      await compteAdmin(t.base, 2),
      await compteAdmin(t.base, 3),
    ]).toEqual([false, true, false]);
    const port = portConnecteurs(t.base);
    expect([await port.allowedProviderTypes(1), await port.allowedProviderTypes(3)]).toEqual([[], []]);
    expect(await port.allowedProviderTypes(2)).toEqual(cloudProviderTypes());
    const deAlice = await perso();
    const deBob = await perso(t.base, 2);
    installerConnecteurs(port);
    try {
      const refus = await resolveLlmTarget(1, deAlice, null, { strict: true }).catch((e: unknown) => e);
      expect(refus).toBeInstanceOf(EngineUnavailable);
      expect((refus as EngineUnavailable).reason).toBe("provider");
      const cible = await resolveLlmTarget(2, deBob, null, { strict: true, touch: false });
      expect([cible.providerType, cible.apiKey, cible.connectorId]).toEqual([
        "anthropic",
        "sk-ant-SECRET",
        deBob,
      ]);
    } finally {
      installerConnecteurs(null);
    }
  });
});

describe("coffre indisponible", () => {
  it("création d'une clé refusée sans rien écrire (jamais stockée en clair), connecteur sans clé accepté", async () => {
    const t = ouvrirBaseDeTest("sqlite");
    try {
      await initialiserBase(t.base);
      coffre(true);
      const refus = await createConnector(t.base, {
        scope: "shared",
        provider_type: "vllm",
        wire: "openai",
        api_key: "x",
      }).catch((e: unknown) => e);
      expect(refus).toBeInstanceOf(ErreurSecret);
      expect((refus as ErreurSecret).code).toBe("secret_key_unavailable");
      expect(await t.base.all("SELECT id FROM llm_connectors")).toEqual([]);
      expect(
        await createConnector(t.base, { scope: "shared", provider_type: "vllm", wire: "openai" }),
      ).toBeTypeOf("number");
      expect(await t.base.all("SELECT api_key_enc, secret_id FROM llm_connectors")).toEqual([
        { api_key_enc: "", secret_id: null },
      ]);
    } finally {
      coffre();
      await t.fermer();
    }
  });
});
