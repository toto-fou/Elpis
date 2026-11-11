// SPDX-License-Identifier: MIT
/** apps/core/test/rag/magasin.test.ts — magasin RAG : racine, chemins construits, formes refusées, liens et fichiers spéciaux refusés, suppressions confinées, noms Qdrant ; constantes égales aux contrats. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { EXTENSIONS_RAG, RE_UUID_RAG } from "@elpis/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  analyserNomQdrantRag,
  assurerRacineMagasinRag,
  creerDossiersCollectionRag,
  ErreurMagasinRag,
  estNomQdrantRag,
  estRelMagasinRag,
  EXTENSIONS_MAGASIN_RAG,
  nomQdrantRag,
  ouvrirDossierMagasinRag,
  racineMagasinRag,
  RE_UUID_MAGASIN_RAG,
  relCollectionRag,
  relCompteRag,
  relExtraitRag,
  relPageRag,
  relPagesRag,
  relPartielRag,
  relSourceRag,
  resoudreMagasinRag,
  supprimerDossierCollectionRag,
  supprimerDossierCompteRag,
} from "../../src/rag/magasin";

const C = "3f9a1c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const D = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

let dossier: string;
let racine: string;
let restaurer: () => void;

beforeAll(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-rag-magasin-"));
  restaurer = surchargerConfig({
    CONFIG_JSON_PATH: join(dossier, "config.json"),
    DB_PATH: join(dossier, "user_db", "app.db"),
  });
});

afterAll(() => {
  restaurer();
  rmSync(dossier, { recursive: true, force: true });
});

beforeEach(() => {
  racine = join(dossier, `magasin-${randomUUID()}`);
  writeFileSync(join(dossier, "config.json"), JSON.stringify({ rag: { store_dir: racine } }));
  invalidateConfigCache();
});

afterEach(() => {
  rmSync(racine, { recursive: true, force: true });
});

describe("constantes partagées avec @elpis/contracts", () => {
  it("extensions et forme des uuid identiques", () => {
    expect([...EXTENSIONS_MAGASIN_RAG]).toEqual([...EXTENSIONS_RAG]);
    expect(RE_UUID_MAGASIN_RAG.source).toBe(RE_UUID_RAG.source);
  });
});

describe("racine et chemins", () => {
  it("racine : `rag.store_dir`, sinon `<dossier de la base>/rag`", () => {
    expect(racineMagasinRag()).toBe(racine);
    writeFileSync(join(dossier, "config.json"), "{}");
    invalidateConfigCache();
    expect(racineMagasinRag()).toBe(join(dossier, "user_db", "rag"));
  });

  it("chemins construits d'identifiants validés", () => {
    expect(relCompteRag(7)).toBe("7");
    expect(relCollectionRag(7, C)).toBe(`7/${C}`);
    expect(relSourceRag(7, C, D, "pdf")).toBe(`7/${C}/sources/${D}.pdf`);
    expect(relPartielRag(7, C, D, "docx")).toBe(`7/${C}/sources/${D}.docx.part`);
    expect(relExtraitRag(7, C, D)).toBe(`7/${C}/extraits/${D}.json`);
    expect(relPagesRag(7, C, D)).toBe(`7/${C}/pages/${D}`);
    expect(relPageRag(7, C, D, 12)).toBe(`7/${C}/pages/${D}/12.webp`);
    for (const rel of [relSourceRag(7, C, D, "pdf"), relPartielRag(7, C, D, "md"), relPageRag(7, C, D, 1)])
      expect(estRelMagasinRag(rel), rel).toBe(true);
  });

  it("identifiants, extension ou page invalides : refus", () => {
    const essais: (() => unknown)[] = [
      () => relCompteRag(0),
      () => relCompteRag(-3),
      () => relCompteRag(1.5),
      () => relCompteRag("7" as unknown as number),
      () => relCollectionRag(7, C.toUpperCase()),
      () => relCollectionRag(7, ".."),
      () => relCollectionRag(7, `${C}/../x`),
      () => relSourceRag(7, C, D, "exe"),
      () => relSourceRag(7, C, D, ".pdf"),
      () => relSourceRag(7, C, D, "PDF"),
      () => relSourceRag(7, C, "../../etc/passwd", "pdf"),
      () => relPageRag(7, C, D, 0),
      () => relPageRag(7, C, D, 1.5),
    ];
    for (const [i, f] of essais.entries()) expect(f, `essai ${i}`).toThrow(ErreurMagasinRag);
  });

  it("formes hors liste refusées par la résolution", () => {
    for (const rel of [
      "",
      "/7",
      "07",
      "7/",
      "7/..",
      `7/${C}/..`,
      `7//${C}`,
      `7/${C}/autres`,
      `7/${C}/sources/${D}.pdf/x`,
      `7/${C}/sources/${D}.exe`,
      `7/${C}/extraits/${D}.txt`,
      `7/${C}/pages/${D}/0.webp`,
      `7/${C}/pages/${D}/1.png`,
      `7/${C.toUpperCase()}`,
      `7/${C}\0`,
    ]) {
      expect(estRelMagasinRag(rel), JSON.stringify(rel)).toBe(false);
      expect(() => resoudreMagasinRag(rel), JSON.stringify(rel)).toThrow(ErreurMagasinRag);
    }
  });
});

describe("résolution confinée et dossiers", () => {
  it("dossiers d'une collection créés en 0700 ; source résolue sous la racine", () => {
    creerDossiersCollectionRag(7, C);
    for (const sous of ["sources", "extraits", "pages"]) {
      const p = join(racine, "7", C, sous);
      expect(statSync(p).isDirectory()).toBe(true);
      expect(statSync(p).mode & 0o777).toBe(0o700);
    }
    const rel = relSourceRag(7, C, D, "pdf");
    writeFileSync(join(racine, rel), "%PDF");
    expect(resoudreMagasinRag(rel)).toBe(join(assurerRacineMagasinRag(), rel));
    expect(resoudreMagasinRag(relExtraitRag(7, C, D))).toBe(join(racine, relExtraitRag(7, C, D)));
  });

  it("racine absente : chemin rendu sans rien créer", () => {
    expect(resoudreMagasinRag(relCollectionRag(9, C))).toBe(join(racine, "9", C));
    expect(existsSync(racine)).toBe(false);
  });

  it("racine en lien posé par l'administrateur : suivie ; lien dessous : refusé", () => {
    const vraie = join(dossier, `vraie-${randomUUID()}`);
    mkdirSync(join(vraie, "7"), { recursive: true });
    symlinkSync(vraie, racine);
    try {
      expect(resoudreMagasinRag("7")).toBe(join(vraie, "7"));
      const ailleurs = mkdtempSync(join(dossier, "ailleurs-"));
      symlinkSync(ailleurs, join(vraie, "7", C));
      expect(() => resoudreMagasinRag(relSourceRag(7, C, D, "pdf"))).toThrow(/lien symbolique/u);
      expect(() => ouvrirDossierMagasinRag(`7/${C}/sources`, { creer: true })).toThrow();
      expect(readdirSync(ailleurs)).toEqual([]);
    } finally {
      rmSync(vraie, { recursive: true, force: true });
    }
  });

  it("feuille en lien ou fichier spécial : refusée ; dossier à la place d'un fichier : refusé", () => {
    creerDossiersCollectionRag(7, C);
    const source = relSourceRag(7, C, D, "pdf");
    symlinkSync("/etc/passwd", join(racine, source));
    expect(() => resoudreMagasinRag(source)).toThrow(/lien symbolique/u);
    const extrait = relExtraitRag(7, C, D);
    execFileSync("mkfifo", [join(racine, extrait)]);
    expect(() => resoudreMagasinRag(extrait)).toThrow(ErreurMagasinRag);
    const autre = relSourceRag(7, C, randomUUID(), "md");
    mkdirSync(join(racine, autre));
    expect(resoudreMagasinRag(autre)).toBe(join(racine, autre));
    writeFileSync(join(racine, "7", C, "pages", "x"), "");
    expect(() => ouvrirDossierMagasinRag(`7/${C}/pages/x`)).toThrow(ErreurMagasinRag);
  });

  it("dossier ouvert sans suivre de lien, descripteur rendu", () => {
    const fd = ouvrirDossierMagasinRag(relPagesRag(7, C, D), { creer: true });
    closeSync(fd);
    expect(statSync(join(racine, relPagesRag(7, C, D))).isDirectory()).toBe(true);
    expect(() => ouvrirDossierMagasinRag(relSourceRag(7, C, D, "pdf"))).toThrow(ErreurMagasinRag);
  });

  it("suppressions : collection puis compte ; absent = faux ; lien à la place refusé, cible intacte", async () => {
    creerDossiersCollectionRag(7, C);
    writeFileSync(join(racine, relSourceRag(7, C, D, "pdf")), "%PDF");
    const autre = randomUUID();
    creerDossiersCollectionRag(7, autre);
    expect(await supprimerDossierCollectionRag(7, C)).toBe(true);
    expect(existsSync(join(racine, "7", C))).toBe(false);
    expect(existsSync(join(racine, "7", autre))).toBe(true);
    expect(await supprimerDossierCollectionRag(7, C)).toBe(false);
    expect(await supprimerDossierCompteRag(7)).toBe(true);
    expect(existsSync(join(racine, "7"))).toBe(false);
    expect(await supprimerDossierCompteRag(7)).toBe(false);
    const cible = mkdtempSync(join(dossier, "cible-"));
    writeFileSync(join(cible, "garde.txt"), "x");
    mkdirSync(racine, { recursive: true });
    symlinkSync(cible, join(racine, "8"));
    await expect(supprimerDossierCompteRag(8)).rejects.toThrow(/lien symbolique/u);
    expect(readdirSync(cible)).toEqual(["garde.txt"]);
  });
});

describe("noms Qdrant", () => {
  it("`elpis_<uuid sans tirets>`, génération suffixée, aller-retour", () => {
    const hex = C.replaceAll("-", "");
    expect(nomQdrantRag(C)).toBe(`elpis_${hex}`);
    expect(nomQdrantRag(C, 3)).toBe(`elpis_${hex}_g3`);
    expect(analyserNomQdrantRag(nomQdrantRag(C))).toEqual({ collectionId: C, generation: 0 });
    expect(analyserNomQdrantRag(nomQdrantRag(C, 12))).toEqual({ collectionId: C, generation: 12 });
    expect(estNomQdrantRag(nomQdrantRag(randomUUID()))).toBe(true);
  });

  it("jamais tiré d'une saisie : identifiant ou génération invalides refusés ; anciens noms non reconnus", () => {
    for (const f of [
      () => nomQdrantRag("documents"),
      () => nomQdrantRag(C.toUpperCase()),
      () => nomQdrantRag(C, -1),
      () => nomQdrantRag(C, 1.5),
      () => nomQdrantRag(C, 1_000_000),
    ])
      expect(f).toThrow(ErreurMagasinRag);
    const hex = C.replaceAll("-", "");
    for (const nom of [
      "documents",
      "elpis_",
      `elpis_${hex.toUpperCase()}`,
      `elpis_${hex}_g0`,
      `elpis_${hex}_g01`,
      `elpis_${hex}_x`,
      `elpis_${hex}x`,
      `elpis_${"0".repeat(32)}`,
      ` elpis_${hex}`,
      42,
      null,
    ])
      expect(analyserNomQdrantRag(nom), String(nom)).toBeNull();
  });
});
