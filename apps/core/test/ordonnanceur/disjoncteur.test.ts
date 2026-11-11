// SPDX-License-Identifier: MIT
/** apps/core/test/ordonnanceur/disjoncteur.test.ts — disjoncteur : vecteurs Python (réglages, séquences) et garde-fous. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { Disjoncteur, LLMCircuitOpen, reglagesDisjoncteur } from "../../src/llm/ordonnanceur/disjoncteur";
import type { ReglagesDisjoncteur } from "../../src/llm/ordonnanceur/disjoncteur";
import { entierPython, flottantPython, stripPython } from "../../src/llm/ordonnanceur/python";

type Nombre = number | "inf" | "-inf" | "nan";
type Famille = { kind: string; cause: { kind: string } | null };
type Etape = {
  op: "allow" | "echec" | "succes" | "generation" | "transport" | "attendre" | "reset";
  args: (string | number | null)[];
  resultat?: string | number;
  message?: string;
  erreur?: Famille | null;
  etat: Record<string, { fails: number; open_until: Nombre; gen: number }>;
};
type Vecteurs = {
  reglages: {
    env: Record<string, string | null>;
    attendu: { enabled: boolean; fails: number; cooldown_s: Nombre };
  }[];
  scenarios: {
    nom: string;
    horloge_initiale: number;
    reglages: { enabled: boolean; fails: number; cooldown_s: Nombre };
    etapes: Etape[];
  }[];
};

const vecteurs = JSON.parse(
  readFileSync(new URL("../vecteurs/ordonnanceur_disjoncteur.json", import.meta.url), "utf-8"),
) as Vecteurs;

const nombre = (n: Nombre): number =>
  n === "inf" ? Infinity : n === "-inf" ? -Infinity : n === "nan" ? Number.NaN : n;
const texte = (n: number): Nombre =>
  Number.isNaN(n) ? "nan" : n === Infinity ? "inf" : n === -Infinity ? "-inf" : n;

/** Erreur fabriquée d'après la famille relevée côté Python (avec sa cause, comme `LLMFailure`). */
function erreurDe(famille: Famille | null | undefined): unknown {
  if (!famille) return null;
  return famille.cause ? { kind: famille.kind, cause: { kind: famille.cause.kind } } : { kind: famille.kind };
}

describe("réglages LLM_BREAKER* (vecteurs Python)", () => {
  it("couvre les cas générés", () => expect(vecteurs.reglages.length).toBeGreaterThan(90));

  for (const [i, cas] of vecteurs.reglages.entries()) {
    it(`${i} ${JSON.stringify(cas.env)}`, () => {
      const env = Object.fromEntries(Object.entries(cas.env).map(([k, v]) => [k, v ?? undefined]));
      const r = reglagesDisjoncteur(env);
      expect({ enabled: r.enabled, fails: r.failsToOpen, cooldown_s: texte(r.cooldownS) }).toEqual(
        cas.attendu,
      );
    });
  }
});

describe("séquences du disjoncteur (vecteurs Python, horloge simulée)", () => {
  for (const scenario of vecteurs.scenarios) {
    it(scenario.nom, () => {
      let t = scenario.horloge_initiale;
      const reglages: ReglagesDisjoncteur = {
        enabled: scenario.reglages.enabled,
        failsToOpen: scenario.reglages.fails,
        cooldownS: nombre(scenario.reglages.cooldown_s),
      };
      const d = new Disjoncteur(
        reglages,
        () => t,
        (e) => (e as { kind: string }).kind,
      );
      for (const [n, etape] of scenario.etapes.entries()) {
        const [a0, a1] = etape.args;
        const model = a0 as string | null;
        if (etape.op === "allow") {
          let resultat = "ok";
          try {
            d.allow(model);
          } catch (e) {
            expect(e).toBeInstanceOf(LLMCircuitOpen);
            expect((e as Error).message).toBe(etape.message);
            resultat = "ouvert";
          }
          expect(resultat, `étape ${n}`).toBe(etape.resultat);
        } else if (etape.op === "echec") d.recordFailure(model);
        else if (etape.op === "succes") d.recordSuccess(model, a1 as number | null);
        else if (etape.op === "generation") expect(d.generation(model), `étape ${n}`).toBe(etape.resultat);
        else if (etape.op === "transport") d.noteTransportFailure(model, erreurDe(etape.erreur));
        else if (etape.op === "attendre") t += a0 as number;
        else d.reset(model);
        const etat = Object.fromEntries(
          [...d.etats].map(([k, v]) => [k, { fails: v.fails, open_until: texte(v.openUntil), gen: v.gen }]),
        );
        expect(etat, `état après l'étape ${n} (${etape.op})`).toEqual(etape.etat);
      }
    });
  }
});

describe("disjoncteur hors vecteurs", () => {
  const reglages = { enabled: true, failsToOpen: 2, cooldownS: 15 };
  const classer = (e: unknown): string => (e as { kind?: string }).kind ?? "unknown";

  it("une même erreur notée par le chemin de génération puis par withLLM ne compte qu'une fois", () => {
    const d = new Disjoncteur(reglages, () => 0, classer);
    const cause = { kind: "unreachable" };
    d.noteTransportFailure("m", cause);
    d.noteTransportFailure("m", { kind: "unknown", cause });
    expect(d.etats.get("m")?.fails).toBe(1);
    d.noteTransportFailure("m", { kind: "unreachable" });
    expect(() => d.allow("m")).toThrow(LLMCircuitOpen);
  });

  it("un classement qui lève ne casse rien (fail-safe) et une erreur absente est ignorée", () => {
    const d = new Disjoncteur(
      reglages,
      () => 0,
      () => {
        throw new Error("bug");
      },
    );
    expect(() => d.noteTransportFailure("m", new Error("x"))).not.toThrow();
    d.noteTransportFailure("m", undefined);
    expect(d.etats.size).toBe(0);
  });

  it("sans classement injecté, aucune erreur n'ouvre le circuit", () => {
    const d = new Disjoncteur(reglages, () => 0);
    for (let i = 0; i < 5; i += 1) d.noteTransportFailure("m", new Error("refus"));
    expect(() => d.allow("m")).not.toThrow();
  });

  it("LLMCircuitOpen garde le message Python", () => {
    const e = new LLMCircuitOpen();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("LLMCircuitOpen");
    expect(e.message).toMatch(/^Service LLM temporairement indisponible \(circuit ouvert\)/);
  });

  it("réglages par défaut : 5 échecs, 15 s, actif", () => {
    expect(reglagesDisjoncteur({})).toEqual({ enabled: true, failsToOpen: 5, cooldownS: 15 });
  });

  it("coercitions Python : blancs, chiffres Unicode, soulignés", () => {
    expect(stripPython("\x1c\u3000 x \x85")).toBe("x");
    expect(stripPython("\ufeffx")).toBe("\ufeffx");
    expect(entierPython(" \u0663_\u0663 ")).toBe(33);
    expect(entierPython("\x1c3")).toBeNull();
    expect(flottantPython("-InFiNiTy")).toBe(-Infinity);
    expect(flottantPython("1__0")).toBeNull();
    expect(flottantPython("\uff12.\uff15")).toBe(2.5);
  });
});
