// SPDX-License-Identifier: MIT
/** apps/core/test/pages.test.ts — pages coquilles : vecteurs (versions, vendor), cache sur l'état du disque, empreintes des fichiers, entrées Vite, en-tête CSP. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  MANIFESTE_WEB,
  Pages,
  balisesEntree,
  enteteCsp,
  modeCsp,
  POLITIQUE_CSP,
  SCRIPT_HABILLAGE,
} from "../src/interface/pages";
import { empreinteFichier } from "../src/interface/statiques";

const vecteurs = JSON.parse(readFileSync(new URL("./vecteurs/pages.json", import.meta.url), "utf-8")) as {
  fichiers: Record<string, string>;
  cas: { nom: string; page: string; sortie: string; lus: string[] }[];
};

const racine = mkdtempSync(join(tmpdir(), "elpis-pages-"));
const frontend = join(racine, "frontend");
mkdirSync(frontend, { recursive: true });
for (const [rel, contenu] of Object.entries(vecteurs.fichiers)) {
  mkdirSync(dirname(join(frontend, rel)), { recursive: true });
  writeFileSync(join(frontend, rel), contenu);
}

afterAll(() => {
  rmSync(racine, { recursive: true, force: true });
});

class PagesTemoin extends Pages {
  override empreinte(rel: string): string {
    return `fp(${rel})`;
  }
}

describe("vecteurs de l'assemblage", () => {
  for (const c of vecteurs.cas) {
    it(c.nom, () => {
      const lus: string[] = [];
      expect(new PagesTemoin(frontend, "BUILD-42").assembler(c.page, lus)).toBe(c.sortie);
      expect(lus.map((p) => relative(racine, p))).toEqual(c.lus);
    });
  }
});

describe("rendu en cache", () => {
  it("relit la page quand elle change sur le disque, sinon sert le cache ; plus aucun @include assemblé", () => {
    const page = join(frontend, "index.html");
    writeFileSync(page, '<head><link href="static/css/x.css?v=1"></head><!-- @include includes/a.html -->');
    const pages = new Pages(frontend, "B1");
    const premier = pages.rendre("index.html");
    expect(premier).toContain('x.css?v=B1"');
    expect(premier).toContain("<!-- @include includes/a.html -->");
    expect(pages.rendre("index.html")).toBe(premier);
    writeFileSync(page, '<head><link href="static/css/y.css?v=9"></head>');
    utimesSync(page, new Date(), new Date(Date.now() + 5_000));
    expect(pages.rendre("index.html")).toContain('y.css?v=B1"');
  });

  it("empreinte : stable, propre au fichier, celle que /static/ sert immuable, BUILD_ID si absent", () => {
    mkdirSync(join(frontend, "vendor"), { recursive: true });
    writeFileSync(join(frontend, "vendor/a.js"), "a");
    const pages = new Pages(frontend, "B2");
    const fp = pages.empreinte("vendor/a.js");
    expect(fp).toMatch(/^[0-9a-f]{10}$/);
    expect(pages.empreinte("vendor/a.js")).toBe(fp);
    expect(fp).toBe(empreinteFichier(statSync(join(frontend, "vendor/a.js"))));
    expect(pages.empreinte("vendor/absent.js")).toBe("B2");
  });

  it("feuille modifiée sans redémarrage : la page en cache est réassemblée avec sa nouvelle version", () => {
    mkdirSync(join(frontend, "css"), { recursive: true });
    const feuille = join(frontend, "css/vive.css");
    writeFileSync(feuille, "a{}");
    writeFileSync(join(frontend, "vive.html"), '<head><link href="static/css/vive.css?v=1"></head>');
    const pages = new Pages(frontend, "B5");
    const avant = pages.rendre("vive.html");
    expect(avant).toContain(`vive.css?v=${empreinteFichier(statSync(feuille))}"`);
    writeFileSync(feuille, "a{color:red}");
    utimesSync(feuille, new Date(), new Date(Date.now() + 5_000));
    const apres = pages.rendre("vive.html");
    expect(apres).not.toBe(avant);
    expect(apres).toContain(`vive.css?v=${empreinteFichier(statSync(feuille))}"`);
  });
});

describe("entrées Vite (@entree)", () => {
  const manifeste = {
    "src/entries/main.ts": {
      file: "assets/main-A1.js",
      isEntry: true,
      imports: ["_pont-B2.js", "_socle-C3.js"],
      css: ["assets/main-A1.css"],
    },
    "_pont-B2.js": { file: "assets/pont-B2.js", imports: ["_socle-C3.js"], css: ["assets/pont-B2.css"] },
    "_socle-C3.js": { file: "assets/socle-C3.js" },
  };
  const ecrireManifeste = (contenu: unknown, decalage = 0): void => {
    const chemin = join(frontend, MANIFESTE_WEB);
    mkdirSync(dirname(chemin), { recursive: true });
    writeFileSync(chemin, JSON.stringify(contenu));
    utimesSync(chemin, new Date(), new Date(Date.now() + decalage));
  };

  it("feuilles, préchargements du graphe statique puis le module, sans doublon", () => {
    expect(balisesEntree(manifeste, "main")).toBe(
      [
        '<link rel="stylesheet" href="static/dist/assets/main-A1.css">',
        '<link rel="stylesheet" href="static/dist/assets/pont-B2.css">',
        '<link rel="modulepreload" href="static/dist/assets/pont-B2.js">',
        '<link rel="modulepreload" href="static/dist/assets/socle-C3.js">',
        '<script type="module" src="static/dist/assets/main-A1.js"></script>',
      ].join("\n"),
    );
    expect(balisesEntree(manifeste, "admin")).toBeNull();
    expect(balisesEntree({ "src/entries/x.ts": { file: 'assets/x".js' } }, "x")).toBeNull();
    expect(balisesEntree({ "src/entries/x.ts": { file: "../../config.json" } }, "x")).toBeNull();
  });

  it("la page suit le manifeste du disque ; build absent ou nom invalide signalés", () => {
    writeFileSync(
      join(frontend, "entree.html"),
      '<head><!-- @entree main --><link rel="stylesheet" href="static/css/s.css?v=1"></head><!-- @entree ../x -->',
    );
    const pages = new Pages(frontend, "B3");
    rmSync(join(frontend, "dist"), { recursive: true, force: true });
    const sans = pages.rendre("entree.html");
    expect(sans).toContain("<!-- @entree: main absente du build -->");
    expect(sans).toContain("<!-- @entree: invalid name '../x' -->");
    expect(sans).not.toContain("static/dist/");
    expect(sans).not.toContain("<script");
    ecrireManifeste(manifeste, 5_000);
    const avec = pages.rendre("entree.html");
    expect(avec).toContain('<script type="module" src="static/dist/assets/main-A1.js"></script>');
    expect(avec).toContain('href="static/css/s.css?v=B3"');
    expect(avec.indexOf("main-A1.js")).toBeLessThan(avec.indexOf("static/css/s.css"));
    ecrireManifeste({ "src/entries/main.ts": { file: "assets/main-Z9.js" } }, 10_000);
    const neuf = pages.rendre("entree.html");
    expect(neuf).toContain("assets/main-Z9.js");
    expect(neuf).not.toContain("main-A1");
  });

  it("@habillage : le script autorisé par la CSP, tel quel, une fois par marqueur", () => {
    const html = new Pages(frontend, "B5").assembler("<head><!-- @habillage --></head><body></body>");
    expect(html).toBe(`<head><script>${SCRIPT_HABILLAGE}</script></head><body></body>`);
    expect(SCRIPT_HABILLAGE).not.toMatch(/<\/script|`|\$\{/i);
  });

  it("manifeste illisible : comme un build absent", () => {
    const chemin = join(frontend, MANIFESTE_WEB);
    mkdirSync(dirname(chemin), { recursive: true });
    writeFileSync(chemin, "{");
    const html = new Pages(frontend, "B4").assembler("<head></head><!-- @entree main -->");
    expect(html).toContain("<!-- @entree: main absente du build -->");
  });
});

describe("politique de sécurité du contenu (CSP)", () => {
  it("mode : enforce par défaut, report-only et off reconnus", () => {
    expect(modeCsp(undefined)).toBe("enforce");
    expect(modeCsp("n'importe")).toBe("enforce");
    expect(modeCsp("report-only")).toBe("report-only");
    expect(modeCsp("off")).toBe("off");
  });

  it("en-tête selon le mode ; aucun script évalué, en ligne seulement celui de l'habillage", () => {
    expect(enteteCsp("enforce")).toEqual({ "content-security-policy": POLITIQUE_CSP });
    expect(enteteCsp("report-only")).toEqual({ "content-security-policy-report-only": POLITIQUE_CSP });
    expect(enteteCsp("off")).toEqual({});
    const script = /(?:^|; )script-src ([^;]*)/.exec(POLITIQUE_CSP)?.[1] ?? "";
    const empreinte = createHash("sha256").update(SCRIPT_HABILLAGE).digest("base64");
    expect(script).toBe(`'self' 'sha256-${empreinte}'`);
    expect(POLITIQUE_CSP).not.toMatch(/unsafe-eval/);
    expect(POLITIQUE_CSP).toMatch(/object-src 'none'/);
    expect(POLITIQUE_CSP).toMatch(/frame-ancestors 'self'/);
    expect(POLITIQUE_CSP).not.toMatch(/https?:|\*/);
    expect(POLITIQUE_CSP.split("; ").map((d) => d.split(" ")[0])).toEqual([
      "default-src",
      "script-src",
      "style-src",
      "img-src",
      "media-src",
      "object-src",
      "base-uri",
      "frame-ancestors",
      "form-action",
    ]);
  });
});
