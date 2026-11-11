// SPDX-License-Identifier: MIT
/** apps/core/test/reglages.test.ts — les 14 routes de la famille comptes rejouées contre la vraie `create_app()` Python (réponses, comptes, avatars), SQLite et PostgreSQL. */
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createUser, dependancesParDefaut, signerSession } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { estDict, pyJsonDumps, pyJsonLoads, reprFlottant } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { configView, invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { Valeur } from "@elpis/db";
import { resolvePersonal, surInvalidationMcp } from "@elpis/mcp";
import type { EvenementMcp } from "@elpis/mcp";
import { configurerChiffrement, configurerCoffre, decrypt, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { composer } from "../src/composition";
import { cheminCacheCategories, reinitialiserRegistre } from "../src/outils/categories";
import { installerCrochetJournal } from "../src/journal";
import { appTest, effacementUnifie, journalMuet } from "./aides";
import { reponseSansAvatarAssistant, sansAvatarAssistant } from "./ecart-avatar-assistant";
import { corpsSansFusion, documentSansFusion } from "./ecart-fusion-skins";

type Fichier = { champ: string; nom: string; type: string; hex: string };
type Etape = {
  t?: number;
  u?: string;
  lt?: number;
  s?: Record<string, unknown>;
  m?: string;
  p?: string;
  c?: unknown;
  b?: string;
  h?: Record<string, string>;
  f?: Fichier;
  mode?: "admin";
  sc?: boolean;
  config?: unknown;
  sql?: [string, Valeur[]];
  doc?: [string, string];
};
type Reponse = {
  statut?: number;
  corps?: string | { sha256: string; taille: number };
  type?: string | null;
  cache?: string | null;
  location?: string | null;
  cookies?: string[];
};

const V = pyJsonLoads(readFileSync(new URL("./vecteurs/reglages.json", import.meta.url), "utf-8")) as {
  T0: { valeur: number } | number;
  secret: string;
  cle: string;
  comptes: [string, string, number, number][];
  sql: [string, Valeur[]][];
  etapes: Etape[];
  ids: Dict;
  reponses: Reponse[];
  comptes_finaux: unknown[][];
  avatars: [string, string][];
};
const T0 = Number(typeof V.T0 === "object" ? V.T0.valeur : V.T0);
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const CHIFFRES = ["auth_enc", "headers_enc", "env_enc"];
const B = "frontiereDifferentiel";

let dossier: string;
const auditAvant = process.env["ELPIS_AUDIT_DIR"];

beforeAll(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-reglages-"));
  process.env["ELPIS_AUDIT_DIR"] = join(dossier, "audit");
  oublierConfigurationAudit();
});

afterAll(() => {
  if (auditAvant === undefined) delete process.env["ELPIS_AUDIT_DIR"];
  else process.env["ELPIS_AUDIT_DIR"] = auditAvant;
  oublierConfigurationAudit();
  rmSync(dossier, { recursive: true, force: true });
});

function multipart(f: Fichier): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${B}\r\nContent-Disposition: form-data; name="${f.champ}"; filename="${f.nom}"\r\nContent-Type: ${f.type}\r\n\r\n`,
    ),
    Buffer.from(f.hex, "hex"),
    Buffer.from(`\r\n--${B}--\r\n`),
  ]);
}

/** Secrets chiffrés (Fernet aléatoire) remplacés par leur clair : même forme que `normaliser` du générateur. */
function normaliser(texte: unknown): unknown {
  if (typeof texte !== "string") return texte;
  let d: unknown;
  try {
    d = pyJsonLoads(texte);
  } catch {
    return texte;
  }
  const serveurs = estDict(d) ? d["mcp_servers"] : undefined;
  if (Array.isArray(serveurs))
    for (const s of serveurs)
      if (estDict(s))
        for (const k of CHIFFRES)
          if (typeof s[k] === "string" && s[k]) s[k] = { $dechiffre: decrypt(s[k] as string) };
  return pyJsonDumps(d, { ensureAscii: false });
}

/** Étapes où le Python répond 500 (réglages ou configuration d'instance mal formés) et le core 200 : défauts Python corrigés en TS. */
const CORRIGES_EN_TS = new Set([127, 155, 156]);

/** Réponse TS de `/api/settings/agent-templates` : en-têtes du Python, les cinq agents livrés avec la lecture seule de l'administrateur. */
function modelesAgentsTs(obtenu: Reponse, voulu: Reponse, corps: string): boolean {
  if (obtenu.statut !== 200 || obtenu.type !== voulu.type || obtenu.cache !== voulu.cache) return false;
  const d = JSON.parse(corps) as { templates: Record<string, unknown>[]; read_only_policy: unknown };
  return (
    d.templates.map((t) => t["name"]).join(",") === "explore,implement,verify,web,pr" &&
    d.templates.every(
      (t) => typeof t["read_only_default"] === "boolean" && t["read_only_forced"] === false,
    ) &&
    typeof d.read_only_policy === "object"
  );
}

/** Serveurs perso restant dans les réglages de modo (entrées non-objets retirées, réglages mal formés corrigés en TS, étape 127) ; ceux de bob restent tels que le Python les laisse (chaque PUT refusé, 403). */
const FINAUX_CORRIGES_EN_TS: Record<string, unknown[]> = {
  modo: [
    {
      id: "m1",
      name: "M",
      type: "sse",
      url: "https://9.9.9.9/sse",
      auth_mode: "",
      auth_user: "",
    },
  ],
};

/** Réglages de bob relus (étapes 7, 76, 120) : son entrée d'avant le coffre, posée après la migration 0029, est montrée avec le mode implicite de son `authorization` (« raw ») et les noms de ses anciens secrets, signalée `not_migrated` et jamais utilisée pour se connecter ; renvoyée telle quelle, elle passerait au coffre ; sans ce mode, un compte ordinaire est refusé (403, comme le Python) — écart voulu. */
const MCP_NON_MIGRES = new Set([7, 76, 120]);
const SRV1_PYTHON =
  '"visible":true,"has_auth":true,"headers":[{"name":"X-Api","value":"","has_value":true}],"env":[]}';
const SRV1_TS =
  '"visible":true,"auth_mode":"raw","auth_user":"","has_auth":true,' +
  '"headers":[{"name":"X-Api","value":"","has_value":true}],"env":[],"secret_error":"not_migrated"}';

function corpsMcpNonMigre(corps: unknown): unknown {
  if (typeof corps !== "string" || !corps.includes(SRV1_PYTHON))
    throw new Error("réglages de bob inattendus");
  return corps.replace(SRV1_PYTHON, SRV1_TS);
}

/** Réglages enregistrés, `secret_id` des serveurs MCP remplacé par un repère (ids du coffre propres au run). */
function sansIdsCoffre(texte: string): unknown {
  const d = pyJsonLoads(texte);
  const serveurs = estDict(d) ? d["mcp_servers"] : undefined;
  if (Array.isArray(serveurs))
    for (const s of serveurs) if (estDict(s) && "secret_id" in s) s["secret_id"] = "<coffre>";
  return d;
}

/** Document de réglages (JSON compact), `secret_id` des serveurs MCP remplacé par un repère. */
function idsCoffreMasques(texte: string): string {
  const d = JSON.parse(texte) as Dict;
  const serveurs = d["mcp_servers"];
  if (Array.isArray(serveurs))
    for (const s of serveurs) if (estDict(s) && "secret_id" in s) s["secret_id"] = "<coffre>";
  return JSON.stringify(d);
}

/** Réglages finaux du Python vus avec le coffre : champs chiffrés des serveurs MCP retirés, repère du coffre là où un secret était gardé (écart voulu). */
function finauxMcpEnTs(texte: string): string {
  const d = JSON.parse(texte) as Dict;
  const serveurs = d["mcp_servers"];
  if (!Array.isArray(serveurs)) return texte;
  const chiffres = ["headers_enc", "env_enc", "extra_scheme", "auth_enc", "key_scheme"];
  d["mcp_servers"] = serveurs.map((s: unknown) => {
    if (!estDict(s)) return s;
    const e = Object.fromEntries(Object.entries(s).filter(([k]) => !chiffres.includes(k)));
    return ["auth_enc", "headers_enc", "env_enc"].some((k) => s[k]) ? { ...e, secret_id: "<coffre>" } : e;
  });
  return JSON.stringify(d);
}

describe.each(MOTEURS)("différentiel contre create_app() (%s)", (moteur) => {
  let t: BaseDeTest;
  let racine: string;
  let config: string;
  let sb: string;
  let principal: FastifyInstance;
  let console_: FastifyInstance;
  let restaurer: () => void;
  const horloge = { t: T0 };

  beforeAll(async () => {
    const ici = mkdtempSync(join(dossier, `${moteur}-`));
    racine = join(ici, "racine");
    sb = join(ici, "sb");
    config = join(ici, "config.json");
    mkdirSync(racine);
    writeFileSync(config, "{}");
    restaurer = surchargerConfig({
      CONFIG_JSON_PATH: config,
      SANDBOX_DIR: sb,
      SKINS_DIR: join(ici, "user_skins"),
    });
    invalidateConfigCache();
    configurerChiffrement({ cleEnv: V.cle, fichierCle: join(ici, ".encryption_key") });
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: join(ici, "absente.key"),
      repli: join(ici, ".vault.key"),
    });
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    for (const [nom, mdp, admin, changer] of V.comptes)
      await createUser(t.base, nom, mdp, { isAdmin: admin, mustChangePwd: changer, maintenant: T0 });
    for (const [requete, params] of V.sql) await t.base.run(requete, params);
    const dep: DependancesAuth & DependancesJetons = {
      ...dependancesParDefaut(t.base),
      config: () => configView(),
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax",
        https_only: false,
        max_age: 86400,
      }),
      secret: () => V.secret,
      jetonService: () => "",
      maintenant: () => horloge.t,
    };
    principal = await appTest({ ...(await composer("main", t.base, journalMuet, dep, racine)) });
    console_ = await appTest({
      ...(await composer("admin", t.base, journalMuet, dep, racine)),
      mode: "admin",
    });
  });

  afterAll(async () => {
    await principal.close();
    await console_.close();
    await t.fermer();
    restaurer();
    invalidateConfigCache();
  });

  it(`${V.etapes.length} étapes : statut, corps, type et cache ; puis comptes et avatars`, async () => {
    const ecarts: string[] = [];
    const prefixeSb = realpathSync(dirname(sb)) + "/sb";
    for (const [i, e] of V.etapes.entries()) {
      // Écart voulu : avatar de l'assistant = logo de l'application (ecart-avatar-assistant.ts).
      const attendu = reponseSansAvatarAssistant(e.m ?? "", e.p ?? "", V.reponses[i] as Reponse);
      if (e.config !== undefined) {
        writeFileSync(config, pyJsonDumps(e.config));
        invalidateConfigCache();
        continue;
      }
      if (e.sql !== undefined) {
        await t.base.run(e.sql[0], e.sql[1]);
        continue;
      }
      if (e.doc !== undefined) {
        // Écart voulu : le guide utilisateur français est passé à docs/fr/user-guide.md (documentation en anglais).
        const doc = e.doc[0] === "docs/guide-utilisateur.md" ? "docs/fr/user-guide.md" : e.doc[0];
        const chemin = join(racine, doc);
        mkdirSync(dirname(chemin), { recursive: true });
        writeFileSync(chemin, Buffer.from(e.doc[1], "hex"));
        continue;
      }
      horloge.t = T0 + Number(e.t ?? 0);
      const entetes: Record<string, string> = { host: "lan.test:8000", ...(e.h ?? {}) };
      if (e.u) {
        const uid = Number(V.ids[e.u]);
        const session = signerSession(
          { user_id: uid, _login_ts: horloge.t + Number(e.lt ?? 0) },
          V.secret,
          horloge.t,
        );
        entetes["cookie"] = `mcpwebui_session=${session}`;
      } else if (e.s !== undefined) {
        entetes["cookie"] = `mcpwebui_session=${signerSession(e.s, V.secret, horloge.t)}`;
      }
      let charge: Buffer | undefined;
      if (e.c !== undefined) {
        charge = Buffer.from(pyJsonDumps(e.c, { ensureAscii: false }), "utf-8");
        entetes["content-type"] = "application/json";
      } else if (e.b !== undefined) {
        charge = Buffer.from(e.b, "utf-8");
        entetes["content-type"] = "application/json";
      } else if (e.f !== undefined) {
        charge = multipart(e.f);
        entetes["content-type"] = `multipart/form-data; boundary=${B}`;
      }
      const app = e.mode === "admin" ? console_ : principal;
      const r = await app.inject({
        method: e.m as "GET",
        url: e.p ?? "",
        headers: entetes,
        ...(charge === undefined ? {} : { payload: charge }),
      });
      const type = (r.headers["content-type"] as string | undefined) ?? null;
      const binaire = r.rawPayload.length > 6000 || (type ?? "").startsWith("image/");
      const obtenu: Reponse = {
        statut: r.statusCode,
        corps: binaire
          ? { sha256: createHash("sha256").update(r.rawPayload).digest("hex"), taille: r.rawPayload.length }
          : r.body
              .split(prefixeSb)
              .join("$SB")
              .replace(/"(token|hint)":"[^"]*"/g, '"$1":"<$1>"'),
        type: type === "application/json; charset=utf-8" ? "application/json" : type,
        cache: (r.headers["cache-control"] as string | undefined) ?? null,
        location: (r.headers["location"] as string | undefined) ?? null,
        ...(e.sc
          ? { cookies: ([] as string[]).concat((r.headers["set-cookie"] as string[] | string) ?? []) }
          : {}),
      };
      const voulu: Reponse = {
        statut: attendu.statut,
        corps: attendu.corps,
        type: attendu.type,
        cache: attendu.cache,
        location: attendu.location,
        ...(e.sc ? { cookies: attendu.cookies?.map(effacementUnifie) } : {}),
      };
      if (CORRIGES_EN_TS.has(i)) {
        if (obtenu.statut !== 200) ecarts.push(`${i} ${e.m} ${e.p} : ${obtenu.statut} au lieu de 200`);
        continue;
      }
      if (e.m === "GET" && e.p === "/api/settings/agent-templates" && voulu.statut === 200) {
        // Écart voulu (ecarts-python.md de la v0.1.2, « Sous-agents ») : lecture seule de l'administrateur jointe, personas alignées sur le périmètre.
        if (!modelesAgentsTs(obtenu, voulu, r.body))
          ecarts.push(`${i} ${e.m} ${e.p} : modèles d'agents inattendus`);
        continue;
      }
      // Écart voulu : Parchemin fondu dans Elpis, réglage `skin_palette` ajouté (ecart-fusion-skins.ts).
      obtenu.corps = corpsSansFusion(obtenu.corps) as typeof obtenu.corps;
      voulu.corps = corpsSansFusion(voulu.corps) as typeof voulu.corps;
      if (MCP_NON_MIGRES.has(i)) voulu.corps = corpsMcpNonMigre(voulu.corps) as typeof voulu.corps;
      if (pyJsonDumps(obtenu) !== pyJsonDumps(voulu))
        ecarts.push(
          `${i} ${e.mode ?? ""} ${e.u ?? "-"} ${e.m} ${e.p}\n  attendu ${pyJsonDumps(voulu).slice(0, 1500)}\n  obtenu  ${pyJsonDumps(obtenu).slice(0, 1500)}`,
        );
    }
    expect(ecarts).toEqual([]);
    const lignes = await t.base.valeurs<unknown[]>(
      "SELECT id, username, is_admin, avatar, must_change_pwd, session_min_ts, settings_json FROM users ORDER BY id",
    );
    const comptes = lignes.map(([id, nom, admin, avatar, changer, minimum, reglages]) => [
      Number(id),
      nom,
      Number(admin),
      avatar,
      Number(changer),
      minimum === null ? null : reprFlottant(Number(minimum)),
      normaliser(reglages),
    ]);
    for (const [i, ligne] of comptes.entries()) {
      const brut = V.comptes_finaux[i] as unknown[];
      // Écart voulu : Parchemin fondu dans Elpis, réglage `skin_palette` ajouté (ecart-fusion-skins.ts).
      const c = [...ligne.slice(0, 6), documentSansFusion(String(ligne[6]))];
      const voulu =
        typeof brut[6] === "string"
          ? [...brut.slice(0, 6), documentSansFusion(sansAvatarAssistant(brut[6], { ensureAscii: false }))]
          : brut;
      const mcp = FINAUX_CORRIGES_EN_TS[String(c[1])];
      if (mcp === undefined) {
        const [obtenu, attendu] =
          typeof voulu[6] === "string"
            ? [
                [...c.slice(0, 6), idsCoffreMasques(String(c[6]))],
                [...voulu.slice(0, 6), finauxMcpEnTs(voulu[6])],
              ]
            : [c, voulu];
        expect(pyJsonDumps(obtenu), String(c[1])).toBe(pyJsonDumps(attendu));
        continue;
      }
      const reglagesVoulus = { ...(pyJsonLoads(String(voulu[6])) as Dict), mcp_servers: mcp };
      expect(pyJsonDumps([...c.slice(0, 6), pyJsonDumps(sansIdsCoffre(String(c[6])))]), String(c[1])).toBe(
        pyJsonDumps([...voulu.slice(0, 6), pyJsonDumps(reglagesVoulus)]),
      );
    }
    const avatars = join(racine, "user_db", "avatars");
    const fichiers = readdirSync(avatars)
      .sort()
      .map((n) => [
        n,
        createHash("sha256")
          .update(readFileSync(join(avatars, n)))
          .digest("hex"),
      ]);
    // Écart voulu : aucun avatar d'assistant (`bot_…`) n'est plus déposé.
    expect(fichiers).toEqual(V.avatars.filter(([n]) => !n.startsWith("bot_")));
  });
});

