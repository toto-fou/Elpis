// SPDX-License-Identifier: MIT
/** apps/core/test/memoire/sessions.test.ts — recherche de sessions rejouée sur les vecteurs Python (termes, SQL des deux moteurs, extraits, recherches sur une base SQLite remplie à l'identique), plein texte absent compris. */
import "../moteur-environnement";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pgFtsDocument, initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";

import {
  ftsSearchSql,
  ftsSnippetSql,
  ftsTerms,
  manualExcerpt,
  PONCTUATION_FTS,
  SEARCH_ROLES,
  sessionIndexMessages,
  sessionMessageByRef,
  sessionSearchFts,
  sessionSearchSnippets,
} from "../../src/memoire/sessions";
import { lireVecteurs } from "../vecteurs-moteur";
import { degraderPleinTexte, rejouerRecherches, remplirSessions } from "./aides-sessions";
import type { Reponse, SpecSessions } from "./aides-sessions";

type Dialecte = "sqlite" | "postgres";

const V = lireVecteurs<{
  termes: { tokens: string[]; sqlite: string; postgres: string }[];
  sql: {
    dialecte: Dialecte;
    tokens: string[];
    uid: number;
    roles: string[];
    lim: number;
    recherche: [string, unknown[]];
    extraits: [string, unknown[]];
  }[];
  extraits: { contenu: unknown; tokens: string[]; extrait: string }[];
  spec: SpecSessions;
  resultats: Reponse[];
  degrade: Reponse[];
}>("memoire-sessions");

