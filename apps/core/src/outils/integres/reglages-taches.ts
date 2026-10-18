// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/reglages-taches.ts — réglages des sous-agents (section `agents` de config.json) : lecture seule par type (défaut, imposition), sous-agents simultanés par tour, lecture vivante et règle de priorité. */
import { estDict, getPy, HttpError, intPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { configView } from "@elpis/config";
import { TYPE_AGENT_PERSONNALISE, TYPES_AGENTS_LIVRES, TYPES_AGENTS_REGLABLES } from "@elpis/securite";

export type ParType = Readonly<Record<string, boolean>>;

export interface ReglagesAgents {
  readonly read_only: { readonly defaults: ParType; readonly forced: ParType };
  readonly max_parallel: number;
}

export const BORNES_PARALLELE: readonly [number, number] = [1, 10];

const parTypeDe = (f: (t: string) => boolean): Record<string, boolean> =>
  Object.fromEntries(TYPES_AGENTS_REGLABLES.map((t) => [t, f(t)]));

export const DEFAUTS_AGENTS: ReglagesAgents = {
  read_only: { defaults: parTypeDe((t) => t === "explore"), forced: parTypeDe(() => false) },
  max_parallel: 3,
};

/** Type des réglages d'un agent du roster : livré par son nom, sinon `custom`. */
export function typeReglable(nom: string): string {
  return (TYPES_AGENTS_LIVRES as readonly string[]).includes(nom) ? nom : TYPE_AGENT_PERSONNALISE;
}

function parTypeLu(brut: unknown, defaut: ParType): Record<string, boolean> {
  const src: Dict = estDict(brut) ? brut : {};
  return parTypeDe((t) => (typeof src[t] === "boolean" ? (src[t] as boolean) : (defaut[t] ?? false)));
}

/** Valeurs effectives d'une section lue : une clé illisible ou hors bornes retombe sur son défaut. */
export function reglagesAgentsDepuis(brut: unknown): ReglagesAgents {
  const src: Dict = estDict(brut) ? brut : {};
  const ro: Dict = estDict(src["read_only"]) ? src["read_only"] : {};
  let n: number;
  try {
    n = intPy(getPy(src, "max_parallel", DEFAUTS_AGENTS.max_parallel));
  } catch {
    n = DEFAUTS_AGENTS.max_parallel;
  }
  return {
    read_only: {
      defaults: parTypeLu(ro["defaults"], DEFAUTS_AGENTS.read_only.defaults),
      forced: parTypeLu(ro["forced"], DEFAUTS_AGENTS.read_only.forced),
    },
    max_parallel:
      Number.isInteger(n) && n >= BORNES_PARALLELE[0] && n <= BORNES_PARALLELE[1]
        ? n
        : DEFAUTS_AGENTS.max_parallel,
  };
}

function parTypeEcrit(brut: unknown, courant: ParType, quoi: string): Record<string, boolean> {
  if (brut === undefined || brut === null) return { ...courant };
  if (!estDict(brut)) throw new HttpError(400, `agents.read_only.${quoi} doit être un objet`);
  const out = { ...courant };
  for (const [t, v] of Object.entries(brut)) {
    if (!TYPES_AGENTS_REGLABLES.includes(t))
      throw new HttpError(400, `agents.read_only.${quoi} : type inconnu « ${t} »`);
    if (typeof v !== "boolean")
      throw new HttpError(400, `agents.read_only.${quoi}.${t} doit être un booléen`);
    out[t] = v;
  }
  return out;
}

/** Section validée pour config.json : clé absente gardée, type inconnu, non-booléen ou borne dépassée : 400. */
export function assainirReglagesAgents(brut: unknown, courant: ReglagesAgents): ReglagesAgents {
  if (!estDict(brut)) throw new HttpError(400, "Body invalide : besoin de {agents: {...}}");
  const ro = brut["read_only"];
  if (ro !== undefined && ro !== null && !estDict(ro))
    throw new HttpError(400, "agents.read_only doit être un objet");
  const roD: Dict = estDict(ro) ? ro : {};
  let n = courant.max_parallel;
  if (brut["max_parallel"] !== undefined) {
    const v = brut["max_parallel"];
    if (typeof v !== "number" || !Number.isInteger(v))
      throw new HttpError(400, "agents.max_parallel doit être un entier");
    if (v < BORNES_PARALLELE[0] || v > BORNES_PARALLELE[1])
      throw new HttpError(
        400,
        `agents.max_parallel doit être entre ${BORNES_PARALLELE[0]} et ${BORNES_PARALLELE[1]}`,
      );
    n = v;
  }
  return {
    read_only: {
      defaults: parTypeEcrit(roD["defaults"], courant.read_only.defaults, "defaults"),
      forced: parTypeEcrit(roD["forced"], courant.read_only.forced, "forced"),
    },
    max_parallel: n,
  };
}

/** Réglages en vigueur, relus dans la vue vivante de config.json (lus à chaud). */
export function reglagesAgents(): ReglagesAgents {
  try {
    return reglagesAgentsDepuis(getPy(configView(), "agents"));
  } catch {
    return DEFAUTS_AGENTS;
  }
}

export type SourceLectureSeule = "admin_forced" | "task" | "user" | "admin_default";

/** Imposée par l'admin, OU demandée par `task`, OU case du compte (si posée, sinon défaut de l'admin) ; l'agent principal ne fait que durcir. */
export function lectureSeuleEffective(
  type: string,
  o: { task: boolean; utilisateur: boolean | null },
  r: ReglagesAgents = reglagesAgents(),
): { read_only: boolean; source: SourceLectureSeule | null } {
  if (r.read_only.forced[type]) return { read_only: true, source: "admin_forced" };
  if (o.task) return { read_only: true, source: "task" };
  if (o.utilisateur !== null) return { read_only: o.utilisateur, source: o.utilisateur ? "user" : null };
  return r.read_only.defaults[type]
    ? { read_only: true, source: "admin_default" }
    : { read_only: false, source: null };
}
