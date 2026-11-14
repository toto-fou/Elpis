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

  // Panneau de 280 px (par défaut) dont l'animation est enregistrée ; `cancel`, `finish` et `finished` suivent l'API des animations Web.
  function panneau(largeur = 280): {
    el: HTMLElement;
    jouees: { images: Keyframe[]; options: KeyframeAnimationOptions; annulee: boolean; finir(): void }[];
  } {
    const el = document.createElement("div");
    el.className = "elpis-slide-panel";
    el.getBoundingClientRect = () => ({ width: largeur }) as DOMRect;
    const jouees: ReturnType<typeof panneau>["jouees"] = [];
    el.animate = ((images: Keyframe[], options: KeyframeAnimationOptions) => {
      const ecoutes: (() => void)[] = [];
      let arriver: () => void = () => undefined;
      const finished = new Promise<void>((ok) => (arriver = ok));
      const j = {
        images,
        options,
        annulee: false,
        finir: () => {
          ecoutes.forEach((f) => f());
          arriver();
        },
      };
      jouees.push(j);
      return {
        finished,
        cancel: () => (j.annulee = true),
        addEventListener: (_t: string, f: () => void) => ecoutes.push(f),
      };
    }) as unknown as HTMLElement["animate"];
    return { el, jouees };
  }
  const rien = (): void => undefined;

  it("panneau racine de la transition : sa largeur glisse de 0 à sa valeur, sa largeur finale et sa durée posées pour son contenu, puis il reprend sa mise en page", async () => {
    const { c } = await monter();
    const { el, jouees } = panneau();
    etat.ouvert = true;
    c.onBeforeEnter();
    c.onEnter(el);
    expect(jouees).toHaveLength(1);
    expect(jouees[0]?.images.map((i) => i["width"])).toEqual(["0px", "280px"]);
    expect(el.style.getPropertyValue("--volet-largeur")).toBe("280px");
    expect(el.style.getPropertyValue("--volet-duree")).toBe("260ms");
    jouees[0]?.finir();
    expect(el.style.getPropertyValue("--volet-duree")).toBe("");
    expect(jouees[0]?.annulee).toBe(true);
  });

  it("à la sortie : durée posée avant les classes de sortie, la largeur glisse vers 0 et y reste jusqu'au retrait ; la sortie finit avec elle", async () => {
    const { c } = await monter();
    const { el, jouees } = panneau(830);
    const fin = vi.fn();
    etat.ouvert = true;
    c.onBeforeEnter();
    etat.ouvert = false;
    c.onBeforeLeave(el);
    expect(el.style.getPropertyValue("--volet-duree")).toBe("300ms");
    expect(jouees).toHaveLength(0);
    c.onLeave(el, fin);
    expect(jouees[0]?.images.map((i) => i["width"])).toEqual(["830px", "0px"]);
    expect(jouees[0]?.options).toMatchObject({ duration: 300, fill: "forwards" });
    await new Promise((r) => setTimeout(r, 5));
    expect(fin).not.toHaveBeenCalled();
    jouees[0]?.finir();
    await nextTick();
    expect(fin).toHaveBeenCalledTimes(1);
    c.onAfterLeave(el);
    expect(jouees[0]?.annulee).toBe(true);
    expect(el.style.getPropertyValue("--volet-duree")).toBe("");
  });

  it("une racine qui n'est pas un panneau (contenu d'un rail) n'est pas animée : sa sortie finit avec sa transition", async () => {
    const { c } = await monter();
    const contenu = panneau();
    contenu.el.className = "";
    const fin = vi.fn();
    c.onEnter(contenu.el);
    c.onBeforeLeave(contenu.el);
    c.onLeave(contenu.el, fin);
    expect(contenu.jouees).toHaveLength(0);
    expect(contenu.el.style.getPropertyValue("--volet-duree")).toBe("");
    expect(fin).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 5));
    expect(fin).toHaveBeenCalledTimes(1);
  });

  it("un panneau large glisse plus longtemps, jusqu'à une fois et demie la durée des autres", async () => {
    const { c } = await monter();
    const durees = (largeur: number): unknown[] => {
      const { el, jouees } = panneau(largeur);
      c.onEnter(el);
      jouees[0]?.finir();
      c.onLeave(el, rien);
      return jouees.map((j) => j.options.duration);
    };
    expect(durees(280)).toEqual([260, 200]);
    expect(durees(550)).toEqual([260, 200]);
    expect(durees(660)).toEqual([312, 240]);
    expect(durees(830)).toEqual([390, 300]);
    expect(durees(1400)).toEqual([390, 300]);
  });

  it("bloc accompagné : sa largeur maximale glisse de sa largeur d'avant à la règle d'après, au rythme du volet ; rien si la règle n'a pas changé", async () => {
    const { c } = await monter();
    const { el, jouees } = panneau(830);
    // Colonne de 830 px dont 62 de marges intérieures : conteneur de 768 px.
    const colonne = document.createElement("div");
    colonne.style.padding = "0 31px";
    Object.defineProperty(colonne, "clientWidth", { value: 830 });
    const bloc = document.createElement("div");
    colonne.appendChild(bloc);
    document.body.appendChild(colonne);
    let largeur = 967;
    bloc.getBoundingClientRect = () => ({ width: largeur }) as DOMRect;
    bloc.style.maxWidth = "70%";
    const glisses: { images: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
    bloc.animate = ((images: Keyframe[], options: KeyframeAnimationOptions) => {
      glisses.push({ images, options });
      return { cancel: rien };
    }) as unknown as HTMLElement["animate"];
    const portee = effectScope();
    portee.run(() => accompagnerVolets(() => bloc));

    // Ouverture : la règle devient une longueur, départ en pixels.
    etat.ouvert = true;
    bloc.style.maxWidth = "48rem";
    c.onBeforeEnter();
    c.onEnter(el);
    await nextTick();
    expect(glisses).toEqual([
      { images: [{ maxWidth: "967px" }, { maxWidth: "48rem" }], options: { duration: 390, easing: "ease" } },
    ]);

    // Fermeture : la règle redevient une part du conteneur ; départ : cette part (537,6 px sur 768) plus l'écart en pixels.
    jouees[0]?.finir();
    largeur = 768;
    etat.ouvert = false;
    bloc.style.maxWidth = "70%";
    c.onBeforeLeave(el);
    c.onLeave(el, rien);
    await nextTick();
    expect(glisses[1]).toEqual({
      images: [{ maxWidth: "calc(70% + 230.4px)" }, { maxWidth: "70%" }],
      options: { duration: 300, easing: "ease" },
    });

    // Règle inchangée (autre volet), puis bloc désinscrit : rien.
    c.onAfterLeave(el);
    etat.ouvert = true;
    c.onEnter(el);
    await nextTick();
    portee.stop();
    etat.ouvert = false;
    bloc.style.maxWidth = "48rem";
    c.onLeave(el, rien);
    await nextTick();
    expect(glisses).toHaveLength(2);
    colonne.remove();
  });

  it("les largeurs relevées au geste ne servent pas à un geste suivant", async () => {
    const { c } = await monter();
    const { el } = panneau(830);
    const bloc = document.createElement("div");
    document.body.appendChild(bloc);
    bloc.style.maxWidth = "70%";
    const glisse = vi.fn(() => ({ cancel: rien }));
    bloc.animate = glisse as unknown as HTMLElement["animate"];
    const portee = effectScope();
    portee.run(() => accompagnerVolets(() => bloc));
    etat.ouvert = true;
    await new Promise((r) => setTimeout(r, 5));
    bloc.style.maxWidth = "48rem";
    c.onEnter(el);
    await nextTick();
    expect(glisse).not.toHaveBeenCalled();
    portee.stop();
    bloc.remove();
  });

  it("mouvement réduit : aucune largeur animée, la sortie finit avec la transition", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const { c } = await monter();
    const { el, jouees } = panneau();
    const fin = vi.fn();
    c.onEnter(el);
    c.onBeforeLeave(el);
    c.onLeave(el, fin);
    expect(jouees).toHaveLength(0);
    expect(el.style.getPropertyValue("--volet-duree")).toBe("");
    await new Promise((r) => setTimeout(r, 5));
    expect(fin).toHaveBeenCalledTimes(1);
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
