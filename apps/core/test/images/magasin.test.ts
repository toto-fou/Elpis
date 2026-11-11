// SPDX-License-Identifier: MIT
/** apps/core/test/images/magasin.test.ts — magasin unique des images (store.py) et droits (access.py) : vecteurs Python, magasin rejoué, rétention, cloisonnement, entretien, clé sous verrou. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createUser } from "@elpis/auth";
import { comparePointsDeCode, FlottantPy, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { cheminCopieConfigJson, config, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { avecVerrou, cheminVerrou } from "@elpis/verrous";

import { deleteAllChats, deleteChat, deleteChatsByIds, upsertChat } from "../../src/chats/stockage";
import {
  cleanPrefs,
  enabledIn,
  PREFS_DEFAULTS,
  readSettings,
  readyFor,
  toolEnabledIn,
  userAllowed,
} from "../../src/images/acces";
import { getImageConfig, retirerCleHeritee } from "../../src/images/config";
import {
  countForUser,
  deleteForChats,
  deleteImage,
  deleteUserDir,
  EPHEMERAL_TTL_S,
  getImage,
  listImages,
  ORPHAN_GRACE_S,
  readBytes,
  recentTimings,
  refFor,
  root,
  saveImages,
  supprimerIds,
  sweepOrphans,
  THUMB_SIDE,
  urlFor,
  validId,
} from "../../src/images/magasin";
import type { ImageTrouvee } from "../../src/images/magasin";

type Issue = { resultat?: string; erreur?: string; message?: string };
type Operation = [string, string | null, unknown[] | Dict];

const V = pyJsonLoads(readFileSync(new URL("../vecteurs/images-magasin.json", import.meta.url), "utf-8")) as {
  prefs_textes: string[];
  sections: string[];
  reglages: (Dict | null)[];
  id_cas: unknown[];
  ref_cas: Dict[];
  prefs: Issue[][];
  cases: [boolean, boolean][];
  ids: [boolean, string | null, string | null][];
  refs: Issue[];
  constantes: Dict;
  magasin: {
    comptes: [string, number][];
    chats: [string, string][];
    fichiers: [string, string, number][];
    lignes: unknown[][];
    operations_cas: Operation[];
    ids: Dict;
    operations: (Issue & { etat: { lignes: string[]; fichiers: string[] } })[];
  };
};

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAUklEQVR4nO3PMQ0AIADAMEAI/qUgCxEcDcmqYJtn7/GzpQNeNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oF2vFwFk2XER3gAAAABJRU5ErkJggg==",
  "base64",
);

/** `_appel` du générateur : JSON compact de Python, ou la classe levée. */
function appel(f: () => unknown): Issue {
  try {
    return { resultat: pyJsonDumps(f(), { ensureAscii: false }) };
  } catch (e) {
    return { erreur: (e as { type?: string }).type ?? (e as Error).name, message: (e as Error).message };
  }
}

