// SPDX-License-Identifier: MIT
/** frontend/src/features/voix/segmenteur.ts — découpage en phrases prononçables d'un flux de texte en cours de génération, code retiré, abréviations et listes numérotées respectées. */

export interface ReglagesSegmenteur {
  premier?: number;
  suivant?: number;
}

export interface Segmenteur {
  push(delta: string): string[];
  flush(): string[];
  reset(): void;
}

/** Abréviations dont le point ne termine pas une phrase. */
const ABREVIATIONS = new Set(
  (
    "m mm mme mlle mgr dr pr me st ste cf ex env art chap fig vol " +
    "no nos p pp ed trad dir coll janv fevr avr juil sept oct nov dec " +
    "tel fax av bd pl rte etc vs ie eg"
  ).split(" "),
);

const FIN_PHRASE = ".!?…";
const FIN_MEMBRE = ",;:";
const FERMANTES = "\"')]}»”";
const DECIMAL = /\d[.,]\d/;

function estAbreviation(texte: string, iPoint: number): boolean {
  let debut = iPoint;
  while (debut > 0 && (/[a-zA-ZÀ-ÿ]/.test(texte[debut - 1] ?? "") || texte[debut - 1] === ".")) debut--;
  const mot = texte.slice(debut, iPoint).toLowerCase().replace(/\./g, "");
  if (!mot) return false;
  if (mot.length === 1) return true;
  return ABREVIATIONS.has(mot);
}

function finDeGroupe(texte: string, i: number): number {
  let fin = i + 1;
  for (;;) {
    while (
      fin < texte.length &&
      (FIN_PHRASE.indexOf(texte[fin] ?? "") >= 0 || FERMANTES.indexOf(texte[fin] ?? "") >= 0)
    ) {
      fin++;
    }
    // Typographie française : « … ? » — une espace sépare la ponctuation du guillemet fermant.
    if (
      fin + 1 < texte.length &&
      (texte[fin] === " " || texte[fin] === " ") &&
      FERMANTES.indexOf(texte[fin + 1] ?? "") >= 0
    ) {
      fin += 2;
      continue;
    }
    return fin;
  }
}

/** « 1. Premier point » : le point d'une liste numérotée n'est pas une fin de phrase. */
function estPuceNumerotee(texte: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\d/.test(texte[j] ?? "")) j--;
  if (j === i - 1) return false;
  while (j >= 0 && (texte[j] === " " || texte[j] === "\t")) j--;
  return j < 0 || texte[j] === "\n";
}

function estFinDePhrase(texte: string, i: number): boolean {
  const c = texte[i] ?? "";
  if (FIN_PHRASE.indexOf(c) < 0) return false;
  if (c === "." && DECIMAL.test(texte.slice(Math.max(0, i - 1), i + 2))) return false;
  if (c === "." && estPuceNumerotee(texte, i)) return false;
  if (c === "." && estAbreviation(texte, i)) return false;
  const fin = finDeGroupe(texte, i);
  if (fin >= texte.length) return false;
  return /\s/.test(texte[fin] ?? "");
}

/** Accumule le flux du modèle et rend des morceaux prononçables ; `premier` plus court que `suivant` pour que le son démarre tôt. */
export function creeSegmenteur(reglages?: ReglagesSegmenteur): Segmenteur {
  const premier = (reglages && reglages.premier) || 40;
  const suivant = (reglages && reglages.suivant) || 160;
  let tampon = "";
  let emis = 0;
  let dansCode = false;
  let residu = "";

  function prochaineFence(t: string): number {
    const a = t.indexOf("```");
    const b = t.indexOf("~~~");
    if (a < 0) return b;
    if (b < 0) return a;
    return Math.min(a, b);
  }

  /** Retire le code en flux ; une amorce de fence en bout de fragment est gardée pour le suivant. */
  function filtreCode(delta: string): { texte: string; reste: string } {
    let sortie = "";
    let reste = delta;
    for (;;) {
      const i = prochaineFence(reste);
      if (i < 0) {
        let garde = 0;
        if (reste.endsWith("``") || reste.endsWith("~~")) garde = 2;
        else if (reste.endsWith("`") || reste.endsWith("~")) garde = 1;
        const morceau = garde ? reste.slice(0, reste.length - garde) : reste;
        if (!dansCode) sortie += morceau;
        return { texte: sortie, reste: garde ? reste.slice(reste.length - garde) : "" };
      }
      const avant = reste.slice(0, i);
      reste = reste.slice(i + 3);
      if (!dansCode) sortie += `${avant} `;
      dansCode = !dansCode;
    }
  }

  function coupe(): number | null {
    if (!tampon.trim()) return null;
    const limite = emis === 0 ? premier : suivant;
    for (let i = 0; i < tampon.length; i++) {
      if (FIN_PHRASE.indexOf(tampon[i] ?? "") >= 0 && estFinDePhrase(tampon, i))
        return finDeGroupe(tampon, i);
    }
    if (tampon.length < limite) return null;
    const fenetre = tampon.slice(0, limite);
    for (let i = fenetre.length - 1; i > 0; i--) {
      if (
        FIN_MEMBRE.indexOf(fenetre[i] ?? "") >= 0 &&
        i + 1 < tampon.length &&
        /\s/.test(tampon[i + 1] ?? "")
      ) {
        return i + 1;
      }
    }
    // Aucune ponctuation dans la fenêtre : attendre jusqu'au double du seuil plutôt que couper en plein souffle.
    if (tampon.length < 2 * limite) return null;
    const espace = tampon.slice(0, 2 * limite).lastIndexOf(" ");
    if (espace > 0) return espace + 1;
    return tampon.length >= 3 * limite ? 2 * limite : null;
  }

  return {
    push(delta) {
      if (!delta) return [];
      const r = filtreCode(residu + delta);
      residu = r.reste;
      tampon += r.texte;
      const morceaux: string[] = [];
      for (;;) {
        const i = coupe();
        if (i === null) break;
        const brut = tampon.slice(0, i);
        tampon = tampon.slice(i).replace(/^\s+/, "");
        if (brut.trim()) {
          emis++;
          morceaux.push(brut.trim());
        }
      }
      return morceaux;
    },
    flush() {
      const r = filtreCode(residu);
      residu = "";
      tampon += r.texte;
      const reste = tampon.trim();
      tampon = "";
      if (!reste) return [];
      emis++;
      return [reste];
    },
    reset() {
      tampon = "";
      residu = "";
      emis = 0;
      dansCode = false;
    },
  };
}
