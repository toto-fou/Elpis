// SPDX-License-Identifier: MIT
/** packages/config/test/vecteurs.test.ts — réglages, lectures, avertissements, fonctions et rechargements rejouent les vecteurs Python. */
import { DOSSIER_TEST } from "./environnement";

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { comparePointsDeCode, ErreurPython } from "@elpis/commun";

import {
  asBool,
  asFloat,
  asInt,
  asStr,
  deepGet,
  pyParent,
  pyPath,
  readJsonFile,
  resolveConfigJsonPath,
} from "../src/brut";
import { reinitialiserCaches, surchargerConfig } from "../src/index";
import {
  builtinLocalMcpDepuis,
  builtinLocalMcpUrlDepuis,
  calculerReglages,
  coerceDesktopTargets,
  parseClientTokenFamilies,
  parseClientTokens,
  retiredBackendMessage,
} from "../src/reglages";
import type { Reglages } from "../src/reglages";
import {
  builtinLocalMcp,
  builtinLocalMcpUrl,
  dbPassword,
  featureEnabled,
  getDesktopTarget,
  httpsEnabled,
  httpsPorts,
  liveConfigValue,
  maxRecentChats,
  reloadCompressionConfigFromDisk,
  reloadDesktopConfigFromDisk,
  reloadMemoryConfigFromDisk,
  safeSandboxName,
  sandboxImportMaxPct,
  sessionCookieAttrs,
} from "../src/vivant";
import { config } from "../src/instance";

interface Fichier {
  chemin: string;
  texte?: string;
  hex?: string;
  mode?: number;
}

type Appel = { valeur: unknown } | { erreur: string };

interface Fonctions {
  feature_enabled: Record<string, Appel>;
  feature_enabled_defaut_faux: Appel;
  https_enabled: Appel;
  https_ports: Appel;
  session_cookie_attrs: Appel;
  max_recent_chats: Appel;
  sandbox_import_max_pct: Appel;
  db_password: Appel;
  live_config_value: [string, unknown, Appel][];
  builtin_local_mcp: Appel;
  builtin_local_mcp_url: Appel;
  get_desktop_target: [string, Appel][];
}

interface Attendu {
  erreur?: string;
  reglages?: Record<string, unknown>;
  lectures?: { en_moins: string[]; en_plus: string[] };
  avertissements?: string[];
  fonctions?: Fonctions;
  rechargement?: {
    retours: Record<"desktop" | "compression" | "memoire", boolean[]>;
    reglages: Record<string, unknown>;
  };
  modes?: Record<string, string | null>;
}

interface Scenario {
  nom: string;
  env?: Record<string, string>;
  config?: string | null;
  config_hex?: string;
  fichiers?: Fichier[];
  dossiers?: string[];
  liens?: { chemin: string; cible: string }[];
  modes?: string[];
  config_rechargee?: string | null;
  attendu: Attendu;
}

interface CasPur {
  entree: unknown[];
  valeur?: unknown;
  erreur?: string;
}

interface Vecteurs {
  cles: string[];
  reference: { scenario: string; reglages: Record<string, unknown>; lectures: string[] };
  scenarios: Scenario[];
  variantes: Scenario[];
  fonctions_pures: Record<string, CasPur[]>;
}

const RACINE = realpathSync(path.resolve(import.meta.dirname, "..", "..", ".."));
const vecteurs = JSON.parse(
  readFileSync(new URL("./vecteurs/reglages.json", import.meta.url), "utf-8"),
) as Vecteurs;
const FLOTTANTS: Readonly<Record<string, number>> = { nan: Number.NaN, inf: Infinity, "-inf": -Infinity };
const PROMPTS = [
  "SYSTEM_PROMPT_DEFAULT",
  "SYSTEM_PROMPT_AX_MEMORY_HEADER",
  "SYSTEM_PROMPT_COMPRESSOR",
] as const;
const ENV_LU_A_L_APPEL = ["APP_MAX_RECENT_CHATS", "APP_DB_PASSWORD"] as const;

afterAll(() => {
  rmSync(DOSSIER_TEST, { recursive: true, force: true });
});

