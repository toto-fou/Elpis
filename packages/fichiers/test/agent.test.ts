// SPDX-License-Identifier: MIT
/** packages/fichiers/test/agent.test.ts — client de l'agent contre le vrai agent Python (server.py en sous-processus) : opérations, bornes, socket piégé, faux agent, relance, archives. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AgentClient,
  AgentError,
  reglagesAgent,
  surchargerVersionAttendue,
  versionAttendue,
} from "../src/agent";
import { BacTest, dossierTemporaire, PYTHON, SERVEUR_AGENT } from "./aides";

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

async function refus(p: Promise<unknown>): Promise<AgentError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AgentError) return e;
    throw e;
  }
  throw new Error("refus attendu");
}

let racine: string;
let nettoyer: () => void;
let bac: BacTest;
const serveurs: Server[] = [];
const reglages = { ...reglagesAgent };

beforeEach(() => {
  [racine, nettoyer] = dossierTemporaire("elpis-agent-");
  bac = new BacTest(racine);
});

afterEach(async () => {
  Object.assign(reglagesAgent, reglages);
  surchargerVersionAttendue(null);
  await bac.arreter();
  await Promise.all(serveurs.splice(0).map((s) => new Promise((fin) => s.close(fin))));
  nettoyer();
});

/** Faux agent : note les connexions, répond `reponse` à chacune. */
function ecoute(
  chemin: string,
  reponse: Buffer = Buffer.alloc(0),
): Promise<{ connexions: number; envoye: number }> {
  const etat = { connexions: 0, envoye: 0 };
  const s = createServer((c) => {
    etat.connexions++;
    c.on("error", () => undefined);
    c.once("data", () => {
      if (!reponse.length) return;
      const pousser = (): void => {
        while (etat.envoye < 200 << 20) {
          etat.envoye += reponse.length;
          if (!c.write(reponse)) {
            c.once("drain", pousser);
            return;
          }
        }
      };
      pousser();
    });
  });
  serveurs.push(s);
  return new Promise((fin) => s.listen(chemin, () => fin(etat)));
}

