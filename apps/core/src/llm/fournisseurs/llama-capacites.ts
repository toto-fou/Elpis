// SPDX-License-Identifier: MIT
/** apps/core/src/llm/fournisseurs/llama-capacites.ts — ce que le llama-server en face sait faire (build et rôle lus sur `/props`), mis en cache avec un TTL. */
import { intPy, strPy, veritePy } from "@elpis/commun";
import { config } from "@elpis/config";

import { journal } from "../../journal";
import { exigerDict } from "../../python";
import { getAdminClient, monotonic } from "../llama-http";
import { currentEngine } from "../moteurs";
import type { EngineRef } from "../moteurs";

const log = journal("llama_caps");

export const MIN_BUILD_RESUMABLE_STREAM = 10545;
export const MIN_BUILD_RETURN_PROGRESS = 10545;
export const MIN_BUILD_SSE_PING = 10545;
export const MIN_BUILD_REASONING_CTL = 10545;
export const MIN_BUILD_MODELS_SSE = 10545;
export const MIN_BUILD_AUTOLOAD_PARAM = 10545;

export const CAPS_TTL_S = 300.0;
export const CAPS_FAIL_TTL_S = 10.0;

/** Capacités résolues ; `known=false` = sonde inaboutie, comportement historique. */
export class EngineCaps {
  readonly known: boolean;
  readonly build: number;
  readonly isRouter: boolean;

  constructor(champs: { known?: boolean; build?: number; isRouter?: boolean } = {}) {
    this.known = champs.known ?? false;
    this.build = champs.build ?? 0;
    this.isRouter = champs.isRouter ?? false;
    Object.freeze(this);
  }

  /** Preuve exigée : ce qui change le contrat (flux nommé, API `/models`). */
  private proven(plancher: number): boolean {
    return this.known && this.build >= plancher;
  }

  /** Bénéfice du doute : ce qui est inerte quand ce n'est pas supporté ; seule une version LUE trop ancienne le retire. */
  private notOlder(plancher: number): boolean {
    return !this.known || this.build >= plancher;
  }

  get resumableStream(): boolean {
    return this.proven(MIN_BUILD_RESUMABLE_STREAM);
  }

  get reasoningControl(): boolean {
    return this.notOlder(MIN_BUILD_REASONING_CTL);
  }

  get payloadReturnProgress(): boolean {
    return this.notOlder(MIN_BUILD_RETURN_PROGRESS);
  }

  get payloadSsePing(): boolean {
    return this.notOlder(MIN_BUILD_SSE_PING);
  }

  get payloadReasoningControl(): boolean {
    return this.notOlder(MIN_BUILD_REASONING_CTL);
  }

  get modelsApi(): boolean {
    return this.known && this.isRouter;
  }

  get modelsSse(): boolean {
    return this.modelsApi && this.proven(MIN_BUILD_MODELS_SSE);
  }

  get autoloadParam(): boolean {
    return this.notOlder(MIN_BUILD_AUTOLOAD_PARAM);
  }

  describe(): string {
    if (!this.known) return "moteur non identifié (comportement historique)";
    return `build b${this.build}${this.isRouter ? ", routeur" : ", mono-modèle"}`;
  }
}

export const UNKNOWN = new EngineCaps();

/** Racine d'un serveur : sans `/v1/chat/completions`, `/chat/completions` ni `/v1` final. */
export function baseServeur(url: string | null | undefined): string {
  let u = url ?? "";
  let fin = u.length;
  while (fin > 0 && u.charAt(fin - 1) === "/") fin--;
  u = u.slice(0, fin);
  for (const suffixe of ["/v1/chat/completions", "/chat/completions", "/v1"]) {
    if (u.endsWith(suffixe)) return u.slice(0, u.length - suffixe.length);
  }
  return u;
}

/** `\w` de Python (Unicode) pour borner le numéro de build comme `\b`. */
const RE_BUILD = /(?<![\p{L}\p{N}_])b(\p{Nd}{3,7})(?![\p{L}\p{N}_])/u;

/** `"b10545-a30273376"` → `10545` ; 0 si illisible (chiffres Unicode lus comme `int()`). */
export function parseBuild(buildInfo: unknown): number {
  const m = RE_BUILD.exec(strPy(veritePy(buildInfo) ? buildInfo : ""));
  return m === null ? 0 : intPy(m[1]);
}

const cache = new Map<string, [number, EngineCaps]>();
const prevenus = new Set<string>();

/** `[racine, en-têtes]` sondés : `baseUrl`, sinon `engine`, sinon le serveur de la cible courante ; non llama.cpp = racine vide. */
function resoudre(
  baseUrl: string,
  engine: EngineRef | null | undefined,
): [string, Record<string, string> | null] {
  let eng = engine ?? null;
  if (eng === null && !baseUrl) {
    try {
      eng = currentEngine();
    } catch {
      eng = null;
    }
  }
  if (eng !== null) {
    if (!eng.isLlamacpp) return ["", null];
    if (eng.isBuiltin) return [baseServeur(config.LLAMA_URL), null];
    const h = eng.headerDict();
    return [baseServeur(eng.baseRoot), Object.keys(h).length > 0 ? h : null];
  }
  return [baseServeur(baseUrl), null];
}

/** Capacités du moteur derrière `baseUrl` (ou `engine`, ou la cible courante) ; jamais d'exception. */
export async function engineCaps(
  baseUrl = "",
  options: { force?: boolean; engine?: EngineRef | null } = {},
): Promise<EngineCaps> {
  const [base, headers] = resoudre(baseUrl, options.engine);
  if (!base) return UNKNOWN;
  const maintenant = monotonic();
  const hit = cache.get(base);
  if (!options.force && hit && maintenant - hit[0] < CAPS_TTL_S) return hit[1];
  let caps = UNKNOWN;
  try {
    const r = await getAdminClient().get(`${base}/props`, { timeout: 3.0, headers });
    if (r.statusCode === 200) {
      const brut: unknown = r.json();
      const props = exigerDict(veritePy(brut) ? brut : {});
      const build = parseBuild(props["build_info"]);
      if (build > 0) {
        const role = props["role"];
        caps = new EngineCaps({
          known: true,
          build,
          isRouter: strPy(veritePy(role) ? role : "") === "router",
        });
      }
    }
  } catch (e) {
    log.debug(`sonde /props impossible (${String(e).slice(0, 120)}) — repli sur le comportement historique`);
  }
  cache.set(base, [caps.known ? maintenant : maintenant - (CAPS_TTL_S - CAPS_FAIL_TTL_S), caps]);
  if (!prevenus.has(base)) {
    prevenus.add(base);
    log.info(`${base} : ${caps.describe()}`);
  }
  return caps;
}

/** Dernières capacités connues, sans I/O ; `UNKNOWN` si jamais sondé. */
export function cachedCaps(baseUrl = "", options: { engine?: EngineRef | null } = {}): EngineCaps {
  const [base] = resoudre(baseUrl, options.engine);
  return cache.get(base)?.[1] ?? UNKNOWN;
}

/** Oublie la sonde (un serveur, ou toutes). */
export function invalidate(baseUrl = ""): void {
  if (!baseUrl) {
    cache.clear();
    prevenus.clear();
    return;
  }
  cache.delete(baseServeur(baseUrl));
}
