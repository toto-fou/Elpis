// SPDX-License-Identifier: MIT
/** frontend/test/communs/recadrage-image.test.ts — fenêtre RecadrageImage sous happy-dom : ouverture sur un fichier, clavier (flèches, +/-, Échap en premier, Tab gardé), curseur, Ajuster/Remplir/pivoter, sortie émise, erreurs de décodage et d'export. */
/* eslint-disable vue/one-component-per-file -- hôtes de montage du composant testé */
import { createApp, h, nextTick, ref } from "vue";
import type { App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EtatRecadrage } from "../../src/features/communs/recadrage";
import type * as ModuleDom from "../../src/features/communs/recadrage-dom";

const exports: EtatRecadrage[] = [];
let decodage: () => Promise<unknown> = () =>
  Promise.resolve({ source: {}, dimensions: { largeur: 1000, hauteur: 500 } });
let exportKo = false;

vi.mock("../../src/features/communs/recadrage-dom", async (origine) => {
  const vrai = await origine<typeof ModuleDom>();
  const { ErreurRecadrage } = vrai;
  return {
    ...vrai,
    decoderImage: () => decodage(),
    dessiner: () => undefined,
    exporterRecadrage: (_i: unknown, etat: EtatRecadrage, cote: number, base: string) => {
      exports.push(etat);
      if (exportKo) return Promise.reject(new ErreurRecadrage("Export de l'image impossible."));
      return Promise.resolve(new File([new Uint8Array(4)], `${base}-${cote}.png`, { type: "image/png" }));
    },
  };
});

const { default: RecadrageImage } = await import("../../src/components/communs/RecadrageImage.vue");

let app: App | null = null;
const fichier = ref<Blob | null>(null);
const evenements: unknown[][] = [];

beforeEach(() => {
  exports.length = 0;
  evenements.length = 0;
  exportKo = false;
  decodage = () => Promise.resolve({ source: {}, dimensions: { largeur: 1000, hauteur: 500 } });
});

afterEach(() => {
  app?.unmount();
  app = null;
  fichier.value = null;
  document.body.innerHTML = "";
});

async function monter(forme: "rond" | "carre" = "rond"): Promise<void> {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({
    render: () =>
      h(RecadrageImage, {
        fichier: fichier.value,
        titre: "Recadrer la photo",
        forme,
        cote: 512,
        nomFichier: "avatar",
        onValider: (f: File) => evenements.push(["valider", f.name]),
        onAnnuler: () => evenements.push(["annuler"]),
        onErreur: (m: string) => evenements.push(["erreur", m]),
      }),
  });
  app.mount(hote);
  fichier.value = new Blob([new Uint8Array(8)], { type: "image/png" });
  await attendre();
}

