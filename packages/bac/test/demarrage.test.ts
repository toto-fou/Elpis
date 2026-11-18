// SPDX-License-Identifier: MIT
/** packages/bac/test/demarrage.test.ts — sandbox-agent/demarrage.sh joué avec `sh` sur une copie dont le PATH et le fichier IPv6 visent des faux : iptables, ip6tables, iptables-restore (stdin gardé) et setpriv notent leurs arguments. */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dossierTemporaire } from "./aides";

const SCRIPT = new URL("../../../sandbox-agent/demarrage.sh", import.meta.url);
const SETPRIV =
  "setpriv --reuid=10001 --regid=10001 --clear-groups --bounding-set=-net_admin -- /bin/sh -c " +
  'mkdir -p /work/.python-user /work/.local/bin /work/.npm-global 2>/dev/null; exec "$@" >/dev/null 2>&1 demarrage sleep infinity';
const ENTETE = [
  "*filter",
  ":INPUT ACCEPT [0:0]",
  ":FORWARD ACCEPT [0:0]",
  ":OUTPUT DROP [0:0]",
  "-A OUTPUT -o lo -j ACCEPT",
  "-A OUTPUT -m state --state RELATED,ESTABLISHED -j ACCEPT",
];
const FIN = ["-A OUTPUT -j REJECT --reject-with icmp-host-unreachable", "COMMIT"];
const V6 = [
  "ip6tables -A OUTPUT -o lo -j ACCEPT",
  "ip6tables -A OUTPUT -m state --state RELATED,ESTABLISHED -j ACCEPT",
  "ip6tables -A OUTPUT -j REJECT --reject-with icmp6-adm-prohibited",
];
const dns = (ip: string): string[] => [
  `-A OUTPUT -d ${ip} -p udp --dport 53 -j ACCEPT`,
  `-A OUTPUT -d ${ip} -p tcp --dport 53 -j ACCEPT`,
];

let tmp: string;
let nettoyer: () => void;
let copie: string;
let journal: string;
let ruleset: string;
let inet6: string;

beforeEach(() => {
  [tmp, nettoyer] = dossierTemporaire("elpis-demarrage-");
  const bin = path.join(tmp, "bin");
  mkdirSync(bin);
  journal = path.join(tmp, "appels.log");
  ruleset = path.join(tmp, "restore.in");
  inet6 = path.join(tmp, "if_inet6");
  writeFileSync(journal, "");
  writeFileSync(inet6, "");
  writeFileSync(path.join(tmp, "echec"), "");
  for (const nom of ["iptables", "ip6tables", "iptables-restore", "setpriv"]) {
    // Fichier `echec` : noms de stubs en échec, `iptables-P` pour la politique d'iptables (le script ne garde plus l'environnement).
    writeFileSync(
      path.join(bin, nom),
      `#!/bin/sh
{ printf '%s' "${nom}"; for a; do printf ' %s' "$a"; done; printf '\\n'; } >> "${journal}"
[ "${nom}" = iptables-restore ] && cat > "${ruleset}"
echec=" $(cat "${path.join(tmp, "echec")}") "
case "$echec" in *" ${nom} "*) exit 1 ;; esac
if [ "${nom}" = iptables ] && [ "\${1:-}" = -P ]; then case "$echec" in *" iptables-P "*) exit 1 ;; esac; fi
exit 0
`,
    );
    chmodSync(path.join(bin, nom), 0o755);
  }
  for (const outil of ["tr", "cat", "env"])
    symlinkSync(
      spawnSync("sh", ["-c", `command -v ${outil}`], { encoding: "utf8" }).stdout.trim(),
      path.join(bin, outil),
    );
  const lignes = readFileSync(SCRIPT, "utf8").split("\n");
  const i = lignes.findIndex((l) => l.startsWith("PATH=/usr/local/sbin"));
  expect(i).toBeGreaterThan(-1);
  lignes[i] = `PATH=${bin}`;
  copie = path.join(tmp, "demarrage.sh");
  const texte = lignes.join("\n");
  expect(texte).toContain("/proc/net/if_inet6");
  writeFileSync(copie, texte.replaceAll("/proc/net/if_inet6", inet6));
});

afterEach(() => nettoyer());

interface Sortie {
  rc: number | null;
  appels: string[];
  regles: string[];
  err: string;
}

