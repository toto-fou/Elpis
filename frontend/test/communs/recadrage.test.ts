// SPDX-License-Identifier: MIT
/** frontend/test/communs/recadrage.test.ts — calculs du recadrage : borne de décodage, remplir et ajuster, bornes du zoom et du déplacement, zoom autour d'un foyer, quart de tour, curseur, transformation de dessin, clavier et format de sortie. */
import { describe, expect, it } from "vitest";

import {
  aDeLaTransparence,
  actionClavier,
  ajuster,
  borneDecodage,
  bornesZoom,
  COTE_DECODAGE_MAX,
  deplacer,
  echelleDuNiveau,
  etatInitial,
  niveauZoom,
  nomSortie,
  remplir,
  tourner,
  transformation,
  typeSortie,
  zoomer,
  zoomerPar,
  ZOOM_MAX,
} from "../../src/features/communs/recadrage";

const PAYSAGE = { largeur: 1000, hauteur: 500 };
const proche = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

describe("recadrage : décodage borné", () => {
  it("réduit au plus grand côté autorisé en gardant les proportions, laisse une petite image intacte", () => {
    expect(borneDecodage({ largeur: 8192, hauteur: 6144 })).toEqual({ largeur: 4096, hauteur: 3072 });
    expect(borneDecodage({ largeur: 3000, hauteur: 12000 })).toEqual({ largeur: 1024, hauteur: 4096 });
    expect(borneDecodage({ largeur: 640, hauteur: 480 })).toEqual({ largeur: 640, hauteur: 480 });
    expect(borneDecodage({ largeur: 100000, hauteur: 1 })).toEqual({
      largeur: COTE_DECODAGE_MAX,
      hauteur: 1,
    });
  });
});

describe("recadrage : cadre", () => {
  it("à l'ouverture, l'image couvre le cadre et reste centrée", () => {
    const e = etatInitial(PAYSAGE, 200);
    expect(e).toMatchObject({ echelle: 0.4, x: 0, y: 0, rotation: 0 });
  });

  it("Ajuster montre l'image entière, Remplir couvre le cadre, tous deux recentrent", () => {
    const e = deplacer(etatInitial(PAYSAGE, 200), 50, 0);
    expect(e.x).toBe(50);
    expect(ajuster(e)).toMatchObject({ echelle: 0.2, x: 0, y: 0 });
    expect(remplir(ajuster(e))).toMatchObject({ echelle: 0.4, x: 0, y: 0 });
  });

  it("le zoom reste entre Ajuster et huit fois Remplir", () => {
    const e = etatInitial(PAYSAGE, 200);
    expect(bornesZoom(e)).toEqual({ min: 0.2, max: 0.4 * ZOOM_MAX });
    expect(zoomer(e, 100).echelle).toBe(0.4 * ZOOM_MAX);
    expect(zoomer(e, 0.001).echelle).toBe(0.2);
  });

  it("le déplacement ne découvre jamais le cadre quand l'image le dépasse", () => {
    const e = etatInitial(PAYSAGE, 200);
    // Image affichée en 400 × 200 : 100 px de jeu horizontal, aucun vertical.
    expect(deplacer(e, 500, 30)).toMatchObject({ x: 100, y: 0 });
    expect(deplacer(e, -500, -30)).toMatchObject({ x: -100, y: 0 });
  });

  it("une image plus petite que le cadre reste dedans", () => {
    const e = ajuster(etatInitial(PAYSAGE, 200));
    // 200 × 100 : pile la largeur, 50 px de jeu vertical.
    expect(deplacer(e, 30, 500)).toMatchObject({ x: 0, y: 50 });
  });

  it("zoom autour d'un foyer : le point de l'image sous le foyer ne bouge pas", () => {
    const e = etatInitial(PAYSAGE, 200);
    const foyer = { x: 60, y: 20 };
    const z = zoomerPar(e, 2, foyer);
    expect(z.echelle).toBe(0.8);
    // Point de l'image sous le foyer, en px d'image, avant et après.
    const sous = (s: typeof e) => [(foyer.x - s.x) / s.echelle, (foyer.y - s.y) / s.echelle];
    const [a, b] = sous(e);
    const [c, d] = sous(z);
    expect(proche(a ?? 0, c ?? 1) && proche(b ?? 0, d ?? 1)).toBe(true);
  });

  it("quart de tour : dimensions échangées, décalage tourné autour du centre, quatre tours = départ", () => {
    const e = zoomerPar(etatInitial({ largeur: 400, hauteur: 400 }, 200), 2);
    const decale = deplacer(e, 40, 10);
    const t = tourner(decale, 1);
    expect(t).toMatchObject({ rotation: 90, x: -10, y: 40 });
    expect(tourner(t, -1)).toMatchObject({ rotation: 0, x: 40, y: 10 });
    let r = decale;
    for (let i = 0; i < 4; i++) r = tourner(r, 1);
    expect(r).toMatchObject({ rotation: 0, x: 40, y: 10 });
    const p = tourner(etatInitial(PAYSAGE, 200), -1);
    expect(p.rotation).toBe(270);
    // Portrait de 500 × 1000 : le jeu passe à la verticale.
    expect(deplacer(p, 300, 300)).toMatchObject({ x: 0, y: 100 });
  });

  it("curseur logarithmique : 0 = Ajuster, 1 = zoom maximal, aller-retour exact", () => {
    const e = etatInitial(PAYSAGE, 200);
    expect(niveauZoom(ajuster(e))).toBe(0);
    expect(niveauZoom(zoomer(e, 1000))).toBe(1);
    const n = niveauZoom(e);
    expect(proche(echelleDuNiveau(e, n), e.echelle)).toBe(true);
    expect(echelleDuNiveau(e, 2)).toBeCloseTo(bornesZoom(e).max, 12);
  });
});

describe("recadrage : sortie", () => {
  it("la transformation ramène le cadre au canevas de sortie (centre, angle, échelle)", () => {
    const e = deplacer(zoomerPar(etatInitial(PAYSAGE, 200), 2), 40, 20);
    expect(transformation(e, 512)).toEqual({
      tx: 256 + 40 * 2.56,
      ty: 256 + 20 * 2.56,
      angle: 0,
      echelle: 0.8 * 2.56,
    });
    const t = transformation(tourner(e, 1), 300, 200);
    expect(t.angle).toBeCloseTo(Math.PI / 2, 12);
    expect(t.echelle).toBe(0.8);
  });

  it("PNG si un pixel n'est pas opaque, WebP sinon ; extension suivant le type réellement produit", () => {
    expect(aDeLaTransparence(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false);
    expect(aDeLaTransparence(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(true);
    expect(typeSortie(true)).toBe("image/png");
    expect(typeSortie(false)).toBe("image/webp");
    expect(nomSortie("image/webp", "avatar")).toBe("avatar.webp");
    expect(nomSortie("image/png", "logo")).toBe("logo.png");
  });

  it("clavier : flèches (Maj : pas large), + et -, Échap ; le reste est ignoré", () => {
    expect(actionClavier("ArrowLeft", false)).toEqual({ type: "deplacer", dx: -10, dy: 0 });
    expect(actionClavier("ArrowDown", true)).toEqual({ type: "deplacer", dx: 0, dy: 50 });
    expect(actionClavier("+", false)).toEqual({ type: "zoom", facteur: 1.1 });
    expect(actionClavier("-", false)).toEqual({ type: "zoom", facteur: 1 / 1.1 });
    expect(actionClavier("Escape", false)).toEqual({ type: "annuler" });
    expect(actionClavier("a", false)).toBeNull();
  });
});
