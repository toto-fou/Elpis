// SPDX-License-Identifier: MIT
/** packages/bac/test/regle-git.test.ts — règle Git d'un profil réseau : serveurs saisis mis en forme, règle lue de config.json (défaut, valeurs illisibles signalées), profil de repli. */
import { describe, expect, it } from "vitest";

import {
  configBacDepuis,
  profilParId,
  profilReseauDepuis,
  regleGitDepuis,
  serveurGitCanonique,
} from "../src/index";
import type { Avertir } from "../src/index";

describe("serveurGitCanonique", () => {
  it.each([
    ["github.com", "github.com"],
    ["GitHub.COM", "github.com"],
    ["  github.com  ", "github.com"],
    ["https://github.com", "github.com"],
    ["http://github.com/", "github.com"],
    ["HTTPS://Github.com//", "github.com"],
    ["git.lan:3000", "git.lan:3000"],
    ["git.lan:65535", "git.lan:65535"],
    ["github.com/Acme", "github.com/Acme"],
    ["GitHub.com/Acme.GIT", "github.com/Acme"],
    ["github.com/acme/api", "github.com/acme/api"],
    ["https://github.com/Acme/API.git", "github.com/Acme/API"],
    ["https://github.com/acme/api.git/", "github.com/acme/api"],
    ["git.lan:3000/o/r.git", "git.lan:3000/o/r"],
    ["github.com/a.b_c-d~e", "github.com/a.b_c-d~e"],
    ["github.com/acme.git/x", "github.com/acme.git/x"],
    ["a-b.c-d.example", "a-b.c-d.example"],
    ["localhost", "localhost"],
    ["192.0.2.7:8080", "192.0.2.7:8080"],
  ])("%j : %j", (entree, attendu) => {
    expect(serveurGitCanonique(entree)).toBe(attendu);
  });

  it.each([
    [""],
    ["   "],
    ["/"],
    ["https://"],
    ["git.lan:0"],
    ["git.lan:65536"],
    ["git.lan:99999"],
    ["git.lan:08"],
    ["git.lan:abc"],
    ["git.lan:"],
    ["git.lan:100000"],
    ["-bad.example"],
    ["bad-.example"],
    ["a..b"],
    [".example"],
    ["exa mple.com"],
    ["user@github.com"],
    ["ssh://git@github.com/acme"],
    ["git@github.com:acme/api.git"],
    ["github.com//acme"],
    ["github.com/acme//api"],
    ["github.com/.."],
    ["github.com/acme/.."],
    ["github.com/."],
    ["github.com/acme/./api"],
    ["github.com/a b"],
    ["github.com/ac%2fme"],
    ["github.com/ac;me"],
    ["github.com/acme?x=1"],
    ["github.com/acme#f"],
    ["github.com/é"],
    ["[::1]"],
    ["[2001:db8::1]:8080"],
    ["a".repeat(64) + ".example"],
  ])("illisible %j : refusé", (entree) => {
    expect(serveurGitCanonique(entree)).toBeNull();
  });
});