function decoder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decoder);
  if (v !== null && typeof v === "object") {
    const special = (v as Record<string, unknown>)["$flottant"];
    if (typeof special === "string") return FLOTTANTS[special];
    return Object.fromEntries(Object.entries(v).map(([cle, valeur]) => [cle, decoder(valeur)]));
  }
  return v;
}

function jetons(tmp: string): [string, string][] {
  const liste: [string, string][] = [
    [RACINE, "<RACINE>"],
    [tmp, "<TMP>"],
  ];
  const parent = path.dirname(RACINE);
  if (parent !== "/") liste.push([parent, "<RACINE>/.."]);
  return liste;
}

/** Même forme que la sonde Python : chemins portables, ensembles triés, flottants non finis encodés. */
function normaliser(v: unknown, j: [string, string][]): unknown {
  if (typeof v === "string") {
    for (const [prefixe, jeton] of j)
      if (v === prefixe || v.startsWith(`${prefixe}/`)) return jeton + v.slice(prefixe.length);
    return v;
  }
  if (typeof v === "number" && !Number.isFinite(v)) {
    return { $flottant: Number.isNaN(v) ? "nan" : v > 0 ? "inf" : "-inf" };
  }
  if (v instanceof Set) return [...v].map((x) => normaliser(x, j) as string).sort(comparePointsDeCode);
  if (Array.isArray(v)) return v.map((x) => normaliser(x, j));
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([cle, valeur]) => [cle, normaliser(valeur, j)]));
  }
  return v;
}

function normaliserReglages(reglages: Reglages, j: [string, string][]): Record<string, unknown> {
  const n = normaliser(reglages, j) as Record<string, unknown>;
  if (/^\d+-[0-9a-f]{6}$/.test(String(n["BUILD_ID"]))) n["BUILD_ID"] = "<VOLATIL>";
  if (/^(?:ELPIS_[0-9a-f]{64}|EPHEMERAL_[0-9a-f]{32})$/.test(String(n["SESSION_SECRET"]))) {
    n["SESSION_SECRET"] = "<VOLATIL>";
  }
  for (const cle of PROMPTS) if (String(n[`${cle}_PATH`]).startsWith("<RACINE>")) n[cle] = "<DEPOT>";
  return n;
}

/** Dossiers de données dont le défaut TS suit la base d'une instance déplacée (écart au Python) : [réglage, nom, défaut Python normalisé]. */
const DONNEES_SOUS_LA_BASE: readonly [string, string, string][] = [
  ["MCP_SERVERS_DIR", "mcp_custom_servers", "<RACINE>/../mcp_custom_servers"],
  ["USER_SKILLS_DIR", "user_skills", "<RACINE>/user_skills"],
  ["SKINS_DIR", "user_skins", "<RACINE>/user_skins"],
];

/** Valeurs attendues du Python, corrigées de l'écart : base hors `<racine>/user_db` et défaut Python pris = dossier voisin de la base. */
function avecEcartDonnees(
  attendus: Record<string, unknown>,
  obtenus: Record<string, unknown>,
): Record<string, unknown> {
  const base = String(obtenus["DB_PATH"]);
  const dossierBase = base.slice(0, base.lastIndexOf("/"));
  if (dossierBase === "<RACINE>/user_db") return attendus;
  const corrige = { ...attendus };
  for (const [cle, nom, defautPython] of DONNEES_SOUS_LA_BASE)
    if (attendus[cle] === defautPython) corrige[cle] = `${dossierBase}/${nom}`;
  return corrige;
}

/** Réglages retirés du TS depuis les vecteurs (écart voulu) : `mcp.server_cmd`, sans lecteur depuis le retrait d'elpis-tools ; `llm.max_runs_per_user`, remplacé par `llm.max_requests_per_user` ; `BACKEND_DIR`, dossier de shared_infra retiré. */
const RETIRES: readonly string[] = ["MCP_SERVER_CMD", "MAX_RUNS_PER_USER", "BACKEND_DIR"];
const LECTURES_RETIREES: readonly string[] = ["mcp.server_cmd", "llm.max_runs_per_user"];
const CLES = vecteurs.cles.filter((c) => !RETIRES.includes(c));

