// SPDX-License-Identifier: MIT
/** frontend/test/rag/decoupage-composants.test.ts — fenêtre « Découpage » d'un document montée sur la vraie page : ouverture (action de la ligne, nom), aperçu, antirebond, saisies invalides, redécoupes, application, retour à la collection, passages indexés, lecteur, Échap. */
import { createApp, effectScope, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import type { DocumentRag } from "@elpis/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import PageRag from "../../src/components/rag/PageRag.vue";
import { paramsParDefaut } from "../../src/features/rag/decoupage";
import type { DecoupageDocumentRag, PassageListeRag } from "@elpis/contracts";
import { CLE_RAG } from "../../src/features/rag/domaine";
import type { DomaineRag } from "../../src/features/rag/domaine";
import { creerRag } from "../../src/features/rag/rag";
import {
  collection,
  document as doc,
  echec,
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

const COLL = idRag(1);
const DOC = doc(1, COLL, { name: "guide.pdf", rel_path: "guide.pdf", chunk_count: 3 });
const PAUSE = 15;
const attendrePause = (): Promise<void> => new Promise((r) => setTimeout(r, PAUSE * 4));

function passages(n: number): PassageListeRag[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    texte: `Texte du passage ${i + 1}`,
    caracteres: 100 + i * 100,
    jetons: 25 + i * 25,
    page: i + 1,
    section: i % 2 === 0 ? "Titre A" : "Titre B",
    redecoupe_de: null,
  }));
}
const apercu = (
  n: number,
  extra: Partial<{ tronque: boolean; avertissements: string[]; total: number }> = {},
) =>
  ok({
    passages: passages(n),
    total: extra.total ?? n,
    tronque: extra.tronque ?? false,
    avertissements: extra.avertissements ?? [],
  });

interface Options {
  api?: Parameters<typeof fausseApi>[0];
  collections?: ReturnType<typeof collection>[];
  documents?: DocumentRag[];
}

async function monter(o: Options = {}) {
  const api = fausseApi({
    collections: vi.fn(async () =>
      ok(o.collections ?? [collection(1, { name: "Réseau", doc_count: 1, chunk_count: 3 })]),
    ),
    documents: vi.fn(async () =>
      ok({ documents: o.documents ?? [DOC], total: (o.documents ?? [DOC]).length }),
    ),
    apercuDecoupage: vi.fn(async () => apercu(3)),
    ...o.api,
  });
  const { ctx, toasts } = fauxCtx(true);
  scope = effectScope();
  const rg = reactive(
    scope.run(() =>
      creerRag(api, faussesRefs("chat"), ctx, {
        cible: new EventTarget(),
        periodeSondageMs: 100_000,
        delaiApercuMs: PAUSE,
      }),
    )!,
  );
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
  const saisir = async (selecteur: string, valeur: string): Promise<void> => {
    const e = q<HTMLInputElement | HTMLSelectElement>(selecteur)!;
    e.value = valeur;
    e.dispatchEvent(new Event(e instanceof HTMLSelectElement ? "change" : "input"));
    await nextTick();
  };
  const ouvrir = async (): Promise<void> => {
    q("[data-rag-doc] [data-rag-decoupage]")!.click();
    await attendre();
  };
  return { rg, api, ctx, toasts, q, qa, bouton, attendre, saisir, ouvrir };
}

