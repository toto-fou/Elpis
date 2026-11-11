// SPDX-License-Identifier: MIT
/** packages/outils-mcp/test/boite.test.ts — boîte à outils des familles rejouée contre _toolkit.py (vecteurs), plus identité, battement et jumeaux. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ErreurPython } from "@elpis/commun";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  asBool,
  asEnum,
  asInt,
  asList,
  asStr,
  brancherSurchargesErreurs,
  clipText,
  err,
  foldConfusable,
  getChatId,
  getUsername,
  globMatch,
  headTail,
  Heartbeat,
  LIST_BUDGET,
  ok,
  page,
  safeChatId,
  tagKw,
  TEXT_BUDGET,
  toolKw,
  toolKwDestructive,
  toolKwIdempotent,
  toolKwMutating,
  toolKwOpenworld,
  toolKwReadonly,
  twinMessage,
  unicodeTwinWarning,
  unquote,
  withPolicy,
} from "../src/boite";
import type { Categorie, KwOutil } from "../src/boite";
import { avecJeton } from "../src/contexte";
import type { ContexteAppel, OptionsJournal } from "../src/contexte";
import { jsonPydantic, titlePy } from "../src/texte";
import { detaguer, lireVecteurs, taguer } from "./vecteurs";

type Essai = { ok: unknown } | { erreur: string; message: string };

const V = lireVecteurs<{
  budgets: { texte: number; liste: number };
  ok: unknown[];
  err: unknown[];
  clip: ({ texte: unknown; max: number | null; label: string } & Essai)[];
  head_tail: ({ texte: unknown; tete: number; queue: number } & Essai)[];
  page: ({ items: unknown[]; offset: unknown; limit: unknown } & Essai)[];
  quelconques: {
    v: unknown;
    unquote: Essai;
    as_str: Essai;
    as_int: Essai;
    as_int_none: Essai;
    as_bool: Essai;
    as_bool_vrai: Essai;
    as_list: Essai;
    as_enum: Essai[];
    as_enum_strict: Essai[];
  }[];
  politiques: ({ politique: Record<string, unknown> } & Record<string, Essai>)[];
  tag_kw: unknown;
  glob: { rel: string; motif: string; ok: boolean }[];
  replis: { nom: string; pli: string }[];
  jumeaux: { paires: [string, string][]; message: string | null }[];
  titres: { nom: string; titre: string }[];
  chats: { v: unknown; id: string }[];
  json: { v: unknown; texte: string }[];
}>("boite");

const CHOIX = [
  ["pending", "in_progress", "completed"],
  ["Add", "Remove-All", "Do It"],
];
const CATEGORIE: Categorie = { name: "fs", label: "Fichiers", icon: "ph-folder", color: "orange" };

/** Rejoue `f` et compare au vecteur : valeur (FlottantPy et bigint retagués) ou type d'erreur Python et message. */
function rejouer(f: () => unknown, attendu: Essai, titre: string): void {
  let obtenu: Essai;
  try {
    obtenu = { ok: taguer(f()) };
  } catch (e) {
    if (!(e instanceof ErreurPython)) throw e;
    obtenu = { erreur: e.type, message: e.message };
  }
  const voulu = "ok" in attendu ? { ok: taguer(detaguer(attendu.ok)) } : attendu;
  expect(obtenu, titre).toEqual(voulu);
}

const kw = (k: KwOutil): unknown => k;

describe("enveloppes et budgets (vecteurs _toolkit.py)", () => {
  it("budgets par défaut", () => {
    expect([TEXT_BUDGET, LIST_BUDGET]).toEqual([V.budgets.texte, V.budgets.liste]);
  });

  it("ok() et err() : ordre des clés, champs facultatifs, contexte qui écrase", () => {
    expect(V.ok).toEqual([ok(), ok({ todos: [1], total: 3 }), ok({ ok: false, x: null })]);
    const obtenus = [
      err("bad_path", "path is outside"),
      err("c", "m", { fix: "f", next_action: "n", retryable: true }),
      err("c", "m", {
        fix: "",
        next_action: null,
        retryable: false,
        valid_choices: ["a"],
        did_you_mean: "x",
      }),
      err("c", "m", { ok: true, error: "autre" }),
    ];
    expect(obtenus).toEqual(V.err);
    expect(obtenus.map((e) => Object.keys(e))).toEqual(V.err.map((e) => Object.keys(e as object)));
  });

  it("surcharge errors.<code> : message et correctif non vides seulement", () => {
    brancherSurchargesErreurs((code) => (code === "x" ? { message: "M", fix: "" } : null));
    try {
      expect(err("x", "m", { fix: "f" })).toEqual({ ok: false, error: "x", message: "M", fix: "f" });
      expect(err("y", "m")).toEqual({ ok: false, error: "y", message: "m" });
    } finally {
      brancherSurchargesErreurs(null);
    }
  });

  it.each(V.clip.map((c, i) => [i, c] as const))("clip_text %i", (_i, c) => {
    rejouer(() => clipText(detaguer(c.texte), c.max, { label: c.label }), c, JSON.stringify(c));
  });

  it.each(V.head_tail.map((c, i) => [i, c] as const))("head_tail %i", (_i, c) => {
    rejouer(() => headTail(c.texte, { headLines: c.tete, tailLines: c.queue }), c, JSON.stringify(c.texte));
  });

  it("page()", () => {
    for (const c of V.page)
      rejouer(
        () => page(c.items, { offset: detaguer(c.offset), limit: detaguer(c.limit) }),
        c,
        JSON.stringify([c.offset, c.limit]),
      );
  });
});

