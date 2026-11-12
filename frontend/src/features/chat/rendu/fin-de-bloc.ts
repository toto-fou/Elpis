// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/fin-de-bloc.ts — répare la fin inachevée du texte affiché du bloc actif (marqueurs Markdown sans fermeture) avant son analyse. */

const BLANC = /\s/;
const PONCTUATION = /[\p{P}\p{S}]/u;
const LIMITE_BALISE = 300;
const LIMITE_DESTINATION = 2000;
const CREDIT_DESTINATIONS = 40000;
const TOURS_MAX = 6;
const PASSES_MAX = 8;
const BALISE =
  /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/y;
const AUTOLIEN = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/y;
const COURRIEL = /<[^\s<>@]+@[A-Za-z0-9.-]+>/y;
const DEBUT_URL = /^(?:(?:https?|ftp):\/\/|www\.)/i;
const BALISES_CONNUES = new Set(
  "div span img table thead tbody section article details summary svg script style iframe button input form strong code pre blockquote video audio figure textarea select label".split(
    " ",
  ),
);
const BALISE_SANS_ESPACE = /^<\/?[A-Za-z][^\s<>]*$/;
const BALISE_AVEC_ATTRIBUT = /^<\/?[A-Za-z][A-Za-z0-9-]*[ \t]+[^<>\n]*=[^<>\n]*$/;
const DESTINATION_INACHEVEE = /^\s*\S*(?:\s+["'(][^\n]*)?$/;
const LIGNE_HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const RESTE_NU = /^(?:#{1,6}|-{1,2}|`{1,2}|~{1,2})$/;
const CASE_A_COCHER = /^\[[ xX]\](?:\s+|$)/;
const RESTE_PUCE = /^(?:[-+*]|\d{1,3}[.)])$/;
const NUMERO_LONG = /^\s*\d{4,}[.)]\s*$/;
const DELIMITEUR = /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;
const DELIMITEUR_PARTIEL = /^[ \t|:-]*$/;

interface Delimiteur {
  car: number;
  pos: number;
  fin: number;
  orig: number;
  reste: number;
  ouvre: boolean;
  ferme: boolean;
  actif: boolean;
  mot: boolean;
  ponct: boolean;
}

interface Balayage {
  coupe: string | null;
  fermetures: string;
}

interface Prefixe {
  saut: number;
  liste: boolean;
  titre: boolean;
  citation: boolean;
  indent: number;
}

interface Lignes {
  debuts: number[];
  fins: number[];
  vides: boolean[];
  para: number[];
  fence: boolean;
}

/** Texte à afficher pour un bloc actif : sa fin inachevée est fermée ou masquée, le reste est rendu tel quel. */
export function reparerFinDeBloc(texte: string): string {
  try {
    let courant = texte;
    for (let passe = 0; passe < PASSES_MAX; passe++) {
      const suivant = reparer(courant);
      if (suivant === courant) break;
      courant = suivant;
    }
    return courant;
  } catch {
    return texte;
  }
}

function estBlanc(c: number): boolean {
  return c === 32 || c === 9;
}

function finUtile(texte: string): number {
  let fin = texte.length;
  while (fin > 0 && texte.charCodeAt(fin - 1) <= 32) fin--;
  return fin;
}

/** 0 : bord ou blanc, 1 : ponctuation ou symbole, 2 : caractère de mot (le tilde n'est pas de la ponctuation). */
function classe(c: string): number {
  if (c === "" || BLANC.test(c)) return 0;
  if (c !== "~" && PONCTUATION.test(c)) return 1;
  return 2;
}

function carAvant(t: string, pos: number): string {
  if (pos <= 0) return "";
  const b = t.charCodeAt(pos - 1);
  if (b >= 0xdc00 && b <= 0xdfff && pos >= 2) {
    const h = t.charCodeAt(pos - 2);
    if (h >= 0xd800 && h <= 0xdbff) return t.slice(pos - 2, pos);
  }
  return t.charAt(pos - 1);
}

function carApres(t: string, pos: number): string {
  return pos >= t.length ? "" : String.fromCodePoint(t.codePointAt(pos) ?? 32);
}

function ponctuationAscii(c: number): boolean {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

function estLettre(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function estChiffre(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** Découpe en lignes jusqu'au dernier caractère utile, avec le début du paragraphe de chaque ligne et l'état des fences. */
function lire(texte: string, fin: number): Lignes {
  const debuts: number[] = [];
  const fins: number[] = [];
  const vides: boolean[] = [];
  const para: number[] = [];
  let courant = 0;
  let fenceCar = 0;
  let fenceLong = 0;
  let a = 0;
  while (a < fin) {
    const nl = texte.indexOf("\n", a);
    const b = nl < 0 || nl > fin ? fin : nl;
    const e = b > a && texte.charCodeAt(b - 1) === 13 ? b - 1 : b;
    let i = a;
    while (i < e && estBlanc(texte.charCodeAt(i))) i++;
    const k = debuts.length;
    debuts.push(a);
    fins.push(e);
    vides.push(i === e);
    const c = i < e ? texte.charCodeAt(i) : 0;
    if (c === 96 || c === 126) {
      let j = i;
      while (j < e && texte.charCodeAt(j) === c) j++;
      const longueur = j - i;
      if (longueur >= 3) {
        if (fenceCar === 0) {
          const reste = texte.indexOf("`", j);
          if (c === 126 || reste < 0 || reste >= e) {
            fenceCar = c;
            fenceLong = longueur;
            courant = k + 1;
          }
        } else if (c === fenceCar && longueur >= fenceLong && texte.slice(j, e).trim() === "") {
          fenceCar = 0;
          courant = k + 1;
        }
        para.push(courant);
        a = b + 1;
        continue;
      }
    }
    if (fenceCar === 0 && i === e) courant = k + 1;
    para.push(courant);
    a = b + 1;
  }
  return { debuts, fins, vides, para, fence: fenceCar !== 0 };
}

/** Conteneurs de début de ligne (citation, puces, numéros, titre) : nombre de caractères qui ne sont pas du texte. */
function prefixe(ln: string): Prefixe {
  const n = ln.length;
  let i = 0;
  let liste = false;
  let titre = false;
  let citation = false;
  let indent = -1;
  for (;;) {
    let b = i;
    let largeur = 0;
    while (b < n && estBlanc(ln.charCodeAt(b))) largeur += ln.charCodeAt(b++) === 9 ? 4 : 1;
    if (indent < 0) indent = largeur;
    const c = ln.charCodeAt(b);
    if (c === 62) {
      citation = true;
      i = b + 1;
      if (estBlanc(ln.charCodeAt(i))) i++;
      continue;
    }
    if ((c === 45 || c === 43 || c === 42) && (b + 1 >= n || estBlanc(ln.charCodeAt(b + 1)))) {
      liste = true;
      i = b + 1;
      while (i < n && estBlanc(ln.charCodeAt(i))) i++;
      continue;
    }
    if (estChiffre(c)) {
      let j = b;
      while (j < n && j - b < 9 && estChiffre(ln.charCodeAt(j))) j++;
      const m = ln.charCodeAt(j);
      if ((m === 46 || m === 41) && (j + 1 >= n || estBlanc(ln.charCodeAt(j + 1)))) {
        liste = true;
        i = j + 1;
        while (i < n && estBlanc(ln.charCodeAt(i))) i++;
        continue;
      }
    }
    if (c === 35) {
      let j = b;
      while (j < n && ln.charCodeAt(j) === 35) j++;
      if (j - b <= 6 && (j >= n || estBlanc(ln.charCodeAt(j)))) {
        titre = true;
        i = j;
        while (i < n && estBlanc(ln.charCodeAt(i))) i++;
        break;
      }
    }
    if (!liste && !citation) i = b;
    break;
  }
  return { saut: i, liste, titre, citation, indent: Math.max(indent, 0) };
}

/** Ligne faite seulement d'un marqueur de bloc sans contenu (titre, puce, numéro, citation, accents graves ou tildes). */
function marqueurNu(ln: string): boolean {
  if (NUMERO_LONG.test(ln)) return false;
  const p = prefixe(ln);
  if (p.titre) return ln.slice(p.saut).trim() === "";
  if (p.liste || p.citation) {
    const reste = ln.slice(p.saut).replace(CASE_A_COCHER, "").trim();
    return reste === "" || RESTE_NU.test(reste) || RESTE_PUCE.test(reste);
  }
  return RESTE_NU.test(ln.trim());
}

function estLigneFence(ln: string): boolean {
  const t = ln.trimStart();
  return t.startsWith("```") || t.startsWith("~~~");
}

function commencePar(ln: string, car: string): boolean {
  return ln.trimStart().startsWith(car);
}

function pipeEchappe(ln: string, k: number): boolean {
  let n = 0;
  while (k - 1 - n >= 0 && ln.charCodeAt(k - 1 - n) === 92) n++;
  return n % 2 === 1;
}

/** Nombre de cellules d'une ligne de tableau (pipes non échappés, pipe de bord ignoré). */
function compterCellules(ln: string): number {
  const cellules: string[] = [];
  let debut = 0;
  for (let k = 0; k < ln.length; k++) {
    if (ln.charCodeAt(k) === 124 && !pipeEchappe(ln, k)) {
      cellules.push(ln.slice(debut, k));
      debut = k + 1;
    }
  }
  cellules.push(ln.slice(debut));
  if (cellules[0]?.trim() === "") cellules.shift();
  if (cellules.length > 0 && cellules[cellules.length - 1]?.trim() === "") cellules.pop();
  return cellules.length;
}

function dernierPipe(ln: string): number {
  for (let k = ln.length - 1; k >= 0; k--) if (ln.charCodeAt(k) === 124 && !pipeEchappe(ln, k)) return k;
  return -1;
}

function reparer(texte: string): string {
  const fin = finUtile(texte);
  if (fin === 0) return texte;
  const queue = texte.slice(fin);
  if (queue.indexOf("\n") !== queue.lastIndexOf("\n")) return texte;
  const lignes = lire(texte, fin);
  if (lignes.fence || lignes.debuts.length === 0) return texte;
  const ligne = (k: number): string => texte.slice(lignes.debuts[k] ?? 0, lignes.fins[k] ?? 0);
  const sans = (k: number): string => {
    let j = k - 1;
    while (j >= 0 && lignes.vides[j]) j--;
    if (j < 0) return "";
    return texte.slice(0, lignes.fins[j] ?? 0) + (j < k - 1 ? "\n\n" : "");
  };
  let l = lignes.debuts.length - 1;
  let coupe = false;
  while (l >= 0 && marqueurNu(ligne(l))) {
    coupe = true;
    l--;
    while (l >= 0 && lignes.vides[l]) l--;
  }
  if (l < 0) return "";
  if (coupe && lignes.vides[l + 1]) return texte.slice(0, lignes.fins[l] ?? 0) + "\n\n";
  const t = coupe ? sans(l + 1) : texte;
  const fut = coupe ? (lignes.fins[l] ?? 0) : fin;
  const ln = ligne(l);
  if (estLigneFence(ln) || LIGNE_HR.test(ln)) return t;
  if (commencePar(ln, "|")) {
    const r = tableau(texte, t, fut, lignes, l, ligne, sans);
    if (r !== undefined) return r;
  }
  const debut = debutContexte(lignes, l, ligne);
  if (debut === null) return t;
  return appliquerEnLigne(t, fut, debut);
}

/** Tableau en cours : texte réparé, ou `undefined` si le bloc n'est pas (ou plus) un tableau en attente. */
function tableau(
  texte: string,
  t: string,
  fut: number,
  lignes: Lignes,
  l: number,
  ligne: (k: number) => string,
  sans: (k: number) => string,
): string | undefined {
  const plancher = lignes.para[l] ?? 0;
  let s = l;
  while (s - 1 >= plancher && commencePar(ligne(s - 1), "|")) s--;
  if (s === l) return sans(s);
  const entete = ligne(s);
  const delim = ligne(s + 1);
  const nh = compterCellules(entete);
  const valide = DELIMITEUR.test(delim) && compterCellules(delim) === nh;
  if (!valide) {
    const termine = fut < texte.length && texte.indexOf("\n", fut) >= 0;
    if (l === s + 1 && !termine && DELIMITEUR_PARTIEL.test(delim) && compterCellules(delim) <= nh)
      return sans(s);
    return undefined;
  }
  if (l === s + 1) return t;
  const ln = ligne(l);
  const nu = ln.trim();
  if (nu === "|") return sans(l);
  if (nu.endsWith("|") && !pipeEchappe(nu, nu.length - 1)) return t;
  const q = dernierPipe(ln);
  return appliquerEnLigne(t, fut, (lignes.debuts[l] ?? 0) + q + 1);
}

/** Début (dans le texte) du contenu en ligne du dernier paragraphe ou élément, ou `null` si rien à réparer. */
function debutContexte(lignes: Lignes, l: number, ligne: (k: number) => string): number | null {
  const plancher = lignes.para[l] ?? 0;
  const infos = new Map<number, Prefixe>();
  const info = (k: number): Prefixe => {
    let p = infos.get(k);
    if (!p) {
      p = prefixe(ligne(k));
      infos.set(k, p);
    }
    return p;
  };
  const sansTexte = (k: number): boolean => {
    const ln = ligne(k);
    const p = info(k);
    return LIGNE_HR.test(ln) || (!p.titre && LIGNE_HR.test(ln.slice(p.saut))) || estLigneFence(ln);
  };
  let s = l;
  while (s > plancher) {
    const ici = info(s);
    if (ici.liste || ici.titre || (ici.citation && !info(s - 1).citation) || sansTexte(s)) break;
    if (info(s - 1).titre || sansTexte(s - 1) || commencePar(ligne(s - 1), "|")) break;
    s--;
  }
  if (sansTexte(s)) return null;
  const p = info(s);
  if (!p.liste && !p.titre && !p.citation && p.indent >= 4) return null;
  return (lignes.debuts[s] ?? 0) + p.saut;
}

function appliquerEnLigne(t: string, fut: number, debut: number): string {
  if (debut >= fut) return t;
  const ctx = t.slice(debut, fut);
  const r = reparerEnLigne(ctx);
  return r === null ? t : t.slice(0, debut) + r + t.slice(fut);
}

/** Contenu en ligne réparé, ou `null` s'il n'y a rien à changer. */
function reparerEnLigne(ctx: string): string | null {
  let courant = ctx;
  let modifie = false;
  for (let tour = 0; tour < TOURS_MAX; tour++) {
    const r = balayer(courant);
    if (r.coupe !== null) {
      courant = r.coupe;
      modifie = true;
      continue;
    }
    if (r.fermetures === "") return modifie ? courant.trimEnd() : null;
    return courant.trimEnd() + r.fermetures;
  }
  return null;
}

function fermetureCode(t: string, depuis: number, longueur: number, echecs: Set<number>): number {
  if (echecs.has(longueur)) return -1;
  const n = t.length;
  let k = depuis;
  for (;;) {
    k = t.indexOf("`", k);
    if (k < 0) {
      echecs.add(longueur);
      return -1;
    }
    let j = k;
    while (j < n && t.charCodeAt(j) === 96) j++;
    if (j - k === longueur) return k;
    k = j;
  }
}

function fermerDestination(t: string, depuis: number, credit: { reste: number }): number {
  const fin = Math.min(t.length, depuis + LIMITE_DESTINATION, depuis + credit.reste);
  let prof = 1;
  for (let k = depuis; k < fin; k++) {
    const c = t.charCodeAt(k);
    if (c === 92) k++;
    else if (c === 40) prof++;
    else if (c === 41 && --prof === 0) {
      credit.reste -= k + 1 - depuis;
      return k + 1;
    }
  }
  credit.reste -= Math.max(fin - depuis, 0);
  return -1;
}

/** Fin (exclue) d'une balise ou d'un autolien complet en `i`, -2 pour une balise inachevée à masquer, -1 sinon. */
function balise(t: string, i: number): number {
  if (t.length - i <= 2 && /^<\/?$/.test(t.slice(i))) return classe(carAvant(t, i)) === 2 ? -1 : -2;
  const c = t.charCodeAt(i + 1);
  if (!(estLettre(c) || (c === 47 && estLettre(t.charCodeAt(i + 2))))) return -1;
  const tranche = t.slice(i, i + LIMITE_BALISE + 1);
  for (const re of [BALISE, AUTOLIEN, COURRIEL]) {
    re.lastIndex = 0;
    const m = re.exec(tranche);
    if (m) return i + m[0].length;
  }
  if (tranche.length > LIMITE_BALISE || tranche.includes(">")) return -1;
  if (classe(carAvant(t, i)) === 2) return -1;
  if (BALISE_SANS_ESPACE.test(tranche) || BALISE_AVEC_ATTRIBUT.test(tranche)) return -2;
  const nom = /^<\/?([A-Za-z][A-Za-z0-9-]*)[ \t]/.exec(tranche)?.[1];
  return nom && BALISES_CONNUES.has(nom.toLowerCase()) && !tranche.includes("\n") ? -2 : -1;
}

/** Fin d'une adresse nue (http, https, ftp, www) commençant en `i`, sans la ponctuation et les marqueurs finaux ; -1 sinon. */
function finUrl(t: string, i: number): number {
  if (i > 0 && classe(carAvant(t, i)) === 2) return -1;
  if (!DEBUT_URL.test(t.slice(i, i + 8))) return -1;
  let j = i;
  const n = t.length;
  while (j < n) {
    const c = t.charCodeAt(j);
    if (c <= 32 || c === 60 || c === 93) break;
    j++;
  }
  while (j > i && "?!.,:;*_'\"~)".includes(t.charAt(j - 1))) j--;
  return Math.max(j, i + 1);
}

function balayer(t: string): Balayage {
  const n = t.length;
  const delims: Delimiteur[] = [];
  const crochets: number[] = [];
  const echecs = new Set<number>();
  const credit = { reste: CREDIT_DESTINATIONS };
  let code = -1;
  let longCode = 0;
  let antislashFinal = false;
  let i = 0;
  while (i < n && code < 0) {
    const c = t.charCodeAt(i);
    if (c === 92) {
      if (i + 1 >= n) antislashFinal = true;
      i += i + 1 < n && ponctuationAscii(t.charCodeAt(i + 1)) ? 2 : 1;
    } else if (c === 96) {
      let j = i + 1;
      while (j < n && t.charCodeAt(j) === 96) j++;
      const f = fermetureCode(t, j, j - i, echecs);
      if (f >= 0) i = f + (j - i);
      else if (j >= n) return { coupe: t.slice(0, i), fermetures: "" };
      else if (!BLANC.test(carApres(t, j))) {
        code = i;
        longCode = j - i;
      } else i = j;
    } else if (c === 42 || c === 95 || c === 126) {
      let j = i + 1;
      while (j < n && t.charCodeAt(j) === c) j++;
      if (c !== 126 || j - i === 2) {
        const pc = classe(carAvant(t, i));
        const nc = classe(carApres(t, j));
        const barre = c === 126;
        const gauche = nc !== 0 && (barre || nc !== 1 || pc !== 2);
        const droite = pc !== 0 && (barre || pc !== 1 || nc !== 2);
        const souligne = c === 95;
        delims.push({
          car: c,
          pos: i,
          fin: j,
          orig: j - i,
          reste: j - i,
          ouvre: souligne ? gauche && (!droite || pc === 1) : gauche,
          ferme: souligne ? droite && (!gauche || nc === 1) : droite,
          actif: true,
          mot: pc === 2,
          ponct: pc === 1,
        });
      }
      i = j;
    } else if (c === 60) {
      const b = balise(t, i);
      if (b === -2) return { coupe: t.slice(0, i), fermetures: "" };
      i = b > 0 ? b : i + 1;
    } else if (c === 91) {
      crochets.push(i);
      i++;
    } else if (c === 93) {
      const ouvrant = crochets.pop();
      if (t.charCodeAt(i + 1) !== 40) {
        i++;
        continue;
      }
      const f = fermerDestination(t, i + 2, credit);
      if (f >= 0) {
        i = f;
        continue;
      }
      if (ouvrant !== undefined) {
        const reste = t.slice(i + 2);
        if (reste.length <= LIMITE_DESTINATION && !reste.includes(")") && DESTINATION_INACHEVEE.test(reste)) {
          const debut = ouvrant > 0 && t.charCodeAt(ouvrant - 1) === 33 ? ouvrant - 1 : ouvrant;
          return { coupe: t.slice(0, debut) + t.slice(ouvrant + 1, i), fermetures: "" };
        }
      }
      i += 2;
    } else if (c === 104 || c === 72 || c === 119 || c === 87 || c === 102 || c === 70) {
      const u = finUrl(t, i);
      i = u > 0 ? u : i + 1;
    } else i++;
  }
  if (code >= 0) {
    if (t.charCodeAt(n - 1) === 96) {
      let k = n;
      while (k > 0 && t.charCodeAt(k - 1) === 96) k--;
      return { coupe: t.slice(0, k), fermetures: "" };
    }
  } else {
    const dernier = crochets[crochets.length - 1];
    if (dernier === n - 1) {
      const debut = n >= 2 && t.charCodeAt(n - 2) === 33 ? n - 2 : n - 1;
      const av = carAvant(t, debut);
      if (av === "" || BLANC.test(av) || (PONCTUATION.test(av) && av !== "]" && av !== ")"))
        return { coupe: t.slice(0, debut), fermetures: "" };
    }
  }
  traiter(delims);
  let fermetures = "";
  const vus = new Map<number, Delimiteur>();
  for (let k = delims.length - 1; k >= 0; k--) {
    const d = delims[k];
    if (!d?.actif || !d.ouvre || d.reste === 0 || d.mot || identifiant(t, d)) continue;
    const doublon = vus.get(d.car * 8 + d.reste);
    if (doublon?.ponct) return { coupe: null, fermetures: "" };
    vus.set(d.car * 8 + d.reste, d);
    fermetures += String.fromCharCode(d.car).repeat(d.reste);
  }
  if (code >= 0) fermetures = "`".repeat(longCode) + fermetures;
  if (code < 0 && fermetures.startsWith("~") && t.charCodeAt(n - 1) === 126) {
    let k = n;
    while (k > 0 && t.charCodeAt(k - 1) === 126) k--;
    return { coupe: t.slice(0, k), fermetures: "" };
  }
  if (code < 0) {
    const d = delims[delims.length - 1];
    if (d && d.fin === n && d.reste === d.orig && !d.mot && (d.orig >= 2 || fermetures !== ""))
      return { coupe: t.slice(0, d.pos), fermetures: "" };
  }
  if (antislashFinal && fermetures !== "") return { coupe: t.slice(0, n - 1), fermetures: "" };
  return { coupe: null, fermetures };
}

/** Un `_` ouvrant suivi d'un mot qui contient lui-même un `_` est un identifiant, pas une emphase. */
function identifiant(t: string, d: Delimiteur): boolean {
  if (d.car !== 95) return false;
  for (let k = d.fin; k < t.length; k++) {
    const c = t.charCodeAt(k);
    if (c <= 32) return false;
    if (c === 95 && (estLettre(t.charCodeAt(k + 1)) || estChiffre(t.charCodeAt(k + 1)))) return true;
  }
  return false;
}

/** Appariement des délimiteurs d'emphase (algorithme de CommonMark) : les ouvrants sans fermant restent actifs. */
function traiter(d: Delimiteur[]): void {
  const m = d.length;
  if (m < 2) return;
  const prec = new Int32Array(m);
  for (let k = 0; k < m; k++) prec[k] = k - 1;
  const bas = new Int32Array(18).fill(-1);
  for (let ci = 0; ci < m; ci++) {
    const f = d[ci];
    if (!f?.ferme) continue;
    const type = f.car === 42 ? 0 : f.car === 95 ? 1 : 2;
    const cle = type * 6 + (f.ouvre ? 3 : 0) + (f.orig % 3);
    while (f.reste > 0) {
      let trouve = -1;
      for (let oi = prec[ci] ?? -1; oi > (bas[cle] ?? -1); oi = prec[oi] ?? -1) {
        const o = d[oi];
        if (!o?.actif || !o.ouvre || o.car !== f.car || o.reste === 0) continue;
        const somme = (o.orig + f.orig) % 3 === 0 && (o.orig % 3 !== 0 || f.orig % 3 !== 0);
        if ((o.ferme || f.ouvre) && somme) continue;
        trouve = oi;
        break;
      }
      if (trouve < 0) {
        bas[cle] = prec[ci] ?? -1;
        if (!f.ouvre) f.actif = false;
        break;
      }
      const o = d[trouve];
      if (!o) break;
      const usage = f.car === 126 || (f.reste >= 2 && o.reste >= 2) ? 2 : 1;
      for (let k = prec[ci] ?? -1; k > trouve; k = prec[k] ?? -1) {
        const e = d[k];
        if (e) e.actif = false;
      }
      o.reste -= usage;
      f.reste -= usage;
      prec[ci] = o.reste > 0 ? trouve : (prec[trouve] ?? -1);
      if (o.reste === 0) o.actif = false;
    }
    if (f.reste === 0) f.actif = false;
  }
}
