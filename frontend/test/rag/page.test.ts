// SPDX-License-Identifier: MIT
/** frontend/test/rag/page.test.ts — page RAG montée sur le vrai module : première visite, colonne des collections, détail propriétaire et lecteur, tableau virtualisé, onglets au clavier, Tester, Publier, dépôt par glisser-déposer. */
import { createApp, effectScope, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import type { DocumentRag } from "@elpis/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import PageRag from "../../src/components/rag/PageRag.vue";
import { CLE_RAG } from "../../src/features/rag/domaine";
import type { DomaineRag } from "../../src/features/rag/domaine";
import { creerRag } from "../../src/features/rag/rag";
import type { RechercheRag } from "../../src/features/rag/api";
import {
  collection,
  decoupage,
  document as doc,
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

let app: App | null = null;
let scope: ReturnType<typeof effectScope> | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  scope?.stop();
  scope = null;
  window.document.body.innerHTML = "";
});

interface Options {
  api?: Parameters<typeof fausseApi>[0];
  confirmation?: boolean;
}

async function monter(o: Options = {}) {
  // Une seule page à la fois dans le document : les recherches du test portent sur toute la page.
  app?.unmount();
  scope?.stop();
  window.document.body.innerHTML = "";
  const api = fausseApi(o.api);
  const { ctx } = fauxCtx(o.confirmation ?? true);
  const refs = faussesRefs("chat");
  const cible = new EventTarget();
  scope = effectScope();
  const rg = reactive(scope.run(() => creerRag(api, refs, ctx, { cible, periodeSondageMs: 100_000 }))!);
  api.source = () => rg.collections;
  const hote = window.document.createElement("div");
  window.document.body.appendChild(hote);
  app = createApp({ render: () => h(PageRag) });
  app.provide(CLE_RAG, rg as DomaineRag);
  app.mount(hote);
  await rg.ouvrir();
  await vider();
  await nextTick();
  const q = <T extends HTMLElement = HTMLElement>(s: string): T | null => window.document.querySelector<T>(s);
  const qa = (s: string): HTMLElement[] => [...window.document.querySelectorAll<HTMLElement>(s)];
  const bouton = (texte: string): HTMLButtonElement | undefined =>
    qa("button").find((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim().includes(texte)) as
      HTMLButtonElement | undefined;
  const attendre = async (): Promise<void> => {
    await vider();
    await nextTick();
  };
  return { rg, api, ctx, cible, hote, q, qa, bouton, attendre };
}

const texte = (e: Element | null): string =>
  (e?.textContent ?? "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();

const MES = [
  collection(1, {
    name: "Procédures réseau",
    description: "Exploitation du réseau.",
    doc_count: 3,
    chunk_count: 40,
    bytes: 3 * 1024 * 1024,
  }),
  collection(2, {
    name: "Contrats fournisseurs",
    visibility: "groups",
    groups: [{ id: 1, name: "Réseau", members: 6 }],
    doc_count: 17,
    chunk_count: 402,
  }),
];
const DOCS: DocumentRag[] = [
  doc(1, idRag(1), {
    rel_path: "Constructeur/guide.pdf",
    name: "guide.pdf",
    chunk_count: 412,
    bytes: 18 * 1024 * 1024,
  }),
  doc(2, idRag(1), {
    rel_path: "VPN/procedure.docx",
    name: "procedure.docx",
    ext: "docx",
    chunk_count: 64,
    status: "indexing",
  }),
  doc(3, idRag(1), {
    rel_path: "Opérateurs/scan.pdf",
    name: "scan.pdf",
    status: "error",
    chunk_count: 0,
    error: { code: "no_text", message: "Aucun texte" },
  }),
];
const api = (extra: Options["api"] = {}): Options["api"] => ({
  collections: vi.fn(async () => ok(MES)),
  documents: vi.fn(async () => ok({ documents: DOCS, total: DOCS.length })),
  ...extra,
});

describe("première visite", () => {
  it("aucune collection : la zone de dépôt qui crée la collection, sans bouton « Nouvelle collection » dans l'en-tête", async () => {
    const m = await monter({ api: { collections: vi.fn(async () => ok([])) } });
    expect(m.q("[data-rag-vide]")).not.toBeNull();
    expect(texte(m.q("[data-rag-vide]"))).toContain("Créez votre première collection");
    expect(texte(m.q("[data-rag-vide]"))).toContain("Ou glissez des fichiers ici");
    expect(texte(m.q("header"))).not.toContain("Nouvelle collection");
    expect(texte(m.q(".rag-list"))).toContain("Aucune collection pour l’instant");
  });

  it("« Nouvelle collection » ouvre la boîte, qui crée la collection et affiche son détail", async () => {
    const creer = vi.fn(async (name: string) => ok(collection(7, { name })));
    const m = await monter({ api: { collections: vi.fn(async () => ok([])), creer } });
    m.bouton("Nouvelle collection")!.click();
    await m.attendre();
    const boite = m.q('[data-rag-dialog="nouvelle"]');
    expect(boite?.getAttribute("role")).toBeNull();
    expect(m.q('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    const champ = m.q("#rag-nouv-nom") as HTMLInputElement;
    champ.value = "Notes";
    champ.dispatchEvent(new Event("input"));
    await m.attendre();
    (m.q('[data-rag-dialog="nouvelle"] form') as HTMLFormElement).dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    await m.attendre();
    expect(creer).toHaveBeenCalledWith("Notes", "");
    expect(m.q('[data-rag-dialog="nouvelle"]')).toBeNull();
    expect(texte(m.q(".rag-title"))).toBe("Notes");
  });

  it("des fichiers glissés sur la page vide ouvrent la boîte avec le nom du dossier", async () => {
    const m = await monter({ api: { collections: vi.fn(async () => ok([])) } });
    const f = new File(["x"], "a.md");
    const dt = {
      types: ["Files"],
      items: [],
      files: [Object.assign(f, { webkitRelativePath: "Procédures/a.md" })],
    };
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: dt });
    m.q(".elpis-rag-page")!.dispatchEvent(e);
    await m.attendre();
    expect((m.q("#rag-nouv-nom") as HTMLInputElement).value).toBe("Procédures");
    expect(texte(m.q('[data-rag-dialog="nouvelle"]'))).toContain("1 fichier seront ajoutés");
  });
});

describe("colonne des collections", () => {
  it("mes collections, partagées avec la pastille de l'auteur, quota en pied", async () => {
    const m = await monter({
      api: api({
        collections: vi.fn(async () =>
          ok([...MES, partagee(3, "Sophie Laurent", { name: "Base support", doc_count: 128 })]),
        ),
      }),
    });
    const liste = m.q(".rag-list")!;
    expect(texte(liste)).toContain("Mes collections 2");
    expect(texte(liste)).toContain("Partagées avec moi 1");
    expect(texte(liste)).toContain("Procédures réseau");
    expect(texte(liste)).toContain("3 documents · 40 passages");
    expect(texte(liste)).toContain("Sophie Laurent · 128 documents");
    expect(m.q(".rag-owner")?.textContent).toBe("SL");
    expect(texte(m.q(".rag-list__foot"))).toBe("64 Mo sur 2 Go");
    const choisie = m.qa(".rag-coll[aria-current='true']");
    expect(choisie).toHaveLength(1);
    expect(texte(choisie[0]!)).toContain("Procédures réseau");
  });

  it("indexation en cours : pourcentage et barre dans la ligne", async () => {
    const m = await monter({
      api: api({ travaux: vi.fn(async () => ok([travail(1, idRag(1), { total: 8, done: 3 })])) }),
    });
    const ligne = m.qa(".rag-coll")[0]!;
    expect(texte(ligne)).toContain("Indexation 38 %");
    const barre = ligne.querySelector('[role="progressbar"]')!;
    expect(barre.getAttribute("aria-valuenow")).toBe("38");
  });

  it("choisir une autre collection change le détail", async () => {
    const m = await monter({ api: api() });
    m.qa(".rag-coll")[1]!.click();
    await m.attendre();
    expect(texte(m.q(".rag-title"))).toBe("Contrats fournisseurs");
  });

  it("le filtre réduit les lignes", async () => {
    const m = await monter({ api: api() });
    const champ = m.q('input[aria-label="Filtrer les collections"]') as HTMLInputElement;
    champ.value = "contrats";
    champ.dispatchEvent(new Event("input"));
    await m.attendre();
    expect(m.qa(".rag-coll").map((c) => texte(c))).toEqual([
      expect.stringContaining("Contrats fournisseurs"),
    ]);
  });

  it("masquées : repliées avec leur nombre, dépliées avec « Afficher »", async () => {
    const cachee = partagee(5, "Marc", { name: "Ancienne", hidden: true });
    const masquer = vi.fn(async () => ok({ ...cachee, hidden: false }));
    const m = await monter({ api: api({ collections: vi.fn(async () => ok([...MES, cachee])), masquer }) });
    expect(texte(m.q(".rag-list"))).not.toContain("Ancienne");
    m.bouton("Afficher les masquées")!.click();
    await m.attendre();
    expect(texte(m.q(".rag-list"))).toContain("Ancienne");
    m.bouton("Afficher")!.click();
    await m.attendre();
    expect(masquer).toHaveBeenCalledWith(idRag(5), false);
  });
});

describe("détail d'une collection du compte", () => {
  it("titre, description, chiffres, actions : un seul bouton principal", async () => {
    const m = await monter({ api: api() });
    expect(texte(m.q(".rag-title"))).toBe("Procédures réseau");
    expect(texte(m.q(".rag-desc"))).toBe("Exploitation du réseau.");
    const meta = texte(m.q(".rag-meta"));
    expect(meta).toContain("Privée");
    expect(meta).toContain("3 documents");
    expect(meta).toContain("40 passages");
    expect(meta).toContain("3 Mo");
    expect(meta).toMatch(/Modifiée le /u);
    for (const t of ["Discuter avec", "Publier…", "Ajouter des documents"]) expect(m.bouton(t)).toBeDefined();
    expect(m.q('button[aria-label="Plus d’actions"]')).not.toBeNull();
    const principaux = m.qa(".rag-detail .rag-btn--primary");
    expect(principaux.map((b) => texte(b))).toEqual(["Ajouter des documents"]);
  });

  it("onglets accessibles : tablist, sélection, navigation aux flèches", async () => {
    const m = await monter({ api: api() });
    const onglets = m.qa('[role="tab"]');
    expect(onglets.map((o) => texte(o))).toEqual(["Documents 3", "Tester", "Réglages"]);
    expect(onglets.map((o) => o.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(onglets.map((o) => o.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(m.q('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe("rag-tab-documents");
    onglets[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await m.attendre();
    expect(m.rg.onglet).toBe("tester");
    expect(m.q('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe("rag-tab-tester");
    m.q('[role="tablist"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await m.attendre();
    expect(m.rg.onglet).toBe("reglages");
  });

  it("le bouton « Ajouter des documents » n'est plus principal hors de l'onglet Documents", async () => {
    const m = await monter({ api: api() });
    m.bouton("Tester")!.click();
    await m.attendre();
    expect(m.qa(".rag-detail .rag-head .rag-btn--primary")).toEqual([]);
  });

  it("RAG indisponible : avis, création et ajout désactivés, collections consultables", async () => {
    const m = await monter({
      api: api({
        etat: vi.fn(async () =>
          ok(
            etat({ usable: false, reason: { code: "qdrant_injoignable", message: "Qdrant ne répond pas." } }),
          ),
        ),
      }),
    });
    expect(texte(m.q("[data-rag-avis]"))).toContain("Qdrant ne répond pas.");
    expect(m.bouton("Nouvelle collection")!.disabled).toBe(true);
    expect(m.bouton("Ajouter des documents")!.disabled).toBe(true);
    expect(texte(m.q(".rag-title"))).toBe("Procédures réseau");
  });
});

describe("tableau des documents", () => {
  it("nom et dossier, bande de passages, taille, date, état en clair, erreurs signalées", async () => {
    const m = await monter({ api: api() });
    const lignes = m.qa("[data-rag-doc]");
    expect(lignes).toHaveLength(3);
    const t = lignes.map((l) => texte(l));
    const ligne = (nom: string): HTMLElement => lignes.find((l) => texte(l).startsWith(nom))!;
    expect(texte(ligne("guide.pdf"))).toContain("guide.pdf Constructeur/");
    expect(texte(ligne("guide.pdf"))).toContain("412");
    expect(texte(ligne("guide.pdf"))).toContain("18 Mo");
    expect(texte(ligne("guide.pdf"))).toContain("Prête");
    expect(texte(ligne("procedure.docx"))).toContain("Indexation…");
    expect(texte(ligne("scan.pdf"))).toContain("Sans texte : activez l’OCR");
    expect(t).toHaveLength(3);
    expect(ligne("guide.pdf").querySelectorAll(".rag-strip i")).toHaveLength(24);
    expect(ligne("procedure.docx").querySelector(".rag-strip")?.classList.contains("is-busy")).toBe(true);
    expect(ligne("scan.pdf").querySelector(".rag-strip")).toBeNull();
  });

  it("actions de ligne du propriétaire : réindexer, ouvrir, retirer, avec noms accessibles", async () => {
    const m = await monter({ api: api() });
    const l = m.qa("[data-rag-doc]")[0]!;
    expect(l.querySelector('button[aria-label="Réindexer guide.pdf"]')).not.toBeNull();
    expect(l.querySelector('button[aria-label="Retirer guide.pdf"]')).not.toBeNull();
    const lien = l.querySelector('a[aria-label="Ouvrir l’original de guide.pdf"]')!;
    expect(lien.getAttribute("href")).toBe(
      `/api/rag/collections/${idRag(1)}/documents/${DOCS[0]!.id}/original`,
    );
  });

  it("filtre par texte et par état", async () => {
    const m = await monter({ api: api() });
    const champ = m.q('input[aria-label="Filtrer les documents"]') as HTMLInputElement;
    champ.value = "vpn";
    champ.dispatchEvent(new Event("input"));
    await m.attendre();
    expect(m.qa("[data-rag-doc]")).toHaveLength(1);
    champ.value = "";
    champ.dispatchEvent(new Event("input"));
    m.bouton("Tous les états")!.click();
    await m.attendre();
    const choix = m.qa('[role="menuitemradio"]');
    expect(choix.map((c) => texte(c))).toEqual([
      "Tous les états",
      "Prêts",
      "En cours",
      "En attente",
      "En échec",
    ]);
    expect(choix[0]!.getAttribute("aria-checked")).toBe("true");
    choix[4]!.click();
    await m.attendre();
    expect(m.qa("[data-rag-doc]").map((l) => texte(l))).toEqual([expect.stringContaining("scan.pdf")]);
    expect(texte(m.q(".rag-tools"))).toContain("En échec");
  });

  it("collection vide : message d'invite ; filtre sans résultat : message adapté", async () => {
    const m = await monter({ api: api({ documents: vi.fn(async () => ok({ documents: [], total: 0 })) }) });
    expect(texte(m.q(".rag-empty-docs"))).toContain("Cette collection est vide");
    const champ = m.q('input[aria-label="Filtrer les documents"]') as HTMLInputElement;
    champ.value = "zzz";
    champ.dispatchEvent(new Event("input"));
    await m.attendre();
    expect(texte(m.q(".rag-empty-docs"))).toContain("Aucun document ne correspond");
  });

  it("au-delà de 500 lignes, seule la fenêtre visible est dessinée, avec des espaceurs", async () => {
    const beaucoup = Array.from({ length: 1200 }, (_, i) =>
      doc(i, idRag(1), {
        rel_path: `d/f${String(i).padStart(4, "0")}.md`,
        name: `f${String(i).padStart(4, "0")}.md`,
        ext: "md",
      }),
    );
    const m = await monter({
      api: api({
        documents: vi.fn(async (_id: string, offset: number) =>
          ok({ documents: beaucoup.slice(offset, offset + 500), total: 1200 }),
        ),
      }),
    });
    expect(m.rg.documents.virtualise).toBe(true);
    const lignes = m.qa("[data-rag-doc]");
    expect(lignes.length).toBeGreaterThan(5);
    expect(lignes.length).toBeLessThan(60);
    expect(m.q(".rag-table")?.getAttribute("aria-rowcount")).toBe("1201");
    expect(texte(lignes[0]!)).toContain("f0000.md");
    expect(m.q("tr.rag-spacer")).not.toBeNull();
    expect(lignes[0]!.getAttribute("aria-rowindex")).toBe("2");
  });

  it("bandeau d'indexation : texte, progression, Suspendre et Annuler ; Reprendre en pause", async () => {
    const agirTravail = vi.fn(async () => ok(travail(1, idRag(1), { status: "paused", total: 9, done: 3 })));
    const m = await monter({
      api: api({
        travaux: vi.fn(async () => ok([travail(1, idRag(1), { total: 9, done: 3 })])),
        agirTravail,
      }),
    });
    const b = m.q("[data-rag-bandeau]")!;
    expect(texte(b)).toContain("Indexation de 9 documents ajoutés");
    expect(texte(b)).toContain("3 terminés");
    expect(b.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("33");
    expect(["Suspendre", "Annuler"].every((t) => m.bouton(t) !== undefined)).toBe(true);
    m.bouton("Suspendre")!.click();
    await m.attendre();
    expect(texte(m.q("[data-rag-bandeau]"))).toContain("Indexation suspendue");
    expect(m.bouton("Reprendre")).toBeDefined();
    expect(m.bouton("Suspendre")).toBeUndefined();
  });

  it("zone de dépôt : texte de la maquette et plafond du serveur", async () => {
    const m = await monter({ api: api() });
    const z = texte(m.q("[data-rag-zone-depot]"));
    expect(z).toContain("Glissez des fichiers ou un dossier ici, ou parcourez");
    expect(z).toContain("PDF, Word, Excel, PowerPoint, Markdown, HTML, texte · 200 Mo par fichier");
  });

  it("fichiers glissés sur la page : envoyés à la collection affichée, résultats par fichier présentés", async () => {
    const deposer = vi.fn(async (_id: string, corps: FormData) =>
      ok({
        results: (corps.getAll("files") as File[]).map((x) => ({ name: x.name, status: "ajoute" as const })),
        job: null,
      }),
    );
    const m = await monter({ api: api({ deposer }) });
    const f = new File(["x"], "nouveau.md");
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], items: [], files: [f] } });
    m.q(".elpis-rag-page")!.dispatchEvent(e);
    await m.attendre();
    expect(deposer).toHaveBeenCalledTimes(1);
    expect(texte(m.q("[data-rag-resultats]"))).toContain("1 ajouté");
    expect(texte(m.q("[data-rag-resultats]"))).toContain("nouveau.md");
    expect(e.defaultPrevented).toBe(true);
  });

  it("un fichier déposé hors de l'onglet Documents est expliqué au lieu d'être ignoré", async () => {
    const deposer = vi.fn(async () => ok({ results: [], job: null }));
    const m = await monter({ api: api({ deposer }) });
    m.rg.choisirOnglet("reglages");
    await m.attendre();
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", {
      value: { types: ["Files"], items: [], files: [new File(["x"], "a.md")] },
    });
    m.q(".elpis-rag-page")!.dispatchEvent(e);
    await m.attendre();
    expect(deposer).not.toHaveBeenCalled();
    expect(m.ctx.showToast).toHaveBeenCalledWith("Déposez les fichiers dans l’onglet Documents.", "info");
  });

  it("un refus local (extension) est présenté avec son message, jamais envoyé", async () => {
    const deposer = vi.fn(async () => ok({ results: [], job: null }));
    const m = await monter({ api: api({ deposer }) });
    const f = new File(["x"], "virus.exe");
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], items: [], files: [f] } });
    m.q(".elpis-rag-page")!.dispatchEvent(e);
    await m.attendre();
    expect(deposer).not.toHaveBeenCalled();
    expect(texte(m.q("[data-rag-resultats]"))).toContain("virus.exe");
    expect(texte(m.q("[data-rag-resultats]"))).toContain("Refusé : Format .exe non pris en charge");
  });
});

describe("collection publiée par un autre compte", () => {
  const demarrer = async (extra: Options["api"] = {}) => {
    const m = await monter({
      api: api({
        collections: vi.fn(async () =>
          ok([
            ...MES,
            partagee(3, "Sophie Laurent", {
              name: "Base support",
              description: "Réponses validées.",
              doc_count: 128,
              chunk_count: 4210,
            }),
          ]),
        ),
        ...extra,
      }),
    });
    m.qa(".rag-coll")
      .find((c) => texte(c).includes("Base support"))!
      .click();
    await m.attendre();
    return m;
  };

  it("lecture seule : seuls « Discuter avec » et « Masquer de ma liste », rien pour modifier", async () => {
    const m = await demarrer();
    expect(texte(m.q(".rag-title"))).toBe("Base support");
    expect(texte(m.q(".rag-meta"))).toContain("Partagée par Sophie Laurent");
    expect(texte(m.q(".rag-meta"))).toContain("Lecture seule");
    expect(texte(m.q(".rag-meta"))).toContain("Mise à jour");
    const actions = m.qa(".rag-head .rag-actions .rag-btn").map((b) => texte(b));
    expect(actions).toEqual(["Masquer de ma liste", "Discuter avec"]);
    expect(m.qa(".rag-detail .rag-btn--primary").map((b) => texte(b))).toEqual(["Discuter avec"]);
    expect(m.bouton("Publier")).toBeUndefined();
    expect(m.bouton("Ajouter des documents")).toBeUndefined();
    expect(m.bouton("Importer depuis la sandbox")).toBeUndefined();
    expect(m.q('button[aria-label="Plus d’actions"]')).toBeNull();
  });

  it("onglets Documents et Tester seulement", async () => {
    const m = await demarrer();
    expect(m.qa('[role="tab"]').map((o) => texte(o))).toEqual(["Documents 128", "Tester"]);
  });

  it("ni zone de dépôt, ni réindexation, ni retrait ; l'original seulement si le propriétaire l'a permis", async () => {
    const m = await demarrer();
    expect(m.q("[data-rag-zone-depot]")).toBeNull();
    const l = m.qa("[data-rag-doc]")[0]!;
    expect(l.querySelector('button[aria-label^="Réindexer"]')).toBeNull();
    expect(l.querySelector('button[aria-label^="Retirer"]')).toBeNull();
    expect(l.querySelector('a[aria-label^="Ouvrir"]')).toBeNull();
    const ouvert = await monter({
      api: api({ collections: vi.fn(async () => ok([partagee(3, "Sophie", { allow_source_open: true })])) }),
    });
    ouvert.qa(".rag-coll")[0]!.click();
    await ouvert.attendre();
    const l2 = ouvert.qa("[data-rag-doc]")[0]!;
    expect(l2.querySelector('a[aria-label^="Ouvrir"]')).not.toBeNull();
    expect(l2.querySelector('button[aria-label^="Retirer"]')).toBeNull();
  });

  it("des fichiers glissés sur la page d'un lecteur ne partent nulle part", async () => {
    const deposer = vi.fn(async () => ok({ results: [], job: null }));
    const m = await demarrer({ deposer });
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", {
      value: { types: ["Files"], items: [], files: [new File(["x"], "a.md")] },
    });
    m.q(".elpis-rag-page")!.dispatchEvent(e);
    await m.attendre();
    expect(deposer).not.toHaveBeenCalled();
  });

  it("« Masquer de ma liste » et « Discuter avec » agissent", async () => {
    const masquer = vi.fn(async () =>
      ok({ ...partagee(3, "Sophie Laurent", { name: "Base support" }), hidden: true }),
    );
    const m = await demarrer({ masquer });
    const recu: unknown[] = [];
    m.cible.addEventListener("rag:discuter", (e) => recu.push((e as CustomEvent).detail));
    m.bouton("Discuter avec")!.click();
    expect(recu).toEqual([{ id: idRag(3), name: "Base support" }]);
    m.bouton("Masquer de ma liste")!.click();
    await m.attendre();
    expect(masquer).toHaveBeenCalledWith(idRag(3), true);
    expect(texte(m.q(".rag-title"))).toBe("Procédures réseau");
  });
});

describe("onglet Tester", () => {
  const RES: RechercheRag = {
    mode: "mixte",
    reranked: false,
    duration_ms: 400,
    tokens: 1934,
    warnings: [],
    errors: [],
    passages: [
      {
        collection_id: idRag(1),
        collection_name: "Procédures réseau",
        owner: { id: 1, username: "alice", display_name: "alice" },
        document_id: idRag(1001),
        document_name: "certificats.md",
        rel_path: "PKI/certificats.md",
        chunk_index: 3,
        page: null,
        heading_path: "Tunnels IPsec",
        text: "Le certificat du tunnel IPsec expire tous les 12 mois.",
        score: 0.8,
        boxes: [],
        rank: 1,
        relevance: 0.86,
      },
      {
        collection_id: idRag(1),
        collection_name: "Procédures réseau",
        owner: { id: 1, username: "alice", display_name: "alice" },
        document_id: idRag(1002),
        document_name: "procedure.docx",
        rel_path: "VPN/procedure.docx",
        chunk_index: 13,
        page: 7,
        heading_path: "3.2 Renouvellement",
        text: "Avant tout renouvellement, vérifiez le profil.",
        score: 0.7,
        boxes: [],
        rank: 2,
        relevance: 0.79,
      },
    ],
    map: [
      {
        document_id: idRag(1001),
        document_name: "certificats.md",
        rel_path: "PKI/certificats.md",
        chunk_count: 18,
        hits: [
          { chunk_index: 3, rank: 1, retained: true },
          { chunk_index: 6, rank: 3, retained: false },
        ],
      },
      {
        document_id: idRag(1002),
        document_name: "procedure.docx",
        rel_path: "VPN/procedure.docx",
        chunk_count: 32,
        hits: [{ chunk_index: 13, rank: 2, retained: true }],
      },
    ],
  };

  it("question, résultat : carte, passages numérotés, mots surlignés, estimation en jetons", async () => {
    const rechercher = vi.fn(async () => ok(RES));
    const m = await monter({ api: api({ rechercher }) });
    m.bouton("Tester")!.click();
    await m.attendre();
    const champ = m.q('input[aria-label="Question à poser à la collection"]') as HTMLInputElement;
    champ.value = "Comment renouveler le certificat IPsec ?";
    champ.dispatchEvent(new Event("input"));
    await m.attendre();
    (m.q(".rag-ask") as HTMLFormElement).dispatchEvent(new Event("submit", { cancelable: true }));
    await m.attendre();
    expect(rechercher).toHaveBeenCalledWith(idRag(1), {
      requete: "Comment renouveler le certificat IPsec ?",
      mode: "mixte",
      limite: 8,
      reclasser: false,
    });
    expect(texte(m.q(".rag-sub"))).toContain("Où se trouvent les passages");
    expect(texte(m.qa(".rag-sub")[0]!)).toContain("3 passages trouvés dans 2 documents · 0,4 s");
    expect(texte(m.qa(".rag-sub")[1]!)).toContain("les 2 meilleurs · environ 1 900 jetons");
    const bandes = m.qa(".rag-map .rag-strip--big");
    expect(bandes).toHaveLength(2);
    expect(bandes[0]!.querySelectorAll("i")).toHaveLength(18);
    expect(
      [...bandes[0]!.querySelectorAll("i[data-r]")].map((i) => [i.getAttribute("data-r"), i.className]),
    ).toEqual([["1", "is-hit"]]);
    expect(bandes[0]!.querySelectorAll("i.is-out")).toHaveLength(1);
    expect(texte(m.q(".rag-map__more"))).toContain("1 autre document sans passage retenu");
    const passages = m.qa("[data-rag-passage]");
    expect(passages.map((p) => texte(p.querySelector(".rag-hit__rank")))).toEqual(["1", "2"]);
    expect(
      [...passages[0]!.querySelectorAll(".rag-hit__src > *")].map((x) => texte(x)).filter((x) => x !== ""),
    ).toEqual(["certificats.md", "§ Tunnels IPsec", "0,86"]);
    expect(
      [...passages[1]!.querySelectorAll(".rag-hit__src > *")].map((x) => texte(x)).filter((x) => x !== ""),
    ).toEqual(["procedure.docx", "page 7 · 3.2 Renouvellement", "0,79"]);
    expect([...passages[0]!.querySelectorAll("mark")].map((x) => x.textContent)).toEqual([
      "certificat",
      "IPsec",
    ]);
    expect([...passages[1]!.querySelectorAll("mark")].map((x) => x.textContent)).toEqual(["renouvellement"]);
  });

  it("mode, nombre de passages et reclassement se règlent ; le reclassement est désactivé sans modèle", async () => {
    const m = await monter({ api: api({ rechercher: vi.fn(async () => ok(RES)) }) });
    m.bouton("Tester")!.click();
    await m.attendre();
    const modes = m.qa('[role="radio"]');
    expect(modes.map((x) => texte(x))).toEqual(["Mixte", "Par le sens", "Mots exacts"]);
    expect(modes[0]!.getAttribute("aria-checked")).toBe("true");
    modes[2]!.click();
    await m.attendre();
    expect(m.rg.tester.mode).toBe("mots");
    expect(m.qa('[role="radio"]')[2]!.getAttribute("aria-checked")).toBe("true");
    m.q('button[aria-label="Moins de passages"]')!.click();
    m.q('button[aria-label="Moins de passages"]')!.click();
    await m.attendre();
    expect(m.rg.tester.limite).toBe(6);
    const interrupteur = m.q('[role="switch"]') as HTMLButtonElement;
    expect(interrupteur.disabled).toBe(true);
    expect(interrupteur.getAttribute("aria-checked")).toBe("false");
  });

  it("erreur du serveur : message d'alerte, pas de résultat", async () => {
    const m = await monter({
      api: api({
        rechercher: vi.fn(async () =>
          echec("embeddings_indisponibles", "Le serveur d’embeddings ne répond pas."),
        ),
      }),
    });
    m.bouton("Tester")!.click();
    await m.attendre();
    const champ = m.q('input[aria-label="Question à poser à la collection"]') as HTMLInputElement;
    champ.value = "question";
    champ.dispatchEvent(new Event("input"));
    await m.attendre();
    (m.q(".rag-ask") as HTMLFormElement).dispatchEvent(new Event("submit", { cancelable: true }));
    await m.attendre();
    expect(m.q('[role="alert"]')?.textContent).toContain("Le serveur d’embeddings ne répond pas.");
    expect(m.q("[data-rag-carte]")).toBeNull();
  });
});

describe("boîte Publier", () => {
  const GROUPES = {
    groups: [
      { id: 1, name: "Réseau", members: 6 },
      { id: 2, name: "Support", members: 11 },
    ],
    can_publish_all: false,
    accounts: 40,
  };

  it("Privée, Groupes avec effectifs, interrupteur des sources éteint, nombre de comptes ; « Tous les comptes » absent pour un utilisateur", async () => {
    const m = await monter({ api: api({ groupesPublication: vi.fn(async () => ok(GROUPES)) }) });
    m.bouton("Publier…")!.click();
    await m.attendre();
    const d = m.q('[role="dialog"]')!;
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(texte(d.querySelector("h3"))).toBe("Publier « Procédures réseau »");
    expect(m.q('[data-rag-dialog="publier"]')?.hasAttribute("data-a11y-modal")).toBe(true);
    const radios = [...d.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.id)).toEqual(["rag-vis-private", "rag-vis-groups"]);
    expect(radios[0]!.checked).toBe(true);
    expect(texte(d)).not.toContain("Tous les comptes");
    const chips = [...d.querySelectorAll<HTMLButtonElement>(".rag-chip")];
    expect(chips.map((c) => texte(c))).toEqual(["Réseau 6", "Support 11"]);
    expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual(["false", "false"]);
    expect(d.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(texte(d.querySelector("[data-rag-comptes]"))).toBe("Seul votre compte y a accès.");
    expect((m.q('[data-rag-dialog="publier"] .rag-btn--primary') as HTMLButtonElement).disabled).toBe(true);
  });

  it("Groupes sans aucun groupe choisi : le motif est un rappel discret, pas une alerte", async () => {
    const m = await monter({ api: api({ groupesPublication: vi.fn(async () => ok(GROUPES)) }) });
    m.bouton("Publier…")!.click();
    await m.attendre();
    const radio = m.q<HTMLInputElement>("#rag-vis-groups")!;
    radio.checked = true;
    radio.dispatchEvent(new Event("change"));
    await m.attendre();
    expect(texte(m.q("[data-rag-comptes]"))).toBe("Choisissez au moins un groupe.");
    expect(m.q('[data-rag-dialog="publier"] [role="alert"]')).toBeNull();
    expect((m.q('[data-rag-dialog="publier"] .rag-btn--primary') as HTMLButtonElement).disabled).toBe(true);
  });

  it("choisir des groupes : phrase mise à jour, bouton actif, envoi, fermeture", async () => {
    const publier = vi.fn(async () =>
      ok({
        collection: collection(1, {
          visibility: "groups",
          groups: [
            { id: 1, name: "Réseau", members: 6 },
            { id: 2, name: "Support", members: 11 },
          ],
        }),
        notified: 17,
      }),
    );
    const m = await monter({ api: api({ groupesPublication: vi.fn(async () => ok(GROUPES)), publier }) });
    m.bouton("Publier…")!.click();
    await m.attendre();
    const chips = m.qa(".rag-chip");
    chips[0]!.click();
    chips[1]!.click();
    await m.attendre();
    expect(m.q<HTMLInputElement>("#rag-vis-groups")!.checked).toBe(true);
    expect(texte(m.q("[data-rag-comptes]"))).toBe(
      "Jusqu’à 17 comptes y auront accès. Vous pourrez la dépublier à tout moment.",
    );
    expect(m.qa(".rag-chip").map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "true"]);
    const confirmer = m.qa('[data-rag-dialog="publier"] .rag-btn--primary')[0] as HTMLButtonElement;
    expect(confirmer.disabled).toBe(false);
    confirmer.click();
    await m.attendre();
    expect(publier).toHaveBeenCalledWith(idRag(1), {
      visibility: "groups",
      group_ids: [1, 2],
      allow_source_open: false,
    });
    expect(m.q('[data-rag-dialog="publier"]')).toBeNull();
    expect(texte(m.q(".rag-meta"))).toContain("2 groupes");
  });

  it("administrateur : « Tous les comptes » proposé", async () => {
    const m = await monter({
      api: api({ groupesPublication: vi.fn(async () => ok({ ...GROUPES, can_publish_all: true })) }),
    });
    m.bouton("Publier…")!.click();
    await m.attendre();
    expect(texte(m.q('[role="dialog"]'))).toContain("Tous les comptes");
    expect(m.q("#rag-vis-all")).not.toBeNull();
  });

  it("refus du serveur : phrase claire dans la boîte, restée ouverte", async () => {
    const m = await monter({
      api: api({
        groupesPublication: vi.fn(async () => ok(GROUPES)),
        publier: vi.fn(async () => echec("groupe_non_membre", "x")),
      }),
    });
    m.bouton("Publier…")!.click();
    await m.attendre();
    m.qa(".rag-chip")[0]!.click();
    await m.attendre();
    (m.qa('[data-rag-dialog="publier"] .rag-btn--primary')[0] as HTMLButtonElement).click();
    await m.attendre();
    expect(m.q('[data-rag-dialog="publier"] [role="alert"]')?.textContent).toContain(
      "Vous ne pouvez publier qu’aux groupes dont vous êtes membre.",
    );
    expect(m.q('[data-rag-dialog="publier"]')).not.toBeNull();
  });

  it("aucun groupe : le dit", async () => {
    const m = await monter({
      api: api({
        groupesPublication: vi.fn(async () => ok({ groups: [], can_publish_all: false, accounts: 40 })),
      }),
    });
    m.bouton("Publier…")!.click();
    await m.attendre();
    expect(texte(m.q('[role="dialog"]'))).toContain("Vous n’êtes membre d’aucun groupe.");
  });
});

