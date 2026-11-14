// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/texte-direct-differentiel.test.ts — LiveText contre l'ancienne fenêtre fixe de 48 caractères : suites aléatoires à graine fixe, fins d'itération simulées. */
import "../moteur-environnement";

import { describe, expect, it } from "vitest";

import { longueurPy, lstripPy, prefixePy, stripPy } from "@elpis/commun";

import * as Analyse from "../../src/boucle/analyse-appels";
import { extractThinking } from "../../src/boucle/chat-commun";
import { emit } from "../../src/boucle/evenements";
import { MARKUP_ONLY_REPLY } from "../../src/boucle/sortie";
import { LIVE_HOLDBACK_CHARS, LIVE_MARKUP_SUSPECT_RE, LiveText } from "../../src/boucle/texte-direct";

/** LiveText d'avant la retenue au balisage : les 48 derniers points de code attendent toujours. */
class Ancien extends LiveText {
  override async onToken(tok: string): Promise<void> {
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
      const cut = longueurPy(this.pend) - LIVE_HOLDBACK_CHARS;
      if (cut <= 0) return;
      chunk = prefixePy(this.pend, cut);
      this.pend = this.pend.slice(chunk.length);
    }
    if (chunk) {
      this.n += longueurPy(chunk);
      await emit(this.onEvent, { type: "content_token", text: chunk });
    }
  }
}

type Ev = Record<string, unknown>;
type Live = LiveText;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROSE = [
  "Bonjour",
  "le",
  "monde",
  "é",
  "😀",
  "日本語",
  "a",
  "x",
  "Voici",
  "résultat",
  ".",
  ",",
  ":",
  "!",
  "?",
  "(",
  ")",
  "-",
  "*",
  "#",
  "'",
  '"',
  "=",
  "/",
  "|",
  "]",
  "[",
  "`",
  "İ",
  "ſ",
  "K",
  "name",
  "tool_call",
  "function",
  "Je cherche.",
  "D'accord, je lance la recherche maintenant",
  "1 < 2",
  "x > y",
  "a=b",
];
const BLANCS = [" ", " ", " ", "  ", "\n", "\n\n", "\t", " ", "　", " ", "\x1c", "​", "﻿"];
const BALISES = [
  "<tool_call>",
  "</tool_call>",
  '<tool_call>{"name": "foo", "arguments": {"q": 1}}</tool_call>',
  '<tool_call>{"name": "search", "arguments": {"q": "x"}}</tool_call>',
  "<function=foo>",
  "<function=search><parameter=q>x</parameter></function>",
  "</function>",
  "<parameter=x>",
  "<tool>",
  "<tools>",
  "<toolbox>",
  "<tool_x>",
  "<arg_key>k</arg_key><arg_value>v</arg_value>",
  "<|python_tag|>",
  "<|im_end|>",
  "< /TOOL_CALL>",
  "<\n tool_call>",
  "<TOOL_CALL>",
  "<functİon=foo>",
  "<toolſ>",
  '{"name": "foo", "arguments": {}}',
  '{ "name" : "foo"}',
  '{\n"NAME":',
  '{"name":',
  '{"arguments": {"q": "x"}, "name": "foo"}',
  '{"arguments": {"q": "x"}, "name": "search"}',
  '{"type": "function", "name": "search", "parameters": {"q": "météo à Paris demain matin"}}',
  '{"type": "function", "name": "search", "parameters": "q"}',
  '[{"name": "foo", "arguments": {}}]',
  "[TOOL_CALLS]",
  "<think>",
  "</think>",
  "<|thinking|>",
  "<b>",
  "a < b",
  "{x}",
  "<",
  "{",
  '"name"',
  "```json\n",
  "```",
  "<｜tool▁calls▁begin｜>",
];

function choisir<T>(r: () => number, t: readonly T[]): T {
  return t[Math.floor(r() * t.length)]!;
}

