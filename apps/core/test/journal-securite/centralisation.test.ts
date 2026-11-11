// SPDX-License-Identifier: MIT
/** apps/core/test/journal-securite/centralisation.test.ts — détection de l'agent syslog et de la règle Elpis : rsyslog, syslog-ng, commentaires et chaînes, `call`, fichiers piégés lus en temps borné, bornes, fichiers par défaut des distributions, lecture bornée (FIFO, périphérique, gros fichier), aucun agent. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detecterCentralisation, lireFichierBorne } from "../../src/journal-securite/centralisation";
import {
  DEBIAN_12,
  RHEL_9,
  UBUNTU_24_04,
  UBUNTU_24_04_20_UFW,
  UBUNTU_24_04_21_CLOUDINIT,
  UBUNTU_24_04_50_DEFAULT,
} from "./syslog-defauts";

let racine: string;
const ecrire = (chemin: string, texte: string): void => {
  mkdirSync(join(racine, chemin, ".."), { recursive: true });
  writeFileSync(join(racine, chemin), texte);
};
const actif = (v: boolean | null) => async () => v;
const ENVOI =
  'ruleset(name="elpis-audit") {\n  action(type="omfwd" target="10.0.0.9" port="6514" protocol="tcp")\n}\n';
/** Entrée imfile du journal reliée au ruleset d'envoi. */
const entree = (fichier = "/var/lib/elpis/audit/audit-*.jsonl"): string =>
  `input(type="imfile" File="${fichier}" Tag="elpis-audit" ruleset="elpis-audit")\n${ENVOI}`;

beforeEach(() => {
  racine = mkdtempSync(join(tmpdir(), "elpis-syslog-"));
});
afterEach(() => {
  rmSync(racine, { recursive: true, force: true });
});

