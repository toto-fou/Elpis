// SPDX-License-Identifier: MIT
/** apps/core/src/contexte/config-contexte.ts — textes et réglages injectés au LLM (`context_config.json`), chargés au démarrage : défaut = littéral de l'appelant. */
import { readFileSync } from "node:fs";

import { comparePointsDeCode, ErreurPython, estErreurPython, stripPy, strPy, veritePy } from "@elpis/commun";
import {
  asStr,
  CHARS_PER_TOKEN,
  cheminContextConfig,
  config,
  deepGet,
  outilsEteints,
  readJsonFile,
  resolveRel,
} from "@elpis/config";

import { journal } from "../journal";
import { getCategories, manifestSource } from "../outils/categories";
import { entierPy, estDict, exigerDict, flottantPy, iterPy, lire, longueurPy, lowerPy, ou } from "../python";
import type { Dict } from "../python";

const log = journal("context_config");
/** env `APP_CONTEXT_CONFIG` > `app.context_config_path` de `shared_infra/config.json` > défaut ; lu au chargement. */
export const CONTEXT_CONFIG_PATH = cheminContextConfig();

const DECODEUR = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `_load_system_prompt_file` : UTF-8 strict, BOM gardé, fins de ligne universelles ; `""` au moindre échec. */
function lirePrompt(chemin: string): string {
  if (!chemin.isWellFormed()) return "";
  try {
    return DECODEUR.decode(readFileSync(chemin)).replace(/\r\n?/g, "\n");
  } catch {
    return "";
  }
}

/** Texte d'un nœud : chaîne telle quelle, `{"file"}` lu sous la racine (repli `inline`), `{"inline"}`, sinon `defaut`. */
export function resolveText(node: unknown, defaut = ""): string {
  if (node === null || node === undefined) return defaut;
  if (typeof node === "string") return node;
  if (!estDict(node)) return defaut;
  const fichier = lire(node, "file");
  if (veritePy(fichier)) {
    const texte = lirePrompt(resolveRel(strPy(fichier), config.PROJECT_ROOT));
    if (stripPy(texte)) return texte;
  }
  return asStr(lire(node, "inline"), defaut);
}

function entierOuZero(v: unknown): number {
  try {
    return entierPy(v);
  } catch {
    return 0;
  }
}

/** Accès typés à `context_config.json`, résolution des textes, interrupteurs d'outils et gating par catégorie. */
export class ContextConfig {
  readonly raw: Dict;
  readonly tpc: number;

  constructor(raw: unknown) {
    this.raw = (veritePy(raw) ? raw : {}) as Dict;
    const defaut = 1.0 / CHARS_PER_TOKEN;
    let tpc: number;
    try {
      tpc = flottantPy(deepGet(this.raw, "budgets.tokens_per_char", defaut));
    } catch {
      tpc = defaut;
    }
    this.tpc = tpc;
  }

  get(chemin: string, defaut: unknown = null): unknown {
    return deepGet(this.raw, chemin, defaut);
  }

  /** Résolution brute : `""` rendu tel quel (« omettre »). */
  text(chemin: string, defaut = ""): string {
    return resolveText(deepGet(this.raw, chemin, null), defaut);
  }

  /** Valeur vide ou absente → `fallback` (le littéral du code) ; seule une valeur non vide surcharge. */
  override(chemin: string, fallback = ""): string {
    const node = deepGet(this.raw, chemin, null);
    if (node === null || node === undefined) return fallback;
    const texte = resolveText(node, fallback);
    return texte && stripPy(texte) ? texte : fallback;
  }

  /** Faux seulement si `tools.<name>.enabled` est explicitement faux. */
  toolEnabled(name: string): boolean {
    return veritePy(deepGet(this.raw, `tools.${name}.enabled`, true));
  }

  /** Noms marqués `tools.<nom>.enabled: false` (retirés nativement par le serveur MCP au démarrage). */
  disabledTools(): Set<string> {
    return outilsEteints(this.raw);
  }

  toolDescription(name: string, fallback = ""): string {
    return this.override(`tools.${name}.description`, fallback);
  }

  /** Nœud brut de `budgets` (nombres, pas de texte), ou `null`. */
  budgetRaw(key: string): unknown {
    return deepGet(this.raw, `budgets.${key}`, null);
  }

  /** Délai par outil en secondes ; 0 = pas de surcharge (le défaut global s'applique). */
  toolTimeoutS(name: string): number {
    let v: number;
    try {
      v = flottantPy(ou(deepGet(this.raw, `tools.${name}.timeout_s`, 0), 0));
    } catch (e) {
      if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
      v = 0;
    }
    return v > 0 ? v : 0;
  }

