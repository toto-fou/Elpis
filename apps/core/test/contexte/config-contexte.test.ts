// SPDX-License-Identifier: MIT
/** apps/core/test/contexte/config-contexte.test.ts — `context_config.json` sur plusieurs fichiers de test, chemin, journal et singleton (vecteurs Python). */
import { DOSSIER_MOTEUR } from "../moteur-environnement";

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { comparePointsDeCode } from "@elpis/commun";
import { CHARS_PER_TOKEN, config, readJsonFile } from "@elpis/config";

import {
  chargerContextConfig,
  ContextConfig,
  CTX,
  reload,
  resolveText,
} from "../../src/contexte/config-contexte";
import { ingestTools, reinitialiserRegistre } from "../../src/outils/categories";
import { decoder, lireVecteurs, rejouer } from "../vecteurs-moteur";
import type { Attendu } from "../vecteurs-moteur";

type Paire<T> = [T, Attendu];

interface Config {
  nom: string;
  texte: string | null;
  registre: string[];
  tpc: unknown;
  get: Paire<string>[];
  text: Paire<string>[];
  override: Paire<string>[];
  tool_enabled: Paire<string>[];
  disabled_tools: Attendu;
  tool_description: Paire<string>[];
  budget_raw: Paire<string>[];
  tool_timeout_s: Paire<string>[];
  gating_enabled: Attendu;
  category_gated_out: [string | null, string | null, Attendu][];
  est_tokens: Paire<string | null>[];
  validate: Attendu;
  validate_journal: [string, string][];
  load: { ok: true } | { erreur: string; message: string };
  load_journal: [string, string][];
}

interface Vecteurs {
  fichiers: Record<string, { texte: string } | { hex: string }>;
  noeuds: ({ noeud: unknown; defaut: string } & Attendu)[];
  configs: Config[];
  chemins: { env: string | null; chemin: string }[];
}

const v = lireVecteurs<Vecteurs>("contexte-config");
const TMP = path.join(DOSSIER_MOTEUR, "contexte");
mkdirSync(TMP, { recursive: true });
for (const [nom, contenu] of Object.entries(v.fichiers))
  writeFileSync(path.join(TMP, nom), "hex" in contenu ? Buffer.from(contenu.hex, "hex") : contenu.texte);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** `<TMP>` des vecteurs → dossier de ce test, partout dans une valeur. */
function local(x: unknown): unknown {
  if (typeof x === "string") return x.replaceAll("<TMP>", TMP);
  if (Array.isArray(x)) return x.map(local);
  if (typeof x === "object" && x !== null)
    return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, local(y)]));
  return x;
}

function attendu(a: Attendu): Attendu {
  return "valeur" in a ? { valeur: local(a.valeur) } : a;
}

/** Lignes `[niveau, message]` du domaine `context_config` écrites sur stderr pendant `f` (avertissement et au-delà). */
function journal(f: () => void): [string, string][] {
  const lignes: string[] = [];
  const espion = vi.spyOn(process.stderr, "write").mockImplementation(((texte: unknown) => {
    lignes.push(String(texte));
    return true;
  }) as typeof process.stderr.write);
  try {
    f();
  } finally {
    espion.mockRestore();
  }
  return lignes
    .map((l) => l.split("\n")[0] ?? "")
    .map((l) => l.split(" "))
    .filter((m) => ["WARNING", "ERROR", "CRITICAL"].includes(m[1] ?? "") && m[2] === "[context_config]")
    .map((m) => [m[1] ?? "", m.slice(2).join(" ")]);
}

function preparerRegistre(categories: string[], nom: string): void {
  const fichier = path.join(DOSSIER_MOTEUR, "registres", `${nom}-${categories.length}`, "cache.json");
  rmSync(fichier, { force: true });
  reinitialiserRegistre({ cheminCache: fichier });
  if (categories.length > 0)
    ingestTools(categories.map((c) => ({ name: `outil_${c}`, meta: { category: c } })));
}