describe("fonctions pures (vecteurs Python)", () => {
  it("clean_prefs : préférences ramenées aux limites de chaque configuration", () => {
    for (const [i, section] of V.sections.entries()) {
      const cfg = getImageConfig({ image: pyJsonLoads(section) });
      for (const [j, texte] of V.prefs_textes.entries())
        expect(
          appel(() => cleanPrefs(pyJsonLoads(texte), cfg)),
          `${section} × ${texte}`,
        ).toEqual(V.prefs[i]?.[j]);
    }
  });

  it("cases du compte, ids, URL, références, constantes", () => {
    expect(V.reglages.map((r) => [enabledIn(r), toolEnabledIn(r)])).toEqual(V.cases);
    expect(
      V.id_cas.map((i) => [
        validId(i),
        validId(i) ? urlFor(i) : null,
        validId(i) ? urlFor(i, { thumb: true }) : null,
      ]),
    ).toEqual(V.ids);
    for (const [k, cas] of V.ref_cas.entries())
      expect(
        appel(() => refFor(cas)),
        pyJsonDumps(cas),
      ).toEqual(V.refs[k]);
    expect(pyJsonDumps({ ORPHAN_GRACE_S, EPHEMERAL_TTL_S, THUMB_SIDE, PREFS_DEFAULTS })).toBe(
      pyJsonDumps({
        ...V.constantes,
        ORPHAN_GRACE_S: new FlottantPy(ORPHAN_GRACE_S),
        EPHEMERAL_TTL_S: new FlottantPy(EPHEMERAL_TTL_S),
      }).replace(/(_S": )(\d+)\.0/g, "$1$2"),
    );
  });
});

const REELS = new Set(["megapixels", "duration_s", "created_at"]);

/** Fichiers de la racine, chemins relatifs triés comme `sorted()` de Python. */
function fichiers(racine: string): string[] {
  const out: string[] = [];
  const marcher = (d: string): void => {
    for (const nom of readdirSync(d)) {
      const p = join(d, nom);
      const s = statSync(p);
      if (s.isDirectory()) marcher(p);
      else if (s.isFile()) out.push(relative(racine, p));
    }
  };
  if (existsSync(racine)) marcher(racine);
  return out.sort(comparePointsDeCode);
}

function rendu(nom: string, r: unknown): unknown {
  if (nom === "get_image" && r) {
    const base = realpathSync(root());
    const ligne = r as ImageTrouvee;
    const out: Dict = {};
    for (const [k, v] of Object.entries(ligne))
      out[k] = REELS.has(k) && typeof v === "number" ? new FlottantPy(v) : v;
    out["path"] = relative(base, ligne.path);
    out["thumb_path"] = ligne.thumb_path && relative(base, ligne.thumb_path);
    return out;
  }
  if (nom === "read_bytes" && r) return (r as Buffer).toString("utf-8");
  if (nom === "recent_timings")
    return (r as [number, number][]).map(([d, mp]) => [new FlottantPy(d), new FlottantPy(mp)]);
  return r ?? null;
}

describe.each(MOTEURS)("magasin rejoué contre le Python (%s)", (moteur) => {
  let t: BaseDeTest;
  let dossier: string;
  let restaurer: () => void;

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    dossier = mkdtempSync(join(tmpdir(), "elpis-images-magasin-"));
    writeFileSync(join(dossier, "config.json"), JSON.stringify({ image: { keep_per_user: 3 } }));
    restaurer = surchargerConfig({
      DB_PATH: join(dossier, "user_db", "app.db"),
      CONFIG_JSON_PATH: join(dossier, "config.json"),
    });
  });
  afterEach(async () => {
    restaurer();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("lectures, galerie, suppressions, conversations, entretien : résultats, lignes et fichiers identiques", async () => {
    const b = t.base;
    const M = V.magasin;
    const ids: Record<string, number> = {};
    for (const [nom, admin] of M.comptes)
      ids[nom] = await createUser(b, nom, `mdp-${nom}`, { isAdmin: admin });
    expect(ids).toEqual({ ...M.ids });
    for (const [nom, cid] of M.chats)
      await upsertChat(b, ids[nom] ?? 0, cid, "t", [{ role: "user", content: "x" }], 1_700_000_000.0);
    const racine = root();
    for (const [rel, contenu, mtime] of M.fichiers) {
      const p = join(racine, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, contenu, "utf-8");
      utimesSync(p, mtime, mtime);
    }
    for (const [iid, nom, chat, prompt, pj, model, rel, vig, steps, mp, duree, quand] of M.lignes)
      await b.run(
        "INSERT INTO generated_images (id, user_id, chat_id, prompt, params_json, model, mime, width, " +
          "height, bytes, rel_path, thumb_rel_path, steps, megapixels, duration_s, created_at) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          iid as string,
          ids[nom as string] ?? 0,
          chat as string | null,
          prompt as string,
          pj as string,
          model as string,
          "image/png",
          64,
          48,
          10,
          rel as string,
          vig as string,
          steps as number,
          Number(mp),
          duree === null ? null : Number(duree),
          Number(quand),
        ],
      );
    const etat = async (): Promise<{ lignes: string[]; fichiers: string[] }> => ({
      lignes: (await b.valeurs<[string]>("SELECT id FROM generated_images ORDER BY id")).map(([i]) => i),
      fichiers: fichiers(racine),
    });
    const num = (v: unknown): number => Number(v);
    const operations: Record<string, (uid: number | null, a: unknown[] | Dict) => Promise<unknown>> = {
      get_image: (u, a) => getImage(b, u ?? 0, (a as unknown[])[0]),
      read_bytes: (u, a) => readBytes(b, u ?? 0, (a as unknown[])[0]),
      list_images: (u, a) => {
        const o = a as Dict;
        return listImages(b, u ?? 0, {
          ...(o["limit"] !== undefined ? { limit: num(o["limit"]) } : {}),
          ...(o["before"] !== undefined ? { before: num(o["before"]) } : {}),
          ...(o["chat_id"] !== undefined ? { chatId: o["chat_id"] as string } : {}),
        });
      },
      count_for_user: (u, a) => countForUser(b, u ?? num((a as unknown[])[0])),
      recent_timings: (_u, a) => {
        const [m, s, l] = a as [string, number, number?];
        return l === undefined ? recentTimings(b, m, s) : recentTimings(b, m, s, l);
      },
      delete_image: (u, a) => deleteImage(b, u ?? 0, (a as unknown[])[0]),
      delete_for_chats: (u, a) => deleteForChats(b, u ?? 0, (a as unknown[][])[0] ?? []),
      sweep_orphans: (_u, a) => {
        const o = a as Dict;
        return sweepOrphans(b, {
          now: num(o["now"]),
          ...(o["keep"] !== undefined ? { keep: num(o["keep"]) } : {}),
        });
      },
      delete_user_dir: async (u, a) => deleteUserDir(u ?? num((a as unknown[])[0])),
    };
    for (const [i, [nom, compte, args]] of M.operations_cas.entries()) {
      const f = operations[nom];
      if (!f) throw new Error(`opération inconnue : ${nom}`);
      let obtenu: Issue;
      try {
        obtenu = {
          resultat: pyJsonDumps(rendu(nom, await f(compte === null ? null : (ids[compte] ?? 0), args)), {
            ensureAscii: false,
          }),
        };
      } catch (e) {
        obtenu = { erreur: (e as Error).name, message: (e as Error).message };
      }
      const attendu = M.operations[i];
      expect({ ...obtenu, etat: await etat() }, `opération ${i} : ${nom} ${pyJsonDumps(args)}`).toEqual(
        attendu,
      );
    }
  });
});

describe("magasin : comportement (test_images_magasin)", () => {
  let t: BaseDeTest;
  let base: Base;
  let dossier: string;
  let restaurer: () => void;

  beforeEach(async () => {
    t = ouvrirBaseDeTest("sqlite");
    base = t.base;
    await initialiserBase(base);
    dossier = mkdtempSync(join(tmpdir(), "elpis-images-"));
    restaurer = surchargerConfig({
      DB_PATH: join(dossier, "user_db", "app.db"),
      CONFIG_JSON_PATH: join(dossier, "config.json"),
    });
    expect(await createUser(base, "alice", "pw-alice-12")).toBe(1);
    expect(await createUser(base, "bob", "pw-bob-1234")).toBe(2);
  });
  afterEach(async () => {
    restaurer();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  const enregistrer = (
    o: {
      uid?: number;
      chatId?: string | null;
      n?: number;
      keep?: number;
      prompt?: string;
      model?: string;
    } = {},
  ) =>
    saveImages(base, o.uid ?? 1, o.chatId ?? null, o.prompt ?? "un phare", {
      model: o.model ?? "Qwen-Image",
      params: { size: "64x48" },
      results: Array.from({ length: o.n ?? 1 }, (_, i) => ({
        data: PNG,
        mime: "image/png",
        width: 64,
        height: 48,
        seed: 7 + i,
        revisedPrompt: "",
        extra: {},
      })),
      keep: o.keep ?? 50,
      durationS: 12.0,
    });
  const vieillir = (iid: string, secondes: number) =>
    base.run("UPDATE generated_images SET created_at=created_at-? WHERE id=?", [secondes, iid]);
  const chat = (uid: number, cid: string) =>
    upsertChat(base, uid, cid, "t", [{ role: "user", content: "x" }], Date.now() / 1000);

  it("références, fichiers et vignette ; chemin RELATIF en base ; octets relus", async () => {
    const [r] = await enregistrer({ n: 2 });
    if (!r) throw new Error("aucune référence");
    const row = await getImage(base, 1, r.id);
    expect(row?.rel_path).toBe(`1/${r.id}.png`);
    expect(statSync(row?.path ?? "").isFile()).toBe(true);
    expect(row?.thumb_path?.endsWith(".thumb.webp")).toBe(true);
    expect((await readBytes(base, 1, r.id))?.subarray(0, 4).toString("latin1")).toBe("\x89PNG");
  });

  it("image d'un autre compte inexistante ; chemin hors magasin refusé", async () => {
    const iid = (await enregistrer())[0]?.id ?? "";
    expect(await getImage(base, 2, iid)).toBeNull();
    expect(await deleteImage(base, 2, iid)).toBe(false);
    expect(await getImage(base, 1, iid)).not.toBeNull();
    expect(await getImage(base, 1, "../../etc")).toBeNull();
    await base.run("UPDATE generated_images SET rel_path=? WHERE id=?", ["../../app.db", iid]);
    expect(await getImage(base, 1, iid)).toBeNull();
    await base.run("UPDATE generated_images SET rel_path=? WHERE id=?", [`/${dossier}/user_db/app.db`, iid]);
    expect(await getImage(base, 1, iid)).toBeNull();
  });

  it("rétention glissante par compte, jamais plus petite que le lot", async () => {
    const vieilles = [(await enregistrer({ keep: 2 }))[0], (await enregistrer({ keep: 2 }))[0]];
    const autre = (await enregistrer({ uid: 2, keep: 2 }))[0];
    const neuve = (await enregistrer({ keep: 2 }))[0];
    expect(await getImage(base, 1, vieilles[0]?.id)).toBeNull();
    expect(existsSync(join(root(), "1", `${vieilles[0]?.id}.thumb.webp`))).toBe(false);
    expect(await getImage(base, 1, vieilles[1]?.id)).not.toBeNull();
    expect(await getImage(base, 1, neuve?.id)).not.toBeNull();
    expect(await getImage(base, 2, autre?.id)).not.toBeNull();
    const lot = await enregistrer({ n: 4, keep: 2 });
    for (const r of lot) expect(await getImage(base, 1, r.id)).not.toBeNull();
    expect(await countForUser(base, 1)).toBe(4);
  });

  it("suppression unitaire : fichiers effacés", async () => {
    const iid = (await enregistrer())[0]?.id ?? "";
    expect(await deleteImage(base, 1, iid)).toBe(true);
    expect(readdirSync(join(root(), "1")).filter((f) => f.startsWith(iid))).toEqual([]);
  });

  it("conversations supprimées par tous les chemins", async () => {
    for (const cid of ["c1", "c2", "c3", "c4"]) await chat(1, cid);
    const ids: Record<string, string> = {};
    for (const cid of ["c1", "c2", "c3", "c4"]) ids[cid] = (await enregistrer({ chatId: cid }))[0]?.id ?? "";
    expect(await deleteChat(base, 1, "c1")).toBe(true);
    expect(await getImage(base, 1, ids["c1"])).toBeNull();
    await deleteChatsByIds(base, 1, ["c2"]);
    expect(await getImage(base, 1, ids["c2"])).toBeNull();
    await deleteAllChats(base, 1);
    expect(await getImage(base, 1, ids["c3"])).toBeNull();
    expect(await getImage(base, 1, ids["c4"])).toBeNull();
  });

  it("chat neuf pas encore écrit : gardé jusqu'au délai de grâce", async () => {
    const iid = (await enregistrer({ chatId: "pas-encore-en-base" }))[0]?.id ?? "";
    await enregistrer();
    expect(await getImage(base, 1, iid)).not.toBeNull();
    expect(await sweepOrphans(base, { now: Date.now() / 1000 + 3600 })).toBe(0);
    expect(await sweepOrphans(base, { now: Date.now() / 1000 + ORPHAN_GRACE_S + 5 })).toBeGreaterThanOrEqual(
      1,
    );
    expect(await getImage(base, 1, iid)).toBeNull();
  });

  it("dossier d'un compte supprimé", async () => {
    await enregistrer({ uid: 2 });
    expect(statSync(join(root(), "2")).isDirectory()).toBe(true);
    await deleteUserDir(2);
    expect(existsSync(join(root(), "2"))).toBe(false);
    await deleteUserDir(3);
  });

  it("entretien : fichiers sans ligne, comptes disparus, sessions éphémères, lignes sans fichier, rétention de tous", async () => {
    await enregistrer();
    const perdu = join(root(), "1", "f".repeat(32) + ".png");
    writeFileSync(perdu, "x");
    const vieux = Date.now() / 1000 - 7200;
    utimesSync(perdu, vieux, vieux);
    mkdirSync(join(root(), "99"));
    writeFileSync(join(root(), "99", "a.png"), "x");
    expect(await sweepOrphans(base)).toBeGreaterThanOrEqual(2);
    expect(existsSync(perdu)).toBe(false);
    expect(existsSync(join(root(), "99"))).toBe(false);
    expect(readdirSync(join(root(), "1")).filter((f) => f.endsWith(".png"))).toHaveLength(1);

    const vieille = (await enregistrer())[0]?.id ?? "";
    const recente = (await enregistrer())[0]?.id ?? "";
    await vieillir(vieille, EPHEMERAL_TTL_S + 60);
    await sweepOrphans(base);
    expect(await getImage(base, 1, vieille)).toBeNull();
    expect(await getImage(base, 1, recente)).not.toBeNull();

    rmSync(join(root(), "1", `${recente}.png`));
    await vieillir(recente, 2 * 86400);
    const n = await countForUser(base, 1);
    await sweepOrphans(base);
    expect(await countForUser(base, 1)).toBe(n - 1);

    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await enregistrer({ uid: 2 }))[0]?.id ?? "");
    await sweepOrphans(base, { keep: 2 });
    expect(await countForUser(base, 2)).toBe(2);
    expect(await getImage(base, 2, ids[3])).not.toBeNull();
    expect(await getImage(base, 2, ids[0])).toBeNull();
    expect(existsSync(join(root(), "2", `${ids[0]}.png`))).toBe(false);
  });

  it("entretien : un dossier « ² » (isdigit sans int) est ignoré au lieu d'arrêter le balayage", async () => {
    await enregistrer();
    mkdirSync(join(root(), "²"));
    mkdirSync(join(root(), "99"));
    expect(await sweepOrphans(base)).toBe(1);
    expect(existsSync(join(root(), "²"))).toBe(true);
    expect(existsSync(join(root(), "99"))).toBe(false);
  });

  it("galerie paginée et filtrée ; curseur en flottant", async () => {
    await chat(1, "c1");
    for (let i = 0; i < 5; i++) await enregistrer({ chatId: i % 2 ? "c1" : null, prompt: `p${i}` });
    const [items, suite, total] = await listImages(base, 1, { limit: 2 });
    expect(total).toBe(5);
    expect(items.map((x) => x["prompt"])).toEqual(["p4", "p3"]);
    expect(suite).toBeInstanceOf(FlottantPy);
    const [items2, suite2] = await listImages(base, 1, { limit: 10, before: suite?.valeur ?? null });
    expect(items2.map((x) => x["prompt"])).toEqual(["p2", "p1", "p0"]);
    expect(suite2).toBeNull();
    const [duChat] = await listImages(base, 1, { chatId: "c1" });
    expect(new Set(duChat.map((x) => x["prompt"]))).toEqual(new Set(["p1", "p3"]));
    expect((await listImages(base, 2))[2]).toBe(0);
  });

  it("mesures de durée : une par lot, nom de modèle borné", async () => {
    await saveImages(base, 1, null, "x", {
      model: "m".repeat(400),
      params: {},
      results: [
        {
          data: PNG,
          mime: "image/png",
          width: 64,
          height: 48,
          seed: null,
          revisedPrompt: "a lighthouse",
          extra: {},
        },
      ],
      keep: 5,
      durationS: 30,
    });
    expect(await recentTimings(base, "m".repeat(191), 0)).toEqual([[30, 0.0031]]);
    expect(await base.valeurs("SELECT params_json FROM generated_images")).toEqual([
      ['{"revised_prompt": "a lighthouse"}'],
    ]);
  });

  it("suppression par tranches dédoublonnées", async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await enregistrer())[0]?.id ?? "");
    await supprimerIds(base, [ids[0], ids[0], ids[1], "", null]);
    expect(await countForUser(base, 1)).toBe(1);
    expect(await getImage(base, 1, ids[2])).not.toBeNull();
  });
});

