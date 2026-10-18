// SPDX-License-Identifier: MIT
/** frontend/src/features/mascotte/motifs.ts — glyphes en pixel art du mot de l'accueil (ELPIS, KIKI) dans leurs variantes, quinze lignes de haut. */
export type Glyphe = readonly string[];
export type TableGlyphes = Readonly<Record<string, Glyphe>>;

export interface Motif {
  etiquette: string;
  larg: number;
  ecart: number;
  glyphes: TableGlyphes;
  eclats?: TableGlyphes;
  quoi: string;
}

function rehaut(glyphe: Glyphe): Glyphe {
  return glyphe.map((ligne, y) =>
    [...ligne]
      .map((c, x) =>
        c === "#" && (y === 0 || glyphe[y - 1]?.[x] !== "#" || x === 0 || ligne[x - 1] !== "#") ? "#" : ".",
      )
      .join(""),
  );
}

const BLOC: TableGlyphes = {
  E: [
    "###########",
    "###########",
    "###########",
    "###........",
    "###........",
    "###........",
    "########...",
    "########...",
    "########...",
    "###........",
    "###........",
    "###........",
    "###########",
    "###########",
    "###########",
  ],
  L: [
    "###........",
    "###........",
    "###........",
    "###........",
    "###........",
    "###........",
    "###........",
    "###........",
    "###........",
    "###........",
    "###........",
    "###........",
    "###########",
    "###########",
    "###########",
  ],
  P: [
    "###########",
    "###########",
    "###########",
    "###.....###",
    "###.....###",
    "###.....###",
    "###########",
    "###########",
    "###########",
    "###........",
    "###........",
    "###........",
    "###........",
    "###........",
    "###........",
  ],
  I: [
    "###########",
    "###########",
    "###########",
    "....###....",
    "....###....",
    "....###....",
    "....###....",
    "....###....",
    "....###....",
    "....###....",
    "....###....",
    "....###....",
    "###########",
    "###########",
    "###########",
  ],
  S: [
    "###########",
    "###########",
    "###########",
    "###........",
    "###........",
    "###........",
    "###########",
    "###########",
    "###########",
    "........###",
    "........###",
    "........###",
    "###########",
    "###########",
    "###########",
  ],

  K: [
    "###.....###",
    "###....###.",
    "###...###..",
    "###..###...",
    "###.###....",
    "######.....",
    "#####......",
    "#####......",
    "#####......",
    "######.....",
    "###.###....",
    "###..###...",
    "###...###..",
    "###....###.",
    "###.....###",
  ],
};

const EPIGRAPHE: TableGlyphes = {
  E: [
    "############.",
    "#############",
    "###.......###",
    "###..........",
    "###..........",
    "###..........",
    "########.....",
    "########.....",
    "###..........",
    "###..........",
    "###..........",
    "###..........",
    "###.......###",
    "#############",
    "############.",
  ],
  L: [
    "#####........",
    "#####........",
    "###..........",
    "###..........",
    "###..........",
    "###..........",
    "###..........",
    "###..........",
    "###..........",
    "###..........",
    "###..........",
    "###..........",
    "###.......###",
    "#############",
    "############.",
  ],
  P: [
    "############.",
    "#############",
    "###.......###",
    "###.......###",
    "###.......###",
    "###.......###",
    "#############",
    "############.",
    "###..........",
    "###..........",
    "###..........",
    "###..........",
    "###..........",
    "#####........",
    "#####........",
  ],
  I: [
    "#############",
    ".###########.",
    ".....###.....",
    ".....###.....",
    ".....###.....",
    ".....###.....",
    ".....###.....",
    ".....###.....",
    ".....###.....",
    ".....###.....",
    ".....###.....",
    ".....###.....",
    ".....###.....",
    ".###########.",
    "#############",
  ],
  S: [
    ".############",
    "#############",
    "###.......###",
    "###..........",
    "###..........",
    "###..........",
    "###..........",
    "############.",
    ".############",
    "..........###",
    "..........###",
    "..........###",
    "###.......###",
    "#############",
    "############.",
  ],
  K: [
    "#####...#####",
    "###.....###..",
    "###....###...",
    "###...###....",
    "###..###.....",
    "###.###......",
    "######.......",
    "#####........",
    "######.......",
    "###.###......",
    "###..###.....",
    "###...###....",
    "###....###...",
    "###.....###..",
    "#####...#####",
  ],
};

