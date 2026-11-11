// SPDX-License-Identifier: MIT
/** frontend/test/rag/rag.test.ts — état de la page RAG : ouverture, droits, sélection, flux `rag_job`, dépôt, création, suppression, publication, masquage, « Discuter avec », Tester, Réglages, import du bac, Échap. */
import { effectScope, reactive } from "vue";
import type { DocumentRag, TravailRag } from "@elpis/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { creerRag, EVT_COLLECTIONS, EVT_DISCUTER, EVT_TRAVAIL } from "../../src/features/rag/rag";
import type { RechercheRag } from "../../src/features/rag/api";
import {
  collection,
  decoupage,
  document,
  echec,
  etat,
  fausseApi,
  fauxCtx,
  faussesRefs,
  idRag,
  ok,
  partagee,
  travail,
  vider,
} from "./aides";

const scopes: ReturnType<typeof effectScope>[] = [];

interface Options {
  api?: Parameters<typeof fausseApi>[0];
  confirmation?: boolean;
  vue?: string;
  user?: unknown;
  periodeSondageMs?: number;
}

function monter(o: Options = {}) {
  const api = fausseApi(o.api);
  const { ctx, toasts } = fauxCtx(o.confirmation ?? true);
  const refs = faussesRefs(o.vue ?? "chat", o.user === undefined ? { id: 1, username: "alice" } : o.user);
  const cible = new EventTarget();
  const evenements = { collections: 0, discuter: [] as unknown[] };
  cible.addEventListener(EVT_COLLECTIONS, () => evenements.collections++);
  cible.addEventListener(EVT_DISCUTER, (e) => evenements.discuter.push((e as CustomEvent).detail));
  const scope = effectScope();
  scopes.push(scope);
  const rg = reactive(
    scope.run(() => creerRag(api, refs, ctx, { cible, periodeSondageMs: o.periodeSondageMs ?? 100_000 }))!,
  );
  // Par défaut le serveur relit la collection telle que la page la connaît.
  api.source = () => rg.collections;
  return { rg, api, ctx, toasts, refs, cible, evenements };
}

afterEach(() => {
  for (const s of scopes.splice(0)) s.stop();
  vi.useRealTimers();
});

const MES = [collection(1, { name: "Procédures réseau", doc_count: 3 }), collection(2, { name: "Contrats" })];

describe("ouverture et droits", () => {
  it("lit l'état dès la connexion : l'entrée du volet dépend du droit RAG", async () => {
    const { rg, api } = monter({
      api: { etat: vi.fn(async () => ok(etat({ allowed: false, usable: false }))) },
    });
    await vider();
    expect(api.etat).toHaveBeenCalledTimes(1);
    expect(rg.autorise).toBe(false);
    const autre = monter();
    await vider();
    expect(autre.rg.autorise).toBe(true);
  });

  it("sans compte connecté, rien n'est lu", async () => {
    const { rg, api } = monter({ user: null });
    await vider();
    expect(api.etat).not.toHaveBeenCalled();
    expect(rg.autorise).toBe(false);
  });

  it("ouvrir : vue « rag », état, collections et travaux chargés, première de mes collections sélectionnée avec ses documents", async () => {
    const docs = [document(1, idRag(1))];
    const { rg, api, refs } = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        documents: vi.fn(async () => ok({ documents: docs, total: 1 })),
      },
    });
    await rg.ouvrir();
    await vider();
    expect(refs.currentView.value).toBe("rag");
    expect(rg.ouverte).toBe(true);
    expect(api.collections).toHaveBeenCalledTimes(1);
    expect(api.travaux).toHaveBeenCalledWith(true);
    expect(rg.selection).toBe(idRag(1));
    expect(api.documents).toHaveBeenCalledWith(idRag(1), 0, 500);
    expect(rg.documents.documents).toEqual(docs);
    expect(rg.premiereVisite).toBe(false);
  });

  it("fermer : retour au chat", async () => {
    const { rg, refs } = monter();
    await rg.ouvrir();
    rg.fermer();
    expect(refs.currentView.value).toBe("chat");
    expect(rg.ouverte).toBe(false);
  });

  it("rouvrir la page sur la même collection relit ses documents", async () => {
    const { rg, api } = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        documents: vi.fn(async () => ok({ documents: [], total: 0 })),
      },
    });
    await rg.ouvrir();
    await vider();
    const lectures = api.documents.mock.calls.length;
    rg.fermer();
    await rg.ouvrir();
    await vider();
    expect(api.documents.mock.calls.length).toBe(lectures + 1);
  });

  it("déconnexion : tout est remis à zéro, l'entrée disparaît", async () => {
    const { rg, refs } = monter({ api: { collections: vi.fn(async () => ok(MES)) } });
    await rg.ouvrir();
    await vider();
    refs.user.value = null;
    await vider();
    expect(rg.collections).toEqual([]);
    expect(rg.selection).toBeNull();
    expect(rg.etat).toBeNull();
    expect(rg.autorise).toBe(false);
  });

  it("changement de compte : l'état du précédent ne survit pas", async () => {
    const { rg, refs, api } = monter({ api: { collections: vi.fn(async () => ok(MES)) } });
    await rg.ouvrir();
    await vider();
    refs.user.value = { id: 2, username: "bob" };
    await vider();
    expect(rg.collections).toEqual([]);
    expect(api.etat).toHaveBeenCalledTimes(3);
  });
});

describe("liste des collections", () => {
  const liste = [
    collection(1, { name: "Procédures réseau" }),
    collection(2, { name: "Contrats" }),
    partagee(3, "Sophie Laurent", { name: "Base support" }),
    partagee(4, "Marc Dubois", { name: "PSSI" }),
    partagee(5, "Marc Dubois", { name: "Ancienne", hidden: true }),
  ];

  it("mes collections, partagées avec moi (sans les masquées), masquées à part", async () => {
    const { rg } = monter({ api: { collections: vi.fn(async () => ok(liste)) } });
    await rg.ouvrir();
    expect(rg.mes.map((c) => c.name)).toEqual(["Procédures réseau", "Contrats"]);
    expect(rg.partagees.map((c) => c.name)).toEqual(["Base support", "PSSI"]);
    expect(rg.masquees.map((c) => c.name)).toEqual(["Ancienne"]);
  });

  it("le filtre porte sur les trois groupes", async () => {
    const { rg } = monter({ api: { collections: vi.fn(async () => ok(liste)) } });
    await rg.ouvrir();
    rg.filtre = "marc";
    expect(rg.mesFiltrees).toEqual([]);
    expect(rg.partageesFiltrees.map((c) => c.name)).toEqual(["PSSI"]);
    expect(rg.masqueesFiltrees.map((c) => c.name)).toEqual(["Ancienne"]);
  });

  it("première visite : aucune collection à soi, même si d'autres sont partagées", async () => {
    const { rg } = monter({ api: { collections: vi.fn(async () => ok([partagee(3), partagee(4)])) } });
    expect(rg.premiereVisite).toBe(false);
    await rg.ouvrir();
    expect(rg.selection).toBeNull();
    expect(rg.premiereVisite).toBe(true);
    rg.selectionner(idRag(3));
    expect(rg.premiereVisite).toBe(false);
    expect(rg.estProprietaire).toBe(false);
  });

  it("une erreur de chargement est dite, la liste reste vide", async () => {
    const { rg } = monter({ api: { collections: vi.fn(async () => echec(null, "Erreur réseau")) } });
    await rg.ouvrir();
    expect(rg.erreurListe).toBe("Erreur réseau");
    expect(rg.premiereVisite).toBe(false);
  });

  it("la sélection disparue du serveur retombe sur la première de mes collections", async () => {
    let n = 0;
    const { rg } = monter({ api: { collections: vi.fn(async () => ok(n++ === 0 ? MES : [MES[1]!])) } });
    await rg.ouvrir();
    expect(rg.selection).toBe(idRag(1));
    await rg.charger();
    expect(rg.selection).toBe(idRag(2));
  });
});