describe("droits (test_images_config_acces)", () => {
  let t: BaseDeTest;
  let dossier: string;
  let restaurer: () => void;
  const comptes: Record<string, number> = {};

  beforeEach(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    dossier = mkdtempSync(join(tmpdir(), "elpis-images-acces-"));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    comptes["admin"] = await createUser(t.base, "admin", "pw-admin-12", { isAdmin: 1 });
    comptes["alice"] = await createUser(t.base, "alice", "pw-alice-12");
    comptes["bob"] = await createUser(t.base, "bob", "pw-bob-1234");
    comptes["design"] = await t.base.insertId(
      `INSERT INTO "groups" (name, description, created_at) VALUES ('Design', '', 0)`,
    );
    await t.base.run("INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)", [
      comptes["alice"],
      comptes["design"],
    ]);
  });
  afterEach(async () => {
    restaurer();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  const configurer = (image: Dict): void =>
    writeFileSync(config.CONFIG_JSON_PATH, JSON.stringify({ image }), "utf-8");

  it("groupes autorisés ; l'administrateur passe toujours ; un groupe supprimé ne rouvre pas", async () => {
    const b = t.base;
    const [alice, bob, admin] = [comptes["alice"] ?? 0, comptes["bob"] ?? 0, comptes["admin"] ?? 0];
    configurer({ enabled: true, url: "http://h" });
    expect(await userAllowed(b, alice)).toBe(true);
    expect(await userAllowed(b, bob)).toBe(true);
    configurer({ enabled: true, url: "http://h", groups: [comptes["design"]] });
    expect(await userAllowed(b, alice)).toBe(true);
    expect(await userAllowed(b, bob)).toBe(false);
    expect(await userAllowed(b, admin)).toBe(true);
    expect(await readyFor(b, alice)).toBe(true);
    expect(await readyFor(b, bob)).toBe(false);
    configurer({ enabled: false, url: "http://h" });
    expect(await readyFor(b, alice)).toBe(false);
    configurer({ enabled: true, url: "http://h", groups: [(comptes["design"] ?? 0) + 1] });
    expect(await userAllowed(b, alice)).toBe(false);
  });

  it("groupes ou réglages illisibles : refus", async () => {
    configurer({ enabled: true, url: "http://h", groups: [comptes["design"]] });
    const panne = Object.create(t.base) as Base;
    panne.get = () => Promise.reject(new Error("base indisponible"));
    panne.all = () => Promise.reject(new Error("base indisponible"));
    expect(await userAllowed(panne, comptes["alice"] ?? 0)).toBe(false);
    expect(await readSettings(panne, comptes["alice"] ?? 0)).toBeNull();
    expect(await readSettings(t.base, comptes["alice"] ?? 0)).toEqual({});
    await t.base.run("UPDATE users SET settings_json=? WHERE id=?", ["{corrompu", comptes["alice"] ?? 0]);
    expect(await readSettings(t.base, comptes["alice"] ?? 0)).toEqual({});
  });

  it("préférences ramenées aux limites ; valeurs non finies", () => {
    configurer({ enabled: true, url: "http://h", max_n: 4 });
    expect(cleanPrefs({ ratio: "16:9", side: 2048, n: 9, enhance: true })).toEqual({
      ratio: "16:9",
      side: 2048,
      n: 4,
      enhance: true,
    });
    expect(cleanPrefs({ ratio: "5:1", side: "x" })).toEqual({
      ratio: "1:1",
      side: 1024,
      n: 1,
      enhance: false,
    });
    expect(cleanPrefs({ side: 900 }).side).toBe(1024);
    expect(cleanPrefs({ side: 700 }).side).toBe(768);
    const p = cleanPrefs(pyJsonLoads('{"n": Infinity, "side": -Infinity}'));
    expect([p.n, p.side]).toEqual([1, 1024]);
  });

  it("ancienne clé retirée sous le verrou de config.json, et de config.json.bak : attend le détenteur, garde le reste, ne réécrit pas un fichier sans clé", async () => {
    configurer({ enabled: true, url: "http://h", api_key_enc: "jeton-chiffre" });
    const copie = cheminCopieConfigJson();
    writeFileSync(
      copie,
      JSON.stringify({ image: { url: "http://ancien", api_key_enc: "jeton-plus-ancien" } }),
    );
    let retiree: string[] | null = null;
    let ecriture: Promise<void> = Promise.resolve();
    await avecVerrou(cheminVerrou(config.CONFIG_JSON_PATH), {}, async () => {
      ecriture = retirerCleHeritee().then((f) => {
        retiree = f;
      });
      await new Promise((ok) => setTimeout(ok, 300));
      expect(retiree).toBeNull();
      expect(JSON.parse(readFileSync(config.CONFIG_JSON_PATH, "utf-8"))["image"]["api_key_enc"]).toBe(
        "jeton-chiffre",
      );
    });
    await ecriture;
    expect(retiree).toEqual([config.CONFIG_JSON_PATH, copie]);
    expect(JSON.parse(readFileSync(config.CONFIG_JSON_PATH, "utf-8"))).toEqual({
      image: { enabled: true, url: "http://h" },
    });
    expect(JSON.parse(readFileSync(copie, "utf-8"))).toEqual({ image: { url: "http://ancien" } });
    writeFileSync(config.CONFIG_JSON_PATH, JSON.stringify({ image: "pas un bloc", autre: 1 }), "utf-8");
    writeFileSync(copie, '{"image": {"api_key_enc": "x"}', "utf-8");
    expect(await retirerCleHeritee()).toEqual([]);
    expect(readFileSync(config.CONFIG_JSON_PATH, "utf-8")).toBe('{"image":"pas un bloc","autre":1}');
    expect(readFileSync(copie, "utf-8")).toBe('{"image": {"api_key_enc": "x"}');
  });
});