  gatingEnabled(): boolean {
    return veritePy(deepGet(this.raw, "tool_gating.enabled", false));
  }

  /** Vrai si une catégorie listée dans `tool_gating.gated` (`keyword:a,b`) n'a aucun de ses mots-clés dans le texte. */
  categoryGatedOut(category: string | null | undefined, keywordsText: string | null = ""): boolean {
    if (!category || !this.gatingEnabled()) return false;
    const regle = lire(exigerDict(ou(deepGet(this.raw, "tool_gating.gated", {}), {})), category);
    if (regle === null || regle === undefined) return false;
    const texte = strPy(regle);
    if (!texte.startsWith("keyword:")) return false;
    const mots = texte
      .slice("keyword:".length)
      .split(",")
      .filter((k) => stripPy(k) !== "")
      .map((k) => lowerPy(stripPy(k)));
    const bas = lowerPy(keywordsText || "");
    return !mots.some((k) => bas.includes(k));
  }

  /** Estimation en tokens : `len(s)` en points de code × `budgets.tokens_per_char` (sinon 1/`CHARS_PER_TOKEN`). */
  estTokens(s: string | null | undefined): number {
    return entierPy(longueurPy(s || "") * this.tpc);
  }

  /** Budgets d'avertissement au chargement (`fail_on_overrun` lève), puis signal du gating inerte. */
  validate(): void {
    const echec = veritePy(this.get("budgets.fail_on_overrun", false));
    for (const [cheminTexte, cheminBudget] of [
      ["system_prompt", "budgets.warn_system_total"],
      ["compression.system_prompt", "budgets.warn_compression_summary"],
    ] as const) {
      const budget = entierOuZero(this.get(cheminBudget, 0));
      if (budget <= 0) continue;
      const n = this.estTokens(this.text(cheminTexte));
      if (n <= budget) continue;
      const message = `${cheminTexte}: ~${n} tok > budget ${budget}`;
      if (echec) throw new ErreurPython("ValueError", `[context_config] ${message}`);
      log.warn(message);
    }
    this.signalerGatingInerte();
  }

  /** `tool_gating.gated` n'a aucun effet (gating par mots-clés non câblé) : le dire une fois au chargement. */
  private signalerGatingInerte(): void {
    try {
      if (!this.gatingEnabled()) return;
      const gated = ou(deepGet(this.raw, "tool_gating.gated", {}), {});
      if (!veritePy(gated)) return;
      const elements = iterPy(gated);
      if (elements === null) throw new ErreurPython("TypeError", "object of this type has no len()");
      const noms = elements.map(strPy);
      log.warn(
        `tool_gating.gated liste ${elements.length} catégorie(s) (${[...noms].sort(comparePointsDeCode).join(", ")}) ` +
          "mais le gating par mots-clés n'est PAS câblé : aucune catégorie ne sera masquée. Réglage sans effet — " +
          "utilisez les toggles du panneau Outils, ou tools.<nom>.enabled=false pour retirer un outil.",
      );
      this.signalerCategoriesInconnues(noms);
    } catch (e) {
      log.debug({ err: e }, "contrôle tool_gating ignoré");
    }
  }

  /** Noms de `gated` absents du registre ; registre vide ou illisible : rien à dire. */
  private signalerCategoriesInconnues(noms: string[]): void {
    try {
      if (manifestSource() === "empty") return;
      const connues = new Set(getCategories(true).map((c) => c.name));
      const inconnues = [...new Set(noms)].filter((n) => !connues.has(n)).sort(comparePointsDeCode);
      if (inconnues.length > 0)
        log.warn(
          `tool_gating.gated : catégorie(s) inconnue(s) du registre : ${inconnues.join(", ")} ` +
            `(connues : ${[...connues].sort(comparePointsDeCode).join(", ")})`,
        );
    } catch {
      return;
    }
  }
}

/** `_load()` : `{}` si le fichier manque (replis partout) ; un échec de validation ne lève que sous `fail_on_overrun`. */
export function chargerContextConfig(chemin: string = CONTEXT_CONFIG_PATH): ContextConfig {
  const brut = readJsonFile(chemin);
  const cfg = new ContextConfig(brut);
  try {
    cfg.validate();
  } catch (e) {
    const budgets = Object.hasOwn(brut, "budgets") ? brut["budgets"] : {};
    if (veritePy(lire(exigerDict(budgets), "fail_on_overrun"))) throw e;
    log.error({ err: e }, "validation soft-failed");
  }
  return cfg;
}

/** Singleton chargé au démarrage ; la liaison ESM suit `reload()`. */
export let CTX: ContextConfig = chargerContextConfig();

export function reload(): void {
  CTX = chargerContextConfig();
}
