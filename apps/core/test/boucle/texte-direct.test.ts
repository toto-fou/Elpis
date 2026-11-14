// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/texte-direct.test.ts — émission directe : suites de jetons Python rejouées (événements et état), queue nettoyée, portail. */
import "../moteur-environnement";

import { describe, expect, it } from "vitest";

import { estErreurAnnulation, longueurPy, lstripPy, prefixePy } from "@elpis/commun";

import { emit } from "../../src/boucle/evenements";
import {
  LIVE_HOLDBACK_CHARS,
  LIVE_MARKUP_SUSPECT_RE,
  LiveText,
  liveStreamRest,
  partEmettable,
} from "../../src/boucle/texte-direct";
import { lireVecteurs } from "../vecteurs-moteur";

type Op = ["jeton", string] | ["flush"] | ["prefixer", string] | ["purger"] | ["reste", string, boolean];
interface Suite {
  ops: Op[];
  evenements: Record<string, unknown>[];
  etat: { parts: string[]; n: number; pend: string; gated: boolean };
}

const V = lireVecteurs<{
  suites: Suite[];
  restes: [string, string, number, string | null][];
  suspects: [string, number | null][];
}>("boucle-texte");

/** Index Python (points de code) du début d'une correspondance. */
function debutPy(t: string): number | null {
  const m = LIVE_MARKUP_SUSPECT_RE.exec(t);
  return m === null ? null : Array.from(t.slice(0, m.index)).length;
}

/** Texte affiché par le client une fois les événements appliqués. */
function visible(evenements: Record<string, unknown>[]): string {
  let t = "";
  for (const e of evenements)
    if (e["type"] === "content_token") t += String(e["text"]);
    else if (e["type"] === "content_replace") t = String(e["text"]);
  return t;
}

const horsJetons = (evenements: Record<string, unknown>[]): Record<string, unknown>[] =>
  evenements.filter((e) => e["type"] !== "content_token");

/** Émet les jetons un à un et rend les textes partis après chacun. */
async function emis(jetons: string[]): Promise<[LiveText, string[]]> {
  const textes: string[] = [];
  const live = new LiveText((e) => {
    textes.push(String(e["text"]));
  });
  for (const j of jetons) await live.onToken(j);
  return [live, textes];
}

