// SPDX-License-Identifier: MIT
/** apps/core/test/chats.test.ts — conversations, prompts et templates rejoués contre le routeur Python (vecteurs), sur SQLite et PostgreSQL. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { createUser } from "@elpis/auth";
import { ErreurCle, ErreurPython, pyJsonDumps, pyJsonLoads, versFlottantPy } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { Dirent } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  addChatPrunedKeys,
  cleanCtxUsage,
  clearChatCtxUsage,
  deleteChat,
  finalizeTurnMeta,
  getChatPlanMode,
  getChatTodos,
  setChatPlanMode,
  setChatTodos,
  setChatTools,
  setTitleIfDefault,
  upsertChat,
} from "../src/chats/stockage";
import { creerFamilleChats } from "../src/familles/chats";
import { creerFamillePrompts } from "../src/familles/prompts";
import { idGraphiqueSur, nomSur, refsGraphiques } from "../src/graphiques/incrustation";
import { deleteForChats, root as racineImages } from "../src/images/magasin";
import { appTest } from "./aides";

/** [compte, méthode, chemin, corps, statut sous PostgreSQL si l'étape est propre à SQLite]. */
type Etape = [string, string, string, unknown, number?];

const V = pyJsonLoads(readFileSync(new URL("./vecteurs/chats.json", import.meta.url), "utf-8"), {
  mode: "valeurs",
}) as {
  comptes: [string, number][];
  groupes: [string, string[]][];
  graphiques: Record<string, Record<string, string>>;
  etapes: Etape[];
  ids: Record<string, number>;
  crees: string[];
  reponses: { statut: number; corps: string; entetes: Record<string, string> }[];
  prealables: [number, string][];
  operations: [string, unknown[], Record<string, unknown>, string | null][];
  images: [string, string, string, string][];
  magasin: { resultat?: string; erreur?: string; message?: string; ligne?: Record<string, unknown> | null }[];
  fichiers_restants: string[];
  refs: { texte: unknown; ids: string[] }[];
  noms: { nom: string; utilisateur: string; graphique: string }[];
};

type Args = unknown[] & [number, string, ...unknown[]];

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const T0 = 1_800_000_000;

/** `str.encode("utf-8", "surrogatepass")` : une demi-paire isolée s'écrit telle quelle (ED A0 80…). */
function octetsSurrogatepass(texte: string): Buffer {
  const octets: number[] = [];
  for (const c of texte) {
    const p = c.codePointAt(0) ?? 0;
    if (p < 0x80) octets.push(p);
    else if (p < 0x800) octets.push(0xc0 | (p >> 6), 0x80 | (p & 63));
    else if (p < 0x10000) octets.push(0xe0 | (p >> 12), 0x80 | ((p >> 6) & 63), 0x80 | (p & 63));
    else octets.push(0xf0 | (p >> 18), 0x80 | ((p >> 12) & 63), 0x80 | ((p >> 6) & 63), 0x80 | (p & 63));
  }
  return Buffer.from(octets);
}

describe("références de graphiques et noms sûrs (vecteurs)", () => {
  it("`\\s` et `\\b` de Python, blocs chart-ref et poignées !id ; lettres et chiffres Unicode", () => {
    for (const c of V.refs) expect([...refsGraphiques(c.texte)].sort(), String(c.texte)).toEqual(c.ids);
    for (const n of V.noms)
      expect([nomSur(n.nom), idGraphiqueSur(n.nom)], n.nom).toEqual([n.utilisateur, n.graphique]);
  });
});

