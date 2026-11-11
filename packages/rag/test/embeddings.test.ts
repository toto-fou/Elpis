// SPDX-License-Identifier: MIT
/** packages/rag/test/embeddings.test.ts — client d'embeddings contre un faux serveur : lots, ordre, reprises, délais, abandon, sonde, cache. */
import { afterEach, describe, expect, it } from "vitest";

import { ClientEmbeddings, lireVecteurs, prefixeContexte, texteAvecContexte } from "../src/embeddings";
import type { OptionsEmbeddings } from "../src/embeddings";
import { ErreurRag } from "../src/erreurs";
import { demarrerServeurFaux } from "./serveur-faux";
import type { Gestionnaire, ServeurFaux } from "./serveur-faux";

const serveurs: ServeurFaux[] = [];

/** Vecteur de dimension 3 déduit du texte (longueur, voyelles, majuscules). */
function vecteurDe(texte: string): number[] {
  return [texte.length, (texte.match(/[aeiou]/g) ?? []).length, (texte.match(/[A-Z]/g) ?? []).length];
}

const repond: Gestionnaire = (r) => {
  const { input } = r.corps as { input: string[] };
  return { json: { data: input.map((t, index) => ({ index, embedding: vecteurDe(t) })) } };
};

async function monter(
  g: Gestionnaire,
  options: Partial<OptionsEmbeddings> = {},
): Promise<{ c: ClientEmbeddings; s: ServeurFaux; pauses: number[] }> {
  const s = await demarrerServeurFaux(g);
  serveurs.push(s);
  const pauses: number[] = [];
  const c = new ClientEmbeddings({
    url: s.url,
    modele: "bge-m3",
    attendre: (ms) => {
      pauses.push(ms);
      return Promise.resolve();
    },
    ...options,
  });
  return { c, s, pauses };
}

afterEach(async () => {
  await Promise.all(serveurs.splice(0).map((s) => s.arreter()));
});

describe("lots et ordre", () => {
  it("découpe en lots de 32 et rend les vecteurs dans l'ordre des textes", async () => {
    const { c, s } = await monter(repond);
    const textes = Array.from({ length: 70 }, (_, i) => `texte numéro ${"x".repeat(i)}`);
    const progres: string[] = [];
    const v = await c.embedder(textes, { surProgres: (f, t) => progres.push(`${f}/${t}`) });
    expect(v).toEqual(textes.map(vecteurDe));
    expect(s.requetes.map((r) => (r.corps as { input: string[] }).input.length)).toEqual([32, 32, 6]);
    expect(progres).toEqual(["32/70", "64/70", "70/70"]);
    expect(s.requetes[0]).toMatchObject({ methode: "POST", chemin: "/v1/embeddings" });
    expect((s.requetes[0]?.corps as { model: string }).model).toBe("bge-m3");
  });

  it("respecte la taille de lot demandée et l'ordre d'une réponse mélangée", async () => {
    const { c, s } = await monter(
      (r) => {
        const { input } = r.corps as { input: string[] };
        return { json: { data: input.map((t, index) => ({ index, embedding: vecteurDe(t) })).reverse() } };
      },
      { tailleLot: 2 },
    );
    const v = await c.embedder(["aa", "bbb", "cccc", "d", "ee"]);
    expect(v.map((x) => x[0])).toEqual([2, 3, 4, 1, 2]);
    expect(s.requetes).toHaveLength(3);
  });

  it("n'envoie pas les textes blancs et rend un vecteur vide à leur place", async () => {
    const { c, s } = await monter(repond);
    const v = await c.embedder(["un", "  ", "", "deux\n"]);
    expect(v).toEqual([vecteurDe("un"), [], [], vecteurDe("deux\n")]);
    expect((s.requetes[0]?.corps as { input: string[] }).input).toEqual(["un", "deux\n"]);
    expect(await c.embedder([])).toEqual([]);
    expect(await c.embedder([" "])).toEqual([[]]);
    expect(s.requetes).toHaveLength(1);
  });

  it("envoie la clé d'API en Bearer et accepte une URL terminée par /v1", async () => {
    const { c, s } = await monter(repond, { cleApi: "k" });
    await c.embedder(["x"]);
    expect(s.requetes[0]?.entetes["authorization"]).toBe("Bearer k");
    const sv = await demarrerServeurFaux(repond);
    serveurs.push(sv);
    await new ClientEmbeddings({ url: `${sv.url}/v1/`, modele: "m" }).embedder(["x"]);
    expect(sv.requetes[0]?.chemin).toBe("/v1/embeddings");
  });
});

