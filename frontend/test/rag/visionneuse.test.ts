// SPDX-License-Identifier: MIT
/** frontend/test/rag/visionneuse.test.ts — visionneuse de source : page rendue avec les rectangles stockés ou la localisation, mode Texte, lecteur sans ouverture, collection retirée (404), navigation entre sources, page voisine. */
import type { SourceCiteeRag } from "@elpis/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creerVisionneuse, PHRASE_SOURCES_FERMEES } from "../../src/features/rag/visionneuse";
import { collection, document as doc, echec, fausseApi, ok, partagee, vider } from "./aides";
import { source } from "./aides-sources";

const origine = { creer: URL.createObjectURL, revoquer: URL.revokeObjectURL };
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => `blob:page-${Math.random()}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  URL.createObjectURL = origine.creer;
  URL.revokeObjectURL = origine.revoquer;
});

const imageWebp = (pages = 14, dpi = 110): Response =>
  new Response(new Blob(["RIFFxxxxWEBP"]), {
    status: 200,
    headers: { "content-type": "image/webp", "X-Rag-Dpi": String(dpi), "X-Rag-Pages": String(pages) },
  });
const erreurHttp = (status: number, code: string): Response =>
  new Response(JSON.stringify({ detail: "refus du serveur", code }), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Options {
  collections?: ReturnType<typeof collection>[];
  fetchAuth?: (url: string) => Promise<Response | null>;
  api?: Parameters<typeof fausseApi>[0];
}

function monter(o: Options = {}) {
  const c = collection(1, { name: "Procédures réseau" });
  const api = fausseApi({
    document: vi.fn(async () =>
      ok(doc(1, c.id, { pages: 14, chunk_count: 64, name: "procedure-vpn-ipsec-sites.docx" })),
    ),
    passages: vi.fn(async (_id: string, _d: string, autour: number) =>
      ok({
        passages: [autour - 1, autour, autour + 1].map((i) => ({
          chunk_index: i,
          text: `Texte du passage ${i}`,
          heading_path: "3.2 Renouvellement",
          page: 7,
          boxes: [],
          char_start: i * 100,
          char_end: i * 100 + 50,
        })),
        chunk_count: 64,
        restricted: false,
      }),
    ),
    localiser: vi.fn(async () =>
      ok({
        page: 7,
        boxes: [[7, 100, 200, 300, 260] as [number, number, number, number, number]],
        score: 1,
        page_width: 595,
        page_height: 842,
      }),
    ),
    ...o.api,
  });
  const urls: string[] = [];
  const fetchAuth = vi.fn(async (url: string) => {
    urls.push(url);
    return o.fetchAuth ? o.fetchAuth(url) : imageWebp();
  });
  const annonces: string[] = [];
  const fermerEditeur = vi.fn();
  const v = creerVisionneuse({
    api,
    fetchAuth,
    collections: () => o.collections ?? [c],
    fermerEditeur,
    annoncer: (m) => annonces.push(m),
  });
  return { v, api, fetchAuth, urls, annonces, fermerEditeur, c };
}

const avecBoites = (n: number): SourceCiteeRag =>
  source(n, { collectionId: collection(1).id, boxes: [[7, 100, 200, 300, 260]] });

describe("mode Page", () => {
  it("rectangles stockés avec la source : aucune localisation, la page est lue puis surlignée", async () => {
    const { v, api, urls, fermerEditeur } = monter();
    await v.ouvrir(avecBoites(2));
    expect(api.localiser).not.toHaveBeenCalled();
    expect(urls).toEqual([expect.stringMatching(/\/documents\/[^/]+\/pages\/7$/)]);
    expect(v.page.etat).toBe("pret");
    expect(v.page.num).toBe(7);
    expect(v.totalPages.value).toBe(14);
    expect(fermerEditeur).toHaveBeenCalledOnce();
    v.imageChargee(909, 1286);
    expect(v.page.largeurPts).toBeCloseTo(595, 0);
    const s = v.surlignages.value;
    expect(s).toHaveLength(1);
    expect(s[0]?.courant).toBe(true);
    expect(s[0]?.n).toBe(2);
    expect(s[0]?.gauche).toBeCloseTo((100 / 595) * 100, 1);
  });

  it("sans rectangles : la localisation du texte donne la page, les rectangles et l'approximation", async () => {
    const { v, api } = monter({
      api: {
        localiser: vi.fn(async () =>
          ok({
            page: 7,
            boxes: [[7, 50, 60, 200, 90] as [number, number, number, number, number]],
            score: 0.8,
            page_width: 595,
            page_height: 842,
          }),
        ),
      },
    });
    await v.ouvrir(source(2, { collectionId: collection(1).id, page: null }));
    expect(api.localiser).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.stringContaining("renouvellement"),
      undefined,
    );
    expect(v.page.num).toBe(7);
    expect(v.page.approximatif).toBe(true);
    expect(v.surlignages.value).toHaveLength(1);
  });

  it("passage introuvable dans le rendu mais page connue : la page est montrée sans surlignage", async () => {
    const { v } = monter({
      api: {
        localiser: vi.fn(async () =>
          ok({ page: null, boxes: [], score: 0, page_width: null, page_height: null }),
        ),
      },
    });
    await v.ouvrir(source(2, { collectionId: collection(1).id }));
    expect(v.page.etat).toBe("pret");
    expect(v.page.sansSurlignage).toBe(true);
    v.imageChargee(909, 1286);
    expect(v.surlignages.value).toEqual([]);
  });

  it("passage introuvable et page inconnue : message clair, le texte reste lisible", async () => {
    const { v } = monter({
      api: {
        localiser: vi.fn(async () =>
          ok({ page: null, boxes: [], score: 0, page_width: null, page_height: null }),
        ),
      },
    });
    await v.ouvrir(source(2, { collectionId: collection(1).id, page: null }));
    expect(v.page.etat).toBe("erreur");
    expect(v.page.erreur?.message).toMatch(/lisez-le dans l’onglet Texte/);
    await v.basculer("texte");
    expect(v.texte.etat).toBe("pret");
  });

  it("rendu impossible (422) : message en clair, pas de page", async () => {
    const { v } = monter({ fetchAuth: async () => erreurHttp(422, "rendu_impossible") });
    await v.ouvrir(avecBoites(2));
    expect(v.page.etat).toBe("erreur");
    expect(v.page.erreur?.message).toMatch(/ne peut pas être affichée/);
  });

  it("extracteur indisponible (503) : dit en clair", async () => {
    const { v } = monter({ fetchAuth: async () => erreurHttp(503, "extracteur_indisponible") });
    await v.ouvrir(avecBoites(2));
    expect(v.page.erreur?.message).toMatch(/indisponible/);
  });

  it("une page voisine se charge, les rectangles de la source restent ceux de leur page", async () => {
    const { v, urls } = monter();
    await v.ouvrir(avecBoites(2));
    v.imageChargee(909, 1286);
    await v.allerPage(8);
    expect(urls.at(-1)).toMatch(/pages\/8$/);
    expect(v.page.num).toBe(8);
    expect(v.surlignages.value).toEqual([]);
    await v.allerPage(7);
    expect(v.surlignages.value).toHaveLength(1);
    await v.allerPage(99);
    expect(v.page.num).toBe(7);
  });

  it("les pages déjà lues ne sont pas redemandées", async () => {
    const { v, urls } = monter();
    await v.ouvrir(avecBoites(2));
    await v.allerPage(8);
    await v.allerPage(7);
    expect(urls.filter((u) => u.endsWith("/pages/7"))).toHaveLength(1);
  });
});

describe("mode Texte", () => {
  it("les passages voisins entourent le passage cité", async () => {
    const { v, api } = monter();
    await v.ouvrir(avecBoites(2));
    await v.basculer("texte");
    expect(api.passages).toHaveBeenCalledWith(expect.any(String), expect.any(String), 26, 3);
    expect(v.texte.passages.map((p) => p.chunk_index)).toEqual([25, 26, 27]);
    expect(v.texte.chunkCount).toBe(64);
    expect(v.mode.value).toBe("texte");
  });
});

describe("droits", () => {
  it("lecteur sans allow_source_open : seulement le passage cité, ni page ni original, une phrase claire", async () => {
    const lecteur = partagee(1, "Sophie Laurent", { allow_source_open: false });
    const { v, urls, api } = monter({
      collections: [lecteur],
      api: {
        passages: vi.fn(async () =>
          ok({
            passages: [
              {
                chunk_index: 26,
                text: "Le passage cité.",
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
    await v.ouvrir(avecBoites(2));
    expect(v.restreint.value).toBe(true);
    expect(v.mode.value).toBe("texte");
    expect(v.peutOuvrirOriginal.value).toBe(false);
    expect(v.urlOriginal.value).toBe("");
    expect(urls).toEqual([]);
    expect(api.localiser).not.toHaveBeenCalled();
    expect(v.texte.passages).toHaveLength(1);
    expect(PHRASE_SOURCES_FERMEES).toMatch(/seul le passage cité est visible/);
  });

  it("collection inconnue de la liste : le serveur dit le rôle, 403 sources_fermees sur la page bascule en Texte", async () => {
    const { v, api } = monter({
      collections: [],
      fetchAuth: async () => erreurHttp(403, "sources_fermees"),
      api: {
        collection: vi.fn(async () => ok(partagee(1, "Sophie", { allow_source_open: true }))),
        passages: vi.fn(async () =>
          ok({
            passages: [
              {
                chunk_index: 26,
                text: "Seul.",
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
    await v.ouvrir(avecBoites(2));
    expect(api.collection).toHaveBeenCalled();
    expect(v.restreint.value).toBe(true);
    expect(v.mode.value).toBe("texte");
    expect(v.texte.etat).toBe("pret");
  });

  it("propriétaire : l'original est proposé", async () => {
    const { v } = monter();
    await v.ouvrir(avecBoites(2));
    expect(v.peutOuvrirOriginal.value).toBe(true);
    expect(v.urlOriginal.value).toMatch(/\/documents\/.+\/original$/);
  });

  it("collection retirée (404) : message propre, aucune requête de page, pas d'erreur", async () => {
    const { v, urls } = monter({
      collections: [],
      api: { collection: vi.fn(async () => echec("collection_introuvable", "Collection introuvable")) },
    });
    await expect(v.ouvrir(avecBoites(2))).resolves.toBeUndefined();
    expect(v.introuvable.value?.message).toMatch(/n’est plus accessible/);
    expect(urls).toEqual([]);
    expect(v.source.value?.n).toBe(2);
  });

  it("collection retirée pendant la lecture : 404 de la page dit proprement", async () => {
    const { v } = monter({ fetchAuth: async () => erreurHttp(404, "collection_introuvable") });
    await v.ouvrir(avecBoites(2));
    expect(v.introuvable.value?.message).toMatch(/n’est plus accessible/);
  });
});

describe("navigation", () => {
  const ensemble = [1, 2, 3, 4].map((n) => avecBoites(n));

  it("‹ › parcourent les sources citées en boucle, la page suit", async () => {
    const { v, annonces } = monter();
    await v.ouvrir(ensemble[1] as SourceCiteeRag, ensemble);
    expect(v.ensemble.value.map((s) => s.n)).toEqual([1, 2, 3, 4]);
    await v.voisine(1);
    expect(v.numero.value).toBe(3);
    await v.voisine(-1);
    await v.voisine(-1);
    expect(v.numero.value).toBe(1);
    await v.voisine(-1);
    expect(v.numero.value).toBe(4);
    expect(annonces.at(-1)).toMatch(/^Source 4/);
  });

  it("une source non citée ouverte s'ajoute à l'ensemble à sa place", async () => {
    const { v } = monter();
    await v.ouvrir(source(5, { collectionId: collection(1).id, cited: false }), [
      ensemble[0] as SourceCiteeRag,
      ensemble[2] as SourceCiteeRag,
    ]);
    expect(v.ensemble.value.map((s) => s.n)).toEqual([1, 3, 5]);
    expect(v.numero.value).toBe(5);
  });

  it("aller à une source inconnue ne fait rien ; les sources du même document se retrouvent", async () => {
    const { v } = monter();
    await v.ouvrir(ensemble[0] as SourceCiteeRag, ensemble);
    await v.aller(42);
    expect(v.numero.value).toBe(1);
    expect(v.duDocument.value).toHaveLength(4);
  });

  it("fermer remet tout à zéro ; Échap ferme une seule fois", async () => {
    const { v } = monter();
    await v.ouvrir(avecBoites(2));
    expect(v.echap()).toBe(true);
    expect(v.ouverte.value).toBe(false);
    expect(v.ensemble.value).toEqual([]);
    expect(v.echap()).toBe(false);
  });

  it("une réponse tardive d'une source précédente est ignorée", async () => {
    let lib: (r: Response) => void = () => undefined;
    const attente = new Promise<Response>((r) => {
      lib = r;
    });
    let appel = 0;
    const { v } = monter({ fetchAuth: () => (++appel === 1 ? attente : Promise.resolve(imageWebp())) });
    const premiere = v.ouvrir(avecBoites(2), [avecBoites(2), avecBoites(3)]);
    await vider();
    await v.aller(3);
    lib(imageWebp());
    await premiere;
    expect(v.numero.value).toBe(3);
    expect(v.page.etat).toBe("pret");
  });
});
