// SPDX-License-Identifier: MIT
/** packages/bac/test/reseau-vue.test.ts — la vue réseau de la console (frontend/src/features/admin/reseau-vue.ts) suit @elpis/bac et le script de démarrage : constantes, plages refusées, sandbox durcie, règles posées égales ligne à ligne à celles que sandbox-agent/demarrage.sh passe à de faux iptables, résolveurs (`--dns`) et noms épinglés (`--add-host`) du vrai `buildRunArgs`, pour des profils édités, enregistrés (`profilsAssainis`) puis relus comme le serveur. */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { adresseIpOuNul } from "@elpis/commun";
import type { AdresseIp } from "@elpis/commun";
import type { HoteMachine } from "@elpis/securite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { profilsAssainis } from "../../../apps/core/src/administration/executeurs";
import * as vue from "../../../frontend/src/features/admin/reseau-vue";
import type { ContexteVue, ProfilVu } from "../../../frontend/src/features/admin/reseau-vue";
import {
  PLAGES_LOCALES,
  PLAGES_METADONNEES,
  plagesRefusees,
  protectionsDe,
  releveHote,
  RESEAU_BACS,
  sandboxAdminConfigDepuis,
  UserSandbox,
} from "../src/index";
import { DNS_DE_GARDE } from "../src/reseau";
import { dossierTemporaire, FauxCli } from "./aides";

const SCRIPT = new URL("../../../sandbox-agent/demarrage.sh", import.meta.url);

const ip = (texte: string): AdresseIp => {
  const a = adresseIpOuNul(texte);
  if (a === null) throw new Error(texte);
  return a;
};
/** Machine de test : boucle, adresses de documentation (dont un doublon), IPv6, et la diffusion de la boucle que relève le noyau. */
const MACHINE: HoteMachine = {
  adresses: ["127.0.0.1", "192.0.2.10", "198.51.100.7", "192.0.2.10", "::1", "2001:db8::10"].map(ip),
  reseaux: [],
  diffusions: ["127.255.255.255", "192.0.2.255", "198.51.100.255"].map(ip),
};
const MACHINE_VUE = (() => {
  const { adresses, diffusions } = releveHote(MACHINE);
  return { addresses: adresses, broadcasts: diffusions };
})();
/** Adresses du moment des domaines, comme les sert la console : résolus, irrésoluble, sans réponse. */
const DOMAINES: Record<string, string[] | null> = {
  "api.example.com": ["192.0.2.20", "192.0.2.21"],
  "cdn.example.org": ["198.51.100.5"],
  "absent.example.net": [],
  "lent.example.net": null,
};
const contexte = (sudo = true): ContexteVue => ({
  sudo,
  machine: MACHINE_VUE,
  domaines: DOMAINES,
  etat: "charge",
});
const COMBINAISONS = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
  block_metadata: (n & 1) === 1,
  block_lan: (n & 2) === 2,
  block_host: (n & 4) === 4,
}));

let tmp: string;
let nettoyer: () => void;
let copie: string;
let journal: string;
let ruleset: string;

beforeAll(() => {
  [tmp, nettoyer] = dossierTemporaire("elpis-reseau-vue-");
  const bin = path.join(tmp, "bin");
  mkdirSync(bin);
  journal = path.join(tmp, "appels.log");
  ruleset = path.join(tmp, "restore.in");
  const inet6 = path.join(tmp, "if_inet6");
  writeFileSync(inet6, "");
  for (const nom of ["iptables", "ip6tables", "iptables-restore", "setpriv"]) {
    writeFileSync(
      path.join(bin, nom),
      `#!/bin/sh
{ printf '%s' "${nom}"; for a; do printf ' %s' "$a"; done; printf '\\n'; } >> "${journal}"
[ "${nom}" = iptables-restore ] && cat > "${ruleset}"
exit 0
`,
    );
    chmodSync(path.join(bin, nom), 0o755);
  }
  for (const outil of ["env", "tr", "cat"])
    symlinkSync(
      spawnSync("sh", ["-c", `command -v ${outil}`], { encoding: "utf8" }).stdout.trim(),
      path.join(bin, outil),
    );
  const lignes = readFileSync(SCRIPT, "utf8").split("\n");
  const i = lignes.findIndex((l) => l.startsWith("PATH=/usr/local/sbin"));
  expect(i).toBeGreaterThan(-1);
  lignes[i] = `PATH=${bin}`;
  copie = path.join(tmp, "demarrage.sh");
  writeFileSync(copie, lignes.join("\n").replaceAll("/proc/net/if_inet6", inet6));
});

