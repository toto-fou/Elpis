// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/texte-direct.ts — émission directe du contenu d'une itération, fenêtre de retenue et portail contre le balisage d'appel. */
import { BLANC_PY, longueurPy, lstripPy, motifPy, prefixePy } from "@elpis/commun";

import { emit } from "./evenements";
import type { SurEvenement } from "./evenements";

export const LIVE_HOLDBACK_CHARS = 48;
const B = BLANC_PY;
export const LIVE_MARKUP_SUSPECT_RE = new RegExp(
  `<${B}*/?${B}*(?:${["tool_call", "function", "parameter"].map(motifPy).join("|")}|${motifPy("tool")}${motifPy("s")}?(?![\\p{L}\\p{N}_])|${motifPy("arg_key")}|${motifPy("arg_value")})` +
    `|<\\||\\{${B}*"${motifPy("name")}"${B}*:`,
  "u",
);
const BLANCS_FIN = new RegExp(`${B}+$`, "u");
/** Premier caractère d'un contenu qui peut n'être qu'un appel d'outil en texte (clôture, JSON, balise). */
const DEBUT_PRUDENT = /^[`[{<]/u;

/** Longueur (UTF-16) de `pend` qui peut partir : sauf la queue où un balisage peut encore commencer (premier `<` ou `{` des `LIVE_HOLDBACK_CHARS` derniers points de code, blancs qui le précèdent), les blancs finaux et une demi-paire haute en attente de la sienne ; fenêtre entière si `prudent`. */
export function partEmettable(pend: string, prudent: boolean): number {
  const fenetre = prefixePy(pend, Math.max(0, longueurPy(pend) - LIVE_HOLDBACK_CHARS)).length;
  let cut = fenetre;
  if (!prudent) {
    const i = pend.slice(fenetre).search(/[<{]/u);
    const fin = i < 0 ? pend.length : fenetre + i;
    cut = fin - (BLANCS_FIN.exec(pend.slice(fenetre, fin))?.[0].length ?? 0);
  }
  return cut > 0 && (pend.charCodeAt(cut - 1) & 0xfc00) === 0xd800 ? cut - 1 : cut;
}

/** `s[n:]` en points de code. */
function apres(s: string, n: number): string {
  return s.slice(prefixePy(s, n).length);
}

/** Queue du texte nettoyé à émettre quand `nEmitted` points de code du brut sont partis ; `null` si le nettoyage a touché la partie émise. */
export function liveStreamRest(cleanText: string, rawText: string, nEmitted: number): string | null {
  if (nEmitted <= 0) return cleanText;
  const leadWs = longueurPy(rawText) - longueurPy(lstripPy(rawText));
  const eff = nEmitted - leadWs;
  if (eff <= 0) return cleanText;
  if (prefixePy(cleanText, eff) === prefixePy(apres(rawText, leadWs), nEmitted - leadWs))
    return apres(cleanText, eff);
  return null;
}

/** Contenu d'UNE itération : `parts` (jamais réaffecté), `n` points de code émis, fenêtre `pend`, portail `gated`, `prudent` fixé au premier caractère visible ou à la première accolade (appel JSON en texte que le portail ne voit pas). */
export class LiveText {
  readonly onEvent: SurEvenement;
  readonly parts: string[] = [];
  n = 0;
  pend = "";
  gated = false;
  prudent: boolean | null = null;

  constructor(onEvent: SurEvenement) {
    this.onEvent = onEvent;
  }

  async onToken(tok: string): Promise<void> {
    this.parts.push(tok);
    if (this.gated) return;
    this.pend += tok;
    const m = LIVE_MARKUP_SUSPECT_RE.exec(this.pend);
    let chunk: string;
    if (m !== null) {
      this.gated = true;
      chunk = this.pend.slice(0, m.index);
      this.pend = "";
    } else {
      if (this.prudent === null) {
        const debut = lstripPy(this.pend);
        if (debut) this.prudent = DEBUT_PRUDENT.test(debut);
      }
      if (this.prudent === false && this.pend.includes("{")) this.prudent = true;
      const cut = partEmettable(this.pend, this.prudent ?? false);
      if (cut <= 0) return;
      chunk = this.pend.slice(0, cut);
      this.pend = this.pend.slice(cut);
    }
    if (chunk) {
      this.n += longueurPy(chunk);
      await emit(this.onEvent, { type: "content_token", text: chunk });
    }
  }

  /** Émet la fenêtre de retenue avant une relance ou la génération des arguments d'un appel. */
  async flush(): Promise<void> {
    if (this.gated || !this.pend) return;
    const chunk = this.pend;
    this.pend = "";
    this.n += longueurPy(chunk);
    await emit(this.onEvent, { type: "content_token", text: chunk });
  }

  /** Reprise de rédaction : la prose déjà tenue par le client passe en tête et compte comme émise (sans effet si `parts` est vide). */
  prefixerDejaEmis(texte: string): void {
    if (this.parts.length) {
      this.parts.unshift(texte);
      this.n += longueurPy(texte);
    }
  }

  purger(): void {
    this.parts.length = 0;
  }

  /** Réflexion reclassée en fin d'itération (balise fermante orpheline dans le contenu) : la bulle repart du texte nettoyé. */
  async remplacer(texte: string): Promise<void> {
    const emis = this.n > 0;
    this.parts.length = 0;
    this.n = 0;
    this.pend = "";
    this.gated = false;
    this.prudent = null;
    if (emis) await emit(this.onEvent, { type: "content_replace", text: "" });
    if (texte) await this.onToken(texte);
  }

  /** TERMINAL : émet la queue nettoyée non reçue, ou `content_replace` si le nettoyage a touché la partie émise et que c'est voulu. */
  async emitRest(text: string, o: { replaceOnDivergence: boolean }): Promise<void> {
    const rest = liveStreamRest(text, this.parts.join(""), this.n);
    if (rest === null) {
      if (o.replaceOnDivergence) await emit(this.onEvent, { type: "content_replace", text });
    } else if (rest) {
      await emit(this.onEvent, { type: "content_token", text: rest });
    }
  }
}
