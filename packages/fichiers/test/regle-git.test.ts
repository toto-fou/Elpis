// SPDX-License-Identifier: MIT
/** packages/fichiers/test/regle-git.test.ts — règle Git d'un profil réseau : portées, couverture d'une URL, protections du relais (réseau local, machine), refus avant tout transfert et clone permis de bout en bout. */
import { readFileSync } from "node:fs";
import path from "node:path";

import { configBacDepuis, profilParId } from "@elpis/bac";
import type { ProfilReseau } from "@elpis/bac";
import { adresseIpOuNul, reseauPy } from "@elpis/commun";
import type { AdresseIp, Reseau } from "@elpis/commun";
import type { HoteMachine } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentClient } from "../src/agent";
import {
  gardeDepot,
  porteesDuCompte,
  protectionsDuProfil,
  regleCouvre,
  regleDuProfil,
  runNetwork,
} from "../src/git";
import type { PorteeGit, RegleGit, SourceGit } from "../src/git";
import { arreterRelais, RelayRefused } from "../src/relais-git";
import { BacTest, dossierTemporaire, PYTHON } from "./aides";
import { demarrerAmont, JETON } from "./amont-git";
import type { Amont } from "./amont-git";

const BOB = { user_id: 1, username: "bob" };
const source = (portees: PorteeGit[] | Error = []): SourceGit => ({
  gitCredential: async () => null,
  connectorHosts: async () => [],
  connectorScopes: async () => {
    if (portees instanceof Error) throw portees;
    return portees;
  },
});
const profilGit = (git_access: string, git_servers: string[] = []): ProfilReseau =>
  profilParId(
    configBacDepuis({ network_profiles: [{ id: "p", name: "P", mode: "bridge", git_access, git_servers }] }),
    "p",
  );
const servers = (...hotes: string[]): RegleGit => ({
  acces: "servers",
  portees: hotes.map((h) =>
    h.includes("/")
      ? { host: h.split("/")[0] as string, path: h.slice(h.indexOf("/") + 1) }
      : { host: h, path: "" },
  ),
});
const comptes = (...portees: PorteeGit[]): RegleGit => ({ acces: "accounts", portees });

describe("règle d'un profil", () => {
  it("tous les dépôts : sans lecture des comptes ; absente ou null aussi", async () => {
    const lire = vi.fn(async () => [] as PorteeGit[]);
    expect(await regleDuProfil(profilGit("all"), lire)).toEqual({ acces: "all" });
    expect(await regleDuProfil({ git_access: "all", git_servers: ["x.lan"] }, lire)).toEqual({
      acces: "all",
    });
    expect(lire).not.toHaveBeenCalled();
  });

  it("serveurs choisis : hôte seul ou hôte et organisation, sans lecture des comptes", async () => {
    const lire = vi.fn(async () => [] as PorteeGit[]);
    expect(await regleDuProfil(profilGit("servers", ["git.lan:3000", "github.com/acme/api"]), lire)).toEqual({
      acces: "servers",
      portees: [
        { host: "git.lan:3000", path: "" },
        { host: "github.com", path: "acme/api", exact: true },
      ],
    });
    expect(await regleDuProfil(profilGit("servers"), lire)).toEqual({ acces: "servers", portees: [] });
    expect(lire).not.toHaveBeenCalled();
  });

  it("comptes Git : portées lues une fois ; panne de la lecture : aucune portée", async () => {
    const p: PorteeGit = { host: "github.com", path: "acme", exact: false };
    const lire = vi.fn(async () => [p]);
    expect(await regleDuProfil(profilGit("accounts"), lire)).toEqual({ acces: "accounts", portees: [p] });
    expect(lire).toHaveBeenCalledTimes(1);
    expect(
      await regleDuProfil(profilGit("accounts"), async () => {
        throw new Error("core injoignable");
      }),
    ).toEqual({ acces: "accounts", portees: [] });
  });

  it("porteesDuCompte : demandées au core pour le compte signé, aucune sans compte", async () => {
    const connectorScopes = vi.fn(async () => [{ host: "git.lan", path: "" }]);
    const src: SourceGit = { ...source(), connectorScopes };
    expect(await porteesDuCompte(src, { user_id: 7.9, username: "alice" })()).toEqual([
      { host: "git.lan", path: "" },
    ]);
    expect(connectorScopes).toHaveBeenCalledWith({ user_id: 7, username: "alice" });
    for (const compte of [
      { user_id: 0, username: "alice" },
      { user_id: 7, username: "" },
    ])
      expect(await porteesDuCompte(src, compte)()).toEqual([]);
    expect(connectorScopes).toHaveBeenCalledTimes(1);
    await expect(porteesDuCompte(source(new Error("panne")), BOB)()).rejects.toThrow("panne");
  });
});

