// SPDX-License-Identifier: MIT
/** apps/toolhost/test/git-vecteurs.test.ts — vecteurs du vrai Python (migration-kit/vecteurs/toolhost_git.py) : gardes d'arguments, porcelaine du push, chemins d'un dépôt, et routes Git rejouées sur le même faux agent et le même faux relais (réponse et appels identiques). */
import { readFileSync } from "node:fs";

import { HttpError } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { AgentError, GitResult, RelayRefused } from "@elpis/fichiers";
import type { AgentClient } from "@elpis/fichiers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";

import { creerAppToolhost } from "../src/app";
import { RAPPEL_ABSENT } from "../src/fichiers/commun";
import {
  dansDepot,
  hashArg,
  nomDuClone,
  pathsArg,
  refArg,
  refsPorcelaine,
  reseauGit,
  routesGit,
} from "../src/git/routes";
import { configTest, entetes, journalMuet } from "./aides";

type Canne = [unknown, unknown][];
interface Scenario {
  nom: string;
  methode: "GET" | "POST";
  route: string;
  query?: Record<string, string>;
  corps?: unknown;
  corps_brut?: string;
  agent?: { stat?: Canne; list?: Canne; read_many?: Canne; fsop?: Canne; git?: Canne };
  reseau?: Canne;
  pull?: unknown;
  gardes?: Record<string, string>;
  username?: string | null;
  maintenant?: number;
  enregistre?: boolean;
  sortie: { statut: number; corps?: unknown; erreur?: string; appels: unknown[] };
}

const V = JSON.parse(readFileSync(new URL("./vecteurs/git.json", import.meta.url), "utf-8")) as {
  refs: { entree: unknown; quoi: string; valeur?: string; statut?: number; detail?: string }[];
  hashs: { entree: unknown; valeur?: string; statut?: number; detail?: string }[];
  paths: { entree: unknown; valeur?: string[]; statut?: number; detail?: string }[];
  dans_depot: { rel: string; p: string; valeur: string | null }[];
  porcelaine: { sortie: string; valeur: Record<string, string[]> }[];
  clones: { url: string; valeur: string }[];
  routes: Scenario[];
};

function capter(f: () => unknown): Dict {
  try {
    return { valeur: f() };
  } catch (e) {
    if (e instanceof HttpError) return { statut: e.statusCode, detail: e.detail };
    throw e;
  }
}

describe("gardes et analyses pures (vecteurs Python)", () => {
  it("_ref_arg, _hash_arg, _paths_arg", () => {
    for (const c of V.refs)
      expect(
        capter(() => refArg(c.entree, c.quoi)),
        String(c.entree),
      ).toEqual(sansCle(c, "entree", "quoi"));
    for (const c of V.hashs)
      expect(
        capter(() => hashArg(c.entree)),
        String(c.entree),
      ).toEqual(sansCle(c, "entree"));
    for (const c of V.paths)
      expect(
        capter(() => pathsArg(c.entree)),
        String(c.entree),
      ).toEqual(sansCle(c, "entree"));
  });

  it("_dans_depot, _refs_porcelaine, nom du clone", () => {
    for (const c of V.dans_depot) expect(dansDepot(c.rel, c.p), `${c.rel} ${c.p}`).toBe(c.valeur);
    for (const c of V.porcelaine) expect(refsPorcelaine(c.sortie), c.sortie).toEqual(c.valeur);
    for (const c of V.clones) expect(nomDuClone(c.url), c.url).toBe(c.valeur);
  });
});

function sansCle<T extends object>(o: T, ...cles: string[]): Dict {
  const r: Dict = { ...(o as Dict) };
  for (const c of cles) delete r[c];
  return r;
}

/** Valeur cannée d'une liste `[clé, valeur]` (clé comparée en JSON), `undefined` si absente. */
function trouve(liste: Canne | undefined, cle: unknown): unknown {
  const k = JSON.stringify(cle);
  let v: unknown;
  for (const [c, r] of liste ?? []) if (JSON.stringify(c) === k) v = r;
  return v;
}

function leve(v: unknown): void {
  if (v !== null && typeof v === "object" && !Array.isArray(v) && "erreur" in v) {
    const [code, message] = (v as { erreur: [string, string] }).erreur;
    throw new AgentError(code, message);
  }
}

function resultat(v: unknown): {
  returncode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timed_out: boolean;
  duration_ms: number;
} {
  const t = [...(v as unknown[])];
  const [rc, out = "", err = "", tronque = false, delai = false] = t as [
    number,
    string?,
    string?,
    boolean?,
    boolean?,
  ];
  return { returncode: rc, stdout: out, stderr: err, truncated: tronque, timed_out: delai, duration_ms: 1 };
}

