// SPDX-License-Identifier: MIT
/** frontend/test/rag/commande.test.ts — commande /rag : résolution d'un nom de collection, menus, et chaque sous-commande (use, off, search, add, new, status, open) avec ses erreurs. */
import type { ResultatDepotRag } from "@elpis/contracts";
import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";

import { creerCommandeRag, resoudreCollection, valeursCollections } from "../../src/features/rag/commande";
import type { ChatPourRag } from "../../src/features/rag/commande";
import { lireNotice } from "../../src/features/rag/notice-recherche";
import { collection, echec, etat, fausseApi, idRag, ok, partagee, travail } from "./aides";
import { passageTrouve } from "./aides-sources";

const nb = (s: string): string => s.replace(/\u00a0/g, " ");

const mes = [
  collection(1, { name: "Procédures réseau", doc_count: 48 }),
  collection(2, { name: "Contrats fournisseurs", doc_count: 17, visibility: "groups" }),
];
const autres = [partagee(3, "Sophie Laurent", { name: "Base de connaissances support", doc_count: 128 })];
const toutes = [...autres, ...mes];

describe("menus", () => {
  it("les miennes d'abord (par nom) puis celles partagées avec moi, détail et icône comme la maquette", () => {
    expect(valeursCollections(toutes).map((v) => ({ ...v, label: nb(v.label) }))).toEqual([
      { value: "Contrats fournisseurs", label: "Vous · publiée · 17 documents", icone: "ph-books" },
      { value: "Procédures réseau", label: "Vous · 48 documents", icone: "ph-books" },
      {
        value: "Base de connaissances support",
        label: "Sophie Laurent · 128 documents",
        icone: "ph-users-three",
      },
    ]);
  });

  it("add ne propose que les miennes", () => {
    expect(valeursCollections(toutes, true).map((v) => v.value)).toEqual([
      "Contrats fournisseurs",
      "Procédures réseau",
    ]);
  });

  it("un nom porté par une collection d'autrui s'écrit « nom (auteur) »", () => {
    const v = valeursCollections([
      collection(1, { name: "Notes" }),
      partagee(2, "Marc Dubois", { name: "Notes" }),
    ]);
    expect(v.map((x) => x.value)).toEqual(["Notes", "Notes (Marc Dubois)"]);
  });
});

describe("résolution d'un nom", () => {
  it("casse libre, nom exact, début de nom unique, identifiant", () => {
    expect(resoudreCollection("procédures RÉSEAU", toutes)).toMatchObject({ ok: true });
    expect(resoudreCollection("contrats", toutes)).toMatchObject({
      ok: true,
      collection: { id: mes[1]?.id },
    });
    expect(resoudreCollection(mes[0]?.id ?? "", toutes)).toMatchObject({ ok: true });
  });

  it("inconnue, vide, ambiguë : un message clair", () => {
    const inconnue = resoudreCollection("Rien", toutes);
    expect(inconnue).toMatchObject({ ok: false, code: "inconnue" });
    expect(inconnue.ok ? "" : inconnue.message).toMatch(/Collection inconnue : « Rien »/);
    expect(resoudreCollection("  ", toutes)).toMatchObject({ ok: false, code: "vide" });
    expect(
      resoudreCollection("P", [collection(1, { name: "Plan A" }), collection(2, { name: "Plan B" })]),
    ).toMatchObject({ ok: false, code: "ambigue" });
  });

  it("même nom chez moi et chez un autre : la mienne l'emporte, l'autre se désigne avec son auteur", () => {
    const l = [collection(1, { name: "Notes" }), partagee(2, "Marc Dubois", { name: "Notes" })];
    expect(resoudreCollection("Notes", l)).toMatchObject({ ok: true, collection: { id: idRag(1) } });
    expect(resoudreCollection("Notes (Marc Dubois)", l)).toMatchObject({
      ok: true,
      collection: { id: idRag(2) },
    });
  });

  it("seulement les miennes : une collection partagée est refusée en lecture seule", () => {
    const r = resoudreCollection("Base de connaissances support", toutes, true);
    expect(r).toMatchObject({ ok: false, code: "lecture_seule" });
    expect(r.ok ? "" : r.message).toMatch(/partagée par Sophie Laurent en lecture seule/);
  });
});

