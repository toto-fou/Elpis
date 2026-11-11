// SPDX-License-Identifier: MIT
/** apps/core/test/images/securite-png-gonflage.test.ts — métadonnées PNG compressées : plafond par bloc (texte, ICC) et total ; un bloc hors plafond est ignoré, l'image reste lue. */
import { Worker } from "node:worker_threads";
import { crc32, deflateSync, inflateSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ImageError } from "../../src/images/base";
import { pixelsSurPlace, prepareSource, reduireLargeur, signatureCapture } from "@elpis/images";
import { png } from "./fabrique";
import type { Rvba } from "./fabrique";

const MIO = 1024 * 1024;
const XMP = "XML:com.adobe.xmp";
const peintre = (x: number): Rvba => (x < 2 ? [200, 30, 30, 255] : [30, 30, 200, 255]);
const BASE = png(4, 2, peintre);

function bloc(type: string, donnees: Buffer): Buffer {
  const entete = Buffer.alloc(4);
  entete.writeUInt32BE(donnees.length);
  const corps = Buffer.concat([Buffer.from(type, "latin1"), donnees]);
  const controle = Buffer.alloc(4);
  controle.writeUInt32BE(crc32(corps));
  return Buffer.concat([entete, corps, controle]);
}

const cle = (nom: string): Buffer => Buffer.from(`${nom}\0`, "latin1");
const iccp = (profil: Buffer): Buffer =>
  bloc("iCCP", Buffer.concat([cle("Profil"), Buffer.from([0]), deflateSync(profil)]));
const ztxt = (nom: string, texte: Buffer): Buffer =>
  bloc("zTXt", Buffer.concat([cle(nom), Buffer.from([0]), deflateSync(texte)]));
const itxt = (nom: string, texte: Buffer, compresse: boolean): Buffer =>
  bloc(
    "iTXt",
    Buffer.concat([
      cle(nom),
      Buffer.from([compresse ? 1 : 0, 0, 0, 0]),
      compresse ? deflateSync(texte) : texte,
    ]),
  );

/** Blocs insérés avant IEND, donc après IDAT : le contrôle des dimensions ne les voit pas. */
const avec = (...blocs: Buffer[]): Buffer =>
  Buffer.concat([BASE.subarray(0, BASE.length - 12), ...blocs, BASE.subarray(BASE.length - 12)]);

const xmpOrientation = (taille: number): Buffer => {
  const tete = Buffer.from('<x tiff:Orientation="6"/>', "latin1");
  return Buffer.concat([tete, Buffer.alloc(taille - tete.length, 0x20)]);
};

const profil = (taille: number): Buffer => Buffer.alloc(taille, "ICC-");

function profilRendu(octets: Uint8Array): Buffer | null {
  const d = Buffer.from(octets);
  for (let i = 8; i + 8 <= d.length; i += 12 + d.readUInt32BE(i))
    if (d.subarray(i + 4, i + 8).toString("latin1") === "iCCP") {
      const corps = d.subarray(i + 8, i + 8 + d.readUInt32BE(i));
      return inflateSync(corps.subarray(corps.indexOf(0) + 2));
    }
  return null;
}

const reduit = async (entree: Buffer): Promise<Uint8Array> => (await reduireLargeur(entree, 2, 4)).octets;
const source = (entree: Buffer): Promise<Uint8Array> => prepareSource(entree, 4, 2);
const memes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(a, b) === 0;

beforeAll(() => pixelsSurPlace(true));
afterAll(() => pixelsSurPlace(false));

describe("profil ICC d'un PNG", () => {
  it.each([
    ["sRGB courant", 3144],
    ["le plus gros du registre ICC (8,4 Mo)", Math.ceil(8.4 * 1000 * 1000)],
    ["au plafond", 16 * MIO],
  ])("garde un profil : %s", async (_nom, taille) => {
    const attendu = profil(taille);
    const rendu = profilRendu(await reduit(avec(iccp(attendu))));
    expect(rendu !== null && rendu.equals(attendu)).toBe(true);
  });

  it("ignore un profil au-delà du plafond et lit quand même l'image", async () => {
    const octets = await reduit(avec(iccp(profil(16 * MIO + 1))));
    expect(profilRendu(octets) === null).toBe(true);
    expect(memes(octets, await reduit(BASE))).toBe(true);
  });
});

