// SPDX-License-Identifier: MIT
/** apps/core/test/memoire/outil.test.ts — corps des outils `memory` et `session_search` rejoués sur les vecteurs Python (migration-kit/vecteurs/memoire_outil.py) : résultats, fichiers, journal et audit. */
import "../moteur-environnement";

import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pyJsonDumps } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";

import { StoreBusyError } from "../../src/memoire/magasin";
import type { MarkdownStore } from "../../src/memoire/magasin";
import * as memoryJournal from "../../src/memoire/journal";
import {
  asEnum,
  fmtEntry,
  identiteMemoire,
  isoDay,
  limitesMemoire,
  memory,
  sessionSearch,
  safeChatIdOutil,
  safeUsernameOutil,
  unquote,
} from "../../src/memoire/outil";
import type { DependancesMemoire } from "../../src/memoire/outil";
import { storeFor } from "../../src/memoire/portee";
import { lireVecteurs } from "../vecteurs-moteur";
import { remplirSessions } from "./aides-sessions";
import type { SpecSessions } from "./aides-sessions";

/** Les vecteurs datent les messages en heure de Paris (jour local, pas jour UTC). */
process.env["TZ"] = "Europe/Paris";

interface Etape {
  outil: "memory" | "session_search";
  meta: { username?: string; chat_id?: string };
  args: Record<string, unknown>;
  limites?: [number, number];
  occupe?: boolean;
  indisponible?: boolean;
  erreur_compte?: boolean;
  journal_bloque?: boolean;
}

const V = lireVecteurs<{
  spec: { base: Omit<SpecSessions, "recherches">; etapes: Etape[] };
  etapes: {
    resultat: Record<string, unknown>;
    info: string[];
    compte: string;
    fichiers: Record<string, string | null>;
  }[];
  journaux: Record<string, string[]>;
  audits: Record<string, string[]>;
  aides: {
    unquote: { entree: unknown; sortie: string }[];
    as_enum: { entree: unknown; choix: string[]; defaut: string | null; sortie: string | null }[];
    noms: { entree: string | null; outil: string; sandbox: string }[];
    chats: { entree: string | null; outil: string; toolkit: string }[];
    fmt_entry: { id: string; texte: unknown; sortie: string }[];
    jours: { entree: unknown; sortie: string }[];
  };
}>("memoire-outil");

/** Sérialisation à la Python : un flottant entier (`usage_pct` 0.0) s'écrit comme dans le vecteur. */
const enJson = (v: unknown): unknown => JSON.parse(pyJsonDumps(v));