describe("tolérance d'entrée (vecteurs)", () => {
  it.each(V.quelconques.map((q) => [JSON.stringify(q.v), q] as const))("%s", (_n, q) => {
    const v = detaguer(q.v);
    rejouer(() => unquote(v), q.unquote, "unquote");
    rejouer(() => asStr(v, "def"), q.as_str, "as_str");
    rejouer(() => asInt(v, -1), q.as_int, "as_int");
    rejouer(() => asInt(v), q.as_int_none, "as_int sans défaut");
    rejouer(() => asBool(v), q.as_bool, "as_bool");
    rejouer(() => asBool(v, true), q.as_bool_vrai, "as_bool vrai");
    rejouer(() => asList(v), q.as_list, "as_list");
    CHOIX.forEach((c, i) => {
      rejouer(() => asEnum(v, c, "def"), q.as_enum[i] as Essai, `as_enum ${i}`);
      rejouer(
        () => asEnum(v, c, null, { normalize: false }),
        q.as_enum_strict[i] as Essai,
        `as_enum strict ${i}`,
      );
    });
  });
});

describe("unquote sur des guillemets imbriqués", () => {
  it("reste linéaire : 200 000 couches s'ôtent en moins d'une seconde", () => {
    const profond = '"'.repeat(100_000) + "x" + '"'.repeat(100_000);
    const debut = performance.now();
    expect(unquote(profond)).toBe("x");
    expect(unquote(`${"'“".repeat(5_000)} é ${"”'".repeat(5_000)}`)).toBe("é");
    expect(performance.now() - debut).toBeLessThan(1_000);
  });

  it("un caractère hors du plan de base seul n'est ni vidé ni coupé", () => {
    expect([unquote('"😀"'), unquote("😀"), unquote('"'), unquote("''")]).toEqual(["😀", "😀", '"', ""]);
  });
});

describe("politique d'exécution et annotations (vecteurs)", () => {
  const variantes: Record<string, (p: Record<string, unknown>) => KwOutil> = {
    tool_kw: (p) => toolKw(CATEGORIE, p),
    readonly: (p) => toolKwReadonly(CATEGORIE, { title: "Lire" }, p),
    destructive: (p) => toolKwDestructive(CATEGORIE, { openWorld: true }, p),
    idempotent: (p) => toolKwIdempotent(CATEGORIE, {}, p),
    mutating: (p) => toolKwMutating(CATEGORIE, { title: "" }, p),
    openworld: (p) => toolKwOpenworld(CATEGORIE, { readOnly: true, idempotent: true }, p),
  };

  it.each(V.politiques.map((p) => [JSON.stringify(p.politique), p] as const))("%s", (_n, p) => {
    for (const [nom, f] of Object.entries(variantes)) rejouer(() => kw(f(p.politique)), p[nom] as Essai, nom);
    rejouer(
      () => kw(withPolicy({ tags: ["x"], meta: { policy: { prune: "x" } } }, p.politique)),
      p["with_policy"] as Essai,
      "with_policy",
    );
  });

  it("tag_kw et deny_for d'un texte (itéré comme en Python)", () => {
    expect(tagKw(CATEGORIE)).toEqual(V.tag_kw);
    expect(withPolicy({ tags: [], meta: {} }, { deny_for: "ba" }).meta).toEqual({
      policy: { deny_for: ["a", "b"] },
    });
  });
});