describe("detecterCentralisation", () => {
  it("rsyslog : règle trouvée dans rsyslog.d par l'étiquette elpis-audit, service actif", async () => {
    ecrire("etc/rsyslog.conf", "$IncludeConfig /etc/rsyslog.d/*.conf\n");
    ecrire("etc/rsyslog.d/50-default.conf", "*.* /var/log/syslog\n");
    ecrire("etc/rsyslog.d/60-elpis.conf", entree());
    expect(await detecterCentralisation({ racine, estActif: actif(true) })).toEqual({
      agent: "rsyslog",
      actif: true,
      regle: "/etc/rsyslog.d/60-elpis.conf",
      envoi: { collecteur: "10.0.0.9:6514", transport: "TCP", file: null },
    });
  });

  it("règle commentée : absente ; dossier du journal cité : trouvée ; service arrêté remonté tel quel", async () => {
    ecrire("etc/rsyslog.conf", '# input(type="imfile" Tag="elpis-audit")\n');
    expect(await detecterCentralisation({ racine, estActif: actif(false) })).toEqual({
      agent: "rsyslog",
      actif: false,
      regle: null,
      envoi: null,
    });
    ecrire("etc/rsyslog.conf", entree("/srv/audit/audit-*.jsonl"));
    expect(
      (await detecterCentralisation({ racine, dossierAudit: "/srv/audit", estActif: actif(null) })).regle,
    ).toBe("/etc/rsyslog.conf");
  });

  it("bloc commenté, ligne d'exclusion seule, cible d'exemple, autre dossier : pas de règle", async () => {
    const cas = [
      '/* input(type="imfile" File="/var/lib/elpis/audit/a-*.jsonl" Tag="elpis-audit") */\n',
      'if $programname != "elpis-audit" then /var/log/syslog\n',
      'input(type="imfile" File="/var/lib/elpis/audit/a-*.jsonl" Tag="elpis-audit")\naction(type="omfwd" Target="collector.example.lan")\n',
      entree("/autre/audit-*.jsonl"),
      // Envoi absent : entrée sans ruleset, ruleset commenté, action commentée, ruleset qui ne fait qu'écrire un fichier.
      'input(type="imfile" File="/var/lib/elpis/audit/audit-*.jsonl" Tag="elpis-audit")\n' + ENVOI,
      entree()
        .replace("ruleset(name", "# ruleset(name")
        .replace("  action(", "#  action(")
        .replace("\n}", "\n#}"),
      entree().replace("  action(", "  # action("),
      entree().replace('action(type="omfwd"', 'action(type="omfile" file="/var/log/x"'),
    ];
    for (const texte of cas) {
      ecrire("etc/rsyslog.conf", texte);
      const e = await detecterCentralisation({
        racine,
        dossierAudit: "/var/lib/elpis/audit",
        estActif: actif(true),
      });
      expect(e.regle, texte).toBeNull();
    }
    ecrire("etc/rsyslog.conf", entree());
    expect(
      (await detecterCentralisation({ racine, dossierAudit: "/var/lib/elpis/audit/", estActif: actif(true) }))
        .regle,
    ).toBe("/etc/rsyslog.conf");
    // Envoi par un ruleset appelé (« call »), comme dans l'exemple livré, et l'exemple lui-même une fois la cible remplacée.
    ecrire(
      "etc/rsyslog.conf",
      'input(type="imfile" File="/var/lib/elpis/audit/audit-*.jsonl" Tag="elpis-audit" ruleset="a")\n' +
        'ruleset(name="a") { if $msg contains "{" then { call b } }\n' +
        'ruleset(name="b") {\n  action(type="omrelp" target="10.0.0.9")\n}\n',
    );
    expect(
      (await detecterCentralisation({ racine, dossierAudit: "/var/lib/elpis/audit", estActif: actif(true) }))
        .regle,
    ).toBe("/etc/rsyslog.conf");
    ecrire(
      "etc/rsyslog.conf",
      readFileSync(
        new URL("../../../../deploy/rsyslog/60-elpis.conf.example", import.meta.url),
        "utf8",
      ).replaceAll("collector.example.lan", "collecteur.lan"),
    );
    expect(
      (await detecterCentralisation({ racine, dossierAudit: "/var/lib/elpis/audit", estActif: actif(true) }))
        .regle,
    ).toBe("/etc/rsyslog.conf");
  });

  it("syslog-ng, puis aucun agent", async () => {
    ecrire("etc/syslog-ng/syslog-ng.conf", '@include "/etc/syslog-ng/conf.d/*.conf"\n');
    ecrire(
      "etc/syslog-ng/conf.d/elpis.conf",
      'source s_elpis { file("/var/lib/elpis/audit/x" program-override("elpis-audit")); };\n',
    );
    expect(await detecterCentralisation({ racine, estActif: actif(true) })).toMatchObject({
      agent: "syslog-ng",
      regle: "/etc/syslog-ng/conf.d/elpis.conf",
    });
    rmSync(join(racine, "etc"), { recursive: true });
    expect(await detecterCentralisation({ racine, estActif: actif(true) })).toEqual({
      agent: null,
      actif: null,
      regle: null,
      envoi: null,
    });
  });

  it("action d'envoi décrite : exemple livré (TCP + TLS, file disque), RELP + TLS par `call`, UDP par défaut", async () => {
    const exemple = readFileSync(
      new URL("../../../../deploy/rsyslog/60-elpis.conf.example", import.meta.url),
      "utf8",
    ).replaceAll("collector.example.lan", "journaux.interne.lan");
    ecrire("etc/rsyslog.conf", exemple);
    expect((await detecterCentralisation({ racine, estActif: actif(true) })).envoi).toEqual({
      collecteur: "journaux.interne.lan:6514",
      transport: "TCP + TLS (x509/name)",
      file: { type: "Disk", fichier: "elpis-audit", max_disque: "2g" },
    });
    ecrire(
      "etc/rsyslog.conf",
      'input(type="imfile" File="/var/lib/elpis/audit/audit-*.jsonl" Tag="elpis-audit" ruleset="elpis-audit")\n' +
        'ruleset(name="elpis-audit") { call envoi-relp }\n' +
        'ruleset(name="envoi-relp") {\n  action(type="omrelp" Target="10.0.0.9" Port="20514" TLS="on"\n' +
        '         tls.authMode="name" queue.type="LinkedList" queue.filename="relp")\n}\n',
    );
    expect((await detecterCentralisation({ racine, estActif: actif(true) })).envoi).toEqual({
      collecteur: "10.0.0.9:20514",
      transport: "RELP + TLS (name)",
      file: { type: "LinkedList", fichier: "relp", max_disque: null },
    });
    ecrire(
      "etc/rsyslog.conf",
      'input(type="imfile" File="/var/lib/elpis/audit/audit-*.jsonl" Tag="elpis-audit" ruleset="r")\n' +
        'ruleset(name="r") { action(type="omfwd" target="10.0.0.9" queue.type="Direct") }\n',
    );
    expect((await detecterCentralisation({ racine, estActif: actif(true) })).envoi).toEqual({
      collecteur: "10.0.0.9:514",
      transport: "UDP",
      file: null,
    });
  });
});

