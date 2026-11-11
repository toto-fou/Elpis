// SPDX-License-Identifier: MIT
/** frontend/test/rag/sources-composants.test.ts — pied de sources, bulle, visionneuse et notice du fil montés sur le vrai module RAG : titres, documents cités, passages non cités, bulle au survol et au focus, mode Page et Texte, navigation, lecteur restreint, notice de recherche. */
import { createApp, effectScope, h, nextTick, reactive } from "vue";
import type { App, VNode } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import BulleSource from "../../src/components/rag/BulleSource.vue";
import NoticeRecherche from "../../src/components/rag/NoticeRecherche.vue";
import PiedSources from "../../src/components/rag/PiedSources.vue";
import VisionneuseSource from "../../src/components/rag/VisionneuseSource.vue";
import { CLE_RAG } from "../../src/features/rag/domaine";
import type { DomaineRag } from "../../src/features/rag/domaine";
import { creerRag } from "../../src/features/rag/rag";
import { creerNotice, serialiserNotice } from "../../src/features/rag/notice-recherche";
import { ref } from "vue";
import {
  collection,
  document as doc,
  echec,
  fausseApi,
  fauxCtx,
  faussesRefs,
  ok,
  partagee,
  vider,
} from "./aides";
import { passageTrouve, reponse, source } from "./aides-sources";

let app: App | null = null;
let scope: ReturnType<typeof effectScope> | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  scope?.stop();
  scope = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const COLL = collection(1, { name: "Procédures réseau" });

const SOURCES = [
  source(1, {
    document: "renouvellement-certificats.md",
    doc: "d1",
    page: null,
    section: "Renouvellement › Tunnels IPsec",
    collectionId: COLL.id,
  }),
  source(2, {
    document: "procedure-vpn-ipsec-sites.docx",
    doc: "d2",
    page: 7,
    collectionId: COLL.id,
    boxes: [[7, 100, 200, 300, 260]],
  }),
  source(3, {
    document: "renouvellement-certificats.md",
    doc: "d1",
    page: null,
    section: "Vérifications",
    collectionId: COLL.id,
  }),
  source(4, { document: "procedure-vpn-ipsec-sites.docx", doc: "d2", page: 8, collectionId: COLL.id }),
  source(5, { document: "guide.pdf", doc: "d3", cited: false, collectionId: COLL.id }),
  source(6, {
    document: "plan.txt",
    doc: "d4",
    cited: false,
    collectionId: COLL.id,
    texte: "Le réseau de Lille.",
  }),
];

interface Options {
  collections?: ReturnType<typeof collection>[];
  messages?: unknown[];
  api?: Parameters<typeof fausseApi>[0];
  fetchAuth?: (url: string) => Promise<Response | null>;
  composants?: unknown[];
  /** Rendu libre du composant monté (props) ; par défaut les `composants` sans props. */
  rendu?: () => VNode;
}