afterAll(() => nettoyer());

/** Le vrai script, joué avec l'environnement donné : appels notés et entrée d'iptables-restore. */
function jouer(env: Record<string, string>): { rc: number | null; appels: string[]; regles: string[] } {
  writeFileSync(journal, "");
  writeFileSync(ruleset, "");
  const r = spawnSync("/bin/sh", [copie, "sleep", "infinity"], {
    env: { ...env, HOME: tmp },
    encoding: "utf8",
  });
  const lire = (f: string): string[] => readFileSync(f, "utf8").split("\n").filter(Boolean);
  return { rc: r.status, appels: lire(journal), regles: lire(ruleset) };
}

/** Ce qu'envoie la console pour un profil édité : champs d'interface retirés, ports vidés sous « Tous ». */
function envoye(p: ProfilVu & { name: string }): Record<string, unknown> {
  const sortie: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (!k.startsWith("_")) sortie[k] = v;
  sortie["ports"] = p._portsMode === "all" ? [] : (p.ports ?? []);
  return sortie;
}

/** Profil relu par le bac (enregistré d'abord par la console avec `enregistre`), et argv de `docker run` de sa sandbox créée maintenant. */
async function creation(p: ProfilVu & { name: string }, sudo = true, enregistre = false) {
  const avertis: string[] = [];
  const profils = enregistre ? profilsAssainis({ network_profiles: [envoye(p)] }, avertis) : [envoye(p)];
  const cfg = sandboxAdminConfigDepuis({ network_profiles: profils, allow_sudo: sudo }, () => undefined);
  const sb = new UserSandbox(1, "alice", path.join(tmp, "sb", "alice", "work"), cfg, p.id, {
    cli: new FauxCli(),
  });
  const profil = sb.networkProfile;
  const refusees = await plagesRefusees(protectionsDe(profil), () => Promise.resolve(MACHINE));
  const resolus = Object.fromEntries(
    profil.domains.flatMap((d) => (DOMAINES[d]?.length ? [[d, DOMAINES[d] ?? []]] : [])),
  ) as Record<string, string[]>;
  return { sb, profil, argv: sb.buildRunArgs(profil, resolus, refusees) };
}

/** Variables du filtre (`-e ELPIS_…`) d'un argv de `docker run`. */
function variablesFiltre(argv: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  argv.forEach((a, i) => {
    const v = argv[i + 1] ?? "";
    if (a === "-e" && v.startsWith("ELPIS_")) env[v.slice(0, v.indexOf("="))] = v.slice(v.indexOf("=") + 1);
  });
  return env;
}

/** Valeurs d'une option répétée d'un argv de `docker run` (`--dns`, `--add-host`). */
function valeurs(argv: readonly string[], option: string): string[] {
  return argv.flatMap((a, i) => (a === option ? [argv[i + 1] ?? ""] : []));
}

/** Règles de la vue et règles du vrai script, pour un même profil édité (enregistré d'abord avec `enregistre`). */
async function comparer(p: ProfilVu & { name: string }, enregistre = false) {
  const { argv } = await creation(p, true, enregistre);
  const sortie = jouer(variablesFiltre(argv));
  return { vue: vue.reglesPosees(p, contexte()), sortie, argv };
}

const liste = (champs: Partial<ProfilVu>): ProfilVu & { name: string } => ({
  id: "liste",
  name: "Liste",
  mode: "allowlist_ip",
  ips: [],
  domains: [],
  ports: [],
  dns: [],
  _portsMode: "list",
  ...champs,
});