async function attendre(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

const dialogue = () => document.querySelector<HTMLElement>('[role="dialog"]');
const scene = () => document.querySelector<HTMLElement>("[data-recadrage-scene]");
const bouton = (texte: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === texte || b.getAttribute("aria-label") === texte,
  );
const touche = (cible: EventTarget, key: string, init: KeyboardEventInit = {}) => {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  cible.dispatchEvent(ev);
  return ev;
};

async function valider(): Promise<EtatRecadrage> {
  bouton("Valider")?.click();
  await attendre();
  const e = exports.at(-1);
  if (!e) throw new Error("aucun export");
  return e;
}

describe("RecadrageImage", () => {
  it("fermée sans fichier ; ouverte en dialogue modal titré, scène focalisée, aperçu rond ou carré", async () => {
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp({ render: () => h(RecadrageImage, { fichier: null, titre: "X" }) });
    app.mount(hote);
    expect(dialogue()).toBeNull();
    app.unmount();
    await monter("carre");
    const d = dialogue();
    expect(d?.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(d?.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(
      "Recadrer la photo",
    );
    expect(document.activeElement).toBe(scene());
    expect(scene()?.querySelector(".rounded-lg.ring-2")).not.toBeNull();
    expect(scene()?.querySelector(".rounded-full")).toBeNull();
  });

  it("Valider émet le fichier produit à la taille demandée, l'état initial couvre le cadre", async () => {
    await monter();
    const e = await valider();
    expect(e).toMatchObject({ rotation: 0, x: 0, y: 0, cadre: 224 });
    expect(e.echelle).toBeCloseTo(224 / 500, 12);
    expect(evenements).toEqual([["valider", "avatar-512.png"]]);
  });

  it("flèches et +/- sur la scène : déplacement et zoom ; Maj élargit le pas", async () => {
    await monter();
    const s = scene() as HTMLElement;
    expect(touche(s, "ArrowLeft").defaultPrevented).toBe(true);
    touche(s, "ArrowLeft", { shiftKey: true });
    touche(s, "+");
    await attendre();
    const e = await valider();
    expect(e.echelle).toBeCloseTo((224 / 500) * 1.1, 12);
    expect(e.x).toBeCloseTo(-60 * 1.1, 9);
  });

  it("Ajuster, Remplir, pivoter et le curseur changent l'état exporté", async () => {
    await monter();
    bouton("Ajuster")?.click();
    await attendre();
    expect((await valider()).echelle).toBeCloseTo(224 / 1000, 12);
    bouton("Remplir")?.click();
    bouton("Pivoter à droite")?.click();
    await attendre();
    expect(await valider()).toMatchObject({ rotation: 90 });
    bouton("Pivoter à gauche")?.click();
    bouton("Pivoter à gauche")?.click();
    await attendre();
    expect((await valider()).rotation).toBe(270);
    const curseur = document.querySelector<HTMLInputElement>('input[type="range"]') as HTMLInputElement;
    expect(curseur.getAttribute("aria-label")).toBe("Zoom");
    curseur.value = "1000";
    curseur.dispatchEvent(new Event("input", { bubbles: true }));
    await attendre();
    expect((await valider()).echelle).toBeCloseTo((224 / 500) * 8, 12);
    expect(curseur.getAttribute("aria-valuetext")).toBe("800 %");
  });

  it("Échap annule avant le clavier global (qui ne le voit pas), Annuler aussi", async () => {
    const global = vi.fn();
    document.addEventListener("keydown", global, { capture: true });
    try {
      await monter();
      touche(scene() as HTMLElement, "Escape");
      expect(evenements).toEqual([["annuler"]]);
      expect(global).not.toHaveBeenCalled();
      bouton("Annuler")?.click();
      expect(evenements).toEqual([["annuler"], ["annuler"]]);
    } finally {
      document.removeEventListener("keydown", global, { capture: true });
    }
  });

  it("Tab reste dans la fenêtre : du dernier bouton au premier, et retour par Maj+Tab", async () => {
    await monter();
    const valide = bouton("Valider") as HTMLButtonElement;
    const fermer = bouton("Annuler le recadrage") as HTMLButtonElement;
    valide.focus();
    expect(touche(valide, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(fermer);
    touche(fermer, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(valide);
  });

  it("une fermeture retire l'écoute globale : Échap n'émet plus rien", async () => {
    await monter();
    fichier.value = null;
    await attendre();
    expect(dialogue()).toBeNull();
    touche(document.body, "Escape");
    expect(evenements).toEqual([]);
  });

  it("image illisible : erreur émise ; export en échec : message dans la fenêtre, rien d'émis", async () => {
    decodage = () => Promise.reject(new Error("x"));
    await monter();
    expect(evenements).toEqual([["erreur", "Image illisible."]]);
    app?.unmount();
    evenements.length = 0;
    decodage = () => Promise.resolve({ source: {}, dimensions: { largeur: 10, hauteur: 10 } });
    exportKo = true;
    await monter();
    bouton("Valider")?.click();
    await attendre();
    expect(document.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      "Export de l'image impossible.",
    );
    expect(evenements).toEqual([]);
  });
});