function jouer({ STUB_ECHEC = "", ...env }: Record<string, string> = {}): Sortie {
  writeFileSync(path.join(tmp, "echec"), STUB_ECHEC);
  const r = spawnSync("/bin/sh", [copie, "sleep", "infinity"], {
    env: { ...env, HOME: tmp },
    encoding: "utf8",
  });
  let regles: string[];
  try {
    regles = readFileSync(ruleset, "utf8").split("\n").filter(Boolean);
  } catch {
    regles = [];
  }
  return {
    rc: r.status,
    appels: readFileSync(journal, "utf8").split("\n").filter(Boolean),
    regles,
    err: r.stderr,
  };
}

const liste = (env: Record<string, string>): Record<string, string> => ({
  ELPIS_NET_MODE: "allowlist",
  ...env,
});
const destinations = (regles: string[]): string[] =>
  regles.filter((l) => /^-A OUTPUT -d (?!.* --dport 53 )/u.test(l));

describe("demarrage.sh : ensemble de règles IPv4 (iptables-restore)", () => {
  it("deux destinations, sans ports : une règle chacune ; ordre des appels", () => {
    const { rc, appels, regles } = jouer(liste({ ELPIS_ALLOWLIST: "10.0.0.5 192.168.1.0/24" }));
    expect(rc).toBe(0);
    expect(regles).toEqual([
      ...ENTETE,
      "-A OUTPUT -d 10.0.0.5 -j ACCEPT",
      "-A OUTPUT -d 192.168.1.0/24 -j ACCEPT",
      ...FIN,
    ]);
    expect(appels).toEqual([
      "iptables -P OUTPUT DROP",
      "ip6tables -P OUTPUT DROP",
      "iptables-restore",
      ...V6,
      SETPRIV,
    ]);
  });

  it("32 ports : paquets de 15, 15 et 2, par destination", () => {
    const ports = Array.from({ length: 32 }, (_, i) => i + 1);
    const { rc, regles } = jouer(
      liste({ ELPIS_ALLOWLIST: "10.0.0.5 10.0.0.6", ELPIS_ALLOWLIST_PORTS: ports.join(",") }),
    );
    expect(rc).toBe(0);
    const paquets = [ports.slice(0, 15), ports.slice(15, 30), ports.slice(30)].map((p) => p.join(","));
    expect(regles).toEqual([
      ...ENTETE,
      ...["10.0.0.5", "10.0.0.6"].flatMap((ip) =>
        paquets.map((q) => `-A OUTPUT -d ${ip} -p tcp -m multiport --dports ${q} -j ACCEPT`),
      ),
      ...FIN,
    ]);
  });

  it("résolveurs seuls : 53 en UDP et TCP, aucune destination", () => {
    const { regles } = jouer(liste({ ELPIS_DNS: "9.9.9.9 1.1.1.1" }));
    expect(regles).toEqual([...ENTETE, ...dns("9.9.9.9"), ...dns("1.1.1.1"), ...FIN]);
  });

  it("liste vide : loopback, établies, REJECT seulement", () => {
    const { rc, regles, appels } = jouer(liste({ ELPIS_ALLOWLIST: "" }));
    expect(rc).toBe(0);
    expect(regles).toEqual([...ENTETE, ...FIN]);
    expect(appels.at(-1)).toBe(SETPRIV);
  });

  it("entrées ignorées de toute sorte : journalisées, jamais dans le jeu de règles", () => {
    const mauvaises = [
      "300.1.1.1",
      "1.2.3.4/33",
      "1.2.3",
      "010.0.0.1",
      "10.0.0.0/255.255.255.0",
      "*",
      "fe80::1",
      "::1/128",
      "host.lan",
      "-j",
      "1.2.3.4/8/9",
      "1.2.3.4/",
      "1.2.3.4/100",
      "1..2.3",
      "1.2.3.4.5",
      "/8",
    ];
    const { rc, regles, err } = jouer(
      liste({
        ELPIS_ALLOWLIST: ["10.0.0.5", ...mauvaises].join(" "),
        ELPIS_DNS: ["9.9.9.9", ...mauvaises].join(" "),
      }),
    );
    expect(rc).toBe(0);
    expect(regles).toEqual([...ENTETE, ...dns("9.9.9.9"), "-A OUTPUT -d 10.0.0.5 -j ACCEPT", ...FIN]);
    for (const m of mauvaises) {
      expect(err).toContain(`destination ignorée : ${m}`);
      expect(err).toContain(`résolveur ignoré : ${m}`);
    }
  });

  it("valeurs limites acceptées : 0.0.0.0/0, 255.255.255.255, /32", () => {
    const { regles } = jouer(liste({ ELPIS_ALLOWLIST: "0.0.0.0/0 255.255.255.255 1.2.3.4/32 10.0.0.0/8" }));
    expect(destinations(regles)).toEqual([
      "-A OUTPUT -d 0.0.0.0/0 -j ACCEPT",
      "-A OUTPUT -d 255.255.255.255 -j ACCEPT",
      "-A OUTPUT -d 1.2.3.4/32 -j ACCEPT",
      "-A OUTPUT -d 10.0.0.0/8 -j ACCEPT",
    ]);
  });

  it("ports 0, 70000, 443x et jeton vide ignorés, 443 et 80 gardés", () => {
    const { regles, err } = jouer(
      liste({ ELPIS_ALLOWLIST: "10.0.0.5", ELPIS_ALLOWLIST_PORTS: "0,70000,443x,,443,80,-1,123456" }),
    );
    expect(destinations(regles)).toEqual([
      "-A OUTPUT -d 10.0.0.5 -p tcp -m multiport --dports 443,80 -j ACCEPT",
    ]);
    for (const p of ["0", "70000", "443x", "-1", "123456"]) expect(err).toContain(`port ignoré : ${p}`);
  });

  it("ports demandés mais aucun valide : aucune destination, les résolveurs restent", () => {
    const { rc, regles, err } = jouer(
      liste({
        ELPIS_ALLOWLIST: "10.0.0.5 10.0.0.6",
        ELPIS_ALLOWLIST_PORTS: "0,70000,443x",
        ELPIS_DNS: "9.9.9.9",
      }),
    );
    expect(rc).toBe(0);
    expect(destinations(regles)).toEqual([]);
    expect(regles).toEqual([...ENTETE, ...dns("9.9.9.9"), ...FIN]);
    expect(err).toContain("aucun port valide : aucune destination ouverte");
  });

  it("sans mode explicite, une liste non vide vaut liste blanche", () => {
    const { rc, appels, regles } = jouer({ ELPIS_ALLOWLIST: "10.0.0.5" });
    expect(rc).toBe(0);
    expect(appels[0]).toBe("iptables -P OUTPUT DROP");
    expect(regles).toContain("-A OUTPUT -d 10.0.0.5 -j ACCEPT");
  });
});

