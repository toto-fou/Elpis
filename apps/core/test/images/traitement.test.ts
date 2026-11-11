// SPDX-License-Identifier: MIT
/** apps/core/test/images/traitement.test.ts — pixels sans module natif : source d'édition (orientation EXIF, recadrage), vignette, réductions de capture, thread de travail. */
import { crc32, deflateSync } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

import { ImageError } from "../../src/images/base";
import { dimensionsImage } from "@elpis/images";
import { LIBWEBP_MIN, versionLibwebp } from "@elpis/images/pixels";
import {
  modePixels,
  pixelsSurPlace,
  prepareSource,
  reduireCapture,
  reduireLargeur,
  vignette,
} from "@elpis/images";
import { jpeg, lireJpeg, lirePng, png, webpAvecAlpha } from "./fabrique";

const ROUGE = [200, 30, 30, 255] as const;

async function erreur(p: Promise<unknown>): Promise<ImageError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ImageError) return e;
    throw e;
  }
  throw new Error("aucune erreur levée");
}

afterAll(async () => {
  await pixelsSurPlace(false);
});

describe("image source d'une édition", () => {
  it("PNG RGB exactement à la taille demandée, quel que soit le format d'entrée", async () => {
    const webp = await vignette(png(20, 20, [200, 30, 30, 128], true));
    expect(webp && webpAvecAlpha(webp)).toBe(true);
    for (const entree of [png(100, 100, ROUGE), jpeg(30, 80, ROUGE), webp ?? new Uint8Array(0)]) {
      const sortie = lirePng(await prepareSource(entree, 128, 64));
      expect([sortie.largeur, sortie.hauteur, sortie.type]).toEqual([128, 64, 2]);
    }
  });

  it("orientation EXIF appliquée avant le recadrage", async () => {
    const source = jpeg(40, 40, (x) => (x < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255]), 95, 6);
    const sortie = lirePng(await prepareSource(source, 40, 40));
    expect(sortie.pixel(20, 2)[0]).toBeGreaterThan(200);
    expect(sortie.pixel(20, 37)[2]).toBeGreaterThan(200);
  });

  it("refus : vide ou trop lourde, format inconnu, en-tête refusé, trop de pixels", async () => {
    const vide = await erreur(prepareSource(new Uint8Array(0), 64, 64));
    expect([vide.code, vide.status, vide.message]).toEqual([
      "invalid",
      400,
      "Image source trop lourde (20 Mo au plus).",
    ]);
    const lourde = await erreur(prepareSource(new Uint8Array(20 * 1024 * 1024 + 1), 64, 64));
    expect(lourde.message).toBe("Image source trop lourde (20 Mo au plus).");
    const eps = await erreur(prepareSource(Buffer.from("%!PS-Adobe-3.0 EPSF-3.0\n"), 64, 64));
    expect(eps.message).toBe("Image source : PNG, JPEG ou WEBP seulement.");
    const tronquee = await erreur(prepareSource(png(10, 10, ROUGE).subarray(0, 30), 64, 64));
    expect(tronquee.message).toBe("Image source illisible.");
    const corrompue = Buffer.from(png(10, 10, ROUGE));
    corrompue[40] = (corrompue[40] ?? 0) ^ 0xff;
    const illisible = await erreur(prepareSource(corrompue, 64, 64));
    expect([illisible.code, illisible.message]).toEqual(["invalid", "Image source illisible."]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(7000, 0);
    ihdr.writeUInt32BE(7000, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const morceau = (type: string, data: Buffer): Buffer => {
      const longueur = Buffer.alloc(4);
      longueur.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])) >>> 0);
      return Buffer.concat([longueur, Buffer.from(type), data, crc]);
    };
    const geante = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      morceau("IHDR", ihdr),
      morceau("IDAT", Buffer.alloc(4)),
    ]);
    expect((await erreur(prepareSource(geante, 64, 64))).message).toBe("Image source trop grande.");
  });
});

