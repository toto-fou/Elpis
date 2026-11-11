// SPDX-License-Identifier: MIT
/** apps/toolhost/test/skill-run-vecteurs.test.ts — famille skill_run rejouée sur les vecteurs du vrai Python (migration-kit/vecteurs/toolhost_skill_run.py) : résolution, refus, archive envoyée au conteneur, jetons, environnement, délai, notes et résultat. */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { racineTravail } from "@elpis/bac";
import type { Dict } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { invalidateSkillsScanCache } from "@elpis/skills";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dossierPersoDuCompte, skillRunScript } from "../src/mcp/skill-run/outil";
import type { AppuisSkillRun, ArgsSkillRun } from "../src/mcp/skill-run/outil";
import { ctxTest, membresTar } from "./aides-skill-run";

type Brut = Record<string, unknown>;
type Entree = [string, string, string, string | number | null, number | null];
const V = JSON.parse(readFileSync(new URL("./vecteurs/skill-run.json", import.meta.url), "utf-8")) as {
  base: Entree[];
  scenarios: Brut[];
};

/** Écart voulu au Python : messages renvoyés au modèle en anglais (B-13), le reste du vecteur est comparé tel quel. */
const enAnglais = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v)
      .replaceAll("env var refusée :", "env var rejected:")
      .replaceAll("script introuvable :", "script not found:")
      .replaceAll("chemin hors du dossier du skill", "path outside the skill folder")
      .replaceAll("chemin requis", "path required")
      .replaceAll(
        "Utilise un chemin de `files` (skill_get) en .py/.sh/.js…",
        "Use a path from `files` (skill_get) ending in .py/.sh/.js…",
      )
      .replaceAll(
        "/work indisponible dans le conteneur (sandbox à recréer ?).",
        "/work unavailable in the container (sandbox to recreate?).",
      ),
  );

/** Égalité ET ordre des clés (le modèle lit le JSON dans cet ordre). */
const meme = (obtenu: unknown, attendu0: unknown): void => {
  const attendu = enAnglais(attendu0);
  expect(obtenu).toEqual(attendu);
  expect(JSON.stringify(obtenu)).toBe(JSON.stringify(attendu));
};

/** Arbre du scénario sous `base` : modes explicites, dossiers en 0755 sauf mention (comme le générateur). */
function planter(base: string, arbre: Entree[]): void {
  const racines: Record<string, string> = {
    g: path.join(base, "skills"),
    u: path.join(base, "user_skills", "alice"),
    m: path.join(base, "sb", "alice", "skills"),
    U: path.join(base, "user_skills", "JeanDupont"),
  };
  mkdirSync(path.join(base, "skills"), { recursive: true });
  for (const [r, rel, nature, contenu, mode] of arbre) {
    const p = path.join(racines[r] ?? "", rel);
    mkdirSync(path.dirname(p), { recursive: true });
    if (nature === "f") writeFileSync(p, String(contenu));
    else if (nature === "z") {
      writeFileSync(p, "");
      truncateSync(p, Number(contenu));
    } else if (nature === "d") mkdirSync(p, { recursive: true });
    else if (nature === "l") symlinkSync(String(contenu), p);
    if (mode !== null && nature !== "d") chmodSync(p, mode);
  }
  const parcourir = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }))
      if (e.isDirectory()) {
        chmodSync(path.join(d, e.name), 0o755);
        parcourir(path.join(d, e.name));
      }
  };
  parcourir(base);
  for (const [r, rel, nature, , mode] of arbre)
    if (nature === "d" && mode !== null) chmodSync(path.join(racines[r] ?? "", rel), mode);
}

describe("vecteurs skill_run : outil skill_run_script", () => {
  let restaurer: () => void = () => undefined;
  afterEach(() => {
    restaurer();
    vi.unstubAllEnvs();
    invalidateSkillsScanCache();
  });

  for (const sc of V.scenarios) {
    it(String(sc["nom"]), async () => {
      const base = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-skill-run-vec-")));
      try {
        vi.stubEnv("APP_SKILLS_DIR", path.join(base, "skills"));
        vi.stubEnv("APP_USER_SKILLS_DIR", path.join(base, "user_skills"));
        restaurer = surchargerConfig({ SANDBOX_DIR: path.join(base, "sb") });
        planter(base, sc["arbre"] === "base" ? V.base : (sc["arbre"] as Entree[]));
        invalidateSkillsScanCache();
        const releve: unknown[] = [];
        const appels: Dict[] = [];
        const a: AppuisSkillRun = {
          dossierPerso: dossierPersoDuCompte,
          racine: racineTravail,
          userIdFor: async () => 7,
          uidFor: async () => 7,
          releve: (uid, username) => {
            releve.push(["releve", uid, username, "shell"]);
            const fichiers = (sc["fichiers"] as Dict[] | undefined) ?? [];
            return {
              debut: async () => void releve.push(["debut"]),
              fin: async () => void releve.push(["fin"]),
              attacher: (r) => {
                if (fichiers.length > 0) {
                  r["files_changed"] = fichiers;
                  if (Number(sc["total"] ?? 0) > fichiers.length) r["files_changed_total"] = sc["total"];
                }
                return r;
              },
            };
          },
          executer: async (o) => {
            appels.push({
              tokens: o.tokens,
              sandbox_root: `<racine>${o.sandboxRoot.slice(base.length)}`,
              env_extra: o.envExtra,
              timeout_s: o.timeoutS,
              max_output: o.maxOutput,
              archive: o.stdin === null || sc["sans_archive"] ? null : membresTar(o.stdin),
              archive_octets: o.stdin === null ? null : o.stdin.length > 0,
              user_id: o.userId,
              username: o.username,
              audit_kind: o.auditKind,
              stream_live: o.streamLive,
            });
            if (sc["pont_erreur"] !== undefined) throw new Error(String(sc["pont_erreur"]));
            return { ...(sc["pont"] as Dict) };
          },
        };
        const args = {
          args: null,
          env: null,
          timeout_sec: null,
          ...(sc["args"] as Dict),
        } as unknown as ArgsSkillRun;
        const notifications: unknown[] = [];
        let sortie: Dict | null = null;
        let erreur: string | null = null;
        try {
          sortie = await skillRunScript(args, ctxTest(sc["meta"] as Dict, notifications), a);
        } catch (e) {
          erreur = (e as Error).message;
        }
        meme(sortie, sc["sortie"]);
        expect(erreur).toBe(sc["erreur"]);
        meme(appels, sc["appels"]);
        expect(notifications).toEqual(sc["notifications"]);
        expect(releve).toEqual(sc["releve"]);
        if (sc["nom"] === "miroir_seul")
          expect(lstatSync(path.join(base, "sb", "alice", "skills")).isDirectory()).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  }
});