describe("regleCouvre", () => {
  it("tous les dépôts : toute URL, même illisible", () => {
    for (const u of ["https://x.example/a/b.git", "n'importe quoi", ""])
      expect(regleCouvre({ acces: "all" }, u)).toBe(true);
  });

  it("serveur entier : l'hôte, sans la casse, avec son port tel qu'écrit", () => {
    const r = servers("git.lan", "git.lan:3000");
    for (const u of [
      "https://git.lan/o/r.git",
      "https://GIT.LAN/o/r",
      "http://git.lan:3000/o/r.git",
      "https://git.lan/a/b/c/d",
    ])
      expect(regleCouvre(r, u), u).toBe(true);
    expect(regleCouvre(servers("git.lan"), "https://git.lan:443/o/r"), "443 écrit").toBe(true);
    expect(regleCouvre(servers("git.lan"), "http://git.lan:80/o/r"), "80 écrit").toBe(true);
    expect(regleCouvre(servers("git.lan:443"), "https://git.lan/o/r"), "443 choisi").toBe(true);
    expect(regleCouvre(servers("git.lan:80"), "http://GIT.lan/o/r"), "80 choisi").toBe(true);
    expect(regleCouvre(servers("git.lan:443"), "http://git.lan/o/r"), "443 choisi, HTTP").toBe(false);
    expect(regleCouvre(servers("git.lan"), "http://git.lan:443/o/r"), "HTTP sur 443").toBe(false);
    expect(regleCouvre(servers("git.lan:80"), "https://git.lan/o/r"), "80 choisi, HTTPS").toBe(false);
    for (const u of [
      "https://autre.lan/o/r.git",
      "https://git.lan:3001/o/r.git",
      "https://sous.git.lan/o/r.git",
      "https://git.lan.evil.example/o/r.git",
      "https://evilgit.lan/o/r.git",
    ])
      expect(regleCouvre(r, u), u).toBe(false);
  });

  it("portée à chemin : égal ou en dessous, frontière de segment, sans la casse", () => {
    const r = servers("github.com/acme");
    for (const u of [
      "https://github.com/acme/api.git",
      "https://github.com/Acme/API",
      "https://GITHUB.com/ACME/api/sous/dossier",
      "https://github.com/acme",
      "https://github.com/acme.git",
    ])
      expect(regleCouvre(r, u), u).toBe(true);
    for (const u of [
      "https://github.com/acme2/api.git",
      "https://github.com/acm/api.git",
      "https://github.com/autre/acme/api.git",
      "https://github.com/",
      "https://gitlab.com/acme/api.git",
    ])
      expect(regleCouvre(r, u), u).toBe(false);
  });

  it("portée à chemin plus profond : le dépôt lui-même ou ses sous-chemins", () => {
    const r = servers("github.com/acme/api");
    expect(regleCouvre(r, "https://github.com/acme/api.git")).toBe(true);
    expect(regleCouvre(r, "https://github.com/acme/api/sous")).toBe(true);
    expect(regleCouvre(r, "https://github.com/acme/api2.git")).toBe(false);
    expect(regleCouvre(r, "https://github.com/acme")).toBe(false);
  });

  it("segments non simples sous une portée à chemin : jamais couverts", () => {
    const r = servers("github.com/acme");
    for (const u of [
      "https://github.com/acme/..%2fevil",
      "https://github.com/acme/%2e%2e/x",
      "https://github.com/acme/..;/x",
      "https://github.com/acme/..%5cx",
      "https://github.com/acme/a%2fb",
      "https://github.com/acme/a%20b",
      "https://github.com/acme/a;b",
      "https://github.com/acme/é",
      "https://github.com/acme/../x",
      "https://github.com/acme/./x",
    ])
      expect(regleCouvre(r, u), u).toBe(false);
  });

  it("serveur entier : les segments non simples n'ont pas à l'être", () => {
    expect(regleCouvre(servers("git.lan"), "https://git.lan/a/..%2fb")).toBe(true);
  });

  it("casse exacte pour une portée `exact` (compte Git d'un service générique), pas pour les autres", () => {
    const exacte = comptes({ host: "git.lan", path: "Acme", exact: true });
    expect(regleCouvre(exacte, "https://git.lan/Acme/Api.git")).toBe(true);
    expect(regleCouvre(exacte, "https://GIT.lan/Acme/api")).toBe(true);
    expect(regleCouvre(exacte, "https://git.lan/acme/Api.git")).toBe(false);
    expect(regleCouvre(exacte, "https://git.lan/ACME/api.git")).toBe(false);
    const libre = comptes({ host: "git.lan", path: "Acme", exact: false });
    expect(regleCouvre(libre, "https://git.lan/acme/api.git")).toBe(true);
    expect(regleCouvre(comptes({ host: "git.lan", path: "Acme" }), "https://git.lan/ACME/x")).toBe(true);
  });

  it("une portée d'hôte entier n'est pas bornée par la casse ni par la forme du chemin", () => {
    expect(regleCouvre(comptes({ host: "git.lan", path: "", exact: true }), "https://git.lan/Z/Y.git")).toBe(
      true,
    );
  });

  it("plusieurs portées : une suffit ; aucune portée : rien n'est couvert", () => {
    const r = comptes({ host: "a.lan", path: "x" }, { host: "b.lan", path: "" });
    expect(regleCouvre(r, "https://b.lan/n'importe/quoi")).toBe(true);
    expect(regleCouvre(r, "https://a.lan/x/r")).toBe(true);
    expect(regleCouvre(r, "https://a.lan/y/r")).toBe(false);
    expect(regleCouvre(comptes(), "https://a.lan/x/r")).toBe(false);
    expect(regleCouvre(servers(), "https://a.lan/x/r")).toBe(false);
  });

  it("URL illisible, avec identifiants, requête, autre schéma : jamais couverte", () => {
    const r = servers("git.lan");
    for (const u of [
      "",
      "pas une url",
      "git://git.lan/o/r.git",
      "ssh://git@git.lan/o/r.git",
      "https://u:p@git.lan/o/r.git",
      "https://git.lan/o/r.git?x=1",
      "https://git.lan/o/r.git#f",
      "https://git.lan",
      "https://git.lan/",
    ])
      expect(regleCouvre(r, u), u).toBe(false);
  });
});