const texte = (e: Element | null): string =>
  (e?.textContent ?? "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();

describe("ouverture", () => {
  it("l'action de la ligne ouvre la fenêtre du propriétaire : dialogue modal, aperçu calculé sans paramètre propre", async () => {
    const m = await monter();
    await m.ouvrir();
    const boite = m.q('[data-rag-dialog="decoupage"]')!;
    expect(boite).not.toBeNull();
    expect(boite.hasAttribute("data-a11y-modal")).toBe(true);
    const dialogue = boite.querySelector('[role="dialog"]')!;
    expect(dialogue.getAttribute("aria-modal")).toBe("true");
    expect(texte(m.q("#rag-dec-titre"))).toBe("Découpage de « guide.pdf »");
    expect(m.rg.dialogueOuvert).toBe(true);
    expect(m.api.apercuDecoupage).toHaveBeenCalledTimes(1);
    expect(m.api.apercuDecoupage).toHaveBeenCalledWith(COLL, DOC.id, { redecoupes: [] });
    expect(m.qa('[data-rag-dialog="decoupage"] [role="tab"]').map((t) => texte(t))).toEqual([
      "Aperçu du découpage",
      "Passages indexés",
    ]);
    expect(texte(m.q("#rag-dpanel-apercu .rag-apercu__count"))).toBe("3 passages");
    expect(m.qa("#rag-dpanel-apercu .rag-strip i")).toHaveLength(3);
  });

  it("cliquer sur le nom du document ouvre la même fenêtre", async () => {
    const m = await monter();
    m.q<HTMLButtonElement>(".rag-doc__open")!.click();
    await m.attendre();
    expect(m.rg.decoupage.ouvert).toBe(true);
    expect(m.rg.decoupage.lecture).toBe(false);
  });

  it("chaque passage : numéro, barre relative, caractères et jetons, page et section, texte replié", async () => {
    const m = await monter();
    await m.ouvrir();
    const lignes = m.qa("#rag-dpanel-apercu [data-rag-passage]");
    expect(lignes).toHaveLength(3);
    const l = lignes[1]!;
    expect(texte(l.querySelector(".rag-pas__n"))).toBe("2");
    expect(texte(l.querySelector(".rag-pas__meta"))).toBe("200 car. · 50 jetons");
    expect(texte(l.querySelector(".rag-pas__lieu"))).toBe("page 2 · Titre B");
    const largeurs = lignes.map((x) => x.querySelector<HTMLElement>(".rag-pas__bar i")!.style.width);
    expect(largeurs).toEqual(["33%", "67%", "100%"]);
    const bascule = l.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(bascule.getAttribute("aria-expanded")).toBe("false");
    expect(l.querySelector(".rag-pas__txt")!.classList.contains("is-open")).toBe(false);
    bascule.click();
    await m.attendre();
    expect(bascule.getAttribute("aria-expanded")).toBe("true");
    expect(l.querySelector(".rag-pas__txt")!.classList.contains("is-open")).toBe(true);
    expect(bascule.getAttribute("aria-controls")).toBe(l.querySelector(".rag-pas__txt")!.id);
  });

  it("avertissements et aperçu tronqué sont dits en tête", async () => {
    const m = await monter({
      api: {
        apercuDecoupage: vi.fn(async () =>
          apercu(3, { tronque: true, total: 480, avertissements: ["Tableau coupé en deux."] }),
        ),
      },
    });
    await m.ouvrir();
    expect(texte(m.q("[data-rag-avertissements]"))).toBe("Tableau coupé en deux.");
    expect(texte(m.q("[data-rag-tronque]"))).toBe("Aperçu tronqué : les 3 premiers passages sur 480.");
    expect(texte(m.q(".rag-apercu__count"))).toBe("480 passages");
  });

  it("erreur du serveur sur l'aperçu : message en clair, la fenêtre reste ouverte", async () => {
    const m = await monter({ api: { apercuDecoupage: vi.fn(async () => echec("regex_invalide", "400")) } });
    await m.ouvrir();
    expect(texte(m.q("#rag-dpanel-apercu .rag-error"))).toBe("L’expression régulière est invalide.");
    expect(m.rg.decoupage.ouvert).toBe(true);
  });
});

describe("découpage propre et antirebond", () => {
  it("hériter d'abord, avec le résumé de la collection ; Appliquer inactif tant que rien n'a changé", async () => {
    const m = await monter();
    await m.ouvrir();
    const radios = m.qa('input[name="rag-dec-mode"]') as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    expect(texte(m.q(".rag-dec__params"))).toContain("Automatique · 512 jetons · chevauchement 64");
    expect(m.q("#rag-dec-doc-methode")).toBeNull();
    expect((m.bouton("Appliquer et réindexer") as HTMLButtonElement).disabled).toBe(true);
  });

  it("l'aperçu est recalculé après une pause, une seule fois pour plusieurs saisies", async () => {
    const m = await monter();
    await m.ouvrir();
    (m.qa('input[name="rag-dec-mode"]')[1] as HTMLInputElement).click();
    await m.attendre();
    await attendrePause();
    expect(m.api.apercuDecoupage).toHaveBeenCalledTimes(2);
    expect(m.api.apercuDecoupage).toHaveBeenLastCalledWith(COLL, DOC.id, {
      params: paramsParDefaut(),
      redecoupes: [],
    });
    await m.saisir("#rag-dec-doc-taille", "200");
    await m.saisir("#rag-dec-doc-taille", "250");
    await m.saisir("#rag-dec-doc-taille", "300");
    expect(m.api.apercuDecoupage).toHaveBeenCalledTimes(2);
    expect(texte(m.q(".rag-apercu__count"))).toContain("Calcul");
    await attendrePause();
    expect(m.api.apercuDecoupage).toHaveBeenCalledTimes(3);
    expect(vi.mocked(m.api.apercuDecoupage).mock.calls[2]![2]).toMatchObject({ params: { taille: 300 } });
    expect((m.bouton("Appliquer et réindexer") as HTMLButtonElement).disabled).toBe(false);
  });

  it("saisie invalide : aucun appel, le dit, Appliquer inactif", async () => {
    const m = await monter();
    await m.ouvrir();
    (m.qa('input[name="rag-dec-mode"]')[1] as HTMLInputElement).click();
    await m.attendre();
    await attendrePause();
    const avant = vi.mocked(m.api.apercuDecoupage).mock.calls.length;
    await m.saisir("#rag-dec-doc-methode", "separateur");
    await m.attendre();
    await attendrePause();
    expect(vi.mocked(m.api.apercuDecoupage).mock.calls.length).toBe(avant);
    expect(texte(m.q("#rag-dec-doc-valeur-err"))).toBe("Indiquez le séparateur.");
    expect(texte(m.q("#rag-dpanel-apercu"))).toContain("Corrigez les valeurs");
    expect((m.bouton("Appliquer et réindexer") as HTMLButtonElement).disabled).toBe(true);
    m.qa(".rag-dec__params .rag-exemples .rag-chip")[0]!.click();
    await m.attendre();
    await attendrePause();
    expect(vi.mocked(m.api.apercuDecoupage).mock.calls.length).toBe(avant + 1);
    expect(vi.mocked(m.api.apercuDecoupage).mock.calls.at(-1)![2]).toMatchObject({
      params: { methode: "separateur", valeur: "\\n\\n" },
    });
    expect((m.bouton("Appliquer et réindexer") as HTMLButtonElement).disabled).toBe(false);
  });

  it("une réponse périmée est ignorée", async () => {
    let premiere!: (v: ReturnType<typeof apercu>) => void;
    const apercuFn = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (premiere = r)))
      .mockImplementation(async () => apercu(2));
    const m = await monter({ api: { apercuDecoupage: apercuFn } });
    await m.ouvrir();
    (m.qa('input[name="rag-dec-mode"]')[1] as HTMLInputElement).click();
    await m.attendre();
    await attendrePause();
    expect(m.qa("[data-rag-passage]")).toHaveLength(2);
    premiere(apercu(7));
    await m.attendre();
    expect(m.qa("[data-rag-passage]")).toHaveLength(2);
  });
});