/** Contenu aléatoire : prose, blancs, balisages complets ou tronqués. */
function contenu(r: () => number): string {
  const n = 1 + Math.floor(r() * 30);
  let s = "";
  const pMarq = r() * 0.4;
  for (let i = 0; i < n; i++) {
    const x = r();
    if (x < pMarq) s += choisir(r, BALISES);
    else if (x < pMarq + 0.08) {
      const b = Array.from(choisir(r, BALISES));
      s += b.slice(0, 1 + Math.floor(r() * b.length)).join("");
    } else if (x < pMarq + 0.3) s += choisir(r, BLANCS);
    else s += choisir(r, PROSE) + (r() < 0.6 ? " " : "");
    if (r() < 0.05) s += "x".repeat(Math.floor(r() * 60));
  }
  return s;
}

const APPELS = [
  '{"name": "NOM", "arguments": {"q": "x"}}',
  '{"arguments": {"q": "un texte assez long pour sortir de la fenêtre"}, "name": "NOM"}',
  '{"type": "function", "name": "NOM", "parameters": {"q": "x"}}',
  '{"tool_call": {"name": "NOM", "arguments": {}}}',
  '[{"name": "NOM", "arguments": {}}]',
  "<tool_call>NOM <arg_key>a</arg_key><arg_value>1</arg_value></tool_call>",
  "<function=NOM><parameter=q>x</parameter></function>",
  '"<function=NOM>bar</function>"',
  '"<tool_call>NOM <arg_key>a</arg_key><arg_value>1</arg_value></tool_call>"',
];
const AVANTS = [
  "",
  "",
  " ",
  "\n\n",
  " ",
  "```json\n",
  "```\n",
  "<tool_call>",
  "Je cherche. ",
  "OK ",
  "﻿",
  "​",
  "`",
];
const APRES = ["", "", "\n", "\n```", "</tool_call>", " ", "`"];

/** Contenu qui ressemble à un appel d'outil pur (ou presque). */
function appelPur(r: () => number): string {
  const nom = r() < 0.5 ? "search" : "foo";
  return choisir(r, AVANTS) + choisir(r, APPELS).replace("NOM", nom) + choisir(r, APRES);
}

/** Découpe en jetons : points de code (défaut) ou unités UTF-16 (demi-paires possibles). */
function decouper(r: () => number, s: string, utf16: boolean): string[] {
  const unites = utf16 ? s.split("") : Array.from(s);
  const jetons: string[] = [];
  let i = 0;
  const maxi = r() < 0.2 ? 1 : 1 + Math.floor(r() * 10);
  while (i < unites.length) {
    const k = 1 + Math.floor(r() * maxi);
    jetons.push(unites.slice(i, i + k).join(""));
    i += k;
  }
  return jetons;
}

function visible(evs: Ev[]): string {
  let t = "";
  for (const e of evs)
    if (e["type"] === "content_token") t += String(e["text"]);
    else if (e["type"] === "content_replace") t = String(e["text"]);
  return t;
}

async function jouer(
  Cls: typeof LiveText,
  jetons: string[],
): Promise<{ live: Live; evs: Ev[]; etapes: string[] }> {
  const evs: Ev[] = [];
  const live = new Cls((e) => {
    evs.push(e);
  });
  const etapes: string[] = [];
  for (const j of jetons) {
    await live.onToken(j);
    etapes.push(visible(evs));
  }
  return { live, evs, etapes };
}

const CONNUS = new Set(["search"]);
type Issue = "finishOk" | "purge" | "texte" | "relance";

/** Fin d'itération sans appel natif : callLlm (réflexion dans le texte), classifyTextReply, relance, finishOk. */
async function finTexte(live: Live): Promise<Issue> {
  let rawContent = stripPy(live.parts.join(""));
  const [th, cl] = extractThinking(rawContent, { truncated: false });
  if (th) {
    await live.remplacer(cl);
    rawContent = cl;
  }
  const iterClean = rawContent;
  let legacy = iterClean ? Analyse.extractToolCalls(iterClean) : null;
  if (legacy) {
    const retenus = legacy.filter(([n]) => typeof n === "string" && CONNUS.has(n));
    if (!retenus.length) {
      if (Analyse.looksLikePureToolCallText(iterClean)) {
        live.purger();
        return "purge";
      }
      legacy = null;
    } else return "texte";
  }
  if (!legacy && iterClean && Analyse.LAST_PARSE_DIAGNOSTIC) {
    await live.flush();
    return "relance";
  }
  const streame = live.parts.join("");
  let finalClean = iterClean ? extractThinking(iterClean)[1] : iterClean;
  if (streame) finalClean = extractThinking(streame)[1] || finalClean || iterClean || "";
  const avant = finalClean;
  finalClean = Analyse.stripToolCallMarkup(finalClean);
  if (!stripPy(finalClean || "") && stripPy(avant || "")) finalClean = MARKUP_ONLY_REPLY;
  if (finalClean) await live.emitRest(finalClean, { replaceOnDivergence: true });
  return "finishOk";
}

