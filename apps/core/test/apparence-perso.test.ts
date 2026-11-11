// SPDX-License-Identifier: MIT
/** apps/core/test/apparence-perso.test.ts — vecteurs du moteur des habillages personnels : skin valide, injections, liste blanche, requis, alpha, contraste, dérivations, darkBase, taille, spécificité. */
import { readFileSync } from "node:fs";

import { analyse } from "@elpis/commun/couleurs";
import { describe, expect, it } from "vitest";

import {
  couleurAdmise,
  deriver,
  evaluerSkinPerso,
  JETONS_DERIVES_ETAT,
  JETONS_PERSO,
  JETONS_REQUIS,
  MAX_PERSO_OCTETS,
  rayonAdmis,
  verifierSkinPerso,
} from "../src/apparence/perso";

const CLAIR = {
  "--app-bg": "#f1f5f9",
  "--surface": "#ffffff",
  "--text-900": "#0f172a",
  "--text-600": "#475569",
  "--border": "#e2e8f0",
  "--accent": "#2563eb",
  "--rail-bg": "#0f172a",
  "--rail-text": "#cbd5e1",
};
const SOMBRE = {
  "--app-bg": "#1e1e1e",
  "--surface": "#252526",
  "--text-900": "#f8fafc",
  "--text-600": "#cbd5e1",
  "--border": "rgba(255, 255, 255, 0.10)",
  "--accent": "#60a5fa",
  "--rail-bg": "#0b1120",
  "--rail-text": "#cbd5e1",
};
const base = (): Record<string, unknown> => ({
  id: "mon-style",
  label: "Mon style",
  desc: "Essai",
  tokens: { light: { ...CLAIR }, dark: { ...SOMBRE } },
});
const avec = (mode: "light" | "dark", jetons: Record<string, string>): Record<string, unknown> => {
  const m = base();
  const t = m["tokens"] as Record<string, Record<string, string>>;
  t[mode] = { ...t[mode], ...jetons };
  return m;
};

