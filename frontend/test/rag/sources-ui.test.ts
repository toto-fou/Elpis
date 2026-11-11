// SPDX-License-Identifier: MIT
/** frontend/test/rag/sources-ui.test.ts — sources d'une réponse côté interface : quels messages ont des renvois, résolution dans les messages précédents, ensemble parcouru par la visionneuse, Échap. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creerSources } from "../../src/features/rag/sources-ui";
import type { MessageSources } from "../../src/features/rag/sources-ui";
import { collection, fausseApi, ok, document as doc } from "./aides";
import { reponse, source } from "./aides-sources";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const COLL = collection(1);
const premier = [
  source(1, { collectionId: COLL.id }),
  source(2, { collectionId: COLL.id }),
  source(3, { collectionId: COLL.id, cited: false }),
];
const second = [source(4, { collectionId: COLL.id, document: "notes.md", doc: "d2", page: null })];

function monter(messages: MessageSources[], ragActif = false) {
  const api = fausseApi({
    document: vi.fn(async () => ok(doc(1, COLL.id, { pages: 3 }))),
    passages: vi.fn(async () => ok({ passages: [], chunk_count: 10, restricted: false })),
    localiser: vi.fn(async () =>
      ok({ page: null, boxes: [], score: 0, page_width: null, page_height: null }),
    ),
  });
  const fermerEditeur = vi.fn();
  const s = creerSources({
    api,
    fetchAuth: vi.fn(async () => new Response(new Blob(["x"]), { status: 200 })),
    messages: () => messages,
    collections: () => [COLL],
    ragActif: () => ragActif,
    fermerEditeur,
  });
  return { s, fermerEditeur };
}

describe("renvoisPour", () => {
  it("aucun renvoi pour un message d'utilisateur, ni dans une conversation sans RAG", () => {
    const m = [{ role: "user" }, reponse("Texte [1]", [])];
    const { s } = monter(m);
    expect(s.renvoisPour(0)).toBeNull();
    expect(s.renvoisPour(1)).toBeNull();
    expect(s.renvoisPour(9)).toBeNull();
  });

  it("une réponse qui porte des sources résout ses [n] ; un numéro absent est inconnu", () => {
    const { s } = monter([{ role: "user" }, reponse("[1] [2]", premier)]);
    const r = s.renvoisPour(1);
    expect(r?.resoudre(2)?.n).toBe(2);
    expect(r?.resoudre(99)).toBeNull();
  });

  it("un [n] d'un tour précédent se résout dans les messages d'avant", () => {
    const { s } = monter([
      { role: "user" },
      reponse("a", premier),
      { role: "user" },
      reponse("rappel [2]", []),
    ]);
    expect(s.renvoisPour(3)?.resoudre(2)?.passage.document_name).toBe("procedure-vpn-ipsec-sites.docx");
  });

  it("collections actives sans aucune source : seule la dernière réponse a des renvois (inconnus)", () => {
    const m = [{ role: "user" }, reponse("vieux [1]", []), { role: "user" }, reponse("récent [1]", [])];
    const { s } = monter(m, true);
    expect(s.renvoisPour(1)).toBeNull();
    expect(s.renvoisPour(3)?.resoudre(1)).toBeNull();
  });

  it("la pastille courante suit la bulle puis la visionneuse", async () => {
    const { s } = monter([{ role: "user" }, reponse("[1]", premier)]);
    const r = s.renvoisPour(1);
    expect(r?.courante()).toBeNull();
    r?.survol(2, document.createElement("button"));
    vi.advanceTimersByTime(200);
    expect(r?.courante()).toBe(2);
    s.bulle.fermer();
    await s.visionneuse.ouvrir(premier[0] ?? source(1), premier);
    expect(r?.courante()).toBe(1);
  });
});

describe("voir et fermer", () => {
  it("la visionneuse parcourt les sources citées du message qui porte la source cliquée, l'éditeur se ferme", async () => {
    const m = [{ role: "user" }, reponse("a", premier), { role: "user" }, reponse("b", second)];
    const { s, fermerEditeur } = monter(m);
    await s.voir(second[0] ?? source(4), 3);
    expect(s.visionneuse.ensemble.value.map((x) => x.n)).toEqual([4]);
    expect(fermerEditeur).toHaveBeenCalled();
    await s.voir(premier[2] ?? source(3), 1);
    expect(s.visionneuse.ensemble.value.map((x) => x.n)).toEqual([1, 2, 3]);
    expect(s.visionneuse.numero.value).toBe(3);
  });

  it("Échap ferme la bulle d'abord, puis la visionneuse ; fermer vide tout", async () => {
    const { s } = monter([{ role: "user" }, reponse("a", premier)]);
    await s.voir(premier[0] ?? source(1), 1);
    s.bulle.survol(premier[1] ?? source(2), document.createElement("button"), () => undefined);
    vi.advanceTimersByTime(200);
    expect(s.echap()).toBe(true);
    expect(s.bulle.etat.value).toBeNull();
    expect(s.visionneuse.ouverte.value).toBe(true);
    expect(s.echap()).toBe(true);
    expect(s.visionneuse.ouverte.value).toBe(false);
    expect(s.echap()).toBe(false);
    await s.voir(premier[0] ?? source(1), 1);
    s.fermer();
    expect(s.visionneuse.ouverte.value).toBe(false);
  });

  it("« Voir dans le document » de la bulle ferme la bulle avant d'ouvrir", async () => {
    const { s } = monter([{ role: "user" }, reponse("a", premier)]);
    const r = s.renvoisPour(1);
    r?.survol(1, document.createElement("button"));
    vi.advanceTimersByTime(200);
    r?.ouvrir(1, document.createElement("button"));
    await vi.advanceTimersByTimeAsync(10);
    expect(s.bulle.etat.value).toBeNull();
    expect(s.visionneuse.numero.value).toBe(1);
  });
});