describe("redécoupes", () => {
  // Quatre passages de base ; chaque redécoupe remplace son passage par deux morceaux.
  const avecRedecoupes = async (dec: { redecoupes: { index: number }[] }) => {
    const sortie: PassageListeRag[] = [];
    passages(4).forEach((p, i) => {
      if (!dec.redecoupes.some((r) => r.index === i)) sortie.push(p);
      else sortie.push({ ...p, redecoupe_de: i }, { ...p, texte: `${p.texte} (suite)`, redecoupe_de: i });
    });
    return ok({ passages: sortie, total: sortie.length, tronque: false, avertissements: [] });
  };
  const monterRedecoupe = () =>
    monter({
      api: {
        apercuDecoupage: vi.fn(async (_i: string, _d: string, dec: { redecoupes: { index: number }[] }) =>
          avecRedecoupes(dec),
        ),
      },
    });

  it("le panneau s'ouvre sous le passage, la redécoupe est empilée et l'aperçu recalculé", async () => {
    const m = await monterRedecoupe();
    await m.ouvrir();
    m.q<HTMLButtonElement>('[aria-label="Redécouper le passage 2"]')!.click();
    await m.attendre();
    const panneau = m.q("[data-rag-redecoupe]")!;
    expect(panneau).not.toBeNull();
    expect(panneau.closest("[data-rag-passage]")!.querySelector(".rag-pas__n")!.textContent).toBe("2");
    expect(window.document.activeElement?.id).toBe("rag-redec-methode");
    await m.saisir("#rag-redec-methode", "phrase");
    await m.saisir("#rag-redec-taille", "120");
    await m.saisir("#rag-redec-chevauchement", "10");
    m.bouton("Redécouper ce passage")!.click();
    await m.attendre();
    await attendrePause();
    expect(m.q("[data-rag-redecoupe]")).toBeNull();
    const dernier = vi.mocked(m.api.apercuDecoupage).mock.calls.at(-1)!;
    expect(dernier[2]).toEqual({
      redecoupes: [
        {
          index: 1,
          params: { methode: "phrase", unite: "jetons", taille: 120, chevauchement: 10, taille_max: 1200 },
        },
      ],
    });
    expect(texte(m.q("[data-rag-modifie]"))).toBe("Découpage modifié");
    expect(m.qa("[data-rag-passage].is-sub")).toHaveLength(2);
    expect(m.qa("[data-rag-passage]")).toHaveLength(5);
    // un passage redécoupé ne se redécoupe pas ; la première pièce propose de défaire
    expect(m.qa('[aria-label^="Redécouper le passage"]')).toHaveLength(3);
    expect(m.qa("[data-rag-passage].is-sub .rag-link").map((b) => texte(b))).toEqual(["Défaire"]);
    expect(m.rg.decoupage.modifie).toBe(true);
  });

  it("une redécoupe se refuse si ses valeurs sont invalides", async () => {
    const m = await monterRedecoupe();
    await m.ouvrir();
    m.q<HTMLButtonElement>('[aria-label="Redécouper le passage 1"]')!.click();
    await m.attendre();
    await m.saisir("#rag-redec-taille", "5");
    expect(m.bouton("Redécouper ce passage")!.disabled).toBe(true);
    expect(m.rg.decoupage.validerRedecoupe()).toBe(false);
    expect(m.rg.decoupage.redecoupes).toEqual([]);
  });

  it("« Annuler les redécoupes » rend l'aperçu de base ; « Défaire » n'ôte que sa redécoupe", async () => {
    const m = await monterRedecoupe();
    await m.ouvrir();
    for (const n of [1, 4]) {
      m.q<HTMLButtonElement>(`[aria-label="Redécouper le passage ${n}"]`)!.click();
      await m.attendre();
      m.bouton("Redécouper ce passage")!.click();
      await m.attendre();
      await attendrePause();
    }
    expect(m.rg.decoupage.redecoupes.map((r) => r.index)).toEqual([0, 2]);
    m.q<HTMLButtonElement>("[data-rag-passage].is-sub .rag-link")!.click();
    await m.attendre();
    await attendrePause();
    expect(m.rg.decoupage.redecoupes.map((r) => r.index)).toEqual([2]);
    m.bouton("Annuler les redécoupes")!.click();
    await m.attendre();
    await attendrePause();
    expect(m.rg.decoupage.redecoupes).toEqual([]);
    expect(m.q("[data-rag-modifie]")).toBeNull();
    expect(vi.mocked(m.api.apercuDecoupage).mock.calls.at(-1)![2]).toEqual({ redecoupes: [] });
  });

  it("Échap ferme d'abord le panneau, puis la fenêtre", async () => {
    const m = await monterRedecoupe();
    await m.ouvrir();
    m.q<HTMLButtonElement>('[aria-label="Redécouper le passage 1"]')!.click();
    await m.attendre();
    expect(m.rg.fermerDialogue()).toBe(true);
    await m.attendre();
    expect(m.q("[data-rag-redecoupe]")).toBeNull();
    expect(m.rg.decoupage.ouvert).toBe(true);
    expect(m.rg.fermerDialogue()).toBe(true);
    await m.attendre();
    expect(m.q('[data-rag-dialog="decoupage"]')).toBeNull();
    expect(m.rg.dialogueOuvert).toBe(false);
    expect(m.rg.fermerDialogue()).toBe(false);
  });
});