describe("lecteur : lecture seule", () => {
  it("l'onglet Réglages lui est fermé, Documents et Tester restent", async () => {
    const { rg } = monter({ api: { collections: vi.fn(async () => ok([partagee(3)])) } });
    await rg.ouvrir();
    rg.selectionner(idRag(3));
    rg.choisirOnglet("reglages");
    expect(rg.onglet).toBe("documents");
    rg.choisirOnglet("tester");
    expect(rg.onglet).toBe("tester");
  });

  it("changer pour une collection partagée quand l'onglet Réglages était ouvert ramène à Documents", async () => {
    const { rg } = monter({ api: { collections: vi.fn(async () => ok([collection(1), partagee(3)])) } });
    await rg.ouvrir();
    rg.choisirOnglet("reglages");
    expect(rg.onglet).toBe("reglages");
    rg.selectionner(idRag(3));
    expect(rg.onglet).toBe("documents");
  });

  it("aucun dépôt, aucune publication, aucun import pour un lecteur", async () => {
    const { rg, api } = monter({ api: { collections: vi.fn(async () => ok([partagee(3)])) } });
    await rg.ouvrir();
    rg.selectionner(idRag(3));
    expect(await rg.documents.deposer([{ file: new File(["x"], "a.md"), chemin: "a.md" }])).toBe(false);
    await rg.publier.ouvrir();
    await rg.bac.ouvrir();
    expect(rg.publier.ouvert).toBe(false);
    expect(rg.bac.ouvert).toBe(false);
    expect(api.deposer).not.toHaveBeenCalled();
    expect(api.groupesPublication).not.toHaveBeenCalled();
    expect(api.arbreBac).not.toHaveBeenCalled();
  });
});

describe("documents", () => {
  it("charge toutes les pages de 500", async () => {
    const page = (debut: number, n: number): DocumentRag[] =>
      Array.from({ length: n }, (_, i) => document(debut + i, idRag(1)));
    const documents = vi.fn(async (_id: string, offset: number) =>
      ok({
        documents: offset === 0 ? page(0, 500) : offset === 500 ? page(500, 500) : page(1000, 200),
        total: 1200,
      }),
    );
    const { rg } = monter({ api: { collections: vi.fn(async () => ok(MES)), documents } });
    await rg.ouvrir();
    await vider();
    expect(documents.mock.calls.map((c) => c[1])).toEqual([0, 500, 1000]);
    expect(rg.documents.documents).toHaveLength(1200);
    expect(rg.documents.total).toBe(1200);
    expect(rg.documents.virtualise).toBe(true);
  });

  it("au-delà de 500 lignes seulement le tableau est virtualisé ; le filtre le ramène sous le seuil", async () => {
    const docs = Array.from({ length: 501 }, (_, i) => document(i, idRag(1), { rel_path: `d/f${i}.md` }));
    const { rg } = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        documents: vi.fn(async () => ok({ documents: docs, total: 501 })),
      },
    });
    await rg.ouvrir();
    await vider();
    expect(rg.documents.virtualise).toBe(true);
    rg.documents.filtreTexte = "f12";
    expect(rg.documents.lignes.length).toBeLessThan(500);
    expect(rg.documents.virtualise).toBe(false);
    expect(rg.documents.filtrees).toBe(true);
  });

  it("une réponse tardive d'une collection quittée est écartée", async () => {
    const attentes: ((v: ReturnType<typeof ok<{ documents: DocumentRag[]; total: number }>>) => void)[] = [];
    const documents = vi.fn((id: string) =>
      new Promise<ReturnType<typeof ok<{ documents: DocumentRag[]; total: number }>>>((r) =>
        attentes.push((v) => r(v)),
      ).then((v) => (id === idRag(1) ? v : v)),
    );
    const { rg } = monter({ api: { collections: vi.fn(async () => ok(MES)), documents } });
    await rg.ouvrir();
    await vider();
    rg.selectionner(idRag(2));
    attentes[1]?.(ok({ documents: [document(2, idRag(2))], total: 1 }));
    await vider();
    attentes[0]?.(ok({ documents: [document(1, idRag(1))], total: 1 }));
    await vider();
    expect(rg.documents.documents.map((d) => d.collection_id)).toEqual([idRag(2)]);
  });

  it("changer de collection remet à zéro filtres et résultats du dépôt", async () => {
    const { rg } = monter({ api: { collections: vi.fn(async () => ok(MES)) } });
    await rg.ouvrir();
    rg.documents.filtreTexte = "abc";
    rg.documents.filtreEtat = "erreurs";
    rg.documents.depot.visible = true;
    rg.selectionner(idRag(2));
    expect(rg.documents.filtreTexte).toBe("");
    expect(rg.documents.filtreEtat).toBe("tous");
    expect(rg.documents.depot.visible).toBe(false);
  });

  it("réindexer un document : requête forcée, ligne remise en attente", async () => {
    const d = document(1, idRag(1), { status: "error", error: { code: "no_text", message: "x" } });
    const reindexer = vi.fn(async () =>
      ok({ job: travail(1, idRag(1), { kind: "reindex", total: 1, done: 0 }) }),
    );
    const { rg } = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        documents: vi.fn(async () => ok({ documents: [d], total: 1 })),
        reindexer,
      },
    });
    await rg.ouvrir();
    await vider();
    await rg.documents.reindexerDocument(d);
    expect(reindexer).toHaveBeenCalledWith(idRag(1), [d.id], true);
    expect(rg.documents.documents[0]).toMatchObject({ status: "pending", error: null });
    expect(rg.documents.travail?.kind).toBe("reindex");
  });

  it("retirer un document : confirmation, suppression, ligne et compteurs mis à jour", async () => {
    const d1 = document(1, idRag(1));
    const d2 = document(2, idRag(1));
    const supprimerDocument = vi.fn(async () => ok({ ok: true }));
    const { rg, ctx } = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        documents: vi.fn(async () => ok({ documents: [d1, d2], total: 2 })),
        supprimerDocument,
        collection: vi.fn(async () => ok(collection(1, { doc_count: 1 }))),
      },
    });
    await rg.ouvrir();
    await vider();
    await rg.documents.retirerDocument(d1);
    expect(ctx.openConfirm).toHaveBeenCalled();
    expect(supprimerDocument).toHaveBeenCalledWith(idRag(1), d1.id);
    expect(rg.documents.documents.map((d) => d.id)).toEqual([d2.id]);
    expect(rg.documents.total).toBe(1);
    expect(rg.courante?.doc_count).toBe(1);
  });

  it("retirer un document : refus de la confirmation, rien n'est envoyé", async () => {
    const d1 = document(1, idRag(1));
    const { rg, api } = monter({
      confirmation: false,
      api: {
        collections: vi.fn(async () => ok(MES)),
        documents: vi.fn(async () => ok({ documents: [d1], total: 1 })),
      },
    });
    await rg.ouvrir();
    await vider();
    await rg.documents.retirerDocument(d1);
    expect(api.supprimerDocument).not.toHaveBeenCalled();
    expect(rg.documents.documents).toHaveLength(1);
  });
});