describe("onglet Réglages et menu « … »", () => {
  it("zone de danger : vider et supprimer demandent confirmation avec le nom", async () => {
    const m = await monter({ api: api() });
    m.bouton("Réglages")!.click();
    await m.attendre();
    expect((m.q("#rag-reg-nom") as HTMLInputElement).value).toBe("Procédures réseau");
    expect(texte(m.q("small#rag-reg-desc-aide"))).toContain("L’assistant la lit pour savoir quand chercher");
    m.bouton("Supprimer…")!.click();
    await m.attendre();
    expect(m.ctx.openTypedConfirm).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "Procédures réseau",
      "Supprimer",
    );
  });

  it("découpage : Automatique par défaut ; enregistrer n'est actif qu'après un changement valide, envoie le découpage entier", async () => {
    const maj = vi.fn(async () =>
      ok({
        collection: collection(1, {
          name: "Procédures réseau",
          chunking: decoupage({ methode: "separateur", valeur: "\\n\\n", taille: 300 }),
        }),
        job: travail(1, idRag(1), { kind: "reindex" }),
      }),
    );
    const m = await monter({ api: api({ maj }) });
    m.bouton("Réglages")!.click();
    await m.attendre();
    const enregistrer = m.bouton("Enregistrer") as HTMLButtonElement;
    expect(enregistrer.disabled).toBe(true);
    const methode = m.q("#rag-reg-dec-methode") as HTMLSelectElement;
    expect(methode.value).toBe("auto");
    expect(m.q("#rag-reg-dec-valeur")).toBeNull();
    methode.value = "separateur";
    methode.dispatchEvent(new Event("change"));
    await m.attendre();
    // Séparateur vide : refusé tant qu'il n'est pas renseigné.
    expect((m.bouton("Enregistrer") as HTMLButtonElement).disabled).toBe(true);
    expect(texte(m.q("#rag-reg-dec-valeur-err"))).toBe("Indiquez le séparateur.");
    expect(m.q("#rag-reg-dec-chevauchement")).toBeNull();
    const exemple = m.qa(".rag-exemples .rag-chip")[0]!;
    exemple.click();
    await m.attendre();
    expect((m.q("#rag-reg-dec-valeur") as HTMLInputElement).value).toBe("\\n\\n");
    const taille = m.q("#rag-reg-dec-taille") as HTMLInputElement;
    taille.value = "300";
    taille.dispatchEvent(new Event("input"));
    await m.attendre();
    expect((m.bouton("Enregistrer") as HTMLButtonElement).disabled).toBe(false);
    (m.q(".rag-form") as HTMLFormElement).dispatchEvent(new Event("submit", { cancelable: true }));
    await m.attendre();
    expect(maj).toHaveBeenCalledWith(idRag(1), {
      chunking: {
        methode: "separateur",
        valeur: "\\n\\n",
        unite: "jetons",
        taille: 300,
        chevauchement: 64,
        taille_max: 1200,
        par_extension: {},
      },
    });
  });

  it("règles par type de fichier : ajouter une ligne, saisir l'extension, la retirer", async () => {
    const m = await monter({ api: api() });
    m.bouton("Réglages")!.click();
    await m.attendre();
    expect(m.qa("[data-rag-regle]")).toHaveLength(0);
    m.bouton("Ajouter une règle")!.click();
    await m.attendre();
    expect(m.qa("[data-rag-regle]")).toHaveLength(1);
    const ext = m.q("[data-rag-regle] select") as HTMLSelectElement;
    expect(window.document.activeElement).toBe(ext);
    expect(ext.value).toBe("pdf");
    expect([...ext.options].map((o) => o.value)).toContain("yml");
    expect(texte(m.q("[data-rag-regle] .rag-err"))).toBe("");
    expect((m.bouton("Enregistrer") as HTMLButtonElement).disabled).toBe(false);
    m.bouton("Ajouter une règle")!.click();
    await m.attendre();
    const secondes = m
      .qa("[data-rag-regle] select")
      .filter((s) => s.id.endsWith("-ext")) as HTMLSelectElement[];
    expect(secondes.map((s) => s.value)).toEqual(["pdf", "docx"]);
    secondes[1]!.value = "pdf";
    secondes[1]!.dispatchEvent(new Event("change"));
    await m.attendre();
    expect(texte(m.qa("[data-rag-regle] [id$='-ext-err']")[1] ?? null)).toBe(
      "Une règle existe déjà pour ce type de fichier.",
    );
    expect((m.bouton("Enregistrer") as HTMLButtonElement).disabled).toBe(true);
    (m.qa('[aria-label^="Retirer la règle"]')[1] as HTMLButtonElement).click();
    await m.attendre();
    (m.q('[aria-label^="Retirer la règle"]') as HTMLButtonElement).click();
    await m.attendre();
    expect(m.qa("[data-rag-regle]")).toHaveLength(0);
    expect((m.bouton("Enregistrer") as HTMLButtonElement).disabled).toBe(true);
  });

  it("menu « … » : choix de menu, Échap géré par la racine, retour du focus", async () => {
    const m = await monter({ api: api() });
    const declencheur = m.q('button[aria-label="Plus d’actions"]') as HTMLButtonElement;
    declencheur.click();
    await m.attendre();
    expect(declencheur.getAttribute("aria-expanded")).toBe("true");
    const items = m.qa('[role="menu"] [role="menuitem"]');
    expect(items.map((i) => texte(i))).toEqual([
      "Importer depuis la sandbox",
      "Ajouter un dossier…",
      "Réindexer tous les documents",
      "Réglages",
      "Supprimer la collection…",
    ]);
    expect(items.at(-1)!.classList.contains("is-danger")).toBe(true);
    m.rg.echapPage();
    await m.attendre();
    expect(m.q('[role="menu"]')).toBeNull();
    declencheur.click();
    await m.attendre();
    m.qa('[role="menu"] [role="menuitem"]')[3]!.click();
    await m.attendre();
    expect(m.rg.onglet).toBe("reglages");
    expect(m.q('[role="menu"]')).toBeNull();
  });

  it("menu : flèches entre les entrées", async () => {
    const m = await monter({ api: api() });
    (m.q('button[aria-label="Plus d’actions"]') as HTMLButtonElement).click();
    await m.attendre();
    const menu = m.q('[role="menu"]')!;
    const items = m.qa('[role="menu"] [role="menuitem"]');
    (items[0] as HTMLElement).focus();
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(window.document.activeElement).toBe(items[1]);
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(window.document.activeElement).toBe(items.at(-1));
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(window.document.activeElement).toBe(items[0]);
  });
});

describe("en-tête et accessibilité générale", () => {
  it("région nommée, retour au chat, aucun emoji dans le texte affiché", async () => {
    const m = await monter({ api: api() });
    const region = m.q('[role="region"][aria-label="RAG"]')!;
    expect(region.classList.contains("elpis-rag-page")).toBe(true);
    expect(m.q('button[aria-label="Retour au chat"]')).not.toBeNull();
    expect(texte(region)).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u);
    m.q<HTMLButtonElement>('button[aria-label="Retour au chat"]')!.click();
    await m.attendre();
    expect(m.rg.ouverte).toBe(false);
    expect(m.q(".elpis-rag-page")).toBeNull();
  });

  it("les icônes décoratives sont cachées aux lecteurs d'écran", async () => {
    const m = await monter({ api: api() });
    const icones = m.qa(".elpis-rag-page i.ph");
    expect(icones.length).toBeGreaterThan(10);
    const nues = icones.filter(
      (i) => !i.hasAttribute("aria-hidden") && !i.hasAttribute("aria-label") && !i.hasAttribute("title"),
    );
    expect(nues.map((i) => i.className)).toEqual([]);
  });
});
