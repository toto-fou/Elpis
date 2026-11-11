// SPDX-License-Identifier: MIT
/** apps/core/test/outils/mcp/famille-skill.test.ts — outils de la famille skill rejoués sur les vecteurs Python (migration-kit/vecteurs/outils_skill.py) : résultats, notifications et arbre de fichiers de chaque étape. */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { validerArguments } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { afterEach, describe, expect, it } from "vitest";

import { outilsSkill } from "../../../src/outils/mcp/famille-skill";
import { SKILL_FILE_READ_CAP } from "../../../src/skills/outils";
import { invalidateSkillsScanCache } from "../../../src/skills/bibliotheque";
import { enAnglais, sansSuggestion } from "../../skills/ecart-anglais";
import { ecrireArbre, empreinteArbre, poserEnv, relatif } from "../../skills/arbre";
import { compacter, developper } from "../../skills/vecteurs-skill";
import type { ContenuArbre } from "../../skills/arbre";

type Dict = Record<string, unknown>;

interface Etape {
  outil: string;
  utilisateur: string;
  args: Dict;
  resultat?: unknown;
  exception?: string;
  message?: string;
  infos: unknown[];
  arbre?: string[][];
}

interface Vecteurs {
  arbre: Record<string, ContenuArbre>;
  constantes: Record<string, number>;
  scenarios: { nom: string; etapes: Etape[] }[];
}

const V = JSON.parse(
  readFileSync(new URL("../../vecteurs/outils-skill.json", import.meta.url), "utf-8"),
) as Vecteurs;

/** Demi-paire dans le chemin : « position N » devient `position <R>+k` (indépendant de la longueur de la racine), comme le générateur. */
function positionRelative(v: unknown, racine: string): unknown {
  if (typeof v === "string")
    return v.replace(
      /position (\d+)/gu,
      (_m, n: string) => `position <R>+${Number(n) - Array.from(racine).length}`,
    );
  if (Array.isArray(v)) return v.map((x) => positionRelative(x, racine));
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v as Dict).map(([k, x]) => [k, positionRelative(x, racine)]));
  return v;
}

const aDemiPaire = (v: unknown): boolean => typeof v === "string" && !v.isWellFormed();

/** Résultat ou exception rendus comme le vecteur : racine en `<R>`, longues chaînes résumées, positions des chemins relatives. */
function forme(v: unknown, racine: string, args: Dict): unknown {
  const brut = compacter(relatif(JSON.parse(JSON.stringify(v)), racine));
  return aDemiPaire((developper(args) as Dict)["path"]) ? positionRelative(brut, racine) : brut;
}

/** Contexte d'appel minimal : compte dans `_meta`, notifications recueillies. */
function contexte(utilisateur: string, infos: string[]): ContexteAppel {
  const note = (m: string): Promise<void> => {
    infos.push(m);
    return Promise.resolve();
  };
  return {
    nomOutil: "",
    meta: utilisateur ? { username: utilisateur } : null,
    famille: "skill",
    signal: new AbortController().signal,
    log: note,
    debug: () => Promise.resolve(),
    info: note,
    warning: note,
    error: note,
    reportProgress: () => Promise.resolve(),
  };
}

const dossiers: string[] = [];
const remises: (() => void)[] = [];

afterEach(async () => {
  for (const r of remises.splice(0).reverse()) r();
  invalidateSkillsScanCache();
  await Promise.all(dossiers.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("constantes de skill_tools.py", () => {
  it("plafond de lecture", () => {
    expect(SKILL_FILE_READ_CAP).toBe(V.constantes["lecture_max"]);
  });
});

describe("outils de la famille skill rejoués sur les vecteurs Python", () => {
  // Le scénario ask_user est rejoué par outils/integres/question.test.ts (outil sorti de la famille).
  for (const scenario of V.scenarios.filter((x) => x.nom !== "ask_user"))
    it(`${scenario.nom} (${scenario.etapes.length} étapes : résultats, notifications, arbre)`, async () => {
      const racine = await realpath(await mkdtemp(path.join(os.tmpdir(), "elpis-outils-skill-")));
      dossiers.push(racine);
      remises.push(
        poserEnv({
          APP_SKILLS_DIR: path.join(racine, "global"),
          APP_USER_SKILLS_DIR: path.join(racine, "user_skills"),
          APP_SANDBOX_DIR: path.join(racine, "sandboxes"),
          SKILLS_LOCK_PATH: `${racine}.skills_write.lock`,
        }),
      );
      await mkdir(racine, { recursive: true });
      await ecrireArbre(racine, developper(V.arbre) as Record<string, ContenuArbre>);
      const outils = new Map(outilsSkill().map((o) => [o.nom, o]));
      let arbre = await empreinteArbre(racine);
      for (const [i, e] of scenario.etapes.entries()) {
        const etiquette = `#${i} ${e.outil}(${e.utilisateur}) ${JSON.stringify(e.args).slice(0, 100)}`;
        const outil = outils.get(e.outil);
        if (outil === undefined) throw new Error(`outil absent : ${e.outil}`);
        const brut = developper(e.args) as Dict;
        const valide = validerArguments(
          { fonction: outil.fonction ?? outil.nom, parametres: outil.signature },
          brut,
        );
        if (!valide.ok) throw new Error(`${etiquette} : ${valide.texte}`);
        const infos: string[] = [];
        const obtenu: unknown = await Promise.resolve(
          outil.traiter(valide.valeurs, contexte(e.utilisateur, infos), brut),
        ).catch((erreur: unknown) => ({ exception: (erreur as Error).message }));
        // L'ordre des champs compte (texte JSON de la réponse) : comparaison sur la sérialisation.
        const attendu = e.exception === undefined ? e.resultat : { exception: e.message };
        expect(sansSuggestion(JSON.stringify(forme(obtenu, racine, e.args))), etiquette).toBe(
          enAnglais(JSON.stringify(attendu)),
        );
        expect(JSON.stringify(forme(infos, racine, e.args)), `${etiquette} (notifications)`).toBe(
          JSON.stringify(e.infos),
        );
        if (e.arbre !== undefined) arbre = e.arbre;
        expect(await empreinteArbre(racine), `${etiquette} (arbre)`).toEqual(arbre);
      }
    });
});
