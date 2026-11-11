// SPDX-License-Identifier: MIT
/** apps/core/test/graphiques/moteur-graphiques.test.ts — les 30 types de graphiques, leurs refus et le garde-fou anti-boucle rejoués contre le Python (vecteurs), infobulles échappées. */
import { ErreurPython, FlottantPy, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { echapperHtml, reinitialiserRefus, runChart } from "../../src/graphiques/moteur/index";
import type { Opt } from "../../src/graphiques/moteur/index";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { difference, ecrit, maintenant, sansEcartsVoulus, V } from "./vecteurs-moteur";
import { enAnglais } from "../skills/ecart-anglais";

const TZ_INITIAL = process.env["TZ"];

function fixerFuseau(tz: string): void {
  process.env["TZ"] = tz;
}

beforeAll(() => fixerFuseau("UTC"));
afterAll(() => {
  if (TZ_INITIAL === undefined) delete process.env["TZ"];
  else process.env["TZ"] = TZ_INITIAL;
});

/** Option du Python avec le nom de tâche des infobulles du Gantt échappé (écart « plus strict » du portage TS). */
function attendueEchappee(texte: string): string {
  const option = pyJsonLoads(texte) as any;
  if (option?._elpis?.kind !== "gantt") return texte;
  const taches = option.yAxis.data as string[];
  for (const serie of option.series as any[])
    (serie.data as any[]).forEach((d, i) => {
      const f = d?.tooltip?.formatter;
      if (typeof f !== "string") return;
      const nom = taches[i] ?? "";
      expect(f.startsWith(nom + "<br/>"), `formatter du Gantt : ${f}`).toBe(true);
      d.tooltip.formatter = echapperHtml(nom) + f.slice(nom.length);
    });
  return pyJsonDumps(option, { ensureAscii: false, allowNan: false });
}

type Obtenu = { exception: string } | { resultat: unknown; option: Opt | null; type: string | null };

function jouer(e: any): Obtenu {
  try {
    const [resultat, option, type] = runChart(e.args, e.session, maintenant());
    return { resultat, option, type };
  } catch (err) {
    return {
      exception: err instanceof ErreurPython ? err.type : err instanceof Error ? err.name : String(err),
    };
  }
}

function verifier(e: any, obtenu: Obtenu): void {
  if (e.exception) {
    expect("exception" in obtenu ? obtenu.exception : "aucune", e.nom).toBe(e.exception.type);
    return;
  }
  if ("exception" in obtenu) throw new Error(`${e.nom} : exception inattendue ${obtenu.exception}`);
  const texteTs = JSON.stringify(obtenu.resultat);
  const refusePy = (e.resultat as { ok?: boolean }).ok === false;
  // écart voulu au Python : entonnoir non décroissant gardé dans l'ordre d'entrée et annoncé (B-24).
  const entonnoir = texteTs.includes("stages are not decreasing");
  // écart voulu au Python : colonne majoritairement numérique (B-18) ou dates dont certaines sont illisibles (B-26) : dessiné et annoncé au lieu d'être refusé.
  const sauve = refusePy && (texteTs.includes("is mostly numeric") || texteTs.includes("unreadable date"));
  // écart voulu au Python : un y explicite à cellules invalides n'est plus pris pour un axe x ou un groupe (B-18).
  const yExplicite =
    (e.args as { y?: unknown }).y !== undefined &&
    texteTs.includes("non-numeric value(s)") &&
    ecrit(sansEcartsVoulus(obtenu.resultat)) !== enAnglais(ecrit(e.resultat));
  // écart voulu au Python : moyenne mobile sur moins de 5 bougies annoncée en warning, plus en fix (B-29).
  const moyenne = texteTs.includes("at least 5 candles");
  if (entonnoir || sauve || yExplicite || moyenne) {
    expect(obtenu.type).not.toBeNull();
    if (entonnoir) expect(e.type).toBe("funnel");
    return;
  }
  expect(ecrit(sansEcartsVoulus(obtenu.resultat)), e.nom).toBe(enAnglais(ecrit(e.resultat)));
  expect(obtenu.type, e.nom).toBe(e.type);
  if (e.option === null) {
    if (e.nonfini !== undefined) {
      expect(() => pyJsonDumps(obtenu.option, { ensureAscii: false, allowNan: false }), e.nom).toThrow(
        RangeError,
      );
    } else expect(obtenu.option, e.nom).toBeNull();
    return;
  }
  // écart voulu au Python : un highlight inconnu ne grise plus rien (B-27), l'option diffère donc.
  if (texteTs.includes("nothing greyed out")) return;
  const texte = pyJsonDumps(obtenu.option, { ensureAscii: false, allowNan: false });
  const attendu = attendueEchappee(e.option);
  if (texte !== attendu) throw new Error(`${e.nom} : option différente ${difference(texte, attendu)}`);
}

describe("30 types de graphiques rejoués contre le Python", () => {
  it("appels écrits à la main et tirés au sort, dans l'ordre (garde-fou compris)", () => {
    reinitialiserRefus();
    const types = new Set<string>();
    for (const e of V.graphiques as any[]) {
      const obtenu = jouer(e);
      verifier(e, obtenu);
      if ("type" in obtenu && obtenu.type !== null && obtenu.option !== null) types.add(obtenu.type);
    }
    expect([...types].sort()).toEqual(Object.keys(V.tables.PER_TYPE).sort());
    reinitialiserRefus();
  });

  it("Gantt sous d'autres fuseaux horaires (heure murale locale, passage à l'heure d'été)", () => {
    reinitialiserRefus();
    for (const e of V.gantt_fuseaux as any[]) {
      fixerFuseau(e.tz);
      verifier(e, jouer(e));
    }
    fixerFuseau("UTC");
    expect((V.gantt_fuseaux as any[]).length).toBeGreaterThan(20);
  });

  it("heatmap au format large de plus de 125 000 cellules (pas d'arguments multiples)", () => {
    const colonnes = Array.from({ length: 20 }, (_, j) => `c${j}`);
    const data = Array.from({ length: 10_000 }, (_, i) => ({
      ligne: `l${i}`,
      ...Object.fromEntries(colonnes.map((c, j) => [c, (i * j) % 17])),
    }));
    const [res, option] = runChart({ type: "heatmap", data });
    expect(res["ok"]).toBe(true);
    expect((option?.["series"] as any[])[0].data).toHaveLength(200_000);
  });

  it("mémoire des refus bornée à 4096 appels", () => {
    reinitialiserRefus();
    const a = { type: "bar", data: [] };
    const [premier] = runChart(a, "evict");
    expect(premier["repeated"] ?? null).toBe(V.eviction.premier);
    for (let i = 0; i < V.eviction.taille; i++) runChart({ type: "bar", data: [], i }, "evict");
    const [apres] = runChart(a, "evict");
    expect(apres["repeated"] ?? null).toBe(V.eviction.apres);
    const [dernier] = runChart({ type: "bar", data: [], i: V.eviction.taille - 1 }, "evict");
    expect(dernier["repeated"] ?? null).toBe(V.eviction.dernier);
    reinitialiserRefus();
  });
});

describe("infobulles du Gantt échappées (correctif XSS, écart « plus strict » du Python)", () => {
  const hostiles = [
    "<img src=x onerror=alert(1)>",
    "<script>alert(1)</script>",
    "a&b \"c\" 'd' {b}",
    "</div><svg onload=1>",
  ];

  it("le nom de tâche ne sort jamais en HTML brut", () => {
    const data = hostiles.map((t, i) => ({ t, start: `2020-0${i + 1}-05`, end: `2020-0${i + 1}-16` }));
    const [res, option] = runChart({ type: "gantt", data });
    expect(res["ok"]).toBe(true);
    const formatters = ((option?.["series"] ?? []) as any[])
      .flatMap((s) => s.data as any[])
      .map((d) => d?.tooltip?.formatter)
      .filter((f): f is string => typeof f === "string");
    expect(formatters).toHaveLength(hostiles.length);
    for (const f of formatters) expect(f.replaceAll("<br/>", "")).not.toMatch(/[<>"']/);
    expect(formatters[0]).toBe("&lt;img src=x onerror=alert(1)&gt;<br/>5 janv. → 16 janv. (12 j)");
    expect(formatters[2]).toBe("a&amp;b &quot;c&quot; &#39;d&#39; {b}<br/>5 mars → 16 mars (12 j)");
    const python = (V.graphiques as any[]).find((e) => e.nom === "gantt balises dans le nom");
    expect(python.option).toContain('"<img src=x onerror=alert(1)><br/>5 janv.');
  });

  it("aucune autre infobulle des 30 types n'insère une donnée dans son HTML", () => {
    reinitialiserRefus();
    for (const e of V.graphiques as any[]) {
      const obtenu = jouer(e);
      if ("exception" in obtenu || obtenu.option === null) continue;
      const vus: string[] = [];
      const parcourir = (n: unknown, dansTooltip: boolean): void => {
        if (Array.isArray(n)) for (const x of n) parcourir(x, dansTooltip);
        else if (n !== null && typeof n === "object" && !(n instanceof FlottantPy))
          for (const [k, x] of Object.entries(n)) {
            if (dansTooltip && k === "formatter" && typeof x === "string") vus.push(x);
            parcourir(x, dansTooltip || k === "tooltip");
          }
      };
      parcourir(obtenu.option, false);
      for (const f of vus)
        if (f !== "{b}") expect(f.replaceAll("<br/>", ""), `${e.nom} : ${f}`).not.toMatch(/[<>"']/);
    }
    reinitialiserRefus();
  });
});
