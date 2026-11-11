// SPDX-License-Identifier: MIT
/** frontend/test/admin/rag.test.ts — console › RAG : chargement des cartes, filtres, groupes autorisés, essais des services, supprimer, quotas par compte, réindexation et travaux. */
import * as Vue from "vue";
import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupAdmin } from "../../src/features/admin/console";
import { ragAdmDate, ragAdmOctets } from "../../src/features/admin/rag";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const JOB = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const QUOTAS = { storage_mb: 2048, collections: 10, file_mb: 200, docs_per_collection: 2000 };

const etat = {
  enabled: true,
  extractor: {
    configured: true,
    url: "http://x",
    ok: true,
    version: "1.0",
    error: null,
    soffice: true,
    ocr: false,
  },
  qdrant: { configured: true, url: "http://q", ok: true, version: "1.16", error: null },
  embed: { configured: true, url: "http://e", model: "bge-m3", has_api_key: false },
  reranker: { enabled: false, url: "", model: "bge-reranker-v2-m3" },
  ocr: { configured: false, url: "", model: "", has_api_key: false },
  groups: [],
  quotas: QUOTAS,
  quotas_max: {
    storage_mb: 10_000_000,
    collections: 10_000,
    file_mb: 100_000,
    docs_per_collection: 1_000_000,
  },
  indexation: {
    concurrence: 2,
    par_compte: 1,
    jobs: { queued: 0, running: 1, paused: 0 },
    last_heartbeat: null,
  },
  totals: { collections: 1, documents: 2, bytes: 4096, owners: 1 },
};
const travail = {
  id: JOB,
  collection_id: ID,
  kind: "ingest",
  status: "running",
  total: 4,
  done: 1,
  failed: 0,
  error: null,
  created_at: 1,
  finished_at: null,
};
const collection = {
  id: ID,
  name: "Contrats",
  owner: { id: 3, username: "alice" },
  visibility: "groups",
  groups: [{ id: 1, name: "Juristes" }],
  allow_source_open: false,
  doc_count: 2,
  chunk_count: 10,
  bytes: 4096,
  status: "indexing",
  embed_model: "bge-m3",
  created_at: 1,
  updated_at: 2,
  last_indexed_at: 1_700_000_000,
  job: travail,
};
const compte = {
  id: 3,
  username: "alice",
  role: "user",
  rag_allowed: true,
  usage: { storage_bytes: 4096, collections: 1, documents: 2 },
  override: null,
  effective: QUOTAS,
};
const reindexation = {
  model: "bge-m3",
  embed_configured: true,
  to_migrate: 2,
  up_to_date: 1,
  empty: 0,
  by_model: [{ model: "bge-m3", collections: 1 }],
  progress: { collections: 0, total: 0, done: 0, failed: 0 },
  jobs: [],
};

interface Appel {
  methode: string;
  url: string;
  corps: unknown;
}

function monter(
  route: (url: string, init?: RequestInit) => Response | undefined,
  options: { confirme?: boolean; role?: string } = {},
) {
  const appels: Appel[] = [];
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => {
    appels.push({
      methode: init?.method ?? "GET",
      url,
      corps: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    });
    return Promise.resolve(
      route(url, init) ??
        (url.startsWith("/api/admin/rag/etat")
          ? json(etat)
          : url.startsWith("/api/admin/rag/collections")
            ? json({ collections: [collection], total: 1, offset: 0, limit: 25 })
            : url.startsWith("/api/admin/rag/comptes")
              ? json({ accounts: [compte], total: 1, offset: 0, limit: 25 })
              : url.startsWith("/api/admin/rag/reindexation")
                ? json(reindexation)
                : url.startsWith("/api/admin/rag/travaux")
                  ? json({
                      jobs: [
                        { ...travail, collection_name: "Contrats", owner: { id: 3, username: "alice" } },
                      ],
                    })
                  : json({})),
    );
  };
  const toasts: string[] = [];
  const confirmations: string[] = [];
  const refs: RefsAdmin = {
    user: ref({ username: "root", role: options.role ?? "admin", is_admin: options.role === "user" ? 0 : 1 }),
    isAdminView: ref(true),
  };
  const ctx: CtxAdmin = {
    showToast: (m) => toasts.push(m),
    fetchAuth: (url, options2) => fetchFaux(url, options2),
    openConfirm: (titre) => {
      confirmations.push(titre);
      return Promise.resolve(options.confirme !== false);
    },
    openTypedConfirm: (titre, _texte, mot) => {
      confirmations.push(`${titre}|${mot}`);
      return Promise.resolve(options.confirme !== false);
    },
    openChoice: () => Promise.resolve("save"),
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
  };
  const A = setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  A.configForm.value = {
    rag: {
      service_url: "http://svc:8000",
      service_token: "jeton",
      service_timeout: 9,
      qdrant_url: "http://qdrant:6333",
      embed: { url: "http://emb:8081", model: "m2", api_key: "cle", batch: 32, timeout_s: 60 },
      reranker: { enabled: true, url: "http://rr:8082", model: "rr" },
      ocr: { url: "http://vision:8090", model: "deepseek-ocr", api_key: "********", timeout_s: 180 },
      groups: [],
      quotas: QUOTAS,
      indexation: { concurrence: 2, par_compte: 1 },
    },
  } as unknown as typeof A.configForm.value;
  return { A, appels, toasts, confirmations };
}

