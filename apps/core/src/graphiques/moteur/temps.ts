// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/temps.ts — `datetime` naïfs et `timedelta` de Python (microsecondes en bigint) pour le diagramme de Gantt. */
import { ErreurPython } from "@elpis/commun";

/** Date-heure naïve : microsecondes écoulées depuis 1970-01-01 00:00:00 sur l'horloge murale (sans fuseau). */
export type Naif = bigint;

const US_PAR_SECONDE = 1_000_000n;
const US_PAR_JOUR = 86_400_000_000n;

/** Jours depuis 1970-01-01 d'une date du calendrier grégorien proleptique. */
export function joursDepuis1970(y: number, m: number, d: number): number {
  const a = m <= 2 ? y - 1 : y;
  const ere = Math.floor(a / 400);
  const yoe = a - ere * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return ere * 146_097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719_468;
}

/** Date du calendrier pour un nombre de jours depuis 1970-01-01. */
function dateDepuisJours(z0: number): { y: number; m: number; d: number } {
  const z = z0 + 719_468;
  const ere = Math.floor(z / 146_097);
  const doe = z - ere * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + ere * 400 + (m <= 2 ? 1 : 0), m, d };
}

export function estBissextile(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

export function joursDansMois(y: number, m: number): number {
  return m === 2 ? (estBissextile(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** `datetime.date(y, m, d)` accepté par Python (année 1 à 9999). */
export function dateValide(y: number, m: number, d: number): boolean {
  return y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= joursDansMois(y, m);
}

const MIN_NAIF = BigInt(joursDepuis1970(1, 1, 1)) * US_PAR_JOUR;
const MAX_NAIF = BigInt(joursDepuis1970(9999, 12, 31) + 1) * US_PAR_JOUR - 1n;

function verifier(n: Naif): Naif {
  if (n < MIN_NAIF || n > MAX_NAIF) throw new ErreurPython("OverflowError", "date value out of range");
  return n;
}

/** Minuit d'un jour valide. */
export function minuit(y: number, m: number, d: number): Naif {
  return BigInt(joursDepuis1970(y, m, d)) * US_PAR_JOUR;
}

/** `datetime.fromisoformat("AAAA-MM-JJ")` d'une date déjà validée. */
export function naifDepuisIso(s: string): Naif {
  return minuit(Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10)));
}

/** Un instant JS lu sur l'horloge murale locale (`datetime.now()`). */
export function naifLocal(d: Date): Naif {
  return (
    minuit(d.getFullYear(), d.getMonth() + 1, d.getDate()) +
    BigInt(((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * 1000 + d.getMilliseconds()) * 1000n
  );
}

function plancherDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

function composantes(n: Naif): { y: number; m: number; d: number; reste: bigint } {
  const jours = plancherDiv(n, US_PAR_JOUR);
  return { ...dateDepuisJours(Number(jours)), reste: n - jours * US_PAR_JOUR };
}

export function jour(n: Naif): number {
  return composantes(n).d;
}

export function mois(n: Naif): number {
  return composantes(n).m;
}

/** `dt.date().isoformat()`. */
export function dateIso(n: Naif): string {
  const { y, m, d } = composantes(n);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Durée en microsecondes (`timedelta`). */
export type Duree = bigint;

const MAX_JOURS = 999_999_999n;
const INT_C_MAX = 2_147_483_647n;

function dureeValide(us: bigint): Duree {
  const jours = plancherDiv(us, US_PAR_JOUR);
  if (jours < -INT_C_MAX - 1n || jours > INT_C_MAX)
    throw new ErreurPython("OverflowError", "Python int too large to convert to C int");
  if (jours < -MAX_JOURS || jours > MAX_JOURS)
    throw new ErreurPython("OverflowError", `days=${jours}; must have magnitude <= 999999999`);
  return us;
}

/** `round()` de C : demi vers l'infini. */
function arrondiC(x: number): number {
  return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
}

/** `timedelta(days=jours)` d'un entier ou d'un flottant : partie entière exacte, fraction arrondie à la microseconde (moitié au pair). */
export function dureeJours(jours: number): Duree {
  const entiere = Math.trunc(jours);
  const fraction = jours - entiere;
  if (!Number.isFinite(jours))
    throw Number.isNaN(jours)
      ? new ErreurPython("ValueError", "cannot convert float NaN to integer")
      : new ErreurPython("OverflowError", "cannot convert float infinity to integer");
  let x = BigInt(entiere) * US_PAR_JOUR;
  if (fraction !== 0) {
    const produit = Number(US_PAR_JOUR) * fraction;
    const ip = Math.trunc(produit);
    const reste = produit - ip;
    x += BigInt(ip);
    if (reste !== 0) {
      let entierUs = arrondiC(reste);
      if (Math.abs(entierUs - reste) === 0.5) {
        const impair = (x & 1n) !== 0n ? 1 : 0;
        entierUs = 2 * arrondiC((reste + impair) * 0.5) - impair;
      }
      x += BigInt(entierUs);
    }
  }
  return dureeValide(x);
}

export const UN_JOUR: Duree = US_PAR_JOUR;

export function plus(n: Naif, d: Duree): Naif {
  return verifier(n + d);
}

export function moins(n: Naif, d: Duree): Naif {
  return verifier(n - d);
}

/** `a - b` entre deux dates. */
export function ecart(a: Naif, b: Naif): Duree {
  return a - b;
}

/** `timedelta.days` (division par le bas). */
export function joursDeDuree(d: Duree): number {
  return Number(plancherDiv(d, US_PAR_JOUR));
}

/** Division entière arrondie au plus proche, moitié au pair (`divide_nearest`). */
function diviserAuPlusProche(m: bigint, n: bigint): bigint {
  let q = plancherDiv(m, n);
  const r = m - q * n;
  const deuxR = r * 2n;
  if (deuxR > n || (deuxR === n && (q & 1n) === 1n)) q += 1n;
  return q;
}

/** `float.as_integer_ratio()` d'un flottant fini positif. */
function rapportEntier(x: number): [bigint, bigint] {
  const vue = new DataView(new ArrayBuffer(8));
  vue.setFloat64(0, x);
  const bits = vue.getBigUint64(0);
  const expo = Number((bits >> 52n) & 0x7ffn);
  let mantisse = bits & 0xfffffffffffffn;
  let e = expo === 0 ? -1074 : expo - 1075;
  if (expo !== 0) mantisse |= 1n << 52n;
  while (mantisse !== 0n && (mantisse & 1n) === 0n) {
    mantisse >>= 1n;
    e += 1;
  }
  return e >= 0 ? [mantisse << BigInt(e), 1n] : [mantisse, 1n << BigInt(-e)];
}

/** `timedelta * flottant positif`. */
export function dureeFois(d: Duree, x: number): Duree {
  const [a, b] = rapportEntier(x);
  return dureeValide(diviserAuPlusProche(d * a, b));
}

/** Secondes POSIX d'un instant naïf lu comme heure locale du process (`datetime.timestamp()`), microsecondes comprises. */
export function timestamp(n: Naif): number {
  const { y, m, d, reste } = composantes(n);
  const secondes = reste / US_PAR_SECONDE;
  const heure = Number(secondes / 3600n);
  const minute = Number((secondes / 60n) % 60n);
  const seconde = Number(secondes % 60n);
  const date = new Date(2000, 0, 1, 12);
  date.setFullYear(y, m - 1, d);
  date.setHours(heure, minute, seconde, 0);
  return Math.floor(date.getTime() / 1000) + Number(reste % US_PAR_SECONDE) / 1e6;
}

/** `int(dt.timestamp() * 1000)` du Gantt. */
export function ms(n: Naif): number {
  return Math.trunc(timestamp(n) * 1000);
}