describe("regleGitDepuis : lecture d'un profil", () => {
  const lire = (d: Record<string, unknown>): { regle: unknown; avis: string[] } => {
    const avis: string[] = [];
    const avertir: Avertir = (m) => avis.push(m);
    return { regle: regleGitDepuis(d, "web", avertir), avis };
  };

  it("absente ou null : tous les dépôts, sans avertissement", () => {
    for (const d of [
      {},
      { git_access: null },
      { git_servers: null },
      { git_access: null, git_servers: null },
    ])
      expect(lire(d), JSON.stringify(d)).toEqual({ regle: { git_access: "all", git_servers: [] }, avis: [] });
  });

  it.each([["all"], ["servers"], ["accounts"]])("%s : lue telle quelle", (acces) => {
    expect(lire({ git_access: acces })).toEqual({ regle: { git_access: acces, git_servers: [] }, avis: [] });
  });

  it.each([["tous"], [""], ["ALL"], ["Servers"], [5], [true], [false], [[]], [{}]])(
    "valeur inconnue %j : serveurs listés seuls, signalé",
    (valeur) => {
      const { regle, avis } = lire({ git_access: valeur });
      expect(regle).toEqual({ git_access: "servers", git_servers: [] });
      expect(avis).toHaveLength(1);
      expect(avis[0]).toContain("profil réseau 'web'");
      expect(avis[0]).toContain("git_access");
      expect(avis[0]).toContain("illisible");
    },
  );

  it("serveurs : mis en forme, sans doublon retiré, dans l'ordre", () => {
    expect(
      lire({
        git_access: "servers",
        git_servers: ["GitHub.com/Acme", "https://git.lan:3000/", "github.com/Acme"],
      }),
    ).toEqual({
      regle: { git_access: "servers", git_servers: ["github.com/Acme", "git.lan:3000", "github.com/Acme"] },
      avis: [],
    });
  });

  it("serveurs illisibles : écartés et signalés un par un, les lisibles gardés", () => {
    const { regle, avis } = lire({
      git_access: "servers",
      git_servers: ["git.lan", "user@git.lan", "git.lan:70000", "github.com/acme"],
    });
    expect(regle).toEqual({ git_access: "servers", git_servers: ["git.lan", "github.com/acme"] });
    expect(avis).toHaveLength(2);
    expect(avis[0]).toContain("'user@git.lan'");
    expect(avis[1]).toContain("'git.lan:70000'");
    expect(avis[0]).toContain("ignoré");
  });

  it.each([["git.lan"], [5], [true], [{ a: 1 }]])(
    "git_servers qui n'est pas une liste (%j) : ignoré et signalé",
    (valeur) => {
      const { regle, avis } = lire({ git_access: "servers", git_servers: valeur });
      expect(regle).toEqual({ git_access: "servers", git_servers: [] });
      expect(avis).toHaveLength(1);
      expect(avis[0]).toContain("git_servers ignoré (une liste est attendue)");
    },
  );

  it("règle illisible sans serveur : serveurs listés seuls et aucun serveur, tout est refusé", () => {
    expect(lire({ git_access: "nimporte" }).regle).toEqual({ git_access: "servers", git_servers: [] });
  });
});

describe("profils lus depuis config.json", () => {
  it("chaque profil porte sa règle, tous les dépôts par défaut, quel que soit le mode", () => {
    const cfg = configBacDepuis({
      network_profiles: [
        { id: "isolated", name: "I", mode: "none" },
        { id: "libre", name: "L", mode: "bridge" },
        { id: "liste", name: "W", mode: "allowlist_ip", ips: ["192.0.2.1"], git_access: "accounts" },
        { id: "serveurs", name: "S", mode: "none", git_access: "servers", git_servers: ["github.com/Acme"] },
      ],
    });
    const regle = (id: string): unknown => {
      const p = profilParId(cfg, id);
      return [p.git_access, p.git_servers];
    };
    expect(regle("isolated")).toEqual(["all", []]);
    expect(regle("libre")).toEqual(["all", []]);
    expect(regle("liste")).toEqual(["accounts", []]);
    expect(regle("serveurs")).toEqual(["servers", ["github.com/Acme"]]);
  });

  it("profil de repli « isolated » et configuration vide : tous les dépôts", () => {
    for (const brut of [
      {},
      null,
      { network_profiles: [] },
      { network_profiles: [{ id: "x", name: "X", mode: "bridge" }] },
    ]) {
      const p = profilParId(configBacDepuis(brut), "isolated");
      expect([p.git_access, p.git_servers]).toEqual(["all", []]);
    }
  });

  it("profilReseauDepuis : avertissements transmis à l'appelant, profil lu sans lever", () => {
    const avis: string[] = [];
    const p = profilReseauDepuis(
      { id: "a", name: "A", mode: "bridge", git_access: "?", git_servers: ["x@y"] },
      (m) => avis.push(m),
    );
    expect([p.git_access, p.git_servers]).toEqual(["servers", []]);
    expect(avis).toHaveLength(2);
  });
});