describe("travaux d'indexation en direct", () => {
  const COLL = idRag(1);
  const demarrer = async (job: TravailRag | null, docs: DocumentRag[] = []) => {
    const m = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        travaux: vi.fn(async () => ok(job ? [job] : [])),
        documents: vi.fn(async () => ok({ documents: docs, total: docs.length })),
        collection: vi.fn(async () => ok(collection(1, { doc_count: 9, chunk_count: 400 }))),
      },
    });
    await m.rg.ouvrir();
    await vider();
    return m;
  };

  it("après un rechargement, les travaux actifs reviennent par la route", async () => {
    const { rg } = await demarrer(travail(1, COLL, { total: 8, done: 3 }));
    expect(rg.documents.travail?.id).toBe(idRag(2001));
    expect(rg.documents.progression(COLL)).toBe(38);
    expect(rg.documents.progression(idRag(2))).toBeNull();
  });

  it("bandeau : titre, détail et part faite", async () => {
    const docs = [document(1, COLL, { status: "indexing" }), document(2, COLL, { status: "pending" })];
    const { rg } = await demarrer(
      travail(1, COLL, { total: 9, done: 3, failed: 1, created_at: Date.now() / 1000 - 60 }),
      docs,
    );
    const b = rg.documents.bandeau;
    expect(b?.titre.replace(/\u00a0/g, " ")).toBe("Indexation de 9 documents ajoutés");
    expect(b?.detail.replace(/\u00a0/g, " ")).toMatch(
      /^3 terminés · 1 en échec · 1 en cours · environ \d+ min restantes$/u,
    );
    expect(b?.pourcent).toBe(44);
    expect(b?.enPause).toBe(false);
  });

  it("événement rag_job : le travail se met à jour et la ligne du document arrive", async () => {
    const { rg, cible } = await demarrer(travail(1, COLL, { total: 8, done: 3 }), [
      document(1, COLL, { status: "indexing" }),
    ]);
    const lue = document(1, COLL, { status: "ready", chunk_count: 26 });
    cible.dispatchEvent(
      new CustomEvent(EVT_TRAVAIL, {
        detail: { collection_id: COLL, job: travail(1, COLL, { total: 8, done: 4 }), document: lue },
      }),
    );
    expect(rg.documents.travail?.done).toBe(4);
    expect(rg.documents.documents[0]).toMatchObject({ status: "ready", chunk_count: 26 });
    expect(rg.documents.documents).toHaveLength(1);
  });

  it("événement pour un document nouveau : ajouté ; pour une autre collection : ignoré dans la liste", async () => {
    const { rg, cible } = await demarrer(null);
    cible.dispatchEvent(
      new CustomEvent(EVT_TRAVAIL, {
        detail: {
          collection_id: COLL,
          job: travail(1, COLL),
          document: document(5, COLL, { status: "pending" }),
        },
      }),
    );
    expect(rg.documents.documents.map((d) => d.id)).toEqual([idRag(1005)]);
    cible.dispatchEvent(
      new CustomEvent(EVT_TRAVAIL, {
        detail: { collection_id: idRag(2), job: travail(2, idRag(2)), document: document(6, idRag(2)) },
      }),
    );
    expect(rg.documents.documents).toHaveLength(1);
    expect(rg.documents.travaux).toHaveLength(2);
  });

  it("travail terminé : il quitte la liste, la collection, l'état et les documents se relisent", async () => {
    const { rg, cible, api, ctx } = await demarrer(travail(1, COLL, { total: 8, done: 7 }));
    const avant = api.documents.mock.calls.length;
    cible.dispatchEvent(
      new CustomEvent(EVT_TRAVAIL, {
        detail: {
          collection_id: COLL,
          job: travail(1, COLL, { status: "done", total: 8, done: 8, finished_at: 1_700_000_999 }),
        },
      }),
    );
    await vider();
    expect(rg.documents.travail).toBeNull();
    expect(rg.documents.progression(COLL)).toBeNull();
    expect(api.collection).toHaveBeenCalledWith(COLL);
    expect(rg.courante?.doc_count).toBe(9);
    expect(api.documents.mock.calls.length).toBe(avant + 1);
    expect(ctx.announce).toHaveBeenCalledWith("Indexation terminée.");
  });

  it("un événement mal formé ne casse rien", async () => {
    const { rg, cible } = await demarrer(null);
    cible.dispatchEvent(new CustomEvent(EVT_TRAVAIL, { detail: null }));
    cible.dispatchEvent(new CustomEvent(EVT_TRAVAIL, { detail: { collection_id: COLL } }));
    expect(rg.documents.travaux).toEqual([]);
  });

  it("suspendre, reprendre : l'état du travail suit la réponse", async () => {
    const agirTravail = vi.fn(async (_id: string, action: string) =>
      ok(travail(1, COLL, { status: action === "suspendre" ? "paused" : "running" })),
    );
    const m = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        travaux: vi.fn(async () => ok([travail(1, COLL)])),
        agirTravail,
      },
    });
    await m.rg.ouvrir();
    await vider();
    await m.rg.documents.agir("suspendre");
    expect(agirTravail).toHaveBeenCalledWith(idRag(2001), "suspendre");
    expect(m.rg.documents.bandeau?.enPause).toBe(true);
    expect(m.rg.documents.bandeau?.titre).toBe("Indexation suspendue");
    await m.rg.documents.agir("reprendre");
    expect(m.rg.documents.bandeau?.enPause).toBe(false);
  });

  it("annuler : confirmation expliquée avant l'appel ; refus de la confirmation, rien n'est envoyé", async () => {
    const agirTravail = vi.fn(async () => ok(travail(1, COLL, { status: "cancelled" })));
    const m = monter({
      confirmation: false,
      api: {
        collections: vi.fn(async () => ok(MES)),
        travaux: vi.fn(async () => ok([travail(1, COLL)])),
        agirTravail,
      },
    });
    await m.rg.ouvrir();
    await vider();
    await m.rg.documents.agir("annuler");
    expect(m.ctx.openConfirm).toHaveBeenCalledWith(
      expect.stringContaining("Annuler"),
      expect.stringContaining("conservés"),
      true,
      expect.any(String),
    );
    expect(agirTravail).not.toHaveBeenCalled();
  });

  it("annuler confirmé : le travail est retiré et les documents relus", async () => {
    const agirTravail = vi.fn(async () =>
      ok(travail(1, COLL, { status: "cancelled", finished_at: 1_700_000_999 })),
    );
    const m = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        travaux: vi.fn(async () => ok([travail(1, COLL)])),
        agirTravail,
        collection: vi.fn(async () => ok(collection(1))),
      },
    });
    await m.rg.ouvrir();
    await vider();
    await m.rg.documents.agir("annuler");
    await vider();
    expect(m.rg.documents.travail).toBeNull();
    expect(m.ctx.announce).toHaveBeenCalledWith("Indexation annulée.");
  });

  it("relecture périodique des travaux actifs tant que la page est ouverte, arrêtée à la fermeture", async () => {
    vi.useFakeTimers();
    const m = monter({
      periodeSondageMs: 1000,
      api: { collections: vi.fn(async () => ok(MES)), travaux: vi.fn(async () => ok([travail(1, COLL)])) },
    });
    await m.rg.ouvrir();
    await vi.advanceTimersByTimeAsync(0);
    const base = m.api.travaux.mock.calls.length;
    m.refs.currentView.value = "rag";
    await vi.advanceTimersByTimeAsync(3000);
    expect(m.api.travaux.mock.calls.length).toBe(base + 3);
    m.rg.fermer();
    await vi.advanceTimersByTimeAsync(3000);
    expect(m.api.travaux.mock.calls.length).toBe(base + 3);
  });
});

