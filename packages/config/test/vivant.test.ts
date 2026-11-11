// SPDX-License-Identifier: MIT
/** packages/config/test/vivant.test.ts — cache de configView, écriture atomique, rechargements à chaud et fonctions relues à l'appel. */
import { DOSSIER_TEST } from "./environnement";

import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { poserCle, pyJsonDumps } from "@elpis/commun";

import {
  config,
  configView,
  dbPassword,
  featureEnabled,
  getDesktopTarget,
  getDesktopTargets,
  liveConfigValue,
  marquerCompressionAJour,
  maxRecentChats,
  readConfigJson,
  reinitialiserCaches,
  reloadCompressionConfigFromDisk,
  reloadDesktopConfigFromDisk,
  reloadMemoryConfigFromDisk,
  surchargerConfig,
  writeConfigJson,
  writeTextAtomic,
} from "../src/index";

let dossier = "";
let fichier = "";
let restaurer: () => void = () => undefined;

beforeEach(() => {
  dossier = realpathSync(mkdtempSync(path.join(DOSSIER_TEST, "vivant-")));
  fichier = path.join(dossier, "config.json");
  writeFileSync(fichier, JSON.stringify({ security: { session: { max_age_sec: 111 } } }));
  restaurer = surchargerConfig({ CONFIG_JSON_PATH: fichier, DB_PATH: path.join(dossier, "app.db") });
  reinitialiserCaches();
});

afterEach(() => {
  restaurer();
  reinitialiserCaches();
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(DOSSIER_TEST, { recursive: true, force: true });
});

/** Écrit comme un autre process : temporaire puis renommage (l'inode change, comme write_config_json, vi, sed -i). */
function ecrireAilleurs(donnees: unknown): void {
  const temporaire = `${fichier}.autre.tmp`;
  writeFileSync(temporaire, JSON.stringify(donnees));
  renameSync(temporaire, fichier);
}

describe("configView : cache invalidé par le disque", () => {
  it("relit une écriture faite par un autre process", () => {
    expect(liveConfigValue("security.session.max_age_sec")).toBe(111);
    ecrireAilleurs({ security: { session: { max_age_sec: 222 } } });
    expect(liveConfigValue("security.session.max_age_sec")).toBe(222);
  });

  it("relit même à taille identique : l'inode fait partie de la clé", () => {
    configView();
    const avant = statSync(fichier).size;
    ecrireAilleurs({ security: { session: { max_age_sec: 999 } } });
    expect(statSync(fichier).size).toBe(avant);
    expect(liveConfigValue("security.session.max_age_sec")).toBe(999);
  });

  it("rend le même objet tant que le fichier ne bouge pas, sans reparse", () => {
    const premiere = configView();
    const analyse = vi.spyOn(JSON, "parse");
    for (let i = 0; i < 50; i++) expect(configView()).toBe(premiere);
    expect(analyse).not.toHaveBeenCalled();
    ecrireAilleurs({ security: { session: { max_age_sec: 333 } } });
    expect(configView()).not.toBe(premiere);
    expect(analyse).toHaveBeenCalledTimes(1);
  });

  it("une écriture sur place, même taille et même mtime, n'est vue qu'après 1 s", () => {
    utimesSync(fichier, 1_000_000, 1_000_000);
    const t0 = performance.now();
    const horloge = vi.spyOn(performance, "now").mockReturnValue(t0);
    expect(liveConfigValue("security.session.max_age_sec")).toBe(111);
    writeFileSync(fichier, JSON.stringify({ security: { session: { max_age_sec: 999 } } }));
    utimesSync(fichier, 1_000_000, 1_000_000);
    horloge.mockReturnValue(t0 + 999);
    expect(liveConfigValue("security.session.max_age_sec")).toBe(111);
    horloge.mockReturnValue(t0 + 1001);
    expect(liveConfigValue("security.session.max_age_sec")).toBe(999);
  });

  it("fichier absent, supprimé ou invalide : {} et le défaut", () => {
    expect(liveConfigValue("security.session.max_age_sec")).toBe(111);
    rmSync(fichier);
    expect(configView()).toEqual({});
    writeFileSync(fichier, "{ pas du json");
    expect(readConfigJson()).toEqual({});
    expect(liveConfigValue("security.session.max_age_sec", 7)).toBe(7);
  });

  it("la vue partagée est gelée en profondeur", () => {
    const vue = configView() as { security: { session: { max_age_sec: number } } };
    expect(Object.isFrozen(vue)).toBe(true);
    expect(Object.isFrozen(vue.security.session)).toBe(true);
    expect(() => {
      vue.security.session.max_age_sec = 0;
    }).toThrow(TypeError);
  });
});