/** Lignes du fichier telles quelles (octets compris), horodatage et identifiant d'écriture neutralisés comme le fait le script Python. */
async function lignes(chemin: string): Promise<string[]> {
  let texte: string;
  try {
    texte = await readFile(chemin, "utf8");
  } catch {
    return [];
  }
  return texte
    .split("\n")
    .filter((l) => l)
    .map((l) => l.replace(/"ts": -?[0-9][0-9.e+-]*/u, '"ts": 0').replace(/"op": "[^"]*"/u, '"op": "OP"'));
}

describe("outils memory et session_search rejoués sur les vecteurs Python", () => {
  let t: BaseDeTest;
  let racine: string;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await remplirSessions(t.base, { ...V.spec.base, recherches: [] });
    racine = await mkdtemp(path.join(os.tmpdir(), "elpis-outil-"));
  });
  afterAll(async () => {
    await t.fermer();
    await rm(racine, { recursive: true, force: true });
  });

  it("chaque appel rend le même résultat (clés dans le même ordre), les mêmes fichiers, les mêmes messages d'information ; journal et audit identiques", async () => {
    expect(V.spec.etapes.length).toBe(V.etapes.length);
    const comptes: string[] = [];
    for (const [i, e] of V.spec.etapes.entries()) {
      const attendu = V.etapes[i];
      if (!attendu) throw new Error(`étape ${i} absente du vecteur`);
      const identite = { username: e.meta.username || "guest", chatId: e.meta.chat_id || "" };
      const infos: string[] = [];
      let dump: Record<string, unknown>;
      const dossier = path.join(racine, attendu.compte, "memory");
      if (e.journal_bloque) await mkdir(path.join(dossier, ".journal.jsonl"), { recursive: true });
      try {
        if (e.outil === "memory") {
          const dep: DependancesMemoire = {
            racine,
            limites: () => e.limites ?? [2200, 1375],
            info: (m) => void infos.push(m),
          };
          if (e.occupe) {
            dep.magasin = (kind, username, scope, [memoryLimit, userLimit]) => {
              const s = storeFor(kind, username, scope, racine, { memoryLimit, userLimit });
              const occupe = (): Promise<never> => Promise.reject(new StoreBusyError("verrou occupé"));
              return Object.assign(s, {
                add: occupe,
                replace: occupe,
                remove: occupe,
                rewrite: occupe,
              }) as MarkdownStore;
            };
          }
          if (e.indisponible) {
            dep.magasin = () => {
              throw new Error("boom");
            };
          }
          dump = await memory(dep, identite, e.args);
        } else {
          dump = await sessionSearch(
            {
              base: t.base,
              idUtilisateur: async (nom) => {
                if (e.erreur_compte) throw new Error("base indisponible");
                const r = await t.base.get<{ id: number }>("SELECT id FROM users WHERE username = ?", [nom]);
                return r ? Number(r.id) : null;
              },
            },
            identite,
            e.args,
          );
        }
      } finally {
        if (e.journal_bloque)
          await rm(path.join(dossier, ".journal.jsonl"), { recursive: true, force: true });
      }
      if (typeof dump["op"] === "string" && dump["op"]) {
        expect(
          (await memoryJournal.records(dossier)).some((r) => r["op"] === dump["op"]),
          `étape ${i} : op absent du journal`,
        ).toBe(true);
        dump["op"] = "OP";
      }
      const obtenu = enJson(dump) as Record<string, unknown>;
      expect(obtenu, `étape ${i} ${JSON.stringify(e)}`).toEqual(attendu.resultat);
      expect(Object.keys(obtenu), `étape ${i} : ordre des clés`).toEqual(Object.keys(attendu.resultat));
      expect(infos, `étape ${i} : info`).toEqual(attendu.info);
      if (e.outil === "memory") {
        const fichiers: Record<string, string | null> = {};
        for (const nom of ["MEMORY.md", "USER.md"])
          fichiers[nom] = await readFile(path.join(dossier, nom), "utf8").catch(() => null);
        expect(fichiers, `étape ${i} : fichiers`).toEqual(attendu.fichiers);
      }
      if (!comptes.includes(attendu.compte)) comptes.push(attendu.compte);
    }
    for (const c of comptes) {
      const dossier = path.join(racine, c, "memory");
      expect(await lignes(path.join(dossier, ".journal.jsonl")), `journal de ${c}`).toEqual(
        V.journaux[c] ?? [],
      );
      expect(await lignes(path.join(dossier, ".audit.jsonl")), `audit de ${c}`).toEqual(V.audits[c] ?? []);
    }
  });
});

describe("aides des outils (vecteurs Python)", () => {
  it("unquote et as_enum du toolkit", () => {
    for (const c of V.aides.unquote) expect(unquote(c.entree), JSON.stringify(c.entree)).toBe(c.sortie);
    for (const c of V.aides.as_enum)
      expect(asEnum(c.entree, c.choix, c.defaut), JSON.stringify([c.entree, c.defaut])).toBe(c.sortie);
  });

  it("noms de compte et de chat : memory_tools d'abord comme Python, puis la chaîne complète get_username → _identity", async () => {
    for (const n of V.aides.noms) {
      expect(safeUsernameOutil(n.entree), String(n.entree)).toBe(n.outil);
      expect(identiteMemoire({ username: n.entree ?? "", chatId: "" })[0], String(n.entree)).toBe(
        safeUsernameOutil(n.sandbox),
      );
    }
    for (const c of V.aides.chats) {
      expect(safeChatIdOutil(c.entree), String(c.entree)).toBe(c.outil);
      expect(identiteMemoire({ username: "a", chatId: c.entree ?? "" })[1], String(c.entree)).toBe(
        safeChatIdOutil(c.toolkit),
      );
    }
  });

  it("unquote traite 20 000 couches de guillemets sans ralentir (linéaire en la longueur)", () => {
    const couches = '"'.repeat(20_000);
    expect(unquote(`${couches}x${couches}`)).toBe("x");
    expect(unquote(`${couches}`)).toBe("");
  });

  it("_fmt_entry et _iso_day", () => {
    for (const c of V.aides.fmt_entry)
      expect(fmtEntry(c.id, c.texte), JSON.stringify(c.texte)).toBe(c.sortie);
    for (const c of V.aides.jours) expect(isoDay(c.entree), JSON.stringify(c.entree)).toBe(c.sortie);
  });

  it("limitesMemoire suit la config du process", () => {
    const restaurer = surchargerConfig({ MEMORY_MD_CHAR_LIMIT: 3000.9, USER_MD_CHAR_LIMIT: 500 });
    try {
      expect(limitesMemoire()).toEqual([3000, 500]);
    } finally {
      restaurer();
    }
  });
});

