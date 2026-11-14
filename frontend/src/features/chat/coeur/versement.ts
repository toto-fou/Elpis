// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/versement.ts — versement à débit constant du texte reçu : tampon de gigue (débit et intervalle d'arrivée estimés), tranche à révéler à chaque image. */

const IMAGE_MS = 1000 / 60;
const FACTEUR = 0.25;
const INTERVALLE_MAX_MS = 300;
const RATTRAPAGE_MS = 120;
const DEBUT_MS = 90;
const DEBUT_MIN = 3;
const ARRIVEES_DEBUT = 3;
const GROUPE_MS = 5;
const DT_MIN_MS = 4;
const DT_MAX_MS = 100;

export interface EtatVersement {
  /** Date de la dernière arrivée intégrée aux moyennes (null : aucune). */
  dernier: number | null;
  /** Moyenne glissante de l'intervalle entre deux arrivées, plafonnée. */
  intervalle: number;
  /** Moyenne glissante du débit d'arrivée, en caractères par milliseconde. */
  debit: number;
  arrivees: number;
  /** Fraction de caractère portée à l'image suivante. */
  reste: number;
  /** Arrivées de moins de 5 ms regroupées : un paquet réseau n'est qu'une arrivée. */
  groupe: { t: number; n: number } | null;
}

export function creerVersement(): EtatVersement {
  return { dernier: null, intervalle: IMAGE_MS, debit: 0, arrivees: 0, reste: 0, groupe: null };
}

export function reinitialiserVersement(v: EtatVersement): void {
  Object.assign(v, creerVersement());
}

function integrer(v: EtatVersement): void {
  const g = v.groupe;
  if (!g) return;
  if (v.dernier !== null) {
    const ecart = Math.max(1, g.t - v.dernier);
    v.intervalle += FACTEUR * (Math.min(ecart, INTERVALLE_MAX_MS) - v.intervalle);
    v.debit += FACTEUR * (g.n / ecart - v.debit);
  }
  v.dernier = g.t;
  v.arrivees++;
  v.groupe = null;
}

/** Une arrivée de `n` caractères à la date `t` (ms) : met à jour le débit et l'intervalle estimés. */
export function noterArrivee(v: EtatVersement, t: number, n: number): void {
  if (n <= 0) return;
  const g = v.groupe;
  if (g && t - g.t < GROUPE_MS) {
    g.n += n;
    return;
  }
  integrer(v);
  v.groupe = { t, n };
}

/** Ne coupe ni une paire de substitution UTF-16 ni un CRLF. */
function sansCoupure(texte: string, prise: number): number {
  if (prise <= 0) return 0;
  if (prise >= texte.length) return texte.length;
  const cc = texte.charCodeAt(prise - 1);
  if (cc >= 0xd800 && cc <= 0xdbff) return prise + 1;
  if (cc === 13 && texte.charCodeAt(prise) === 10) return prise + 1;
  return prise;
}

/**
 * Nombre de caractères de `attente` à révéler à cette image (`dtMs` : temps depuis l'image précédente).
 * Au débit estimé, plus un rattrapage du surplus (constante de 120 ms) ; tout après un silence ; jamais plus que l'attente.
 */
export function tranche(v: EtatVersement, attente: string, maintenant: number, dtMs: number): number {
  const restant = attente.length;
  if (!restant) {
    v.reste = 0;
    return 0;
  }
  if (v.groupe && maintenant - v.groupe.t >= GROUPE_MS) integrer(v);
  const dt = Math.min(DT_MAX_MS, Math.max(DT_MIN_MS, dtMs));
  const arrivees = v.arrivees + (v.groupe ? 1 : 0);
  // Les premières arrivées n'attendent pas d'estimation.
  if (arrivees < ARRIVEES_DEBUT)
    return sansCoupure(attente, Math.min(restant, Math.max(DEBUT_MIN, Math.ceil((restant * dt) / DEBUT_MS))));
  const derniere = v.groupe ? v.groupe.t : (v.dernier ?? maintenant);
  const silence = maintenant - derniere > 2 * v.intervalle;
  const cible = v.debit * v.intervalle;
  v.reste +=
    v.debit * dt +
    (Math.max(0, restant - cible) * dt) / RATTRAPAGE_MS +
    (silence ? (restant * dt) / RATTRAPAGE_MS : 0);
  let prise = Math.floor(v.reste);
  if (prise < 1 && silence) prise = 1;
  prise = sansCoupure(attente, Math.min(restant, prise));
  if (prise > 0) v.reste -= prise;
  return prise;
}