async function monter(o: Options = {}) {
  const api = fausseApi({
    document: vi.fn(async () =>
      ok(doc(2, COLL.id, { pages: 14, chunk_count: 64, name: "procedure-vpn-ipsec-sites.docx" })),
    ),
    passages: vi.fn(async (_i: string, _d: string, autour: number) =>
      ok({
        passages: [autour - 1, autour, autour + 1].map((i) => ({
          chunk_index: i,
          text: `Texte du passage ${i}`,
          heading_path: "3.2 Renouvellement",
          page: 7,
          boxes: [],
          char_start: 0,
          char_end: 5,
        })),
        chunk_count: 64,
        restricted: false,
      }),
    ),
    ...o.api,
  });
  const messages = ref<unknown[]>(
    o.messages ?? [{ role: "user", content: "Comment ?" }, reponse("Texte [1] [2] [3] [4].", SOURCES)],
  );
  const accessibles = ref(o.collections ?? [COLL]);
  const { ctx } = fauxCtx();
  const fetchAuth = vi.fn(async (url: string) =>
    o.fetchAuth
      ? o.fetchAuth(url)
      : new Response(new Blob(["RIFFxxxxWEBP"]), {
          status: 200,
          headers: { "X-Rag-Dpi": "110", "X-Rag-Pages": "14" },
        }),
  );
  const refs = { ...faussesRefs("chat"), messages, currentChatId: ref<string | null>("chat-1") };
  scope = effectScope();
  const rg = reactive(
    scope.run(() =>
      creerRag(api, refs, {
        ...ctx,
        fetchAuth,
        chatPourRag: () => ({
          ragChat: { accessibles, selection: ref(["x"]) } as never,
          attachedFiles: ref([]),
          messages,
        }),
        fermerEditeur: () => undefined,
      }),
    )!,
  );
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  const composants = o.composants ?? [];
  app = createApp({
    render: () =>
      o.rendu
        ? o.rendu()
        : h(
            "div",
            composants.map((c) => h(c as never)),
          ),
  });
  app.provide(CLE_RAG, rg as DomaineRag);
  app.mount(hote);
  await nextTick();
  const q = <T extends HTMLElement = HTMLElement>(s: string): T | null => document.querySelector<T>(s);
  const qa = (s: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(s)];
  const attendre = async (): Promise<void> => {
    await vider();
    await nextTick();
  };
  return { rg, api, fetchAuth, messages, hote, q, qa, attendre };
}