describe("droits sur un autre compte", () => {
  let t: BaseDeTest;
  let racine: string;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await remplirSessions(t.base, { ...V.spec.base, recherches: [] });
    racine = await mkdtemp(path.join(os.tmpdir(), "elpis-droits-"));
  });
  afterAll(async () => {
    await t.fermer();
    await rm(racine, { recursive: true, force: true });
  });

  const dep = (): { base: BaseDeTest["base"]; idUtilisateur: (n: string) => Promise<number | null> } => ({
    base: t.base,
    idUtilisateur: async (nom) => {
      const r = await t.base.get<{ id: number }>("SELECT id FROM users WHERE username = ?", [nom]);
      return r ? Number(r.id) : null;
    },
  });

  it("memory écrit chez le compte de l'identité, jamais chez celui que les arguments désignent", async () => {
    const piege = {
      action: "add",
      store: "memory",
      content: "note d'alice",
      username: "bob",
      user: "bob",
      user_id: 2,
      scope: "bob",
      chat_id: "d1",
    };
    const r = await memory(
      { racine, limites: () => [2200, 1375] },
      { username: "alice", chatId: "c1" },
      piege,
    );
    expect(r["ok"]).toBe(true);
    expect(await readFile(path.join(racine, "alice", "memory", "MEMORY.md"), "utf8")).toBe("note d'alice");
    await expect(readFile(path.join(racine, "bob", "memory", "MEMORY.md"), "utf8")).rejects.toThrow();
  });

  it("un nom de compte à chemin piégé reste dans le dossier des bacs", async () => {
    for (const username of ["../../etc", "/etc/passwd", "alice/../bob", "..", "a\\..\\b"]) {
      const r = await memory(
        { racine, limites: () => [2200, 1375] },
        { username, chatId: "" },
        { action: "add", store: "user", content: "x" },
      );
      expect(r["ok"], username).toBe(true);
    }
    for (const d of await readdir(racine)) expect(d).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("session_search ne lit que les messages du compte de l'identité, ref d'un autre compte compris", async () => {
    const piege = { query: "café", username: "bob", user_id: 2, ref: undefined };
    const alice = await sessionSearch(dep(), { username: "alice", chatId: "c1" }, piege);
    const refs = (alice["matches"] as { ref: number }[]).map((m) => m.ref);
    expect(refs).toEqual([4]);
    const bob = await sessionSearch(dep(), { username: "bob", chatId: "d1" }, { query: "café" });
    expect((bob["matches"] as { ref: number }[]).map((m) => m.ref)).toEqual([9]);
    const pieges = { ref: 9, username: "bob" };
    const lecture = await sessionSearch(dep(), { username: "alice", chatId: "c1" }, pieges);
    expect(lecture).toMatchObject({ ok: false, error: "unknown_ref" });
    const sienne = await sessionSearch(dep(), { username: "bob", chatId: "d1" }, { ref: 9 });
    expect(sienne).toMatchObject({ ok: true, count: 1 });
  });

  it("ref et limit hors de la plage sûre (entiers Python) : ref inconnue citée en entier, limit bornée", async () => {
    const d = dep();
    const identite = { username: "alice", chatId: "c1" };
    const grande = 10n ** 20n;
    const lecture = await sessionSearch(d, identite, { query: "nginx", ref: grande });
    expect(lecture).toMatchObject({
      ok: false,
      error: "unknown_ref",
      message: "no passage with ref 100000000000000000000",
    });
    const haut = await sessionSearch(d, identite, { query: "plafond", limit: grande });
    expect(haut["count"]).toBe(20);
    const bas = await sessionSearch(d, identite, { query: "plafond", limit: -grande });
    expect(bas["count"]).toBe(1);
  });
});
