// SPDX-License-Identifier: MIT
/** frontend/test/rag/notice-recherche.test.ts — notice de `/rag search` : fusion des passages de plusieurs collections, écriture dans `summary` et relecture validée, sources de la visionneuse. */
import { describe, expect, it } from "vitest";

import {
  creerNotice,
  fusionnerPassages,
  lireNotice,
  serialiserNotice,
  sourcesDeNotice,
} from "../../src/features/rag/notice-recherche";
import { passageTrouve } from "./aides-sources";

describe("fusion", () => {
  it("la pertinence départage, puis le rang ; les rangs sont refaits de 1 à N", () => {
    const a = [
      passageTrouve(1, { relevance: 1, doc: "d1" }),
      passageTrouve(2, { relevance: 0.6, doc: "d1" }),
    ];
    const b = [
      passageTrouve(1, { relevance: 1, doc: "d2" }),
      passageTrouve(2, { relevance: 0.8, doc: "d2" }),
    ];
    const f = fusionnerPassages([a, b], 3);
    expect(f.map((p) => [p.rank, p.relevance, p.document_id.endsWith("101") ? "d1" : "d2"])).toEqual([
      [1, 1, "d1"],
      [2, 1, "d2"],
      [3, 0.8, "d2"],
    ]);
  });

  it("l'extrait est coupé à la taille des sources enregistrées", () => {
    const [p] = fusionnerPassages([[passageTrouve(1, { texte: "x".repeat(3000) })]], 8);
    expect(p?.text.length).toBe(1200);
    expect(p?.text.endsWith("…")).toBe(true);
  });
});

describe("notice", () => {
  const notice = creerNotice({
    requete: "renouvellement certificat",
    mode: "mixte",
    duree_ms: 420,
    collections: [{ id: "c", name: "Procédures réseau" }],
    passages: [passageTrouve(1), passageTrouve(2)],
    erreurs: ["« Contrats » : La base vectorielle est indisponible."],
  });

  it("s'écrit dans summary et se relit à l'identique", () => {
    expect(lireNotice(serialiserNotice(notice))).toEqual(notice);
  });

  it("un contenu absent, illisible ou hors contrat n'est pas une notice", () => {
    expect(lireNotice(null)).toBeNull();
    expect(lireNotice("")).toBeNull();
    expect(lireNotice("pas du json")).toBeNull();
    expect(lireNotice(JSON.stringify({ v: 2 }))).toBeNull();
    expect(lireNotice(JSON.stringify({ ...notice, passages: [{ rank: 1 }] }))).toBeNull();
  });

  it("les passages deviennent des sources numérotées par leur rang, avec les mots de la question", () => {
    const s = sourcesDeNotice(notice);
    expect(s.map((x) => [x.n, x.cited, x.query, x.rank])).toEqual([
      [1, true, "renouvellement certificat", 1],
      [2, true, "renouvellement certificat", 2],
    ]);
    expect(s[0]?.passage.document_name).toBe("procedure-vpn-ipsec-sites.docx");
  });
});
