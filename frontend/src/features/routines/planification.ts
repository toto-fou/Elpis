// SPDX-License-Identifier: MIT
/** frontend/src/features/routines/planification.ts — constructeur de planification visuel : état ⇄ expression cron à 5 champs, résumé lisible. */

export type Frequence = "none" | "minutes" | "hourly" | "daily" | "weekly" | "monthly" | "custom";

export interface Planification {
  freq: Frequence;
  everyMinutes: number;
  atMinute: number;
  time: string;
  weekdays: number[];
  dayOfMonth: number;
  custom: string;
}

/** Lundi = 1 … dimanche = 7, comme le planificateur du serveur. */
export const PUCES_JOURS: ReadonlyArray<{ n: number; l: string }> = [
  { n: 1, l: "Lun" },
  { n: 2, l: "Mar" },
  { n: 3, l: "Mer" },
  { n: 4, l: "Jeu" },
  { n: 5, l: "Ven" },
  { n: 6, l: "Sam" },
  { n: 7, l: "Dim" },
];

const NOMS_JOURS: Readonly<Record<number, string>> = {
  1: "lundi",
  2: "mardi",
  3: "mercredi",
  4: "jeudi",
  5: "vendredi",
  6: "samedi",
  7: "dimanche",
};

export function planificationParDefaut(): Planification {
  return {
    freq: "daily",
    everyMinutes: 30,
    atMinute: 0,
    time: "09:00",
    weekdays: [1],
    dayOfMonth: 1,
    custom: "0 9 * * *",
  };
}

function analyserHeure(t: string | undefined): [number, number] {
  const p = String(t || "09:00").split(":");
  let h = parseInt(p[0] ?? "", 10);
  let m = parseInt(p[1] ?? "", 10);
  if (isNaN(h) || h < 0 || h > 23) h = 9;
  if (isNaN(m) || m < 0 || m > 59) m = 0;
  return [h, m];
}

const deux = (n: number): string => String(n).padStart(2, "0");

/** Borne un entier saisi (chaîne ou nombre) ; valeur illisible : `defaut`. */
export function borner(v: unknown, bas: number, haut: number, defaut: number): number {
  let n = parseInt(String(v), 10);
  if (isNaN(n)) n = defaut;
  return Math.min(haut, Math.max(bas, n));
}

/** Expression cron de l'état ; vide : aucune planification (manuel ou webhook). */
export function cronDepuisPlanification(s: Planification): string {
  const [h, m] = analyserHeure(s.time);
  switch (s.freq) {
    case "none":
      return "";
    case "minutes":
      return `*/${borner(s.everyMinutes, 1, 59, 1)} * * * *`;
    case "hourly":
      return `${borner(s.atMinute, 0, 59, 0)} * * * *`;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekly": {
      const jours = s.weekdays.length
        ? s.weekdays
            .slice()
            .sort((a, b) => a - b)
            .join(",")
        : "1";
      return `${m} ${h} * * ${jours}`;
    }
    case "monthly":
      return `${m} ${h} ${borner(s.dayOfMonth, 1, 31, 1)} * *`;
    case "custom":
      return (s.custom || "").trim();
    default:
      return "0 9 * * *";
  }
}

/** État depuis une expression cron ; toute forme non représentable retombe en « custom ». */
export function planificationDepuisCron(expr: string | null | undefined): Planification {
  const s = planificationParDefaut();
  const texte = String(expr || "").trim();
  if (!texte) {
    s.freq = "none";
    return s;
  }
  const parts = texte.split(/\s+/);
  const brut = expr || "";
  if (parts.length !== 5) {
    s.freq = "custom";
    s.custom = brut;
    return s;
  }
  const [mi = "", h = "", dom = "", mo = "", dow = ""] = parts;
  const entier = (v: string): boolean => /^\d+$/.test(v);
  const hm = (): string => `${deux(parseInt(h, 10))}:${deux(parseInt(mi, 10))}`;
  const pas = /^\*\/(\d+)$/.exec(mi);
  if (pas && h === "*" && dom === "*" && mo === "*" && dow === "*") {
    s.freq = "minutes";
    s.everyMinutes = parseInt(pas[1] ?? "", 10);
    return s;
  }
  if (entier(mi) && h === "*" && dom === "*" && mo === "*" && dow === "*") {
    s.freq = "hourly";
    s.atMinute = parseInt(mi, 10);
    return s;
  }
  if (entier(mi) && entier(h) && dom === "*" && mo === "*" && dow === "*") {
    s.freq = "daily";
    s.time = hm();
    return s;
  }
  if (entier(mi) && entier(h) && dom === "*" && mo === "*" && /^[1-7](,[1-7])*$/.test(dow)) {
    const jours = [...new Set(dow.split(",").map((x) => parseInt(x, 10)))];
    if (jours.length) {
      s.freq = "weekly";
      s.weekdays = jours;
      s.time = hm();
      return s;
    }
  }
  if (entier(mi) && entier(h) && entier(dom) && mo === "*" && dow === "*") {
    s.freq = "monthly";
    s.dayOfMonth = parseInt(dom, 10);
    s.time = hm();
    return s;
  }
  s.freq = "custom";
  s.custom = brut;
  return s;
}

/** Résumé lisible, aligné sur ce que le cron enregistré fera réellement (bornes comprises). */
export function resumerPlanification(s: Planification): string {
  const t = s.time || "09:00";
  switch (s.freq) {
    case "none":
      return "Aucune planification (manuel / webhook)";
    case "minutes":
      return `Toutes les ${borner(s.everyMinutes, 1, 59, 1)} minute(s)`;
    case "hourly":
      return `Toutes les heures (à :${deux(borner(s.atMinute, 0, 59, 0))})`;
    case "daily":
      return `Tous les jours à ${t}`;
    case "weekly": {
      const jours = s.weekdays
        .slice()
        .sort((a, b) => a - b)
        .map((n) => NOMS_JOURS[n])
        .join(", ");
      return jours ? `Chaque ${jours} à ${t}` : `Chaque semaine à ${t}`;
    }
    case "monthly":
      return `Le ${s.dayOfMonth || 1} du mois à ${t}`;
    case "custom":
      return "Planification personnalisée (cron)";
    default:
      return "";
  }
}

export function cronEnTexte(expr: string | null | undefined): string {
  return resumerPlanification(planificationDepuisCron(expr));
}
