// SPDX-License-Identifier: MIT
/** packages/mcp/test/paquet.test.ts — familles, origines, délégation, clés du pool, serveurs des comptes (après la migration 0029 des secrets au coffre) et registre local rejoués sur les vecteurs Python. */
import { DOSSIER_TEST } from "./environnement";

import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import type { Base, Ligne } from "@elpis/db";
import { configurerChiffrement } from "@elpis/securite";

import {
  allowedOrigins,
  APP_FAMILIES,
  authFingerprint,
  brancherCoffreMcp,
  brancherGardeUrl,
  CLES_HERITEES,
  clientBuiltinRef,
  DEFAULT_OPENCODE_EXCLUDE,
  DEFAULT_OPENCODE_FAMILIES,
  delegationToken,
  entreeReprise,
  estConfigIntegree,
  FAMILY_CATEGORY,
  FAMILY_NAMES,
  headerNameOk,
  isFamilyName,
  localServers,
  makeKey,
  mergePairs,
  mergePersonalMcp,
  normalizeSecret,
  opencodeEntryFor,
  opencodeFamilies,
  originAllowed,
  oublierVerdictsUrl,
  pairsPublic,
  parseFamilies,
  parseFamilySet,
  personalPublic,
  personalToConfig,
  publicId,
  repriseHeritee,
  resolvePersonal,
  sanitizePairs,
  SANDBOX_FAMILIES,
  secretsDeJson,
  secretsEnJson,
  secretsPerso,
  serveurDePortee,
  sharedId,
  verifyDelegation,
} from "../src";
import type { SecretsServeur } from "../src";
import { utilisateurDuMeta } from "../src/pool";
import { ligneEnConfig, oublierAvertissementsPaires } from "../src/serveurs";
import { capturerJournal, coffreSimule, decoder, lireVecteurs, rejouer } from "./aides";
import type { Issue } from "./aides";

type Dict = Record<string, unknown>;

const V = lireVecteurs<Record<string, Dict>>("mcp-paquet");
const journal = capturerJournal();