const PRUDENT = /^[`[{<]/u;
const DEMI_PAIRE = /[\ud800-\udbff]$|^[\udc00-\udfff]/u;
const N = 3000;
const GRAINE = 20261114;

describe("LiveText contre la fenêtre fixe de 48 caractères", () => {
  it(`${N} suites (graine ${GRAINE}) : même portail, plus tôt seulement un texte sans début de balisage`, async () => {
    const r = mulberry32(GRAINE);
    const ecarts: Record<string, unknown[]> = {};
    const noter = (cle: string, ex: unknown): void => {
      const liste = (ecarts[cle] ??= []);
      if (liste.length < 3) liste.push(ex);
    };
    for (let k = 0; k < N; k++) {
      const pur = r() < 0.3;
      const s = pur ? appelPur(r) : contenu(r);
      const jetons = decouper(r, s, r() < 0.15);
      const a = await jouer(Ancien, jetons);
      const b = await jouer(LiveText, jetons);
      if (a.live.gated !== b.live.gated) noter("portail", jetons);
      if (a.live.gated && visible(a.evs) !== visible(b.evs)) noter("emis au portail", jetons);
      if (JSON.stringify(a.live.parts) !== JSON.stringify(b.live.parts)) noter("parts", jetons);
      if (a.live.n + longueurPy(a.live.pend) !== b.live.n + longueurPy(b.live.pend))
        noter("n + pend", jetons);
      const eventuelA = a.live.gated ? visible(a.evs) : visible(a.evs) + a.live.pend;
      for (let i = 0; i < jetons.length; i++)
        if (!b.etapes[i]!.startsWith(a.etapes[i]!) || !eventuelA.startsWith(b.etapes[i]!)) {
          noter("pas entre l'ancien et son texte retenu", { jetons, i });
          break;
        }
      const debut = lstripPy(s);
      if (debut && PRUDENT.test(debut) && JSON.stringify(a.evs) !== JSON.stringify(b.evs))
        noter("prudent", jetons);
      for (const fin of ["flush", "natif", "texte", "abandon"] as const) {
        const a2 = await jouer(Ancien, jetons);
        const b2 = await jouer(LiveText, jetons);
        let issue: string = fin;
        if (fin === "flush") {
          await a2.live.flush();
          await b2.live.flush();
        } else if (fin === "natif") {
          for (const x of [a2, b2]) {
            const avant = Analyse.stripToolCallMarkup(x.live.parts.join(""));
            if (avant) await x.live.emitRest(avant, { replaceOnDivergence: false });
          }
        } else if (fin === "texte") {
          issue = await finTexte(a2.live);
          expect(await finTexte(b2.live)).toBe(issue);
        }
        if (b2.evs.some((e) => e["type"] === "content_token" && DEMI_PAIRE.test(String(e["text"]))))
          noter(`demi-paire émise (${issue})`, jetons);
        const remplacements = (evs: Ev[]): number =>
          evs.filter((e) => e["type"] === "content_replace").length;
        // Seule la réflexion reclassée d'une réponse courte (remplacer) remplace un texte que l'ancien n'avait pas émis.
        if (issue !== "finishOk" && remplacements(b2.evs) > remplacements(a2.evs))
          noter(`remplacement (${issue})`, s);
        const va = visible(a2.evs);
        const vb = visible(b2.evs);
        if (lstripPy(va) === lstripPy(vb)) continue;
        // Texte retenu jeté (canal texte, abandon) : le nouveau n'en a montré que la part sans `<` ni `{`.
        const jete = issue === "texte" || issue === "abandon";
        if (!jete || !vb.startsWith(va) || /[<{]/u.test(vb.slice(va.length)))
          noter(`texte visible (${issue})`, { contenu: s, ancien: va, nouveau: vb });
      }
    }
    expect(ecarts).toEqual({});
  }, 60_000);
});