describe("detecterCentralisation : lecture en une passe", () => {
  const ENTREE =
    'input(type="imfile" File="/var/lib/elpis/audit/audit-*.jsonl" Tag="elpis-audit" ruleset="a")\n';
  const lire = async () =>
    detecterCentralisation({ racine, dossierAudit: "/var/lib/elpis/audit", estActif: actif(true) });
  /** `debut`, puis `motif` répété jusqu'à 256 Kio environ, puis `fin`. */
  const remplir = (debut: string, motif: string, fin = ""): string =>
    debut + motif.repeat(Math.floor((256 * 1024 - debut.length - fin.length) / motif.length)) + fin;
  /** Entrée, puis ruleset `a` qui porte `corps` et `action(params)`. */
  const regle = (params: string, corps = "", entree = ENTREE): string =>
    `${entree}ruleset(name="a") {\n${corps}  action(${params})\n}\n`;

  it("fichiers piégés de 256 Kio : lus en moins de 1 s chacun (plusieurs secondes avant), sans exception", async () => {
    const cas: [string, string, string | null][] = [
      [
        "action sans parenthèse fermante",
        remplir(ENTREE + 'ruleset(name="a"){ ', 'action( type="omfwd" '),
        null,
      ],
      [
        "paramètre de 256 Kio",
        remplir(ENTREE + 'ruleset(name="a"){ action(type="omfwd" target="c.lan" ', "a", ")}"),
        "UDP",
      ],
      ["call a en boucle", remplir(ENTREE + 'ruleset(name="a"){ ', "call a\n", "}"), null],
      ["call a sous la borne", ENTREE + 'ruleset(name="a"){ ' + "call a\n".repeat(9_000) + "}", null],
      ["commentaire non fermé", remplir("", "/*a"), null],
      ["chaîne non fermée", remplir(ENTREE + 'ruleset(name="a"){ action(type="omfwd" target="', "a"), null],
      ["ruleset( sans parenthèse", remplir("", "ruleset("), null],
      ["accolades non équilibrées", remplir(ENTREE, 'ruleset(name="a"){'), null],
      ["input( sans parenthèse", remplir("", "input("), null],
      ["objets vides", remplir(ENTREE, "x()"), null],
      ["accolades imbriquées", remplir(ENTREE + 'ruleset(name="a"){ action(type="omfwd") ', "{"), null],
    ];
    for (const [nom, texte, transport] of cas) {
      ecrire("etc/rsyslog.conf", texte);
      const debut = performance.now();
      const e = await lire();
      expect(performance.now() - debut, nom).toBeLessThan(1000);
      expect(e.envoi?.transport ?? null, nom).toBe(transport);
    }
  });

  it("bornes : à 10 000 objets, 1 000 rulesets ou 10 000 call la règle qui suit est lue, au-delà non", async () => {
    // La règle compte 3 objets (input, ruleset, action), 1 ruleset et aucun call.
    const REGLE = regle('type="omfwd" target="c.lan" port="6514"');
    const cas: [string, (n: number) => string, number][] = [
      ["objets", (n) => "x()\n".repeat(n), 10_000 - 3],
      [
        "rulesets",
        (n) => Array.from({ length: n }, (_, i) => `ruleset(name="r${i}") {}\n`).join(""),
        1_000 - 1,
      ],
      ["call", (n) => `ruleset(name="z") {\n${"call z\n".repeat(n)}}\n`, 10_000],
    ];
    for (const [nom, avant, borne] of cas) {
      ecrire("etc/rsyslog.conf", avant(borne) + REGLE);
      expect((await lire()).regle, `${nom} : à la borne`).toBe("/etc/rsyslog.conf");
      ecrire("etc/rsyslog.conf", avant(borne + 1) + REGLE);
      expect((await lire()).regle, `${nom} : au-delà`).toBeNull();
    }
  });

  it("fichiers par défaut de Debian 12, Ubuntu 24.04 et RHEL 9 : sans règle, puis exemple livré dans rsyslog.d ou ajouté", async () => {
    const exemple = readFileSync(
      new URL("../../../../deploy/rsyslog/60-elpis.conf.example", import.meta.url),
      "utf8",
    ).replaceAll("collector.example.lan", "journaux.interne.lan");
    const ubuntu = {
      "etc/rsyslog.conf": UBUNTU_24_04,
      "etc/rsyslog.d/20-ufw.conf": UBUNTU_24_04_20_UFW,
      "etc/rsyslog.d/21-cloudinit.conf": UBUNTU_24_04_21_CLOUDINIT,
      "etc/rsyslog.d/50-default.conf": UBUNTU_24_04_50_DEFAULT,
    };
    const cas: [string, Record<string, string>, string | null][] = [
      ["Debian 12", { "etc/rsyslog.conf": DEBIAN_12 }, null],
      ["Ubuntu 24.04", ubuntu, null],
      ["RHEL 9", { "etc/rsyslog.conf": RHEL_9 }, null],
      [
        "Debian 12 + 60-elpis.conf",
        { "etc/rsyslog.conf": DEBIAN_12, "etc/rsyslog.d/60-elpis.conf": exemple },
        "/etc/rsyslog.d/60-elpis.conf",
      ],
      [
        "Debian 12, règle ajoutée au fichier principal",
        { "etc/rsyslog.conf": DEBIAN_12 + exemple },
        "/etc/rsyslog.conf",
      ],
      [
        "Ubuntu 24.04 + 60-elpis.conf",
        { ...ubuntu, "etc/rsyslog.d/60-elpis.conf": exemple },
        "/etc/rsyslog.d/60-elpis.conf",
      ],
      [
        "Ubuntu 24.04, règle ajoutée à 50-default.conf",
        { ...ubuntu, "etc/rsyslog.d/50-default.conf": UBUNTU_24_04_50_DEFAULT + exemple },
        "/etc/rsyslog.d/50-default.conf",
      ],
      [
        "Ubuntu 24.04, règle ajoutée au fichier principal",
        { ...ubuntu, "etc/rsyslog.conf": UBUNTU_24_04 + exemple },
        "/etc/rsyslog.conf",
      ],
      ["RHEL 9, règle ajoutée", { "etc/rsyslog.conf": RHEL_9 + exemple }, "/etc/rsyslog.conf"],
    ];
    for (const [nom, fichiers, attendue] of cas) {
      rmSync(join(racine, "etc"), { recursive: true, force: true });
      for (const [chemin, texte] of Object.entries(fichiers)) ecrire(chemin, texte);
      const e = await lire();
      expect(e.regle, nom).toBe(attendue);
      expect(e.envoi?.collecteur ?? null, nom).toBe(attendue === null ? null : "journaux.interne.lan:6514");
    }
  });

  it("commentaires `#` en fin de ligne, `'}'`, `/*` et `#` dans les chaînes, directive ancienne : règle lue", async () => {
    const cas: [string, string, string][] = [
      [
        "commentaire après target",
        regle(
          'type="omfwd" target="c.lan" # collecteur (principal)\n' +
            '         port="6514" protocol="tcp" StreamDriverMode="1" StreamDriverAuthMode="x509/name"',
        ),
        "TCP + TLS (x509/name)",
      ],
      [
        "commentaire avant type",
        regle('name="fwd" # envoi (TLS)\n         type="omfwd" target="c.lan" port="6514" protocol="tcp"'),
        "TCP",
      ],
      [
        "accolade entre apostrophes",
        regle('type="omfwd" target="c.lan" port="6514"', "  if $msg contains '}' then stop\n"),
        "UDP",
      ],
      [
        "dièse et accolade dans une chaîne",
        regle('type="omfwd" target="c.lan" port="6514"', '  if $msg contains "# {" then stop\n'),
        "UDP",
      ],
      [
        "étoile-barre dans une chaîne après File=…/*.jsonl",
        regle(
          'type="omfwd" target="c.lan" port="6514"',
          "",
          ENTREE.replace("audit-*.jsonl", "*.jsonl") +
            'input(type="imfile" File="/var/log/elpis/*/app.jsonl" Tag="elpis-app")\n',
        ),
        "UDP",
      ],
      [
        "directive ancienne $IncludeConfig …/*.conf avant la règle",
        "$IncludeConfig /etc/rsyslog.d/*.conf\n" + regle('type="omfwd" target="c.lan" port="6514"'),
        "UDP",
      ],
    ];
    for (const [nom, texte, transport] of cas) {
      ecrire("etc/rsyslog.conf", texte);
      const e = await lire();
      expect(e.regle, nom).toBe("/etc/rsyslog.conf");
      expect(e.envoi, nom).toEqual({ collecteur: "c.lan:6514", transport, file: null });
    }
  });

  it("call : cycle a/b/a sans envoi, envoi par cycle et à 3 niveaux lu, à 4 niveaux non ; fichier mal formé sans règle", async () => {
    const nom = (i: number): string => String.fromCharCode(97 + i);
    /** `a` appelle `b`… sur `n` niveaux, le dernier ruleset envoie en RELP. */
    const chaine = (n: number): string =>
      ENTREE +
      Array.from({ length: n }, (_, i) => `ruleset(name="${nom(i)}") { call ${nom(i + 1)} }\n`).join("") +
      `ruleset(name="${nom(n)}") { action(type="omrelp" target="10.0.0.9") }\n`;
    const RELP = { collecteur: "10.0.0.9:2514", transport: "RELP", file: null };
    ecrire("etc/rsyslog.conf", ENTREE + 'ruleset(name="a") { call b }\nruleset(name="b") { call a }\n');
    expect((await lire()).regle).toBeNull();
    ecrire(
      "etc/rsyslog.conf",
      ENTREE +
        'ruleset(name="a") { call b }\nruleset(name="b") { call a\n call c }\n' +
        'ruleset(name="c") { action(type="omrelp" target="10.0.0.9") }\n',
    );
    expect((await lire()).envoi).toEqual(RELP);
    ecrire("etc/rsyslog.conf", chaine(3));
    expect((await lire()).envoi).toEqual(RELP);
    ecrire("etc/rsyslog.conf", chaine(4));
    expect((await lire()).regle).toBeNull();
    for (const casse of ["", "}", ")", "(", "{", "/*", '"', "if $msg == '"]) {
      ecrire("etc/rsyslog.conf", chaine(1) + casse);
      expect((await lire()).regle, casse).toBe(casse === "" ? "/etc/rsyslog.conf" : null);
    }
  });

  it("apostrophe hors expression et hors parenthèses : caractère de mot, le bloc commenté qui suit reste commenté", async () => {
    const REGLE = regle('type="omfwd" target="c.lan" port="6514"');
    ecrire("etc/rsyslog.conf", "*.* /var/log/it's.log\n/* disabled, it's broken\n" + REGLE + "*/\n");
    expect((await lire()).regle).toBeNull();
    ecrire("etc/rsyslog.conf", "*.* /var/log/it's.log\n" + REGLE);
    expect((await lire()).envoi?.collecteur).toBe("c.lan:6514");
    ecrire(
      "etc/syslog-ng/syslog-ng.conf",
      "@define who it's\n" +
        "source s { wildcard-file(base-dir(\"/var/lib/elpis/audit\") program-override('elpis-audit')); };\n",
    );
    rmSync(join(racine, "etc/rsyslog.conf"));
    expect((await lire()).regle).toBe("/etc/syslog-ng/syslog-ng.conf");
  });

  it("stop ou ~ non conditionnel avant l'envoi, cible absente ou vide : pas de règle ; filtres conditionnels hors périmètre", async () => {
    const FWD = 'action(type="omfwd" target="c.lan" port="6514")';
    const corps = (c: string): string => `${ENTREE}ruleset(name="a") {\n${c}\n}\n`;
    const sans = [
      corps(`  stop\n  ${FWD}`),
      corps(`  STOP ${FWD}`),
      corps(`  *.* ~\n  ${FWD}`),
      corps(`  set $!x = "y";\n  stop\n  ${FWD}`),
      corps(`  if $msg contains "x" then {\n    action(type="omfile" file="/x")\n  }\n  stop\n  ${FWD}`),
      corps(`  if $msg contains "x" then action(type="omfile" file="/x")\n  stop\n  ${FWD}`),
      corps(`  stop\n  call b\n}\nruleset(name="b") {\n  ${FWD}`),
      corps(`  action(type="omfile" file="/x") & stop\n  ${FWD}`),
      corps(`  *.* action(type="omfile" file="/x")\n  & stop\n  ${FWD}`),
      corps('  action(type="omfwd" port="6514")'),
      corps('  action(type="omfwd" target="")'),
      corps('  action(type="omrelp" Target="")'),
    ];
    for (const texte of sans) {
      ecrire("etc/rsyslog.conf", texte);
      expect((await lire()).regle, texte).toBeNull();
    }
    const avec = [
      corps(`  ${FWD}\n  stop`),
      corps(`  ${FWD} & stop`),
      corps(`  if $programname == "x" then stop\n  ${FWD}`),
      corps(`  if $programname == "x" then {\n    stop\n  }\n  ${FWD}`),
      corps(`  mail.* ~\n  ${FWD}`),
      corps(`  :msg, contains, "debug" stop\n  ${FWD}`),
      corps(`  if $msg contains "x" then action(type="omfile" file="/x") & stop\n  ${FWD}`),
      corps(`  mail.* action(type="omfile" file="/x")\n  & ~\n  ${FWD}`),
      corps(`  call b\n  stop\n}\nruleset(name="b") {\n  ${FWD}`),
    ];
    for (const texte of avec) {
      ecrire("etc/rsyslog.conf", texte);
      expect((await lire()).envoi?.collecteur, texte).toBe("c.lan:6514");
    }
    ecrire("etc/rsyslog.conf", corps('  action(type="omfwd" target=["c1.lan", "c2.lan"] port="6514")'));
    expect((await lire()).envoi?.collecteur).toBe("c1.lan, c2.lan:6514");
  });

  it("mots-clés sans casse (CALL, IF … THEN) ; ruleset défini deux fois : la première définition compte", async () => {
    const FWD = 'action(type="omfwd" target="c.lan" port="6514")';
    const REGLE = `ruleset(name="a") {\n  ${FWD}\n}\n`;
    for (const texte of [
      `${ENTREE}ruleset(name="a") { CALL f }\nruleset(name="f") { ${FWD} }\n`,
      `${ENTREE}ruleset(name="a") { Call f }\nruleset(name="f") { ${FWD} }\n`,
      `if $programname == "x" THEN stop\n$IncludeConfig /etc/rsyslog.d/*.conf\n${ENTREE}${REGLE}`,
      `${ENTREE}ruleset(name="a") {\n  IF $programname == "x" or\n     $msg contains "/*" THEN stop\n  ${FWD}\n}\n`,
      `${ENTREE}${REGLE}ruleset(name="a") {\n  action(type="omfile" file="/x")\n}\n`,
    ]) {
      ecrire("etc/rsyslog.conf", texte);
      expect((await lire()).envoi?.collecteur, texte).toBe("c.lan:6514");
    }
    for (const texte of [
      `IF $programname == "x" or\n$msg contains "y" THEN stop /*\n${ENTREE}${REGLE}*/\n`,
      `${ENTREE}ruleset(name="a") {\n  action(type="omfile" file="/x")\n}\n${REGLE}`,
    ]) {
      ecrire("etc/rsyslog.conf", texte);
      expect((await lire()).regle, texte).toBeNull();
    }
  });

  it("lecture bornée : FIFO et périphérique ignorés sans attendre, gros fichier lu sur 256 Kio", async () => {
    const REGLE = regle('type="omfwd" target="c.lan" port="6514"');
    ecrire("etc/rsyslog.conf", "*.* /var/log/syslog\n");
    ecrire("etc/rsyslog.d/60-elpis.conf", REGLE);
    execFileSync("mkfifo", [join(racine, "etc/rsyslog.d/50-fifo.conf")]);
    symlinkSync("/dev/zero", join(racine, "etc/rsyslog.d/55-zero.conf"));
    expect((await lire()).regle).toBe("/etc/rsyslog.d/60-elpis.conf");
    expect(await lireFichierBorne(join(racine, "etc/rsyslog.d/50-fifo.conf"))).toBeNull();
    expect(await lireFichierBorne(join(racine, "etc/rsyslog.d/55-zero.conf"))).toBeNull();
    expect(await lireFichierBorne(join(racine, "etc/rsyslog.d"))).toBeNull();
    expect(await lireFichierBorne(join(racine, "absent"))).toBeNull();
    ecrire("etc/rsyslog.conf", REGLE + "#" + "x".repeat(300 * 1024) + "\n");
    expect((await lireFichierBorne(join(racine, "etc/rsyslog.conf")))?.length).toBe(256 * 1024);
    expect((await lire()).regle).toBe("/etc/rsyslog.conf");
    rmSync(join(racine, "etc/rsyslog.d/60-elpis.conf"));
    ecrire("etc/rsyslog.conf", "#" + "x".repeat(256 * 1024) + "\n" + REGLE);
    expect((await lire()).regle).toBeNull();
  });

  it("syslog-ng : étiquette citée dans un commentaire de fin de ligne seulement, pas de règle", async () => {
    ecrire(
      "etc/syslog-ng/syslog-ng.conf",
      'source s_elpis { file("/var/lib/elpis/audit/x"); }; # program-override("elpis-audit")\n',
    );
    expect((await detecterCentralisation({ racine, estActif: actif(true) })).regle).toBeNull();
  });
});
