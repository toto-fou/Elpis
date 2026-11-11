// SPDX-License-Identifier: MIT
/** packages/fichiers/test/historique.test.ts — historique des fichiers : sessions, versions, renommages, blobs, verrou partagé avec un autre processus. */
import { mkdirSync, readFileSync, readdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";

import { config } from "@elpis/config";
import { tenirParAutreProcessus } from "@elpis/verrous/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  currentSession,
  dossierCompte,
  elaguer,
  fileEntry,
  getBlob,
  MAX_FILE,
  normRel,
  nouvelIdSession,
  recordMove,
  recordWrite,
  sessionInfo,
  sessions,
  shaOf,
  startSession,
  TOO_BIG,
  UNKNOWN,
} from "../src/historique";
import type { ContenuHistorique } from "../src/historique";
import { dossierTemporaire } from "./aides";

let racine: string;
let nettoyer: () => void;

beforeEach(() => {
  [racine, nettoyer] = dossierTemporaire("elpis-historique-");
  vi.stubEnv("APP_FILE_HISTORY_DIR", racine);
});

afterEach(() => {
  vi.unstubAllEnvs();
  nettoyer();
});

describe("sessions", () => {
  it("id horodaté à l'heure locale, suffixe aléatoire", () => {
    const d = new Date(2026, 9, 9, 7, 5, 3);
    expect(nouvelIdSession(d)).toMatch(/^20261009-070503-[0-9a-f]{6}$/u);
    expect(nouvelIdSession(d)).not.toBe(nouvelIdSession(d));
  });

  it("start_session écrit session.json au format Python ; current_session le relit", async () => {
    const sid = await startSession(7);
    const brut = readFileSync(path.join(racine, "7", "session.json"), "utf-8");
    expect(brut).toMatch(new RegExp(`^\\{"id": "${sid}", "started": \\d+\\.\\d+\\}$`, "u"));
    expect(await currentSession(7)).toBe(sid);
    expect(readdirSync(path.join(racine, "7"))).toEqual(["session.json"]);
  });

  it("current_session crée la session au besoin ; JSON illisible ou id vide : nouvelle session", async () => {
    const sid = await currentSession(3);
    expect(await currentSession(3)).toBe(sid);
    for (const contenu of ["{", "[]", '{"id": ""}', '{"id": 5}', "\xff"]) {
      writeFileSync(path.join(racine, "3", "session.json"), contenu, "latin1");
      const autre = await currentSession(3);
      expect(autre, contenu).not.toBe(sid);
    }
  });

  it("élagage au-delà du plafond disque (taille apparente, fichiers creux) : les plus anciennes partent, jamais la courante", async () => {
    const d = dossierCompte(6);
    for (const [s, taille] of [
      ["20260101-000000-aaaaaa", 200],
      ["20260102-000000-bbbbbb", 150],
      ["20260103-000000-cccccc", 10],
    ] as const) {
      mkdirSync(path.join(d, s, "blobs"), { recursive: true });
      writeFileSync(path.join(d, s, "blobs", "x"), "");
      truncateSync(path.join(d, s, "blobs", "x"), taille * 1024 * 1024);
    }
    await elaguer(6, "20260103-000000-cccccc");
    expect(await sessions(6)).toEqual(["20260102-000000-bbbbbb", "20260103-000000-cccccc"]);
  });

  it("élagage : les plus anciennes au-delà de trois (la courante comprise) ; un lien compte mais n'est jamais supprimé", async () => {
    const d = dossierCompte(5);
    for (const s of [
      "20260101-000000-aaaaaa",
      "20260102-000000-bbbbbb",
      "20260103-000000-cccccc",
      "20260104-000000-dddddd",
    ])
      mkdirSync(path.join(d, s), { recursive: true });
    mkdirSync(path.join(racine, "ailleurs"));
    symlinkSync(path.join(racine, "ailleurs"), path.join(d, "20250101-000000-lienlien"));
    await elaguer(5, "20260104-000000-dddddd");
    expect(await sessions(5)).toEqual([
      "20250101-000000-lienlien",
      "20260102-000000-bbbbbb",
      "20260103-000000-cccccc",
      "20260104-000000-dddddd",
    ]);
  });

  it("chemin du compte : uid entier, racine relue à chaque appel", () => {
    expect(dossierCompte(12)).toBe(path.join(racine, "12"));
    vi.stubEnv("APP_FILE_HISTORY_DIR", "");
    expect(dossierCompte(12)).toBe(path.join(config.PROJECT_ROOT, "user_db", "file_history", "12"));
  });
});

describe("verrou du compte tenu par un autre processus (flock, hors de l'hôte)", () => {
  it("verrou du compte tenu par un autre processus : l'hôte attend 5 s au plus puis continue", async () => {
    mkdirSync(dossierCompte(9), { recursive: true });
    const detenteur = await tenirParAutreProcessus(
      path.join(dossierCompte(9), ".lock"),
      path.join(racine, "compteur"),
      30,
    );
    try {
      const debut = performance.now();
      const sid = await startSession(9);
      const duree = performance.now() - debut;
      expect(duree).toBeGreaterThan(4_500);
      expect(duree).toBeLessThan(15_000);
      expect(await currentSession(9)).toBe(sid);
    } finally {
      detenteur.tuer();
      await detenteur.fin;
    }
  }, 60_000);
});

const b = (t: string): Buffer => Buffer.from(t);

interface Version {
  readonly sha: string | null;
  readonly source?: string;
  readonly exists?: boolean;
  readonly too_big?: boolean;
}

interface Entree {
  readonly original: Version;
  readonly versions: Version[];
  readonly path?: string;
  readonly moved_from?: string;
}