describe("application", () => {
  const reponse = (statut: DocumentRag["status"] = "pending") =>
    ok({
      document: { ...DOC, status: statut },
      job: travail(1, COLL, { kind: "reindex", total: 1, done: 0 }),
    });

  it("Appliquer et réindexer : découpage propre et redécoupes envoyés, fenêtre fermée, réindexation suivie", async () => {
    const appliquer = vi.fn(async () => reponse());
    const m = await monter({ api: { appliquerDecoupage: appliquer } });
    await m.ouvrir();
    (m.qa('input[name="rag-dec-mode"]')[1] as HTMLInputElement).click();
    await m.attendre();
    await m.saisir("#rag-dec-doc-methode", "phrase");
    await m.saisir("#rag-dec-doc-taille", "300");
    m.q<HTMLButtonElement>('[aria-label="Redécouper le passage 3"]')!.click();
    await m.attendre();
    m.bouton("Redécouper ce passage")!.click();
    await m.attendre();
    await attendrePause();
    m.bouton("Appliquer et réindexer")!.click();
    await m.attendre();
    expect(appliquer).toHaveBeenCalledWith(COLL, DOC.id, {
      params: { methode: "phrase", unite: "jetons", taille: 300, chevauchement: 64, taille_max: 1200 },
      redecoupes: [
        {
          index: 2,
          params: { methode: "phrase", unite: "jetons", taille: 300, chevauchement: 64, taille_max: 1200 },
        },
      ],
    });
    expect(m.q('[data-rag-dialog="decoupage"]')).toBeNull();
    expect(m.toasts.at(-1)?.message).toBe("Découpage enregistré, réindexation lancée.");
    expect(m.rg.documents.documents[0]!.status).toBe("pending");
    expect(m.rg.documents.travail?.kind).toBe("reindex");
    expect(texte(m.q("[data-rag-bandeau]"))).toContain("Réindexation de 1 document");
  });

  it("un document qui hérite et n'a aucune redécoupe n'a rien à appliquer", async () => {
    const m = await monter();
    await m.ouvrir();
    expect(m.rg.decoupage.peutAppliquer).toBe(false);
    expect(await m.rg.decoupage.appliquer()).toBe(false);
    expect(m.api.appliquerDecoupage).not.toHaveBeenCalled();
  });

  it("refus du serveur : message dans la fenêtre, elle reste ouverte", async () => {
    const appliquer = vi.fn(async () => echec("regex_invalide", "x"));
    const m = await monter({ api: { appliquerDecoupage: appliquer } });
    await m.ouvrir();
    (m.qa('input[name="rag-dec-mode"]')[1] as HTMLInputElement).click();
    await m.attendre();
    await m.saisir("#rag-dec-doc-taille", "300");
    m.bouton("Appliquer et réindexer")!.click();
    await m.attendre();
    expect(texte(m.q(".rag-dec__err"))).toBe("L’expression régulière est invalide.");
    expect(m.rg.decoupage.ouvert).toBe(true);
    expect(m.rg.decoupage.enCours).toBe(false);
  });

  it("RAG indisponible : on n'applique pas", async () => {
    const m = await monter();
    await m.ouvrir();
    (m.qa('input[name="rag-dec-mode"]')[1] as HTMLInputElement).click();
    await m.attendre();
    await m.saisir("#rag-dec-doc-taille", "300");
    expect(m.rg.decoupage.peutAppliquer).toBe(true);
    m.rg.etat = { ...m.rg.etat!, usable: false };
    expect(m.rg.decoupage.peutAppliquer).toBe(false);
  });

  it("document au découpage propre : mode propre au départ, « Revenir au découpage de la collection » envoie null", async () => {
    const propre = {
      params: { methode: "markdown", unite: "jetons", taille: 400, chevauchement: 40, taille_max: 900 },
      redecoupes: [],
    } satisfies DecoupageDocumentRag;
    const appliquer = vi.fn(async () => reponse());
    const lire = vi.fn(async () => ok(propre));
    const m = await monter({ api: { appliquerDecoupage: appliquer, decoupageDocument: lire } });
    await m.ouvrir();
    expect(lire).toHaveBeenCalledWith(COLL, DOC.id);
    expect((m.qa('input[name="rag-dec-mode"]')[1] as HTMLInputElement).checked).toBe(true);
    expect((m.q("#rag-dec-doc-methode") as HTMLSelectElement).value).toBe("markdown");
    expect(texte(m.q("#rag-dec-sous"))).toBe("Ce document a son propre découpage.");
    expect(vi.mocked(m.api.apercuDecoupage).mock.calls[0]![2]).toMatchObject({
      params: { methode: "markdown", taille: 400 },
    });
    m.bouton("Revenir au découpage de la collection")!.click();
    await m.attendre();
    expect(appliquer).toHaveBeenCalledWith(COLL, DOC.id, null);
    expect(m.toasts.at(-1)?.message).toBe("Le document suit de nouveau le découpage de la collection.");
    expect(m.rg.decoupage.ouvert).toBe(false);
  });

  it("découpage propre illisible : le dit, pas d'aperçu, rien à appliquer", async () => {
    const m = await monter({
      api: { decoupageDocument: vi.fn(async () => echec("document_introuvable", "x")) },
    });
    await m.ouvrir();
    expect(m.api.apercuDecoupage).not.toHaveBeenCalled();
    expect(m.rg.decoupage.peutAppliquer).toBe(false);
    expect(texte(m.q(".rag-dec__err")).length).toBeGreaterThan(0);
  });

  it("changer de collection ferme la fenêtre", async () => {
    const m = await monter({
      collections: [collection(1, { name: "Réseau", doc_count: 1 }), collection(2, { name: "Contrats" })],
    });
    await m.ouvrir();
    m.rg.selectionner(idRag(2));
    await m.attendre();
    expect(m.rg.decoupage.ouvert).toBe(false);
    expect(m.q('[data-rag-dialog="decoupage"]')).toBeNull();
  });
});