/** Écart voulu : chaque machine de bureau porte `agent_token` (vide sans jeton propre). */
function avecJetonAgent(v: unknown): unknown {
  const cible = (t: unknown): unknown =>
    typeof t === "object" && t !== null && !Array.isArray(t) && "agent_url" in t && !("agent_token" in t)
      ? { ...t, agent_token: "" }
      : t;
  return Array.isArray(v) ? v.map(cible) : cible(v);
}

/** Valeurs attendues du Python sans les réglages retirés, machines de bureau munies de leur jeton. */
function avecEcartsRetraits(attendus: Record<string, unknown>): Record<string, unknown> {
  const corrige = { ...attendus };
  for (const cle of RETIRES) delete corrige[cle];
  if ("DESKTOP_TARGETS" in corrige) corrige["DESKTOP_TARGETS"] = avecJetonAgent(corrige["DESKTOP_TARGETS"]);
  const lus = corrige["BOOT_READ_PATHS"];
  if (Array.isArray(lus))
    corrige["BOOT_READ_PATHS"] = lus.filter((l) => !LECTURES_RETIREES.includes(String(l)));
  return corrige;
}

function appel(fonction: () => unknown, j: [string, string][]): Appel {
  try {
    return { valeur: normaliser(fonction(), j) };
  } catch (e) {
    return { erreur: e instanceof ErreurPython ? e.type : String(e) };
  }
}

/** Défaut de `MCP_SERVERS_DIR` (`<dépôt>/../mcp_custom_servers`), créé par tout scénario qui n'en donne pas. */
const MCP_PAR_DEFAUT = path.join(path.dirname(RACINE), "mcp_custom_servers");

interface Prepare {
  tmp: string;
  env: Record<string, string>;
  mcpAvant: boolean;
}

/** Temporaire du scénario supprimé, et le dossier MCP par défaut s'il est apparu pendant le scénario (vide). */
function nettoyer({ tmp, mcpAvant }: Prepare): void {
  rmSync(tmp, { recursive: true, force: true });
  if (!mcpAvant && existsSync(MCP_PAR_DEFAUT) && readdirSync(MCP_PAR_DEFAUT).length === 0)
    rmdirSync(MCP_PAR_DEFAUT);
}

function preparer(scenario: Scenario): Prepare {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "vecteurs-config-")));
  const sub = (v: string): string => v.replaceAll("<TMP>", tmp);
  for (const dossier of scenario.dossiers ?? []) mkdirSync(sub(dossier), { recursive: true });
  for (const lien of scenario.liens ?? []) symlinkSync(sub(lien.cible), sub(lien.chemin));
  for (const fichier of scenario.fichiers ?? []) {
    const chemin = sub(fichier.chemin);
    mkdirSync(path.dirname(chemin), { recursive: true });
    writeFileSync(
      chemin,
      fichier.hex !== undefined ? Buffer.from(fichier.hex, "hex") : sub(fichier.texte ?? ""),
    );
    if (fichier.mode !== undefined) chmodSync(chemin, fichier.mode);
  }
  const cheminConfig = path.join(tmp, "config.json");
  if (scenario.config_hex !== undefined) writeFileSync(cheminConfig, Buffer.from(scenario.config_hex, "hex"));
  else if (scenario.config != null) writeFileSync(cheminConfig, sub(scenario.config));
  const env: Record<string, string> = { APP_CONFIG_PATH: cheminConfig };
  for (const [nom, valeur] of Object.entries(scenario.env ?? {})) env[nom] = sub(valeur);
  return { tmp, env, mcpAvant: existsSync(MCP_PAR_DEFAUT) };
}

interface Capture {
  resultat?: ReturnType<typeof calculerReglages>;
  erreur?: unknown;
  sortie: string;
  erreurs: string;
}

/** Calcule les réglages comme un import neuf, en recueillant stdout et stderr. */
function calculer(env: Record<string, string>): Capture {
  const capture: Capture = { sortie: "", erreurs: "" };
  const so = vi.spyOn(process.stdout, "write").mockImplementation(((morceau: string) => {
    capture.sortie += morceau;
    return true;
  }) as typeof process.stdout.write);
  const se = vi.spyOn(process.stderr, "write").mockImplementation(((morceau: string) => {
    capture.erreurs += morceau;
    return true;
  }) as typeof process.stderr.write);
  try {
    const cheminConfig = resolveConfigJsonPath(env, RACINE);
    capture.resultat = calculerReglages(env, readJsonFile(cheminConfig), RACINE, cheminConfig);
  } catch (e) {
    capture.erreur = e;
  } finally {
    so.mockRestore();
    se.mockRestore();
  }
  return capture;
}