describe("course entre la réponse HTTP et les événements d'un travail", () => {
  const COLL = idRag(1);

  it("l'événement de fin arrive avant la réponse : aucun travail fantôme, document à jour, documents relus", async () => {
    const d = document(1, COLL, { status: "ready" });
    let serveur = d;
    let cible: EventTarget | null = null;
    const reindexer = vi.fn(async () => {
      const fini = travail(1, COLL, {
        kind: "reindex",
        status: "done",
        total: 1,
        done: 1,
        finished_at: 1_700_000_999,
      });
      serveur = { ...d, chunk_count: 30 };
      cible?.dispatchEvent(
        new CustomEvent(EVT_TRAVAIL, {
          detail: { collection_id: COLL, job: fini, document: serveur },
        }),
      );
      await vider();
      return ok({ job: travail(1, COLL, { kind: "reindex", status: "queued", total: 1, done: 0 }) });
    });
    const m = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        documents: vi.fn(async () => ok({ documents: [serveur], total: 1 })),
        reindexer,
      },
    });
    cible = m.cible;
    await m.rg.ouvrir();
    await vider();
    const lectures = m.api.documents.mock.calls.length;
    await m.rg.documents.reindexerDocument(d);
    await vider();
    expect(m.rg.documents.travail).toBeNull();
    expect(m.rg.documents.travaux).toEqual([]);
    expect(m.rg.documents.documents[0]).toMatchObject({ status: "ready", chunk_count: 30 });
    expect(m.api.documents.mock.calls.length).toBe(lectures + 1);
  });

  it("dépôt dont le travail est déjà fini à la réponse : le travail ne reste pas affiché", async () => {
    let cible: EventTarget | null = null;
    const deposer = vi.fn(async () => {
      cible?.dispatchEvent(
        new CustomEvent(EVT_TRAVAIL, {
          detail: { collection_id: COLL, job: travail(1, COLL, { status: "done", total: 1, done: 1 }) },
        }),
      );
      return ok({ results: [], job: travail(1, COLL, { status: "running", total: 1, done: 0 }) });
    });
    const m = monter({ api: { collections: vi.fn(async () => ok(MES)), deposer } });
    cible = m.cible;
    await m.rg.ouvrir();
    await vider();
    await m.rg.documents.deposer([{ file: new File(["x"], "a.md"), chemin: "a.md" }]);
    await vider();
    expect(m.rg.documents.travail).toBeNull();
    expect(m.rg.documents.progression(COLL)).toBeNull();
  });

  it("un événement périmé, livré après la fin de son travail, ne remet pas le document en cours", async () => {
    const d = document(1, COLL, { status: "ready" });
    const m = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        documents: vi.fn(async () => ok({ documents: [d], total: 1 })),
      },
    });
    await m.rg.ouvrir();
    await vider();
    const fini = travail(1, COLL, { status: "done", total: 1, done: 1 });
    m.cible.dispatchEvent(
      new CustomEvent(EVT_TRAVAIL, { detail: { collection_id: COLL, job: fini, document: d } }),
    );
    await vider();
    const enCours = document(1, COLL, { status: "indexing" });
    m.cible.dispatchEvent(
      new CustomEvent(EVT_TRAVAIL, {
        detail: { collection_id: COLL, job: travail(1, COLL, { status: "running" }), document: enCours },
      }),
    );
    expect(m.rg.documents.documents[0]?.status).toBe("ready");
    expect(m.rg.documents.travail).toBeNull();
  });

  it("réindexation refusée : la ligne retrouve son état et l'erreur est dite", async () => {
    const d = document(1, COLL, { status: "error", error: { code: "no_text", message: "x" } });
    const m = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        documents: vi.fn(async () => ok({ documents: [d], total: 1 })),
        reindexer: vi.fn(async () => echec("rag_desactive", "Le RAG est désactivé.")),
      },
    });
    await m.rg.ouvrir();
    await vider();
    await m.rg.documents.reindexerDocument(d);
    expect(m.rg.documents.documents[0]).toMatchObject({ status: "error" });
    expect(m.toasts.at(-1)).toEqual({ message: "Le RAG est désactivé.", type: "error" });
  });

  it("relecture périodique : un travail qui n'est plus actif a fini pendant un événement manqué, les écrans se relisent", async () => {
    const lecture = vi.fn();
    let actifs = [travail(1, COLL)];
    const m = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        travaux: vi.fn(async () => ok(actifs)),
        documents: lecture.mockImplementation(async () => ok({ documents: [], total: 0 })),
      },
    });
    await m.rg.ouvrir();
    await vider();
    expect(m.rg.documents.travail).not.toBeNull();
    const avant = lecture.mock.calls.length;
    actifs = [];
    await m.rg.documents.chargerTravaux();
    await vider();
    expect(m.rg.documents.travail).toBeNull();
    expect(lecture.mock.calls.length).toBe(avant + 1);
    await m.rg.documents.chargerTravaux();
    await vider();
    expect(lecture.mock.calls.length).toBe(avant + 1);
  });

  it("une relecture qui rend un travail déjà vu fini ne le ressuscite pas", async () => {
    const m = monter({
      api: { collections: vi.fn(async () => ok(MES)), travaux: vi.fn(async () => ok([travail(1, COLL)])) },
    });
    await m.rg.ouvrir();
    await vider();
    m.cible.dispatchEvent(
      new CustomEvent(EVT_TRAVAIL, {
        detail: { collection_id: COLL, job: travail(1, COLL, { status: "done" }) },
      }),
    );
    await m.rg.documents.chargerTravaux();
    expect(m.rg.documents.travail).toBeNull();
  });
});

describe("dépôt de fichiers", () => {
  const f = (chemin: string, taille = 10) => ({
    file: new File([new Uint8Array(taille)], chemin.split("/").pop() ?? chemin),
    chemin,
  });
  const COLL = idRag(1);

  it("refus locaux sans envoi, fichiers acceptés envoyés en multipart, bilan par fichier, travail suivi, collection relue", async () => {
    const deposer = vi.fn(async (_id: string, corps: FormData) => {
      const noms = (corps.getAll("files") as File[]).map((x) => x.name);
      return ok({
        results: noms.map((name) => ({
          name,
          status: name === "b.md" ? ("deja_present" as const) : ("ajoute" as const),
        })),
        job: travail(1, COLL, { total: 2, done: 0 }),
      });
    });
    const { rg, api } = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        deposer,
        collection: vi.fn(async () => ok(collection(1, { doc_count: 2 }))),
      },
    });
    await rg.ouvrir();
    await vider();
    const ok1 = await rg.documents.deposer([f("dossier/a.pdf"), f("b.md"), f("virus.exe"), f(".DS_Store")]);
    expect(ok1).toBe(true);
    expect(deposer).toHaveBeenCalledTimes(1);
    expect((deposer.mock.calls[0]![1].getAll("files") as File[]).map((x) => x.name)).toEqual([
      "dossier/a.pdf",
      "b.md",
    ]);
    const d = rg.documents.depot;
    expect(d.visible).toBe(true);
    expect(d.ignores).toBe(1);
    expect(d.resultats.map((r) => [r.name, r.status])).toEqual([
      ["virus.exe", "refuse"],
      ["dossier/a.pdf", "ajoute"],
      ["b.md", "deja_present"],
    ]);
    expect(rg.documents.depotBilan).toBe("1 ajouté · 1 déjà présent · 1 refusé");
    expect(rg.documents.travail?.total).toBe(2);
    expect(api.collection).toHaveBeenCalledWith(COLL);
    expect(rg.courante?.doc_count).toBe(2);
    expect(d.enCours).toBe(false);
  });

  it("plafond de taille lu de l'état du serveur", async () => {
    const { rg, api } = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        etat: vi.fn(async () =>
          ok(etat({ quotas: { storage_mb: 2048, collections: 10, file_mb: 1, docs_per_collection: 2000 } })),
        ),
      },
    });
    await rg.ouvrir();
    await vider();
    await rg.documents.deposer([f("gros.pdf", 2 * 1024 * 1024)]);
    expect(api.deposer).not.toHaveBeenCalled();
    expect(rg.documents.depot.resultats[0]?.code).toBe("fichier_trop_gros");
  });

  it("plus de 1000 fichiers : plusieurs envois d'au plus 1000, résultats cumulés", async () => {
    const deposer = vi.fn(async (_id: string, corps: FormData) =>
      ok({
        results: (corps.getAll("files") as File[]).map((x) => ({ name: x.name, status: "ajoute" as const })),
        job: null,
      }),
    );
    const { rg } = monter({ api: { collections: vi.fn(async () => ok(MES)), deposer } });
    await rg.ouvrir();
    await vider();
    await rg.documents.deposer(Array.from({ length: 2100 }, (_, i) => f(`d/f${i}.md`, 1)));
    expect(deposer.mock.calls.map((c) => (c[1].getAll("files") as File[]).length)).toEqual([1000, 1000, 100]);
    expect(rg.documents.depot.resultats).toHaveLength(2100);
  });

  it("échec en cours de route : les envois faits sont gardés, l'erreur est dite, les suivants ne partent pas", async () => {
    let n = 0;
    const deposer = vi.fn(async (_id: string, corps: FormData) =>
      n++ === 0
        ? ok({
            results: (corps.getAll("files") as File[]).map((x) => ({
              name: x.name,
              status: "ajoute" as const,
            })),
            job: null,
          })
        : echec("depot_interrompu", "Le dépôt a été interrompu."),
    );
    const { rg, ctx } = monter({ api: { collections: vi.fn(async () => ok(MES)), deposer } });
    await rg.ouvrir();
    await vider();
    const ok2 = await rg.documents.deposer(Array.from({ length: 2500 }, (_, i) => f(`d/f${i}.md`, 1)));
    expect(ok2).toBe(false);
    expect(deposer).toHaveBeenCalledTimes(2);
    expect(rg.documents.depot.resultats).toHaveLength(1000);
    expect(rg.documents.depot.erreur).toBe("Le dépôt a été interrompu.");
    expect(ctx.announce).toHaveBeenCalledWith("Le dépôt a échoué.");
  });

  it("un seul dépôt à la fois", async () => {
    let fin: () => void = () => undefined;
    const deposer = vi.fn(
      () =>
        new Promise<ReturnType<typeof ok<{ results: never[]; job: null }>>>(
          (r) => (fin = () => r(ok({ results: [], job: null }))),
        ),
    );
    const { rg, toasts } = monter({ api: { collections: vi.fn(async () => ok(MES)), deposer } });
    await rg.ouvrir();
    await vider();
    const premier = rg.documents.deposer([f("a.md")]);
    await vider();
    expect(await rg.documents.deposer([f("b.md")])).toBe(false);
    expect(toasts.at(-1)).toEqual({ message: "Un dépôt est déjà en cours.", type: "error" });
    fin();
    await premier;
  });

  it("aucun fichier : rien à faire", async () => {
    const { rg, api } = monter({ api: { collections: vi.fn(async () => ok(MES)) } });
    await rg.ouvrir();
    expect(await rg.documents.deposer([])).toBe(false);
    expect(api.deposer).not.toHaveBeenCalled();
  });
});