const GREC: TableGlyphes = {
  E: EPIGRAPHE.E as Glyphe,
  L: [
    ".....###.....",
    ".....###.....",
    "....#####....",
    "....#####....",
    "...###.###...",
    "...###.###...",
    "..###...###..",
    "..###...###..",
    ".###.....###.",
    ".###.....###.",
    "###.......###",
    "###.......###",
    "###.......###",
    "#####...#####",
    "#####...#####",
  ],
  P: [
    "#############",
    "#############",
    "###.......###",
    "###.......###",
    "###.......###",
    "###.......###",
    "###.......###",
    "###.......###",
    "###.......###",
    "###.......###",
    "###.......###",
    "###.......###",
    "###.......###",
    "#####...#####",
    "#####...#####",
  ],
  I: EPIGRAPHE.I as Glyphe,
  K: EPIGRAPHE.K as Glyphe,
  S: [
    "#############",
    "#############",
    "###..........",
    ".###.........",
    "..###........",
    "...###.......",
    "....###......",
    ".....###.....",
    "....###......",
    "...###.......",
    "..###........",
    ".###.........",
    "###..........",
    "#############",
    "#############",
  ],
};

const FIN: TableGlyphes = {
  E: [
    "#########",
    "#########",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "#######..",
    "#######..",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "#########",
    "#########",
  ],
  L: [
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "#########",
    "#########",
  ],
  P: [
    "########.",
    "########.",
    "##.....##",
    "##.....##",
    "##.....##",
    "##.....##",
    "########.",
    "########.",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
  ],
  I: [
    "#########",
    "#########",
    "...##....",
    "...##....",
    "...##....",
    "...##....",
    "...##....",
    "...##....",
    "...##....",
    "...##....",
    "...##....",
    "...##....",
    "...##....",
    "#########",
    "#########",
  ],
  S: [
    "#########",
    "#########",
    "##.......",
    "##.......",
    "##.......",
    "##.......",
    "#########",
    "#########",
    ".......##",
    ".......##",
    ".......##",
    ".......##",
    ".......##",
    "#########",
    "#########",
  ],
  K: [
    "##.....##",
    "##....##.",
    "##...##..",
    "##..##...",
    "##.##....",
    "####.....",
    "###......",
    "###......",
    "###......",
    "####.....",
    "##.##....",
    "##..##...",
    "##...##..",
    "##....##.",
    "##.....##",
  ],
};

function creuser(g: Glyphe): Glyphe {
  const H = g.length,
    W = g[0]?.length ?? 0;
  const vide = (y: number, x: number): boolean => y < 0 || y >= H || x < 0 || x >= W || g[y]?.[x] !== "#";
  return g.map((ligne, y) =>
    [...ligne]
      .map((c, x) =>
        c === "#" && (vide(y - 1, x) || vide(y + 1, x) || vide(y, x - 1) || vide(y, x + 1)) ? "#" : ".",
      )
      .join(""),
  );
}

function adoucir(g: Glyphe): Glyphe {
  const H = g.length,
    W = g[0]?.length ?? 0;
  const vide = (y: number, x: number): boolean => y < 0 || y >= H || x < 0 || x >= W || g[y]?.[x] !== "#";
  return g.map((ligne, y) =>
    [...ligne]
      .map((c, x) => {
        if (c !== "#") return ".";
        const coin =
          (vide(y - 1, x) && vide(y, x - 1)) ||
          (vide(y - 1, x) && vide(y, x + 1)) ||
          (vide(y + 1, x) && vide(y, x - 1)) ||
          (vide(y + 1, x) && vide(y, x + 1));
        return coin ? "." : "#";
      })
      .join(""),
  );
}