describe("passages indexés", () => {
  const liste = (de: number, n: number, total: number) =>
    ok({
      passages: passages(de + n)
        .slice(de)
        .map((p) => ({ ...p, index: p.index })),
      total,
    });

  it("le second onglet charge la vraie liste par pages, avec un filtre texte et « Afficher la suite »", async () => {
    const lire = vi.fn(async (_c: string, _d: string, offset: number) =>
      liste(offset, offset === 0 ? 50 : 10, 60),
    );
    const m = await monter({ api: { passagesListe: lire } });
    await m.ouvrir();
    expect(lire).not.toHaveBeenCalled();
    m.q<HTMLButtonElement>("#rag-dtab-indexes")!.click();
    await m.attendre();
    expect(lire).toHaveBeenCalledWith(COLL, DOC.id, 0, 50);
    expect(m.q("#rag-dtab-indexes")!.getAttribute("aria-selected")).toBe("true");
    expect(m.qa("#rag-dpanel-indexes [data-rag-passage]")).toHaveLength(50);
    expect(texte(m.q("#rag-dpanel-indexes .rag-tools .rag-hint"))).toBe("50 sur 60 passages");
    // le filtre porte sur les passages chargés
    await m.saisir("#rag-dpanel-indexes input[type='search']", "passage 7");
    await m.attendre();
    expect(
      m.qa("#rag-dpanel-indexes [data-rag-passage]").map((p) => texte(p.querySelector(".rag-pas__txt"))),
    ).toEqual(["Texte du passage 7"]);
    expect(texte(m.q("#rag-dpanel-indexes .rag-more"))).toContain(
      "Le filtre porte sur les passages déjà chargés.",
    );
    await m.saisir("#rag-dpanel-indexes input[type='search']", "");
    m.bouton("Afficher la suite (10)")!.click();
    await m.attendre();
    expect(lire).toHaveBeenLastCalledWith(COLL, DOC.id, 50, 50);
    expect(m.qa("#rag-dpanel-indexes [data-rag-passage]")).toHaveLength(60);
    expect(m.q("#rag-dpanel-indexes .rag-more")).toBeNull();
  });

  it("document sans passage indexé, ou filtre sans résultat : le dit", async () => {
    const m = await monter();
    await m.ouvrir();
    m.q<HTMLButtonElement>("#rag-dtab-indexes")!.click();
    await m.attendre();
    expect(texte(m.q("#rag-dpanel-indexes"))).toContain("Ce document n’a pas encore de passage indexé.");
  });

  it("les flèches du clavier passent d'un onglet à l'autre", async () => {
    const m = await monter();
    await m.ouvrir();
    m.q("#rag-dtab-apercu")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await m.attendre();
    expect(m.rg.decoupage.onglet).toBe("indexes");
    expect(window.document.activeElement?.id).toBe("rag-dtab-indexes");
    m.q("#rag-dtab-indexes")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await m.attendre();
    expect(m.rg.decoupage.onglet).toBe("apercu");
  });
});