describe("textes compressés d'un PNG", () => {
  it.each([
    ["zTXt", (t: Buffer) => ztxt(XMP, t)],
    ["iTXt", (t: Buffer) => itxt(XMP, t, true)],
  ])("%s : lu jusqu'au plafond, ignoré au-delà", async (_type, fabriquer) => {
    const sansXmp = await source(BASE);
    expect(memes(await source(avec(fabriquer(xmpOrientation(4096)))), sansXmp)).toBe(false);
    expect(memes(await source(avec(fabriquer(xmpOrientation(MIO)))), sansXmp)).toBe(false);
    expect(memes(await source(avec(fabriquer(xmpOrientation(MIO + 1)))), sansXmp)).toBe(true);
    expect(memes(await source(avec(fabriquer(xmpOrientation(64 * MIO)))), sansXmp)).toBe(true);
  });

  it("iTXt non compressé : pas de plafond, comme avant", async () => {
    const sansXmp = await source(BASE);
    expect(memes(await source(avec(itxt(XMP, xmpOrientation(2 * MIO), false))), sansXmp)).toBe(false);
  });

  it("un flux compressé invalide ne gêne pas la lecture", async () => {
    const abime = bloc("zTXt", Buffer.concat([cle(XMP), Buffer.from([0]), Buffer.from("pas du zlib")]));
    expect(memes(await source(avec(abime)), await source(BASE))).toBe(true);
  });
});

describe("plafond total d'un PNG", () => {
  it("un profil et un texte aux plafonds passent ensemble", async () => {
    const attendu = profil(16 * MIO);
    const octets = await reduit(avec(ztxt(XMP, xmpOrientation(MIO)), iccp(attendu)));
    const rendu = profilRendu(octets);
    expect(rendu !== null && rendu.equals(attendu)).toBe(true);
  });

  it("une fois le total atteint, les blocs suivants sont ignorés", async () => {
    const remplissage = new Array<Buffer>(64).fill(ztxt("bourrage", Buffer.alloc(MIO)));
    expect(profilRendu(await reduit(avec(...remplissage, iccp(profil(3144))))) === null).toBe(true);
  });

  it("de nombreux petits blocs très compressés ne coûtent que le total", async () => {
    const charge = avec(...new Array<Buffer>(3000).fill(ztxt("bourrage", Buffer.alloc(MIO))));
    const debut = performance.now();
    const octets = await reduit(charge);
    expect(performance.now() - debut).toBeLessThan(2500);
    expect(memes(octets, await reduit(BASE))).toBe(true);
  });
});

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FIN = bloc("IEND", Buffer.alloc(0));
const PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;
const CANAUX: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function ihdr(l: number, h: number, profondeur: number, couleur: number, entrelace: 0 | 1): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(l, 0);
  d.writeUInt32BE(h, 4);
  d[8] = profondeur;
  d[9] = couleur;
  d[12] = entrelace;
  return bloc("IHDR", d);
}

/** Données brutes Adam7, sans filtre ; `valeur` donne chaque échantillon, écrit selon la profondeur. */
function brutAdam7(
  l: number,
  h: number,
  profondeur: number,
  couleur: number,
  valeur: (x: number, y: number, c: number) => number,
): Buffer {
  const octets: number[] = [];
  for (const [x0, y0, pasX, pasY] of PASSES) {
    if (x0 >= l || y0 >= h) continue;
    for (let y = y0; y < h; y += pasY) {
      octets.push(0);
      let accu = 0;
      let bits = 0;
      for (let x = x0; x < l; x += pasX)
        for (let c = 0; c < (CANAUX[couleur] ?? 0); c++) {
          accu = accu * 2 ** profondeur + valeur(x, y, c);
          bits += profondeur;
          while (bits >= 8) {
            octets.push(Math.floor(accu / 2 ** (bits - 8)) % 256);
            bits -= 8;
          }
          accu %= 2 ** bits;
        }
      if (bits > 0) octets.push((accu * 2 ** (8 - bits)) % 256);
    }
  }
  return Buffer.from(octets);
}

const fichier = (...blocs: Buffer[]): Buffer => Buffer.concat([SIGNATURE, ...blocs, FIN]);
const palette = bloc("PLTE", Buffer.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]));

async function refus(p: Promise<unknown>): Promise<ImageError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  if (!(e instanceof ImageError)) throw new Error(`image acceptée ou autre erreur : ${String(e)}`);
  return e;
}