describe("vignette et réductions", () => {
  it("vignette WebP de 384 px au plus, rapport gardé, transparence conservée, jamais agrandie", async () => {
    const grande = await vignette(png(1024, 768, ROUGE));
    expect([
      dimensionsImage(grande ?? new Uint8Array(0)),
      webpAvecAlpha(grande ?? new Uint8Array(0)),
    ]).toEqual([[384, 288], false]);
    const petite = (await vignette(png(100, 50, [200, 30, 30, 128], true))) ?? new Uint8Array(0);
    expect([dimensionsImage(petite), webpAvecAlpha(petite)]).toEqual([[100, 50], true]);
    expect(await vignette(Buffer.from("pas une image"))).toBeNull();
  });

  it("capture vision : JPEG à la largeur maximale, transparence retirée ; illisible : null", async () => {
    const reduite = await reduireCapture(png(2000, 1000, [200, 30, 30, 128], true), 1280, 70);
    expect(lireJpeg(reduite ?? new Uint8Array(0))).toEqual({ largeur: 1280, hauteur: 640, composantes: 3 });
    const etroite = await reduireCapture(png(300, 200, ROUGE), 1280, 70);
    expect(lireJpeg(etroite ?? new Uint8Array(0))).toEqual({ largeur: 300, hauteur: 200, composantes: 3 });
    expect(await reduireCapture(Buffer.from("x"), 1280, 70)).toBeNull();
  });

  it("annotation : capture trop large réduite (largeur envoyée rendue), sinon intacte", async () => {
    const r = await reduireLargeur(png(3000, 1001, ROUGE), 1920, 3000);
    const sortie = lirePng(r.octets);
    expect([r.largeur, sortie.largeur, sortie.hauteur, sortie.type]).toEqual([1920, 1920, 640, 2]);
    const etroite = png(800, 600, ROUGE);
    expect(await reduireLargeur(etroite, 1920, 800)).toEqual({ octets: etroite, largeur: 800 });
    expect(await reduireLargeur(Buffer.from("x"), 1920, 4000)).toEqual({
      octets: Buffer.from("x"),
      largeur: 4000,
    });
    expect((await reduireLargeur(etroite, 1920, 0)).largeur).toBe(0);
  });

  it("bombe de décompression (plus de 2 × MAX_IMAGE_PIXELS) : refusée avant décodage, comme `Image.open`", async () => {
    const cote = 13_380;
    const bloc = (type: string, donnees: Buffer): Buffer => {
      const corps = Buffer.concat([Buffer.from(type, "latin1"), donnees]);
      const [longueur, controle] = [Buffer.alloc(4), Buffer.alloc(4)];
      longueur.writeUInt32BE(donnees.length);
      controle.writeUInt32BE(crc32(corps));
      return Buffer.concat([longueur, corps, controle]);
    };
    const entete = Buffer.alloc(13);
    entete.writeUInt32BE(cote, 0);
    entete.writeUInt32BE(cote, 4);
    entete[8] = 1;
    const bombe = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      bloc("IHDR", entete),
      bloc("IDAT", deflateSync(Buffer.alloc((1 + Math.ceil(cote / 8)) * cote))),
      bloc("IEND", Buffer.alloc(0)),
    ]);
    expect(await reduireLargeur(bombe, 1920, cote)).toEqual({ octets: bombe, largeur: cote });
    expect(await reduireCapture(bombe, 1280, 70)).toBeNull();
    expect(await vignette(bombe)).toBeNull();
  });
});

/** WebP sans perte (6 × 5, Pillow) ; ses octets après l'en-tête VP8L portent les codes de Huffman. */
const SANS_PERTE = Buffer.from(
  "UklGRr4AAABXRUJQVlA4TLIAAAAvBQABAO/AJgDAJHPBXV8+OpCLHkTiogQ/l7vWYBvZtpLv/2eCRRZBTEoH9EEfNEoB7q4zTAMATLJkQNIIB7j8wCV8wD9wj3Z36CS3+Y9cfP/PZTi/JrjV5WY/DmG3ohkSpJBhSdJedhe5Pgh5eJGx0xJlKgfQcqR4HO0sKifFSVgf89i2CcYRO+l1f0O6ASNk2NIHhZEkmbG7t21E9D9SU74OwlbMRuhHJ4I8/dvNwy0O",
  "base64",
);

/** Flux coupé à `n` octets, tailles RIFF et VP8L récrites : l'en-tête est accepté, libwebp reçoit le flux incomplet. */
function tronquer(o: Buffer, n: number): Buffer {
  const t = Buffer.from(o.subarray(0, n));
  t.writeUInt32LE(n - 8, 4);
  t.writeUInt32LE(n - 20, 16);
  return t;
}

describe("codec WebP (libwebp en WebAssembly, deploy/codecs/webp)", () => {
  it("libwebp 1.3.2 ou après (correctif de CVE-2023-4863) ; flux sans perte corrompu ou tronqué refusé par libwebp, sans plantage", async () => {
    expect(await versionLibwebp()).toBeGreaterThanOrEqual(LIBWEBP_MIN);
    const corrompu = Buffer.from(SANS_PERTE);
    corrompu.fill(0xff, 25);
    for (const piege of [corrompu, tronquer(SANS_PERTE, 40)]) {
      const refus = await erreur(prepareSource(piege, 24, 24));
      expect([refus.code, refus.message]).toEqual(["invalid", "Image source illisible."]);
      expect(refus.detail).toContain("cannot decode WebP image");
      expect(await vignette(piege)).toBeNull();
    }
    const sortie = lirePng(await prepareSource(SANS_PERTE, 12, 10));
    expect([sortie.largeur, sortie.hauteur, modePixels()]).toEqual([12, 10, "thread"]);
  });
});

describe("thread de travail", () => {
  it("calcul hors de la boucle d'évènements ; sur place, les mêmes octets", async () => {
    const photo = jpeg(2400, 1700, (x, y) => [(x * 7) % 256, (y * 3) % 256, (x ^ y) % 256, 255], 90);
    let [ecart, avant] = [0, performance.now()];
    let actif = true;
    const sonde = (): void => {
      const t = performance.now();
      ecart = Math.max(ecart, t - avant);
      avant = t;
      if (actif) setImmediate(sonde);
    };
    sonde();
    const [source, petite] = [await prepareSource(photo, 1024, 1024), await vignette(photo)];
    actif = false;
    expect(modePixels()).toBe("thread");
    expect(ecart).toBeLessThan(250);
    await pixelsSurPlace(true);
    expect(modePixels()).toBe("sur-place");
    expect(Buffer.from(await prepareSource(photo, 1024, 1024)).equals(Buffer.from(source))).toBe(true);
    expect(Buffer.from((await vignette(photo)) ?? []).equals(Buffer.from(petite ?? [1]))).toBe(true);
    await pixelsSurPlace(false);
  });
});