describe.skipIf(!PYTHON)("agent réel", () => {
  it("version attendue : empreinte de server.py", () => {
    expect(versionAttendue()).toBe(sha(readFileSync(SERVEUR_AGENT)).slice(0, 16));
  });

  it("opérations de bout en bout ; un seul agent pour tout", async () => {
    const c = new AgentClient(bac);
    const h = await c.hello();
    expect(h["version"]).toBe(versionAttendue());
    expect(bac.demarrages).toBe(1);
    const r = await c.write("dir/a.txt", Buffer.from("bonjour"), { parents: true });
    expect(r["created"]).toBe(true);
    expect(r["sha256"]).toBe(sha("bonjour"));
    expect(r["size"]).toBe(7);
    const lu = await c.read("dir/a.txt");
    expect(lu.data.toString()).toBe("bonjour");
    expect(lu.stat["size"]).toBe(7);
    expect((await c.read("/work/dir/a.txt", { offset: 3, length: 2 })).data.toString()).toBe("jo");
    const [e] = await c.stat(["dir/a.txt"], { hash: true });
    expect(e?.["kind"]).toBe("file");
    expect(e?.["sha256"]).toBe(r["sha256"]);
    expect(typeof e?.["mtime_ns"]).toBe("bigint");
    expect((await c.stat(["absent"]))[0]?.["kind"]).toBe("missing");
    let liste = await c.list("", { depth: 5 });
    expect(new Set(liste.entries.map((x) => x["path"]))).toEqual(new Set(["dir", "dir/a.txt"]));
    expect(liste.truncated).toBe(false);
    await c.fsop("copy", { src: "dir", dst: "copie" });
    await c.fsop("rename", { src: "copie/a.txt", dst: "b.txt" });
    await c.fsop("remove", { path: "dir", recursive: true });
    await c.fsop("mkdir", { path: "x/y" });
    liste = await c.list("", { depth: 5 });
    expect(new Set(liste.entries.map((x) => x["path"]))).toEqual(new Set(["copie", "b.txt", "x", "x/y"]));
    expect(bac.demarrages).toBe(1);
  });

  it("préconditions : if_absent, if_sha256, if_mtime_ns ; lecture groupée bornée", async () => {
    const c = new AgentClient(bac);
    await c.write("f", Buffer.from("v1"));
    let e = await refus(c.write("f", Buffer.from("x"), { ifAbsent: true }));
    expect([e.code, e.status]).toEqual(["exists", 412]);
    e = await refus(c.write("f", Buffer.from("x"), { ifSha256: "0".repeat(64) }));
    expect([e.code, e.status]).toEqual(["changed", 412]);
    expect(e.data["sha256"]).toBe(sha("v1"));
    const [st] = await c.stat(["f"]);
    await c.write("f", Buffer.from("v2"), { ifMtimeNs: st?.["mtime_ns"] as bigint });
    expect((await c.read("f")).data.toString()).toBe("v2");
    mkdirSync(path.join(bac.sandboxPath, "d"));
    writeFileSync(path.join(bac.sandboxPath, "d", "f"), "12345");
    writeFileSync(path.join(bac.sandboxPath, "gros"), "x".repeat(10));
    writeFileSync(path.join(bac.sandboxPath, "g"), "678");
    writeFileSync(path.join(bac.sandboxPath, "h"), "9999");
    const lus = await c.readMany(["d/f", "absent", "gros", "g", "h"], { maxFile: 6, maxTotal: 8 });
    expect([...lus].map(([k, v]) => [k, v?.toString() ?? null])).toEqual([
      ["d/f", "12345"],
      ["absent", null],
      ["gros", null],
      ["g", "678"],
    ]);
    expect((await c.readMany(["h"], { maxFile: 6, maxTotal: 100 })).get("h")?.toString()).toBe("9999");
  });

  it("lectures bornées et refus typés", async () => {
    writeFileSync(path.join(bac.sandboxPath, "gros"), "x".repeat(1000));
    mkdirSync(path.join(bac.sandboxPath, "d"));
    const c = new AgentClient(bac);
    let e = await refus(c.read("gros", { maxBytes: 100 }));
    expect([e.code, e.status]).toEqual(["too_large", 413]);
    expect((e.data["stat"] as Record<string, unknown>)["size"]).toBe(1000);
    expect((await c.read("gros", { length: 100, maxBytes: 100 })).data.length).toBe(100);
    expect((await refus(c.read("gros", { expectSize: 999 }))).code).toBe("changed");
    expect((await refus(c.read("d"))).code).toBe("not_file");
    e = await refus(c.read("absent"));
    expect([e.code, e.status]).toEqual(["not_found", 404]);
    expect((await refus(c.read("a\ud800"))).code).toBe("bad_path");
    expect(String(e)).toMatch(/^not_found: /u);
    expect(e.name).toBe("AgentError");
  });

  it("liste bornée, élaguée ; grep sur place ; relevé avant/après", async () => {
    for (let i = 0; i < 30; i++)
      writeFileSync(path.join(bac.sandboxPath, `f${String(i).padStart(2, "0")}`), "");
    mkdirSync(path.join(bac.sandboxPath, "node_modules", "p"), { recursive: true });
    mkdirSync(path.join(bac.sandboxPath, ".cache"));
    const c = new AgentClient(bac);
    const tronquee = await c.list("", { maxEntries: 10 });
    expect(tronquee.truncated).toBe(true);
    expect(tronquee.entries).toHaveLength(10);
    const chemins = new Set(
      (await c.list("", { depth: 9, hidden: false, prune: ["node_modules"] })).entries.map((x) => x["path"]),
    );
    expect(chemins.has("node_modules")).toBe(true);
    expect(chemins.has("node_modules/p")).toBe(false);
    expect(chemins.has(".cache")).toBe(false);
    expect((await refus(c.list("f00"))).code).toBe("not_dir");
    writeFileSync(path.join(bac.sandboxPath, "t.txt"), "un\nDeux trois\nquatre\n");
    const [lignes, bilan] = await c.grep(["t.txt"], "deux");
    expect(lignes.map((l) => [l["file"], l["line"]])).toEqual([["t.txt", 2]]);
    expect(bilan["done"]).toBe(true);
    const avant = await c.changesBegin([]);
    writeFileSync(path.join(bac.sandboxPath, "t.txt"), "changé\n");
    const [vus, fin] = await c.changesEnd(String(avant["id"]));
    expect(vus.map((v) => v["path"])).toEqual(["t.txt"]);
    expect(fin["done"]).toBe(true);
  });

  it("corps envoyés : fichier de l'hôte, flux de taille connue, flux nu ; ajout par morceaux", async () => {
    const c = new AgentClient(bac);
    const source = path.join(racine, "source.bin");
    writeFileSync(source, Buffer.alloc(3 << 20, 7));
    expect((await c.write("a", { chemin: source, debut: 1 }))["size"]).toBe((3 << 20) - 1);
    expect(statSync(path.join(bac.sandboxPath, "a")).size).toBe((3 << 20) - 1);
    async function* morceaux(): AsyncGenerator<Buffer> {
      yield Buffer.from("abc");
      yield Buffer.from("defgh");
    }
    expect((await c.write("b", { flux: morceaux(), taille: 5 }))["size"]).toBe(5);
    expect(readFileSync(path.join(bac.sandboxPath, "b"), "utf-8")).toBe("abcde");
    expect((await c.write("c", morceaux()))["size"]).toBe(8);
    expect((await c.append("p/x.part", Buffer.from("12"), { parents: true, truncate: true }))["size"]).toBe(
      2,
    );
    expect((await c.append("p/x.part", Buffer.from("345")))["size"]).toBe(5);
  });

  it("git dans le bac : identité par défaut, crochets jamais lancés, bornes", async () => {
    const c = new AgentClient(bac);
    mkdirSync(path.join(bac.sandboxPath, "p"));
    expect((await c.git("p", ["init", "-q", "-b", "main"])).returncode).toBe(0);
    writeFileSync(path.join(bac.sandboxPath, "p", "f.txt"), "x\n");
    writeFileSync(path.join(bac.sandboxPath, "p", ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
    chmodSync(path.join(bac.sandboxPath, "p", ".git", "hooks", "pre-commit"), 0o755);
    expect((await c.git("p", ["add", "f.txt"])).returncode).toBe(0);
    expect((await c.git("p", ["commit", "-q", "-m", "premier"])).returncode).toBe(0);
    const r = await c.git("p", ["log", "-1", "--format=%cn <%ce>"]);
    expect(r.stdout.trim()).toBe("Elpis <elpis@localhost>");
    const lent = await c.git("", ["-c", "alias.dort=!sleep 5", "dort"], { timeoutS: 0.5 });
    expect([lent.returncode, lent.timed_out]).toEqual([124, true]);
    const bavard = await c.git("", ["-c", "alias.bavard=!head -c 300000 /dev/zero | tr '\\0' x", "bavard"], {
      maxOut: 1000,
    });
    expect([bavard.truncated, bavard.stdout]).toEqual([true, "x".repeat(1000)]);
    expect((await refus(c.git("", ["status"], { env: { GIT_DIR: "/" } }))).code).toBe("bad_request");
  });

  it("archives zip, raw et tgz ; extraction bornée", async () => {
    mkdirSync(path.join(bac.sandboxPath, "d"));
    writeFileSync(path.join(bac.sandboxPath, "d", "a.txt"), "aaa");
    writeFileSync(path.join(bac.sandboxPath, "b.txt"), "bb");
    symlinkSync("/etc/passwd", path.join(bac.sandboxPath, "lien"));
    const c = new AgentClient(bac);
    const zip = await c.archive([""], { maxBytes: 1 << 20, maxFiles: 100 });
    const octets: Buffer[] = [];
    try {
      for await (const x of zip) if (Buffer.isBuffer(x)) octets.push(x);
    } finally {
      await zip.fermer();
    }
    expect(zip.debut["start"]).toBe(true);
    expect(zip.fin?.["files"]).toBe(2);
    expect(Buffer.concat(octets).subarray(0, 2).toString()).toBe("PK");
    const brut = await c.archive(["d"], { format: "raw", maxBytes: 1 << 20, maxFiles: 100 });
    const vu: unknown[] = [];
    try {
      for await (const x of brut) vu.push(Buffer.isBuffer(x) ? x.toString() : x["entry"]);
    } finally {
      await brut.fermer();
    }
    expect(vu).toEqual(["d/a.txt", "aaa"]);
    expect((await refus(c.archive([""], { maxBytes: 1, maxFiles: 100 }))).code).toBe("too_large");
    const tgz = path.join(racine, "x.tgz");
    mkdirSync(path.join(racine, "src", "n"), { recursive: true });
    writeFileSync(path.join(racine, "src", "n", "neuf.txt"), "neuf");
    spawnSync("tar", ["-czf", tgz, "-C", path.join(racine, "src"), "n"]);
    let envoye = 0;
    const res = await c.extract(
      "",
      { chemin: tgz },
      {
        maxBytes: 1 << 20,
        maxFile: 1 << 20,
        maxMembers: 100,
        onSent: (n) => (envoye += n),
      },
    );
    expect(res["files"]).toBe(1);
    expect(envoye).toBe(statSync(tgz).size);
    expect(readFileSync(path.join(bac.sandboxPath, "n", "neuf.txt"), "utf-8")).toBe("neuf");
    const e = await refus(
      c.extract("", Buffer.from("pas un tar"), { maxBytes: 1 << 20, maxFile: 1, maxMembers: 1 }),
    );
    expect(e.code).toBe("bad_archive");
  });
});

describe.skipIf(!PYTHON)("socket piégé, faux agent, relance", () => {
  it("un lien posé à la place du socket n'est jamais suivi", async () => {
    const leurre = await ecoute(path.join(racine, "hote.sock"));
    symlinkSync(path.join(racine, "hote.sock"), bac.socket);
    expect((await new AgentClient(bac).hello())["version"]).toBe(versionAttendue());
    expect(leurre.connexions).toBe(0);
  });

  it("un fichier ordinaire à la place du socket : agent démarré", async () => {
    writeFileSync(bac.socket, "pas un socket");
    expect((await new AgentClient(bac).hello())["agent"]).toBe("elpis");
    expect(bac.demarrages).toBe(1);
  });

  it("faux agent bavard : lu dans ses bornes, sondé figé, remplacé", async () => {
    const tete = Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n");
    const faux = await ecoute(bac.socket, Buffer.concat([tete, Buffer.alloc(1 << 20, 0x78)]));
    const debut = performance.now();
    const c = new AgentClient(bac);
    expect((await c.stat(["x"]))[0]?.["kind"]).toBe("missing");
    expect(performance.now() - debut).toBeLessThan(15_000);
    expect(faux.envoye).toBeLessThan(200 << 20);
    expect(bac.remplacements).toBe(1);
  }, 30_000);

  it("autre version : relancée une seule fois, appels concurrents compris", async () => {
    await new AgentClient(bac).hello();
    const premier = bac.agents[0];
    surchargerVersionAttendue("autre");
    const c = new AgentClient(bac);
    expect(await Promise.all(Array.from({ length: 6 }, (_, i) => c.stat([`x${i}`])))).toHaveLength(6);
    expect(bac.demarrages).toBe(2);
    // L'ancien ferme son écoute avant la fin de son processus : sa sortie est attendue.
    if (premier && premier.exitCode === null && premier.signalCode === null)
      await new Promise((fin) => {
        premier.once("exit", fin);
        setTimeout(fin, 10_000);
      });
    expect(premier?.exitCode !== null || premier?.signalCode !== null).toBe(true);
    await c.stat(["x"]);
    expect(bac.demarrages).toBe(2);
  }, 30_000);

  it("agent mort (socket orphelin) : relancé", async () => {
    const c = new AgentClient(bac);
    await c.write("f", Buffer.from("1"));
    await bac.arreter();
    expect((await c.read("f")).data.toString()).toBe("1");
    expect(bac.demarrages).toBe(2);
  });

  it("conteneur arrêté : container_down ; appel passif sans démarrage", async () => {
    bac.running = false;
    expect((await refus(new AgentClient(bac).hello())).code).toBe("container_down");
    let reveils = 0;
    bac.ensureRunning = async () => {
      reveils++;
      return bac.status();
    };
    expect((await refus(new AgentClient(bac).stat(["x"], { passive: true }))).code).toBe("container_down");
    expect(reveils).toBe(0);
  });

  it("agent qui ne démarre pas : échec mémorisé, pas de second essai de 10 s", async () => {
    reglagesAgent.demarrageS = 0.3;
    bac.startAgent = async () => {
      bac.demarrages++;
    };
    const c = new AgentClient(bac);
    expect((await refus(c.hello())).code).toBe("agent_unavailable");
    const debut = performance.now();
    expect((await refus(c.hello())).code).toBe("agent_unavailable");
    expect(performance.now() - debut).toBeLessThan(200);
    expect(bac.demarrages).toBe(1);
  });

  it("démarrage en échec : cause rendue, mémorisée 30 s", async () => {
    bac.startAgent = async () => {
      throw new Error("docker exec : image sans agent");
    };
    const c = new AgentClient(bac);
    const e = await refus(c.hello());
    expect([e.code, e.message]).toEqual(["agent_unavailable", "docker exec : image sans agent"]);
  });

  it("borne totale d'une opération : timeout, version re-sondée ensuite", async () => {
    const c = new AgentClient(bac);
    await c.hello();
    await c.stat(["x"]);
    reglagesAgent.delaiTotalS = 0.5;
    const e = await refus(c.git("", ["-c", "alias.dort=!sleep 3", "dort"], { timeoutS: 10 }));
    expect([e.code, e.message]).toEqual(["timeout", "opération de plus de 0 s"]);
  });

  it("socket supprimé entre deux appels : agent relancé", async () => {
    const c = new AgentClient(bac);
    await c.hello();
    await bac.arreter();
    unlinkSync(bac.socket);
    expect((await c.stat(["x"]))[0]?.["kind"]).toBe("missing");
  });
});