function estDictTest(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function trie(v: unknown): unknown {
  return v instanceof Set ? [...(v as Set<string>)].sort() : v;
}

describe("familles d'outils", () => {
  const F = V["familles"] as Dict;

  it("constantes identiques au Python (TOOL_FAMILIES et FAMILY_REGISTER_FN retirés avec elpis-tools)", () => {
    const c = F["constantes"] as Dict;
    expect([...FAMILY_NAMES]).toEqual(c["FAMILY_NAMES"]);
    expect([...FAMILY_NAMES]).toEqual((c["TOOL_FAMILIES"] as string[][]).map((f) => f[0]));
    expect([...SANDBOX_FAMILIES]).toEqual(c["SANDBOX_FAMILIES"]);
    expect([...APP_FAMILIES]).toEqual(c["APP_FAMILIES"]);
    expect(FAMILY_CATEGORY).toEqual(c["FAMILY_CATEGORY"]);
    expect(DEFAULT_OPENCODE_FAMILIES).toBe(c["DEFAULT_OPENCODE_FAMILIES"]);
    expect(DEFAULT_OPENCODE_EXCLUDE).toBe(c["DEFAULT_OPENCODE_EXCLUDE"]);
  });

  it("parse_families et parse_family_set : sortie et avertissements", async () => {
    for (const cas of F["parse_families"] as Dict[]) {
      const avert: string[] = [];
      await rejouer(
        () => parseFamilies(cas["raw"] as string, (m) => avert.push(m)),
        cas["out"] as Issue,
        String(cas["raw"]),
      );
      expect(avert, String(cas["raw"])).toEqual(cas["warnings"]);
    }
    for (const cas of F["parse_family_set"] as Dict[]) {
      const avert: string[] = [];
      await rejouer(
        () => trie(parseFamilySet(cas["raw"] as string, (m) => avert.push(m))),
        cas["out"] as Issue,
        String(cas["raw"]),
      );
      expect(avert, String(cas["raw"])).toEqual(cas["warnings"]);
    }
  });

  it("is_family_name et opencode_families sans manifeste", async () => {
    for (const cas of F["is_family_name"] as Dict[])
      expect(isFamilyName(cas["segment"]), String(cas["segment"])).toBe(cas["out"]);
    for (const cas of F["opencode_families"] as Dict[]) {
      const avert: string[] = [];
      await rejouer(
        () =>
          opencodeFamilies({
            includeRaw: cas["include"] as string | null,
            excludeRaw: cas["exclude"] as string | null,
            warn: (m) => avert.push(m),
            useManifest: false,
          }),
        cas["out"] as Issue,
        JSON.stringify(cas),
      );
      expect(avert, JSON.stringify(cas)).toEqual(cas["warnings"]);
    }
  });
});

describe("origines", () => {
  it("allowed_origins et origin_allowed relus à chaud", () => {
    const fichier = path.join(DOSSIER_TEST, "config.json");
    const cas = V["origines"] as unknown as Dict[];
    expect(cas.length).toBe(5);
    for (const c of cas) {
      writeFileSync(
        fichier,
        JSON.stringify({ mcp: { allowed_origins: c["mcp"] }, app: { cors_origins: c["cors"] } }),
      );
      invalidateConfigCache();
      if (c["env"] === null) delete process.env["LOCAL_MCP_ALLOWED_ORIGINS"];
      else process.env["LOCAL_MCP_ALLOWED_ORIGINS"] = c["env"] as string;
      expect([...allowedOrigins()].sort(), JSON.stringify(c)).toEqual(c["autorisees"]);
      for (const s of c["sondes"] as Dict[])
        expect(
          originAllowed(s["origin"] as string | null),
          `${JSON.stringify(c)} ${String(s["origin"])}`,
        ).toBe(s["ok"]);
    }
    delete process.env["LOCAL_MCP_ALLOWED_ORIGINS"];
    writeFileSync(fichier, "{}");
    invalidateConfigCache();
  });
});

describe("délégation", () => {
  const D = V["delegation"] as Dict;
  const cle = D["cle"] as string;
  const maintenant = D["maintenant"] as number;

  it("jetons dlg_ identiques à l'octet, vérification bornée à ±60 s", async () => {
    for (const cas of D["jetons"] as Dict[]) {
      const attendu = cas["jeton"] as Issue;
      await rejouer(
        () => delegationToken(cas["client"] as Dict, cle, { now: maintenant }),
        attendu,
        JSON.stringify(cas["client"]),
      );
      if (!("valeur" in attendu)) continue;
      const jeton = attendu.valeur as string;
      for (const v of cas["verifs"] as Dict[]) {
        let obtenu: unknown;
        if ("decalage" in v)
          obtenu = verifyDelegation(jeton, cle, { now: maintenant + (v["decalage"] as number) });
        else if ("cle" in v) obtenu = verifyDelegation(jeton, v["cle"] as string, { now: maintenant });
        else obtenu = verifyDelegation(jeton.slice(4), cle, { now: maintenant });
        expect(obtenu, `${jeton} ${JSON.stringify(v)}`).toEqual(decoder(v["out"]));
      }
    }
  });

  it("jetons bruts, clé de service absente", async () => {
    for (const b of D["bruts"] as Dict[])
      expect(verifyDelegation(b["token"] as string, cle, { now: maintenant }), String(b["token"])).toEqual(
        b["out"],
      );
    expect(verifyDelegation("dlg_x.y", "", { now: maintenant })).toEqual(D["sans_cle"]);
    await rejouer(
      () =>
        delegationToken(
          { username: "alice", user_id: 7, kind: "opencode", families: ["git", "browser"] },
          "",
          {
            now: maintenant,
          },
        ),
      D["signature_sans_cle"] as Issue,
      "sans clé",
      true,
    );
  });
});

describe("clés du pool", () => {
  const C = V["cles"] as Dict;

  /** Écart voulu : empreinte HMAC à clé propre au process (jamais la valeur du Python) ; mêmes erreurs, et deux configs ont la même clé et la même empreinte exactement quand le Python les leur donnait. */
  it("_make_key, _auth_fingerprint et _is_local_tools_cfg", async () => {
    const cas = C["configs"] as Dict[];
    expect(cas.length).toBe(24);
    const issue = (f: () => unknown): Issue => {
      try {
        return { valeur: f() };
      } catch (e) {
        return { erreur: e instanceof Error ? e.name : "?", message: "" };
      }
    };
    const vus: { cle: Issue; empreinte: Issue; py: Dict }[] = [];
    for (const c of cas) {
      const cfg = decoder(c["cfg"]) as Dict;
      const cle = issue(() => makeKey(cfg));
      const empreinte = issue(() => authFingerprint(cfg));
      for (const [ts, py] of [
        [cle, c["cle"]],
        [empreinte, c["empreinte"]],
      ] as const)
        expect("erreur" in ts, JSON.stringify(c["cfg"])).toBe("erreur" in (py as Issue));
      expect(estConfigIntegree(cfg), JSON.stringify(c["cfg"])).toBe(c["integree"]);
      vus.push({ cle, empreinte, py: c });
    }
    const valeur = (i: Issue): unknown => ("valeur" in i ? i.valeur : null);
    for (const a of vus)
      for (const b of vus)
        for (const k of ["cle", "empreinte"] as const) {
          const memePy =
            valeur(a.py[k] as Issue) !== null && valeur(a.py[k] as Issue) === valeur(b.py[k] as Issue);
          expect(
            valeur(a[k]) !== null && valeur(a[k]) === valeur(b[k]),
            `${k} ${JSON.stringify(a.py["cfg"])} ${JSON.stringify(b.py["cfg"])}`,
          ).toBe(memePy);
        }
  });

  it("_username_of", () => {
    for (const c of C["utilisateurs"] as Dict[])
      expect(utilisateurDuMeta(c["meta"] as Dict | null), JSON.stringify(c["meta"])).toBe(c["out"]);
  });
});

describe("serveurs des comptes", () => {
  const S = V["serveurs"] as Dict;
  const PERSOS = (S["personnels"] as Dict[]).filter((_, i) => i % 2 === 0).map((c) => c["srv"]);
  const BASE = {} as Base;
  const SYSTEME = { userId: null, username: null };
  const sim = coffreSimule();

  beforeAll(() => {
    brancherCoffreMcp(sim.coffre);
    configurerChiffrement({
      cleEnv: V["cle_fernet"] as unknown as string,
      fichierCle: path.join(DOSSIER_TEST, "absent", ".k"),
    });
    brancherGardeUrl(async (url) => {
      if (url.includes("interne") || url.includes("127.0.0.1")) return "blocked_ip (127.0.0.1)";
      if (url.startsWith("ftp:")) return "scheme_not_allowed (ftp)";
      return null;
    });
  });
  afterAll(() => {
    brancherGardeUrl(null);
    brancherCoffreMcp(null);
  });

  it("paires : nettoyage, fusion « vide = inchangé », vue publique", async () => {
    for (const cas of S["sanitize_pairs"] as Dict[])
      await rejouer(
        () => sanitizePairs(cas["raw"], cas["kind"] as string, cas["strict"] as boolean),
        cas["out"] as Issue,
        JSON.stringify(cas).slice(0, 200),
      );
    for (const cas of S["merge_pairs"] as Dict[])
      await rejouer(
        () => mergePairs(cas["old"], cas["new"], "headers"),
        cas["out"] as Issue,
        JSON.stringify(cas),
      );
    for (const cas of S["pairs_public"] as Dict[])
      await rejouer(() => pairsPublic(cas["pairs"]), cas["out"] as Issue, "public");
  });

  it("secrets, identifiants publics et noms d'en-têtes", async () => {
    for (const cas of S["normalize_secret"] as Dict[])
      expect(normalizeSecret(cas["mode"], cas["secret"]), JSON.stringify(cas)).toBe(cas["out"]);
    for (const cas of S["shared_id"] as Dict[])
      expect(sharedId(cas["id"]), JSON.stringify(cas)).toBe(cas["out"]);
    for (const cas of S["public_id"] as Dict[])
      await rejouer(() => publicId(cas["id"]), cas["out"] as Issue, JSON.stringify(cas));
    for (const cas of S["header_name_ok"] as Dict[])
      expect(headerNameOk(cas["name"]), JSON.stringify(cas)).toBe(cas["out"]);
  });

  /** Écarts voulus avec Python après la migration 0029 : mode implicite d'un ancien `authorization` rendu explicite, parties jamais envoyées (jeton d'un stdio, variables d'un HTTP) non reprises, chiffré mal formé signalé. */
  const ECARTS_COFFRE: Record<string, { config?: Dict; public?: Dict }> = {
    s7: { config: { auth_mode: "raw", auth_user: "" }, public: { auth_mode: "raw", auth_user: "" } },
    s8: { public: { has_auth: false } },
    s12: { public: { env: [], secret_error: "undecryptable" } },
    s17: { public: { env: [] } },
  };

  function ecart(attendu: Issue, srv: unknown, cote: "config" | "public"): Issue {
    const plus = estDictTest(srv) ? ECARTS_COFFRE[String(srv["id"])]?.[cote] : undefined;
    if (plus === undefined || !("valeur" in attendu) || Object.keys(attendu.valeur as Dict).length === 0)
      return attendu;
    return { valeur: { ...(attendu.valeur as Dict), ...plus } };
  }

  /** Entrée d'avant le coffre passée par la migration 0029 (compte 1) : secrets au coffre simulé, entrée laissée par `entreeReprise`. */
  async function migree(srv: unknown): Promise<unknown> {
    if (!estDictTest(srv)) return srv;
    const e = structuredClone(srv);
    const r = repriseHeritee(e);
    if (r === null) return e;
    const id = r.aReprendre
      ? await sim.coffre.ecrire(BASE, 1, serveurDePortee(e["id"]), r.valeur, null, SYSTEME)
      : null;
    entreeReprise(e, r, id);
    return e;
  }

  /** Ligne partagée d'avant le coffre : secrets tels que la migration 0029 les garde au coffre, relus par leur JSON. */
  function auCoffre(ligne: Ligne): SecretsServeur {
    const r = repriseHeritee(ligne);
    return secretsDeJson(secretsEnJson(r === null ? { auth: "", headers: [], env: [] } : r.valeur));
  }

  /** Entrée enregistrée par Python → entrée sans champ hérité et valeur au coffre (`auth_enc`, `headers_enc`, `env_enc` en clair ou déchiffrés). */
  function versCoffre(e: unknown): unknown {
    if (!estDictTest(e)) return e;
    const clair = (v: unknown): string =>
      estDictTest(v) ? String(v["$dechiffre"]) : typeof v === "string" ? v : "";
    const paires = (v: unknown): unknown => (clair(v) ? JSON.parse(clair(v)) : []);
    return {
      entree: Object.fromEntries(Object.entries(e).filter(([k]) => !CLES_HERITEES.includes(k))),
      valeur: { auth: clair(e["auth_enc"]), headers: paires(e["headers_enc"]), env: paires(e["env_enc"]) },
    };
  }

  it("serveurs perso après la migration 0029 : config résolue (garde d'URL, stdio réservé) et vue publique sans secret, comme Python les lisait en place", async () => {
    for (const cas of S["personnels"] as Dict[]) {
      oublierVerdictsUrl();
      const srv = await migree(cas["srv"]);
      const etat = await secretsPerso(BASE, 1, srv);
      const opts = { allowStdio: cas["allow_stdio"] as boolean, secrets: etat.valeur };
      await rejouer(
        () => personalToConfig(srv, opts),
        ecart(cas["config"] as Issue, srv, "config"),
        JSON.stringify(cas["srv"]),
      );
      if (cas["public"] !== null)
        await rejouer(
          () => personalPublic(srv, etat),
          ecart(cas["public"] as Issue, srv, "public"),
          JSON.stringify(cas["srv"]),
        );
    }
  });

  it("fusion de la liste perso : refus stdio et URL interne, secrets jamais repris du client, anciens champs repris pour le coffre", async () => {
    const anciens = [
      {
        id: "a",
        name: "A",
        type: "http",
        url: "https://a/mcp",
        auth_mode: "bearer",
        auth_enc: "ancien-chiffre",
        key_scheme: "plain",
      },
      { id: "loc", name: "Loc", type: "stdio", command: "npx loc" },
      {
        id: "leg",
        name: "Leg",
        type: "sse",
        url: "https://leg/sse",
        basic_auth: { username: "lu", password: "lp" },
      },
      { id: "leg2", name: "Leg2", type: "sse", url: "https://leg/sse", authorization: "Bearer xyz" },
      {
        id: "hdr",
        name: "Hdr",
        type: "http",
        url: "https://h/mcp",
        headers_enc: '[{"name": "X-K", "value": "garde"}]',
        extra_scheme: "plain",
      },
    ];
    const cas = S["fusions"] as Dict[];
    expect(cas.length).toBe(30);
    for (const c of cas) {
      oublierVerdictsUrl();
      const out = c["out"] as Issue;
      await rejouer(
        async () =>
          (await mergePersonalMcp(anciens, c["new"], { allowStdio: c["allow_stdio"] as boolean })).map(
            ({ entree, valeur }) => ({ entree, valeur }),
          ),
        "valeur" in out ? { valeur: (out.valeur as unknown[]).map(versCoffre) } : out,
        `${JSON.stringify(c["new"])} ${String(c["allow_stdio"])}`,
      );
    }
  });

  it("référence d'outils locaux reconstruite, résolution perso par id après la migration 0029", async () => {
    for (const cas of S["references"] as Dict[])
      expect(clientBuiltinRef(cas["raw"]), JSON.stringify(cas["raw"])).toEqual(cas["out"]);
    const reglages = { mcp_servers: await Promise.all(PERSOS.slice(0, 9).map(migree)) };
    for (const cas of S["resolutions"] as Dict[]) {
      oublierVerdictsUrl();
      await rejouer(
        () => resolvePersonal(BASE, 1, reglages, cas["id"], { allowStdio: cas["allow_stdio"] as boolean }),
        cas["out"] as Issue,
        JSON.stringify(cas),
      );
    }
  });

  it("bibliothèque partagée après la migration 0029 : paires revérifiées à la connexion (fullmatch ASCII, noms réservés), valeurs vides retirées", async () => {
    const cas = S["lignes"] as Dict[];
    expect(cas.length).toBe(3);
    for (const c of cas) {
      const ligne = c["ligne"] as Ligne;
      await rejouer(() => ligneEnConfig(ligne, auCoffre(ligne)), c["out"] as Issue, JSON.stringify(ligne));
    }
  });

  it("nom refusé à la connexion : avertissement « [mcp] » une seule fois par nom et par processus", async () => {
    const perso = async (id: string): Promise<[unknown, SecretsServeur]> => {
      const srv = await migree(PERSOS.find((x) => estDictTest(x) && x["id"] === id));
      return [srv, (await secretsPerso(BASE, 1, srv)).valeur];
    };
    const [s13, v13] = await perso("s13");
    const [s16, v16] = await perso("s16");
    const lignes = (S["lignes"] as Dict[]).map((c) => c["ligne"] as Ligne);
    const [v0, v1] = lignes.map(auCoffre);
    oublierAvertissementsPaires();
    journal.length = 0;
    for (let i = 0; i < 2; i++) {
      await personalToConfig(s13, { allowStdio: true, secrets: v13 });
      await personalToConfig(s16, { allowStdio: true, secrets: v16 });
      ligneEnConfig(lignes[0] as Ligne, v0);
      ligneEnConfig(lignes[1] as Ligne, v1);
    }
    const avertis = journal.filter((l) => l.niveau === "warn").map((l) => `[${l.domaine}] ${l.message}`);
    expect(avertis).toEqual(S["avertissements"]);
    oublierAvertissementsPaires();
  });

  it("sans garde d'URL branchée, l'URL perso d'un non-admin est refusée (fail-closed)", async () => {
    brancherGardeUrl(null);
    try {
      oublierVerdictsUrl();
      const srv = { id: "x", type: "http", url: "https://public.example/mcp" };
      expect(await personalToConfig(srv)).toEqual({});
      await expect(mergePersonalMcp([], [srv])).rejects.toThrow("garde SSRF non branchée");
      expect(await personalToConfig(srv, { allowStdio: true })).toMatchObject({ type: "http", url: srv.url });
    } finally {
      brancherGardeUrl(async () => null);
    }
  });
});

describe("registre local (déprécié)", () => {
  const R = V["registre"] as Dict;

  it("local_servers et opencode_entry_for", async () => {
    for (const cas of R["local_servers"] as Dict[]) {
      const restaurer = surchargerConfig({
        LOCAL_MCP_SERVERS_RAW: cas["raw"] as never,
        LOCAL_MCP_HOST: "127.0.0.1",
        LOCAL_MCP_PORT: 8765,
      });
      try {
        await rejouer(() => localServers(), cas["out"] as Issue, JSON.stringify(cas["raw"]));
      } finally {
        restaurer();
      }
    }
    for (const cas of R["opencode_entry_for"] as Dict[])
      expect(opencodeEntryFor(cas["d"] as Dict)).toEqual(cas["out"]);
  });
});
