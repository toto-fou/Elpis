// SPDX-License-Identifier: MIT
/** frontend/test/editor/visionneuses.test.ts — lecture fidèle (BOM, fins de ligne, perte, binaire), aperçus Office (réponse supplantée, onglet fermé, introuvable, passe PDF complète), grille xlsx (morceaux annulés et observateur libéré au démontage). */
import { createApp, h, nextTick, ref } from "vue";
import type { App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import GrilleOffice from "../../src/components/editor/GrilleOffice.vue";
import {
  decoderTexte,
  finDeLigne,
  lireTete,
  lireTexteOuBinaire,
  vidageHex,
} from "../../src/features/editor/lecture";
import { setupEditorViewers } from "../../src/features/editor/visionneuses";
import { fetchManuel, json } from "../aides";

const octets = (...b: number[]): Uint8Array<ArrayBuffer> => new Uint8Array(b);

/** Réponse de préparation conforme au contrat (vue pages). */
function prep(key: string, kind: string, url?: string, partiel = false): Response {
  return json({
    kind,
    key,
    rel: "d." + kind,
    size: 1,
    mtime: 1,
    view: "pages",
    pages: url === undefined ? null : { url, count: null, truncated: false, partial: partiel },
    grid: null,
    has: { pages: url !== undefined, grid: false },
  });
}

describe("lecture fidèle", () => {
  it("BOM retiré mais mémorisé, fins de ligne relevées, contenu non UTF-8 marqué avec perte", () => {
    expect(decoderTexte(octets(0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a))).toEqual({
      text: "a\r\n",
      bom: true,
      lossy: false,
      eol: "crlf",
    });
    expect(decoderTexte(octets(0x63, 0x61, 0x66, 0xe9)).lossy).toBe(true);
    expect(finDeLigne("a\nb\r\nc")).toBe("mixed");
    expect(finDeLigne("sans fin")).toBeNull();
  });

  it("binaire détecté dans le premier bloc ; tête de flux coupée à n octets ; vidage hexadécimal", async () => {
    expect(await lireTexteOuBinaire(new Response(new Blob([octets(0x00, 0x01, 0x02, 0x00)])))).toEqual({
      binary: true,
    });
    expect(await lireTexteOuBinaire(new Response("texte"))).toMatchObject({ text: "texte" });
    const tete = await lireTete(new Response(new Blob([new Uint8Array(10_000).fill(65)])), 4096);
    expect(tete.length).toBe(4096);
    expect(vidageHex(octets(0x41, 0x00, 0x7f))[0]).toEqual({
      offset: "00000000",
      hex: "41 00 7f".padEnd(48, " "),
      ascii: "A..",
    });
  });
});

function monde() {
  const f = fetchManuel();
  const fermes: string[] = [];
  const toasts: string[] = [];
  const refs = {
    openTabs: ref([{ path: "a.docx" }, { path: "b.pdf" }]),
    activeTabPath: ref<string | null>("a.docx"),
    settings: ref({ enable_editor: true }),
    showEditor: ref(true),
    features: ref({ office_preview: true }),
    monacoRef: { instance: null },
  };
  const v = setupEditorViewers(
    refs,
    { fetchAuth: (u, i) => f.fetch(u, i), showToast: (m) => toasts.push(m) },
    {
      url: (e) => "/api/sandbox/" + e,
      fermerOnglet: (p) => fermes.push(p),
      ouvrirFichier: () => Promise.resolve(),
      poserMtime: () => undefined,
      canonique: (p) => p,
    },
  );
  return { f, v, refs, fermes, toasts };
}

describe("aperçus Office", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("une réponse lente supplantée par une demande plus récente n'écrase jamais l'aperçu", async () => {
    const m = monde();
    const p1 = m.v.officeOpen("a.docx");
    const p2 = m.v.officeOpen("a.docx", { view: "pages", reload: true });
    m.f.appels[1]?.repondre(prep("k2", "docx", "/k2.pdf"));
    m.f.appels[0]?.repondre(prep("k1", "docx", "/k1.pdf"));
    await Promise.all([p1, p2]);
    expect(m.v.officeActive.value?.pdfUrl).toBe("/k2.pdf");
    expect(m.f.appels[0]?.init?.signal?.aborted).toBe(true);
  });

  it("onglet fermé pendant la conversion : requête annulée, aucune entrée ni minuterie restante", async () => {
    const m = monde();
    const p = m.v.officeOpen("a.docx");
    await vi.advanceTimersByTimeAsync(500);
    expect(m.v.officeActive.value?.spin).toBe(true);
    m.refs.openTabs.value = [{ path: "b.pdf" }];
    await nextTick();
    expect(m.f.appels[0]?.init?.signal?.aborted).toBe(true);
    m.f.appels[0]?.repondre(prep("k1", "docx"));
    await p;
    expect(m.v.officeActive.value).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("introuvable : onglet fermé avec un message ; échec passager : l'aperçu prêt reste affiché", async () => {
    const m = monde();
    const p1 = m.v.officeOpen("a.docx");
    m.f.appels[0]?.repondre(prep("k1", "docx", "/k1.pdf"));
    await p1;
    const p2 = m.v.officeOpen("a.docx", { force: true });
    m.f.appels[1]?.repondre(json({ detail: { code: "busy" } }, 503));
    await p2;
    expect(m.v.officeActive.value?.status).toBe("ready");
    const p3 = m.v.officeOpen("b.pdf");
    m.f.appels[2]?.repondre(json({ detail: "absent" }, 404));
    await p3;
    expect(m.fermes).toEqual(["b.pdf"]);
    expect(m.toasts).toEqual(["Fichier introuvable : b.pdf"]);
  });

  it("passe PDF complète : suivie jusqu'à la version entière ; une nouvelle clé remplace le suivi sans l'interrompre", async () => {
    const m = monde();
    m.refs.activeTabPath.value = "b.pdf";
    const p1 = m.v.officeOpen("b.pdf");
    m.f.appels[0]?.repondre(prep("k1", "pdf", "/k1a", true));
    await p1;
    await vi.advanceTimersByTimeAsync(2500);
    expect(m.f.appels).toHaveLength(2);
    const p2 = m.v.officeOpen("b.pdf", { force: true });
    m.f.appels[2]?.repondre(prep("k2", "pdf", "/k2a", true));
    await p2;
    m.f.appels[1]?.repondre(prep("k1", "pdf", "/k1b", true));
    await vi.advanceTimersByTimeAsync(2500);
    expect(m.f.appels).toHaveLength(4);
    m.f.appels[3]?.repondre(prep("k2", "pdf", "/k2-complet"));
    await vi.waitFor(() => expect(m.v.officeActive.value?.pdfUrl).toBe("/k2-complet"));
    m.v._resetViewersState();
    expect(vi.getTimerCount()).toBe(0);
  });
});

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  vi.unstubAllGlobals();
});

describe("GrilleOffice", () => {
  it("demande les morceaux visibles, annule ceux en vol et libère son observateur au démontage", async () => {
    let observes = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {
          observes++;
        }
        disconnect(): void {
          observes--;
        }
        unobserve(): void {}
      },
    );
    const signaux: AbortSignal[] = [];
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp({
      render: () =>
        h(GrilleOffice, {
          docKey: "k",
          sheets: [{ name: "F1", rows: 1000, cols: 3, chunks: 5 }],
          chunkSize: 2,
          fetchChunk: (_k: string, _f: number, c: number, s: AbortSignal) => {
            signaux.push(s);
            return c === 0 ? Promise.resolve([["R0C0", "12", "x"]]) : new Promise<unknown>(() => {});
          },
        }),
    });
    app.mount(hote);
    await vi.waitFor(() => expect(hote.textContent).toContain("R0C0"));
    expect(hote.querySelector('[role="gridcell"].justify-end')?.textContent).toBe("12");
    expect(observes).toBe(1);
    app.unmount();
    app = null;
    expect(observes).toBe(0);
    expect(signaux.length).toBeGreaterThan(1);
    expect(signaux.every((s, i) => i === 0 || s.aborted)).toBe(true);
  });
});