function avertissements(capture: Capture): string[] {
  const marques: [string, string, string][] = [
    ["ancien_emplacement", "ANCIEN emplacement", capture.sortie],
    ["secret_faible", "SESSION_SECRET FAIBLE", capture.erreurs],
    ["secret_ephemere", "SESSION_SECRET est ÉPH", capture.erreurs],
    ["mode_secret", "remis en 0600", capture.erreurs],
    ["base_inconnue", "inconnu — SQLite utilis", capture.erreurs],
    ["base_retiree", "MariaDB/MySQL n'est plus pris en charge", capture.erreurs],
  ];
  return marques.filter(([, motif, texte]) => texte.includes(motif)).map(([nom]) => nom);
}

function verifierErreur(capture: Capture, attendue: string, libelle: string): void {
  expect(capture.erreur, `${libelle} : Python lève ${attendue}`).toBeInstanceOf(ErreurPython);
  expect((capture.erreur as ErreurPython).type, libelle).toBe(attendue);
}

/** Exécute `f` avec l'env lu à l'appel (`APP_MAX_RECENT_CHATS`, `APP_DB_PASSWORD`) du scénario. */
function avecEnvDAppel<T>(env: Record<string, string>, f: () => T): T {
  const avant = ENV_LU_A_L_APPEL.map((nom) => [nom, process.env[nom]] as const);
  for (const nom of ENV_LU_A_L_APPEL) {
    if (env[nom] === undefined) delete process.env[nom];
    else process.env[nom] = env[nom];
  }
  try {
    return f();
  } finally {
    for (const [nom, valeur] of avant) {
      if (valeur === undefined) delete process.env[nom];
      else process.env[nom] = valeur;
    }
  }
}

function verifierFonctions(attendu: Fonctions, j: [string, string][], libelle: string): void {
  for (const [nom, resultat] of Object.entries(attendu.feature_enabled)) {
    expect(
      appel(() => featureEnabled(nom), j),
      `${libelle} feature_enabled(${nom})`,
    ).toEqual(resultat);
  }
  expect(appel(() => featureEnabled("absente", false), j)).toEqual(attendu.feature_enabled_defaut_faux);
  expect(appel(httpsEnabled, j), `${libelle} https_enabled`).toEqual(attendu.https_enabled);
  expect(appel(httpsPorts, j), `${libelle} https_ports`).toEqual(attendu.https_ports);
  expect(appel(sessionCookieAttrs, j), `${libelle} session_cookie_attrs`).toEqual(
    attendu.session_cookie_attrs,
  );
  expect(appel(maxRecentChats, j), `${libelle} max_recent_chats`).toEqual(attendu.max_recent_chats);
  expect(appel(sandboxImportMaxPct, j), `${libelle} sandbox_import_max_pct`).toEqual(
    attendu.sandbox_import_max_pct,
  );
  expect(appel(dbPassword, j), `${libelle} db_password`).toEqual(attendu.db_password);
  for (const [chemin, defaut, resultat] of attendu.live_config_value) {
    expect(
      appel(() => liveConfigValue(chemin, defaut), j),
      `${libelle} live_config_value(${chemin})`,
    ).toEqual(resultat);
  }
  expect(appel(builtinLocalMcp, j), `${libelle} builtin_local_mcp`).toEqual(attendu.builtin_local_mcp);
  expect(appel(builtinLocalMcpUrl, j), `${libelle} builtin_local_mcp_url`).toEqual(
    attendu.builtin_local_mcp_url,
  );
  for (const [nom, resultat] of attendu.get_desktop_target) {
    expect(
      appel(() => getDesktopTarget(nom, false), j),
      `${libelle} get_desktop_target(${nom})`,
    ).toEqual("valeur" in resultat ? { valeur: avecJetonAgent(resultat.valeur) } : resultat);
  }
}