describe("création d'une collection", () => {
  it("nom obligatoire ; créée, elle est sélectionnée, les menus du chat sont avertis", async () => {
    const creer = vi.fn(async (name: string, description: string) =>
      ok(collection(7, { name, description })),
    );
    const { rg, evenements } = monter({ api: { collections: vi.fn(async () => ok(MES)), creer } });
    await rg.ouvrir();
    rg.ouvrirNouvelle();
    expect(rg.nouvelle.ouvert).toBe(true);
    expect(await rg.creerNouvelle()).toBe(false);
    expect(rg.nouvelle.erreur).toBe("Le nom est obligatoire.");
    rg.nouvelle.nom = "  Notes de réunion  ";
    rg.nouvelle.description = "Réunions 2026";
    expect(await rg.creerNouvelle()).toBe(true);
    expect(creer).toHaveBeenCalledWith("Notes de réunion", "Réunions 2026");
    expect(rg.nouvelle.ouvert).toBe(false);
    expect(rg.selection).toBe(idRag(7));
    expect(rg.onglet).toBe("documents");
    expect(rg.mes.map((c) => c.name)).toContain("Notes de réunion");
    expect(evenements.collections).toBe(1);
  });

  it("première visite : les fichiers déposés proposent le nom du dossier et partent à la création", async () => {
    const deposer = vi.fn(async (_id: string, corps: FormData) =>
      ok({
        results: (corps.getAll("files") as File[]).map((x) => ({ name: x.name, status: "ajoute" as const })),
        job: null,
      }),
    );
    const { rg } = monter({ api: { collections: vi.fn(async () => ok([])), deposer } });
    await rg.ouvrir();
    expect(rg.premiereVisite).toBe(true);
    rg.ouvrirNouvelle([
      { file: new File(["x"], "a.md"), chemin: "Procédures/a.md" },
      { file: new File(["y"], "b.md"), chemin: "Procédures/b.md" },
    ]);
    expect(rg.nouvelle.nom).toBe("Procédures");
    await rg.creerNouvelle();
    await vider();
    expect(deposer).toHaveBeenCalledWith(idRag(99), expect.any(FormData));
    expect((deposer.mock.calls[0]![1].getAll("files") as File[]).map((x) => x.name)).toEqual([
      "Procédures/a.md",
      "Procédures/b.md",
    ]);
    expect(rg.premiereVisite).toBe(false);
  });

  it("nom déjà pris et quota atteint : messages en clair, la boîte reste ouverte", async () => {
    const m = monter({
      api: { collections: vi.fn(async () => ok(MES)), creer: vi.fn(async () => echec("nom_deja_pris", "x")) },
    });
    await m.rg.ouvrir();
    m.rg.ouvrirNouvelle();
    m.rg.nouvelle.nom = "Contrats";
    expect(await m.rg.creerNouvelle()).toBe(false);
    expect(m.rg.nouvelle.erreur).toBe("Vous avez déjà une collection de ce nom.");
    expect(m.rg.nouvelle.ouvert).toBe(true);
    const q = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        creer: vi.fn(async () => echec("quota_collections", "x")),
      },
    });
    await q.rg.ouvrir();
    q.rg.ouvrirNouvelle();
    q.rg.nouvelle.nom = "Autre";
    await q.rg.creerNouvelle();
    expect(q.rg.nouvelle.erreur).toBe("Vous avez atteint le nombre maximal de collections.");
  });

  it("RAG indisponible : on n'ouvre pas la boîte", async () => {
    const { rg } = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        etat: vi.fn(async () =>
          ok(etat({ usable: false, reason: { code: "qdrant_injoignable", message: "Qdrant injoignable" } })),
        ),
      },
    });
    await rg.ouvrir();
    rg.ouvrirNouvelle();
    expect(rg.nouvelle.ouvert).toBe(false);
  });

  it("« Importer depuis la sandbox » de la page vide : crée puis ouvre l'import", async () => {
    const { rg, api } = monter({ api: { collections: vi.fn(async () => ok([])) } });
    await rg.ouvrir();
    rg.ouvrirNouvelle([], true);
    rg.nouvelle.nom = "Bac";
    await rg.creerNouvelle();
    await vider();
    expect(api.arbreBac).toHaveBeenCalled();
    expect(rg.bac.ouvert).toBe(true);
  });
});

describe("réglages, vidage, suppression", () => {
  const demarrer = async (o: Options = {}) => {
    const m = monter({ ...o, api: { collections: vi.fn(async () => ok(MES)), ...o.api } });
    await m.rg.ouvrir();
    await vider();
    m.rg.choisirOnglet("reglages");
    return m;
  };

  it("le brouillon part de la collection ; rien n'est enregistrable tant que rien n'a changé", async () => {
    const { rg } = await demarrer();
    expect(rg.reglages.brouillon.name).toBe("Procédures réseau");
    expect(rg.reglages.modifie).toBe(false);
    expect(rg.reglages.enregistrable).toBe(false);
    rg.reglages.brouillon.description = "Exploitation du réseau";
    expect(rg.reglages.enregistrable).toBe(true);
  });

  it("enregistrer n'envoie que la différence, met la collection à jour et avertit le chat", async () => {
    const maj = vi.fn(async () =>
      ok({
        collection: collection(1, { name: "Procédures réseau", description: "Exploitation" }),
        job: null,
      }),
    );
    const { rg, evenements, toasts } = await demarrer({ api: { maj } });
    rg.reglages.brouillon.description = "Exploitation";
    expect(await rg.reglages.enregistrer()).toBe(true);
    expect(maj).toHaveBeenCalledWith(idRag(1), { description: "Exploitation" });
    expect(rg.courante?.description).toBe("Exploitation");
    expect(rg.reglages.modifie).toBe(false);
    expect(evenements.collections).toBe(1);
    expect(toasts.at(-1)?.message).toBe("Réglages enregistrés.");
  });

  it("changer le découpage prévient, puis lance une réindexation, dite à l'utilisateur", async () => {
    const nouveau = decoupage({ methode: "phrase", taille: 256, chevauchement: 32 });
    const maj = vi.fn(async () =>
      ok({
        collection: collection(1, { chunking: nouveau }),
        job: travail(1, idRag(1), { kind: "reindex" }),
      }),
    );
    const { rg, ctx, toasts } = await demarrer({ api: { maj } });
    Object.assign(rg.reglages.brouillon.decoupage, { methode: "phrase", taille: 256, chevauchement: 32 });
    rg.reglages.ajouterRegle();
    rg.reglages.brouillon.regles[0]!.ext = "pdf";
    await rg.reglages.enregistrer();
    expect(ctx.openConfirm).toHaveBeenCalledWith(
      "Réindexer les documents ?",
      expect.stringContaining("seront réindexés"),
      false,
      "Enregistrer et réindexer",
    );
    expect(maj).toHaveBeenCalledWith(idRag(1), {
      chunking: {
        methode: "phrase",
        unite: "jetons",
        taille: 256,
        chevauchement: 32,
        taille_max: 1200,
        par_extension: {
          pdf: { methode: "phrase", unite: "jetons", taille: 256, chevauchement: 32, taille_max: 1200 },
        },
      },
    });
    expect(toasts.at(-1)?.message).toBe("Réglages enregistrés, réindexation lancée.");
  });

  it("découpage : refuser la confirmation n'envoie rien", async () => {
    const maj = vi.fn(async () => echec("requete_invalide"));
    const { rg } = await demarrer({ api: { maj }, confirmation: false });
    rg.reglages.brouillon.decoupage.taille = 300;
    expect(await rg.reglages.enregistrer()).toBe(false);
    expect(maj).not.toHaveBeenCalled();
  });

  it("règles : ajouter une règle part du découpage de base, la retirer la supprime du brouillon", async () => {
    const { rg } = await demarrer();
    const cle = rg.reglages.ajouterRegle();
    expect(rg.reglages.brouillon.regles).toHaveLength(1);
    expect(rg.reglages.brouillon.regles[0]).toMatchObject({ cle, ext: "pdf" });
    expect(rg.reglages.ajouterRegle()).not.toBe(cle);
    expect(rg.reglages.brouillon.regles.map((r) => r.ext)).toEqual(["pdf", "docx"]);
    expect(rg.reglages.enregistrable).toBe(true);
    rg.reglages.retirerRegle(cle);
    rg.reglages.retirerRegle(rg.reglages.brouillon.regles[0]!.cle);
    expect(rg.reglages.brouillon.regles).toEqual([]);
  });

  it("valeurs invalides : pas d'envoi ; nom déjà pris : message en clair", async () => {
    const maj = vi.fn(async () => echec("nom_deja_pris", "x"));
    const { rg } = await demarrer({ api: { maj } });
    rg.reglages.brouillon.name = "";
    expect(rg.reglages.enregistrable).toBe(false);
    expect(await rg.reglages.enregistrer()).toBe(false);
    expect(maj).not.toHaveBeenCalled();
    rg.reglages.brouillon.name = "Contrats";
    expect(await rg.reglages.enregistrer()).toBe(false);
    expect(rg.reglages.erreur).toBe("Vous avez déjà une collection de ce nom.");
  });

  it("annuler rend le brouillon à la collection", async () => {
    const { rg } = await demarrer();
    rg.reglages.brouillon.name = "Autre";
    rg.reglages.annuler();
    expect(rg.reglages.brouillon.name).toBe("Procédures réseau");
  });

  it("vider : confirmation, appel, collection et documents relus", async () => {
    const vider2 = vi.fn(async () => ok({ deleted: 3 }));
    const { rg, ctx, api, toasts } = await demarrer({
      api: { vider: vider2, collection: vi.fn(async () => ok(collection(1, { doc_count: 0 }))) },
    });
    await rg.reglages.vider();
    expect(ctx.openConfirm).toHaveBeenCalled();
    expect(vider2).toHaveBeenCalledWith(idRag(1));
    expect(api.collection).toHaveBeenCalledWith(idRag(1));
    expect(toasts.at(-1)?.message).toBe("3 documents supprimés.");
    expect(rg.courante?.doc_count).toBe(0);
  });

  it("supprimer : le nom est saisi pour confirmer, la collection disparaît, la suivante est sélectionnée, le chat est averti", async () => {
    const supprimer = vi.fn(async () => ok({ ok: true }));
    const { rg, ctx, evenements } = await demarrer({ api: { supprimer } });
    await rg.reglages.supprimer();
    expect(ctx.openTypedConfirm).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "Procédures réseau",
      "Supprimer",
    );
    expect(supprimer).toHaveBeenCalledWith(idRag(1));
    expect(rg.collections.map((c) => c.id)).toEqual([idRag(2)]);
    expect(rg.selection).toBe(idRag(2));
    expect(evenements.collections).toBe(1);
  });

  it("supprimer sans la bonne saisie (confirmation refusée) : rien n'est supprimé", async () => {
    const { rg, api, evenements } = await demarrer({ confirmation: false });
    await rg.reglages.supprimer();
    expect(api.supprimer).not.toHaveBeenCalled();
    expect(rg.collections).toHaveLength(2);
    expect(evenements.collections).toBe(0);
  });

  it("supprimer la dernière : retour à la première visite", async () => {
    const m = monter({ api: { collections: vi.fn(async () => ok([MES[0]!])) } });
    await m.rg.ouvrir();
    await vider();
    await m.rg.reglages.supprimer();
    expect(m.rg.selection).toBeNull();
    expect(m.rg.premiereVisite).toBe(true);
  });

  it("OCR : l'interrupteur dépend de l'extracteur du serveur", async () => {
    const sans = await demarrer({
      api: {
        etat: vi.fn(async () =>
          ok(etat({ extractor: { configured: true, ok: true, ocr: false, soffice: true } })),
        ),
      },
    });
    expect(sans.rg.reglages.ocrDispo).toBe(false);
    const avec = await demarrer();
    expect(avec.rg.reglages.ocrDispo).toBe(true);
  });
});