describe("reprises", () => {
  it("reprend sur 503 puis réussit, avec une attente croissante", async () => {
    const { c, s, pauses } = await monter((r, n) =>
      n < 3 ? { statut: 503, texte: "chargement du modèle" } : repond(r, n),
    );
    expect(await c.embedder(["abc"])).toEqual([vecteurDe("abc")]);
    expect(s.requetes).toHaveLength(4);
    expect(pauses).toEqual([1000, 2000, 4000]);
  });

  it("reprend sur 408 et 429 en respectant Retry-After", async () => {
    const { c, s, pauses } = await monter((r, n) => {
      if (n === 0) return { statut: 429, entetes: { "retry-after": "7" }, texte: "trop vite" };
      if (n === 1) return { statut: 408 };
      return repond(r, n);
    });
    await c.embedder(["abc"]);
    expect(s.requetes).toHaveLength(3);
    expect(pauses).toEqual([7000, 2000]);
  });

  it("abandonne après trois reprises avec le statut et un extrait du corps", async () => {
    const { c, s } = await monter(() => ({ statut: 500, texte: "kaboom" }));
    const e = await c.embedder(["abc"]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurRag);
    expect(e).toMatchObject({
      code: "embeddings_http",
      statut: 500,
      message: expect.stringContaining("kaboom"),
    });
    expect(s.requetes).toHaveLength(4);
  });

  it("ne reprend pas sur une erreur client (400, 401)", async () => {
    const { c, s, pauses } = await monter(() => ({ statut: 400, json: { error: "input too large" } }));
    await expect(c.embedder(["abc"])).rejects.toMatchObject({ code: "embeddings_http", statut: 400 });
    expect(s.requetes).toHaveLength(1);
    expect(pauses).toEqual([]);
  });

  it("reprend sur une connexion coupée", async () => {
    const { c, s } = await monter((r, n) => (n === 0 ? { couper: true } : repond(r, n)));
    expect(await c.embedder(["abc"])).toEqual([vecteurDe("abc")]);
    expect(s.requetes).toHaveLength(2);
  });

  it("rend injoignable quand personne n'écoute, après les reprises", async () => {
    const pauses: number[] = [];
    const c = new ClientEmbeddings({
      url: "http://127.0.0.1:1",
      modele: "m",
      delaiMs: 500,
      attendre: (ms) => (pauses.push(ms), Promise.resolve()),
    });
    await expect(c.embedder(["abc"])).rejects.toMatchObject({ code: "embeddings_injoignable" });
    expect(pauses).toEqual([1000, 2000, 4000]);
  });

  it("applique le nombre de reprises demandé (option du client ou de l'appel)", async () => {
    const { c, s } = await monter(() => ({ statut: 502 }), { reprises: 1 });
    await expect(c.embedder(["a"])).rejects.toMatchObject({ statut: 502 });
    expect(s.requetes).toHaveLength(2);
    await expect(c.embedder(["a"], { reprises: 0 })).rejects.toMatchObject({ statut: 502 });
    expect(s.requetes).toHaveLength(3);
  });
});