describe("readConfigJson et liveConfigValue rendent des copies", () => {
  it("readConfigJson : copie modifiable, le cache reste intact", () => {
    const copie = readConfigJson() as { security: { session: { max_age_sec: number } }; injecte?: boolean };
    copie.security.session.max_age_sec = 42;
    copie.injecte = true;
    expect(readConfigJson()).toEqual({ security: { session: { max_age_sec: 111 } } });
  });

  it("liveConfigValue : objets et listes copiés, chemin traversant un non-dict → défaut", () => {
    const session = liveConfigValue("security.session") as { max_age_sec: number };
    session.max_age_sec = 0;
    expect(liveConfigValue("security.session.max_age_sec")).toBe(111);
    ecrireAilleurs({ llm: "pas-un-dict", liste: [1, { a: 2 }] });
    expect(liveConfigValue("llm.scheduling_mode", "auto")).toBe("auto");
    const liste = liveConfigValue("liste") as unknown[];
    liste.push(3);
    expect(liveConfigValue("liste")).toEqual([1, { a: 2 }]);
  });
});

describe("writeConfigJson et writeTextAtomic", () => {
  it("écrit comme json.dumps(indent=2, ensure_ascii=False) et se relit aussitôt", () => {
    const donnees = readConfigJson();
    donnees["features"] = { truc: false };
    donnees["app"] = { nom: "Élpis", ratio: 0.5 };
    writeConfigJson(donnees);
    expect(featureEnabled("truc")).toBe(false);
    expect((readConfigJson()["features"] as Record<string, unknown>)["truc"]).toBe(false);
    expect(readFileSync(fichier, "utf-8")).toBe(pyJsonDumps(donnees, { ensureAscii: false, indent: 2 }));
    expect(readFileSync(fichier, "utf-8")).toContain('"nom": "Élpis"');
  });

  it("lire-modifier-écrire garde l'ordre Python des clés, entières comprises (texte inchangé hors ajouts)", () => {
    const avant =
      '{\n  "llm": {\n    "slots": {\n      "b": 1,\n      "10": 2,\n      "2": 3\n    }\n  },\n  "0": "zero",\n  "app": {\n    "nom": "Élpis"\n  }\n}';
    writeFileSync(fichier, avant);
    reinitialiserCaches();
    writeConfigJson(readConfigJson());
    expect(readFileSync(fichier, "utf-8")).toBe(avant);
    const donnees = readConfigJson();
    poserCle((donnees["llm"] as { slots: object }).slots, "7", 4);
    poserCle(donnees, "features", { "5": true, a: false });
    writeConfigJson(donnees);
    expect(readFileSync(fichier, "utf-8")).toBe(
      '{\n  "llm": {\n    "slots": {\n      "b": 1,\n      "10": 2,\n      "2": 3,\n      "7": 4\n    }\n  },\n  "0": "zero",\n  "app": {\n    "nom": "Élpis"\n  },\n  "features": {\n    "5": true,\n    "a": false\n  }\n}',
    );
  });

  it("reprend le mode du fichier existant, 0644 pour un fichier neuf, sans laisser de temporaire", () => {
    chmodSync(fichier, 0o640);
    writeConfigJson({ a: 1 });
    expect(statSync(fichier).mode & 0o777).toBe(0o640);
    const neuf = path.join(dossier, "sous", "neuf.json");
    writeTextAtomic(neuf, "{}");
    expect(statSync(neuf).mode & 0o777).toBe(0o644);
    expect(readdirSync(dossier).sort()).toEqual(["config.json", "sous"]);
    expect(readdirSync(path.join(dossier, "sous"))).toEqual(["neuf.json"]);
  });

  it("refuse une demi-paire UTF-16 (UnicodeEncodeError) sans toucher au fichier", () => {
    const avant = readFileSync(fichier, "utf-8");
    expect(() => writeTextAtomic(fichier, `x${String.fromCharCode(0xd800)}`)).toThrow();
    expect(readFileSync(fichier, "utf-8")).toBe(avant);
    expect(readdirSync(dossier)).toEqual(["config.json"]);
  });
});