describe("demarrage.sh : IPv6", () => {
  it("iptables-restore passe avant tout ip6tables -A ; ip6tables -P est le deuxième appel", () => {
    const { appels } = jouer(liste({ ELPIS_ALLOWLIST: "10.0.0.5" }));
    expect(appels[0]).toBe("iptables -P OUTPUT DROP");
    expect(appels[1]).toBe("ip6tables -P OUTPUT DROP");
    expect(appels.indexOf("iptables-restore")).toBeLessThan(
      appels.findIndex((a) => a.startsWith("ip6tables -A")),
    );
  });

  it("ip6tables en échec, noyau avec IPv6 : sortie 65, ni iptables-restore ni setpriv", () => {
    const { rc, appels, err } = jouer(liste({ STUB_ECHEC: "ip6tables" }));
    expect(rc).toBe(65);
    expect(appels.some((a) => a.startsWith("setpriv") || a === "iptables-restore")).toBe(false);
    expect(err).toContain("IPv6 non filtrable");
  });

  it("ip6tables en échec, noyau sans IPv6 : règles IPv4 posées, aucun autre appel ip6tables, setpriv atteint", () => {
    rmSync(inet6);
    const { rc, appels, regles } = jouer(liste({ ELPIS_ALLOWLIST: "10.0.0.5", STUB_ECHEC: "ip6tables" }));
    expect(rc).toBe(0);
    expect(regles).toContain("-A OUTPUT -d 10.0.0.5 -j ACCEPT");
    expect(appels).toEqual([
      "iptables -P OUTPUT DROP",
      "ip6tables -P OUTPUT DROP",
      "iptables-restore",
      SETPRIV,
    ]);
  });
});