describe("publication", () => {
  const GROUPES = {
    groups: [
      { id: 1, name: "Réseau", members: 6 },
      { id: 2, name: "Support", members: 11 },
    ],
    can_publish_all: false,
    accounts: 40,
  };
  const demarrer = async (o: Options["api"] = {}) => {
    const m = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        groupesPublication: vi.fn(async () => ok(GROUPES)),
        ...o,
      },
    });
    await m.rg.ouvrir();
    await vider();
    await m.rg.publier.ouvrir();
    return m;
  };

  it("la boîte lit les groupes du compte et part de la publication actuelle", async () => {
    const { rg, api } = await demarrer();
    expect(api.groupesPublication).toHaveBeenCalledTimes(1);
    expect(rg.publier.ouvert).toBe(true);
    expect(rg.publier.choix.visibility).toBe("private");
    expect(rg.publier.groupes.groups.map((g) => g.name)).toEqual(["Réseau", "Support"]);
    expect(rg.publier.peutPublierTous).toBe(false);
    expect(rg.publier.peutConfirmer).toBe(false);
  });

  it("« Tous les comptes » n'est offert que si le serveur le permet (admin)", async () => {
    const { rg } = await demarrer({
      groupesPublication: vi.fn(async () => ok({ ...GROUPES, can_publish_all: true })),
    });
    expect(rg.publier.peutPublierTous).toBe(true);
    rg.publier.choisir("all");
    expect(rg.publier.invalide).toBeNull();
    expect(rg.publier.phrase).toContain("40 comptes");
  });

  it("groupes choisis : nombre de comptes, corps envoyé, collection remplacée, chat averti, boîte fermée", async () => {
    const publier = vi.fn(async () =>
      ok({
        collection: collection(1, {
          name: "Procédures réseau",
          visibility: "groups",
          groups: [
            { id: 1, name: "Réseau", members: 6 },
            { id: 2, name: "Support", members: 11 },
          ],
        }),
        notified: 17,
      }),
    );
    const { rg, evenements, toasts } = await demarrer({ publier });
    rg.publier.choisir("groups");
    expect(rg.publier.invalide).toBe("Choisissez au moins un groupe.");
    rg.publier.basculer(1);
    rg.publier.basculer(2);
    expect(rg.publier.phrase).toBe(
      "Jusqu’à 17 comptes y auront accès. Vous pourrez la dépublier à tout moment.",
    );
    expect(rg.publier.bouton).toBe("Publier");
    expect(await rg.publier.confirmer()).toBe(true);
    expect(publier).toHaveBeenCalledWith(idRag(1), {
      visibility: "groups",
      group_ids: [1, 2],
      allow_source_open: false,
    });
    expect(rg.courante?.visibility).toBe("groups");
    expect(rg.publier.ouvert).toBe(false);
    expect(evenements.collections).toBe(1);
    expect(toasts.at(-1)?.message).toBe("Collection publiée.");
  });

  it("l'ouverture des sources est désactivée par défaut et suit le choix", async () => {
    const publier = vi.fn(async () =>
      ok({
        collection: collection(1, {
          visibility: "groups",
          allow_source_open: true,
          groups: [{ id: 1, name: "Réseau", members: 6 }],
        }),
        notified: 6,
      }),
    );
    const { rg } = await demarrer({ publier });
    expect(rg.publier.choix.allowSourceOpen).toBe(false);
    rg.publier.basculer(1);
    rg.publier.choisir("groups");
    rg.publier.ouvrirSources(true);
    await rg.publier.confirmer();
    expect(publier).toHaveBeenCalledWith(idRag(1), {
      visibility: "groups",
      group_ids: [1],
      allow_source_open: true,
    });
  });

  it("les refus du serveur s'affichent en clair, la boîte reste ouverte", async () => {
    const publier = vi.fn(async () => echec("groupe_non_membre", "Vous n'êtes pas membre"));
    const { rg, evenements } = await demarrer({ publier });
    rg.publier.choisir("groups");
    rg.publier.basculer(1);
    expect(await rg.publier.confirmer()).toBe(false);
    expect(rg.publier.erreur).toBe("Vous ne pouvez publier qu’aux groupes dont vous êtes membre.");
    expect(rg.publier.ouvert).toBe(true);
    expect(evenements.collections).toBe(0);
    publier.mockResolvedValueOnce(echec("tous_reserve_admin", "x"));
    await rg.publier.confirmer();
    expect(rg.publier.erreur).toBe("Seul un administrateur peut publier à tous les comptes.");
  });

  it("rendre privée une collection publiée", async () => {
    const publiee = collection(1, { visibility: "groups", groups: [{ id: 1, name: "Réseau", members: 6 }] });
    const publier = vi.fn(async () => ok({ collection: collection(1), notified: 0 }));
    const m = monter({
      api: {
        collections: vi.fn(async () => ok([publiee, MES[1]!])),
        groupesPublication: vi.fn(async () => ok(GROUPES)),
        publier,
      },
    });
    await m.rg.ouvrir();
    await vider();
    await m.rg.publier.ouvrir();
    expect(m.rg.publier.choix).toMatchObject({ visibility: "groups", groupIds: [1] });
    expect(m.rg.publier.peutConfirmer).toBe(false);
    m.rg.publier.choisir("private");
    expect(m.rg.publier.bouton).toBe("Rendre privée");
    await m.rg.publier.confirmer();
    expect(publier).toHaveBeenCalledWith(idRag(1), {
      visibility: "private",
      group_ids: [],
      allow_source_open: false,
    });
    expect(m.toasts.at(-1)?.message).toBe("Collection rendue privée.");
  });

  it("une panne de la liste des groupes est dite", async () => {
    const m = await demarrer({ groupesPublication: vi.fn(async () => echec(null, "Erreur réseau")) });
    expect(m.rg.publier.erreur).toBe("Erreur réseau");
  });
});

