// SPDX-License-Identifier: MIT
/** packages/fichiers/test/git.test.ts — git par l'agent et relais authentifiant de bout en bout : vrai agent Python, relais TS, vrai `git http-backend` en amont ; jeton à l'hôte exact seulement. */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { createServer as serveurHttp } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentClient } from "../src/agent";
import {
  credential,
  findRepos,
  gardeDepot,
  importLegacyCredentials,
  IMPORT_GARDE,
  installerImportAncien,
  oublierAnciensVus,
  pull,
  run,
  runNetwork,
} from "../src/git";
import type { SourceGit } from "../src/git";
import {
  activesDuTicket,
  amont as amontDe,
  arreterRelais,
  autoritesGit,
  avecTicket,
  reglagesRelais,
  RelayRefused,
  UPLOAD,
} from "../src/relais-git";
import { BacTest, dossierTemporaire, PYTHON } from "./aides";
import { BASIC, demarrerAmont, git, JETON } from "./amont-git";
import type { Amont } from "./amont-git";

const libre = async (): Promise<{ motif: null; adresses: null }> => ({ motif: null, adresses: null });
const sansConnecteur: SourceGit = { gitCredential: async () => null, connectorHosts: async () => [] };
/** Compte des rappels signés au core (identifiant git). */
const BOB = { user_id: 1, username: "bob" };

let racine: string;
let nettoyer: () => void;
let bac: BacTest;
let agent: AgentClient;
let amont: Amont;
const reglages = { ...reglagesRelais };

beforeEach(async () => {
  [racine, nettoyer] = dossierTemporaire("elpis-git-");
  bac = new BacTest(racine);
  agent = new AgentClient(bac);
  amont = await demarrerAmont(racine);
  oublierAnciensVus();
});

afterEach(async () => {
  Object.assign(reglagesRelais, reglages);
  installerImportAncien(null);
  vi.unstubAllEnvs();
  await amont.fermer();
  await bac.arreter();
  await arreterRelais();
  nettoyer();
});

function reseau(extra: Partial<Parameters<typeof runNetwork>[3]> = {}) {
  return {
    uid: 1,
    username: "bob",
    url: amont.url,
    source: sansConnecteur,
    auth: ["u", JETON] as const,
    garde: libre,
    ...extra,
  };
}

/** Requête brute au socket du relais : préambule, ligne de requête, `Host`. */
function requete(nom: string, jeton: string, ligne: string): Promise<string> {
  return new Promise((fin) => {
    const s = connect(path.join(bac.relais, nom));
    let r = "";
    s.on("data", (b) => (r += b.toString("latin1")));
    s.on("error", () => fin(r));
    s.on("close", () => fin(r));
    s.write(`ELPIS-RELAY/1 ${jeton}\r\n${ligne}\r\nHost: x\r\n\r\n`);
  });
}

async function attendre(cond: () => boolean, delaiMs = 5_000): Promise<void> {
  const fin = performance.now() + delaiMs;
  while (!cond()) {
    if (performance.now() > fin) throw new Error("condition non atteinte");
    await new Promise((ok) => setTimeout(ok, 10));
  }
}

