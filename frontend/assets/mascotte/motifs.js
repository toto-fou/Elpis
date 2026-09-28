// SPDX-License-Identifier: MIT
/* ===========================================================================
 *  Les quatre façons d'écrire ELPIS.
 *
 *  Toutes tiennent sur QUINZE lignes — c'est ce qui permet de changer de motif
 *  sans retoucher la mise en scène : la mascotte, le sol et le saut sont calés
 *  sur la hauteur des lettres, pas sur leur dessin. La largeur, elle, varie.
 *
 *  Le dernier glyphe est celui que la mascotte décroche. Il doit donc rester
 *  un OBJET : une forme fermée, reconnaissable seule, qui laisse un trou
 *  identifiable dans le mot.
 * ======================================================================== */

/* Un pixel est un REHAUT s'il est plein et qu'il touche le vide par le haut ou
 * par la gauche. C'est mot pour mot la règle des sprites du socle — « un rehaut
 * clair en haut à gauche uniquement ». Le dériver plutôt que de le dessiner
 * garantit qu'il ne peut pas se désynchroniser de la lettre. */
function rehaut(glyphe) {
    return glyphe.map((ligne, y) => [...ligne].map((c, x) =>
        c === "#" && ((y === 0 || glyphe[y - 1][x] !== "#")
                   || (x === 0 || ligne[x - 1] !== "#")) ? "#" : ".").join(""));
}

/* --- bloc : géométrique, trait de trois. Le point de départ. -------------- */
const BLOC = {
    E: ["###########", "###########", "###########",
        "###........", "###........", "###........",
        "########...", "########...", "########...",
        "###........", "###........", "###........",
        "###########", "###########", "###########"],
    L: ["###........", "###........", "###........",
        "###........", "###........", "###........",
        "###........", "###........", "###........",
        "###........", "###........", "###........",
        "###########", "###########", "###########"],
    P: ["###########", "###########", "###########",
        "###.....###", "###.....###", "###.....###",
        "###########", "###########", "###########",
        "###........", "###........", "###........",
        "###........", "###........", "###........"],
    I: ["###########", "###########", "###########",
        "....###....", "....###....", "....###....",
        "....###....", "....###....", "....###....",
        "....###....", "....###....", "....###....",
        "###########", "###########", "###########"],
    S: ["###########", "###########", "###########",
        "###........", "###........", "###........",
        "###########", "###########", "###########",
        "........###", "........###", "........###",
        "###########", "###########", "###########"],
    /* K — ajouté pour le mot KIKI (skin « kiki »). Même trait de trois : la
     * branche haute descend d'un pixel par rangée jusqu'au fût, la basse en
     * repart symétriquement, et un nœud de cinq pixels les soude au milieu. */
    K: ["###.....###", "###....###.", "###...###..", "###..###...",
        "###.###....", "######.....", "#####......", "#####......",
        "#####......", "######.....", "###.###....", "###..###...",
        "###...###..", "###....###.", "###.....###"],
};

/* --- épigraphe : capitales à empattements ---------------------------------
 * Les traits verticaux font trois pixels, les horizontaux deux, et chaque
 * terminaison s'évase d'un pixel. C'est le minimum qui distingue une capitale
 * gravée d'une capitale de machine à écrire — en dessous, l'empattement
 * disparaît ; au-dessus, la lettre se referme sur elle-même. */
const EPIGRAPHE = {
    E: ["############.", "#############", "###.......###",
        "###..........", "###..........", "###..........",
        "########.....", "########.....",
        "###..........", "###..........", "###..........",
        "###..........", "###.......###", "#############",
        "############."],
    L: ["#####........", "#####........", "###..........",
        "###..........", "###..........", "###..........",
        "###..........", "###..........", "###..........",
        "###..........", "###..........", "###..........",
        "###.......###", "#############", "############."],
    P: ["############.", "#############", "###.......###",
        "###.......###", "###.......###", "###.......###",
        "#############", "############.",
        "###..........", "###..........", "###..........",
        "###..........", "###..........", "#####........",
        "#####........"],
    I: ["#############", ".###########.",
        ".....###.....", ".....###.....", ".....###.....",
        ".....###.....", ".....###.....", ".....###.....",
        ".....###.....", ".....###.....", ".....###.....",
        ".....###.....", ".....###.....",
        ".###########.", "#############"],
    S: [".############", "#############", "###.......###",
        "###..........", "###..........", "###..........",
        "###..........", "############.", ".############",
        "..........###", "..........###", "..........###",
        "###.......###", "#############", "############."],
    K: ["#####...#####", "###.....###..", "###....###...",
        "###...###....", "###..###.....", "###.###......",
        "######.......", "#####........", "######.......",
        "###.###......", "###..###.....", "###...###....",
        "###....###...", "###.....###..", "#####...#####"],
};