describe("masquage et « Discuter avec »", () => {
  const liste = [
    collection(1, { name: "Mienne" }),
    partagee(3, "Sophie Laurent", { name: "Support" }),
    partagee(4, "Marc", { name: "PSSI" }),
  ];

  it("masquer : la collection quitte la liste, la sélection passe à une des miennes, le chat est averti", async () => {
    const masquer = vi.fn(async (id: string) => ok({ ...liste.find((c) => c.id === id)!, hidden: true }));
    const { rg, evenements } = monter({ api: { collections: vi.fn(async () => ok(liste)), masquer } });
    await rg.ouvrir();
    rg.selectionner(idRag(3));
    await rg.masquer(rg.courante!, true);
    expect(masquer).toHaveBeenCalledWith(idRag(3), true);
    expect(rg.partagees.map((c) => c.name)).toEqual(["PSSI"]);
    expect(rg.masquees.map((c) => c.name)).toEqual(["Support"]);
    expect(rg.selection).toBe(idRag(1));
    expect(evenements.collections).toBe(1);
  });

  it("démasquer : retour dans la liste, chat averti", async () => {
    const cachee = { ...liste[1]!, hidden: true };
    const masquer = vi.fn(async () => ok({ ...cachee, hidden: false }));
    const { rg, evenements } = monter({
      api: { collections: vi.fn(async () => ok([liste[0]!, cachee])), masquer },
    });
    await rg.ouvrir();
    expect(rg.partagees).toEqual([]);
    await rg.masquer(rg.masquees[0]!, false);
    expect(masquer).toHaveBeenCalledWith(idRag(3), false);
    expect(rg.partagees.map((c) => c.name)).toEqual(["Support"]);
    expect(evenements.collections).toBe(1);
  });

  it("un échec de masquage est dit, la liste ne change pas", async () => {
    const { rg, toasts, evenements } = monter({
      api: {
        collections: vi.fn(async () => ok(liste)),
        masquer: vi.fn(async () => echec("non_masquable", "Vous ne pouvez pas masquer votre collection.")),
      },
    });
    await rg.ouvrir();
    await rg.masquer(liste[1]!, true);
    expect(toasts.at(-1)).toEqual({ message: "Vous ne pouvez pas masquer votre collection.", type: "error" });
    expect(rg.partagees).toHaveLength(2);
    expect(evenements.collections).toBe(0);
  });

  it("« Discuter avec » : l'événement du contrat, et rien d'autre", async () => {
    const { rg, evenements, refs, api } = monter({ api: { collections: vi.fn(async () => ok(liste)) } });
    await rg.ouvrir();
    await vider();
    const appels = (Object.values(api) as { mock?: { calls: unknown[] } }[]).reduce(
      (n, f) => n + (f.mock?.calls.length ?? 0),
      0,
    );
    rg.discuter();
    expect(evenements.discuter).toEqual([{ id: idRag(1), name: "Mienne" }]);
    rg.selectionner(idRag(3));
    await vider();
    rg.discuter();
    expect(evenements.discuter.at(-1)).toEqual({ id: idRag(3), name: "Support" });
    expect(refs.currentView.value).toBe("rag");
    expect(evenements.collections).toBe(0);
    expect(
      (Object.values(api) as { mock?: { calls: unknown[] } }[]).reduce(
        (n, f) => n + (f.mock?.calls.length ?? 0),
        0,
      ) - appels,
    ).toBe(1); // le seul appel : les documents de la collection sélectionnée
  });
});

describe("Tester", () => {
  const RESULTAT: RechercheRag = {
    mode: "mixte",
    reranked: false,
    passages: [],
    map: [],
    duration_ms: 400,
    tokens: 1900,
    warnings: [],
    errors: [],
  };

  it("les réglages de départ suivent ceux du chat (mode mixte, 8 passages)", async () => {
    const { rg } = monter({ api: { collections: vi.fn(async () => ok(MES)) } });
    await rg.ouvrir();
    expect(rg.tester.mode).toBe("mixte");
    expect(rg.tester.limite).toBe(8);
    expect(rg.tester.reclasser).toBe(false);
  });

  it("chercher envoie la question nettoyée, le mode, la limite ; le résultat est gardé avec la question affichée", async () => {
    const rechercher = vi.fn(async () => ok(RESULTAT));
    const { rg } = monter({ api: { collections: vi.fn(async () => ok(MES)), rechercher } });
    await rg.ouvrir();
    rg.choisirOnglet("tester");
    rg.tester.requete = "  Comment renouveler le certificat ?  ";
    rg.tester.choisirMode("mots");
    rg.tester.pas(-2);
    await rg.tester.chercher();
    expect(rechercher).toHaveBeenCalledWith(idRag(1), {
      requete: "Comment renouveler le certificat ?",
      mode: "mots",
      limite: 6,
      reclasser: false,
    });
    expect(rg.tester.resultat).toEqual(RESULTAT);
    expect(rg.tester.requeteAffichee).toBe("Comment renouveler le certificat ?");
  });

  it("limite bornée de 1 à 20", async () => {
    const { rg } = monter({ api: { collections: vi.fn(async () => ok(MES)) } });
    await rg.ouvrir();
    rg.tester.pas(-100);
    expect(rg.tester.limite).toBe(1);
    rg.tester.pas(100);
    expect(rg.tester.limite).toBe(20);
  });

  it("le reclassement n'est demandé que si le serveur en a un", async () => {
    const rechercher = vi.fn(async () => ok(RESULTAT));
    const sans = monter({ api: { collections: vi.fn(async () => ok(MES)), rechercher } });
    await sans.rg.ouvrir();
    sans.rg.tester.requete = "q";
    sans.rg.tester.reclasser = true;
    expect(sans.rg.tester.reclassementDispo).toBe(false);
    await sans.rg.tester.chercher();
    expect(rechercher).toHaveBeenLastCalledWith(idRag(1), expect.objectContaining({ reclasser: false }));
    const avec = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        rechercher,
        etat: vi.fn(async () => ok(etat({ reranker: { enabled: true } }))),
      },
    });
    await avec.rg.ouvrir();
    avec.rg.tester.requete = "q";
    avec.rg.tester.reclasser = true;
    await avec.rg.tester.chercher();
    expect(rechercher).toHaveBeenLastCalledWith(idRag(1), expect.objectContaining({ reclasser: true }));
  });

  it("question vide : rien n'est envoyé ; erreur du serveur dite, résultat précédent retiré", async () => {
    const rechercher = vi.fn(async () => ok(RESULTAT));
    const { rg } = monter({ api: { collections: vi.fn(async () => ok(MES)), rechercher } });
    await rg.ouvrir();
    await rg.tester.chercher();
    expect(rechercher).not.toHaveBeenCalled();
    rg.tester.requete = "q";
    await rg.tester.chercher();
    expect(rg.tester.resultat).not.toBeNull();
    rechercher.mockResolvedValueOnce(
      echec("embeddings_indisponibles", "Le serveur d’embeddings ne répond pas."),
    );
    await rg.tester.chercher();
    expect(rg.tester.erreur).toBe("Le serveur d’embeddings ne répond pas.");
    expect(rg.tester.resultat).toBeNull();
  });

  it("le résumé et le nombre d'autres documents suivent la carte", async () => {
    const resultat: RechercheRag = {
      ...RESULTAT,
      map: [
        {
          document_id: idRag(1001),
          document_name: "a.md",
          rel_path: "a.md",
          chunk_count: 10,
          hits: [
            { chunk_index: 1, rank: 1, retained: true },
            { chunk_index: 4, rank: 2, retained: true },
          ],
        },
        {
          document_id: idRag(1002),
          document_name: "b.pdf",
          rel_path: "b.pdf",
          chunk_count: 5,
          hits: [{ chunk_index: 0, rank: 3, retained: false }],
        },
      ],
    };
    const { rg } = monter({
      api: {
        collections: vi.fn(async () => ok([collection(1, { doc_count: 48 })])),
        rechercher: vi.fn(async () => ok(resultat)),
      },
    });
    await rg.ouvrir();
    rg.tester.requete = "q";
    await rg.tester.chercher();
    expect(rg.tester.resume.replace(/\u00a0/g, " ")).toBe("3 passages trouvés dans 2 documents · 0,4 s");
    expect(rg.tester.autresDocuments).toBe(46);
  });

  it("changer de collection efface le résultat ; la réponse tardive de l'ancienne est écartée", async () => {
    let fin: (r: ReturnType<typeof ok<RechercheRag>>) => void = () => undefined;
    const rechercher = vi.fn(() => new Promise<ReturnType<typeof ok<RechercheRag>>>((r) => (fin = r)));
    const { rg } = monter({ api: { collections: vi.fn(async () => ok(MES)), rechercher } });
    await rg.ouvrir();
    rg.tester.requete = "q";
    const attente = rg.tester.chercher();
    rg.selectionner(idRag(2));
    fin(ok(RESULTAT));
    await attente;
    expect(rg.tester.resultat).toBeNull();
    expect(rg.tester.chargement).toBe(false);
  });
});