function rejouerScenario(scenario: Scenario, tmp: string, env: Record<string, string>): void {
  const j = jetons(tmp);
  const capture = calculer(env);
  const { attendu } = scenario;
  if (attendu.erreur !== undefined) return verifierErreur(capture, attendu.erreur, scenario.nom);
  expect(capture.erreur, `${scenario.nom} : ${String(capture.erreur)}`).toBeUndefined();
  const { reglages, lectures } = capture.resultat as ReturnType<typeof calculerReglages>;
  const obtenus = normaliserReglages(reglages, j);
  expect(
    Object.keys(obtenus).sort(),
    "mêmes noms de réglages que le module Python, moins les retirés",
  ).toEqual(CLES);
  const attendus = avecEcartsRetraits(
    avecEcartDonnees({ ...vecteurs.reference.reglages, ...attendu.reglages }, obtenus),
  );
  for (const cle of CLES) expect(obtenus[cle], `${scenario.nom} › ${cle}`).toEqual(attendus[cle]);
  const enMoins = new Set(attendu.lectures?.en_moins ?? []);
  const lecturesAttendues = [
    ...vecteurs.reference.lectures.filter((l) => !enMoins.has(l) && !LECTURES_RETIREES.includes(l)),
    ...(attendu.lectures?.en_plus ?? []),
  ].sort(comparePointsDeCode);
  expect([...lectures].sort(comparePointsDeCode), `${scenario.nom} › BOOT_READ_PATHS`).toEqual(
    lecturesAttendues,
  );
  expect(avertissements(capture), `${scenario.nom} › avertissements`).toEqual(attendu.avertissements);
  for (const [chemin, mode] of Object.entries(attendu.modes ?? {})) {
    const reel = chemin.replaceAll("<TMP>", tmp);
    expect(`0o${(statSync(reel).mode & 0o777).toString(8)}`, `${scenario.nom} › mode de ${chemin}`).toBe(
      mode,
    );
  }
  if (attendu.fonctions === undefined) return;
  const restaurer = surchargerConfig(reglages);
  reinitialiserCaches();
  try {
    avecEnvDAppel(env, () => verifierFonctions(attendu.fonctions as Fonctions, j, scenario.nom));
    if (attendu.rechargement !== undefined && scenario.config_rechargee != null) {
      writeFileSync(reglages.CONFIG_JSON_PATH, scenario.config_rechargee.replaceAll("<TMP>", tmp));
      const retours = {
        desktop: [
          reloadDesktopConfigFromDisk(),
          reloadDesktopConfigFromDisk(),
          reloadDesktopConfigFromDisk(true),
        ],
        compression: [
          reloadCompressionConfigFromDisk(),
          reloadCompressionConfigFromDisk(),
          reloadCompressionConfigFromDisk(true),
        ],
        memoire: [
          reloadMemoryConfigFromDisk(),
          reloadMemoryConfigFromDisk(),
          reloadMemoryConfigFromDisk(true),
        ],
      };
      expect(retours, `${scenario.nom} › retours des rechargements`).toEqual(attendu.rechargement.retours);
      const apres = normaliser(config, j) as Record<string, unknown>;
      for (const [cle, valeur] of Object.entries(attendu.rechargement.reglages)) {
        expect(apres[cle], `${scenario.nom} › rechargé › ${cle}`).toEqual(
          cle === "DESKTOP_TARGETS" ? avecJetonAgent(valeur) : valeur,
        );
      }
    }
  } finally {
    restaurer();
    reinitialiserCaches();
  }
}

describe("scénarios Python de shared_infra.config", () => {
  it(`couvre ${vecteurs.scenarios.length} scénarios et ${vecteurs.cles.length} réglages`, () => {
    expect(vecteurs.scenarios.length).toBeGreaterThanOrEqual(12);
    expect(vecteurs.cles.length).toBe(163);
    expect(vecteurs.scenarios[0]?.nom).toBe(vecteurs.reference.scenario);
  });

  for (const scenario of vecteurs.scenarios) {
    it(scenario.nom, () => {
      const p = preparer(scenario);
      try {
        rejouerScenario(scenario, p.tmp, p.env);
      } finally {
        nettoyer(p);
      }
    });
  }

  it("un prompt du dépôt est lu tel quel (fins de ligne universelles)", () => {
    const p = preparer(vecteurs.scenarios[0] as Scenario);
    try {
      const { resultat } = calculer(p.env);
      const fichier = path.join(RACINE, "system_prompts", "CHATBOT_SYSTEM.md");
      const texte = readFileSync(fichier, "utf-8").replace(/\r\n?/g, "\n");
      expect(resultat?.reglages.SYSTEM_PROMPT_DEFAULT).toBe(texte);
      expect(texte.length).toBeGreaterThan(0);
    } finally {
      nettoyer(p);
    }
  });
});

