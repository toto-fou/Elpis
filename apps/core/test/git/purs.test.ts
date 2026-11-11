// SPDX-License-Identifier: MIT
/** apps/core/test/git/purs.test.ts — détection d'hébergeur, hôte saisi, adresses d'API, appels des fournisseurs, ouverture de PR et URL de comparaison rejoués contre le Python (vecteurs). */
import { readFileSync } from "node:fs";

import { ErreurPython, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import { defaultProviderType, detectProvider, normalizeHost } from "../../src/git/detection";
import { compareUrlFor, getProvider, hostIsPrivate, providerTypes } from "../../src/git/fournisseurs";
import type { DemandePr, OptionsAppel } from "../../src/git/fournisseurs";

const V = pyJsonLoads(readFileSync(new URL("../vecteurs/git.json", import.meta.url), "utf-8")) as {
  types: string[];
  detections: [string, Dict | null][];
  saisies: [string, { hote?: string; erreur?: string }][];
  defauts: [string | null, string][];
  prives: [string, boolean][];
  bases: [string | null, string, string, string, string][];
  reponses: Dict[];
  appels: [
    string,
    number,
    string,
    string,
    string,
    { sortie?: unknown; erreur?: string; appels: unknown[] },
  ][];
  pr_reponses: Dict[][];
  pr_demandes: Omit<DemandePr, "apiBase" | "token" | "username">[];
  prs: [
    string,
    number,
    number,
    string,
    string,
    { sortie?: unknown; erreur?: string; message?: string; appels: unknown[] },
  ][];
  comparaisons: [string | null, string, string][];
};

const json = (v: unknown): string => pyJsonDumps(v, { ensureAscii: false });

function typeErreur(e: unknown): string {
  return e instanceof ErreurPython ? e.type : e instanceof Error ? e.name : String(e);
}

describe("détection et saisie d'hôte (vecteurs)", () => {
  it("`detect_provider`, `default_provider_type`, `normalize_host`", () => {
    for (const [url, attendu] of V.detections)
      expect(json(detectProvider(url) ?? {}), url).toBe(json(attendu));
    for (const [d, attendu] of V.defauts) expect(defaultProviderType(d), String(d)).toBe(attendu);
    for (const [s, attendu] of V.saisies) {
      if (attendu.erreur !== undefined) expect(() => normalizeHost(s), s).toThrow();
      else expect(normalizeHost(s), s).toBe(attendu.hote);
    }
  });
});

describe("fournisseurs (vecteurs)", () => {
  it("registre, adresses d'API et hôtes privés de Gitea", () => {
    expect(providerTypes()).toEqual(V.types);
    for (const [h, attendu] of V.prives) expect(hostIsPrivate(h), h).toBe(attendu);
    for (const [t, h, o, type, base] of V.bases) {
      expect(getProvider(t).providerType, `${t} ${h}`).toBe(type);
      expect(getProvider(t).apiBase(h, o), `${t} ${h} ${o}`).toBe(base);
    }
  });

  it("test de connexion et dépôts : mêmes appels, mêmes résultats, mêmes exceptions", async () => {
    for (const [t, i, jeton, login, methode, attendu] of V.appels) {
      const appels: unknown[] = [];
      const http = (url: string, options: { headers: Record<string, string> }): Promise<Dict> => {
        appels.push([url, options]);
        return Promise.resolve(V.reponses[i] ?? {});
      };
      const f = getProvider(t);
      const appel = () =>
        methode === "test_connection"
          ? f.testConnection(http, "https://api.x/v1", jeton, login)
          : f.listRepos(http, "https://api.x/v1", jeton, login);
      const cas = `${t} ${methode} réponse ${i} ${login}`;
      if (attendu.erreur !== undefined) {
        const erreur = await appel().then(
          () => "aucune",
          (e: unknown) => typeErreur(e),
        );
        expect(erreur, cas).toBe(attendu.erreur);
      } else expect(json(await appel()), cas).toBe(json(attendu.sortie));
      expect(json(appels), cas).toBe(json(attendu.appels));
    }
  });
});

describe("ouverture de PR (vecteurs)", () => {
  it("`create_pr` : mêmes appels (URL, méthode, corps, en-têtes), mêmes résultats, mêmes exceptions", async () => {
    for (const [t, i, j, jeton, login, attendu] of V.prs) {
      const reponses = V.pr_reponses[i] ?? [];
      const appels: unknown[] = [];
      const http = (url: string, options: OptionsAppel): Promise<Dict> => {
        appels.push([url, options]);
        return Promise.resolve(reponses[Math.min(appels.length, reponses.length) - 1] ?? {});
      };
      const demande = { apiBase: "https://api.x/v1", token: jeton, username: login, ...V.pr_demandes[j]! };
      const cas = `${t} réponses ${i} demande ${j} ${login}`;
      const issue = await getProvider(t)
        .createPr(http, demande)
        .then(
          (sortie) => ({ sortie }),
          (e: unknown) => ({ erreur: typeErreur(e), message: e instanceof Error ? e.message : String(e) }),
        );
      const { appels: _a, ...reste } = attendu;
      expect(json(issue), cas).toBe(json(reste));
      expect(json(appels), cas).toBe(json(attendu.appels));
    }
  });

  it("`compare_url_for` : le type du connecteur prime, sinon l'hébergeur détecté", () => {
    const c = { host: "Git.H:3000", owner: "o", repo: "g/r", head: "agent/x", base: "main" };
    for (const [d, t, attendu] of V.comparaisons)
      expect(compareUrlFor(d ?? "", c, t), `${String(d)} ${t}`).toBe(attendu);
  });
});