describe("import depuis la sandbox", () => {
  const ARBRE = {
    root: "/work",
    truncated: false,
    max_entries: 5000,
    items: [
      {
        name: "docs",
        path: "docs",
        type: "folder" as const,
        children: [
          { name: "a.pdf", path: "docs/a.pdf", type: "file" as const, size: 10 },
          { name: "b.md", path: "docs/b.md", type: "file" as const, size: 5 },
        ],
      },
      { name: "notes.txt", path: "notes.txt", type: "file" as const, size: 3 },
    ],
  };

  it("choisir un dossier coche tous ses fichiers acceptés ; le recocher les décoche", async () => {
    const { rg } = monter({
      api: { collections: vi.fn(async () => ok(MES)), arbreBac: vi.fn(async () => ok(ARBRE)) },
    });
    await rg.ouvrir();
    await rg.bac.ouvrir();
    expect(rg.bac.ouvert).toBe(true);
    expect(rg.bac.lignes.map((l) => l.chemin)).toEqual(["docs", "notes.txt"]);
    rg.bac.basculer("docs");
    expect([...rg.bac.selection].sort()).toEqual(["docs/a.pdf", "docs/b.md"]);
    expect(rg.bac.phrase.replace(/\u00a0/g, " ")).toBe("2 fichiers choisis");
    rg.bac.basculer("docs");
    expect(rg.bac.nombre).toBe(0);
    rg.bac.basculer("notes.txt");
    expect([...rg.bac.selection]).toEqual(["notes.txt"]);
  });

  it("importer : chemins envoyés, résultats présentés comme un dépôt, travail suivi, boîte fermée", async () => {
    const importerBac = vi.fn(async () =>
      ok({
        results: [
          { name: "docs/a.pdf", status: "ajoute" as const },
          { name: "notes.txt", status: "refuse" as const, code: "sandbox_fichier", message: "Illisible" },
        ],
        job: travail(1, idRag(1), { total: 1 }),
      }),
    );
    const { rg } = monter({
      api: { collections: vi.fn(async () => ok(MES)), arbreBac: vi.fn(async () => ok(ARBRE)), importerBac },
    });
    await rg.ouvrir();
    await vider();
    await rg.bac.ouvrir();
    rg.bac.basculer("docs/a.pdf");
    rg.bac.basculer("notes.txt");
    expect(await rg.bac.importer()).toBe(true);
    expect(importerBac).toHaveBeenCalledWith(idRag(1), ["docs/a.pdf", "notes.txt"]);
    expect(rg.bac.ouvert).toBe(false);
    expect(rg.documents.depot.visible).toBe(true);
    expect(rg.documents.depot.resultats).toHaveLength(2);
    expect(rg.documents.travail?.total).toBe(1);
  });

  it("par lots de 500 chemins", async () => {
    const fichiers = Array.from({ length: 1100 }, (_, i) => ({
      name: `f${i}.md`,
      path: `d/f${i}.md`,
      type: "file" as const,
    }));
    const importerBac = vi.fn(async (_id: string, paths: string[]) =>
      ok({ results: paths.map((name) => ({ name, status: "ajoute" as const })), job: null }),
    );
    const { rg } = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        arbreBac: vi.fn(async () =>
          ok({ ...ARBRE, items: [{ name: "d", path: "d", type: "folder" as const, children: fichiers }] }),
        ),
        importerBac,
      },
    });
    await rg.ouvrir();
    await vider();
    await rg.bac.ouvrir();
    rg.bac.basculer("d");
    await rg.bac.importer();
    expect(importerBac.mock.calls.map((c) => c[1].length)).toEqual([500, 500, 100]);
    expect(rg.documents.depot.resultats).toHaveLength(1100);
  });

  it("sandbox injoignable : message clair, la boîte reste ouverte", async () => {
    const { rg } = monter({
      api: {
        collections: vi.fn(async () => ok(MES)),
        arbreBac: vi.fn(async () => echec("sandbox_indisponible", "x")),
      },
    });
    await rg.ouvrir();
    await rg.bac.ouvrir();
    expect(rg.bac.erreur).toBe("La sandbox n’est pas accessible pour le moment.");
    expect(rg.bac.ouvert).toBe(true);
  });

  it("l'import qui échoue d'emblée est dit dans la boîte, sans résultat", async () => {
    const importerBac = vi.fn(async () => echec("sandbox_indisponible", "x"));
    const { rg } = monter({
      api: { collections: vi.fn(async () => ok(MES)), arbreBac: vi.fn(async () => ok(ARBRE)), importerBac },
    });
    await rg.ouvrir();
    await vider();
    await rg.bac.ouvrir();
    rg.bac.basculer("notes.txt");
    expect(await rg.bac.importer()).toBe(false);
    expect(rg.bac.erreur).toBe("La sandbox n’est pas accessible pour le moment.");
    expect(rg.bac.ouvert).toBe(true);
  });
});

describe("Échap, menus et boîtes", () => {
  it("un menu ouvert se ferme d'abord ; sans menu, la page peut se fermer", async () => {
    const { rg } = monter({ api: { collections: vi.fn(async () => ok(MES)) } });
    await rg.ouvrir();
    rg.basculerMenu("actions");
    expect(rg.menuOuvert).toBe("actions");
    expect(rg.echapPage()).toBe(true);
    expect(rg.menuOuvert).toBeNull();
    expect(rg.echapPage()).toBe(false);
    rg.basculerMenu("actions");
    rg.basculerMenu("actions");
    expect(rg.menuOuvert).toBeNull();
  });

  it("une boîte ouverte se ferme avant la page, une à la fois", async () => {
    const { rg } = monter({ api: { collections: vi.fn(async () => ok(MES)) } });
    await rg.ouvrir();
    await vider();
    expect(rg.dialogueOuvert).toBe(false);
    await rg.publier.ouvrir();
    expect(rg.dialogueOuvert).toBe(true);
    expect(rg.fermerDialogue()).toBe(true);
    expect(rg.dialogueOuvert).toBe(false);
    expect(rg.fermerDialogue()).toBe(false);
    rg.ouvrirNouvelle();
    expect(rg.dialogueOuvert).toBe(true);
    rg.fermerDialogue();
    expect(rg.nouvelle.ouvert).toBe(false);
  });

  it("changer de collection ferme les menus", async () => {
    const { rg } = monter({ api: { collections: vi.fn(async () => ok(MES)) } });
    await rg.ouvrir();
    rg.basculerMenu("etats");
    rg.selectionner(idRag(2));
    expect(rg.menuOuvert).toBeNull();
  });
});

describe("liberer", () => {
  it("n'écoute plus le flux d'indexation après libération", async () => {
    const { rg, cible } = monter({ api: { collections: vi.fn(async () => ok(MES)) } });
    await rg.ouvrir();
    rg.liberer();
    cible.dispatchEvent(
      new CustomEvent(EVT_TRAVAIL, { detail: { collection_id: idRag(1), job: travail(1, idRag(1)) } }),
    );
    expect(rg.documents.travaux).toEqual([]);
  });
});
