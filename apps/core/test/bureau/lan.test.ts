// SPDX-License-Identifier: MIT
/** apps/core/test/bureau/lan.test.ts — fonctions pures du bureau côté serveur rejouées sur les vecteurs Python : signature dHash de Pillow, recadrage, fusion a11y ⊕ vision, noms, lanceurs et installeurs à l'octet près. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { FlottantPy, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import pngjs from "pngjs";
import { describe, expect, it } from "vitest";

import {
  actionHint,
  agentSlug,
  b64decodePy,
  b64decodeStrict,
  bundleReadme,
  bundleRunBat,
  bundleRunSh,
  bundleSlug,
  clampTimeoutS,
  cropForRegion,
  elementImportance,
  frameSig,
  INSTALL_PS1_PYTHON,
  INSTALL_SH_PYTHON,
  installPs1,
  installSh,
  intOu,
  iou,
  mergeElements,
  normAppName,
  resolveAppTarget,
  runtimeRequirements,
  runtimeRequirementsNodeps,
  slugAuto,
  stripDataUrl,
} from "../../src/bureau";

type Issue = { valeur: string } | { erreur: string };

/** Seul écart voulu des installeurs (E35) : sondes HTTPS en GET au lieu de HEAD (405 côté app). */
function sondesEnGetVecteur(texte: string): string {
  return texte.split('--head "').join('-o /dev/null "').split("-Method Head -Uri").join("-Method Get -Uri");
}

const V = pyJsonLoads(
  readFileSync(new URL("../vecteurs/bureau-lan.json", import.meta.url), "utf-8"),
) as Record<string, unknown[][]>;
const RACINE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
const octets = (b64: unknown): Uint8Array => new Uint8Array(Buffer.from(String(b64), "base64"));
const nombre = (v: unknown): number => (v instanceof FlottantPy ? v.valeur : Number(v));

/** Résultat sérialisé comme `json.dumps(…, ensure_ascii=False)`, ou la seule présence d'une erreur. */
function issue(f: () => unknown): Issue {
  try {
    return { valeur: pyJsonDumps(f(), { ensureAscii: false }) };
  } catch (e) {
    return { erreur: (e as Error).name };
  }
}

/** Décodeurs JPEG différents (jpeg-js, libjpeg-turbo de Pillow) : quelques niveaux d'écart par canal. */
const ECART_JPEG = 8;

const sansType = (i: unknown): unknown => ("erreur" in (i as object) ? { erreur: true } : i);

/** Pixels RVBA d'un PNG (largeur, hauteur, sha256), comme `convert("RGBA").tobytes()`. */
function pixels(png: Uint8Array): [number, number, string] {
  const p = pngjs.PNG.sync.read(Buffer.from(png));
  return [p.width, p.height, createHash("sha256").update(p.data).digest("hex")];
}

describe("bureau (LAN) : images de l'agent", () => {
  it("signature dHash 64 bits identique à Pillow (convert L, resize bicubique 9×8)", async () => {
    const images = new Map(V["images"]!.map(([nom, b64]) => [nom as string, b64]));
    for (const [nom, attendu] of V["signatures"]!)
      expect(await frameSig(octets(images.get(nom as string))), String(nom)).toBe(attendu);
  });

  it("recadrage pour l'OCR : mêmes pixels que Pillow, capture d'origine si la zone est trop petite ou illisible", async () => {
    const images = new Map(V["images"]!.map(([nom, b64]) => [nom as string, b64]));
    for (const [nom, boite, attendu] of V["recadrages"]!) {
      const source = octets(images.get(nom as string));
      const sortie = await cropForRegion(source, boite as unknown[]);
      const message = `${String(nom)} ${JSON.stringify(boite)}`;
      if (Array.isArray(attendu) && String(attendu[2]).startsWith("rgba:")) {
        const p = pngjs.PNG.sync.read(Buffer.from(sortie));
        const ref = Buffer.from(String(attendu[2]).slice(5), "base64");
        expect([p.width, p.height], message).toEqual([attendu[0], attendu[1]]);
        expect(Math.max(...p.data.map((x, i) => Math.abs(x - (ref[i] ?? 0)))), message).toBeLessThanOrEqual(
          ECART_JPEG,
        );
        continue;
      }
      const vu =
        Buffer.compare(Buffer.from(sortie), Buffer.from(source)) === 0 ? "identique" : pixels(sortie);
      expect(vu, message).toEqual(attendu);
    }
  });

  it("base64 de Python : tolérant (hors alphabet ignoré) et strict (validate=True)", () => {
    for (const [s, tolerant, strict] of V["base64"]!) {
      const enc = (f: () => Uint8Array): unknown => {
        try {
          return { valeur: Buffer.from(f()).toString("base64") };
        } catch {
          return { erreur: true };
        }
      };
      expect(
        enc(() => b64decodePy(s as string)),
        JSON.stringify(s),
      ).toEqual(sansType(tolerant));
      expect(
        enc(() => b64decodeStrict(s as string)),
        JSON.stringify(s),
      ).toEqual(sansType(strict));
    }
    for (const [s, attendu] of V["data_urls"]!) expect(stripDataUrl(s as string)).toBe(attendu);
  });
});