function monter(
  o: {
    selection?: string[];
    pieces?: unknown[];
    api?: Parameters<typeof fausseApi>[0];
    generation?: boolean;
    liste?: typeof toutes;
  } = {},
) {
  const liste = o.liste ?? toutes;
  const selection = ref<readonly string[]>(o.selection ?? []);
  const accessibles = ref<readonly (typeof toutes)[number][]>(liste);
  const attachedFiles = ref<unknown[]>(o.pieces ?? []);
  const messages = ref<unknown[]>([]);
  const ragChat = {
    autorise: ref<boolean | null>(true),
    selection,
    accessibles,
    rafraichir: vi.fn(async () => undefined),
    activer: vi.fn(async (id: string) => {
      selection.value = [...selection.value, id];
      return true;
    }),
    couper: vi.fn(async () => {
      selection.value = [];
      return true;
    }),
  };
  const chat = { ragChat, attachedFiles, messages, defilerEnBas: vi.fn() } as unknown as ChatPourRag;
  const api = fausseApi(o.api);
  const ouvrirPage = vi.fn();
  const notifier = vi.fn();
  const maintenant = vi.fn(() => 1_000_000);
  const c = creerCommandeRag({
    api,
    chat: () => chat,
    ouvrirPage,
    enGeneration: () => o.generation ?? false,
    notifierCollections: notifier,
    maintenant,
  });
  return { c, api, chat, ragChat, selection, attachedFiles, messages, ouvrirPage, notifier, maintenant };
}

const fichier = (nom: string, taille = 10, type = "application/pdf") => {
  const f = new File([new Uint8Array(taille)], nom, { type });
  return { name: nom, content: "", fichier: f };
};

describe("/rag use et /rag off", () => {
  it("use active la collection nommée (plusieurs mots, casse libre)", async () => {
    const b = monter();
    const r = await b.c.lancer("use procédures réseau");
    expect(b.ragChat.activer).toHaveBeenCalledWith(idRag(1));
    expect(r).toEqual({ ok: true, msg: "« Procédures réseau » sera interrogée dans ce chat." });
  });

  it("use d'une collection déjà active : information, rien d'enregistré", async () => {
    const b = monter({ selection: [idRag(1)] });
    const r = await b.c.lancer("use Procédures réseau");
    expect(b.ragChat.activer).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, info: true });
  });

  it("use : collection inconnue, sans nom, refus du serveur silencieux (déjà dit)", async () => {
    const b = monter();
    expect(await b.c.lancer("use Rien")).toMatchObject({
      ok: false,
      msg: expect.stringContaining("Collection inconnue"),
    });
    expect(b.ragChat.rafraichir).toHaveBeenCalled();
    expect(await b.c.lancer("use")).toMatchObject({
      ok: false,
      msg: expect.stringContaining("/rag use <collection>"),
    });
    b.ragChat.activer.mockResolvedValueOnce(false);
    expect(await b.c.lancer("use Procédures réseau")).toEqual({ ok: false, silent: true });
  });

  it("off coupe, ou dit qu'il n'y a rien à couper", async () => {
    const b = monter({ selection: [idRag(1), idRag(2)] });
    expect(await b.c.lancer("off")).toEqual({ ok: true, msg: "Ce chat n’interroge plus de collection." });
    expect(b.selection.value).toEqual([]);
    expect(await b.c.lancer("off")).toMatchObject({ ok: true, info: true });
  });
});

