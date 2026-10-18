// SPDX-License-Identifier: MIT
/** packages/commun/src/nombres.ts — arrondis et écritures de nombres de Python (`round`, `f"{x:.nf}"`), exacts sur la valeur binaire ; `int(x)` exact et `float(x)` strict. */
import { FlottantPy } from "./json";
import { ErreurPython, floatPy, intPy } from "./python";

/** Valeur exacte d'un double fini et positif : `mantisse × 2^exposant`. */
function decomposer(x: number): { mantisse: bigint; exposant: number } {
  const vue = new DataView(new ArrayBuffer(8));
  vue.setFloat64(0, x);
  const haut = vue.getUint32(0);
  const bas = vue.getUint32(4);
  const brut = (haut >>> 20) & 0x7ff;
  const fraction = (BigInt(haut & 0xfffff) << 32n) | BigInt(bas);
  if (brut === 0) return { mantisse: fraction, exposant: -1074 };
  return { mantisse: fraction | (1n << 52n), exposant: brut - 1075 };
}

/** `round(x × 10^n)` à l'entier, moitié au pair (règle de Python), calculé exactement. */
function entierArrondi(x: number, n: number): bigint {
  const { mantisse, exposant } = decomposer(x);
  let numerateur = mantisse * (n >= 0 ? 10n ** BigInt(n) : 1n);
  let denominateur = n >= 0 ? 1n : 10n ** BigInt(-n);
  if (exposant >= 0) numerateur <<= BigInt(exposant);
  else denominateur <<= BigInt(-exposant);
  const quotient = numerateur / denominateur;
  const reste2 = (numerateur % denominateur) * 2n;
  if (reste2 > denominateur || (reste2 === denominateur && quotient % 2n === 1n)) return quotient + 1n;
  return quotient;
}

/** `f"{x:.{n}f}"` de Python (n ≥ 0) : le signe d'un négatif arrondi à zéro est gardé (`-0.00`). */
export function fixePy(x: number, n: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const negatif = x < 0 || Object.is(x, -0);
  const chiffres = entierArrondi(Math.abs(x), n)
    .toString()
    .padStart(n + 1, "0");
  const texte = n > 0 ? `${chiffres.slice(0, -n)}.${chiffres.slice(-n)}` : chiffres;
  return (negatif ? "-" : "") + texte;
}

/** `round(x)` de Python : entier, moitié au pair (jamais `-0`). */
export function arrondiEntierPy(x: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`impossible d'arrondir ${x} en entier`);
  const entier = Number(entierArrondi(Math.abs(x), 0));
  return x < 0 && entier !== 0 ? -entier : entier;
}

/** `round(x, n)` de Python sur un flottant : reste un flottant, signe gardé ; un résultat infini lève comme `OverflowError`. */
export function arrondiPy(x: number, n: number): number {
  if (!Number.isFinite(x)) return x;
  const valeur =
    n > 0
      ? Number(fixePy(Math.abs(x), n))
      : Number(entierArrondi(Math.abs(x), n) * (n === 0 ? 1n : 10n ** BigInt(-n)));
  if (!Number.isFinite(valeur)) throw new RangeError("rounded value too large to represent");
  return x < 0 || Object.is(x, -0) ? -valeur : valeur;
}

/** `int(x)` : un entier hors des entiers sûrs de JS reste exact (bigint), comme en Python. */
export function entierExactPy(v: unknown): number | bigint {
  if (typeof v === "bigint") return v;
  if (v instanceof FlottantPy) return entierExactPy(v.valeur);
  if (typeof v === "number" && Number.isFinite(v)) {
    const t = Math.trunc(v);
    return Number.isSafeInteger(t) ? t + 0 : BigInt(t);
  }
  return intPy(v);
}

/** `float(x)` : un entier trop grand pour un double lève OverflowError, comme Python. */
export function flottantStrictPy(v: unknown): number {
  if (typeof v === "bigint") {
    const x = Number(v);
    if (!Number.isFinite(x)) throw new ErreurPython("OverflowError", "int too large to convert to float");
    return x;
  }
  return floatPy(v);
}