describe("émission directe du contenu", () => {
  it.each(V.suites.map((s, i) => [i, s] as const))("suite %i", async (_i, s) => {
    const evenements: Record<string, unknown>[] = [];
    const live = new LiveText((e) => {
      evenements.push({ ...e });
    });
    for (const op of s.ops) {
      if (op[0] === "jeton") await live.onToken(op[1]);
      else if (op[0] === "flush") await live.flush();
      else if (op[0] === "prefixer") live.prefixerDejaEmis(op[1]);
      else if (op[0] === "purger") live.purger();
      else await live.emitRest(op[1], { replaceOnDivergence: op[2] });
    }
    const etat = { parts: live.parts, n: live.n, pend: live.pend, gated: live.gated };
    // Contenu qui peut n'être qu'un appel en texte dès son début, ou sans caractère visible : fenêtre fixe, à l'identique.
    const texte = lstripPy(s.ops.flatMap((op) => (op[0] === "jeton" ? [op[1]] : [])).join(""));
    if (live.prudent === null || /^[`[{<]/u.test(texte)) {
      expect(evenements).toStrictEqual(s.evenements);
      expect(etat).toStrictEqual(s.etat);
      return;
    }
    // Retenue au seul balisage possible : même portail, rien de perdu ni de doublé, ce qui attend est une queue de l'ancienne fenêtre.
    expect([etat.parts, etat.gated, etat.n + longueurPy(etat.pend)]).toStrictEqual([
      s.etat.parts,
      s.etat.gated,
      s.etat.n + longueurPy(s.etat.pend),
    ]);
    expect(s.etat.pend.endsWith(etat.pend)).toBe(true);
    // Purge d'un texte déjà parti : la boucle ne purge qu'un texte d'appel pur, donc prudent.
    if (s.ops.some((op) => op[0] === "purger")) return;
    expect(horsJetons(evenements)).toStrictEqual(horsJetons(s.evenements));
    expect(lstripPy(visible(evenements))).toBe(lstripPy(visible(s.evenements)));
  });

  it("premier mot émis sans attendre la fenêtre, blancs finaux retenus", async () => {
    const [live, textes] = await emis(["Bonjour", " ", "à", " tous."]);
    expect(textes).toStrictEqual(["Bonjour", " à", " tous."]);
    expect([live.n, live.pend, live.prudent]).toStrictEqual([15, "", false]);
    const [, blancs] = await emis(["\n\n", "Oui", ".\n"]);
    expect(blancs).toStrictEqual(["\n\nOui", "."]);
  });

  it("début possible de balisage retenu, puis portail ou libération au-delà de la fenêtre", async () => {
    const [porte, avant] = await emis(["Je lis le fichier ", "<", "tool_call>"]);
    expect([avant, porte.gated, porte.n]).toStrictEqual([["Je lis le fichier", " "], true, 18]);
    const [libre, textes] = await emis([
      "Si a ",
      "<",
      " b alors c.",
      " ".repeat(10),
      "x".repeat(LIVE_HOLDBACK_CHARS),
    ]);
    expect(textes).toStrictEqual([
      "Si a",
      " < b alors c." + " ".repeat(10) + "x".repeat(LIVE_HOLDBACK_CHARS),
    ]);
    expect([libre.gated, libre.pend]).toStrictEqual([false, ""]);
  });

  it("contenu commençant par une clôture, un JSON ou une balise : fenêtre fixe", async () => {
    for (const debut of ["```json\n", "[", "{", "<"]) {
      const [live, textes] = await emis(["  ", debut, "x".repeat(LIVE_HOLDBACK_CHARS)]);
      expect(live.prudent).toBe(true);
      expect(textes).toStrictEqual(["  " + debut]);
      expect(longueurPy(live.pend)).toBe(LIVE_HOLDBACK_CHARS);
    }
  });

  it("appel JSON en texte que le portail ne voit pas (`name` après `arguments`) : fenêtre fixe dès l'accolade", async () => {
    const appel = '{"arguments": {"q": "un texte assez long pour sortir de la fenêtre"}, "name": "search"}';
    const contenu = "Je cherche. " + appel;
    const [live, textes] = await emis(contenu.match(/[\s\S]{1,4}/gu) ?? []);
    expect([live.gated, live.prudent]).toStrictEqual([false, true]);
    expect(textes.join("")).toBe(prefixePy(contenu, longueurPy(contenu) - LIVE_HOLDBACK_CHARS));
  });

  it("demi-paire haute retenue jusqu'à la sienne : emoji entier, queue recollée sans perte", async () => {
    const evenements: Record<string, unknown>[] = [];
    const live = new LiveText((e) => {
      evenements.push({ ...e });
    });
    for (const j of ["Voici \uD83D", "\uDE00 la suite", " {x}"]) await live.onToken(j);
    await live.emitRest("Voici 😀 la suite {x}", { replaceOnDivergence: true });
    expect(evenements.map((e) => e["text"])).toStrictEqual(["Voici ", "😀 la suite", " {x}"]);
    expect(visible(evenements)).toBe("Voici 😀 la suite {x}");
  });

  it("part émettable : premier `<` ou `{` de la fenêtre, blancs qui le précèdent, blancs finaux", () => {
    expect(partEmettable("abc", false)).toBe(3);
    expect(partEmettable("abc  \n", false)).toBe(3);
    expect(partEmettable("abc { x", false)).toBe(3);
    expect(partEmettable("😀 a < b { c", false)).toBe(4);
    const long = "{" + "y".repeat(LIVE_HOLDBACK_CHARS);
    expect(partEmettable(long, false)).toBe(long.length);
    expect(partEmettable(long, true)).toBe(1);
    expect(partEmettable("ab \uD83D", false)).toBe(3);
  });

  it("queue restante (offsets en points de code, blanc de tête)", () => {
    for (const [c, r, n, attendu] of V.restes) expect(liveStreamRest(c, r, n)).toBe(attendu);
  });

  it("portail : début de la trace de balisage", () => {
    for (const [t, attendu] of V.suspects) expect(debutPy(t)).toBe(attendu);
  });

  it("émission : panne du consommateur tue, annulation propagée", async () => {
    await emit(
      () => {
        throw new Error("consommateur en panne");
      },
      { type: "info" },
    );
    await expect(
      emit(
        () => {
          throw new DOMException("arrêt", "AbortError");
        },
        { type: "info" },
      ),
    ).rejects.toSatisfy(estErreurAnnulation);
    await emit(null, { type: "info" });
  });
});