const entry = (idx: number, msg: unknown) => ({ idx, msg });
const texte = (e: Element | null): string =>
  (e?.textContent ?? "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();

describe("pied de sources", () => {
  async function pied(sources = SOURCES, enFlux = false) {
    const e = entry(1, { role: "assistant", content: "x", rag_sources: sources, isStreaming: enFlux });
    return monter({ rendu: () => h(PiedSources, { entry: e as never }) });
  }

  it("titre, collection, documents cités avec leur détail et leurs renvois, passages non cités annoncés", async () => {
    const b = await pied();
    expect(texte(b.q("[data-rag-sources] .rag-sources__head"))).toBe(
      "4 sources · Procédures réseau 2 passages lus, non cités",
    );
    const docs = b.qa("[data-rag-source-doc]");
    expect(docs).toHaveLength(2);
    expect(texte(docs[0]?.querySelector(".rag-src__doc span") ?? null)).toBe("renouvellement-certificats.md");
    expect(texte(docs[0]?.querySelector("small") ?? null)).toBe("§ Tunnels IPsec · § Vérifications");
    expect([...(docs[0]?.querySelectorAll(".rag-cite") ?? [])].map((p) => texte(p))).toEqual(["1", "3"]);
    expect(texte(docs[1]?.querySelector(".rag-src__doc span") ?? null)).toBe(
      "procedure-vpn-ipsec-sites.docx",
    );
    expect(texte(docs[1]?.querySelector("small") ?? null)).toBe("pages 7 et 8");
    expect([...(docs[1]?.querySelectorAll(".rag-cite") ?? [])].map((p) => texte(p))).toEqual(["2", "4"]);
    expect(b.q("[data-rag-lus]")).toBeNull();
  });

  it("« N passages lus, non cités » montre ce que l'assistant a écarté, avec les mots de la question surlignés", async () => {
    const b = await pied();
    const lien = b.q<HTMLButtonElement>("[data-rag-ecartes]") as HTMLButtonElement;
    expect(lien.getAttribute("aria-expanded")).toBe("false");
    lien.click();
    await nextTick();
    expect(lien.getAttribute("aria-expanded")).toBe("true");
    const lus = b.qa("[data-rag-lus] li");
    expect(lus.map((l) => texte(l.querySelector(".rag-cite")))).toEqual(["5", "6"]);
    expect(texte(lus[0] ?? null)).toContain("guide.pdf");
    expect(lus[0]?.querySelectorAll("mark").length).toBeGreaterThan(0);
  });

  it("aucune source citée : le dit, avec le lien vers ce qui a été lu", async () => {
    const b = await pied([source(5, { cited: false }), source(6, { cited: false })]);
    expect(texte(b.q(".rag-sources__head"))).toContain("Aucune source citée");
    expect(texte(b.q("[data-rag-ecartes]"))).toBe("2 passages lus, non cités");
    expect(b.qa("[data-rag-source-doc]")).toHaveLength(0);
  });

  it("pendant le flux : seulement le nombre de passages lus", async () => {
    const b = await pied(SOURCES, true);
    expect(texte(b.q(".rag-sources__head"))).toBe("6 passages lus · Procédures réseau");
    expect(b.qa("[data-rag-source-doc]")).toHaveLength(0);
    expect(b.q("[data-rag-ecartes]")).toBeNull();
  });

  it("une pastille du pied ouvre la visionneuse sur ses sources citées", async () => {
    const b = await pied();
    b.qa("[data-rag-source-doc] .rag-cite")
      .find((p) => p.textContent?.trim() === "2")
      ?.click();
    await b.attendre();
    expect(b.rg.sources.visionneuse.numero).toBe(2);
    expect(b.rg.sources.visionneuse.ensemble.map((s) => s.n)).toEqual([1, 2, 3, 4]);
  });
});

describe("bulle", () => {
  async function avecBulle() {
    vi.useFakeTimers();
    const b = await monter({ composants: [BulleSource] });
    return b;
  }

  it("s'ouvre au survol d'une pastille du pied : document, lieu, collection, extrait surligné, pertinence, lien", async () => {
    const b = await avecBulle();
    const bouton = document.createElement("button");
    document.body.appendChild(bouton);
    b.rg.sources.bulle.survol(SOURCES[1] as never, bouton, () => undefined);
    vi.advanceTimersByTime(200);
    await nextTick();
    const bulle = b.q("[data-rag-bulle]") as HTMLElement;
    expect(bulle.getAttribute("role")).toBe("dialog");
    expect(bulle.getAttribute("aria-label")).toBe("Source 2");
    expect(texte(bulle.querySelector(".rag-pop__src b"))).toBe("procedure-vpn-ipsec-sites.docx");
    expect(texte(bulle.querySelector(".rag-pop__src .rag-cite"))).toBe("2");
    expect(texte(bulle.querySelector(".rag-pop__where"))).toBe(
      "page 7 · 3.2 Renouvellement · Procédures réseau",
    );
    expect([...bulle.querySelectorAll("mark")].map((m) => m.textContent?.toLowerCase())).toEqual(
      expect.arrayContaining(["renouvellement", "certificats"]),
    );
    expect(texte(bulle.querySelector(".rag-pop__foot .rag-num"))).toBe("Pertinence 0,79");
    expect(texte(bulle.querySelector(".rag-pop__voir"))).toBe("Voir dans le document");
    expect(bouton.getAttribute("aria-describedby")).toBe(bulle.id);
  });

  it("« Voir dans le document » ouvre la visionneuse et ferme la bulle", async () => {
    const b = await avecBulle();
    const voir = vi.fn();
    b.rg.sources.bulle.survol(SOURCES[1] as never, document.createElement("button"), voir);
    vi.advanceTimersByTime(200);
    await nextTick();
    b.q<HTMLButtonElement>(".rag-pop__voir")?.click();
    await nextTick();
    expect(voir).toHaveBeenCalledOnce();
    expect(b.q("[data-rag-bulle]")).toBeNull();
  });

  it("collection partagée sans ouverture : l'auteur est nommé et le lien dit « Voir le passage »", async () => {
    const lecteur = partagee(1, "Sophie Laurent", { name: "Procédures réseau", allow_source_open: false });
    vi.useFakeTimers();
    const b = await monter({ composants: [BulleSource], collections: [lecteur] });
    const deSophie = source(2, { collectionId: COLL.id, auteur: "Sophie Laurent" });
    b.rg.sources.bulle.survol(deSophie, document.createElement("button"), () => undefined);
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(texte(b.q(".rag-pop__where"))).toContain("Procédures réseau · partagée par Sophie Laurent");
    expect(texte(b.q(".rag-pop__voir"))).toBe("Voir le passage");
  });

  it("Échap ferme la bulle", async () => {
    const b = await avecBulle();
    b.rg.sources.bulle.survol(SOURCES[1] as never, document.createElement("button"), () => undefined);
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(b.rg.sources.echap()).toBe(true);
    await nextTick();
    expect(b.q("[data-rag-bulle]")).toBeNull();
  });
});

describe("visionneuse", () => {
  it("rien tant qu'aucune source n'est ouverte", async () => {
    const b = await monter({ composants: [VisionneuseSource] });
    expect(b.q("[data-rag-viewer]")).toBeNull();
  });

  it("mode Page : en-tête, sous-titre, navigation, bande du document, page surlignée, pager, original", async () => {
    const b = await monter({ composants: [VisionneuseSource] });
    await b.rg.sources.voir(SOURCES[1] as never, 1);
    await b.attendre();
    const v = b.q("[data-rag-viewer]") as HTMLElement;
    expect(texte(v.querySelector(".rag-viewer__name"))).toBe("procedure-vpn-ipsec-sites.docx");
    expect(texte(b.q("[data-rag-sous-titre]"))).toBe("Procédures réseau · page 7 sur 14 · 64 passages");
    expect(v.querySelector("[data-rag-mode='page']")?.getAttribute("aria-pressed")).toBe("true");
    expect([...v.querySelectorAll(".rag-viewer__nav .rag-cite")].map((p) => p.textContent?.trim())).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(v.querySelector(".rag-viewer__nav .rag-cite.is-on")?.textContent?.trim()).toBe("2");
    expect(v.querySelector(".rag-viewer__nav .rag-cite.is-on")?.getAttribute("aria-current")).toBe("true");
    expect(v.querySelector(".rag-strip--big")?.getAttribute("role")).toBe("img");
    expect(v.querySelectorAll(".rag-strip--big i")).toHaveLength(64);
    expect(v.querySelectorAll(".rag-strip--big i.is-hit").length).toBeGreaterThan(0);
    const img = v.querySelector<HTMLImageElement>("[data-rag-page] img") as HTMLImageElement;
    expect(img.getAttribute("alt")).toBe("Page 7 du document procedure-vpn-ipsec-sites.docx");
    Object.defineProperty(img, "naturalWidth", { value: 909 });
    Object.defineProperty(img, "naturalHeight", { value: 1286 });
    img.dispatchEvent(new Event("load"));
    await nextTick();
    expect(v.querySelectorAll("[data-rag-hl]").length).toBeGreaterThan(0);
    expect(v.querySelector(".rag-paper__hl")?.getAttribute("style")).toContain("left");
    expect(texte(v.querySelector("[data-rag-pager]"))).toBe("Page 7 sur 14");
    expect(v.querySelector("[data-rag-original]")?.getAttribute("href")).toMatch(/\/original$/);
    expect(v.querySelector("[data-rag-original]")?.hasAttribute("download")).toBe(true);
  });

  it("le bouton Texte montre les passages voisins, le passage cité marqué et surligné", async () => {
    const b = await monter({ composants: [VisionneuseSource] });
    await b.rg.sources.voir(SOURCES[1] as never, 1);
    await b.attendre();
    b.q<HTMLButtonElement>("[data-rag-mode='texte']")?.click();
    await b.attendre();
    const lignes = b.qa("[data-rag-texte] li");
    expect(lignes).toHaveLength(3);
    expect(lignes[1]?.classList.contains("is-cur")).toBe(true);
    expect(texte(lignes[1]?.querySelector(".rag-cite") ?? null)).toBe("2");
    expect(texte(lignes[1]?.querySelector(".rag-txt__meta") ?? null)).toContain("Passage 27");
    expect(texte(lignes[1]?.querySelector(".rag-txt__meta") ?? null)).toContain("Pertinence 0,79");
    expect(b.q("[data-rag-page]")).toBeNull();
  });

  it("‹ › changent de source : le document, la page et le titre suivent", async () => {
    const b = await monter({ composants: [VisionneuseSource] });
    await b.rg.sources.voir(SOURCES[1] as never, 1);
    await b.attendre();
    b.q<HTMLButtonElement>("[aria-label='Source suivante']")?.click();
    await b.attendre();
    expect(b.rg.sources.visionneuse.numero).toBe(3);
    expect(texte(b.q(".rag-viewer__name"))).toBe("renouvellement-certificats.md");
    b.qa(".rag-viewer__nav .rag-cite")[3]?.click();
    await b.attendre();
    expect(b.rg.sources.visionneuse.numero).toBe(4);
  });

  it("lecteur sans ouverture : pas de bascule Page/Texte ni d'original, une phrase claire, le passage cité", async () => {
    const lecteur = partagee(1, "Sophie Laurent", { name: "Procédures réseau", allow_source_open: false });
    const b = await monter({
      composants: [VisionneuseSource],
      collections: [lecteur],
      api: {
        passages: vi.fn(async () =>
          ok({
            passages: [
              {
                chunk_index: 26,
                text: "Seul passage visible.",
                heading_path: "",
                page: 7,
                boxes: [],
                char_start: 0,
                char_end: 5,
              },
            ],
            chunk_count: 64,
            restricted: true,
          }),
        ),
      },
    });
    await b.rg.sources.voir(SOURCES[1] as never, 1);
    await b.attendre();
    expect(b.q("[data-rag-mode]")).toBeNull();
    expect(b.q("[data-rag-original]")).toBeNull();
    expect(b.q("[data-rag-page]")).toBeNull();
    expect(texte(b.q("[data-rag-volet-avis]"))).toBe(
      "Le propriétaire de cette collection n’ouvre pas ses documents : seul le passage cité est visible.",
    );
    expect(texte(b.q("[data-rag-texte]"))).toContain("Seul passage visible.");
    expect(b.fetchAuth).not.toHaveBeenCalled();
  });

  it("collection retirée (404) : message propre, extrait enregistré gardé, aucune erreur", async () => {
    const b = await monter({
      composants: [VisionneuseSource],
      collections: [],
      api: { collection: vi.fn(async () => echec("collection_introuvable", "Collection introuvable")) },
    });
    await b.rg.sources.voir(SOURCES[1] as never, 1);
    await b.attendre();
    expect(texte(b.q("[data-rag-volet-avis]"))).toContain("n’est plus accessible");
    expect(texte(b.q("[data-rag-texte]"))).toContain("Avant tout renouvellement");
  });

  it("rendu impossible : l'erreur est dite avec un lien vers le texte", async () => {
    const b = await monter({
      composants: [VisionneuseSource],
      fetchAuth: async () =>
        new Response(JSON.stringify({ detail: "x", code: "rendu_impossible" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
    });
    await b.rg.sources.voir(SOURCES[1] as never, 1);
    await b.attendre();
    expect(b.q("[role='alert']")?.textContent).toContain("ne peut pas être affichée");
    b.q<HTMLButtonElement>(".rag-viewer__lien")?.click();
    await b.attendre();
    expect(b.q("[data-rag-texte]")).not.toBeNull();
  });

  it("fermer ou Échap retire le volet", async () => {
    const b = await monter({ composants: [VisionneuseSource] });
    await b.rg.sources.voir(SOURCES[1] as never, 1);
    await b.attendre();
    b.q<HTMLButtonElement>("[data-rag-fermer]")?.click();
    await b.attendre();
    expect(b.q("[data-rag-viewer]")).toBeNull();
    await b.rg.sources.voir(SOURCES[1] as never, 1);
    await b.attendre();
    expect(b.rg.sources.echap()).toBe(true);
    await b.attendre();
    expect(b.q("[data-rag-viewer]")).toBeNull();
  });

  it("ouvrir la page RAG ferme la visionneuse", async () => {
    const b = await monter({ composants: [VisionneuseSource] });
    await b.rg.sources.voir(SOURCES[1] as never, 1);
    await b.attendre();
    await b.rg.ouvrir();
    await b.attendre();
    expect(b.q("[data-rag-viewer]")).toBeNull();
  });

  it("le focus entre dans le volet à l'ouverture et revient à la fermeture", async () => {
    const b = await monter({ composants: [VisionneuseSource] });
    const declencheur = document.createElement("button");
    document.body.appendChild(declencheur);
    declencheur.focus();
    await b.rg.sources.voir(SOURCES[1] as never, 1);
    await b.attendre();
    expect(document.activeElement).toBe(b.q(".rag-viewer__name"));
    b.rg.sources.fermer();
    await b.attendre();
    expect(document.activeElement).toBe(declencheur);
  });
});

describe("notice du fil", () => {
  const notice = creerNotice({
    requete: "renouvellement certificat",
    mode: "mixte",
    duree_ms: 420,
    collections: [{ id: COLL.id, name: "Procédures réseau" }],
    passages: [
      passageTrouve(1, { collectionId: COLL.id, relevance: 1 }),
      passageTrouve(2, { collectionId: COLL.id, document: "guide.pdf", doc: "d3", relevance: 0.5 }),
    ],
    erreurs: [],
  });
  const msg = { role: "notice", kind: "rag_search", summary: serialiserNotice(notice) };

  async function monterNotice(m: unknown = msg) {
    return monter({ rendu: () => h(NoticeRecherche, { entry: entry(2, m) as never }) });
  }

  it("titre, durée, collections et passages rangés avec pertinence et extrait surligné", async () => {
    const b = await monterNotice();
    expect(texte(b.q(".rag-fil-notice__head"))).toBe(
      "Recherche : « renouvellement certificat » 2 passages · 0,4 s",
    );
    expect(texte(b.q(".rag-fil-notice__sub"))).toBe("Dans Procédures réseau · aucune réponse de l’assistant");
    const hits = b.qa("[data-rag-hit]");
    expect(hits).toHaveLength(2);
    expect(texte(hits[0] ?? null)).toContain("Pertinence 1,00");
    expect(texte(hits[1] ?? null)).toContain("guide.pdf");
    expect(hits[0]?.querySelectorAll("mark").length).toBeGreaterThan(0);
  });

  it("« Voir dans le document » ouvre la visionneuse sur les passages de la notice", async () => {
    const b = await monterNotice();
    b.qa("[data-rag-hit] .rag-pop__voir")[1]?.click();
    await b.attendre();
    expect(b.rg.sources.visionneuse.numero).toBe(2);
    expect(b.rg.sources.visionneuse.ensemble.map((s) => s.n)).toEqual([1, 2]);
  });

  it("sans passage : le dit", async () => {
    const vide = creerNotice({ ...notice, passages: [] });
    const b = await monterNotice({ ...msg, summary: serialiserNotice(vide) });
    expect(texte(b.q(".rag-fil-notice__vide"))).toBe("Aucun passage trouvé pour cette question.");
  });

  it("contenu illisible : le dit aussi", async () => {
    const b = await monterNotice({ ...msg, summary: "{" });
    expect(texte(b.q(".rag-fil-notice__vide"))).toBe("Résultat de recherche illisible.");
  });
});
