// SPDX-License-Identifier: MIT
/** apps/core/test/contexte/reseau.test.ts — capacité réseau réelle du bac dite au modèle : dérivation par mode et par règle Git, textes exacts (refus des relais, aucune adresse), même texte pour un même profil (ordre des listes, doublons). */
import { describe, expect, it } from "vitest";

import type { ProfilEffectif } from "../../src/contexte/ports";
import { capaciteReseau, texteReseau } from "../../src/contexte/reseau";

const GIT =
  "  • Git: remote operations of the git_* tools go through the host's Git relay, not the sandbox network; ";
const SHELL = ". A git command run in the shell has only the sandbox network.";
const GIT_TOUS = `${GIT}the relay allows every repository${SHELL}`;
const AUCUN =
  "  • Network: none. The shell and the browser reach nothing outside the sandbox (localhost only): every " +
  "outbound connection fails (expected, not a bug).";
const OUVERT = "  • Network: full. The shell and the browser have open network access";
const NAVIGATEUR =
  " The browser never reaches the host machine or its container networks, nor local-network hosts outside " +
  "the browser allowlist when the administrator set one.";
const REFUS = `: a connection there, or over IPv6, is refused (expected, not a bug).${NAVIGATEUR}`;
const REFUS_GIT = " The relay refuses what the sandbox network refuses";
const LISTE = "  • Network: limited. ";
const RESTE = " A connection to anything else is refused (expected, not a bug).";

const texte = (p: ProfilEffectif): string => texteReseau(capaciteReseau(p));

describe("capacité réseau du profil appliqué", () => {
  it("aucun réseau : mode none, mode inconnu ou absent ; listes et protections sans effet", () => {
    for (const p of [
      { mode: "none" },
      { mode: "autre" },
      { mode: undefined },
      { mode: "none", ips: ["10.0.0.1"], domains: ["pypi.org"], ports: [443], block_lan: true },
    ])
      expect(capaciteReseau(p), JSON.stringify(p)).toEqual({
        niveau: "none",
        git: { acces: "all" },
        filtre: false,
      });
  });

  it("liste blanche sans ports : domaines triés sans doublon, adresses et résolveurs comptés sans doublon, tous les ports ; protections sans effet", () => {
    expect(
      capaciteReseau({
        mode: "allowlist_ip",
        ips: ["192.0.2.7", "10.0.0.0/24", "192.0.2.7"],
        domains: ["pypi.org", "files.pythonhosted.org"],
        dns: ["10.0.0.54", "10.0.0.53"],
        block_metadata: true,
      }),
    ).toEqual({
      niveau: "limited",
      domaines: ["files.pythonhosted.org", "pypi.org"],
      adresses: 2,
      ports: [],
      dns: 2,
      git: { acces: "all" },
      filtre: true,
    });
  });

  it("liste blanche avec ports : ports triés par valeur, sans doublon ; liste vide : aucune destination", () => {
    expect(capaciteReseau({ mode: "allowlist_ip", ips: ["10.0.0.1"], ports: [8443, 443, 80, 443] })).toEqual({
      niveau: "limited",
      domaines: [],
      adresses: 1,
      ports: [80, 443, 8443],
      dns: 0,
      git: { acces: "all" },
      filtre: true,
    });
    expect(capaciteReseau({ mode: "allowlist_ip" })).toMatchObject({
      domaines: [],
      adresses: 0,
      ports: [],
      dns: 0,
    });
  });

  it("ouvert : chaque protection cochée refusée (métadonnées, réseau local, hôte, dans cet ordre), filtré dès une protection", () => {
    expect(capaciteReseau({ mode: "bridge", ips: ["10.0.0.1"], ports: [443] })).toEqual({
      niveau: "full",
      refus: [],
      git: { acces: "all" },
      filtre: false,
    });
    for (const [coche, refus] of [
      ["block_metadata", "metadata"],
      ["block_lan", "lan"],
      ["block_host", "host"],
    ] as const)
      expect(capaciteReseau({ mode: "bridge", [coche]: true })).toMatchObject({
        refus: [refus],
        filtre: true,
      });
    expect(
      capaciteReseau({ mode: "bridge", block_host: true, block_lan: true, block_metadata: true }),
    ).toMatchObject({ refus: ["metadata", "lan", "host"], filtre: true });
  });

  it("règle Git, quel que soit le mode : tous, serveurs choisis (triés, sans doublon ; aucun : refus), comptes Git vérifiés", () => {
    for (const mode of ["none", "allowlist_ip", "bridge"]) {
      const git = (p: Omit<ProfilEffectif, "mode">): unknown => capaciteReseau({ mode, ...p }).git;
      expect(git({})).toEqual({ acces: "all" });
      expect(git({ git_access: "all", git_servers: ["x.org"] })).toEqual({ acces: "all" });
      expect(
        git({
          git_access: "servers",
          git_servers: ["github.com/acme", "git.example.org:8443", "github.com/acme"],
        }),
      ).toEqual({ acces: "servers", serveurs: ["git.example.org:8443", "github.com/acme"] });
      expect(git({ git_access: "servers", git_servers: [] })).toEqual({ acces: "servers", serveurs: [] });
      expect(git({ git_access: "servers" })).toEqual({ acces: "servers", serveurs: [] });
      expect(git({ git_access: "accounts", git_servers: ["x.org"] })).toEqual({ acces: "accounts" });
    }
  });
});