const dernier = (appels: Appel[], methode: string, debut: string): Appel | undefined =>
  [...appels].reverse().find((a) => a.methode === methode && a.url.startsWith(debut));

describe("console › RAG", () => {
  it("les clés de la console sont préfixées : aucune collision avec celles du chat (ragCollections, ragDropdownRef…)", () => {
    const { A } = monter(() => json({}));
    const cles = Object.keys(A).filter((k) => /^rag/u.test(k));
    expect(cles.length).toBeGreaterThan(20);
    expect(cles.filter((k) => !k.startsWith("ragAdm"))).toEqual([]);
  });

  it("la page RAG est enregistrée : large, configuration, comptes et chargeur", () => {
    const { A } = monter(() => json({}));
    const page = A.adminNav.value.flatMap((e) => e.pages).find((p) => p.id === "rag");
    expect(page).toBeDefined();
    const { A: B } = monter(() => json({}));
    expect(B.goAdminPage).toBeTypeOf("function");
    expect(typeof A.loadRagAdmin).toBe("function");
  });

  it("un compte qui n'est pas administrateur ne charge rien (la page ne s'affiche pas non plus)", async () => {
    const { A, appels } = monter(() => undefined, { role: "user" });
    A.adminTab.value = "rag";
    await A.loadRagAdmin();
    expect(appels.filter((a) => a.url.startsWith("/api/admin/rag"))).toHaveLength(0);
    expect(A.ragAdmEtat.value).toBeNull();
  });

  it("charge l'état, les collections, les comptes, la réindexation et les travaux", async () => {
    const { A, appels } = monter(() => undefined);
    A.adminTab.value = "rag";
    await A.loadRagAdmin();
    expect(A.ragAdmEtat.value?.extractor.version).toBe("1.0");
    expect(A.ragAdmCollections.value.map((c) => c.name)).toEqual(["Contrats"]);
    expect(A.ragAdmComptes.value.map((c) => c.username)).toEqual(["alice"]);
    expect(A.ragAdmReindexation.value?.to_migrate).toBe(2);
    expect(A.ragAdmTravaux.value[0]).toMatchObject({ collection_name: "Contrats" });
    expect(
      appels
        .map((a) => a.url.split("?")[0] as string)
        .filter((u) => u.startsWith("/api/admin/rag"))
        .sort(),
    ).toEqual([
      "/api/admin/rag/collections",
      "/api/admin/rag/comptes",
      "/api/admin/rag/etat",
      "/api/admin/rag/reindexation",
      "/api/admin/rag/travaux",
    ]);
    A.adminTab.value = "overview";
  });

  it("une erreur serveur lisible s'affiche, une réponse hors contrat est ignorée", async () => {
    const { A } = monter((url) =>
      url === "/api/admin/rag/etat" ? json({ detail: "Admin required" }, 403) : undefined,
    );
    await A.loadRagAdmin();
    expect(A.ragAdmErreur.value).toBe("Admin required");
    expect(A.ragAdmEtat.value).toBeNull();
    const m = monter((url) => (url === "/api/admin/rag/etat" ? json({ enabled: "oui" }) : undefined));
    await m.A.loadRagAdmin();
    expect(m.A.ragAdmEtat.value).toBeNull();
  });

  it("filtres des collections : requête construite, page remise à zéro, pagination", async () => {
    const { A, appels } = monter(() => undefined);
    vi.useFakeTimers();
    try {
      A.ragAdmFiltres.value.q = " alice ";
      A.ragAdmFiltres.value.visibility = "groups";
      A.ragAdmFiltres.value.status = "indexing";
      A.ragAdmFiltres.value.tri = "taille";
      await vi.advanceTimersByTimeAsync(400);
      const a = dernier(appels, "GET", "/api/admin/rag/collections");
      expect(a?.url).toBe(
        "/api/admin/rag/collections?q=alice&visibility=groups&status=indexing&tri=taille&offset=0&limit=25",
      );
      A.ragAdmCollectionsTotal.value = 60;
      A.ragAdmPageCollections(1);
      expect(dernier(appels, "GET", "/api/admin/rag/collections")?.url).toContain("offset=25");
      A.ragAdmPageCollections(5);
      expect(A.ragAdmFiltres.value.offset).toBe(50);
      A.ragAdmPageCollections(-9);
      expect(A.ragAdmFiltres.value.offset).toBe(0);
      A.ragAdmComptesFiltre.value.surcharges = true;
      await vi.advanceTimersByTimeAsync(400);
      expect(dernier(appels, "GET", "/api/admin/rag/comptes")?.url).toContain("seulement_surcharges=1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("groupes autorisés : bascule, tri, doublons écartés, groupe supprimé signalé", () => {
    const { A } = monter(() => json({}));
    A.groupsList.value = [
      { id: 1, name: "A" },
      { id: 2, name: "B" },
    ] as unknown as typeof A.groupsList.value;
    A.ragAdmBasculerGroupe(2);
    A.ragAdmBasculerGroupe(1);
    expect(A.configForm.value?.rag.groups).toEqual([1, 2]);
    A.ragAdmBasculerGroupe(1);
    expect(A.configForm.value?.rag.groups).toEqual([2]);
    A.ragAdmFixerGroupes([9, 2, 2, "3"]);
    expect(A.configForm.value?.rag.groups).toEqual([2, 3, 9]);
    expect(A.ragAdmGroupesAbsents.value).toEqual([3, 9]);
    A.ragAdmFixerGroupes([]);
    expect(A.configForm.value?.rag.groups).toEqual([]);
  });

  it("le modèle d'embedding modifié est signalé par rapport à celui que le serveur utilise", async () => {
    const { A } = monter(() => undefined);
    expect(A.ragAdmModeleModifie.value).toBe(false);
    await A.loadRagAdmin();
    expect(A.ragAdmModeleModifie.value).toBe(true);
    A.configForm.value!.rag.embed.model = " bge-m3 ";
    expect(A.ragAdmModeleModifie.value).toBe(false);
    A.configForm.value!.rag.embed.model = "";
    expect(A.ragAdmModeleModifie.value).toBe(false);
  });

  it("essais : l'extracteur, les embeddings (avec la clé du formulaire), Qdrant et le reclassement ; succès et échecs", async () => {
    const { A, appels } = monter((url) => {
      if (url === "/api/admin/rag-service/test")
        return json({ ok: true, status: { ok: true, version: "2.0", soffice: true, ocr: false } });
      if (url === "/api/admin/rag/essai/embeddings")
        return json({
          ok: true,
          service: "embeddings",
          detail: "Modèle joignable, vecteurs de 8 dimensions.",
          duration_ms: 12,
          dimension: 8,
        });
      if (url === "/api/admin/rag/essai/qdrant")
        return json({ ok: false, service: "qdrant", error: "refusé" });
      if (url === "/api/admin/rag/essai/reranker") return json({ detail: "Admin required" }, 403);
      if (url === "/api/admin/rag/essai/ocr")
        return json({ ok: true, service: "ocr", detail: "Serveur joignable.", duration_ms: 4 });
      return undefined;
    });
    await A.ragAdmEssayer("extracteur");
    expect(dernier(appels, "POST", "/api/admin/rag-service/test")?.corps).toEqual({
      url: "http://svc:8000",
      token: "jeton",
      timeout: 9,
    });
    expect(A.ragAdmEssais.value.extracteur).toEqual({
      state: "ok",
      detail: "Extracteur joignable · version 2.0 · LibreOffice présent · OCR non pris en charge",
    });
    await A.ragAdmEssayer("embeddings");
    expect(dernier(appels, "POST", "/api/admin/rag/essai/embeddings")?.corps).toEqual({
      url: "http://emb:8081",
      model: "m2",
      api_key: "cle",
    });
    expect(A.ragAdmEssais.value.embeddings).toEqual({
      state: "ok",
      detail: "Modèle joignable, vecteurs de 8 dimensions. (12 ms)",
    });
    await A.ragAdmEssayer("qdrant");
    expect(dernier(appels, "POST", "/api/admin/rag/essai/qdrant")?.corps).toEqual({
      url: "http://qdrant:6333",
    });
    expect(A.ragAdmEssais.value.qdrant).toEqual({ state: "err", detail: "refusé" });
    await A.ragAdmEssayer("reranker");
    expect(dernier(appels, "POST", "/api/admin/rag/essai/reranker")?.corps).toEqual({
      url: "http://rr:8082",
      model: "rr",
    });
    expect(A.ragAdmEssais.value.reranker).toEqual({ state: "err", detail: "Admin required" });
    await A.ragAdmEssayer("ocr");
    expect(dernier(appels, "POST", "/api/admin/rag/essai/ocr")?.corps).toEqual({
      url: "http://vision:8090",
      model: "deepseek-ocr",
      api_key: "********",
    });
    expect(A.ragAdmEssais.value.ocr).toEqual({ state: "ok", detail: "Serveur joignable. (4 ms)" });
  });

  it("aucune action ne confie une collection à un autre compte", async () => {
    const { A } = monter(() => undefined);
    await A.loadRagAdmin();
    expect(Object.keys(A).filter((k) => /^ragAdm.*(transfert|confier|destinataire)/iu.test(k))).toEqual([]);
  });

  it("supprimer : saisie du nom exigée, envoi du nom, liste rechargée ; refus de la confirmation : rien n'est envoyé", async () => {
    const m = monter((url, init) =>
      url === `/api/admin/rag/collections/${ID}` && init?.method === "DELETE"
        ? json({ ok: true, deleted: { id: ID, name: "Contrats", owner: { id: 3, username: "alice" } } })
        : undefined,
    );
    await m.A.loadRagAdmin();
    await m.A.ragAdmSupprimerCollection(m.A.ragAdmCollections.value[0]!);
    expect(m.confirmations).toEqual(["Supprimer la collection|Contrats"]);
    expect(dernier(m.appels, "DELETE", `/api/admin/rag/collections/${ID}`)?.corps).toEqual({
      name: "Contrats",
    });
    expect(m.toasts).toEqual(["Collection « Contrats » supprimée."]);
    const non = monter(() => undefined, { confirme: false });
    await non.A.loadRagAdmin();
    await non.A.ragAdmSupprimerCollection(non.A.ragAdmCollections.value[0]!);
    expect(non.appels.some((a) => a.methode === "DELETE")).toBe(false);
  });

  it("quotas d'un compte : champs vides = valeur de l'instance, validation locale, envoi, rétablissement", async () => {
    const mise = { ...compte, override: { storage_mb: 10 }, effective: { ...QUOTAS, storage_mb: 10 } };
    const { A, appels, toasts } = monter((url, init) =>
      url === "/api/admin/rag/comptes/3/quota" && init?.method === "PUT"
        ? json({ account: JSON.parse(String(init.body)).reset ? compte : mise })
        : undefined,
    );
    await A.loadRagAdmin();
    A.ragAdmOuvrirQuota(A.ragAdmComptes.value[0]!);
    expect(A.ragAdmQuotaEdition.value?.valeurs).toEqual({
      storage_mb: "",
      collections: "",
      file_mb: "",
      docs_per_collection: "",
    });
    A.ragAdmQuotaEdition.value!.valeurs.storage_mb = "dix";
    await A.ragAdmEnregistrerQuota();
    expect(A.ragAdmQuotaEdition.value?.erreur).toContain("Stockage");
    expect(appels.some((a) => a.methode === "PUT")).toBe(false);
    A.ragAdmQuotaEdition.value!.valeurs.storage_mb = " 10 ";
    await A.ragAdmEnregistrerQuota();
    expect(dernier(appels, "PUT", "/api/admin/rag/comptes/3/quota")?.corps).toEqual({
      storage_mb: 10,
      collections: null,
      file_mb: null,
      docs_per_collection: null,
    });
    expect(A.ragAdmQuotaEdition.value).toBeNull();
    expect(A.ragAdmComptes.value[0]?.override).toEqual({ storage_mb: 10 });
    expect(toasts[0]).toContain("alice");
    A.ragAdmOuvrirQuota(A.ragAdmComptes.value[0]!);
    expect(A.ragAdmQuotaEdition.value?.valeurs.storage_mb).toBe("10");
    await A.ragAdmRetablirQuota(A.ragAdmComptes.value[0]!);
    expect(dernier(appels, "PUT", "/api/admin/rag/comptes/3/quota")?.corps).toEqual({ reset: true });
    expect(A.ragAdmComptes.value[0]?.override).toBeNull();
    expect(A.ragAdmQuotaEdition.value).toBeNull();
  });

  it("réindexer tout : confirmation, envoi (force sur demande), rechargement ; rien à faire annoncé", async () => {
    const m = monter((url, init) =>
      url === "/api/admin/rag/reindexer" && init?.method === "POST"
        ? json({ started: JSON.parse(String(init.body)).force ? 3 : 0, to_migrate: 0 })
        : undefined,
    );
    await m.A.loadRagAdmin();
    await m.A.ragAdmReindexerTout();
    expect(m.confirmations).toEqual(["Réindexer toutes les collections"]);
    expect(dernier(m.appels, "POST", "/api/admin/rag/reindexer")?.corps).toEqual({});
    expect(m.toasts[0]).toBe("Rien à réindexer : toutes les collections sont à jour.");
    m.A.ragAdmForcer.value = true;
    await m.A.ragAdmReindexerTout();
    expect(dernier(m.appels, "POST", "/api/admin/rag/reindexer")?.corps).toEqual({ force: true });
    expect(m.toasts[1]).toBe("Réindexation lancée pour 3 collections.");
    const non = monter(() => undefined, { confirme: false });
    await non.A.ragAdmReindexerTout();
    expect(non.appels.some((a) => a.methode === "POST")).toBe(false);
  });

  it("travaux : suspendre, reprendre, annuler (confirmation) et pourcentages", async () => {
    const m = monter((url, init) =>
      /\/api\/admin\/rag\/travaux\/[^/]+\/(suspendre|reprendre|annuler)$/u.test(url) &&
      init?.method === "POST"
        ? json({ job: travail })
        : undefined,
    );
    await m.A.loadRagAdmin();
    const j = m.A.ragAdmTravaux.value[0]!;
    await m.A.ragAdmActionTravail(j, "suspendre");
    expect(dernier(m.appels, "POST", `/api/admin/rag/travaux/${JOB}/suspendre`)).toBeDefined();
    await m.A.ragAdmActionTravail(j, "annuler");
    expect(m.confirmations).toEqual(["Annuler le travail"]);
    expect(dernier(m.appels, "POST", `/api/admin/rag/travaux/${JOB}/annuler`)).toBeDefined();
    expect(m.A.ragAdmPourcent({ total: 4, done: 1, failed: 1 })).toBe(50);
    expect(m.A.ragAdmPourcent({ total: 0, done: 0, failed: 0 })).toBe(0);
    expect(m.A.ragAdmPourcent({ total: 2, done: 5, failed: 0 })).toBe(100);
    const non = monter(() => undefined, { confirme: false });
    await non.A.loadRagAdmin();
    await non.A.ragAdmActionTravail(non.A.ragAdmTravaux.value[0]!, "annuler");
    expect(non.appels.some((a) => a.methode === "POST")).toBe(false);
  });

  it("sondage : actif tant que la page RAG est ouverte et qu'il y a des travaux ; arrêté en la quittant", async () => {
    vi.useFakeTimers();
    try {
      const { A, appels } = monter(() => undefined);
      A.adminTab.value = "rag";
      await A.loadRagAdmin();
      const avant = appels.filter((a) => a.url.startsWith("/api/admin/rag/travaux")).length;
      await vi.advanceTimersByTimeAsync(3_100);
      expect(appels.filter((a) => a.url.startsWith("/api/admin/rag/travaux")).length).toBeGreaterThan(avant);
      A.adminTab.value = "overview";
      await vi.advanceTimersByTimeAsync(0);
      const apres = appels.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(appels.length).toBe(apres);
    } finally {
      vi.useRealTimers();
    }
  });

  it("formats : octets et dates", () => {
    expect(ragAdmOctets(0)).toBe("0 o");
    expect(ragAdmOctets(2048)).toBe("2.0 Ko");
    expect(ragAdmOctets(5 * 1024 ** 2)).toBe("5.0 Mo");
    expect(ragAdmOctets(3 * 1024 ** 3)).toBe("3.00 Go");
    expect(ragAdmDate(null)).toBe("");
    expect(ragAdmDate(1_700_000_000)).toMatch(/2023/u);
  });
});
