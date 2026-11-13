// SPDX-License-Identifier: MIT
/** frontend/test/communs/volet.test.ts — volet coulissant : largeur tenue jusqu'à la fin de la sortie du contenu (ouvertures et fermetures enchaînées comprises), focus passé au volet quand son déclencheur disparaît, rendu au déclencheur ou au rail à la fermeture. */
/* eslint-disable vue/one-component-per-file -- hôtes de montage du composable testé */
import { createApp, h, nextTick, reactive, Transition, vShow, withDirectives } from "vue";
import type { App } from "vue";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { useVolet } from "../../src/features/communs/volet";
import type { CrochetsVolet } from "../../src/features/communs/volet";

let app: App | null = null;
const etat = reactive({ ouvert: false });

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  etat.ouvert = false;
});

// happy-dom ne calcule pas l'affichage : un élément est visible si aucun ancêtre n'est en display:none.
beforeAll(() => {
  HTMLElement.prototype.checkVisibility = function (this: HTMLElement): boolean {
    return !this.closest('[style*="display: none"]');
  };
});

function bouton(texte: string, parent: HTMLElement = document.body): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = texte;
  parent.appendChild(b);
  return b;
}

// Monte le composable dans un composant ; `repli` est la partie affichée volet replié.
async function monter(repli?: HTMLElement): Promise<{ deplie: { value: boolean }; c: CrochetsVolet }> {
  let sortie: { deplie: { value: boolean }; c: CrochetsVolet } | null = null;
  app = createApp({
    setup() {
      const { deplie, crochets } = useVolet(
        () => etat.ouvert,
        () => repli,
      );
      sortie = { deplie, c: crochets };
      return () => null;
    },
  });
  app.mount(document.createElement("div"));
  await nextTick();
  if (!sortie) throw new Error("composable non monté");
  return sortie;
}

describe("useVolet : largeur", () => {
  it("déplié dès l'ouverture, replié seulement après la sortie du contenu", async () => {
    const { deplie, c } = await monter();
    const contenu = document.createElement("div");
    etat.ouvert = true;
    expect(deplie.value).toBe(true);
    c.onBeforeEnter();
    etat.ouvert = false;
    c.onBeforeLeave(contenu);
    await nextTick();
    expect(deplie.value).toBe(true);
    c.onAfterLeave();
    expect(deplie.value).toBe(false);
  });

  it("rouvert pendant la sortie : reste déplié ; une sortie qui finit volet rouvert ne replie rien", async () => {
    const { deplie, c } = await monter();
    const contenu = document.createElement("div");
    etat.ouvert = true;
    c.onBeforeEnter();
    etat.ouvert = false;
    c.onBeforeLeave(contenu);
    etat.ouvert = true;
    c.onAfterLeave();
    c.onBeforeEnter();
    expect(deplie.value).toBe(true);
    etat.ouvert = false;
    expect(deplie.value).toBe(true);
  });

  it("ouvert puis refermé avant tout rendu (contenu jamais affiché) : replié sur-le-champ", async () => {
    const { deplie } = await monter();
    etat.ouvert = true;
    expect(deplie.value).toBe(true);
    etat.ouvert = false;
    expect(deplie.value).toBe(false);
  });
});

describe("useVolet : focus", () => {
  it("volet à droite : le déclencheur garde le focus à l'ouverture et le retrouve à la fermeture depuis le volet", async () => {
    const declencheur = bouton("MCP");
    const contenu = document.createElement("div");
    const fermer = bouton("Fermer", contenu);
    document.body.appendChild(contenu);
    const { c } = await monter();
    declencheur.focus();
    etat.ouvert = true;
    c.onBeforeEnter();
    c.onEnter(contenu);
    expect(document.activeElement).toBe(declencheur);
    fermer.focus();
    etat.ouvert = false;
    c.onBeforeLeave(contenu);
    expect(document.activeElement).toBe(declencheur);
  });

  it("fermé par une bascule hors du volet : le focus reste où il est", async () => {
    const declencheur = bouton("MCP");
    const contenu = document.createElement("div");
    bouton("Fermer", contenu);
    document.body.appendChild(contenu);
    const { c } = await monter();
    declencheur.focus();
    etat.ouvert = true;
    c.onBeforeEnter();
    etat.ouvert = false;
    c.onBeforeLeave(contenu);
    c.onAfterLeave();
    await nextTick();
    expect(document.activeElement).toBe(declencheur);
  });

  it("rail : le déclencheur masqué à l'ouverture passe le focus au volet, qui le lui rend après sa sortie", async () => {
    const rail = document.createElement("div");
    const ouvrir = bouton("Ouvrir le panneau", rail);
    const contenu = document.createElement("div");
    const reduire = bouton("Réduire le panneau", contenu);
    document.body.append(rail, contenu);
    const { c } = await monter(rail);
    ouvrir.focus();
    etat.ouvert = true;
    rail.style.display = "none";
    c.onBeforeEnter();
    c.onEnter(contenu);
    expect(document.activeElement).toBe(reduire);
    etat.ouvert = false;
    c.onBeforeLeave(contenu);
    expect(document.activeElement).toBe(reduire);
    contenu.style.display = "none";
    rail.style.display = "";
    c.onAfterLeave();
    await nextTick();
    expect(document.activeElement).toBe(ouvrir);
  });

  it("rail ouvert au chargement : à la fermeture, le focus va au premier bouton du rail", async () => {
    etat.ouvert = true;
    const rail = document.createElement("div");
    rail.style.display = "none";
    const ouvrir = bouton("Ouvrir le panneau", rail);
    const contenu = document.createElement("div");
    const reduire = bouton("Réduire le panneau", contenu);
    document.body.append(rail, contenu);
    const { c } = await monter(rail);
    reduire.focus();
    etat.ouvert = false;
    c.onBeforeLeave(contenu);
    contenu.style.display = "none";
    rail.style.display = "";
    c.onAfterLeave();
    await nextTick();
    expect(document.activeElement).toBe(ouvrir);
  });
});

describe('useVolet dans <Transition name="volet"> (v-show)', () => {
  it("la largeur suit la fin de la sortie posée par la transition", async () => {
    app = createApp({
      setup() {
        const v = useVolet(() => etat.ouvert);
        return () =>
          h("aside", { style: { width: v.deplie.value ? "260px" : "48px" } }, [
            h(Transition, { name: "volet", persisted: true, ...v.crochets }, () => [
              withDirectives(h("div", { class: "contenu" }, "historique"), [[vShow, etat.ouvert]]),
            ]),
          ]);
      },
    });
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app.mount(hote);
    const aside = (): HTMLElement => hote.querySelector("aside") as HTMLElement;
    etat.ouvert = true;
    await nextTick();
    expect(aside().style.width).toBe("260px");
    etat.ouvert = false;
    await nextTick();
    expect(aside().style.width).toBe("260px");
    await expect.poll(() => aside().style.width, { timeout: 2000 }).toBe("48px");
    expect((hote.querySelector(".contenu") as HTMLElement).style.display).toBe("none");
  });
});