describe("vue réseau de la console : mêmes constantes et plages que @elpis/bac", () => {
  it("plages des protections et réseau des sandboxes", () => {
    expect(vue.PLAGES_METADONNEES).toEqual(PLAGES_METADONNEES);
    expect(vue.PLAGES_LOCALES).toEqual(PLAGES_LOCALES);
    expect(vue.RESEAU_BACS).toBe(RESEAU_BACS);
    expect(vue.DNS_DE_GARDE).toBe(DNS_DE_GARDE);
  });

  it.each(COMBINAISONS)(
    "plages refusées %j : celles de plagesRefusees, relevé de la machine compris",
    async (c) => {
      const p = { id: "o", mode: "bridge", ...c };
      const reelles = await plagesRefusees(protectionsDe({ ...p }), () => Promise.resolve(MACHINE));
      expect(vue.plagesRefusees(vue.protectionsVues(p), MACHINE_VUE)).toEqual(reelles);
    },
  );

  it("protection « hôte » sans adresse de la machine hors boucle : le bac refuse de démarrer, la vue le dit", async () => {
    const boucle: HoteMachine = {
      adresses: [ip("127.0.0.1")],
      reseaux: [],
      diffusions: [ip("127.255.255.255")],
    };
    await expect(plagesRefusees(["host"], () => Promise.resolve(boucle))).rejects.toThrow(/aucune adresse/u);
    const { adresses, diffusions } = releveHote(boucle);
    expect(vue.plagesRefusees(["host"], { addresses: adresses, broadcasts: diffusions })).toBeNull();
    expect(
      vue.reglesPosees({ id: "o", mode: "bridge", block_host: true }, { ...contexte(), machine: null }),
    ).toEqual({
      genre: "machine-inconnue",
    });
  });

  it.each([true, false])("sandbox durcie (sudo permis : %s) : comme UserSandbox.durci", async (sudo) => {
    const profils: (ProfilVu & { name: string })[] = [
      { id: "isolated", name: "Isolé", mode: "none" },
      { id: "o", name: "Ouvert", mode: "bridge" },
      { id: "p", name: "Protégé", mode: "bridge", block_lan: true },
      liste({ ips: ["203.0.113.10"] }),
    ];
    for (const p of profils) {
      const { sb, profil } = await creation(p, sudo);
      expect(vue.profilDurci(p, sudo), p.id).toBe(sb.durci(profil));
    }
  });
});

