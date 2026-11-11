// SPDX-License-Identifier: MIT
/** packages/fichiers/test/vecteurs.test.ts — vecteurs du vrai Python (migration-kit/vecteurs/fichiers.py) : chemins du bac, historique, verrou, client de l'agent, relais Git, écritures de l'éditeur. */
import { readFileSync } from "node:fs";

import { HttpError, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import {
  ErreurCheminBac,
  feuilleCourte,
  lexicalRel,
  relUnder,
  stripWorkPrefix,
  toContainer,
} from "@elpis/securite";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentError,
  base64Strict,
  bilanArchive,
  decalagesEntre,
  entreeValide,
  lignesNdjson,
  relSous,
  tramesArchive,
} from "../src/agent";
import { agentHttp, validateRelPath } from "../src/ecritures";
import { MAX_FILE, MAX_VERSIONS, normRel, shaOf, SOURCES } from "../src/historique";
import { amont, basicAuth, commandesPush, entierHexPy, montrer, RelayRefused } from "../src/relais-git";
import { lockName } from "../src/verrou-ecriture";

interface Vecteurs {
  chemins: {
    strip_work_prefix: [string, string][];
    to_container: [string, string][];
    lexical_rel: { base: string; chemin: string | null; allow_root: boolean; tilde: boolean; sortie: Dict }[];
    rel_under: { base: string; cible: string; sortie: Dict }[];
    short_leaf: { nom: string; max: number; sortie: string }[];
  };
  historique: {
    norm_rel: [string | null, string][];
    lock_name: [string, string][];
    sha_of: [string, string][];
    max_file: number;
    max_versions: number;
    sources: string[];
  };
  agent: {
    rel_sous: [unknown, string, boolean][];
    entree_valide: { entree: Dict; max: number; sortie: Dict }[];
    bilan: { entree: Dict; sortie: Dict }[];
    lignes: { blocs: string[]; maxi: number; ligne_max: number; sortie: Dict }[];
    trames: { blocs: string[]; maxi: number; sortie: Dict }[];
    base64: [string, string | null][];
    decalages: { tz: string; maintenant: number; sortie: unknown }[];
  };
  relais: {
    amont: { url: string }[];
    basic_auth: [string, string, string][];
    montrer: [string, string, string][];
    hex4: [string, number | null][];
    commandes_push: { blocs: string[]; permises: string[]; sortie: Dict }[];
  };
  ecritures: { agent_http: [string, number, unknown][]; validate_rel_path: [string, Dict][] };
}

const V = pyJsonLoads(
  readFileSync(new URL("./vecteurs/fichiers.json", import.meta.url), "utf-8"),
) as Vecteurs;

const hex = (h: string): Buffer => Buffer.from(h, "hex");

async function* blocs(liste: string[]): AsyncGenerator<Buffer> {
  for (const h of liste) yield hex(h);
}