describe("variantes Python (clés ciblées)", () => {
  // Écart voulu : les variantes « runs … » testent `llm.max_runs_per_user`, retiré.
  for (const variante of vecteurs.variantes.filter((v) => !v.nom.startsWith("runs "))) {
    it(variante.nom, () => {
      const p = preparer(variante);
      const { tmp } = p;
      try {
        const capture = calculer(p.env);
        if (variante.attendu.erreur !== undefined)
          return verifierErreur(capture, variante.attendu.erreur, variante.nom);
        expect(capture.erreur, `${variante.nom} : ${String(capture.erreur)}`).toBeUndefined();
        const obtenus = normaliserReglages(
          (capture.resultat as ReturnType<typeof calculerReglages>).reglages,
          jetons(tmp),
        );
        const attendus = avecEcartsRetraits(avecEcartDonnees(variante.attendu.reglages ?? {}, obtenus));
        for (const [cle, valeur] of Object.entries(attendus)) {
          expect(obtenus[cle], `${variante.nom} › ${cle}`).toEqual(valeur);
        }
      } finally {
        nettoyer(p);
      }
    });
  }
});

const PURES: Readonly<Record<string, (...args: unknown[]) => unknown>> = {
  as_int: (v, d) => asInt(v, d as number),
  as_float: (v, d) => asFloat(v, d as number),
  as_str: (v, d) => asStr(v, d as string),
  as_bool: (v, d) => asBool(v, d),
  deep_get: (d, chemin, defaut) => deepGet(d, chemin as string, defaut),
  coerce_desktop_targets: (v) => coerceDesktopTargets(v),
  parse_client_tokens: (e, c) => parseClientTokens(e, c),
  parse_client_token_families: (e, c) => parseClientTokenFamilies(e, c),
  safe_sandbox_name: (nom) => safeSandboxName(nom as string | null),
  chemin_pur: (p) => [pyPath(p as string), pyParent(p as string)],
  mcp_integre: (hote, port, brut) => {
    const d = builtinLocalMcpDepuis(hote as string, port as number, brut);
    return [d, appel(() => builtinLocalMcpUrlDepuis(d), [])];
  },
  retired_backend_message: (moteur) => retiredBackendMessage(moteur as string),
};

describe("fonctions pures de config.py", () => {
  for (const [nom, fonction] of Object.entries(PURES)) {
    it(`${nom} : ${vecteurs.fonctions_pures[nom]?.length ?? 0} cas`, () => {
      const cas = vecteurs.fonctions_pures[nom] ?? [];
      expect(cas.length).toBeGreaterThan(3);
      for (const { entree, ...resultat } of cas) {
        const voulu =
          nom === "coerce_desktop_targets" && "valeur" in resultat
            ? { valeur: avecJetonAgent(resultat.valeur) }
            : resultat;
        expect(
          appel(() => fonction(...(decoder(entree) as unknown[])), []),
          `${nom}(${JSON.stringify(entree)})`,
        ).toEqual(voulu);
      }
    });
  }

  it("safe_sandbox_name : au moins 30 noms piégeux", () => {
    expect(vecteurs.fonctions_pures["safe_sandbox_name"]?.length).toBeGreaterThanOrEqual(30);
  });

  it("les tables de jetons n'héritent de rien : constructor ou __proto__ ne sont pas des jetons", () => {
    const jetons = parseClientTokens("tok:alice:git", null);
    const familles = parseClientTokenFamilies("tok:alice:git", null);
    for (const cle of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(jetons[cle], cle).toBeUndefined();
      expect(familles[cle], cle).toBeUndefined();
    }
    expect(jetons["tok"]).toBe("alice");
    expect(parseClientTokens(null, { __proto__: "x" })).toEqual({});
    expect(Object.keys(parseClientTokens("__proto__:mallory", null))).toEqual(["__proto__"]);
  });
});