describe.skipIf(!PYTHON)("réseau par le relais", () => {
  it("clone, pull, push : identifiants saisis après le 401, refs du ticket seules, jamais de suppression", async () => {
    let r = await runNetwork(agent, "", ["clone", "-q", "--", amont.url, "copie"], reseau());
    expect(r.ok, r.stderr).toBe(true);
    expect(readFileSync(path.join(bac.sandboxPath, "copie", "a.txt"), "utf-8")).toBe("a\n");
    const conf = readFileSync(path.join(bac.sandboxPath, "copie", ".git", "config"), "utf-8");
    expect(conf).toContain(amont.url);
    expect(conf).not.toContain(JETON);
    expect(amont.vus.filter(([, , a]) => a === undefined).map(([m, p]) => [m, p])).toEqual([
      ["GET", "/depot.git/info/refs?service=git-upload-pack"],
    ]);
    expect(amont.vus.every(([, , a]) => a === undefined || a === BASIC)).toBe(true);

    writeFileSync(path.join(amont.src, "b.txt"), "b\n");
    git(amont.src, "add", "b.txt");
    git(amont.src, "commit", "-q", "-m", "b");
    git(amont.src, "push", "-q", path.join(amont.racine, "depot.git"), "main");
    r = await pull(agent, "copie", "origin", "main", "--no-rebase", {
      uid: 1,
      source: sansConnecteur,
      auth: ["u", JETON],
      garde: libre,
    });
    expect(r.ok, r.stderr).toBe(true);
    const fetchHead = readFileSync(path.join(bac.sandboxPath, "copie", ".git", "FETCH_HEAD"), "utf-8");
    expect(fetchHead).toContain(`branch 'main' of ${amont.url.slice(0, -".git".length)}\n`);
    expect(readFileSync(path.join(bac.sandboxPath, "copie", "b.txt"), "utf-8")).toBe("b\n");

    writeFileSync(path.join(bac.sandboxPath, "copie", "c.txt"), "c\n");
    expect((await run(agent, "copie", ["add", "c.txt"])).ok).toBe(true);
    expect((await run(agent, "copie", ["commit", "-q", "-m", "c"])).ok).toBe(true);
    const ok = await runNetwork(
      agent,
      "copie",
      ["push", "origin", "HEAD:refs/heads/agent/x"],
      reseau({ pushRefs: ["refs/heads/agent/x"] }),
    );
    expect(ok.ok, ok.stderr).toBe(true);
    for (const [args, motif] of [
      [["push", "origin", "HEAD:refs/heads/main"], "hors de l'opération"],
      [["push", "origin", ":refs/heads/agent/x"], "suppression"],
    ] as const) {
      const refuse = await runNetwork(agent, "copie", args, reseau({ pushRefs: ["refs/heads/agent/x"] }));
      expect(refuse.ok).toBe(false);
      expect(refuse.stderr).toContain(motif);
    }
    const refs = spawnSync("git", ["for-each-ref", "--format=%(refname)"], {
      cwd: path.join(amont.racine, "depot.git"),
      encoding: "utf-8",
    }).stdout;
    expect(refs.split(/\s+/u).filter(Boolean)).toEqual(["refs/heads/agent/x", "refs/heads/main"]);
  }, 60_000);

  it("sans identifiant : l'amont refuse, aucune requête authentifiée", async () => {
    const r = await runNetwork(
      agent,
      "",
      ["clone", "-q", "--", amont.url, "copie"],
      reseau({ auth: undefined }),
    );
    expect(r.ok).toBe(false);
    expect(amont.vus.every(([, , a]) => a === undefined)).toBe(true);
  }, 30_000);

  it("identifiant du connecteur de l'hôte EXACT : envoyé d'emblée", async () => {
    const hote = amont.url.slice("http://".length, amont.url.indexOf("/", "http://".length));
    const appels: [number, string, string][] = [];
    const source: SourceGit = {
      gitCredential: async (compte, url) => {
        appels.push([compte.user_id, compte.username, url]);
        return { username: "u", token: JETON, host: hote };
      },
      connectorHosts: async () => [hote],
    };
    const r = await runNetwork(
      agent,
      "",
      ["clone", "-q", "--", amont.url, "c2"],
      reseau({ auth: undefined, source }),
    );
    expect(r.ok, r.stderr).toBe(true);
    expect(appels).toEqual([[1, "bob", amont.url]]);
    expect(amont.vus.length).toBeGreaterThan(0);
    expect(amont.vus.every(([, , a]) => a === BASIC)).toBe(true);
    amont.vus.length = 0;
    const sansNom = await runNetwork(agent, "", ["clone", "-q", "--", amont.url, "c2b"], {
      ...reseau({ auth: undefined, source }),
      username: "",
    });
    expect(sansNom.ok).toBe(false);
    expect(appels).toHaveLength(1);
    expect(amont.vus.every(([, , a]) => a === undefined)).toBe(true);
  }, 30_000);

  it("identifiant rendu pour un AUTRE hôte (ou sans hôte, ou sans port) : jamais envoyé", async () => {
    const hote = amont.url.slice("http://".length, amont.url.indexOf("/", "http://".length));
    for (const autre of [
      "gitlab.example.com",
      "",
      "127.0.0.1",
      hote + "0",
      "localhost:" + hote.split(":")[1],
    ]) {
      const source: SourceGit = {
        gitCredential: async () => ({ username: "u", token: JETON, host: autre }),
        connectorHosts: async () => [],
      };
      expect(await credential(source, BOB, amont.url), autre).toEqual(["", ""]);
    }
    const source: SourceGit = {
      gitCredential: async () => ({ username: "u", token: JETON, host: "ailleurs.lan" }),
      connectorHosts: async () => [],
    };
    const r = await runNetwork(
      agent,
      "",
      ["clone", "-q", "--", amont.url, "c3"],
      reseau({ auth: undefined, source }),
    );
    expect(r.ok).toBe(false);
    expect(amont.vus.every(([, , a]) => a === undefined)).toBe(true);
  }, 30_000);

  it("hôte du connecteur en majuscules ou avec IPv6 : comparé à l'hôte joint, normalisé", async () => {
    const source = (host: string): SourceGit => ({
      gitCredential: async () => ({ username: "", token: "t", host }),
      connectorHosts: async () => [],
    });
    expect(
      await credential(source("git.example.lan:8443"), BOB, "https://Git.Example.LAN:8443/o/r.git"),
    ).toEqual(["", "t"]);
    expect(await credential(source("[fd00::1]:3000"), BOB, "http://[FD00::1]:3000/r.git")).toEqual(["", "t"]);
    expect(await credential(source("git.example.lan"), BOB, "https://git.example.lan:8443/o/r.git")).toEqual([
      "",
      "",
    ]);
  });

  it("garde et schémas : refus avant tout transfert", async () => {
    for (const [url, code, garde] of [
      ["git://h/x.git", "scheme_not_relayed", libre],
      ["https://u:p@h/x.git", "blocked_remote", undefined],
      ["https://h/a/../b.git", "malformed_url", libre],
      ["http://127.0.0.1:1/x.git", "blocked_remote", undefined],
    ] as const) {
      const e = await runNetwork(agent, "", ["ls-remote", url], {
        uid: 1,
        url,
        source: sansConnecteur,
        ...(garde ? { garde } : {}),
      }).then(
        () => null,
        (x: unknown) => x,
      );
      expect(e, url).toBeInstanceOf(RelayRefused);
      expect((e as RelayRefused).code, url).toBe(code);
    }
  });

  it("garde par défaut : boucle refusée même pour un hôte de connecteur enregistré (écart plus strict)", async () => {
    const hote = amont.url.slice("http://".length, amont.url.indexOf("/", "http://".length));
    const source: SourceGit = { gitCredential: async () => null, connectorHosts: async () => [hote] };
    expect((await gardeDepot(amont.url, BOB, source)).motif).toBe("blocked_ip (127.0.0.1)");
    const resoudre = async (): Promise<string[]> => ["10.1.2.3"];
    expect(await gardeDepot("http://git.lan:3000/o/r.git", BOB, sansConnecteur, resoudre)).toEqual({
      motif: null,
      adresses: ["10.1.2.3"],
    });
    expect(
      (
        await gardeDepot(
          "http://git.lan:3000/o/r.git",
          BOB,
          { ...sansConnecteur, connectorHosts: async () => ["git.lan:3000"] },
          async () => ["127.0.0.2"],
        )
      ).motif,
    ).toBe("resolves_to_blocked (127.0.0.2)");
    expect(
      (await gardeDepot("https://h.example/x.git", BOB, sansConnecteur, async () => ["169.254.169.254"]))
        .motif,
    ).toBe("resolves_to_blocked (169.254.169.254)");
  });

  it("le relais tient au ticket ; révoqué en fin d'opération ; socket 0666", async () => {
    let nom = "";
    let jeton = "";
    await avecTicket(bac.relais, { uid: 1, url: amont.url, service: UPLOAD, auth: BASIC }, async (relay) => {
      nom = relay.socket;
      jeton = relay.ticket;
      expect(JSON.stringify(relay)).not.toContain(JETON);
      expect(await requete(nom, jeton, "GET /depot.git/info/refs?service=git-upload-pack HTTP/1.1")).toMatch(
        /^HTTP\/1\.1 200/u,
      );
      for (const ligne of [
        "GET /autre.git/info/refs?service=git-upload-pack HTTP/1.1",
        "GET /depot.git/info/refs?service=git-receive-pack HTTP/1.1",
        "GET /depot.git/HEAD HTTP/1.1",
        "POST /depot.git/git-upload-pack?x=1 HTTP/1.1",
      ])
        expect(await requete(nom, jeton, ligne), ligne).toMatch(/^HTTP\/1\.1 403/u);
      expect(await requete(nom, "x".repeat(43), "GET /depot.git/info/refs HTTP/1.1")).toBe("");
    });
    expect(await requete(nom, jeton, "GET /depot.git/info/refs?service=git-upload-pack HTTP/1.1")).toBe("");
    expect(statSync(path.join(bac.relais, nom)).mode & 0o777).toBe(0o666);
    expect(nom).toBe(`${process.pid}.sock`);
  }, 30_000);

  it("connexions bornées par ticket et pour tout le relais ; préambule borné dans le temps", async () => {
    const ligne = "GET /depot.git/info/refs?service=git-upload-pack HTTP/1.1";
    await avecTicket(bac.relais, { uid: 1, url: amont.url, service: UPLOAD, auth: BASIC }, async (relay) => {
      const actives = (): number | null => activesDuTicket(relay.ticket);
      const muettes = Array.from({ length: reglagesRelais.connexionsMax }, () => {
        const s = connect(path.join(bac.relais, relay.socket));
        s.on("error", () => undefined);
        s.write(`ELPIS-RELAY/1 ${relay.ticket}\r\n`);
        return s;
      });
      await attendre(() => actives() === reglagesRelais.connexionsMax);
      expect(await requete(relay.socket, relay.ticket, ligne)).toBe("");
      for (const s of muettes) s.destroy();
      await attendre(() => actives() === 0);
      expect(await requete(relay.socket, relay.ticket, ligne)).toMatch(/^HTTP\/1\.1 200/u);

      reglagesRelais.preambuleS = 0.3;
      const debut = performance.now();
      const muette = connect(path.join(bac.relais, relay.socket));
      await new Promise((fin) => muette.on("close", fin));
      expect(performance.now() - debut).toBeLessThan(3_000);
      reglagesRelais.preambuleS = 5;
      reglagesRelais.connexionsServeur = 3;
      const ouvertes = Array.from({ length: 3 }, () => {
        const s = connect(path.join(bac.relais, relay.socket));
        s.on("error", () => undefined);
        return s;
      });
      await Promise.all(ouvertes.map((s) => new Promise((ok) => s.once("connect", ok))));
      await new Promise((ok) => setTimeout(ok, 100));
      const deTrop = connect(path.join(bac.relais, relay.socket));
      deTrop.on("error", () => undefined);
      let recu = "";
      deTrop.on("data", (b) => (recu += String(b)));
      await new Promise((fin) => deTrop.on("close", fin));
      expect(recu).toBe("");
      for (const s of ouvertes) s.destroy();
      reglagesRelais.connexionsServeur = 64;
      await new Promise((ok) => setTimeout(ok, 100));
      expect(await requete(relay.socket, relay.ticket, ligne)).toMatch(/^HTTP\/1\.1 200/u);
    });
  }, 30_000);

  it("une seule requête par connexion : les requêtes enchaînées n'atteignent pas l'amont", async () => {
    const ligne = "GET /depot.git/info/refs?service=git-upload-pack HTTP/1.1\r\nHost: x\r\n\r\n";
    await avecTicket(bac.relais, { uid: 1, url: amont.url, service: UPLOAD, auth: BASIC }, async (relay) => {
      const recu = await new Promise<string>((fin) => {
        const s = connect(path.join(bac.relais, relay.socket));
        let r = "";
        s.on("data", (b) => (r += b.toString("latin1")));
        s.on("error", () => fin(r));
        s.on("close", () => fin(r));
        s.write(`ELPIS-RELAY/1 ${relay.ticket}\r\n` + ligne.repeat(20));
      });
      expect(recu).toMatch(/^HTTP\/1\.1 200/u);
      expect(amont.vus).toHaveLength(1);
    });
  }, 30_000);

  it("git parti en pleine réponse : la requête à l'amont est close, aucun refus noté", async () => {
    let fermee = false;
    let ecrits = 0;
    const gros = serveurHttp((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-advertisement" });
      const bloc = Buffer.alloc(1 << 16, 0x61);
      const pousser = (): void => {
        while (!fermee && ecrits < 512 << 20) {
          ecrits += bloc.length;
          if (!res.write(bloc)) return void res.once("drain", pousser);
        }
      };
      res.on("close", () => (fermee = true));
      pousser();
    });
    await new Promise<void>((ok) => gros.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(gros.address() as AddressInfo).port}/depot.git`;
    try {
      await avecTicket(bac.relais, { uid: 1, url, service: UPLOAD }, async (relay, refus) => {
        const s = connect(path.join(bac.relais, relay.socket));
        s.on("error", () => undefined);
        await new Promise<void>((ok) => {
          s.once("data", () => ok());
          s.write(
            `ELPIS-RELAY/1 ${relay.ticket}\r\nGET /depot.git/info/refs?service=git-upload-pack HTTP/1.1\r\nHost: x\r\n\r\n`,
          );
        });
        s.pause();
        await new Promise((ok) => setTimeout(ok, 200));
        s.destroy();
        await attendre(() => fermee, 10_000);
        await attendre(() => activesDuTicket(relay.ticket) === 0);
        expect(refus).toEqual([]);
        expect(ecrits).toBeLessThan(512 << 20);
      });
    } finally {
      gros.closeAllConnections();
      await new Promise((ok) => gros.close(ok));
    }
  }, 30_000);

  it("hôte que WHATWG lirait autrement (IP déguisée) : refusé avant tout transfert", () => {
    for (const url of ["http://127.0.0.%31/x.git", "http://0x7f.1/x.git", "http://h%2e/x.git"])
      expect(() => amontDe(url), url).toThrow(RelayRefused);
    expect(amontDe("https://Bücher.example/o/r.git")[0]).toBe("https://bücher.example");
    expect(amontDe("http://h:0/r")[0]).toBe("http://h");
  });

  it("GIT_SSL_CAINFO au format TRUSTED CERTIFICATE : le certificat est retenu", () => {
    const cle = path.join(racine, "ca.key");
    const ca = path.join(racine, "ca.pem");
    const confiance = path.join(racine, "ca-trusted.pem");
    spawnSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      cle,
      "-out",
      ca,
      "-subj",
      "/CN=elpis-test-ca",
      "-days",
      "2",
    ]);
    spawnSync("openssl", ["x509", "-in", ca, "-addtrust", "serverAuth", "-out", confiance]);
    expect(readFileSync(confiance, "utf-8")).toContain("BEGIN TRUSTED CERTIFICATE");
    vi.stubEnv("GIT_SSL_CAINFO", confiance);
    const empreinte = new X509Certificate(readFileSync(ca)).fingerprint256;
    expect(autoritesGit().some((p) => new X509Certificate(p).fingerprint256 === empreinte)).toBe(true);
  });

  it("redirection de l'amont refusée, l'URL à corriger", async () => {
    const srv = serveurHttp((_req, res) => {
      res.writeHead(301, { Location: "https://ailleurs.lan/depot.git/info/refs?x=1", "Content-Length": "0" });
      res.end();
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    try {
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/depot.git`;
      const r = await runNetwork(agent, "", ["clone", "-q", "--", url, "c4"], reseau({ url }));
      expect(r.ok).toBe(false);
      expect(
        r.refus.some((m) => m.includes("redirige (301 vers https://ailleurs.lan/depot.git)")),
        r.refus.join("|"),
      ).toBe(true);
    } finally {
      srv.closeAllConnections();
      await new Promise((ok) => srv.close(ok));
    }
  }, 30_000);

  it("GIT_SSL_CAINFO illisible : message du relais, amont jamais joint", async () => {
    vi.stubEnv("GIT_SSL_CAINFO", "/nulle/part/ca.pem");
    const r = await runNetwork(agent, "", ["clone", "-q", "--", amont.url, "c5"], reseau());
    expect(r.ok).toBe(false);
    expect(r.refus).toContain(
      "Relais Git : autorité de certification illisible (GIT_SSL_CAINFO / GIT_SSL_CAPATH : FileNotFoundError)",
    );
    expect(amont.vus).toEqual([]);
  }, 30_000);

  it("amont injoignable : motif du relais dans stderr", async () => {
    const url = "http://127.0.0.1:1/depot.git";
    const r = await runNetwork(agent, "", ["ls-remote", url], reseau({ url }));
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("Relais Git : amont injoignable (ConnectError)");
  }, 30_000);
});