describe("rechargements à chaud", () => {
  it("desktop : relit quand le mtime avance (repère par mtime, comme Python), pas sinon ; force relit toujours", () => {
    ecrireAilleurs({ vision: { passes: 3 } });
    expect(reloadDesktopConfigFromDisk()).toBe(true);
    expect(config.VISION_PASSES).toBe(3);
    expect(reloadDesktopConfigFromDisk()).toBe(false);
    expect(reloadDesktopConfigFromDisk(true)).toBe(true);
  });

  it("l'env du démarrage n'est pas réappliqué ; une clé absente garde la valeur courante", () => {
    const remettre = surchargerConfig({ VISION_MODEL: "modele-env", VISION_PROMPT: "prompt-env" });
    try {
      ecrireAilleurs({ vision: { model: " modele-fichier " } });
      reloadDesktopConfigFromDisk(true);
      expect(config.VISION_MODEL).toBe("modele-fichier");
      expect(config.VISION_PROMPT).toBe("prompt-env");
    } finally {
      remettre();
    }
  });

  it("fichier absent : rien n'est relu", () => {
    rmSync(fichier);
    expect(reloadDesktopConfigFromDisk(true)).toBe(false);
    expect(reloadCompressionConfigFromDisk(true)).toBe(false);
    expect(reloadMemoryConfigFromDisk(true)).toBe(false);
  });

  it("compression : seulement le sous-ensemble de Python", () => {
    const remettre = surchargerConfig({ COMPACTIONS_PER_RUN_MAX: 8, PRUNE_EVERY_ITERS: 10 });
    try {
      ecrireAilleurs({
        llm: { compaction: { per_run_max: 2, threshold_pct: 10 }, prune: { every_iters: 1 } },
      });
      expect(reloadCompressionConfigFromDisk()).toBe(true);
      expect(config.COMPACTION_THRESHOLD_PCT).toBe(30);
      expect(config.COMPACTIONS_PER_RUN_MAX).toBe(8);
      expect(config.PRUNE_EVERY_ITERS).toBe(10);
    } finally {
      remettre();
    }
  });

  it("marquerCompressionAJour : pas de relecture de sa propre écriture", () => {
    ecrireAilleurs({ llm: { compression: { keep_recent_turns: 9 } } });
    marquerCompressionAJour();
    expect(reloadCompressionConfigFromDisk()).toBe(false);
  });

  it("mémoire : bornes appliquées", () => {
    ecrireAilleurs({ memory: { enabled: 0, memory_char_limit: 10, user_char_limit: "99999" } });
    expect(reloadMemoryConfigFromDisk()).toBe(true);
    expect([config.MEMORY_ENABLED, config.MEMORY_MD_CHAR_LIMIT, config.USER_MD_CHAR_LIMIT]).toEqual([
      false,
      200,
      20000,
    ]);
  });

  it("cibles desktop relues du disque, copie de la liste rendue", () => {
    ecrireAilleurs({
      desktop: {
        targets: [
          { name: "a", agent_url: "http://a/" },
          { name: "b", agent_url: "http://b", default: true },
        ],
      },
    });
    expect(getDesktopTarget("a")?.agent_url).toBe("http://a");
    expect(getDesktopTarget("")?.name).toBe("b");
    expect(getDesktopTarget("inconnue")?.name).toBe("b");
    const cibles = getDesktopTargets(false);
    cibles.pop();
    expect(config.DESKTOP_TARGETS).toHaveLength(2);
    ecrireAilleurs({ desktop: { targets: [] } });
    const plusTard = new Date(Date.now() + 10_000);
    utimesSync(fichier, plusTard, plusTard);
    expect(getDesktopTarget("a")).toBeNull();
  });
});

describe("fonctions relues à l'appel", () => {
  const avecEnv = <T>(nom: string, valeur: string | undefined, f: () => T): T => {
    const avant = process.env[nom];
    if (valeur === undefined) delete process.env[nom];
    else process.env[nom] = valeur;
    try {
      return f();
    } finally {
      if (avant === undefined) delete process.env[nom];
      else process.env[nom] = avant;
    }
  };

  it("maxRecentChats : APP_MAX_RECENT_CHATS prime (même vide), sinon config.json, plancher 1", () => {
    const remettre = surchargerConfig({ MAX_RECENT_CHATS: 40 });
    try {
      ecrireAilleurs({ app: { max_recent_chats: 0 } });
      expect(avecEnv("APP_MAX_RECENT_CHATS", undefined, maxRecentChats)).toBe(1);
      expect(avecEnv("APP_MAX_RECENT_CHATS", "", maxRecentChats)).toBe(40);
      ecrireAilleurs({ app: { max_recent_chats: "x" } });
      expect(avecEnv("APP_MAX_RECENT_CHATS", undefined, maxRecentChats)).toBe(40);
    } finally {
      remettre();
    }
  });

  it("dbPassword : env, sinon .db_password près de la base (blancs retirés), sinon vide", () => {
    expect(avecEnv("APP_DB_PASSWORD", undefined, dbPassword)).toBe("");
    writeFileSync(path.join(dossier, ".db_password"), "  secret-fichier \n");
    expect(avecEnv("APP_DB_PASSWORD", undefined, dbPassword)).toBe("secret-fichier");
    expect(avecEnv("APP_DB_PASSWORD", "env", dbPassword)).toBe("env");
    writeFileSync(path.join(dossier, ".db_password"), Buffer.from("mdp\xff", "latin1"));
    expect(() => avecEnv("APP_DB_PASSWORD", undefined, dbPassword)).toThrow(
      expect.objectContaining({ type: "ValueError" }),
    );
  });
});
