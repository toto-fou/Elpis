// SPDX-License-Identifier: MIT
/** apps/core/test/contexte/reseau.test.ts — capacité réseau réelle du bac dite au modèle : dérivation par mode et par règle Git, textes exacts, même texte pour un même profil (ordre des listes, doublons). */
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
const REFUS = ": a connection there is refused (expected, not a bug).";
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

  it("liste blanche sans ports : domaines, adresses et résolveurs triés sans doublon, tous les ports ; protections sans effet", () => {
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
      adresses: ["10.0.0.0/24", "192.0.2.7"],
      ports: [],
      dns: ["10.0.0.53", "10.0.0.54"],
      git: { acces: "all" },
      filtre: true,
    });
  });

  it("liste blanche avec ports : ports triés par valeur, sans doublon ; liste vide : aucune destination", () => {
    expect(capaciteReseau({ mode: "allowlist_ip", ips: ["10.0.0.1"], ports: [8443, 443, 80, 443] })).toEqual({
      niveau: "limited",
      domaines: [],
      adresses: ["10.0.0.1"],
      ports: [80, 443, 8443],
      dns: [],
      git: { acces: "all" },
      filtre: true,
    });
    expect(capaciteReseau({ mode: "allowlist_ip" })).toMatchObject({ domaines: [], adresses: [], ports: [] });
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

  it("liste blanche : destinations, ports (aucun : tous), résolveurs (aucun : seuls les domaines listés)", () => {
    expect(
      texte({
        mode: "allowlist_ip",
        ips: ["10.0.0.0/24", "192.0.2.7"],
        domains: ["pypi.org", "files.pythonhosted.org"],
        ports: [443, 80],
        dns: ["10.0.0.53"],
      }),
    ).toBe(
      `${LISTE}The shell and the browser reach only the domains files.pythonhosted.org, pypi.org and the addresses ` +
        `10.0.0.0/24, 192.0.2.7, on TCP ports 80, 443. DNS resolver: 10.0.0.53.${RESTE}\n${GIT_TOUS}`,
    );
    expect(texte({ mode: "allowlist_ip", domains: ["pypi.org"] })).toBe(
      `${LISTE}The shell and the browser reach only the domain pypi.org, on every port. No DNS resolver: only the ` +
        `listed domains resolve.${RESTE}\n${GIT_TOUS}`,
    );
    expect(
      texte({ mode: "allowlist_ip", ips: ["10.0.0.1"], ports: [443], dns: ["10.0.0.54", "10.0.0.53"] }),
    ).toBe(
      `${LISTE}The shell and the browser reach only the address 10.0.0.1, on TCP port 443. DNS resolvers: ` +
        `10.0.0.53, 10.0.0.54.${RESTE}\n${GIT_TOUS}`,
    );
    expect(texte({ mode: "allowlist_ip", ips: ["10.0.0.1"] })).toBe(
      `${LISTE}The shell and the browser reach only the address 10.0.0.1, on every port. No DNS resolver.${RESTE}\n${GIT_TOUS}`,
    );
    expect(texte({ mode: "allowlist_ip", ports: [443] })).toBe(
      `${LISTE}No destination is listed. No DNS resolver.${RESTE}\n${GIT_TOUS}`,
    );
  });

  it("ouvert : sans protection, puis chaque protection cochée, puis toutes", () => {
    expect(texte({ mode: "bridge" })).toBe(`${OUVERT}.\n${GIT_TOUS}`);
    expect(texte({ mode: "bridge", block_metadata: true })).toBe(
      `${OUVERT}, except to cloud metadata${REFUS}\n${GIT_TOUS}`,
    );
    expect(texte({ mode: "bridge", block_lan: true })).toBe(
      `${OUVERT}, except to the local network (private addresses)${REFUS}\n${GIT_TOUS}`,
    );
    expect(texte({ mode: "bridge", block_host: true })).toBe(
      `${OUVERT}, except to the host machine${REFUS}\n${GIT_TOUS}`,
    );
    expect(texte({ mode: "bridge", block_metadata: true, block_lan: true, block_host: true })).toBe(
      `${OUVERT}, except to cloud metadata, the local network (private addresses) and the host machine${REFUS}\n${GIT_TOUS}`,
    );
  });

  it("règle du relais Git dite à chaque niveau : tous, serveurs choisis (un, plusieurs, aucun), comptes Git vérifiés", () => {
    for (const [mode, debut] of [
      ["none", AUCUN],
      ["bridge", `${OUVERT}.`],
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