describe("vecteurs Python de llm_core/context_config.py", () => {
  it("résolution d'un nœud de texte", () => {
    for (const n of v.noeuds)
      rejouer(() => resolveText(local(n.noeud), n.defaut), n, JSON.stringify(n.noeud));
  });

  for (const c of v.configs) {
    it(`configuration ${c.nom}${c.registre.length > 0 ? " (registre peuplé)" : ""}`, () => {
      preparerRegistre(c.registre, c.nom);
      const chemin = path.join(TMP, `${c.nom}.json`);
      rmSync(chemin, { force: true });
      if (c.texte !== null) writeFileSync(chemin, c.texte.replaceAll("<TMP>", TMP));
      const cfg = new ContextConfig(readJsonFile(chemin));
      const ctx = (quoi: string): string => `${c.nom} › ${quoi}`;
      expect(cfg.tpc, ctx("tpc")).toEqual(decoder(c.tpc));
      for (const [p, a] of c.get) rejouer(() => cfg.get(p, "D"), attendu(a), ctx(`get ${p}`));
      for (const [p, a] of c.text) rejouer(() => cfg.text(p, "DEF"), attendu(a), ctx(`text ${p}`));
      for (const [p, a] of c.override)
        rejouer(() => cfg.override(p, "FALLBACK"), attendu(a), ctx(`override ${p}`));
      for (const [n, a] of c.tool_enabled) rejouer(() => cfg.toolEnabled(n), a, ctx(`tool_enabled ${n}`));
      rejouer(
        () => [...cfg.disabledTools()].sort(comparePointsDeCode),
        c.disabled_tools,
        ctx("disabled_tools"),
      );
      for (const [n, a] of c.tool_description)
        rejouer(() => cfg.toolDescription(n, "DOC"), attendu(a), ctx(`tool_description ${n}`));
      for (const [b, a] of c.budget_raw) rejouer(() => cfg.budgetRaw(b), a, ctx(`budget_raw ${b}`));
      for (const [n, a] of c.tool_timeout_s)
        rejouer(() => cfg.toolTimeoutS(n), a, ctx(`tool_timeout_s ${n}`));
      rejouer(() => cfg.gatingEnabled(), c.gating_enabled, ctx("gating_enabled"));
      for (const [cat, texte, a] of c.category_gated_out)
        rejouer(() => cfg.categoryGatedOut(cat, texte), a, ctx(`category_gated_out ${cat} ${texte}`));
      for (const [t, a] of c.est_tokens) rejouer(() => cfg.estTokens(t), a, ctx(`est_tokens ${t}`));
      const valider = (): null => {
        cfg.validate();
        return null;
      };
      expect(
        journal(() => rejouer(valider, c.validate, ctx("validate"))),
        ctx("journal"),
      ).toEqual(c.validate_journal);
      let charge: unknown = null;
      expect(
        journal(() => {
          try {
            chargerContextConfig(chemin);
            charge = { ok: true };
          } catch (e) {
            charge = { erreur: (e as { type?: string }).type, message: (e as Error).message };
          }
        }),
        ctx("journal du chargement"),
      ).toEqual(c.load_journal);
      expect(charge, ctx("chargement")).toEqual(c.load);
    });
  }

  it("CONTEXT_CONFIG_PATH : APP_CONTEXT_CONFIG lue au chargement, relative à la racine, normalisée comme Path", async () => {
    for (const c of v.chemins) {
      vi.resetModules();
      vi.stubEnv("APP_CONTEXT_CONFIG", c.env === null ? undefined : c.env.replaceAll("<TMP>", TMP));
      const module = await import("../../src/contexte/config-contexte");
      // Écart voulu : le fichier par défaut a quitté shared_infra/ pour packages/config/.
      const chemin = c.env?.trim() ? c.chemin : "<RACINE>/packages/config/context_config.json";
      const attendu = chemin.replace("<TMP>", TMP).replace("<RACINE>", config.PROJECT_ROOT);
      expect(module.CONTEXT_CONFIG_PATH, String(c.env)).toBe(attendu);
    }
  });
});

describe("comportements des tests pytest", () => {
  it("le JSON livré se charge, gating actif, mise en garde du gating inerte présente", () => {
    expect(CTX.gatingEnabled()).toBe(true);
    const livre = JSON.parse(
      readFileSync(path.join(config.PROJECT_ROOT, "packages", "config", "context_config.json"), "utf-8"),
    );
    expect(Object.keys(livre.tool_gating)).toContain("_WARNING_NOT_WIRED");
    expect(Object.keys(livre.tool_gating.gated ?? {})).not.toContain("firefox");
  });

  it("ratio de repli unifié (1/3.3) et surcharge budgets.tokens_per_char", () => {
    expect(new ContextConfig({}).tpc).toBeCloseTo(1 / CHARS_PER_TOKEN, 12);
    expect(new ContextConfig({ budgets: { tokens_per_char: 0.5 } }).tpc).toBe(0.5);
    expect(new ContextConfig({ budgets: { tokens_per_char: 0.25 } }).estTokens("x".repeat(400))).toBe(100);
    expect(new ContextConfig({}).estTokens("x".repeat(100))).toBe(30);
  });

  it("gating par mots-clés : liste blanche des catégories gérées, casse ignorée", () => {
    const cfg = new ContextConfig({
      tool_gating: {
        enabled: true,
        gated: { git: "keyword:git,commit,branch", browser: "keyword:screenshot" },
      },
    });
    expect(cfg.categoryGatedOut("git", "bonjour")).toBe(true);
    expect(cfg.categoryGatedOut("git", "please commit this")).toBe(false);
    expect(cfg.categoryGatedOut("browser", "take a SCREENSHOT")).toBe(false);
    expect(cfg.categoryGatedOut("fs", "bonjour")).toBe(false);
    expect(new ContextConfig({}).categoryGatedOut("git", "x")).toBe(false);
  });

  it("reload() recharge le singleton et la liaison importée le suit", () => {
    const avant = CTX;
    reload();
    expect(CTX).not.toBe(avant);
    expect(CTX.gatingEnabled()).toBe(avant.gatingEnabled());
  });
});
