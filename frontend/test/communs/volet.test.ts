// SPDX-License-Identifier: MIT
/** frontend/test/communs/volet.test.ts — volet coulissant : largeur qui suit le geste (posée après la sortie en mouvement réduit), contenu gardé jusqu'à la fin de sa sortie (ouvertures et fermetures enchaînées comprises), largeur animée d'un panneau racine de la transition, focus passé au volet quand son déclencheur disparaît, rendu au déclencheur ou au rail à la fermeture. */
/* eslint-disable vue/one-component-per-file -- hôtes de montage du composable testé */
import { createApp, effectScope, h, nextTick, reactive, Transition, vShow, withDirectives } from "vue";
import type { App } from "vue";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { accompagnerVolets, useVolet } from "../../src/features/communs/volet";
import type { CrochetsVolet } from "../../src/features/communs/volet";

let app: App | null = null;
const etat = reactive({ ouvert: false });

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  etat.ouvert = false;
  vi.unstubAllGlobals();
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
interface Monte {
  deplie: { value: boolean };
  large: { value: boolean };
  c: CrochetsVolet;
}
async function monter(repli?: HTMLElement): Promise<Monte> {
  let sortie: Monte | null = null;
  app = createApp({
    setup() {
      const { deplie, large, crochets } = useVolet(
        () => etat.ouvert,
        () => repli,
      );
      sortie = { deplie, large, c: crochets };
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

describe("useVolet : largeur qui glisse", () => {
  it("la largeur suit le geste tout de suite, le contenu reste jusqu'à la fin de sa sortie", async () => {
    const { deplie, large, c } = await monter();
    etat.ouvert = true;
    expect([deplie.value, large.value]).toEqual([true, true]);
    c.onBeforeEnter();
    etat.ouvert = false;
    expect([deplie.value, large.value]).toEqual([true, false]);
    c.onAfterLeave();
    expect([deplie.value, large.value]).toEqual([false, false]);
  });

  it("mouvement réduit : la largeur ne se replie qu'après la sortie du contenu", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const { deplie, large, c } = await monter();
    etat.ouvert = true;
    c.onBeforeEnter();
    etat.ouvert = false;
    expect([deplie.value, large.value]).toEqual([true, true]);
    c.onAfterLeave();
    expect([deplie.value, large.value]).toEqual([false, false]);
  });

  // Panneau de 280 px (par défaut) dont l'animation est enregistrée ; `cancel`, `finish` et `currentTime` suivent l'API des animations Web.
  function panneau(largeur = 280): {
    el: HTMLElement;
    jouees: {
      images: Keyframe[];
      options: KeyframeAnimationOptions;
      annulee: boolean;
      animation: { currentTime: number };
      finir(): void;
    }[];
  } {
    const el = document.createElement("div");
    el.className = "elpis-slide-panel";
    el.getBoundingClientRect = () => ({ width: largeur }) as DOMRect;
    const jouees: ReturnType<typeof panneau>["jouees"] = [];
    el.animate = ((images: Keyframe[], options: KeyframeAnimationOptions) => {
      const ecoutes: (() => void)[] = [];
      const animation = {
        currentTime: 0,
        cancel: () => (j.annulee = true),
        addEventListener: (_t: string, f: () => void) => ecoutes.push(f),
      };
      const j = { images, options, annulee: false, animation, finir: () => ecoutes.forEach((f) => f()) };
      jouees.push(j);
      return animation;
    }) as unknown as HTMLElement["animate"];
    return { el, jouees };
  }

  it("panneau racine de la transition : sa largeur glisse de 0 à sa valeur, contenu tenu à la largeur finale, puis il reprend sa mise en page", async () => {
    const { c } = await monter();
    const { el, jouees } = panneau();
    etat.ouvert = true;
    c.onBeforeEnter();
    c.onEnter(el);
    expect(jouees).toHaveLength(1);
    expect(jouees[0]?.images.map((i) => i["width"])).toEqual(["0px", "280px"]);
    expect(el.classList.contains("volet-anime")).toBe(true);
    expect(el.style.getPropertyValue("--volet-largeur")).toBe("280px");
    jouees[0]?.finir();
    expect(el.classList.contains("volet-anime")).toBe(false);
  });

  it("à la sortie : la largeur glisse vers 0 et y reste jusqu'au retrait du panneau ; une racine qui n'est pas un panneau n'est pas animée", async () => {
    const { c } = await monter();
    const { el, jouees } = panneau();
    etat.ouvert = true;
    c.onBeforeEnter();
    etat.ouvert = false;
    c.onBeforeLeave(el);
    c.onLeave(el);
    expect(jouees[0]?.images.map((i) => i["width"])).toEqual(["280px", "0px"]);
    expect(jouees[0]?.options.fill).toBe("forwards");
    c.onAfterLeave(el);
    expect(jouees[0]?.annulee).toBe(true);
    expect(el.classList.contains("volet-anime")).toBe(false);
    const contenu = panneau();
    contenu.el.className = "";
    c.onEnter(contenu.el);
    expect(contenu.jouees).toHaveLength(0);
  });

  it("un panneau large glisse plus longtemps, jusqu'à une fois et demie la durée des autres", async () => {
    const { c } = await monter();
    const durees = (largeur: number): unknown[] => {
      const { el, jouees } = panneau(largeur);
      c.onEnter(el);
      jouees[0]?.finir();
      c.onLeave(el);
      return jouees.map((j) => j.options.duration);
    };
    expect(durees(280)).toEqual([260, 200]);
    expect(durees(550)).toEqual([260, 200]);
    expect(durees(660)).toEqual([312, 240]);
    expect(durees(830)).toEqual([390, 300]);
    expect(durees(1400)).toEqual([390, 300]);
  });

  it("bloc accompagné : sa largeur maximale glisse de la largeur d'avant à celle d'après le volet, à son rythme ; rien si elle n'a pas changé", async () => {
    const { c } = await monter();
    const { el, jouees } = panneau(830);
    const bloc = document.createElement("div");
    document.body.appendChild(bloc);
    bloc.style.maxWidth = "70%";
    // Volet presque arrivé (lecture de la mise en page finale) : 768 px ; avant : 967 px.
    bloc.getBoundingClientRect = () =>
      ({ width: (jouees.at(-1)?.animation.currentTime ?? 0) > 0 ? 768 : 967 }) as DOMRect;
    const glisses: { images: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
    bloc.animate = ((images: Keyframe[], options: KeyframeAnimationOptions) => {
      glisses.push({ images, options });
      return { cancel: () => undefined };
    }) as unknown as HTMLElement["animate"];
    const portee = effectScope();
    portee.run(() => accompagnerVolets(() => bloc));

    etat.ouvert = true;
    bloc.style.maxWidth = "48rem";
    c.onBeforeEnter();
    c.onEnter(el);
    await nextTick();
    expect(glisses).toEqual([
      { images: [{ maxWidth: "967px" }, { maxWidth: "768px" }], options: { duration: 390, easing: "ease" } },
    ]);
    expect(jouees[0]?.animation.currentTime).toBe(0);

    jouees[0]?.finir();
    etat.ouvert = false;
    c.onLeave(el);
    await nextTick();
    expect(glisses).toHaveLength(1);

    portee.stop();
    etat.ouvert = true;
    bloc.style.maxWidth = "70%";
    c.onEnter(el);
    await nextTick();
    expect(glisses).toHaveLength(1);
    bloc.remove();
  });

  it("mouvement réduit : aucune largeur animée", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const { c } = await monter();
    const { el, jouees } = panneau();
    c.onEnter(el);
    c.onLeave(el);
    expect(jouees).toHaveLength(0);
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
