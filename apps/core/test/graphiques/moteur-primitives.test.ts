// SPDX-License-Identifier: MIT
/** apps/core/test/graphiques/moteur-primitives.test.ts — lecture tolérante, spécification et arithmétique du moteur de graphiques rejouées contre le Python (vecteurs). */
import { ErreurPython, FlottantPy, versFlottantPy } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import { getCloseMatches } from "../../src/graphiques/moteur/difflib";
import { divEntierePy } from "../../src/graphiques/moteur/compile/statistiques";
import {
  ALIAS_OPTIONS,
  AMBIGUOUS,
  fold,
  KINDS,
  monthKey,
  Notes,
  resolveKind,
  toDate,
  toNumber,
  toRecords,
} from "../../src/graphiques/moteur/normalise";
import {
  PARAM_DEFAULTS,
  PARAM_SCHEMAS,
  PER_TYPE,
  ROW_SCHEMA,
  toolDescription,
} from "../../src/graphiques/moteur/parametres";
import {
  enFlottant,
  entier,
  flottant,
  fmeanPy,
  fsumPy,
  medianePy,
  plancherLog10,
  puissance10,
  quartilesExclusifs,
  quartilesInclusifs,
  sommeTermes,
} from "../../src/graphiques/moteur/py";
import type { Terme } from "../../src/graphiques/moteur/py";
import {
  ARG_ALIASES,
  buildSpec,
  MAX_ROWS,
  MAX_SERIES,
  ROLE_NAMES,
  SpecError,
} from "../../src/graphiques/moteur/spec";
import { dureeFois, dureeJours } from "../../src/graphiques/moteur/temps";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ecrit, nombre, sansEcartsVoulus, V } from "./vecteurs-moteur";

/** Nom Python de l'exception levée par `f`. */
function nomException(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof ErreurPython) return e.type;
    if (e instanceof Error) return e.name;
    return String(e);
  }
  return "aucune";
}

function egalNombre(obtenu: number, attendu: number): boolean {
  return Object.is(obtenu, attendu);
}

describe("tables du moteur", () => {
  it("types, alias d'options, rôles et arguments identiques au Python", () => {
    const T = V.tables;
    expect(ecrit(KINDS)).toBe(ecrit(T.KINDS));
    expect(ecrit(Object.fromEntries(ALIAS_OPTIONS))).toBe(ecrit(T.ALIAS_OPTIONS));
    expect(ecrit(Object.fromEntries(AMBIGUOUS))).toBe(ecrit(T.AMBIGUOUS));
    expect(ecrit(ARG_ALIASES)).toBe(ecrit(T.ARG_ALIASES));
    expect(ecrit(ROLE_NAMES)).toBe(ecrit(T.ROLE_NAMES));
    expect(MAX_ROWS).toBe(T.MAX_ROWS);
    expect(MAX_SERIES).toBe(T.MAX_SERIES);
  });

  it("paramètres annoncés aux 30 outils identiques au Python", () => {
    const T = V.tables;
    expect(ecrit(Object.fromEntries(PER_TYPE))).toBe(ecrit(T.PER_TYPE));
    expect(ecrit(PARAM_SCHEMAS)).toBe(ecrit(T.PARAM_SCHEMAS));
    expect(ecrit(PARAM_DEFAULTS)).toBe(ecrit(T.PARAM_DEFAULTS));
    expect(ecrit(ROW_SCHEMA)).toBe(ecrit(T.ROW_SCHEMA));
    expect([...PER_TYPE.keys()]).toHaveLength(30);
    for (const kind of PER_TYPE.keys()) expect(toolDescription(kind)).toBe(T.descriptions[kind]);
  });
});