/** Entrée de l'index, relue par `fileEntry`. */
async function entree(uid: number, rel: string): Promise<Entree> {
  return (await fileEntry(uid, rel)) as unknown as Entree;
}

async function fichiers(uid: number): Promise<Record<string, unknown>[]> {
  return (await sessionInfo(uid))["files"] as Record<string, unknown>[];
}

describe("versions (tests de file_history.py)", () => {
  it("original puis versions ; une écriture identique est ignorée", async () => {
    await startSession(1);
    await recordWrite(1, "work/a.py", b("v0"), b("v1"), "editor");
    await recordWrite(1, "a.py", b("v1"), b("v2"), "assistant");
    await recordWrite(1, "/a.py", b("v2"), b("v2"), "assistant");
    const e = await entree(1, "./a.py");
    expect((await getBlob(1, e.original.sha))?.toString()).toBe("v0");
    expect(await Promise.all(e.versions.map(async (v) => (await getBlob(1, v.sha))?.toString()))).toEqual([
      "v1",
      "v2",
    ]);
    expect(e.versions.map((v) => v.source)).toEqual(["editor", "assistant"]);
    expect(e.path).toBe("a.py");
    const info = await sessionInfo(1);
    expect((info["files"] as Record<string, unknown>[])[0]).toMatchObject({
      path: "a.py",
      versions: 2,
      original_exists: true,
      deleted: false,
    });
  });

  it("création et suppression ; état intermédiaire hors historique gardé en « other »", async () => {
    await startSession(1);
    await recordWrite(1, "n.txt", null, b("x"), "assistant");
    await recordWrite(1, "n.txt", b("x"), null, "editor");
    let e = await entree(1, "n.txt");
    expect(e.original.exists).toBe(false);
    expect(e.versions.at(-1)?.exists).toBe(false);
    expect((await fichiers(1))[0]?.["deleted"]).toBe(true);
    await recordWrite(1, "n.txt", b("modifié ailleurs"), b("y"), "zzz");
    e = await entree(1, "n.txt");
    expect(e.versions.map((v) => v.source)).toEqual(["assistant", "editor", "other", "other"]);
  });

  it("nouvelle session, nouvel original ; renommage d'un dossier ; trop gros ; noms refusés", async () => {
    await startSession(1);
    await recordWrite(1, "a", b("0"), b("1"));
    await startSession(1);
    expect(await fileEntry(1, "a")).toBeNull();
    await recordWrite(1, "a", b("1"), b("2"));
    expect((await getBlob(1, (await entree(1, "a")).original.sha))?.toString()).toBe("1");
    await recordWrite(1, "d/a", b("0"), b("1"));
    await recordMove(1, "d", "e");
    expect((await entree(1, "e/a")).moved_from).toBe("d/a");
    expect(await fileEntry(1, "d/a")).toBeNull();
    const gros = Buffer.alloc(MAX_FILE + 1);
    await recordWrite(1, "big", gros, TOO_BIG);
    const e = await entree(1, "big");
    expect(e.original).toEqual({ exists: true, sha: null, size: -1, too_big: true });
    expect(e.versions[0]?.too_big).toBe(true);
    await recordWrite(1, "inconnu", UNKNOWN, b("z"));
    expect((await entree(1, "inconnu")).original).toEqual({
      exists: true,
      sha: null,
      size: -1,
      unknown: true,
    });
    expect([normRel("../x"), normRel("work"), normRel("a\\b"), normRel(" /./work/a//b/ ")]).toEqual([
      "",
      "",
      "a\\b",
      "a/b",
    ]);
    expect(shaOf(gros)).toBeNull();
    expect(shaOf(TOO_BIG as ContenuHistorique)).toBeNull();
    expect(await getBlob(1, "../../etc/passwd")).toBeNull();
  });

  it("au plus 100 versions par fichier : la première et les plus récentes", async () => {
    for (let i = 0; i < 105; i++) await recordWrite(2, "f", b(String(i)), b(String(i + 1)));
    const vs = (await entree(2, "f")).versions;
    expect(vs).toHaveLength(100);
    expect((await getBlob(2, vs[0]?.sha))?.toString()).toBe("1");
    expect((await getBlob(2, vs[1]?.sha))?.toString()).toBe("7");
  });

  it("première écriture sans session : pas d'attente du verrou (non réentrant)", async () => {
    const debut = performance.now();
    await recordWrite(9, "a", b("0"), b("1"));
    expect(performance.now() - debut).toBeLessThan(1_000);
    expect(await fileEntry(9, "a")).not.toBeNull();
  });

  it("clés « __proto__ » et entières : clés ordinaires, à leur place Python", async () => {
    await recordWrite(3, "z", b("0"), b("1"));
    await recordWrite(3, "__proto__", b("0"), b("1"));
    await recordWrite(3, "12", b("0"), b("1"));
    const idx = readFileSync(path.join(dossierCompte(3), await currentSession(3), "index.json"), "utf-8");
    expect([...idx.matchAll(/"([^"]+)": \{"original"/gu)].map((m) => m[1])).toEqual(["z", "__proto__", "12"]);
    expect((await fichiers(3)).map((f) => String(f["path"])).sort()).toEqual(["12", "__proto__", "z"]);
  });

  it("index illisible : l'écriture est journalisée, jamais levée", async () => {
    const sid = await currentSession(4);
    mkdirSync(path.join(dossierCompte(4), sid), { recursive: true });
    writeFileSync(path.join(dossierCompte(4), sid, "index.json"), "[1, 2]");
    await expect(recordWrite(4, "a", b("0"), b("1"))).resolves.toBeUndefined();
    await expect(recordMove(4, "a", "b")).resolves.toBeUndefined();
  });
});