describe("/rag search", () => {
  const trouvees = (n: number, relevance: number) =>
    ok({
      mode: "mixte" as const,
      reranked: false,
      passages: [passageTrouve(n, { relevance, collectionId: idRag(1) })],
      map: [],
      duration_ms: 12,
      tokens: 100,
      warnings: [],
      errors: [],
    });

  it("cherche dans chaque collection active, fusionne, et écrit une notice du fil sans tour de l'assistant", async () => {
    const rechercher = vi.fn(async (id: string) => (id === idRag(1) ? trouvees(1, 1) : trouvees(1, 0.5)));
    const b = monter({ selection: [idRag(1), idRag(2)], api: { rechercher } });
    const r = await b.c.lancer("search comment renouveler le certificat ?");
    expect(r).toEqual({ ok: true, silent: true });
    expect(rechercher).toHaveBeenCalledTimes(2);
    expect(rechercher).toHaveBeenCalledWith(idRag(1), {
      requete: "comment renouveler le certificat ?",
      mode: "mixte",
      limite: 8,
      reclasser: false,
    });
    expect(b.messages.value).toHaveLength(1);
    const m = b.messages.value[0] as { role: string; kind: string; summary: string; ts: number };
    expect(m.role).toBe("notice");
    expect(m.kind).toBe("rag_search");
    expect(Object.isFrozen(m)).toBe(true);
    const n = lireNotice(m.summary);
    expect(n?.requete).toBe("comment renouveler le certificat ?");
    expect(n?.passages.map((p) => p.rank)).toEqual([1, 2]);
    expect(n?.collections.map((c) => c.name)).toEqual(["Procédures réseau", "Contrats fournisseurs"]);
    expect(b.chat.defilerEnBas).toHaveBeenCalled();
  });

  it("sans collection active, sans question ou pendant une génération : message clair, pas de recherche", async () => {
    const rechercher = vi.fn();
    const b = monter({ api: { rechercher } });
    expect(await b.c.lancer("search question")).toMatchObject({
      ok: false,
      msg: expect.stringContaining("Aucune collection active"),
    });
    expect(await b.c.lancer("search")).toMatchObject({
      ok: false,
      msg: expect.stringContaining("/rag search <question>"),
    });
    const g = monter({ selection: [idRag(1)], generation: true, api: { rechercher } });
    expect(await g.c.lancer("search question")).toMatchObject({
      ok: false,
      msg: expect.stringContaining("génération est en cours"),
    });
    expect(rechercher).not.toHaveBeenCalled();
    expect(g.messages.value).toEqual([]);
  });

  it("une collection en panne n'empêche pas les autres : son erreur est dans la notice", async () => {
    const rechercher = vi.fn(async (id: string) =>
      id === idRag(1) ? trouvees(1, 1) : echec("qdrant_indisponible", "interne"),
    );
    const b = monter({ selection: [idRag(1), idRag(2)], api: { rechercher } });
    await b.c.lancer("search certificat");
    const n = lireNotice((b.messages.value[0] as { summary: string }).summary);
    expect(n?.erreurs).toEqual(["« Contrats fournisseurs » : La base vectorielle est indisponible."]);
    expect(n?.passages).toHaveLength(1);
  });

  it("toutes les collections en échec : une erreur dite, pas de notice", async () => {
    const rechercher = vi.fn(async () => echec("embeddings_indisponibles", ""));
    const b = monter({ selection: [idRag(1)], api: { rechercher } });
    const r = await b.c.lancer("search certificat");
    expect(r).toMatchObject({
      ok: false,
      msg: "« Procédures réseau » : Le serveur d’embeddings est injoignable.",
    });
    expect(b.messages.value).toEqual([]);
  });

  it("aucun passage trouvé : la notice le dit", async () => {
    const vide = ok({
      mode: "mixte" as const,
      reranked: false,
      passages: [],
      map: [],
      duration_ms: 3,
      tokens: 0,
      warnings: [],
      errors: [],
    });
    const b = monter({ selection: [idRag(1)], api: { rechercher: vi.fn(async () => vide) } });
    await b.c.lancer("search rien");
    expect(lireNotice((b.messages.value[0] as { summary: string }).summary)?.passages).toEqual([]);
  });
});