describe("pliage, nombres, dates et types", () => {
  it("fold", () => {
    for (const { entree, plie } of V.plis as any[]) expect(fold(entree), String(entree)).toBe(plie);
  });

  it("toNumber", () => {
    for (const { entree, num } of V.nombres as any[]) {
      const obtenu = ((): unknown => {
        try {
          const r = toNumber(entree);
          return {
            value: r.value === null ? null : versFlottantPy(r.value),
            unit: r.unit,
            coerced: r.coerced,
          };
        } catch (e) {
          return { exception: { type: e instanceof ErreurPython ? e.type : String(e) } };
        }
      })();
      const attendu = num.exception
        ? { exception: { type: num.exception.type } }
        : {
            value: num.value === null ? null : versFlottantPy(nombre(num.value)),
            unit: num.unit,
            coerced: num.coerced,
          };
      expect(ecrit(obtenu), ecrit(entree)).toBe(ecrit(attendu));
    }
  });

  it("toDate et monthKey", () => {
    for (const { entree, date, mois } of V.dates as any[]) {
      expect(toDate(entree), `date ${ecrit(entree)}`).toBe(date);
      expect(monthKey(entree), `mois ${ecrit(entree)}`).toBe(mois);
    }
  });

  it("resolveKind", () => {
    for (const e of V.types as any[]) {
      if (e.exception) {
        expect(nomException(() => resolveKind(e.entree))).toBe(e.exception.type);
        continue;
      }
      const [type, options, note] = resolveKind(e.entree);
      expect(ecrit([type, options, note]), ecrit(e.entree)).toBe(ecrit([e.type, e.options, e.note]));
    }
  });

  it("getCloseMatches (autojunk compris)", () => {
    for (const e of V.proches as any[])
      expect(getCloseMatches(e.mot, e.possibilites, e.n, nombre(e.cutoff)), e.mot.slice(0, 30)).toEqual(
        e.resultat,
      );
  });
});