describe("délai et abandon", () => {
  it("rend delai quand le serveur est trop lent, après les reprises", async () => {
    const { c, s } = await monter(() => ({ json: { data: [] }, attenteMs: 300 }), {
      delaiMs: 40,
      reprises: 1,
    });
    await expect(c.embedder(["a"])).rejects.toMatchObject({ code: "delai" });
    expect(s.requetes).toHaveLength(2);
  });

  it("s'arrête dès que le signal est abandonné, sans nouvelle requête", async () => {
    const { c, s } = await monter(() => ({ statut: 503 }), {
      attendre: (_ms, signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason as unknown), { once: true });
        }),
    });
    const ctl = new AbortController();
    const attente = c.embedder(["a"], { signal: ctl.signal });
    setTimeout(() => ctl.abort(new Error("stop")), 50);
    await expect(attente).rejects.toThrow("stop");
    expect(s.requetes).toHaveLength(1);
  });

  it("rejette tout de suite avec un signal déjà abandonné", async () => {
    const { c, s } = await monter(repond);
    const ctl = new AbortController();
    ctl.abort(new Error("déjà"));
    await expect(c.embedder(["a"], { signal: ctl.signal })).rejects.toThrow("déjà");
    expect(s.requetes).toHaveLength(0);
  });
});

describe("réponses invalides", () => {
  it("refuse une réponse sans data, avec un vecteur manquant ou non numérique", () => {
    expect(() => lireVecteurs({}, 1)).toThrow(expect.objectContaining({ code: "embeddings_reponse" }));
    expect(() => lireVecteurs({ data: [{ index: 0, embedding: [1] }] }, 2)).toThrow(/manquant/);
    expect(() => lireVecteurs({ data: [{ index: 0, embedding: ["x"] }] }, 1)).toThrow(/invalide/);
    expect(() => lireVecteurs({ data: [{ index: 0, embedding: [] }] }, 1)).toThrow(/invalide/);
    expect(() => lireVecteurs({ data: [{ embedding: [1, 2] }, { embedding: [1] }] }, 2)).toThrow(
      /dimensions/,
    );
    expect(lireVecteurs({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }, 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("rend embeddings_reponse sur un corps qui n'est pas du JSON", async () => {
    const { c } = await monter(() => ({ texte: "<html>pas du json</html>" }));
    await expect(c.embedder(["a"])).rejects.toMatchObject({ code: "embeddings_reponse" });
  });
});

describe("requête, dimension, contexte", () => {
  it("garde les requêtes récentes en cache et ne reprend qu'une fois par défaut", async () => {
    const { c, s } = await monter(repond, { cacheRequetes: 2 });
    const a = await c.embedderRequete("question");
    a.push(99);
    expect(await c.embedderRequete("question")).toEqual(vecteurDe("question"));
    expect(s.requetes).toHaveLength(1);
    await c.embedderRequete("autre");
    await c.embedderRequete("troisième");
    await c.embedderRequete("question");
    expect(s.requetes).toHaveLength(4);
    const { c: c2, s: s2 } = await monter(() => ({ statut: 500 }));
    await expect(c2.embedderRequete("q")).rejects.toMatchObject({ statut: 500 });
    expect(s2.requetes).toHaveLength(2);
  });

  it("sonde la dimension une seule fois", async () => {
    const { c, s } = await monter(repond);
    expect(await c.sonderDimension()).toBe(3);
    expect(await c.sonderDimension()).toBe(3);
    expect(s.requetes).toHaveLength(1);
  });

  it("formate le préfixe de contexte", () => {
    expect(prefixeContexte({ document: "contrat.pdf", section: "3 › 3.2 Renouvellement" })).toBe(
      "[Document : contrat.pdf | Section : 3 › 3.2 Renouvellement]\n",
    );
    expect(prefixeContexte({ document: "a\nb.pdf", section: "" })).toBe("[Document : a b.pdf]\n");
    expect(texteAvecContexte({ document: "d.md", heading_path: "A", text: "Corps" })).toBe(
      "[Document : d.md | Section : A]\nCorps",
    );
    expect(prefixeContexte({ document: "x".repeat(500) }).length).toBeLessThan(260);
  });
});