describe("habillage personnel : cas valide", () => {
  it("accepte le jeu minimal, dérive le reste et génère la feuille", () => {
    const { rapport, manifeste } = evaluerSkinPerso(base());
    expect(rapport.erreurs).toEqual([]);
    expect(rapport.ok).toBe(true);
    expect(manifeste).toMatchObject({ id: "mon-style", label: "Mon style", darkBase: false });
    expect(manifeste?.["swatch"]).toEqual(["#0f172a", "#f1f5f9", "#2563eb"]);
    expect(rapport.contrastes.length).toBeGreaterThan(10);
    expect(rapport.contrastes.every((c) => c.ok)).toBe(true);
    expect(new Set(rapport.contrastes.map((c) => c.mode))).toEqual(new Set(["light", "dark"]));
    expect(rapport.css).toContain("body.elpis-skin-perso {");
    expect(rapport.css).toContain("body.elpis-skin-perso.elpis-app-dark {");
    expect(rapport.css).toContain("--accent-fg:");
    expect(rapport.css).not.toMatch(/url\(|var\(--(?!radius)/);
  });
  it("verifierSkinPerso rend le même rapport", () => {
    expect(verifierSkinPerso(base()).ok).toBe(true);
  });
  it("les jetons requis sont tous dans la liste blanche", () => {
    for (const k of JETONS_REQUIS) expect(JETONS_PERSO).toContain(k);
    expect(JETONS_PERSO.length).toBeGreaterThanOrEqual(30);
  });
});

describe("habillage personnel : injections et grammaire", () => {
  const MAUVAISES = [
    "url(https://x.test/a.png)",
    "#fff;}body{display:none",
    "#fff</style><script>",
    "expression(alert(1))",
    "var(--accent)",
    "#fff\\",
    "#fff /* x */",
    "red",
    "rgb(var(--x), 0, 0)",
    "rgb(300, 0, 0)",
    "#12345",
    "calc(1px + 2px)",
    "oklch(0.5 0.1 200)",
  ];
  it.each(MAUVAISES)("refuse %s comme couleur", (v) => {
    const r = verifierSkinPerso(avec("light", { "--accent": v }));
    expect(r.ok).toBe(false);
    expect(r.css).toBe("");
  });
  it("accepte les formes de couleur numériques", () => {
    for (const v of [
      "#fff",
      "#ffff",
      "#ffffff",
      "#ffffff80",
      "rgb(1,2,3)",
      "rgba(1 2 3 / 50%)",
      "hsl(210, 40%, 50%)",
      "hsla(210deg 40% 50% / .5)",
    ])
      expect(couleurAdmise(v), v).toBe(true);
  });
  it("rayon : 0 à 32px ou 2rem", () => {
    for (const v of ["0", "8px", "32px", "0.5rem", "2rem"]) expect(rayonAdmis(v), v).toBe(true);
    for (const v of ["33px", "2.5rem", "-1px", "1em", "8", "var(--x)", "8px;"])
      expect(rayonAdmis(v), v).toBe(false);
  });
  it("refuse un rayon hors borne", () => {
    expect(verifierSkinPerso(avec("light", { "--radius": "40px" })).ok).toBe(false);
    expect(verifierSkinPerso(avec("light", { "--radius": "12px" })).ok).toBe(true);
  });
  it("refuse une clé hors liste, un jeton non préfixé et des clés interdites", () => {
    expect(verifierSkinPerso(avec("light", { "--toast-bg": "#000000" })).erreurs.join()).toContain(
      "hors de la liste",
    );
    expect(verifierSkinPerso(avec("light", { color: "#000000" })).ok).toBe(false);
    for (const cle of ["css", "brand", "mascot", "assets"]) {
      const m = { ...base(), [cle]: cle === "css" ? "skin.css" : {} };
      expect(verifierSkinPerso(m).erreurs.join()).toContain("interdite");
    }
    expect(verifierSkinPerso({ ...base(), autre: 1 }).ok).toBe(false);
  });
  it("refuse tokens malformés et valeurs non texte", () => {
    expect(verifierSkinPerso({ ...base(), tokens: "x" }).ok).toBe(false);
    expect(verifierSkinPerso({ ...base(), tokens: { light: CLAIR, dark: SOMBRE, autre: {} } }).ok).toBe(
      false,
    );
    expect(verifierSkinPerso(avec("light", { "--accent": 12 as unknown as string })).ok).toBe(false);
    expect(verifierSkinPerso(null).ok).toBe(false);
    expect(verifierSkinPerso([]).ok).toBe(false);
  });
  it("refuse un identifiant invalide, un nom vide et une pastille douteuse", () => {
    expect(verifierSkinPerso({ ...base(), id: "Mauvais Id" }).ok).toBe(false);
    expect(verifierSkinPerso({ ...base(), id: "elpis" }).ok).toBe(false);
    expect(verifierSkinPerso({ ...base(), label: "" }).ok).toBe(false);
    expect(verifierSkinPerso({ ...base(), swatch: ["red", "#fff", "#000"] }).ok).toBe(false);
    expect(verifierSkinPerso({ ...base(), swatch: ["#111", "#fff", "#000"] }).ok).toBe(true);
    expect(verifierSkinPerso({ ...base(), desc: "x".repeat(201) }).ok).toBe(false);
  });
});

describe("habillage personnel : requis, alpha, contraste", () => {
  it("signale les jetons requis manquants, par mode", () => {
    const m = base();
    delete (m["tokens"] as { light: Record<string, string> }).light["--surface"];
    delete (m["tokens"] as { dark: Record<string, string> }).dark["--rail-text"];
    const e = verifierSkinPerso(m).erreurs.join("\n");
    expect(e).toContain("clairs requis manquants : --surface");
    expect(e).toContain("sombres requis manquants : --rail-text");
  });
  it("refuse le jeu sombre absent hors darkBase", () => {
    const m = base();
    delete (m["tokens"] as Record<string, unknown>)["dark"];
    expect(verifierSkinPerso(m).ok).toBe(false);
  });
  it("refuse l'alpha sur un fond ou un texte du cœur, l'admet sur une bordure", () => {
    expect(
      verifierSkinPerso(avec("light", { "--surface": "rgba(255,255,255,0.9)" })).erreurs.join(),
    ).toContain("transparence");
    expect(verifierSkinPerso(avec("light", { "--text-900": "#0f172acc" })).ok).toBe(false);
    expect(verifierSkinPerso(avec("light", { "--border": "rgba(0, 0, 0, 0.1)" })).ok).toBe(true);
  });
  it("bloque un texte sous 4,5:1 et un accent sous 3:1", () => {
    const faible = verifierSkinPerso(avec("light", { "--text-600": "#b0b0b0" }));
    expect(faible.ok).toBe(false);
    expect(faible.erreurs.join()).toContain("--text-600 / --surface");
    const jaune = verifierSkinPerso(avec("light", { "--accent": "#facc15" }));
    expect(jaune.contrastes.find((c) => c.paire === "--accent / --surface")).toMatchObject({
      ok: false,
      seuil: 3,
    });
    expect(jaune.ok).toBe(false);
    expect(faible.css).not.toBe("");
  });
  it("le rapport affiche un ratio jamais surestimé", () => {
    const c = verifierSkinPerso(base()).contrastes.find((x) => x.paire === "--text-900 / --surface");
    expect(c?.ratio).toBeGreaterThan(15);
  });
});

describe("habillage personnel : dérivations", () => {
  it("dérive la famille accent, le texte sur accent, la rampe et le rail", () => {
    const d = deriver(CLAIR);
    expect(d["--accent-fg"]).toBe("#ffffff");
    expect(d["--accent-ring"]).toBe("#2563eb");
    expect(d["--accent-strong"]).not.toBe(d["--accent"]);
    for (const k of [
      "--accent-surface",
      "--accent-border",
      "--surface-2",
      "--text-500",
      "--rail-muted",
      "--rail-bg-2",
      "--prose-link",
    ])
      expect(d[k], k).toMatch(/^#[0-9a-f]{6}$/);
    expect(d["--rail-hover"]).toMatch(/^rgba\(/);
  });
  it("choisit noir sur un accent clair et ne touche pas une valeur posée", () => {
    expect(deriver({ ...CLAIR, "--accent": "#fde047" })["--accent-fg"]).toBe("#000000");
    expect(deriver({ ...CLAIR, "--accent-fg": "#123456" })["--accent-fg"]).toBe("#123456");
  });
  it("rayon : l'échelle dérivée accompagne --radius", () => {
    const css = verifierSkinPerso(avec("light", { "--radius": "12px" })).css;
    expect(css).toContain("--radius-sm: calc(var(--radius) - 4px);");
    expect(css.match(/--radius: 12px/g)).toHaveLength(1);
  });
});

describe("habillage personnel : darkBase et taille", () => {
  it("un seul jeu sert aux deux modes", () => {
    const m = { ...base(), darkBase: true, tokens: { light: { ...SOMBRE } } };
    const { rapport, manifeste } = evaluerSkinPerso(m);
    expect(rapport.erreurs).toEqual([]);
    expect(new Set(rapport.contrastes.map((c) => c.mode))).toEqual(new Set(["light"]));
    expect(manifeste).toMatchObject({ darkBase: true, tokens: { light: SOMBRE, dark: {} } });
    const [clair, sombre] = rapport.css.split("body.elpis-skin-perso.elpis-app-dark {");
    expect(clair).toContain("--surface: #252526");
    expect(sombre).toContain("--surface: #252526");
  });
  it("ignore un jeu sombre superflu avec avertissement", () => {
    const r = verifierSkinPerso({ ...base(), darkBase: true, tokens: { light: SOMBRE, dark: CLAIR } });
    expect(r.ok).toBe(true);
    expect(r.avertissements.join()).toContain("ignoré");
  });
  it("refuse un manifeste de plus de 16 Ko", () => {
    const r = verifierSkinPerso({ ...base(), desc: "é".repeat(MAX_PERSO_OCTETS) });
    expect(r.ok).toBe(false);
    expect(r.erreurs.join()).toContain("16 Ko");
  });
  it("refuse un nom de plus de 40 caractères", () => {
    expect(verifierSkinPerso({ ...base(), label: "x".repeat(41) }).ok).toBe(false);
  });
});

describe("habillage personnel : spécificité contre style.css", () => {
  const CSS = readFileSync(new URL("../../../frontend/css/style.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const spec = (sel: string): [number, number, number] => {
    const classes = (sel.match(/\.[\w-]+|:(?!:)[\w-]+/g) ?? []).length;
    const elems = (sel.replace(/\.[\w-]+|:[\w-]+/g, "").match(/\b[a-z][\w-]*/gi) ?? []).length;
    return [0, classes, elems];
  };
  const cmp = (a: number[], b: number[]): number => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
  it("le bloc sombre l'emporte sur tout sélecteur de style.css posant un jeton de la liste", () => {
    const sombre = spec("body.elpis-skin-perso.elpis-app-dark");
    const clair = spec("body.elpis-skin-perso");
    for (const m of CSS.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      const pose = [...JETONS_PERSO, ...JETONS_DERIVES_ETAT].some((k) =>
        new RegExp(`${k}\\s*:`).test(m[2] ?? ""),
      );
      if (!pose) continue;
      for (const sel of (m[1] ?? "").split(",").map((s) => s.trim())) {
        expect(cmp(sombre, spec(sel)), sel).toBeGreaterThanOrEqual(0);
        expect(cmp(clair, spec(sel)), sel).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("habillage personnel : casse des fonctions de couleur", () => {
  it("RGB(255,255,255) en texte sur blanc est refusé pour contraste", () => {
    const r = verifierSkinPerso(avec("light", { "--text-600": "RGB(255,255,255)" }));
    expect(r.ok).toBe(false);
    expect(r.erreurs.join()).toContain("--text-600 / --surface");
  });
  it("RGBA(0,0,0,0) en surface est refusé pour transparence", () => {
    const r = verifierSkinPerso(avec("light", { "--surface": "RGBA(0,0,0,0)" }));
    expect(r.ok).toBe(false);
    expect(r.erreurs.join()).toContain("transparence");
  });
  it("les valeurs sont stockées en minuscules", () => {
    const { manifeste, rapport } = evaluerSkinPerso(
      avec("light", { "--border": "HSLA(0, 0%, 0%, 0.1)", "--accent": "#2563EB" }),
    );
    expect(rapport.ok).toBe(true);
    const clair = (manifeste?.["tokens"] as { light: Record<string, string> }).light;
    expect(clair["--border"]).toBe("hsla(0, 0%, 0%, 0.1)");
    expect(clair["--accent"]).toBe("#2563eb");
    expect(rapport.css).not.toMatch(/HSLA|#2563EB/);
  });
});

describe("habillage personnel : jetons d'état dérivés", () => {
  const ETATS = [
    "--ok-text",
    "--ok-text-strong",
    "--warn-text",
    "--warn-text-strong",
    "--danger-text",
    "--danger-strong",
  ];
  const ratio = (r: ReturnType<typeof verifierSkinPerso>, paire: string, mode: string): number =>
    r.contrastes.find((c) => c.paire === paire && c.mode === mode)?.ratio ?? 0;
  const SOMBRE_PLEIN = { ...SOMBRE, "--border": "#333333" };

  it("darkBase : les textes d'état tiennent 4,5:1 sur la surface sombre, en clair comme en sombre", () => {
    const r = verifierSkinPerso({ ...base(), darkBase: true, tokens: { light: SOMBRE_PLEIN } });
    expect(r.ok).toBe(true);
    for (const t of ETATS) {
      expect(ratio(r, `${t} / --surface`, "light"), t).toBeGreaterThanOrEqual(4.5);
      expect(ratio(r, `${t} / --app-bg`, "light"), t).toBeGreaterThanOrEqual(4.5);
    }
    expect(r.css).toContain("--danger-text:");
  });
  it("jeu clair sombre sans darkBase : le rouge du thème clair n'est pas repris tel quel", () => {
    const r = verifierSkinPerso({ ...base(), tokens: { light: SOMBRE_PLEIN, dark: SOMBRE_PLEIN } });
    expect(r.ok).toBe(true);
    expect(ratio(r, "--danger-text / --surface", "light")).toBeGreaterThanOrEqual(4.5);
    expect(r.css).not.toContain("#dc2626");
  });
  it("jeu clair : les textes d'état sont foncés, teinte du thème de base conservée, et mesurés", () => {
    const r = verifierSkinPerso(base());
    for (const t of ETATS) expect(ratio(r, `${t} / --surface`, "light"), t).toBeGreaterThanOrEqual(4.5);
    const d = deriver({ ...CLAIR });
    const [rouge, vert] = analyse(d["--danger-text"]) ?? [0, 255];
    expect(rouge).toBeGreaterThan(150);
    expect(vert).toBeLessThan(60);
    expect(d["--ok-fg"]).toBe("#ffffff");
  });
  it("texte et surface proches : le texte d'état est rapproché du texte principal", () => {
    const d = deriver({ ...CLAIR, "--surface": "#f5d0d0", "--app-bg": "#f5d0d0" });
    expect(d["--danger-text"]).not.toBe("#dc2626");
  });
  it("le survol du bouton principal tient 4,5:1 sous --accent-fg", () => {
    for (const accent of ["#2563eb", "#facc15", "#10b981", "#7c3aed"]) {
      const r = verifierSkinPerso(avec("light", { "--accent": accent }));
      const c = r.contrastes.find((x) => x.paire === "--accent-fg / --accent-strong");
      expect(c, accent).toBeDefined();
      if (r.contrastes.find((x) => x.paire === "--accent-fg / --accent")?.ok)
        expect(c?.ok, accent).toBe(true);
    }
  });
  it("--border-soft d'un trait transparent reste plus clair que le trait", () => {
    const d = deriver({ ...SOMBRE });
    expect(d["--border-soft"]).toBe("rgba(255, 255, 255, 0.05)");
  });
});

describe("habillage personnel : propriété de la feuille générée", () => {
  const ECHELLE = /^(?:var\(--radius\)|calc\(var\(--radius\) [-+] [24]px\))$/;
  const POOL = [
    "#fff",
    "#FFFFFF",
    "#12345678",
    "rgb(1,2,3)",
    "RGB(10 20 30 / 50%)",
    "hsla(120, 50%, 50%, 0.4)",
    "HSL(10 20% 30%)",
    "red",
    "url(http://x.test/a)",
    "#fff;}body{display:none",
    "#fff</style>",
    "var(--x)",
    "expression(1)",
    "rgb(1,2,3)\n}",
    "\\00",
    "8px",
    "2rem",
    "40px",
    "0",
    "calc(1px)",
    "é#fff",
    "",
  ];
  let graine = 12345;
  const alea = (n: number): number => {
    graine = (graine * 1103515245 + 12345) & 0x7fffffff;
    return graine % n;
  };
  const cles = [...JETONS_PERSO, "--toast-bg", "color", "--x;y", "--a{}"];

  it("toute déclaration est « --jeton: valeur de la grammaire; » sans autre caractère", () => {
    let feuilles = 0;
    for (let i = 0; i < 400; i++) {
      const clair: Record<string, string> = { ...CLAIR };
      const sombre: Record<string, string> = { ...SOMBRE };
      for (let k = alea(8); k > 0; k--) {
        const jeu = alea(2) ? clair : sombre;
        jeu[cles[alea(cles.length)] ?? "--accent"] = POOL[alea(POOL.length)] ?? "";
      }
      const { css } = verifierSkinPerso({
        id: "prop",
        label: "Prop",
        darkBase: alea(4) === 0,
        tokens: { light: clair, dark: sombre },
      });
      if (!css) continue;
      feuilles++;
      for (const ligne of css.split("\n")) {
        if (ligne === "" || ligne === "}" || ligne.startsWith("/* Habillage personnel « prop »")) continue;
        if (ligne === "body.elpis-skin-perso {" || ligne === "body.elpis-skin-perso.elpis-app-dark {")
          continue;
        const m = /^ {4}(--[a-z0-9-]+): ([^;]+);$/.exec(ligne);
        expect(m, ligne).not.toBeNull();
        const [, cle, valeur = ""] = m ?? [];
        const permise = couleurAdmise(valeur) || rayonAdmis(valeur) || ECHELLE.test(valeur);
        expect(permise, `${cle}: ${valeur}`).toBe(true);
      }
    }
    expect(feuilles).toBeGreaterThan(50);
  });
});