/* --- grec : ΕΛΠΙΣ ---------------------------------------------------------
 * Le mot dans son alphabet. Ἐλπίς est l'espérance restée au fond de la jarre ;
 * l'écrire en grec n'est pas un clin d'œil, c'est le nom. Même appareil
 * d'empattements que l'épigraphe — les deux vont ensemble.
 * Ε et Ι sont identiques aux latines, seuls Λ, Π et Σ changent. */
const GREC = {
    E: EPIGRAPHE.E,
    L: [".....###.....", ".....###.....", "....#####....",
        "....#####....", "...###.###...", "...###.###...",
        "..###...###..", "..###...###..", ".###.....###.",
        ".###.....###.", "###.......###", "###.......###",
        "###.......###", "#####...#####", "#####...#####"],
    P: ["#############", "#############", "###.......###",
        "###.......###", "###.......###", "###.......###",
        "###.......###", "###.......###", "###.......###",
        "###.......###", "###.......###", "###.......###",
        "###.......###", "#####...#####", "#####...#####"],
    I: EPIGRAPHE.I,
    K: EPIGRAPHE.K,          // Κ, le kappa : identique à la latine
    S: ["#############", "#############", "###..........",
        ".###.........", "..###........", "...###.......",
        "....###......", ".....###.....", "....###......",
        "...###.......", "..###........", ".###.........",
        "###..........", "#############", "#############"],
};

/* --- fin : capitales étroites, trait de deux -------------------------------
 * Le contrepoint du bloc. Neuf pixels de large au lieu de onze, et un trait de
 * deux : le mot se resserre, donc `k` grandit dans la même boîte et la scène
 * gagne en place. Dessiné à la main — l'amincir par calcul depuis le bloc
 * casse les jonctions (un trait de trois qui perd un pixel n'est pas un trait
 * de deux, c'est un trait de trois troué). */
const FIN = {
    E: ["#########", "#########", "##.......", "##.......", "##.......",
        "##.......", "#######..", "#######..", "##.......", "##.......",
        "##.......", "##.......", "##.......", "#########", "#########"],
    L: ["##.......", "##.......", "##.......", "##.......", "##.......",
        "##.......", "##.......", "##.......", "##.......", "##.......",
        "##.......", "##.......", "##.......", "#########", "#########"],
    P: ["########.", "########.", "##.....##", "##.....##", "##.....##",
        "##.....##", "########.", "########.", "##.......", "##.......",
        "##.......", "##.......", "##.......", "##.......", "##......."],
    I: ["#########", "#########", "...##....", "...##....", "...##....",
        "...##....", "...##....", "...##....", "...##....", "...##....",
        "...##....", "...##....", "...##....", "#########", "#########"],
    S: ["#########", "#########", "##.......", "##.......", "##.......",
        "##.......", "#########", "#########", ".......##", ".......##",
        ".......##", ".......##", ".......##", "#########", "#########"],
    K: ["##.....##", "##....##.", "##...##..", "##..##...", "##.##....",
        "####.....", "###......", "###......", "###......", "####.....",
        "##.##....", "##..##...", "##...##..", "##....##.", "##.....##"],
};

/* --- trois motifs DÉRIVÉS du bloc -----------------------------------------
 * Les dériver plutôt que les redessiner a la même vertu que le rehaut d'or :
 * ils ne peuvent pas se désynchroniser de la lettre. Retoucher le bloc les
 * retouche tous les trois. */

/* NÉON : on ne garde que le bord. Un fût de trois pixels perd sa colonne
 * centrale et devient un tube — c'est exactement la lecture recherchée, et
 * elle sort toute seule de la règle « plein qui touche du vide ». */
function creuser(g) {
    const H = g.length, W = g[0].length;
    const vide = (y, x) => y < 0 || y >= H || x < 0 || x >= W || g[y][x] !== "#";
    return g.map((ligne, y) => [...ligne].map((c, x) =>
        c === "#" && (vide(y - 1, x) || vide(y + 1, x)
                   || vide(y, x - 1) || vide(y, x + 1)) ? "#" : ".").join(""));
}

/* ARRONDI : on retire les coins EXTÉRIEURS, c'est-à-dire les pixels dont deux
 * voisins PERPENDICULAIRES sont vides. Un pixel qui a deux voisins vides
 * OPPOSÉS n'est pas un coin mais le bout d'un trait — l'enlever raccourcirait
 * la lettre. */
function adoucir(g) {
    const H = g.length, W = g[0].length;
    const vide = (y, x) => y < 0 || y >= H || x < 0 || x >= W || g[y][x] !== "#";
    return g.map((ligne, y) => [...ligne].map((c, x) => {
        if (c !== "#") return ".";
        const coin = (vide(y - 1, x) && vide(y, x - 1))
                  || (vide(y - 1, x) && vide(y, x + 1))
                  || (vide(y + 1, x) && vide(y, x - 1))
                  || (vide(y + 1, x) && vide(y, x + 1));
        return coin ? "." : "#";
    }).join(""));
}