describe("gardeDepot : protections du profil", () => {
  const lue = (t: string): AdresseIp => adresseIpOuNul(t) as AdresseIp;
  const net = (t: string): Reseau => reseauPy(t) as Reseau;
  const machine = async (): Promise<HoteMachine> => ({
    adresses: [lue("192.0.2.7"), lue("172.18.0.1")],
    reseaux: [net("172.18.0.0/16")],
  });
  const garde = async (
    url: string,
    protections: { local?: boolean; machine?: boolean; metadonnees?: boolean; permis?: string[] } | undefined,
    adresses: string[] = [],
  ): Promise<string | null> =>
    (
      await gardeDepot(
        url,
        BOB,
        source(),
        async () => adresses,
        machine,
        protections && {
          local: false,
          machine: false,
          metadonnees: false,
          ...protections,
          permis: new Set(protections.permis ?? []),
        },
      )
    ).motif;

  it("sans protection : l'adresse de la machine et le réseau local sont permis, comme avant", async () => {
    expect(await garde("http://192.0.2.7:3000/o/r.git", undefined)).toBeNull();
    expect(await garde("http://10.1.2.3/o/r.git", undefined)).toBeNull();
    expect(await garde("http://git.lan/o/r.git", { local: false, machine: false }, ["10.1.2.3"])).toBeNull();
  });

  it("machine : l'adresse de la machine refusée seulement si la protection est cochée", async () => {
    expect(await garde("http://192.0.2.7:3000/o/r.git", { machine: true })).toMatch(/^blocked_ip /);
    expect(await garde("http://git.lan/o/r.git", { machine: true }, ["192.0.2.7"])).toMatch(
      /^resolves_to_blocked /,
    );
    expect(await garde("http://[::ffff:192.0.2.7]/o/r.git", { machine: true })).toMatch(/^blocked_ip /);
    expect(await garde("http://192.0.2.7:3000/o/r.git", { local: true })).toBeNull();
    expect(await garde("http://192.0.2.50/o/r.git", { machine: true })).toBeNull();
  });

  it("réseau local : privées, partagées et lien local refusées seulement si la protection est cochée", async () => {
    for (const ip of ["10.1.2.3", "172.16.5.5", "192.168.200.1", "100.64.0.9"]) {
      expect(await garde(`http://${ip}/o/r.git`, { local: true }), ip).toMatch(/^blocked_ip /);
      expect(await garde(`http://${ip}/o/r.git`, { machine: true }), ip).toBeNull();
      expect(await garde("http://git.lan/o/r.git", { local: true }, [ip]), ip).toMatch(
        /^resolves_to_blocked /,
      );
    }
    expect(await garde("http://[::ffff:10.1.2.3]/o/r.git", { local: true })).toMatch(/^blocked_ip /);
    expect(await garde("http://git.lan/o/r.git", { local: true }, ["::ffff:10.1.2.3"])).toMatch(
      /^resolves_to_blocked /,
    );
    expect(await garde("http://198.51.100.9/o/r.git", { local: true })).toBeNull();
  });

  it("hôte de `permis` : échappe aux deux protections, avec son port tel que joint", async () => {
    const permis = ["10.1.2.3:3000", "git.lan", "192.0.2.7:8080"];
    const tout = { local: true, machine: true, permis };
    expect(await garde("http://10.1.2.3:3000/o/r.git", tout)).toBeNull();
    expect(await garde("http://10.1.2.3:3001/o/r.git", tout)).toMatch(/^blocked_ip /);
    expect(await garde("http://10.1.2.3/o/r.git", tout)).toMatch(/^blocked_ip /);
    expect(await garde("http://GIT.lan/o/r.git", tout, ["10.9.9.9"])).toBeNull();
    expect(await garde("http://git.lan:3000/o/r.git", tout, ["10.9.9.9"])).toMatch(/^resolves_to_blocked /);
    expect(await garde("http://192.0.2.7:8080/o/r.git", tout)).toBeNull();
    expect(await garde("http://192.0.2.7:8081/o/r.git", tout)).toMatch(/^blocked_ip /);
    expect(await garde("http://autre.lan/o/r.git", tout, ["10.9.9.9"])).toMatch(/^resolves_to_blocked /);
    expect(await garde("http://git.lan:80/o/r.git", tout, ["10.9.9.9"])).toBeNull();
    const https = { local: true, machine: true, permis: ["git.lan:443"] };
    expect(await garde("https://git.lan/o/r.git", https, ["10.9.9.9"])).toBeNull();
    expect(await garde("http://git.lan/o/r.git", https, ["10.9.9.9"])).toMatch(/^resolves_to_blocked /);
  });

  it("métadonnées du cloud : refusées si la protection est cochée, même pour un hôte permis", async () => {
    for (const ip of ["100.100.100.200", "168.63.129.16"]) {
      expect(await garde(`http://${ip}/o/r.git`, undefined), ip).toBeNull();
      expect(await garde(`http://${ip}/o/r.git`, { metadonnees: true, permis: [ip] }), ip).toMatch(
        /^blocked_ip /,
      );
      expect(await garde("http://git.lan/o/r.git", { metadonnees: true }, [ip]), ip).toMatch(
        /^resolves_to_blocked /,
      );
    }
  });

  it("profil protégé : IPv6 refusée, un nom qui n'a que de l'IPv6 refusé, ses adresses IPv4 seules gardées", async () => {
    for (const p of [{ local: true }, { machine: true }, { metadonnees: true }]) {
      expect(await garde("http://[2001:db8::5]/o/r.git", p), JSON.stringify(p)).toMatch(/^blocked_ip /);
      expect(await garde("http://git.lan/o/r.git", p, ["2001:db8::5"])).toBe("ipv6_only");
    }
    const r = await gardeDepot(
      "http://git.lan/o/r.git",
      BOB,
      source(),
      async () => ["2001:db8::5", "198.51.100.9"],
      machine,
      { local: true, machine: false, metadonnees: false, permis: new Set() },
    );
    expect(r).toEqual({ motif: null, adresses: ["198.51.100.9"] });
    expect(await garde("http://git.lan/o/r.git", undefined, ["2001:db8::5"])).toBeNull();
  });

  it("protectionsDuProfil : profil ouvert seulement ; seuls les serveurs choisis échappent, jamais les comptes Git", () => {
    const ouvert = { mode: "bridge", block_metadata: true, block_lan: true, block_host: false } as const;
    expect(protectionsDuProfil({ ...ouvert, mode: "allowlist_ip" }, { acces: "all" })).toEqual({
      local: false,
      machine: false,
      metadonnees: false,
      permis: new Set(),
    });
    expect(
      protectionsDuProfil(ouvert, { acces: "servers", portees: [{ host: "git.lan:3000", path: "acme" }] }),
    ).toEqual({ local: true, machine: false, metadonnees: true, permis: new Set(["git.lan:3000"]) });
    expect(
      protectionsDuProfil(ouvert, { acces: "accounts", portees: [{ host: "git.lan", path: "" }] }),
    ).toEqual({
      local: true,
      machine: false,
      metadonnees: true,
      permis: new Set(),
    });
  });

  it("réseaux de conteneurs de la machine et adresses critiques : refusés même pour un hôte permis", async () => {
    const tout = {
      local: true,
      machine: true,
      permis: ["172.18.0.5", "127.0.0.1", "169.254.169.254", "git.lan", "git.lan:3000"],
    };
    expect(await garde("http://172.18.0.5/o/r.git", tout)).toMatch(/^blocked_ip /);
    expect(await garde("http://127.0.0.1/o/r.git", tout)).toMatch(/^blocked_ip /);
    expect(await garde("http://169.254.169.254/o/r.git", tout)).toMatch(/^blocked_ip /);
    expect(await garde("http://git.lan/o/r.git", tout, ["172.18.0.7"])).toMatch(/^resolves_to_blocked /);
    expect(await garde("http://git.lan/o/r.git", tout, ["127.0.0.2"])).toMatch(/^resolves_to_blocked /);
    expect(await garde("http://git.lan/o/r.git", tout, ["169.254.169.254"])).toMatch(/^resolves_to_blocked /);
    expect(await garde("http://git.lan/o/r.git", {}, ["172.18.0.7"])).toMatch(/^resolves_to_blocked /);
  });
});