describe.each(MOTEURS)("conversations, prompts et templates (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let graphiques: string;
  let restaurer: () => void;

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    for (const [nom, admin] of V.comptes) await createUser(t.base, nom, `mdp-${nom}`, { isAdmin: admin });
    for (const [g, membres] of V.groupes) {
      const gid = await t.base.insertId('INSERT INTO "groups"(name, description, created_at) VALUES(?,?,?)', [
        g,
        "",
        0,
      ]);
      for (const m of membres)
        await t.base.run("INSERT INTO user_groups(user_id, group_id) VALUES(?,?)", [V.ids[m] ?? 0, gid]);
    }
    graphiques = mkdtempSync(join(tmpdir(), "elpis-graphiques-"));
    for (const [nom, fichiers] of Object.entries(V.graphiques)) {
      mkdirSync(join(graphiques, nom), { mode: 0o700 });
      for (const [cid, texte] of Object.entries(fichiers))
        writeFileSync(join(graphiques, nom, `${cid}.json`), texte);
    }
    vi.stubEnv("CHART_CACHE_DIR", graphiques);
    restaurer = surchargerConfig({ MAX_RECENT_CHATS: 4, DB_PATH: join(graphiques, "user_db", "app.db") });
    app = await appTest({
      familles: [creerFamilleChats({ base: t.base }), creerFamillePrompts({ base: t.base })],
      gardes: {
        session: (req) => {
          req.utilisateur = { id: Number(req.headers["x-uid"]), username: null };
        },
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    restaurer();
    await app.close();
    await t.fermer();
    rmSync(graphiques, { recursive: true, force: true });
  });

  it("rejoue les étapes et rend les mêmes réponses, au texte près (vecteurs)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const crees: string[] = [];
    const versPython = (texte: string): string =>
      crees.reduce((s, id, k) => s.replaceAll(id, V.crees[k] ?? id), texte);
    const versTs = (texte: string): string => crees.reduce((s, id, k) => s.replaceAll(`{c${k}}`, id), texte);
    for (const [k, [u, id]] of V.prealables.entries())
      await upsertChat(t.base, u, id, `Préalable ${id}`, [], 1_700_000_000 + k);
    for (const [i, [nom, methode, chemin, corps, statutPg]] of V.etapes.entries()) {
      vi.setSystemTime((T0 + 10 * i) * 1000);
      const entetes: Record<string, string> = { "x-uid": String(V.ids[nom]) };
      let payload: Buffer | undefined;
      if (typeof corps === "string" && corps.startsWith("<<"))
        payload = octetsSurrogatepass(corps.slice(2, -2));
      else if (corps !== null)
        payload = octetsSurrogatepass(versTs(pyJsonDumps(corps, { ensureAscii: false })));
      if (payload !== undefined) entetes["content-type"] = "application/json";
      const r = await app.inject({
        method: methode as "GET",
        url: versTs(chemin),
        headers: entetes,
        ...(payload ? { payload } : {}),
      });
      if (methode === "POST" && chemin === "/api/saved/chats/new" && r.statusCode === 200)
        crees.push((r.json() as { id: string }).id);
      const attendu = V.reponses[i];
      const vus = Object.fromEntries(
        ["cache-control", "pragma", "expires"].flatMap((k) =>
          r.headers[k] ? [[k, String(r.headers[k])]] : [],
        ),
      );
      if (moteur === "postgres" && statutPg !== undefined) {
        expect(r.statusCode, `étape ${i} (postgres) : ${methode} ${chemin}`).toBe(statutPg);
        continue;
      }
      expect(
        { statut: r.statusCode, corps: versPython(r.body), entetes: vus },
        `étape ${i} : ${methode} ${chemin}`,
      ).toEqual(attendu);
    }
    expect(crees).toHaveLength(V.crees.length);
  });

  it("magasin : fin de tour, todos, clés élaguées, mesure du contexte, garde optimiste, images (vecteurs)", async () => {
    const b = t.base;
    const operations: Record<string, (a: Args, kw: Record<string, unknown>) => unknown> = {
      upsert_chat: ([u, c, titre, m, quand], kw) =>
        upsertChat(
          b,
          u,
          c,
          titre as string,
          m,
          quand as number,
          (kw["expected_updated_at"] as number) ?? null,
        ),
      set_title_if_default: ([u, c, titre]) => setTitleIfDefault(b, u, c, titre),
      set_chat_todos: ([u, c, todos]) => setChatTodos(b, u, c, todos),
      get_chat_todos: ([u, c]) => getChatTodos(b, u, c),
      add_chat_pruned_keys: ([u, c, cles], kw) =>
        addChatPrunedKeys(b, u, c, cles as unknown[], (kw["cap"] as number) ?? 500),
      clean_ctx_usage: ([brut]) => cleanCtxUsage(brut),
      finalize_turn_meta: ([u, c], kw) =>
        finalizeTurnMeta(b, u, c, {
          prunedKeys: kw["pruned_keys"] as unknown[] | undefined,
          tools: kw["tools"],
          planModeOff: kw["plan_mode_off"] as boolean | undefined,
          ctxUsage: kw["ctx_usage"],
          userSuffixes: kw["user_suffixes"] as Record<string, unknown> | undefined,
          suffixDropFromRank: kw["suffix_drop_from_rank"] as number | undefined,
        }),
      set_chat_tools: ([u, c, outils]) => setChatTools(b, u, c, outils),
      clear_chat_ctx_usage: ([u, c]) => clearChatCtxUsage(b, u, c),
      set_chat_plan_mode: ([u, c, v]) => setChatPlanMode(b, u, c, v),
      get_chat_plan_mode: ([u, c]) => getChatPlanMode(b, u, c),
      delete_for_chats: ([u, ids]) => deleteForChats(b, u as number, ids as unknown as unknown[]),
      delete_chat: ([u, c]) => deleteChat(b, u, c),
    };
    const racine = racineImages();
    for (const [id, chat, rel, vignette] of V.images) {
      for (const r of [rel, vignette].filter(Boolean)) {
        mkdirSync(dirname(join(racine, r)), { recursive: true });
        writeFileSync(join(racine, r), "x");
      }
      await b.run(
        "INSERT INTO generated_images(id, user_id, chat_id, mime, width, height, bytes, rel_path, thumb_rel_path, created_at) " +
          "VALUES(?,?,?,?,?,?,?,?,?,?)",
        [id, 4, chat, "image/png", 1, 1, 1, rel, vignette, 1],
      );
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [i, [nom, args, kw, chat]] of V.operations.entries()) {
      vi.setSystemTime((1_900_000_000 + 10 * i) * 1000);
      const operation = operations[nom];
      if (!operation) throw new Error(`opération inconnue : ${nom}`);
      let obtenu: (typeof V.magasin)[number];
      try {
        obtenu = {
          resultat: pyJsonDumps((await operation(args as Args, kw)) ?? null, { ensureAscii: false }),
        };
      } catch (e) {
        if (e instanceof ErreurPython) obtenu = { erreur: e.type, message: e.message };
        else if (e instanceof ErreurCle) obtenu = { erreur: "KeyError", message: e.message };
        else throw e;
      }
      if (chat) {
        const ligne = await b.get(
          "SELECT title, meta_json, messages_json, updated_at FROM chats WHERE id=? AND user_id=4",
          [chat],
        );
        obtenu.ligne = ligne ? { ...ligne, updated_at: versFlottantPy(Number(ligne["updated_at"])) } : null;
      }
      expect(obtenu, `opération ${i} : ${nom}`).toEqual(V.magasin[i]);
    }
    const restants = (readdirSync(racine, { recursive: true, withFileTypes: true }) as Dirent[])
      .filter((d) => d.isFile())
      .map((d) => relative(racine, join(d.parentPath, d.name)))
      .sort();
    expect(restants).toEqual(V.fichiers_restants);
  });
});

describe("mesure du contexte enregistrée", () => {
  it("occupation réelle gardée au-delà de la fenêtre : seul le pourcentage est borné", () => {
    expect(cleanCtxUsage({ used: 150_000, total: 131_072, ts: 5 })).toMatchObject({
      used: 150_000,
      total: 131_072,
      pct: 100,
    });
  });
});