/** Valeurs relues par pyJsonLoads : entiers sûrs en `number`, flottants entiers en FlottantPy ; comparaison par JSON Python. */
function egal(a: unknown, b: unknown): void {
  const norme = (x: unknown): string =>
    JSON.stringify(x, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
  expect(norme(a)).toBe(norme(b));
}

describe("chemins du bac (paths.py)", () => {
  it("strip_work_prefix, to_container", () => {
    for (const [e, s] of V.chemins.strip_work_prefix) expect(stripWorkPrefix(e), e).toBe(s);
    for (const [e, s] of V.chemins.to_container) expect(toContainer(e), e).toBe(s);
  });

  it("lexical_rel : relatif ou SandboxPathError, même message", () => {
    for (const c of V.chemins.lexical_rel) {
      let sortie: Dict;
      try {
        sortie = { rel: lexicalRel(c.base, c.chemin, { allowRoot: c.allow_root, tilde: c.tilde }) };
      } catch (e) {
        if (!(e instanceof ErreurCheminBac)) throw e;
        sortie = { erreur: e.name, message: e.message };
      }
      expect(sortie, JSON.stringify(c)).toEqual(c.sortie);
    }
  });

  it("rel_under et _short_leaf", () => {
    for (const c of V.chemins.rel_under) {
      let sortie: Dict;
      try {
        sortie = { rel: relUnder(c.base, c.cible) };
      } catch (e) {
        if (!(e instanceof ErreurCheminBac)) throw e;
        sortie = { erreur: e.name, message: e.message };
      }
      expect(sortie, JSON.stringify(c)).toEqual(c.sortie);
    }
    for (const c of V.chemins.short_leaf) expect(feuilleCourte(c.nom, c.max)).toBe(c.sortie);
  });
});

describe("historique et verrou d'écriture (file_history.py, file_lock.py)", () => {
  it("norm_rel, lock_name, sha_of, constantes", () => {
    for (const [e, s] of V.historique.norm_rel) expect(normRel(e), String(e)).toBe(s);
    for (const [e, s] of V.historique.lock_name) expect(lockName(e), e).toBe(s);
    for (const [e, s] of V.historique.sha_of) expect(shaOf(hex(e))).toBe(s);
    expect([MAX_FILE, MAX_VERSIONS, [...SOURCES]]).toEqual([
      V.historique.max_file,
      V.historique.max_versions,
      V.historique.sources,
    ]);
  });
});

describe("client de l'agent (agent_client.py)", () => {
  const tz = process.env["TZ"];
  afterEach(() => {
    if (tz === undefined) delete process.env["TZ"];
    else process.env["TZ"] = tz;
  });

  function essayer(f: () => unknown): Dict {
    try {
      return { ok: f() };
    } catch (e) {
      if (!(e instanceof AgentError)) throw e;
      return { code: e.code, message: e.message };
    }
  }

  it("_rel_sous, _entree_valide, _bilan", () => {
    for (const [p, b, s] of V.agent.rel_sous) expect(relSous(p, b), String(p)).toBe(s);
    for (const c of V.agent.entree_valide)
      egal(
        essayer(() => entreeValide(c.entree, c.max)),
        c.sortie,
      );
    for (const c of V.agent.bilan) egal(bilanArchive(c.entree), c.sortie);
  });

  it("_lignes : NDJSON borné, signes de vie ignorés, entiers exacts", async () => {
    for (const c of V.agent.lignes) {
      let sortie: Dict;
      try {
        const objets: Dict[] = [];
        for await (const o of lignesNdjson(blocs(c.blocs), c.maxi, c.ligne_max)) objets.push(o);
        sortie = { ok: objets };
      } catch (e) {
        if (!(e instanceof AgentError)) throw e;
        sortie = { code: e.code, message: e.message };
      }
      egal(sortie, c.sortie);
    }
  });

  it("_trames : trames D/J bornées, découpées n'importe où", async () => {
    for (const c of V.agent.trames) {
      let sortie: Dict;
      try {
        const vues: [string, string][] = [];
        for await (const [g, corps] of tramesArchive(blocs(c.blocs), c.maxi))
          vues.push([g, corps.toString("hex")]);
        sortie = { ok: vues };
      } catch (e) {
        if (!(e instanceof AgentError)) throw e;
        sortie = { code: e.code, message: e.message };
      }
      egal(sortie, c.sortie);
    }
  });

  it("base64 strict (b64decode validate=True)", () => {
    for (const [s, h] of V.agent.base64) expect(base64Strict(s)?.toString("hex") ?? null, s).toBe(h);
  });

  it("décalages de l'heure locale de l'hôte pour les zip, fuseau par fuseau", () => {
    for (const c of V.agent.decalages) {
      process.env["TZ"] = c.tz;
      egal(decalagesEntre(315532800, c.maintenant + 2 * 365 * 86400), c.sortie);
    }
  });
});

describe("relais Git (git_relay.py)", () => {
  it("amont : base normalisée, dépôt, origine telle qu'écrite ; refus typés", () => {
    for (const c of V.relais.amont) {
      let sortie: Dict;
      try {
        sortie = { url: c.url, ok: amont(c.url) };
      } catch (e) {
        if (!(e instanceof RelayRefused)) throw e;
        sortie = { url: c.url, code: e.code, message: e.message };
      }
      expect(sortie).toEqual(c);
    }
  });

  it("basic_auth, _montrer, int(pkt-len, 16)", () => {
    for (const [u, t, s] of V.relais.basic_auth) expect(basicAuth(u, t)).toBe(s);
    for (const [url, base, s] of V.relais.montrer) expect(montrer(url, base), url).toBe(s);
    for (const [h, n] of V.relais.hex4) expect(entierHexPy(hex(h)), h).toBe(n);
  });

  it("_commandes_push : refs permises seules, jamais de suppression, corps rendu tel quel", async () => {
    for (const c of V.relais.commandes_push) {
      let sortie: Dict;
      try {
        const morceaux: Buffer[] = [];
        for await (const b of await commandesPush(blocs(c.blocs), new Set(c.permises))) morceaux.push(b);
        sortie = { ok: Buffer.concat(morceaux).toString("hex") };
      } catch (e) {
        const r = e as { statut?: number; message: string };
        if (r.statut === undefined) throw e;
        sortie = { statut: r.statut, message: r.message };
      }
      expect(sortie, JSON.stringify(c.blocs)).toEqual(c.sortie);
    }
  });
});

describe("écritures de l'éditeur (exec_bridge.py)", () => {
  it("agent_http et _validate_rel_path", () => {
    for (const [code, statut, detail] of V.ecritures.agent_http) {
      const e = agentHttp(new AgentError(code, "m"), "Libellé");
      expect([e.statusCode, e.detail], code).toEqual([statut, detail]);
    }
    for (const [p, s] of V.ecritures.validate_rel_path) {
      let sortie: Dict;
      try {
        sortie = { ok: validateRelPath(p) };
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        sortie = { statut: e.statusCode, detail: e.detail };
      }
      expect(sortie, p).toEqual(s);
    }
  });
});