/* POCHOIR : deux saignées horizontales, mais SEULEMENT dans les fûts — un
 * pixel qui a du plein au-dessus ET en dessous. Couper les rangées entières
 * trancherait aussi les barres horizontales, et le E perdrait ses bras. */
function ajourer(g) {
    const H = g.length;
    return g.map((ligne, y) => [...ligne].map((c, x) => {
        if (c !== "#" || (y !== 4 && y !== 10)) return c;
        const plein = yy => yy >= 0 && yy < H && g[yy][x] === "#";
        return plein(y - 1) && plein(y + 1) ? "." : c;
    }).join(""));
}

const derive = (src, f) =>
    Object.fromEntries(Object.entries(src).map(([c, g]) => [c, f(g)]));

const NEON = derive(BLOC, creuser);
const ARRONDI = derive(BLOC, adoucir);
const POCHOIR = derive(BLOC, ajourer);

/* `larg` est la largeur d'un glyphe, `ecart` le blanc entre deux. Ils sont
 * lus par la mise en scène : changer de motif change la largeur du mot, et
 * tout le reste suit. */
export const MOTIFS = {
    bloc: {
        etiquette: "Bloc", larg: 11, ecart: 3, glyphes: BLOC,
        quoi: "géométrique, trait de trois — le plus neutre",
    },
    or: {
        etiquette: "Bloc et or", larg: 11, ecart: 3, glyphes: BLOC,
        eclats: Object.fromEntries(
            Object.entries(BLOC).map(([c, g]) => [c, rehaut(g)])),
        quoi: "le même, avec le rehaut d'or des sprites",
    },
    epigraphe: {
        etiquette: "Épigraphe", larg: 13, ecart: 3, glyphes: EPIGRAPHE,
        quoi: "capitales gravées, empattements — « musée »",
    },
    grec: {
        etiquette: "Grec — ΕΛΠΙΣ", larg: 13, ecart: 3, glyphes: GREC,
        quoi: "le mot dans son alphabet",
    },
    fin: {
        etiquette: "Fin", larg: 9, ecart: 3, glyphes: FIN,
        quoi: "capitales étroites, trait de deux — le mot se resserre",
    },
    fin_or: {
        etiquette: "Fin et or", larg: 9, ecart: 3, glyphes: FIN,
        eclats: derive(FIN, rehaut),
        quoi: "le même, rehaussé d'or",
    },
    neon: {
        etiquette: "Néon", larg: 11, ecart: 3, glyphes: NEON,
        quoi: "creusé : il ne reste que le tube",
    },
    neon_or: {
        etiquette: "Néon doré", larg: 11, ecart: 3, glyphes: NEON,
        eclats: derive(NEON, rehaut),
        quoi: "le tube, avec sa lumière",
    },
    arrondi: {
        etiquette: "Arrondi", larg: 11, ecart: 3, glyphes: ARRONDI,
        eclats: derive(ARRONDI, rehaut),
        quoi: "coins cassés — le bloc, en plus doux",
    },
    pochoir: {
        etiquette: "Pochoir", larg: 11, ecart: 3, glyphes: POCHOIR,
        quoi: "deux saignées dans les fûts, comme une plaque à peindre",
    },
};

/* LE MOTIF RETENU, choisi le 2026-08-08. Les trois autres restent ici : ils ne
 * coûtent rien, le banc les montre toujours côte à côte, et revenir dessus est
 * un changement d'une ligne. Mais le tirage, lui, ne fait plus varier le mot —
 * une identité qui change d'un utilisateur à l'autre n'est plus une identité. */
export const MOTIF_RETENU = "or";

export const HAUT_LETTRE = 15;
export const MOT = ["E", "L", "P", "I", "S"];

/* LES MOTS QUE L'ON SAIT ÉCRIRE : ceux dont chaque lettre a son glyphe dans
 * TOUS les motifs. Le skin « kiki » écrit KIKI ; un mot hors de cette liste
 * retombe sur ELPIS plutôt que de peindre des trous. */
export const MOTS = { elpis: MOT, kiki: ["K", "I", "K", "I"] };

/* Contrôle au chargement plutôt qu'un défaut silencieux : une ligne trop
 * courte décalerait toute la lettre d'un pixel, et ça ne se voit qu'à l'œil,
 * tard. Toutes les lettres de tous les mots, dans tous les motifs. */
const LETTRES = [...new Set(Object.values(MOTS).flat())];
for (const [nom, m] of Object.entries(MOTIFS))
    for (const c of LETTRES) {
        const g = m.glyphes[c];
        if (!g) throw new Error(`${nom}.${c} : glyphe absent`);
        if (g.length !== HAUT_LETTRE)
            throw new Error(`${nom}.${c} : ${g.length} lignes au lieu de ${HAUT_LETTRE}`);
        g.forEach((l, i) => {
            if (l.length !== m.larg)
                throw new Error(`${nom}.${c} ligne ${i} : ${l.length} colonnes `
                                + `au lieu de ${m.larg}`);
        });
    }