describe.skipIf(!PYTHON)("runNetwork : règle Git du profil", () => {
  let racine: string;
  let nettoyer: () => void;
  let bac: BacTest;
  let agent: AgentClient;
  let amont: Amont;

  beforeEach(async () => {
    [racine, nettoyer] = dossierTemporaire("elpis-regle-git-");
    bac = new BacTest(racine);
    agent = new AgentClient(bac);
    amont = await demarrerAmont(racine);
  });
  afterEach(async () => {
    await amont.fermer();
    await bac.arreter();
    await arreterRelais();
    nettoyer();
  });

  const hote = (): string => amont.url.slice("http://".length, amont.url.indexOf("/", "http://".length));
  const clone = (src: SourceGit, extra: Record<string, unknown> = {}, url = amont.url, dest = "copie") =>
    runNetwork(agent, "", ["clone", "-q", "--", url, dest], {
      uid: 1,
      username: "bob",
      url,
      source: src,
      auth: ["u", JETON],
      garde: async () => ({ motif: null, adresses: null }),
      ...extra,
    });
  const refus = async (p: Promise<unknown>): Promise<RelayRefused> => {
    const e = await p.then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(RelayRefused);
    return e as RelayRefused;
  };

  it("tous les dépôts : le clone passe, comme sans règle", async () => {
    bac.networkProfile = profilGit("all");
    const r = await clone(source());
    expect(r.ok, r.stderr).toBe(true);
    expect(readFileSync(path.join(bac.sandboxPath, "copie", "a.txt"), "utf-8")).toBe("a\n");
  }, 30_000);

  it("serveurs choisis : le dépôt d'un serveur listé passe ; chaque requête du relais est jugée par la garde", async () => {
    bac.networkProfile = profilGit("servers", [hote()]);
    const vus: string[] = [];
    const r = await clone(source(), {
      garde: async (u: string) => {
        vus.push(u);
        return { motif: null, adresses: null };
      },
    });
    expect(r.ok, r.stderr).toBe(true);
    expect(vus.length).toBeGreaterThanOrEqual(2);
    expect(vus.every((u) => u.startsWith(amont.url.slice(0, -"/depot.git".length)))).toBe(true);
  }, 30_000);

  it("serveurs choisis : un autre serveur est refusé (git_rule) avant la garde, sans requête à l'amont", async () => {
    bac.networkProfile = profilGit("servers", ["autre.lan"]);
    const garde = vi.fn(async () => ({ motif: null, adresses: null }));
    const e = await refus(clone(source(), { garde }));
    expect([e.code, e.message]).toEqual([
      "git_rule",
      "Dépôt refusé : ce dépôt n'est pas autorisé pour votre sandbox. Demandez à votre administrateur.",
    ]);
    expect(garde).not.toHaveBeenCalled();
    expect(amont.vus).toEqual([]);
  });

  it("aucun serveur listé : tout est refusé", async () => {
    bac.networkProfile = profilGit("servers", []);
    expect((await refus(clone(source()))).code).toBe("git_rule");
  });

  it("comptes Git : un compte qui couvre le dépôt le permet ; sinon refus avec le conseil d'en ajouter un", async () => {
    bac.networkProfile = profilGit("accounts");
    const r = await clone(source([{ host: hote(), path: "depot", exact: false }]));
    expect(r.ok, r.stderr).toBe(true);
    for (const portees of [[], [{ host: hote(), path: "autre" }], [{ host: "autre.lan", path: "" }]]) {
      const e = await refus(clone(source(portees), {}, amont.url, "copie2"));
      expect([e.code, e.message]).toEqual([
        "git_rule",
        "Dépôt refusé : aucun de vos comptes Git ne couvre ce dépôt. Ajoutez-en un dans Paramètres › Secrets › Comptes Git, ou demandez à votre administrateur.",
      ]);
    }
  }, 30_000);

  it("comptes Git : le core en panne ne laisse passer rien", async () => {
    bac.networkProfile = profilGit("accounts");
    expect((await refus(clone(source(new Error("core injoignable"))))).code).toBe("git_rule");
  });

  it("URL mal formée : refusée comme telle avant la règle", async () => {
    bac.networkProfile = profilGit("servers", []);
    for (const url of [
      "https://u:p@h.lan/x.git",
      "https://h.lan/a/../b.git",
      "https://h.lan/x.git?a=1",
      "https:///x.git",
    ]) {
      const e = await refus(clone(source(), {}, url));
      expect(e.code, url).toBe("malformed_url");
    }
    expect((await refus(clone(source(), {}, "git://h.lan/x.git"))).code).toBe("scheme_not_relayed");
  });

  it("garde par défaut : protections du profil appliquées au dépôt permis", async () => {
    bac.networkProfile = profilParId(
      configBacDepuis({
        network_profiles: [
          {
            id: "p",
            name: "P",
            mode: "bridge",
            block_lan: true,
            git_access: "servers",
            git_servers: [hote()],
          },
        ],
      }),
      "p",
    );
    const e = await refus(clone(source(), { garde: undefined }));
    expect(e.code).toBe("blocked_remote");
    expect(e.message).toMatch(/^Dépôt refusé \(anti-SSRF\) : /u);
  });
});