describe("lecteur d'une collection partagée", () => {
  const lecteur = (ouverte: boolean) =>
    monter({
      collections: [
        partagee(3, "Sophie", { name: "Base support", doc_count: 1, allow_source_open: ouverte }),
      ],
      documents: [doc(1, idRag(3), { name: "faq.pdf", rel_path: "faq.pdf" })],
      api: {
        passagesListe: vi.fn(async () => ok({ passages: passages(2), total: 2 })),
      },
    });

  it("sources ouvertes : la fenêtre s'ouvre en lecture sur les passages indexés, sans aperçu ni application", async () => {
    const m = await lecteur(true);
    m.qa(".rag-coll")[0]!.click();
    await m.attendre();
    const action = m.q<HTMLButtonElement>("[data-rag-decoupage]")!;
    expect(action.getAttribute("aria-label")).toBe("Passages de faq.pdf");
    action.click();
    await m.attendre();
    expect(m.rg.decoupage.lecture).toBe(true);
    expect(m.api.apercuDecoupage).not.toHaveBeenCalled();
    expect(m.api.passagesListe).toHaveBeenCalledWith(idRag(3), expect.any(String), 0, 50);
    expect(m.qa('[data-rag-dialog="decoupage"] [role="tab"]').map((t) => texte(t))).toEqual([
      "Passages indexés",
    ]);
    expect(m.q(".rag-dec__params")).toBeNull();
    expect(m.bouton("Appliquer et réindexer")).toBeUndefined();
    expect(m.bouton("Revenir au découpage de la collection")).toBeUndefined();
    // Une seule façon de fermer : la croix d'en-tête, le pied vide disparaît.
    expect(m.bouton("Fermer")).toBeUndefined();
    expect(m.q('[data-rag-dialog="decoupage"] .rag-dialog__foot')).toBeNull();
    expect(m.q('[data-rag-dialog="decoupage"] .rag-dialog__head button[aria-label="Fermer"]')).not.toBeNull();
    expect(texte(m.q("#rag-dec-sous"))).toBe("Lecture seule · Base support");
    expect(m.qa("[data-rag-passage]")).toHaveLength(2);
    expect(m.qa('[aria-label^="Redécouper"]')).toHaveLength(0);
    // même en forçant l'ouverture, rien ne part vers le serveur
    expect(await m.rg.decoupage.appliquer()).toBe(false);
    expect(m.api.appliquerDecoupage).not.toHaveBeenCalled();
  });

  it("sources fermées : ni action ni lien sur le nom", async () => {
    const m = await lecteur(false);
    m.qa(".rag-coll")[0]!.click();
    await m.attendre();
    expect(m.q("[data-rag-decoupage]")).toBeNull();
    expect(m.q(".rag-doc__open")).toBeNull();
  });

  it("refus du serveur (sources fermées entre-temps) : message en clair", async () => {
    const m = await monter({
      collections: [partagee(3, "Sophie", { name: "Base support", doc_count: 1, allow_source_open: true })],
      documents: [doc(1, idRag(3))],
      api: { passagesListe: vi.fn(async () => echec("sources_fermees", "403")) },
    });
    m.qa(".rag-coll")[0]!.click();
    await m.attendre();
    m.q<HTMLButtonElement>("[data-rag-decoupage]")!.click();
    await m.attendre();
    expect(texte(m.q("#rag-dpanel-indexes .rag-error"))).toBe(
      "Le propriétaire n’a pas ouvert les documents sources de cette collection.",
    );
  });
});