function ajourer(g: Glyphe): Glyphe {
  const H = g.length;
  return g.map((ligne, y) =>
    [...ligne]
      .map((c, x) => {
        if (c !== "#" || (y !== 4 && y !== 10)) return c;
        const plein = (yy: number): boolean => yy >= 0 && yy < H && g[yy]?.[x] === "#";
        return plein(y - 1) && plein(y + 1) ? "." : c;
      })
      .join(""),
  );
}

const derive = (src: TableGlyphes, f: (g: Glyphe) => Glyphe): TableGlyphes =>
  Object.fromEntries(Object.entries(src).map(([c, g]) => [c, f(g)]));

const NEON = derive(BLOC, creuser);
const ARRONDI = derive(BLOC, adoucir);
const POCHOIR = derive(BLOC, ajourer);

export const MOTIFS: Readonly<Record<string, Motif>> = {
  bloc: {
    etiquette: "Bloc",
    larg: 11,
    ecart: 3,
    glyphes: BLOC,
    quoi: "géométrique, trait de trois — le plus neutre",
  },
  or: {
    etiquette: "Bloc et or",
    larg: 11,
    ecart: 3,
    glyphes: BLOC,
    eclats: Object.fromEntries(Object.entries(BLOC).map(([c, g]) => [c, rehaut(g)])),
    quoi: "le même, avec le rehaut d'or des sprites",
  },
  epigraphe: {
    etiquette: "Épigraphe",
    larg: 13,
    ecart: 3,
    glyphes: EPIGRAPHE,
    quoi: "capitales gravées, empattements — « musée »",
  },
  grec: {
    etiquette: "Grec — ΕΛΠΙΣ",
    larg: 13,
    ecart: 3,
    glyphes: GREC,
    quoi: "le mot dans son alphabet",
  },
  fin: {
    etiquette: "Fin",
    larg: 9,
    ecart: 3,
    glyphes: FIN,
    quoi: "capitales étroites, trait de deux — le mot se resserre",
  },
  fin_or: {
    etiquette: "Fin et or",
    larg: 9,
    ecart: 3,
    glyphes: FIN,
    eclats: derive(FIN, rehaut),
    quoi: "le même, rehaussé d'or",
  },
  neon: {
    etiquette: "Néon",
    larg: 11,
    ecart: 3,
    glyphes: NEON,
    quoi: "creusé : il ne reste que le tube",
  },
  neon_or: {
    etiquette: "Néon doré",
    larg: 11,
    ecart: 3,
    glyphes: NEON,
    eclats: derive(NEON, rehaut),
    quoi: "le tube, avec sa lumière",
  },
  arrondi: {
    etiquette: "Arrondi",
    larg: 11,
    ecart: 3,
    glyphes: ARRONDI,
    eclats: derive(ARRONDI, rehaut),
    quoi: "coins cassés — le bloc, en plus doux",
  },
  pochoir: {
    etiquette: "Pochoir",
    larg: 11,
    ecart: 3,
    glyphes: POCHOIR,
    quoi: "deux saignées dans les fûts, comme une plaque à peindre",
  },
};

export const MOTIF_RETENU = "or";

export const HAUT_LETTRE = 15;
export const MOT: readonly string[] = ["E", "L", "P", "I", "S"];

export const MOTS: Readonly<Record<string, readonly string[]>> = { elpis: MOT, kiki: ["K", "I", "K", "I"] };

const LETTRES = [...new Set(Object.values(MOTS).flat())];
for (const [nom, m] of Object.entries(MOTIFS))
  for (const c of LETTRES) {
    const g = m.glyphes[c];
    if (!g) throw new Error(`${nom}.${c} : glyphe absent`);
    if (g.length !== HAUT_LETTRE)
      throw new Error(`${nom}.${c} : ${g.length} lignes au lieu de ${HAUT_LETTRE}`);
    g.forEach((l, i) => {
      if (l.length !== m.larg)
        throw new Error(`${nom}.${c} ligne ${i} : ${l.length} colonnes ` + `au lieu de ${m.larg}`);
    });
  }