/** Faux agent : mêmes réponses et même relevé d'appels que celui du générateur Python. */
function fauxAgent(sc: Scenario, appels: unknown[]): AgentClient {
  const a = sc.agent ?? {};
  return {
    relayDir: "/srv/sb/.elpis-relay",
    async stat(paths: Iterable<string>, o: { passive?: boolean } = {}) {
      const p = [...paths];
      appels.push(["stat", p, o.passive ?? false]);
      const v = trouve(a.stat, p);
      leve(v);
      return v !== undefined ? (v as Dict[]) : p.map((x) => ({ kind: "missing", path: x }));
    },
    async list(
      path = "",
      o: { depth?: number; maxEntries?: number; hidden?: boolean; passive?: boolean } = {},
    ) {
      appels.push(["list", path, o.depth ?? 1, o.maxEntries ?? 20000, o.hidden ?? true, o.passive ?? false]);
      const v = trouve(a.list, path);
      leve(v);
      const d = (v ?? {}) as { entries?: Dict[]; truncated?: boolean };
      return { entries: [...(d.entries ?? [])], truncated: Boolean(d.truncated), errors: 0 };
    },
    async readMany(
      paths: Iterable<string>,
      o: { maxFile?: number; maxTotal?: number; passive?: boolean } = {},
    ) {
      const p = [...paths];
      appels.push(["read_many", p, o.maxFile ?? 1 << 20, o.maxTotal ?? 32 << 20, o.passive ?? false]);
      const v = trouve(a.read_many, p);
      leve(v);
      const m = new Map<string, Buffer | null>();
      for (const [k, b] of Object.entries((v ?? {}) as Record<string, string | null>))
        m.set(k, b === null ? null : Buffer.from(b, "base64"));
      return m;
    },
    async fsop(op: string, args: Dict = {}) {
      appels.push(["fsop", op, args]);
      const v = trouve(a.fsop, op);
      leve(v);
      return (v ?? {}) as Dict;
    },
    async git(
      cwd: string,
      args: Iterable<string>,
      o: { timeoutS?: number; maxOut?: number; passive?: boolean } = {},
    ) {
      const g = [...args];
      appels.push(["git", cwd, g, o.timeoutS ?? 60, o.maxOut ?? 1 << 20, o.passive ?? false]);
      const v = trouve(a.git, [cwd, g]);
      leve(v);
      return resultat(v ?? [0, "", ""]);
    },
  } as unknown as AgentClient;
}

function resultatReseau(v: unknown): GitResult {
  if (v !== null && typeof v === "object" && !Array.isArray(v) && "refus_relais" in v) {
    const [code, message] = (v as { refus_relais: [string, string] }).refus_relais;
    throw new RelayRefused(code, message);
  }
  const t = (v ?? [0, "", ""]) as unknown[];
  return new GitResult(resultat(t), (t[5] as string[] | undefined) ?? []);
}

describe("routes Git rejouées (vecteurs Python)", () => {
  const origine = { ...reseauGit };
  let app: FastifyInstance;
  let sc: Scenario;
  let appels: unknown[] = [];

  beforeAll(async () => {
    const routes = routesGit({
      bac: {
        racine: () => Promise.resolve("/srv/sb/alice/work"),
        agent: () => Promise.resolve(fauxAgent(sc, appels)),
      },
      rappel: {
        ...RAPPEL_ABSENT,
        enregistrerIdentifiantGit: async (compte, ...a: unknown[]) => {
          appels.push(["enregistrer", [compte.user_id, ...a]]);
          return sc.enregistre ?? true;
        },
      },
      journal: journalMuet,
    });
    app = await creerAppToolhost({
      tc: configTest(),
      familles: [{ nom: "git", routes }],
      journal: journalMuet,
    });
  });

  afterEach(() => Object.assign(reseauGit, origine));
  afterAll(async () => app?.close());

  it(`${V.routes.length} scénarios : même statut, même corps, mêmes appels`, async () => {
    expect(V.routes.length).toBeGreaterThan(100);
    for (const s of V.routes) {
      if (s.username === null) continue;
      sc = s;
      appels = [];
      reseauGit.runNetwork = async (_a, cwd, args, o) => {
        const g = [...args];
        appels.push([
          "reseau",
          cwd,
          g,
          o.url,
          o.pushRefs !== undefined ? [...o.pushRefs].sort() : null,
          o.auth ? [...o.auth] : null,
          o.timeoutS,
          o.maxOut,
        ]);
        return resultatReseau(trouve(s.reseau, g));
      };
      reseauGit.pull = async (_a, cwd, remote, branche = "", mode = "--ff-only", o) => {
        appels.push(["pull", cwd, remote, branche, mode, o.auth ? [...o.auth] : null, o.timeoutS, o.maxOut]);
        return resultatReseau(s.pull);
      };
      reseauGit.remoteBlockReason = async (url, compte) => {
        appels.push(["garde", url, compte.user_id]);
        return s.gardes?.[url] ?? null;
      };
      reseauGit.maintenant = () => s.maintenant ?? 1700000000.5;
      const url = s.route + (s.query ? `?${new URLSearchParams(s.query).toString()}` : "");
      const r = await app.inject({
        method: s.methode,
        url,
        headers: {
          ...entetes(1, s.username ?? "alice"),
          ...(s.methode === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(s.methode === "POST" ? { payload: s.corps_brut ?? JSON.stringify(s.corps ?? null) } : {}),
      });
      expect(r.statusCode, `${s.nom} : ${r.body}`).toBe(s.sortie.statut);
      if (s.sortie.erreur === undefined) expect(r.json(), s.nom).toEqual(s.sortie.corps);
      expect(appels, s.nom).toEqual(s.sortie.appels);
    }
  });
});