describe("texte vu par le modèle", () => {
  it("aucun réseau : rien hors du bac, Git par le relais", () => {
    expect(texte({ mode: "none" })).toBe(`${AUCUN}\n${GIT_TOUS}`);
  });

  it("liste blanche : domaines nommés, plages d'adresses et résolveurs du shell comptés, ports (aucun : tous)", () => {
    expect(
      texte({
        mode: "allowlist_ip",
        ips: ["10.0.0.0/24", "192.0.2.7"],
        domains: ["pypi.org", "files.pythonhosted.org"],
        ports: [443, 80],
        dns: ["10.0.0.53"],
      }),
    ).toBe(
      `${LISTE}The shell and the browser reach only the domains files.pythonhosted.org, pypi.org and 2 address ` +
        `ranges set by the administrator, on TCP ports 80, 443. DNS for the shell: 1 resolver set by the ` +
        `administrator.${RESTE}\n${GIT_TOUS}`,
    );
    expect(texte({ mode: "allowlist_ip", domains: ["pypi.org"] })).toBe(
      `${LISTE}The shell and the browser reach only the domain pypi.org, on every port. No DNS resolver for the ` +
        `shell: only the listed domains resolve.${RESTE}\n${GIT_TOUS}`,
    );
    expect(
      texte({ mode: "allowlist_ip", ips: ["10.0.0.1"], ports: [443], dns: ["10.0.0.54", "10.0.0.53"] }),
    ).toBe(
      `${LISTE}The shell and the browser reach only 1 address range set by the administrator, on TCP port 443. ` +
        `DNS for the shell: 2 resolvers set by the administrator.${RESTE}\n${GIT_TOUS}`,
    );
    expect(texte({ mode: "allowlist_ip", ips: ["10.0.0.1"] })).toBe(
      `${LISTE}The shell and the browser reach only 1 address range set by the administrator, on every port. No ` +
        `DNS resolver for the shell.${RESTE}\n${GIT_TOUS}`,
    );
    expect(texte({ mode: "allowlist_ip", ports: [443] })).toBe(
      `${LISTE}No destination is listed. No DNS resolver for the shell.${RESTE}\n${GIT_TOUS}`,
    );
  });

  it("ouvert : sans protection (refus propres au navigateur), puis chaque protection cochée (IPv6 refusé, refus partagés par le relais Git), puis toutes", () => {
    const gitProtege = `${GIT}the relay allows every repository.${REFUS_GIT}${SHELL}`;
    expect(texte({ mode: "bridge" })).toBe(`${OUVERT}.${NAVIGATEUR}\n${GIT_TOUS}`);
    expect(texte({ mode: "bridge", block_metadata: true })).toBe(
      `${OUVERT}, except to cloud metadata${REFUS}\n${gitProtege}`,
    );
    expect(texte({ mode: "bridge", block_lan: true })).toBe(
      `${OUVERT}, except to the local network (private addresses)${REFUS}\n${gitProtege}`,
    );
    expect(texte({ mode: "bridge", block_host: true })).toBe(
      `${OUVERT}, except to the host machine${REFUS}\n${gitProtege}`,
    );
    expect(texte({ mode: "bridge", block_metadata: true, block_lan: true, block_host: true })).toBe(
      `${OUVERT}, except to cloud metadata, the local network (private addresses) and the host machine${REFUS}\n${gitProtege}`,
    );
  });

  it("relais Git d'un profil ouvert protégé : mêmes refus que le réseau du bac ; les serveurs choisis échappent au réseau local et à la machine hôte, jamais aux métadonnées", () => {
    const git = (p: Omit<ProfilEffectif, "mode">): string =>
      texte({ mode: "bridge", ...p }).split("\n")[1] ?? "";
    const un = { git_access: "servers" as const, git_servers: ["git.example.org"] };
    const deux = { git_access: "servers" as const, git_servers: ["git.example.org", "github.com/acme"] };
    expect(git({ ...un, block_metadata: true, block_lan: true, block_host: true })).toBe(
      `${GIT}the relay allows only this server: git.example.org.${REFUS_GIT}, except that this server may be ` +
        `on the local network or on the host machine${SHELL}`,
    );
    expect(git({ ...deux, block_lan: true })).toBe(
      `${GIT}the relay allows only these servers: git.example.org, github.com/acme.${REFUS_GIT}, except that ` +
        `these servers may be on the local network${SHELL}`,
    );
    expect(git({ ...un, block_host: true })).toBe(
      `${GIT}the relay allows only this server: git.example.org.${REFUS_GIT}, except that this server may be ` +
        `on the host machine${SHELL}`,
    );
    expect(git({ ...un, block_metadata: true })).toBe(
      `${GIT}the relay allows only this server: git.example.org.${REFUS_GIT}${SHELL}`,
    );
    expect(git({ git_access: "accounts", block_lan: true, block_host: true })).toBe(
      `${GIT}the relay allows only the repositories covered by the user's own verified Git accounts.${REFUS_GIT}${SHELL}`,
    );
    expect(git({ git_access: "servers", git_servers: [], block_lan: true })).toBe(
      `${GIT}the relay refuses every repository (no Git server is allowed)${SHELL}`,
    );
    for (const mode of ["none", "allowlist_ip"])
      expect(texte({ mode, ...un, block_metadata: true, block_lan: true, block_host: true })).not.toContain(
        REFUS_GIT,
      );
  });

  it("règle du relais Git dite à chaque niveau : tous, serveurs choisis (un, plusieurs, aucun), comptes Git vérifiés", () => {
    for (const [mode, debut] of [
      ["none", AUCUN],
      ["bridge", `${OUVERT}.${NAVIGATEUR}`],
    ] as const) {
      expect(texte({ mode, git_access: "servers", git_servers: ["github.com/acme"] })).toBe(
        `${debut}\n${GIT}the relay allows only this server: github.com/acme${SHELL}`,
      );
      expect(
        texte({ mode, git_access: "servers", git_servers: ["github.com/acme", "git.example.org:8443"] }),
      ).toBe(
        `${debut}\n${GIT}the relay allows only these servers: git.example.org:8443, github.com/acme${SHELL}`,
      );
      expect(texte({ mode, git_access: "servers", git_servers: [] })).toBe(
        `${debut}\n${GIT}the relay refuses every repository (no Git server is allowed)${SHELL}`,
      );
      expect(texte({ mode, git_access: "accounts" })).toBe(
        `${debut}\n${GIT}the relay allows only the repositories covered by the user's own verified Git accounts${SHELL}`,
      );
    }
  });

  it("même profil, listes dans un autre ordre ou en double : même texte ; une valeur changée : texte changé", () => {
    const profil: ProfilEffectif = {
      id: "profil_2",
      name: "Profil 3",
      mode: "allowlist_ip",
      ips: ["192.0.2.7", "10.0.0.0/24"],
      domains: ["pypi.org", "files.pythonhosted.org"],
      ports: [443, 80],
      dns: ["10.0.0.54", "10.0.0.53"],
      git_access: "servers",
      git_servers: ["github.com/acme", "git.example.org"],
    };
    const reference = texte(profil);
    expect(texte(profil)).toBe(reference);
    expect(reference).not.toMatch(/profil_2|Profil 3/u);
    const melange = {
      ...profil,
      ips: ["10.0.0.0/24", "192.0.2.7", "10.0.0.0/24"],
      domains: ["files.pythonhosted.org", "pypi.org"],
      ports: [80, 443, 80],
      dns: ["10.0.0.53", "10.0.0.54"],
      git_servers: ["git.example.org", "github.com/acme"],
    };
    expect(texte(melange)).toBe(reference);
    expect(texte({ ...profil, id: "autre", name: "Autre", description: "renommé" })).toBe(reference);
    expect(texte({ ...profil, ips: ["198.51.100.0/24", "10.9.9.9"], dns: ["10.1.1.1", "10.1.1.2"] })).toBe(
      reference,
    );
    expect(reference).not.toMatch(/\d+\.\d+\.\d+\.\d+/u);
    for (const change of [
      { ips: ["192.0.2.7"] },
      { domains: ["pypi.org"] },
      { ports: [443] },
      { dns: ["10.0.0.53"] },
      { git_servers: ["github.com/acme"] },
      { git_access: "accounts" as const },
      { mode: "bridge" },
    ])
      expect(texte({ ...profil, ...change }), JSON.stringify(change)).not.toBe(reference);
  });
});