const resultat = (
  name: string,
  status: ResultatDepotRag["status"],
  extra: Partial<ResultatDepotRag> = {},
): ResultatDepotRag => ({ name, status, ...extra });

describe("/rag add et /rag new", () => {
  it("add dépose les fichiers joints dans une de mes collections (multipart), vide les pièces jointes", async () => {
    const deposer = vi.fn(async (_id: string, corps: FormData) => {
      const noms = (corps.getAll("files") as File[]).map((f) => f.name);
      return ok({ results: noms.map((n) => resultat(n, "ajoute")), job: travail(1, idRag(1)) });
    });
    const b = monter({ pieces: [fichier("guide.pdf"), fichier("notes.docx")], api: { deposer } });
    const r = await b.c.lancer("add Procédures réseau");
    expect(deposer).toHaveBeenCalledOnce();
    expect(deposer.mock.calls[0]?.[0]).toBe(idRag(1));
    expect((deposer.mock.calls[0]?.[1] as FormData).getAll("files")).toHaveLength(2);
    expect(r.ok).toBe(true);
    expect(r.msg).toBe(
      "« Procédures réseau » : 2 ajoutés. L’indexation démarre : /rag status pour la suivre.",
    );
    expect(b.attachedFiles.value).toEqual([]);
    expect(b.notifier).toHaveBeenCalled();
  });

  it("add importe aussi les @fichiers de la sandbox", async () => {
    const importerBac = vi.fn(async (_id: string, paths: string[]) =>
      ok({ results: paths.map((p) => resultat(p, "ajoute")), job: null }),
    );
    const b = monter({
      pieces: [{ name: "docs/guide.pdf", content: "x", isMention: true }],
      api: { importerBac },
    });
    const r = await b.c.lancer("add Contrats fournisseurs");
    expect(importerBac).toHaveBeenCalledWith(idRag(2), ["docs/guide.pdf"]);
    expect(r.ok).toBe(true);
  });

  it("add : aucun fichier joint, collection partagée, collection inconnue — chaque erreur est claire", async () => {
    const b = monter({ pieces: [] });
    expect(await b.c.lancer("add Procédures réseau")).toMatchObject({
      ok: false,
      msg: expect.stringContaining("Aucun fichier joint"),
    });
    const c = monter({ pieces: [fichier("a.pdf")] });
    expect(await c.c.lancer("add Base de connaissances support")).toMatchObject({
      ok: false,
      msg: expect.stringContaining("lecture seule"),
    });
    expect(await c.c.lancer("add Rien")).toMatchObject({
      ok: false,
      msg: expect.stringContaining("Collection inconnue"),
    });
    expect(await c.c.lancer("add")).toMatchObject({
      ok: false,
      msg: expect.stringContaining("/rag add <collection>"),
    });
    expect(c.api.deposer).not.toHaveBeenCalled();
  });

  it("add : les images et fichiers non lus sont comptés comme ignorés ; seules des images : aucun fichier joint", async () => {
    const deposer = vi.fn(async () => ok({ results: [resultat("a.pdf", "ajoute")], job: null }));
    const b = monter({
      pieces: [fichier("a.pdf"), { name: "photo.png", content: "data:", isImage: true }],
      api: { deposer },
    });
    expect((await b.c.lancer("add Procédures réseau")).msg).toContain("1 pièce jointe ignorée");
    const c = monter({ pieces: [{ name: "photo.png", content: "data:", isImage: true }] });
    expect(await c.c.lancer("add Procédures réseau")).toMatchObject({
      ok: false,
      msg: expect.stringContaining("Aucun fichier joint"),
    });
  });

  it("add : quota, lecture seule et refus par fichier sont dits ; les pièces jointes restent si rien n'est accepté", async () => {
    const quota = monter({
      pieces: [fichier("a.pdf")],
      api: { deposer: vi.fn(async () => echec("quota_stockage", "")) },
    });
    expect(await quota.c.lancer("add Procédures réseau")).toEqual({
      ok: false,
      msg: "Votre quota de stockage RAG est atteint.",
    });
    expect(quota.attachedFiles.value).toHaveLength(1);
    const refus = monter({
      pieces: [fichier("a.pdf")],
      api: {
        deposer: vi.fn(async () =>
          ok({
            results: [resultat("a.pdf", "refuse", { code: "quota_documents", message: "Trop de documents" })],
            job: null,
          }),
        ),
      },
    });
    const r = await refus.c.lancer("add Procédures réseau");
    expect(r.ok).toBe(false);
    expect(r.msg).toContain("1 refusé");
    expect(r.msg).toContain("Refusé : a.pdf (Trop de documents)");
    expect(refus.attachedFiles.value).toHaveLength(1);
  });

  it("add : un fichier trop gros ou vide est refusé avant l'envoi, un RAG inutilisable est dit", async () => {
    const e = etat({ quotas: { storage_mb: 2048, collections: 10, file_mb: 1, docs_per_collection: 2000 } });
    const deposer = vi.fn();
    const gros = monter({
      pieces: [fichier("gros.pdf", 2 * 1024 * 1024)],
      api: { etat: vi.fn(async () => ok(e)), deposer },
    });
    const r = await gros.c.lancer("add Procédures réseau");
    expect(deposer).not.toHaveBeenCalled();
    expect(nb(r.msg ?? "")).toContain("Dépasse 1 Mo par fichier");
    const off = monter({
      pieces: [fichier("a.pdf")],
      api: {
        etat: vi.fn(async () =>
          ok(
            etat({
              usable: false,
              reason: { code: "embeddings_non_configures", message: "Embeddings non configurés" },
            }),
          ),
        ),
        deposer,
      },
    });
    expect(await off.c.lancer("add Procédures réseau")).toEqual({
      ok: false,
      msg: "Embeddings non configurés",
    });
  });

  it("new crée la collection puis y dépose les fichiers joints", async () => {
    const creer = vi.fn(async (name: string) => ok(collection(9, { name })));
    const deposer = vi.fn(async () => ok({ results: [resultat("a.pdf", "ajoute")], job: null }));
    const b = monter({ pieces: [fichier("a.pdf")], api: { creer, deposer } });
    const r = await b.c.lancer("new Notes de réunion 2026");
    expect(creer).toHaveBeenCalledWith("Notes de réunion 2026", "");
    expect(deposer).toHaveBeenCalledWith(idRag(9), expect.any(FormData));
    expect(r.ok).toBe(true);
    expect(r.msg).toContain("Collection « Notes de réunion 2026 » créée.");
    expect(r.msg).toContain("1 ajouté");
  });

  it("new sans fichier : collection vide créée, pistes pour la remplir", async () => {
    const b = monter({ api: { creer: vi.fn(async (name: string) => ok(collection(9, { name }))) } });
    const r = await b.c.lancer("new Archives");
    expect(r).toMatchObject({
      ok: true,
      msg: expect.stringContaining("Ajoutez-y des documents avec /rag add"),
    });
    expect(b.api.deposer).not.toHaveBeenCalled();
  });

  it("new : nom manquant, trop long, déjà pris, quota atteint", async () => {
    const b = monter({ api: { creer: vi.fn(async () => echec("nom_deja_pris", "")) } });
    expect(await b.c.lancer("new")).toMatchObject({
      ok: false,
      msg: expect.stringContaining("/rag new <nom>"),
    });
    expect(await b.c.lancer("new " + "x".repeat(81))).toMatchObject({
      ok: false,
      msg: expect.stringContaining("80 caractères"),
    });
    expect(await b.c.lancer("new Notes")).toEqual({
      ok: false,
      msg: "Vous avez déjà une collection de ce nom.",
    });
    const q = monter({ api: { creer: vi.fn(async () => echec("quota_collections", "")) } });
    expect(await q.c.lancer("new Notes")).toEqual({
      ok: false,
      msg: "Vous avez atteint le nombre maximal de collections.",
    });
    const d = monter({ api: { creer: vi.fn(async () => echec("rag_desactive", "")) } });
    expect((await d.c.lancer("new Notes")).msg).toContain("RAG est désactivé");
  });
});