describe("demarrage.sh : sans filtre, mode inconnu, échecs", () => {
  it.each<Record<string, string>>([
    { ELPIS_NET_MODE: "open" },
    {},
    { ELPIS_NET_MODE: "open", ELPIS_ALLOWLIST: "10.0.0.5" },
    { ELPIS_ALLOWLIST: "" },
  ])("%j : aucun appel de filtre, setpriv seul", (env) => {
    const { rc, appels } = jouer(env);
    expect(rc).toBe(0);
    expect(appels).toEqual([SETPRIV]);
  });

  it("mode inconnu : sortie 64, ni filtre ni setpriv", () => {
    const { rc, appels, err } = jouer({ ELPIS_NET_MODE: "autre", ELPIS_ALLOWLIST: "10.0.0.5" });
    expect(rc).toBe(64);
    expect(appels).toEqual([]);
    expect(err).toContain("mode réseau inconnu : autre");
  });

  it("iptables -P OUTPUT DROP en échec : sortie non nulle, rien d'autre, setpriv jamais atteint", () => {
    const { rc, appels } = jouer(liste({ ELPIS_ALLOWLIST: "10.0.0.5", STUB_ECHEC: "iptables-P" }));
    expect(rc).not.toBe(0);
    expect(appels).toEqual(["iptables -P OUTPUT DROP"]);
  });

  it("iptables-restore en échec : sortie non nulle, ni ip6tables -A ni setpriv", () => {
    const { rc, appels } = jouer(liste({ ELPIS_ALLOWLIST: "10.0.0.5", STUB_ECHEC: "iptables-restore" }));
    expect(rc).not.toBe(0);
    expect(appels).toEqual(["iptables -P OUTPUT DROP", "ip6tables -P OUTPUT DROP", "iptables-restore"]);
  });

  it("ip6tables -A en échec : sortie non nulle, setpriv jamais atteint", () => {
    // La politique passe (premier appel), le premier ip6tables -A échoue : un stub qui échoue seulement sur -A.
    writeFileSync(
      path.join(tmp, "bin", "ip6tables"),
      `#!/bin/sh\necho "ip6tables $*" >> "${journal}"\n[ "$1" = -A ] && exit 1\nexit 0\n`,
    );
    const { rc, appels } = jouer(liste({ ELPIS_ALLOWLIST: "10.0.0.5" }));
    expect(rc).not.toBe(0);
    expect(appels.some((a) => a.startsWith("setpriv"))).toBe(false);
  });
});

describe("demarrage.sh : étape root sous un environnement propre", () => {
  const noter = (nom: string): void => {
    writeFileSync(
      path.join(tmp, "bin", nom),
      `#!/bin/sh\necho "${nom} $*" >> "${journal}"\nenv > "${path.join(tmp, `env-${nom}`)}"\n[ "${nom}" = iptables-restore ] && cat > "${ruleset}"\nexit 0\n`,
    );
    chmodSync(path.join(tmp, "bin", nom), 0o755);
  };
  const variables = (nom: string): string[] =>
    readFileSync(path.join(tmp, `env-${nom}`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(0, l.indexOf("=")));
  const ETRANGERES = {
    XTABLES_LIBDIR: "/etranger",
    IPTABLES_LIBDIR: "/etranger",
    LD_PRELOAD: "/etranger/x.so",
    LD_LIBRARY_PATH: "/etranger",
    GCONV_PATH: "/etranger",
    MALLOC_CHECK_: "3",
    BASH_ENV: "/etranger/env",
    ENV: "/etranger/env",
    AUTRE: "1",
  };

  it("une variable étrangère n'atteint ni iptables, ni ip6tables, ni iptables-restore", () => {
    for (const nom of ["iptables", "ip6tables", "iptables-restore"]) noter(nom);
    const { rc } = jouer(liste({ ELPIS_ALLOWLIST: "10.0.0.5", ...ETRANGERES }));
    expect(rc).toBe(0);
    for (const nom of ["iptables", "ip6tables", "iptables-restore"])
      for (const v of variables(nom))
        expect(
          ["PATH", "PWD", "SHLVL", "_", "OLDPWD"].includes(v) || /^ELPIS_/u.test(v),
          `${nom} : ${v}`,
        ).toBe(true);
  });

  it("les variables du filtre passent telles quelles, y compris vides", () => {
    noter("iptables");
    jouer(
      liste({ ELPIS_ALLOWLIST: "10.0.0.5 10.0.0.6", ELPIS_ALLOWLIST_PORTS: "443", ELPIS_DNS: "9.9.9.9" }),
    );
    const env = readFileSync(path.join(tmp, "env-iptables"), "utf8").split("\n");
    expect(env).toEqual(
      expect.arrayContaining([
        "ELPIS_NET_MODE=allowlist",
        "ELPIS_ALLOWLIST=10.0.0.5 10.0.0.6",
        "ELPIS_ALLOWLIST_PORTS=443",
        "ELPIS_DNS=9.9.9.9",
      ]),
    );
  });

  it("le filtre posé est le même avec ou sans variables étrangères", () => {
    const base = jouer(liste({ ELPIS_ALLOWLIST: "10.0.0.5", ELPIS_DNS: "9.9.9.9" }));
    const avec = jouer(liste({ ELPIS_ALLOWLIST: "10.0.0.5", ELPIS_DNS: "9.9.9.9", ...ETRANGERES }));
    expect([avec.rc, avec.appels.slice(base.appels.length), avec.regles]).toEqual([
      base.rc,
      base.appels,
      base.regles,
    ]);
  });
});