describe("vue réseau de la console : règles posées égales à celles du script de démarrage", () => {
  it.each<[string, ProfilVu & { name: string }]>([
    [
      "liste blanche d'adresses et de réseaux, formes canonisées, tous ports",
      liste({
        ips: ["203.0.113.10", "198.51.100.0/24", "192.0.2.77/32", "10.20.30.40/16"],
        _portsMode: "all",
      }),
    ],
    [
      "domaines résolus, irrésoluble et sans réponse, adresse en double, ports 443 et 80",
      liste({
        ips: ["192.0.2.20"],
        domains: ["api.example.com", "cdn.example.org", "absent.example.net", "lent.example.net"],
        ports: [443, 80],
      }),
    ],
    [
      "32 ports : paquets de 15, 15 et 2 par destination",
      liste({ ips: ["203.0.113.10", "203.0.113.11"], ports: Array.from({ length: 32 }, (_, i) => 8000 + i) }),
    ],
    [
      "résolveurs : port 53 en UDP et TCP, avant les destinations",
      liste({ ips: ["203.0.113.10"], dns: ["198.51.100.53", "203.0.113.53"], ports: [443] }),
    ],
    [
      "« Tous » sous une liste de ports restée en mémoire",
      liste({ ips: ["203.0.113.10"], ports: [22], _portsMode: "all" }),
    ],
    [
      "domaines seuls, sans adresse aujourd'hui",
      liste({ domains: ["absent.example.net", "lent.example.net"] }),
    ],
  ])("%s", async (_nom, p) => {
    const { vue: r, sortie, argv } = await comparer(p);
    expect(sortie.rc).toBe(0);
    expect(valeurs(argv, "--dns")).toEqual(vue.resolveursConteneur(p));
    expect(valeurs(argv, "--add-host")).toEqual(vue.hotesEpingles(p, contexte()));
    expect(r.genre).toBe("regles");
    if (r.genre !== "regles") return;
    expect(r.ipv4).toEqual(sortie.regles);
    expect(
      sortie.appels.filter((a) => a.startsWith("ip6tables ")).map((a) => a.slice("ip6tables ".length)),
    ).toEqual(r.ipv6);
    expect(sortie.appels.slice(0, 3)).toEqual([
      "iptables -P OUTPUT DROP",
      "ip6tables -P OUTPUT DROP",
      "iptables-restore",
    ]);
    expect(r.inconnus).toEqual([]);
  });

  it("profil enregistré par la console (profilsAssainis) puis relu : mêmes règles, résolveurs et noms épinglés que la vue du profil édité", async () => {
    const p = liste({
      ips: [" 10.20.30.40/16 ", "192.0.2.77/32", "203.0.113.10"],
      domains: ["API.example.com.", "cdn.example.org", "absent.example.net"],
      ports: ["443", 80],
      dns: [" 198.51.100.53 "],
    });
    const { vue: r, sortie, argv } = await comparer(p, true);
    expect(sortie.rc).toBe(0);
    expect(r.genre === "regles" && r.ipv4).toEqual(sortie.regles);
    expect(valeurs(argv, "--dns")).toEqual(["198.51.100.53"]);
    expect(valeurs(argv, "--dns")).toEqual(vue.resolveursConteneur(p));
    expect(valeurs(argv, "--add-host")).toEqual([
      "api.example.com:192.0.2.20",
      "cdn.example.org:198.51.100.5",
    ]);
    expect(valeurs(argv, "--add-host")).toEqual(vue.hotesEpingles(p, contexte()));
    const sansResolveur = liste({ ips: ["203.0.113.10"], domains: ["cdn.example.org"] });
    const { argv: garde } = await creation(sansResolveur, true, true);
    expect(valeurs(garde, "--dns")).toEqual([DNS_DE_GARDE]);
    expect(vue.resolveursConteneur(sansResolveur)).toEqual([DNS_DE_GARDE]);
  });

  it("le cas des domaines produit bien une adresse dédoublonnée et chaque paquet de ports", async () => {
    const { vue: r } = await comparer(
      liste({ ips: ["192.0.2.20"], domains: ["api.example.com", "cdn.example.org"], ports: [443, 80] }),
    );
    expect(r.genre === "regles" && r.ipv4.filter((l) => l.includes("-d 192.0.2.20 "))).toEqual([
      "-A OUTPUT -d 192.0.2.20 -p tcp -m multiport --dports 443,80 -j ACCEPT",
    ]);
  });

  it.each(COMBINAISONS)("profil ouvert %j", async (c) => {
    const p = { id: "ouvert", name: "Ouvert", mode: "bridge", ...c };
    const { vue: r, sortie, argv } = await comparer(p);
    expect(sortie.rc).toBe(0);
    expect(argv[argv.indexOf("--network") + 1]).toBe(RESEAU_BACS);
    expect([valeurs(argv, "--dns"), valeurs(argv, "--add-host")]).toEqual([
      vue.resolveursConteneur(p),
      vue.hotesEpingles(p, contexte()),
    ]);
    if (!c.block_metadata && !c.block_lan && !c.block_host) {
      expect(r).toEqual({ genre: "sans-filtre" });
      expect(sortie.appels).toHaveLength(1);
      expect(sortie.appels[0]).toMatch(/^setpriv /u);
      return;
    }
    expect(r.genre).toBe("regles");
    if (r.genre !== "regles") return;
    expect(r.ipv4).toEqual(sortie.regles);
    expect(
      sortie.appels.filter((a) => a.startsWith("ip6tables ")).map((a) => a.slice("ip6tables ".length)),
    ).toEqual(r.ipv6);
  });

  it("profil isolé : aucune interface réseau, aucun filtre à poser", async () => {
    const p = { id: "isolated", name: "Isolé", mode: "none" };
    const { vue: r, sortie, argv } = await comparer(p);
    expect(argv[argv.indexOf("--network") + 1]).toBe("none");
    expect(r).toEqual({ genre: "sans-reseau" });
    expect(sortie.appels.map((a) => a.split(" ")[0])).toEqual(["setpriv"]);
  });
});