describe("bureau (LAN) : fusion des éléments", () => {
  it("a11y ⊕ vision : boîtes, centres, indices d'action, libellés fabriqués, erreurs de type", () => {
    for (const [a, v, attendu] of V["fusions"]!)
      expect(sansType(issue(() => mergeElements(a, v as unknown[]))), JSON.stringify([a, v])).toEqual(
        sansType(attendu),
      );
  });

  it("indice d'action, IoU, importance", () => {
    for (const [r, p, attendu] of V["indices"]!)
      expect(sansType(issue(() => actionHint(r, p))), JSON.stringify([r, p])).toEqual(sansType(attendu));
    for (const [a, b, attendu] of V["ious"]!) expect(iou(a as number[], b as number[])).toBe(nombre(attendu));
    for (const [e, attendu] of V["importances"]!)
      expect(sansType(issue(() => elementImportance(e))), JSON.stringify(e)).toEqual(sansType(attendu));
  });
});

describe("bureau (LAN) : noms", () => {
  it("applications amicales → cible lançable (Windows seulement), nom normalisé", () => {
    for (const [a, o, cible, norme] of V["applis"]!) {
      expect(
        issue(() => resolveAppTarget(a, o as string)),
        JSON.stringify([a, o]),
      ).toEqual(cible);
      expect(
        issue(() => normAppName(a)),
        JSON.stringify(a),
      ).toEqual(norme);
    }
  });

  it("slugs des scripts (Studio, dépôt sur l'agent, paquet)", () => {
    for (const [n, slug, agent, paquet] of V["noms"]!) {
      expect(slugAuto(n), JSON.stringify(n)).toBe(slug);
      expect(agentSlug(n), JSON.stringify(n)).toBe(agent);
      expect(bundleSlug(n), JSON.stringify(n)).toBe(paquet);
    }
  });

  it("slug : tirets de bord retirés sans regex, même sur une très longue entrée", () => {
    expect(slugAuto(`${"-".repeat(50_000)}a${"!".repeat(50_000)}b-`)).toBe("a-b");
    expect(slugAuto("--- !!! ---")).toBe("automatisation");
  });

  it("entiers tolérants et budget de matrice borné", () => {
    for (const [v, budget, entier] of V["temps"]!) {
      expect(sansType(issue(() => clampTimeoutS(v))), JSON.stringify(v)).toEqual(sansType(budget));
      expect(sansType(issue(() => intOu(v, 600))), JSON.stringify(v)).toEqual(sansType(entier));
    }
    for (const [v, attendu] of V["entiers"]!)
      expect(sansType(issue(() => intOu(v, -1))), JSON.stringify(v)).toEqual(sansType(attendu));
  });
});

describe("bureau (LAN) : scripts servis à l'octet près", () => {
  it("lanceurs et README du paquet d'automatisation", () => {
    for (const [slug, bat, sh] of V["lanceurs"]!) {
      expect(bundleRunBat(slug as string)).toBe(bat);
      expect(bundleRunSh(slug as string)).toBe(sh);
    }
    for (const [slug, os, w, attendu] of V["lisez_moi"]!)
      expect(bundleReadme(slug as string, os as string, w as boolean)).toBe(attendu);
  });

  it("dépendances du runtime (serveur HTTP de l'agent retiré), repli sans fichier", async () => {
    for (const [reel, os, req, nodeps] of V["exigences"]!) {
      if (reel !== "True") {
        const absent = path.join(RACINE, "absent");
        expect(await runtimeRequirements(absent, os as string)).toBe(req);
        expect(await runtimeRequirementsNodeps(absent, os as string)).toBe(nodeps);
        continue;
      }
      // Fichiers réels du dépôt (dépendances figées depuis le vecteur) : le serveur seul retiré, le reste dans l'ordre.
      const base = path.join(RACINE, "desktop-agent");
      const nom = os === "linux" ? "linux" : "windows";
      const source = readFileSync(path.join(base, `requirements-${nom}.txt`), "utf-8").split("\n");
      const serveur = (l: string): boolean => /^\s*(fastapi|uvicorn)/iu.test(l);
      expect(source.some(serveur), nom).toBe(true);
      const obtenu = await runtimeRequirements(base, os as string);
      expect(
        obtenu.split("\n").filter((l) => l.trim()),
        nom,
      ).toEqual(source.filter((l) => l.trim() && !serveur(l)));
      expect(await runtimeRequirementsNodeps(base, os as string)).toBe(
        readFileSync(path.join(base, `requirements-${nom}-nodeps.txt`), "utf-8"),
      );
    }
  });

  it("install.sh et install.ps1 identiques au Python ; le .ps1 reste 100 % ASCII", () => {
    for (const [base, sh, ps1] of V["installeurs"]!) {
      const b = (gabarit: string): string => gabarit.replaceAll("__BASE__", () => String(base));
      expect(b(INSTALL_SH_PYTHON), String(base)).toBe(sh);
      expect(b(INSTALL_PS1_PYTHON), String(base)).toBe(ps1);
      expect(installSh(base as string), String(base)).toBe(sondesEnGetVecteur(String(sh)));
      expect(installPs1(base as string), String(base)).toBe(sondesEnGetVecteur(String(ps1)));
      expect(installSh(base as string)).not.toMatch(/--head|-Method Head/);
      expect(installPs1(base as string)).not.toMatch(/--head|-Method Head/);
      expect(/^[\p{ASCII}]*$/u.test(installPs1(base as string))).toBe(true);
    }
  });
});