describe("termes et SQL de la recherche de sessions (vecteurs Python)", () => {
  it("la ponctuation retirée de la requête est celle de l'index PostgreSQL", () => {
    expect(pgFtsDocument("c")).toBe(
      `translate(c, '${PONCTUATION_FTS.replaceAll("'", "''")}', '${" ".repeat(Array.from(PONCTUATION_FTS).length)}')`,
    );
  });

  it("_fts_terms identique pour FTS5 et PostgreSQL", () => {
    for (const c of V.termes) {
      expect(ftsTerms(c.tokens, "sqlite"), JSON.stringify(c.tokens)).toBe(c.sqlite);
      expect(ftsTerms(c.tokens, "postgres"), JSON.stringify(c.tokens)).toBe(c.postgres);
    }
  });

  it("_fts_search_sql et _fts_snippet_sql identiques, texte et paramètres, sur les deux moteurs", () => {
    expect(V.sql.length).toBeGreaterThan(50);
    for (const c of V.sql) {
      expect(ftsSearchSql(c.tokens, c.uid, c.lim, c.dialecte), JSON.stringify(c)).toEqual(c.recherche);
      expect(ftsSnippetSql(c.tokens, c.uid, c.roles, c.lim, c.dialecte), JSON.stringify(c)).toEqual(
        c.extraits,
      );
    }
  });

  it("_manual_excerpt (repli sans plein texte) identique, positions de la forme repliée appliquées au texte comme Python", () => {
    for (const c of V.extraits)
      expect(manualExcerpt(c.contenu, c.tokens), JSON.stringify(c.contenu).slice(0, 60)).toBe(c.extrait);
  });

  it("aucun mot de la requête ne sort de sa phrase : guillemets doublés en FTS5, aucun guillemet en PostgreSQL", () => {
    const piege = ['a" OR "b', '"', "x*", "NEAR(a b)", "content:secret", "-nginx", "^debut", "a b"];
    expect(ftsTerms(piege, "sqlite")).toBe(piege.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR "));
    const pg = ftsTerms(piege, "postgres");
    expect(pg.match(/"/gu)?.length ?? 0).toBe(2 * pg.split(" or ").length);
    expect(pg).not.toMatch(/[*^:()-]/u);
    expect(SEARCH_ROLES).toEqual(["user", "assistant", "tool", "tool_call"]);
  });
});

/** Base neuve remplie comme celle de Python (chaque test qui la modifie ouvre la sienne). */
async function baseRemplie(moteur: "sqlite" | "postgres"): Promise<BaseDeTest> {
  const t = ouvrirBaseDeTest(moteur);
  await initialiserBase(t.base);
  await remplirSessions(t.base, V.spec);
  return t;
}

describe("recherches sur une base SQLite remplie comme celle de Python", () => {
  let t: BaseDeTest;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await remplirSessions(t.base, V.spec);
  });
  afterAll(async () => {
    await t.fermer();
  });

  it("mêmes lignes, mêmes extraits, même ordre, mêmes erreurs de type, sur chaque recherche", async () => {
    const reponses = await rejouerRecherches(t.base, V.spec.recherches);
    expect(reponses).toHaveLength(V.resultats.length);
    reponses.forEach((r, i) => expect(r, JSON.stringify(V.spec.recherches[i])).toEqual(V.resultats[i]));
    expect(reponses.some((r) => "valeur" in r && Array.isArray(r.valeur) && r.valeur.length > 0)).toBe(true);
  });

  it("plein texte absent : repli LIKE et extraits de repli identiques à Python", async () => {
    const d = await baseRemplie("sqlite");
    try {
      await degraderPleinTexte(d.base);
      const reponses = await rejouerRecherches(d.base, V.spec.recherches);
      reponses.forEach((r, i) => expect(r, JSON.stringify(V.spec.recherches[i])).toEqual(V.degrade[i]));
    } finally {
      await d.fermer();
    }
  });
});

/** Aucune recherche ne sort des lignes d'un autre compte : propriétaire par `ref` (id = rang dans le corpus + 1), ou par contenu et session pour les messages entiers de `fts`. */
function sansFuite(recherches: SpecSessions["recherches"], reponses: Reponse[]): void {
  const proprietaire = (ref: number): unknown => V.spec.corpus[ref - 1]?.["user_id"];
  const appartient = (uid: number | null, l: { content?: string; session_id?: string }): boolean =>
    V.spec.corpus.some(
      (c) =>
        c["user_id"] === uid && c["session_id"] === l.session_id && String(c["content"]).trim() === l.content,
    );
  reponses.forEach((r, i) => {
    const q = recherches[i];
    if (!q || !("valeur" in r) || r.valeur === null) return;
    const lignes = Array.isArray(r.valeur) ? r.valeur : [r.valeur];
    for (const l of lignes as { ref?: number; content?: string; session_id?: string }[]) {
      if (typeof l.ref === "number") expect(proprietaire(l.ref), JSON.stringify(q)).toBe(q.uid);
      else if (typeof l.content === "string")
        expect(appartient(q.uid, l), JSON.stringify([q, l.session_id])).toBe(true);
    }
  });
}

describe.each(PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const))(
  "isolation entre comptes et requêtes piégées (%s)",
  (moteur) => {
    let t: BaseDeTest;

    beforeAll(async () => {
      t = ouvrirBaseDeTest(moteur);
      await initialiserBase(t.base);
      await remplirSessions(t.base, V.spec);
    });
    afterAll(async () => {
      await t.fermer();
    });

    it("chaque recherche ne rend que des lignes du compte appelant, un ref d'un autre compte est inconnu, aucune requête ne modifie la table", async () => {
      const avant = await t.base.get<{ n: number }>("SELECT COUNT(*) AS n FROM session_messages");
      const reponses = await rejouerRecherches(t.base, V.spec.recherches);
      sansFuite(V.spec.recherches, reponses);
      const trouvees = reponses.filter(
        (r) => "valeur" in r && Array.isArray(r.valeur) && r.valeur.length > 0,
      );
      expect(trouvees.length).toBeGreaterThan(100);
      const apres = await t.base.get<{ n: number }>("SELECT COUNT(*) AS n FROM session_messages");
      expect(Number(apres?.n)).toBe(Number(avant?.n));
      const autres = V.spec.corpus.map((c, i) => [c["user_id"], i + 1] as const).filter(([u]) => u !== 1);
      for (const [, ref] of autres) {
        expect(await rejouerRecherches(t.base, [{ type: "ref", uid: 1, ref }])).toEqual([{ valeur: null }]);
      }
    });

    it("une requête avec guillemets, opérateurs ou SQL reste une simple suite de mots", async () => {
      const pieges = [
        `'; DROP TABLE session_messages; --`,
        `nginx" OR "x`,
        `") OR 1=1 --`,
        `NEAR(nginx certificat, 2)`,
        `content:nginx -apache`,
        `{}[]()^*:`,
      ];
      const reponses = await rejouerRecherches(
        t.base,
        pieges.flatMap((query) => [
          { type: "fts" as const, uid: 2, query },
          { type: "snippets" as const, uid: 2, query },
        ]),
      );
      sansFuite(
        pieges.flatMap((query) => [
          { type: "fts" as const, uid: 2, query },
          { type: "snippets" as const, uid: 2, query },
        ]),
        reponses,
      );
      expect(reponses.every((r) => "valeur" in r)).toBe(true);
      expect(Number((await t.base.get<{ n: number }>("SELECT COUNT(*) AS n FROM session_messages"))?.n)).toBe(
        V.spec.corpus.length,
      );
    });

    it("plein texte absent : le repli LIKE répond, toujours limité au compte", async () => {
      const d = await baseRemplie(moteur);
      try {
        await degraderPleinTexte(d.base);
        const reponses = await rejouerRecherches(d.base, V.spec.recherches);
        sansFuite(V.spec.recherches, reponses);
        expect(
          reponses.filter((r) => "valeur" in r && Array.isArray(r.valeur) && r.valeur.length > 0).length,
        ).toBeGreaterThan(50);
      } finally {
        await d.fermer();
      }
    });
  },
);