describe("réglages : chiffrement absent, nom hérité, invalidation, document illisible", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let ici: string;
  let restaurer: () => void;
  const T = 1_800_000_100;

  const requete = (uid: number, method: "GET" | "PUT", payload?: unknown) =>
    app.inject({
      method,
      url: "/api/settings",
      headers: {
        cookie: `mcpwebui_session=${signerSession({ user_id: uid, _login_ts: T }, "secret-unitaire", T)}`,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });

  beforeAll(async () => {
    ici = mkdtempSync(join(dossier, "unitaire-"));
    writeFileSync(join(ici, "config.json"), "{}");
    restaurer = surchargerConfig({
      CONFIG_JSON_PATH: join(ici, "config.json"),
      SANDBOX_DIR: join(ici, "sb"),
    });
    invalidateConfigCache();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "admin", "x", { isAdmin: 1 });
    await t.base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin, settings_json) VALUES (?, 's', 'h', 0, 0, ?)",
      ["josé.d", '{"a": '],
    );
    const dep: DependancesAuth & DependancesJetons = {
      ...dependancesParDefaut(t.base),
      config: () => configView(),
      secret: () => "secret-unitaire",
      jetonService: () => "",
      maintenant: () => T,
    };
    app = await appTest({ ...(await composer("main", t.base, journalMuet, dep, join(ici, "racine"))) });
  });

  afterAll(async () => {
    await app.close();
    await t.fermer();
    restaurer();
    invalidateConfigCache();
  });

  it("sans clé du coffre, un secret MCP est refusé en 503 et rien n'est écrit (écart : secrets MCP au coffre)", async () => {
    configurerChiffrement({ cleEnv: "", fichierCle: join(ici, "config.json", ".encryption_key") });
    configurerCoffre({ fichier: join(ici, "vault.key.absente"), repli: join(ici, ".vault.key") });
    const r = await requete(1, "PUT", {
      dark_mode: true,
      mcp_servers: [
        { id: "s", name: "S", type: "sse", url: "https://8.8.8.8/x", auth_mode: "bearer", auth_secret: "k" },
      ],
    });
    expect([r.statusCode, r.json()]).toEqual([
      503,
      { detail: "Clé du coffre indisponible : secret MCP non enregistré (voir ./elpis doctor)." },
    ]);
    expect((await requete(1, "GET")).json<Dict>()["dark_mode"]).toBe(false);
    expect(await t.base.all("SELECT id FROM vault_secrets")).toEqual([]);
  });

  it("dossier sandbox affiché : celui de safe_sandbox_name, même pour un nom hérité (écart corrigé)", async () => {
    const d = (await requete(2, "GET")).json<Dict>();
    expect(d["sandbox_path_display"]).toBe(join(realpathSync(ici), "sb", "josd"));
  });

  it("document illisible : défauts, erreur journalisée, puis écrasé par la sauvegarde suivante", async () => {
    const lignes: string[] = [];
    installerCrochetJournal((niveau, message) => lignes.push(`${niveau} ${message}`));
    try {
      expect((await requete(2, "GET")).json<Dict>()["assistant_name"]).toBe("Elpis");
      expect(lignes.join("\n")).toContain("settings_json corrompu pour uid=2");
      expect((await requete(2, "PUT", { system_prompt: "Ana" })).json()).toEqual({ ok: true });
      expect(await t.base.valeurs("SELECT settings_json FROM users WHERE id=2")).toEqual([
        ['{"system_prompt": "Ana"}'],
      ]);
    } finally {
      installerCrochetJournal(null);
    }
  });

  it("jetons : libellé d'une famille tiré du registre des catégories (get_categories), sinon son nom", async () => {
    const cache = join(ici, "categories.json");
    writeFileSync(
      cache,
      JSON.stringify({
        descriptors: {
          fs: { name: "fs", label: "Fichiers", icon: "", color: "", hidden: false, tools: [] },
          git: { name: "git", label: "", icon: "", color: "", hidden: true, tools: [] },
        },
        tool_to_category: {},
        tool_descriptions: {},
        tool_policy: {},
        source: "live",
      }),
    );
    const avant = cheminCacheCategories();
    reinitialiserRegistre({ cheminCache: cache });
    try {
      const r = await app.inject({
        method: "GET",
        url: "/api/tokens",
        headers: {
          cookie: `mcpwebui_session=${signerSession({ user_id: 1, _login_ts: T }, "secret-unitaire", T)}`,
        },
      });
      const familles = r.json<{ policy: { families: { name: string; label: string }[] } }>().policy.families;
      expect(familles.slice(0, 3)).toEqual([
        { name: "fs", label: "Fichiers" },
        { name: "shell", label: "shell" },
        { name: "git", label: "git" },
      ]);
    } finally {
      reinitialiserRegistre({ cheminCache: avant });
    }
  });

  it("serveurs perso : un seul événement d'invalidation, ancienne et nouvelle liste ; aucun sans changement", async () => {
    configurerChiffrement({ cleEnv: "cle-unitaire", fichierCle: join(ici, ".encryption_key") });
    const vus: EvenementMcp[] = [];
    const fin = surInvalidationMcp((e) => {
      vus.push(e);
    });
    try {
      const srv = { id: "s", name: "S", type: "sse", url: "https://8.8.8.8/x" };
      expect((await requete(1, "PUT", { mcp_servers: [srv] })).statusCode).toBe(200);
      expect((await requete(1, "PUT", { dark_mode: false })).statusCode).toBe(200);
      expect((await requete(1, "PUT", { mcp_servers: [srv] })).statusCode).toBe(200);
      expect(vus).toHaveLength(1);
      expect(vus[0]).toMatchObject({
        type: "reglages",
        avant: [],
        apres: [{ id: "s", url: "https://8.8.8.8/x" }],
      });
    } finally {
      fin();
    }
  });

  const ENTREES_ANCIENNES: [string, unknown][] = [
    ["authorization", { id: "a", name: "A", url: "https://8.8.8.8/x", authorization: "Bearer abc" }],
    [
      "headers en dict",
      { id: "b", name: "B", type: "sse", url: "https://8.8.8.8/x", headers: { "X-Api-Key": "k" } },
    ],
    [
      "basic_auth",
      {
        id: "c",
        name: "C",
        url: "https://8.8.8.8/x",
        visible: true,
        basic_auth: { username: "u", password: "p" },
      },
    ],
  ];

  const CONFIGS_ANCIENNES: Record<string, Dict> = {
    authorization: { authorization: "Bearer abc" },
    "headers en dict": { headers: { "X-Api-Key": "k" } },
    basic_auth: { basic_auth: { username: "u", token: "p" } },
  };

  it.each(ENTREES_ANCIENNES)(
    "entrée perso ancienne (%s) : le re-PUT de sa vue par un non-admin n'est plus refusé en 403 (défaut Python corrigé) et garde ses secrets, repris au coffre",
    async (nom, entree) => {
      configurerChiffrement({ cleEnv: "cle-unitaire", fichierCle: join(ici, ".encryption_key") });
      configurerCoffre({
        cleEnv: randomBytes(32).toString("base64"),
        systeme: join(ici, "absente.key"),
        repli: join(ici, ".vault.key"),
      });
      const uid = await createUser(t.base, `ancien-${nom.replace(/\W/g, "")}`, "x", { isAdmin: 0 });
      await t.base.run("UPDATE users SET settings_json=? WHERE id=?", [
        pyJsonDumps({ mcp_servers: [entree] }),
        uid,
      ]);
      for (let tour = 0; tour < 2; tour += 1) {
        const vue = (await requete(uid, "GET")).json<Dict>()["mcp_servers"];
        const r = await requete(uid, "PUT", { mcp_servers: vue });
        expect([r.statusCode, r.json()], `tour ${tour}`).toEqual([200, { ok: true }]);
      }
      const stocke = pyJsonLoads(
        String((await t.base.valeurs<[string]>("SELECT settings_json FROM users WHERE id=?", [uid]))[0]?.[0]),
      ) as Dict;
      const id = String((entree as Dict)["id"]);
      expect(await resolvePersonal(t.base, uid, stocke, id, { allowStdio: true })).toMatchObject(
        CONFIGS_ANCIENNES[nom] ?? {},
      );
    },
  );

  it("entrée perso modifiée par un non-admin : toujours refusée, même sur un compte à entrée ancienne", async () => {
    configurerChiffrement({ cleEnv: "cle-unitaire", fichierCle: join(ici, ".encryption_key") });
    const uid = await createUser(t.base, "ancien-modif", "x", { isAdmin: 0 });
    await t.base.run("UPDATE users SET settings_json=? WHERE id=?", [
      pyJsonDumps({ mcp_servers: [ENTREES_ANCIENNES[0]?.[1]] }),
      uid,
    ]);
    const vue = (await requete(uid, "GET")).json<Dict>()["mcp_servers"] as Dict[];
    const r = await requete(uid, "PUT", {
      mcp_servers: vue.map((s) => ({ ...s, url: "https://1.1.1.1/y" })),
    });
    expect([r.statusCode, r.json()]).toEqual([
      403,
      { detail: "Modification de serveur MCP réservée aux administrateurs." },
    ]);
  });

  it("mcp_servers enregistré avec des entrées qui ne sont pas des objets : ignorées, ni 500 ni perte des autres", async () => {
    configurerChiffrement({ cleEnv: "cle-unitaire", fichierCle: join(ici, ".encryption_key") });
    const uid = await createUser(t.base, "entrees-mixtes", "x", { isAdmin: 0 });
    const bonne = { id: "ok", name: "OK", type: "sse", url: "https://8.8.8.8/x" };
    await t.base.run("UPDATE users SET settings_json=? WHERE id=?", [
      pyJsonDumps({ mcp_servers: ["texte", 5, null, [1], bonne] }),
      uid,
    ]);
    const vue = (await requete(uid, "GET")).json<Dict>()["mcp_servers"] as Dict[];
    expect(vue.map((s) => s["id"])).toEqual(["ok"]);
    for (const charge of [{ mcp_servers: vue }, { mcp_servers: ["texte", ...vue, 7] }]) {
      const r = await requete(uid, "PUT", charge);
      expect([r.statusCode, r.json()]).toEqual([200, { ok: true }]);
    }
    const stocke = pyJsonLoads(
      String((await t.base.valeurs<[string]>("SELECT settings_json FROM users WHERE id=?", [uid]))[0]?.[0]),
    ) as Dict;
    expect((stocke["mcp_servers"] as Dict[]).map((s) => s["id"])).toEqual(["ok"]);
  });

  it("welcome.scene qui n'est pas un objet : ignorée, le GET rend les défauts au lieu d'un 500", async () => {
    const config = join(ici, "config.json");
    const avant = readFileSync(config, "utf-8");
    try {
      for (const scene of ["texte", 5, [1, 2], true]) {
        writeFileSync(config, JSON.stringify({ welcome: { scene } }));
        invalidateConfigCache();
        const r = await requete(1, "GET");
        expect(r.statusCode, JSON.stringify(scene)).toBe(200);
        expect(r.json<Dict>()["mascottes_on"], JSON.stringify(scene)).toBe(true);
      }
    } finally {
      writeFileSync(config, avant);
      invalidateConfigCache();
    }
  });
});
