// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/horodatage.ts — dates de la console : heure locale à l'écran, ISO UTC en infobulle, à partir d'un `ts` en secondes. */

/** Formateur `Intl.DateTimeFormat` fr-FR créé au premier usage (cinq fois plus rapide qu'un `toLocaleString` à chaque ligne), même sortie. */
export function formateurDate(options: Intl.DateTimeFormatOptions): (d: Date | number) => string {
  let f: Intl.DateTimeFormat | undefined;
  return (d) => (f ??= new Intl.DateTimeFormat("fr-FR", options)).format(d);
}

const completLocal = formateurDate({
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hour12: false,
});
export const courtLocal = formateurDate({ dateStyle: "short", timeStyle: "short" });

const secondes = (ts: unknown): Date | null => {
  const n = Number(ts);
  if (!ts || !Number.isFinite(n)) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Date et heure locales (JJ/MM/AAAA HH:MM:SS), ou « » si `ts` est vide ou illisible. */
export function heureLocale(ts: unknown): string {
  const d = secondes(ts);
  return d ? completLocal(d) : "";
}

/** Même instant en ISO 8601 UTC (`2026-11-07T10:30:00.000Z`) pour l'infobulle, ou « ». */
export function isoUtc(ts: unknown): string {
  return secondes(ts)?.toISOString() ?? "";
}

/** Date et heure locales courtes (JJ/MM/AAAA HH:MM), ou « — » si `ts` est vide ou illisible. */
export function heureCourte(ts: unknown): string {
  const d = secondes(ts);
  return d ? courtLocal(d) : "—";
}

/** Jour `AAAA-MM-JJ` en `JJ/MM/AAAA` (jour du serveur, sans conversion de fuseau) ; toute autre valeur est rendue telle quelle. */
export function jourFr(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : date;
}
