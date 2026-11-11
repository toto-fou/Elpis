// SPDX-License-Identifier: MIT
/** frontend/test/rag/collections-chat.test.ts — collections RAG actives d'un chat : pastilles (lisibles seulement), enregistrement par le serveur ou attente d'un chat neuf, refus, « Discuter avec », renvois et sources validées. */
import type { SourceCiteeRag } from "@elpis/contracts";
import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";

import { creerCollectionsChat, ecouterEvenementsRag } from "../../src/features/rag/collections-chat";
import { sourceDuRenvoi, sourcesRagValides } from "../../src/features/rag/sources";
import { decoupage } from "./aides";

const A = "3f9a1c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const B = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const C = "aa1b2c3d-4e5f-4a6b-bc7d-9e0f1a2b3c4d";

function collection(id: string, name: string, role: "proprietaire" | "lecteur", auteur = "alice") {
  return {
    id,
    name,
    description: `Description de ${name}`,
    visibility: role === "lecteur" ? "groups" : "private",
    allow_source_open: false,
    owner: { id: 1, username: auteur, display_name: auteur },
    role,
    groups: [],
    doc_count: 1,
    chunk_count: 2,
    bytes: 3,
    status: "ready",
    embed_model: "m",
    chunking: decoupage(),
    ocr: false,
    created_at: 1,
    updated_at: 1,
    hidden: false,
  };
}

const json = (corps: unknown, status = 200): Response =>
  new Response(JSON.stringify(corps), { status, headers: { "content-type": "application/json" } });

function monter(chat: string | null = null) {
  const appels: { url: string; init: RequestInit | undefined }[] = [];
  const reponses: Record<string, (init?: RequestInit) => Response> = {
    "/api/rag/collections": () =>
      json({
        collections: [
          collection(A, "Contrats", "proprietaire"),
          collection(B, "Procédures", "lecteur", "bob"),
        ],
      }),
  };
  const fetchAuth = vi.fn(async (url: string, init?: RequestInit) => {
    appels.push({ url, init });
    const f = reponses[url];
    return f ? f(init) : json({ detail: "introuvable" }, 404);
  });
  const toasts: string[] = [];
  const currentChatId = ref<string | null>(chat);
  const api = creerCollectionsChat({ fetchAuth, showToast: (m) => void toasts.push(m), currentChatId });
  return { api, appels, reponses, toasts, currentChatId };
}

describe("collections actives d'un chat", () => {
  it("pastilles : seulement les collections lisibles, dans l'ordre de la sélection, auteur d'une partagée", async () => {
    const { api } = monter("c1");
    await api.rafraichir();
    api.appliquerDuChat({ collections: [B, C, A], mode: "mixte", top_k: 8 });
    expect(api.actives.value.map((c) => [c.name, c.auteur, c.role])).toEqual([
      ["Procédures", "bob", "lecteur"],
      ["Contrats", null, "proprietaire"],
    ]);
    api.appliquerDuChat({ collections: ["pas-un-uuid"], mode: "x", top_k: 0 });
    expect(api.selection.value).toEqual([]);
  });

  it("chat existant : chaque changement passe par PUT /api/saved/chats/:id/rag ; refus du serveur dit, sélection gardée", async () => {
    const { api, appels, reponses, toasts } = monter("c1");
    await api.rafraichir();
    reponses["/api/saved/chats/c1/rag"] = (init) =>
      json({ ok: true, rag: { ...(JSON.parse(String(init?.body)) as object), mode: "mixte", top_k: 8 } });
    expect(await api.activer(A)).toBe(true);
    expect(await api.activer(B)).toBe(true);
    expect(await api.activer(A)).toBe(true);
    expect(api.selection.value).toEqual([A, B]);
    expect(appels.filter((a) => a.url.endsWith("/rag")).map((a) => JSON.parse(String(a.init?.body)))).toEqual(
      [{ collections: [A] }, { collections: [A, B] }],
    );
    expect(await api.retirer(A)).toBe(true);
    expect(api.selection.value).toEqual([B]);
    reponses["/api/saved/chats/c1/rag"] = () =>
      json({ detail: "Collection introuvable.", code: "collection_introuvable" }, 404);
    expect(await api.activer(C)).toBe(false);
    expect(api.selection.value).toEqual([B]);
    expect(toasts).toEqual(["Collection introuvable."]);
    reponses["/api/saved/chats/c1/rag"] = () =>
      json({ ok: true, rag: { collections: [], mode: "mixte", top_k: 8 } });
    expect(await api.couper()).toBe(true);
    expect(api.actives.value).toEqual([]);
  });

  it("chat neuf : sélection en attente, scellée par la création ; dix collections au plus", async () => {
    const { api, appels, currentChatId, toasts } = monter(null);
    await api.rafraichir();
    expect(await api.activer(A)).toBe(true);
    expect(api.enAttente()).toEqual([A]);
    expect(appels.some((a) => a.url.includes("/api/saved/chats"))).toBe(false);
    currentChatId.value = "c9";
    expect(api.enAttente()).toEqual([]);
    api.confirmerCreation([A]);
    expect(api.selection.value).toEqual([A]);
    currentChatId.value = null;
    const onze = Array.from({ length: 11 }, (_, i) => `${i}`);
    expect(await api.definir(onze)).toBe(false);
    expect(toasts[0]).toContain("10 collections");
  });

  it("« Discuter avec » : chat neuf, collection active tout de suite (nom provisoire), liste relue ; rag:collections relit", async () => {
    const { api, appels } = monter("c1");
    const cible = new EventTarget();
    const nouveauChat = vi.fn(async () => api.reinitialiser());
    const fin = ecouterEvenementsRag(api, { nouveauChat, cible });
    cible.dispatchEvent(new CustomEvent("rag:discuter", { detail: { id: C, name: "Neuve" } }));
    await vi.waitFor(() => expect(api.selection.value).toEqual([C]));
    expect(nouveauChat).toHaveBeenCalledOnce();
    expect(api.actives.value.map((c) => c.name)).toEqual(["Neuve"]);
    cible.dispatchEvent(new CustomEvent("rag:discuter", { detail: { name: "sans id" } }));
    const avant = appels.length;
    cible.dispatchEvent(new Event("rag:collections"));
    await vi.waitFor(() => expect(appels.length).toBe(avant + 1));
    fin();
    cible.dispatchEvent(new Event("rag:collections"));
    expect(appels.length).toBe(avant + 1);
  });

  it("sources : validées une à une ; renvoi cherché dans le message puis dans les précédents, sinon inconnu", () => {
    const s = (n: number): SourceCiteeRag => ({
      n,
      cited: true,
      query: null,
      rank: null,
      relevance: null,
      passage: {
        collection_id: A,
        collection_name: "C",
        owner: { id: 1, username: "u", display_name: "u" },
        document_id: B,
        document_name: "d.pdf",
        rel_path: "d.pdf",
        chunk_index: n,
        page: 1,
        heading_path: "",
        text: "t",
        score: 0,
        boxes: [[1, 0, 0, 1, 1]],
      },
    });
    expect(sourcesRagValides([s(1), { n: 2 }, s(1), s(3)]).map((x) => x.n)).toEqual([1, 3]);
    const message = { rag_sources: [s(4)] };
    expect(sourceDuRenvoi(4, message)?.n).toBe(4);
    expect(sourceDuRenvoi(1, message, [{ rag_sources: [s(1)] }, {}])?.n).toBe(1);
    expect(sourceDuRenvoi(9, message, [{ rag_sources: [s(1)] }])).toBeNull();
  });
});