describe("glob, replis, jumeaux, titres, chats, JSON pydantic (vecteurs)", () => {
  it("glob_match", () => {
    for (const g of V.glob) expect(globMatch(g.rel, g.motif), `${g.rel} ~ ${g.motif}`).toBe(g.ok);
  });

  it("_fold_confusable", () => {
    for (const r of V.replis) expect(foldConfusable(r.nom), r.nom).toBe(r.pli);
  });

  it("twin_message", () => {
    for (const j of V.jumeaux) expect(twinMessage(j.paires)).toBe(j.message);
  });

  it("_titleize (TitleFiller) = str.title()", () => {
    for (const t of V.titres) {
      const s = t.nom.replaceAll("_", " ").trim();
      expect(titlePy(s) || t.nom, t.nom).toBe(t.titre);
    }
    expect(titlePy("ǆemal ßa ﬁx ᾳ ა")).toBe("ǅemal Ssa Fix ᾼ ა");
  });

  it("_safe_chat_id", () => {
    for (const c of V.chats) expect(safeChatId(c.v), JSON.stringify(c.v)).toBe(c.id);
  });

  it("pydantic_core.to_json", () => {
    for (const j of V.json) expect(jsonPydantic(detaguer(j.v)), j.texte).toBe(j.texte);
    expect(() => jsonPydantic("\ud800")).toThrow(ErreurPython);
  });
});

/** Contexte d'appel minimal : journal capturé. */
function contexte(meta: Record<string, unknown> | null): ContexteAppel & { journaux: unknown[] } {
  const journaux: unknown[] = [];
  const log = (message: string, o: OptionsJournal = {}): Promise<void> => {
    journaux.push({ message, ...o });
    return Promise.resolve();
  };
  return {
    nomOutil: "t",
    meta,
    famille: null,
    signal: new AbortController().signal,
    journaux,
    log,
    debug: (m, o) => log(m, { ...o, level: "debug" }),
    info: (m, o) => log(m, { ...o, level: "info" }),
    warning: (m, o) => log(m, { ...o, level: "warning" }),
    error: (m, o) => log(m, { ...o, level: "error" }),
    reportProgress: () => Promise.resolve(),
  };
}

describe("identité d'un appel", () => {
  const acces = (claims: Record<string, unknown>) => ({
    token: "t",
    client_id: "ext:bob",
    scopes: ["local-tools"],
    expires_at: null,
    claims,
  });

  it("jeton client prime sur le _meta ; jeton de service : _meta ; rien : argument hérité puis guest", () => {
    const ctx = contexte({ username: "Al.ice", chat_id: "c/1" });
    expect(avecJeton(acces({ username: "bob", trusted_meta: false }), () => getUsername(ctx))).toBe("bob");
    expect(avecJeton(acces({ trusted_meta: false }), () => getUsername(ctx))).toBe("extbob");
    expect(avecJeton(acces({ trusted_meta: true, username: "x" }), () => getUsername(ctx))).toBe("Alice");
    expect(getUsername(contexte({}), "carl")).toBe("carl");
    expect(getUsername(null)).toBe("guest");
    expect(getChatId(ctx)).toBe("c1");
    expect(getChatId(contexte({ chat_id: "" }), "")).toBe("default");
  });
});

describe("battement", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("notifie heartbeat avec call_id et log_token, s'arrête, rien sans contexte ni intervalle", async () => {
    vi.useFakeTimers();
    const ctx = contexte({ call_id: "c1", log_token: "l1" });
    const b = new Heartbeat(ctx, { intervalS: 1 });
    await b.avec(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(b.ticks).toBe(2);
    expect(ctx.journaux[0]).toMatchObject({
      message: "heartbeat",
      level: "info",
      loggerName: "elpis.heartbeat",
      extra: { kind: "heartbeat", call_id: "c1", log_token: "l1" },
    });
    expect(new Heartbeat(null, { intervalS: 1 }).start()).toBeInstanceOf(Heartbeat);
    const zero = new Heartbeat(ctx, { intervalS: 0 }).start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(zero.ticks).toBe(0);
  });
});

describe("jumeaux Unicode sur disque", () => {
  it("avertit pour un composant nouveau qui ne diffère que par les accents ; rien sous un dossier existant", () => {
    const racine = mkdtempSync(join(tmpdir(), "elpis-jumeaux-"));
    try {
      mkdirSync(join(racine, "projet-devinette"));
      expect(unicodeTwinWarning(join(racine, "projét-devinette", "a.txt"), racine)).toBe(
        twinMessage([["projet-devinette", "projét-devinette"]]),
      );
      expect(unicodeTwinWarning(join(racine, "projet-devinette", "A.txt"), racine)).toBeNull();
      expect(unicodeTwinWarning("/ailleurs/x", racine)).toBeNull();
      expect(unicodeTwinWarning(join(racine, "PROJET-devinette"), racine, 0)).toBeNull();
    } finally {
      rmSync(racine, { recursive: true, force: true });
    }
  });
});