describe.skipIf(!PYTHON)("dépôts, pull local, anciens identifiants", () => {
  it("find_repos : dépôts sous /work, un dépôt dans un dépôt écarté, triés", async () => {
    for (const d of ["b", "a/x", "a/x/sous", "node_modules/m"]) {
      const p = path.join(bac.sandboxPath, d);
      spawnSync("git", ["init", "-q", p]);
    }
    expect(await findRepos(agent)).toEqual(["a/x", "b"]);
  });

  it("pull d'une branche qui suit une branche locale (remote « . ») : fusion seule, sans réseau", async () => {
    const p = path.join(bac.sandboxPath, "p");
    spawnSync("git", ["init", "-q", "-b", "main", p]);
    expect((await run(agent, "p", ["commit", "-q", "--allow-empty", "-m", "1"])).ok).toBe(true);
    expect((await run(agent, "p", ["branch", "dev"])).ok).toBe(true);
    expect((await run(agent, "p", ["commit", "-q", "--allow-empty", "-m", "2"])).ok).toBe(true);
    expect((await run(agent, "p", ["checkout", "-q", "dev"])).ok).toBe(true);
    expect((await run(agent, "p", ["branch", "-q", "-u", "main"])).ok).toBe(true);
    const r = await pull(agent, "p", ".", "", "--ff-only", { uid: 1, source: sansConnecteur });
    expect(r.ok, r.stderr).toBe(true);
    expect(amont.vus).toEqual([]);
    expect((await run(agent, "p", ["rev-parse", "HEAD"])).stdout).toBe(
      (await run(agent, "p", ["rev-parse", "main"])).stdout,
    );
    await expect(pull(agent, "p", ".", "", "--squash", { uid: 1, source: sansConnecteur })).rejects.toThrow(
      "mode non pris en charge",
    );
  });

  it("ancien .git-credentials.json : rien touché sans nom de compte, gardé sans import possible, importé puis supprimé sinon ; trace .imported retirée", async () => {
    writeFileSync(path.join(bac.sandboxPath, ".git-credentials.json"), '{"github": {"token": "t"}}');
    writeFileSync(path.join(bac.sandboxPath, ".git-credentials.json.imported"), "ancien");
    await importLegacyCredentials(agent, 3);
    expect(statSync(path.join(bac.sandboxPath, ".git-credentials.json.imported")).isFile()).toBe(true);
    await importLegacyCredentials(agent, 3, "carol");
    expect(statSync(path.join(bac.sandboxPath, ".git-credentials.json")).isFile()).toBe(true);
    expect(() => statSync(path.join(bac.sandboxPath, ".git-credentials.json.imported"))).toThrow();
    const recus: [unknown, string][] = [];
    installerImportAncien(async (compte, d: Buffer) => {
      recus.push([compte, d.toString()]);
      return 1;
    });
    await importLegacyCredentials(agent, 3, "carol");
    expect(recus).toEqual([[{ user_id: 3, username: "carol" }, '{"github": {"token": "t"}}']]);
    expect(() => statSync(path.join(bac.sandboxPath, ".git-credentials.json"))).toThrow();
    await importLegacyCredentials(agent, 3);
    expect(recus).toHaveLength(1);
    writeFileSync(
      path.join(bac.sandboxPath, ".git-credentials.json"),
      '{"gitea": {"token": "t", "url": "https://x.lan"}}',
    );
    installerImportAncien(async (compte, d: Buffer) => {
      recus.push([compte, d.toString()]);
      return IMPORT_GARDE;
    });
    for (let i = 0; i < 2; i++) await importLegacyCredentials(agent, 4, "dave");
    expect(recus).toHaveLength(2);
    expect(statSync(path.join(bac.sandboxPath, ".git-credentials.json")).isFile()).toBe(true);
  });

  it("source des connecteurs en panne : aucun identifiant, aucun hôte permis", async () => {
    const panne: SourceGit = {
      gitCredential: async (): Promise<Dict | null> => {
        throw new Error("core injoignable");
      },
      connectorHosts: async () => {
        throw new Error("core injoignable");
      },
    };
    expect(await credential(panne, BOB, amont.url)).toEqual(["", ""]);
    expect((await gardeDepot("http://10.0.0.1/x.git", BOB, panne)).motif).toBeNull();
  });
});