describe("/rag status et /rag open", () => {
  it("status liste les indexations en cours avec leur avancement", async () => {
    const b = monter({
      api: {
        travaux: vi.fn(async () =>
          ok([
            travail(1, idRag(1), { done: 12, total: 48 }),
            travail(2, idRag(2), { done: 3, total: 10, status: "paused" }),
          ]),
        ),
      },
    });
    const r = await b.c.lancer("status");
    expect(r).toEqual({
      ok: true,
      info: true,
      msg: "2 indexations en cours : « Procédures réseau » 12/48 (25 %) · « Contrats fournisseurs » 3/10 (30 %, suspendue).",
    });
  });

  it("status : rien en cours, ou erreur dite", async () => {
    const b = monter();
    expect(await b.c.lancer("status")).toEqual({ ok: true, info: true, msg: "Aucune indexation en cours." });
    const e = monter({ api: { travaux: vi.fn(async () => echec("rag_interdit", "")) } });
    expect(await e.c.lancer("status")).toEqual({ ok: false, msg: "Le RAG n’est pas ouvert à votre compte." });
  });

  it("open ouvre la page, sur une collection si elle est nommée", async () => {
    const b = monter();
    expect(await b.c.lancer("open")).toEqual({ ok: true, silent: true });
    expect(b.ouvrirPage).toHaveBeenLastCalledWith();
    expect(await b.c.lancer("open Base de connaissances support")).toEqual({ ok: true, silent: true });
    expect(b.ouvrirPage).toHaveBeenLastCalledWith(idRag(3));
    expect(await b.c.lancer("open Rien")).toMatchObject({ ok: false });
  });

  it("sous-commande absente ou inconnue", async () => {
    const b = monter();
    expect(await b.c.lancer("")).toMatchObject({
      ok: true,
      info: true,
      msg: expect.stringContaining("use, off, search, add, new, status, open"),
    });
    expect(await b.c.lancer("zap")).toMatchObject({
      ok: false,
      msg: expect.stringContaining("Sous-commande inconnue : « zap »"),
    });
  });
});

describe("disponibilité et menus", () => {
  it("la commande disparaît quand le serveur a refusé le RAG au compte", () => {
    const b = monter();
    expect(b.c.disponible()).toBe(true);
    b.ragChat.autorise.value = false;
    expect(b.c.disponible()).toBe(false);
  });

  it("valeurs : sous-commandes d'abord, puis collections selon la sous-commande", () => {
    const b = monter();
    expect(b.c.valeurs([]).map((v) => v.value)).toEqual([
      "use",
      "off",
      "search",
      "add",
      "new",
      "status",
      "open",
    ]);
    expect(b.c.valeurs(["use"])).toHaveLength(3);
    expect(b.c.valeurs(["add"])).toHaveLength(2);
    expect(b.c.valeurs(["search"])).toEqual([]);
    expect(b.c.valeurs(["new"])).toEqual([]);
  });

  it("actualiser relit la liste au plus toutes les dix secondes", () => {
    const b = monter();
    b.c.actualiser();
    b.c.actualiser();
    expect(b.ragChat.rafraichir).toHaveBeenCalledTimes(1);
    b.maintenant.mockReturnValue(1_011_000);
    b.c.actualiser();
    expect(b.ragChat.rafraichir).toHaveBeenCalledTimes(2);
  });
});