describe("robustesse des expressions régulières", () => {
  it("un nombre suivi de dizaines de milliers de blancs ne bloque pas la boucle d'événements", () => {
    const t = performance.now();
    expect(toNumber("1" + " ".repeat(64_000) + "!").value).toBeNull();
    expect(toNumber("2" + " ".repeat(64_000) + "k").value).toBe(2000);
    expect(toRecords("| a |\n|" + " ".repeat(64_000) + "x|\n| 1 |", new Notes())).toHaveLength(2);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("lecture des lignes", () => {
  it("toRecords : toutes les formes de données", () => {
    for (const e of V.enregistrements as any[]) {
      const notes = new Notes();
      let obtenu: unknown;
      try {
        const lignes = toRecords(e.data, notes, e.labels);
        obtenu = {
          lignes: lignes.map((l) => [...l.entries()].map(([k, v]) => [k, v])),
          fixes: notes.fixes,
          warnings: notes.warnings,
        };
      } catch (err) {
        obtenu = {
          exception: {
            type: err instanceof ErreurPython ? err.type : err instanceof Error ? err.name : String(err),
          },
        };
      }
      const attendu = e.exception
        ? { exception: { type: e.exception.type } }
        : { lignes: e.lignes, fixes: e.fixes, warnings: e.warnings };
      expect(ecrit(obtenu), ecrit(e.data).slice(0, 80)).toBe(ecrit(attendu));
    }
  });
});

describe("spécification canonique", () => {
  it("buildSpec : colonnes, rôles, options et notes", () => {
    for (const e of V.specs as any[]) {
      let obtenu: unknown;
      try {
        const s = buildSpec(e.args);
        obtenu = {
          kind: s.kind,
          lignes: s.rows.length,
          tree: s.tree !== null,
          auto: s.autoFrom,
          colonnes: s.cols.map((c) => [
            c.name,
            c.kind,
            c.unit,
            c.nCoerced,
            c.dates,
            c.months,
            c.example === null ? null : [c.example[0], versFlottantPy(c.example[1])],
          ]),
          x: s.x?.name ?? null,
          ys: s.ys.map((c) => c.name),
          group: s.group?.name ?? null,
          size: s.size?.name ?? null,
          levels: s.levels.map((c) => c.name),
          opts: {
            title: s.opts.title,
            subtitle: s.opts.subtitle,
            unit: s.opts.unit,
            stack: s.opts.stack,
            horizontal: s.opts.horizontal,
            sort: s.opts.sort,
            top: s.opts.top,
            show_values: s.opts.showValues,
            highlight: s.opts.highlight,
            lines: s.opts.lines.map((l) => ({ value: versFlottantPy(l.value), label: l.label })),
            trend: s.opts.trend,
            smooth: s.opts.smooth,
            step: s.opts.step,
          },
          fixes: s.notes.fixes,
          warnings: s.notes.warnings,
        };
      } catch (err) {
        obtenu =
          err instanceof SpecError
            ? { specError: { message: err.message, fix: err.fix, example: err.example } }
            : { exception: { type: err instanceof ErreurPython ? err.type : String(err) } };
      }
      const { nom: _nom, args: _args, ...attendu } = e;
      const a = ecrit(attendu.exception ? { exception: { type: attendu.exception.type } } : attendu);
      expect(ecrit(sansEcartsVoulus(obtenu, true)), e.nom).toBe(a);
    }
  });
});

function termes(valeurs: unknown[]): Terme[] {
  return valeurs.map((v) => {
    if (v instanceof FlottantPy) return flottant(v.valeur);
    if (typeof v === "bigint") return entier(Number(v));
    return Number.isInteger(v) ? entier(v as number) : flottant(v as number);
  });
}

describe("arithmétique à la Python", () => {
  it("sum() compensé de Python 3.13 (entiers puis flottants)", () => {
    for (const e of V.maths.somme as any[]) {
      const r = sommeTermes(termes(e.termes));
      expect(egalNombre(r.v, nombre(e.somme)), ecrit(e.termes)).toBe(true);
      expect(r.f).toBe(!e.entier);
    }
  });

  it("math.fsum", () => {
    for (const e of V.maths.fsomme as any[])
      expect(egalNombre(fsumPy(e.termes.map(nombre)), nombre(e.fsum)), ecrit(e.termes)).toBe(true);
  });

  it("statistics : quartiles, médiane, moyenne", () => {
    for (const e of V.maths.statistiques as any[]) {
      const valeurs = e.valeurs.map(nombre) as number[];
      const egal = (a: number[], b: unknown[]): boolean => a.every((x, i) => egalNombre(x, nombre(b[i])));
      expect(egal([...quartilesInclusifs(valeurs)], e.inclusif)).toBe(true);
      expect(egal([...quartilesExclusifs(valeurs)], e.exclusif)).toBe(true);
      expect(egalNombre(medianePy(valeurs), nombre(e.mediane))).toBe(true);
      expect(egalNombre(fmeanPy(valeurs), nombre(e.moyenne))).toBe(true);
    }
  });

  it("racine cubique, log2 et plancher de log10 identiques à la libm", () => {
    for (const e of V.maths.puissances as any[]) {
      expect(egalNombre(e.n ** (1 / 3), nombre(e.racine_cubique)), `cbrt ${e.n}`).toBe(true);
      expect(Math.ceil(Math.log2(e.n) + 1), `log2 ${e.n}`).toBe(e.ceil_log2);
    }
    for (const e of V.maths.plancher_log10 as any[]) {
      expect(plancherLog10(nombre(e.x)), String(e.x)).toBe(e.plancher);
      if (e.p10 !== null) expect(egalNombre(enFlottant(puissance10(e.plancher)), nombre(e.p10))).toBe(true);
    }
    for (const e of V.maths.p10_negatives as any[])
      expect(egalNombre(puissance10(e.e) as number, nombre(e.valeur))).toBe(true);
  });

  it("a // b sur des flottants", () => {
    for (const e of V.maths.divisions as any[])
      expect(egalNombre(divEntierePy(nombre(e.a), nombre(e.b)), nombre(e.div)), `${e.a} // ${e.b}`).toBe(
        true,
      );
  });

  it("timedelta(days=…) et timedelta * 0,02", () => {
    for (const e of V.maths.durees as any[]) {
      if (e.exception) {
        expect(nomException(() => dureeJours(nombre(e.jours)))).toBe(e.exception.type);
        continue;
      }
      expect(dureeJours(nombre(e.jours)), String(e.jours)).toBe(BigInt(e.us));
    }
    for (const e of V.maths.produits as any[]) expect(dureeFois(BigInt(e.us), 0.02)).toBe(BigInt(e.fois));
  });
});
