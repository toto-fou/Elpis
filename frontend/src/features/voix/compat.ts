// SPDX-License-Identifier: MIT
/** frontend/src/features/voix/compat.ts — compatibilité navigateur de la voix : identification, détection des capacités, contournements connus. */

export interface Navigateur {
  nom: string;
  version: number;
  moteur: string;
}

export interface Capacite {
  ok: boolean;
  raison: string;
}

export interface DiagnosticVoix {
  navigateur: Navigateur;
  dictee: Capacite;
  lecture: Capacite;
  tauxNatifDirect: boolean;
  avertissement: string | null;
}

/** Environnement du diagnostic, fourni en test ; les capacités sont lues telles quelles. */
export interface EnvironnementVoix {
  ua?: string;
  isSecureContext?: boolean;
  mediaDevices?: { getUserMedia?: unknown } | null;
  AudioContext?: unknown;
  AudioWorkletNode?: unknown;
  Audio?: unknown;
  fetch?: unknown;
  AbortController?: unknown;
}

/** Plus anciennes versions éprouvées ou encore maintenues, par moteur. */
const MINIMUM: Readonly<Record<string, number>> = { firefox: 115, chromium: 100, safari: 16 };

/** Moteurs sur lesquels la voix a été éprouvée ; les autres passent s'ils ont les capacités, avec un avertissement. */
const TESTES: Readonly<Record<string, boolean>> = { firefox: true, chromium: true };

/** Nom et version majeure depuis le User-Agent ; l'ordre compte (Edge et Opera annoncent aussi Chrome). */
export function identifie(ua: unknown): Navigateur {
  const s = String(ua || "");
  let m: RegExpMatchArray | null;
  if ((m = s.match(/Firefox\/(\d+)/)) && !/Seamonkey/i.test(s)) {
    return { nom: "Firefox", version: +(m[1] ?? 0), moteur: "firefox" };
  }
  if ((m = s.match(/Edg(?:e|A|iOS)?\/(\d+)/)))
    return { nom: "Edge", version: +(m[1] ?? 0), moteur: "chromium" };
  if ((m = s.match(/OPR\/(\d+)/))) return { nom: "Opera", version: +(m[1] ?? 0), moteur: "chromium" };
  if ((m = s.match(/(?:Chrome|Chromium|CriOS)\/(\d+)/))) {
    return { nom: "Chrome", version: +(m[1] ?? 0), moteur: "chromium" };
  }
  if (/Safari\//.test(s) && (m = s.match(/Version\/(\d+)/))) {
    return { nom: "Safari", version: +(m[1] ?? 0), moteur: "safari" };
  }
  return { nom: "Inconnu", version: 0, moteur: "inconnu" };
}

function nomVersion(nav: Navigateur): string {
  return nav.version ? `${nav.nom} ${nav.version}` : nav.nom;
}

/** Le calcul sur un environnement explicite, testable sans navigateur. */
export function diagnostic(env: EnvironnementVoix): DiagnosticVoix {
  const nav = identifie(env.ua);
  const minimum = MINIMUM[nav.moteur];
  const tropAncien = !!(minimum && nav.version && nav.version < minimum);

  let dictee: Capacite = { ok: true, raison: "" };
  const AC = env.AudioContext;
  const protoAC = (AC as { prototype?: object } | undefined)?.prototype;
  if (tropAncien) {
    dictee = {
      ok: false,
      raison: `${nomVersion(nav)} est trop ancien pour la dictée (${nav.nom} ${minimum} minimum).`,
    };
  } else if (env.isSecureContext === false) {
    dictee = {
      ok: false,
      raison:
        "Le navigateur n'autorise le micro qu'en HTTPS (ou sur localhost). " +
        "Un administrateur peut activer HTTPS dans l'administration.",
    };
  } else if (!env.mediaDevices || typeof env.mediaDevices.getUserMedia !== "function") {
    dictee = { ok: false, raison: "Ce navigateur ne donne pas accès au micro." };
  } else if (typeof AC !== "function") {
    dictee = { ok: false, raison: "Ce navigateur ne sait pas traiter l'audio (AudioContext absent)." };
  } else if (typeof env.AudioWorkletNode !== "function" || !(protoAC && "audioWorklet" in protoAC)) {
    dictee = {
      ok: false,
      raison:
        `${nomVersion(nav)} ne prend pas en charge la capture audio ` +
        "moderne (AudioWorklet). Mettez le navigateur à jour.",
    };
  }

  let lecture: Capacite = { ok: true, raison: "" };
  if (tropAncien) {
    lecture = { ok: false, raison: `${nomVersion(nav)} est trop ancien pour la lecture à voix haute.` };
  } else if (
    typeof env.Audio !== "function" ||
    typeof env.fetch !== "function" ||
    typeof env.AbortController !== "function"
  ) {
    lecture = { ok: false, raison: "Ce navigateur ne peut pas lire les réponses à voix haute." };
  }

  const tauxNatifDirect = nav.moteur === "firefox" || nav.moteur === "safari";

  let avertissement: string | null = null;
  if ((dictee.ok || lecture.ok) && !TESTES[nav.moteur]) {
    avertissement =
      `${nomVersion(nav)} n'a pas été testé avec le moteur vocal : ` +
      "en cas de souci, utilisez Firefox ou Chrome.";
  }

  return { navigateur: nav, dictee, lecture, tauxNatifDirect, avertissement };
}

interface FenetreVoix {
  isSecureContext?: boolean;
  AudioContext?: unknown;
  webkitAudioContext?: unknown;
  AudioWorkletNode?: unknown;
  Audio?: unknown;
  fetch?: unknown;
  AbortController?: unknown;
}

let cache: DiagnosticVoix | null = null;

/** Diagnostic du navigateur courant, mis en cache. */
export function voiceCompat(): DiagnosticVoix {
  if (cache) return cache;
  const w: FenetreVoix = typeof window !== "undefined" ? (window as unknown as FenetreVoix) : {};
  const n = typeof navigator !== "undefined" ? navigator : undefined;
  cache = diagnostic({
    ua: n?.userAgent,
    isSecureContext: w.isSecureContext,
    mediaDevices: n?.mediaDevices,
    AudioContext: w.AudioContext || w.webkitAudioContext,
    AudioWorkletNode: w.AudioWorkletNode,
    Audio: w.Audio,
    fetch: w.fetch,
    AbortController: w.AbortController,
  });
  return cache;
}