describe("PNG entrelacé", () => {
  const rgb = (x: number, y: number, c: number): number => (x * 37 + y * 11 + c * 83) % 256;

  it("se décode comme son jumeau non entrelacé", async () => {
    const [l, h] = [13, 7];
    const entrelace = fichier(ihdr(l, h, 8, 2, 1), bloc("IDAT", deflateSync(brutAdam7(l, h, 8, 2, rgb))));
    const jumeau = png(l, h, (x, y) => [rgb(x, y, 0), rgb(x, y, 1), rgb(x, y, 2), 255]);
    expect(memes(await prepareSource(entrelace, l, h), await prepareSource(jumeau, l, h))).toBe(true);
  });

  it("garde un IDAT réparti sur plusieurs blocs", async () => {
    const z = deflateSync(brutAdam7(13, 7, 8, 2, rgb));
    const coupe = Math.floor(z.length / 2);
    const entier = fichier(ihdr(13, 7, 8, 2, 1), bloc("IDAT", z));
    const reparti = fichier(
      ihdr(13, 7, 8, 2, 1),
      bloc("IDAT", z.subarray(0, coupe)),
      bloc("IDAT", z.subarray(coupe)),
    );
    expect(memes(await prepareSource(reparti, 13, 7), await prepareSource(entier, 13, 7))).toBe(true);
  });

  const MODES = [
    [1, 0],
    [2, 0],
    [4, 0],
    [8, 0],
    [16, 0],
    [8, 2],
    [16, 2],
    [1, 3],
    [2, 3],
    [4, 3],
    [8, 3],
    [8, 4],
    [8, 6],
    [16, 6],
  ] as const;
  const TAILLES = [
    [1, 1],
    [2, 9],
    [9, 2],
    [8, 8],
    [33, 17],
  ] as const;
  const CAS = MODES.flatMap(([p, c]) => TAILLES.map(([l, h]) => [p, c, l, h] as const));

  it.each(CAS)("profondeur %i, couleur %i, %i×%i : décodé, plafond juste", async (p, c, l, h) => {
    const brut = brutAdam7(l, h, p, c, (x, y, k) => (x + y + k) % Math.min(2 ** p, c === 3 ? 4 : 256));
    const debut = [ihdr(l, h, p, c, 1), ...(c === 3 ? [palette] : [])];
    const octets = await prepareSource(fichier(...debut, bloc("IDAT", deflateSync(brut))), l, h);
    expect(octets.length).toBeGreaterThan(0);
    const trop = Buffer.concat([brut, Buffer.alloc(1025)]);
    const e = await refus(prepareSource(fichier(...debut, bloc("IDAT", deflateSync(trop))), l, h));
    expect(e.detail).toMatch(/larger than/);
  });

  it("refuse un IDAT démesuré sans le gonfler, avec l'erreur habituelle", async () => {
    const bombe = bloc("IDAT", deflateSync(Buffer.alloc(32 * MIO)));
    const e = await refus(prepareSource(fichier(ihdr(1, 1, 8, 2, 1), bombe), 1, 1));
    expect(e.message).toBe("Image source illisible.");
    expect(e.code).toBe("invalid");
    expect(e.status).toBe(400);
    expect(e.detail).toMatch(/larger than/);
  });

  it("additionne les blocs IDAT", async () => {
    const z = deflateSync(Buffer.alloc(32 * MIO));
    const coupe = Math.floor(z.length / 2);
    const e = await refus(
      prepareSource(
        fichier(ihdr(1, 1, 8, 2, 1), bloc("IDAT", z.subarray(0, coupe)), bloc("IDAT", z.subarray(coupe))),
        1,
        1,
      ),
    );
    expect(e.detail).toMatch(/larger than/);
  });

  it("refuse un second IHDR placé après IDAT", async () => {
    const entree = fichier(
      ihdr(4, 2, 8, 2, 0),
      bloc("IDAT", deflateSync(Buffer.alloc(2 * (1 + 4 * 3)))),
      ihdr(1, 1, 8, 2, 1),
    );
    const e = await refus(prepareSource(entree, 4, 2));
    expect(e.detail).toMatch(/IHDR/);
  });

  it("plafonne les dimensions là où rien ne les contrôle avant", async () => {
    const entree = fichier(ihdr(20_000, 20_000, 8, 6, 1), bloc("IDAT", deflateSync(Buffer.alloc(64))));
    await expect(signatureCapture(entree)).rejects.toThrow(/dimensions too large/);
  });
});

describe("pixels.ts", () => {
  it("se charge seul en thread de travail, sans import local", async () => {
    const w = new Worker(new URL("../../../../packages/images/src/pixels.ts", import.meta.url), {
      workerData: { elpis: "pixels" },
    });
    const issue = await new Promise<unknown>((ok) => {
      w.once("message", ok);
      w.once("error", ok);
    });
    await w.terminate();
    expect(issue).not.toBeInstanceOf(Error);
  });
});