describe("cas des tests pytest de l'index FTS5 (session_search_fts)", () => {
  let t: BaseDeTest;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    for (const nom of ["alice", "bob"])
      await t.base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, settings_json) VALUES (?,?,?,?,?)",
        [nom, "s", "h", 0, "{}"],
      );
    const ligne = (
      user_id: number,
      app: string,
      session_id: string,
      content: string,
    ): Record<string, unknown> => ({
      user_id,
      app,
      session_id,
      scope_key: "",
      role: "user",
      content,
    });
    await sessionIndexMessages(t.base, [
      ligne(1, "chat", "c1", "comment configurer le serveur nginx"),
      ligne(1, "chat", "c1", "il faut editer le fichier de configuration"),
      ligne(1, "chat", "c1", "banane chat"),
      ligne(1, "agentic", "run9", "banane agentic"),
      ligne(1, "chat", "c1", "   "),
      ligne(1, "chat", "c1", "secret alpha"),
      ligne(2, "chat", "c2", "secret alpha"),
    ]);
  });
  afterAll(async () => {
    await t.fermer();
  });

  it("aller-retour : un mot retrouve son message entier ; la recherche couvre chat et agentic ; requête vide ou blanche : rien", async () => {
    const nginx = await sessionSearchFts(t.base, 1, "nginx", 10);
    expect(nginx).toHaveLength(1);
    expect(nginx[0]).toMatchObject({ app: "chat", content: "comment configurer le serveur nginx" });
    const bananes = await sessionSearchFts(t.base, 1, "banane", 10);
    expect(new Set(bananes.map((r) => r.app))).toEqual(new Set(["chat", "agentic"]));
    expect(await sessionSearchFts(t.base, 1, "", 10)).toEqual([]);
    expect(await sessionSearchFts(t.base, 1, "   ", 10)).toEqual([]);
    expect(await sessionSearchFts(t.base, null, "nginx", 10)).toEqual([]);
  });

  it("la recherche est limitée au compte, une ref d'un autre compte est inconnue", async () => {
    expect(await sessionSearchFts(t.base, 1, "alpha", 10)).toHaveLength(1);
    expect(await sessionSearchFts(t.base, 2, "alpha", 10)).toHaveLength(1);
    const [autre] = await sessionSearchSnippets(t.base, 2, "alpha");
    expect(autre?.ref).toBeGreaterThan(0);
    expect(await sessionMessageByRef(t.base, 1, autre?.ref)).toBeNull();
    expect(await sessionMessageByRef(t.base, 2, autre?.ref)).toMatchObject({
      content: "secret alpha",
      truncated: false,
    });
  });

  it("un compte qui n'est pas un entier : snippets et ref rendent vide comme Python, sans lever", async () => {
    for (const uid of ["abc", [], {}] as unknown[]) {
      expect(await sessionSearchSnippets(t.base, uid as number, "nginx")).toEqual([]);
      expect(await sessionMessageByRef(t.base, uid as number, 1)).toBeNull();
    }
  });

  it("un contenu blanc n'est pas indexé", async () => {
    const n = await t.base.get<{ n: number }>("SELECT COUNT(*) AS n FROM session_messages");
    expect(Number(n?.n)).toBe(6);
  });
});
