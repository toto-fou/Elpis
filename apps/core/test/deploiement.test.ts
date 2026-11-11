// SPDX-License-Identifier: MIT
/** apps/core/test/deploiement.test.ts — bundle de production : démarrage sur une base SQLite temporaire, arrêt gracieux, commandes d'exploitation, licences livrées, empreinte (frontal Caddy : exploitation/frontal-caddy.test.ts). */
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CIBLES,
  construire,
  dossierPaquet,
  licenceConforme,
  RACINE,
  sectionLicenceReadme,
  tableDansNotices,
  tableLicences,
  texteLicences,
} from "../scripts/construire";
import type { Construction } from "../scripts/construire";
import { CODE_SORTIE_REDEMARRAGE, codeDeSortie } from "../src/cycle";
import { empreinteSources } from "@elpis/commun/empreinte";
import type { ReponsePixels, RequetePixels } from "@elpis/images/pixels";

const CIBLE = `${process.platform}-${process.arch}`;
const VECTEURS = JSON.parse(readFileSync(new URL("./vecteurs/licences.json", import.meta.url), "utf-8")) as {
  autorisees: string[];
  cas: { expression: string; conforme: boolean }[];
};

async function portLibre(): Promise<number> {
  const serveur = createServer();
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  const adresse = serveur.address();
  await new Promise<void>((ok) => serveur.close(() => ok()));
  if (adresse === null || typeof adresse === "string") throw new Error("port introuvable");
  return adresse.port;
}

function environnement(instance: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: instance,
    ELPIS_RACINE: RACINE,
    APP_CONFIG_PATH: path.join(instance, "config.json"),
    APP_DB_PATH: path.join(instance, "user_db", "app.db"),
    APP_SANDBOX_DIR: path.join(instance, "sandboxes"),
    ELPIS_AUDIT_DIR: path.join(instance, "audit"),
    ELPIS_AUDIT_KEY_PATH: path.join(instance, "audit.key"),
    MCP_SERVERS_DIR: path.join(instance, "mcp_custom_servers"),
    MAIN_INTERNAL_URL: "http://127.0.0.1:9",
    MAIN_PUBLIC_URL: "http://127.0.0.1:9",
    ...extra,
  };
}

interface Processus {
  enfant: ChildProcess;
  port: number;
  journal: () => string;
  fin: Promise<number | null>;
}

const RELANCE = path.join(RACINE, "deploy", "node", "relance.sh");

async function demarrer(
  dist: string,
  instance: string,
  mode: "main" | "admin",
  sousRelance = false,
): Promise<Processus> {
  const port = await portLibre();
  const commande = [process.execPath, "--enable-source-maps", path.join(dist, "main.mjs")];
  const enfant = spawn(
    sousRelance ? "bash" : process.execPath,
    sousRelance ? [RELANCE, ...commande] : commande.slice(1),
    {
      cwd: instance,
      env: environnement(instance, {
        APP_MODE: mode,
        APP_SERVICE: mode,
        BIND: `127.0.0.1:${port}`,
        ELPIS_PAUSE_RELANCE: "0.2",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let journal = "";
  enfant.stdout?.on("data", (d: Buffer) => (journal += d.toString()));
  enfant.stderr?.on("data", (d: Buffer) => (journal += d.toString()));
  const fin = new Promise<number | null>((ok) => enfant.on("exit", (code) => ok(code)));
  return { enfant, port, journal: () => journal, fin };
}

async function sante(p: Processus, delaiMs = 60_000): Promise<unknown> {
  const limite = Date.now() + delaiMs;
  for (;;) {
    if (p.enfant.exitCode !== null) throw new Error(`process sorti (${p.enfant.exitCode}) :\n${p.journal()}`);
    try {
      const r = await fetch(`http://127.0.0.1:${p.port}/api/health`);
      if (r.ok) return await r.json();
    } catch {
      // pas encore à l'écoute
    }
    if (Date.now() > limite) throw new Error(`/api/health muet sur ${p.port} :\n${p.journal()}`);
    await new Promise((ok) => setTimeout(ok, 200));
  }
}

function exploitation(
  dist: string,
  instance: string,
  commande: string,
): { code: number | null; sortie: string } {
  const r = spawnSync(process.execPath, [path.join(dist, "exploitation.mjs"), commande], {
    cwd: instance,
    env: environnement(instance),
    encoding: "utf-8",
    timeout: 60_000,
  });
  return { code: r.status, sortie: `${r.stdout}${r.stderr}`.trim() };
}

describe.skipIf(!CIBLES.includes(CIBLE))("bundle de production du core", () => {
  let dossier = "";
  let dist = "";
  let instance = "";
  let fait: Construction;

  beforeAll(async () => {
    dossier = mkdtempSync(path.join(tmpdir(), "elpis-bundle-"));
    dist = path.join(dossier, "dist");
    instance = path.join(dossier, "instance");
    mkdirSync(instance);
    writeFileSync(path.join(instance, "config.json"), "{}\n");
    fait = await construire(dist, [CIBLE]);
  }, 180_000);

  afterAll(() => {
    if (dossier) rmSync(dossier, { recursive: true, force: true });
  });

  it("est autonome hors du dépôt : seul le module natif de la cible est copié à côté", () => {
    expect(readdirSync(path.join(dist, "node_modules"))).toEqual(["better-sqlite3"]);
    expect(readdirSync(path.join(dist, "node_modules", "better-sqlite3", "prebuilds"))).toEqual([
      `${CIBLE}.node`,
    ]);
    const construction = JSON.parse(readFileSync(path.join(dist, "construction.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    const version = (
      JSON.parse(readFileSync(path.join(RACINE, "apps", "core", "package.json"), "utf-8")) as {
        version: string;
      }
    ).version;
    expect(construction).toEqual({
      version,
      empreinte: fait.empreinte,
      cibles: [CIBLE],
      sources: fait.sources,
    });
    expect(fait.sources).toEqual(
      expect.arrayContaining([
        "apps/core/package.json",
        "apps/core/src/exploitation.ts",
        "apps/core/src/main.ts",
        "package-lock.json",
        "packages/db/package.json",
        "packages/db/src/index.ts",
      ]),
    );
    expect(fait.sources.filter((f) => f.includes("node_modules/") || f.includes("/test/"))).toEqual([]);
    expect(readFileSync(path.join(dist, "LICENCES-TIERS.txt"), "utf-8")).toBe(texteLicences(fait.paquets));
    expect(fait.sources).toContain("packages/images/src/pixels.ts");
    expect(readdirSync(path.join(dist, "webp"), { recursive: true }).map(String).sort()).toEqual([
      "COPYING",
      "PATENTS",
      "dec",
      path.join("dec", "webp_dec.wasm"),
      "enc",
      path.join("enc", "webp_enc.wasm"),
    ]);
    expect(fait.sources).toEqual(
      expect.arrayContaining(["deploy/codecs/webp/SHA256SUMS", "deploy/codecs/webp/construire.sh"]),
    );
  });

  it("le thread des images (pixels.mjs) démarre hors du dépôt et trouve ses codecs WebAssembly à côté", async () => {
    const thread = new Worker(path.join(dist, "pixels.mjs"), { workerData: { elpis: "pixels" } });
    const reponses: ReponsePixels[] = [];
    const attendre = (n: number): Promise<void> =>
      new Promise((ok, ko) => {
        const verifier = (): void => {
          if (reponses.length >= n) ok();
          else setTimeout(verifier, 20);
        };
        thread.once("error", ko);
        verifier();
      });
    thread.on("message", (m: ReponsePixels) => reponses.push(m));
    try {
      await attendre(1);
      expect(reponses[0]).toEqual({ pret: true });
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      );
      const demander = (id: number, octets: Uint8Array): void => {
        const copie = new Uint8Array(octets);
        thread.postMessage({ id, op: "vignetter", args: [copie, 64] } satisfies RequetePixels, [
          copie.buffer,
        ]);
      };
      demander(1, png);
      await attendre(2);
      const webp = reponses[1];
      if (webp === undefined || !("resultat" in webp)) throw new Error(JSON.stringify(webp));
      const entete = (o: Uint8Array): string => Buffer.from(o.subarray(8, 12)).toString("latin1");
      expect(entete(webp.resultat)).toBe("WEBP");
      demander(2, webp.resultat);
      await attendre(3);
      const relu = reponses[2];
      if (relu === undefined || !("resultat" in relu)) throw new Error(JSON.stringify(relu));
      expect(entete(relu.resultat)).toBe("WEBP");
    } finally {
      await thread.terminate();
    }
  }, 60_000);

  it("base absente : les migrations attendront le premier démarrage, sans créer de fichier", () => {
    expect(exploitation(dist, instance, "migrations")).toEqual({
      code: 0,
      sortie: "base absente : créée au premier démarrage",
    });
    expect(existsSync(path.join(instance, "user_db", "app.db"))).toBe(false);
  });

  it("main démarre sur une base SQLite neuve, sert /api/health et s'arrête proprement sur SIGTERM", async () => {
    const p = await demarrer(dist, instance, "main");
    try {
      expect(await sante(p)).toEqual({ status: "ok" });
    } finally {
      p.enfant.kill("SIGTERM");
    }
    expect(await p.fin).toBe(0);
    expect(p.journal()).toContain("process main à l'écoute");
    expect(p.journal()).toContain("SIGTERM reçu : arrêt gracieux (jusqu'à 300 s)");
    expect(p.journal()).toContain("arrêt terminé");
  }, 120_000);

  it("SIGHUP (redémarrage demandé) : arrêt gracieux avec le code de redémarrage, pas 0", async () => {
    const p = await demarrer(dist, instance, "main");
    try {
      await sante(p);
    } finally {
      p.enfant.kill("SIGHUP");
    }
    expect(await p.fin).toBe(CODE_SORTIE_REDEMARRAGE);
    expect(p.journal()).toContain("SIGHUP reçu : arrêt gracieux (jusqu'à 300 s)");
    expect(p.journal()).toContain("arrêt terminé");
  }, 120_000);

  it("sous relance.sh : un redémarrage demandé relance le core, un arrêt demandé ne le relance plus", async () => {
    const p = await demarrer(dist, instance, "main", true);
    const demarrages = (): number => p.journal().split("process main à l'écoute").length - 1;
    const attendreDemarrages = async (n: number): Promise<void> => {
      const limite = Date.now() + 90_000;
      while (demarrages() < n) {
        if (p.enfant.exitCode !== null)
          throw new Error(`lanceur sorti (${p.enfant.exitCode}) :\n${p.journal()}`);
        if (Date.now() > limite) throw new Error(`pas de démarrage n°${n} :\n${p.journal()}`);
        await new Promise((ok) => setTimeout(ok, 100));
      }
    };
    try {
      await attendreDemarrages(1);
      p.enfant.kill("SIGHUP");
      await attendreDemarrages(2);
      expect(await sante(p)).toEqual({ status: "ok" });
      expect(p.journal()).toContain("[relance]");
      expect(p.enfant.exitCode).toBeNull();
      p.enfant.kill("SIGTERM");
      expect(await p.fin).toBe(0);
      await new Promise((ok) => setTimeout(ok, 1_500));
      expect(demarrages()).toBe(2);
      expect(p.journal().split("SIGTERM reçu : arrêt gracieux").length - 1).toBe(1);
      expect(p.journal()).not.toContain("pendant l'arrêt");
      await expect(fetch(`http://127.0.0.1:${p.port}/api/health`)).rejects.toThrow();
    } finally {
      if (p.enfant.exitCode === null) p.enfant.kill("SIGTERM");
      await p.fin;
    }
  }, 180_000);

  it("admin démarre aussi depuis le même point d'entrée (APP_MODE)", async () => {
    const p = await demarrer(dist, instance, "admin");
    try {
      expect(await sante(p)).toEqual({ status: "ok" });
    } finally {
      p.enfant.kill("SIGTERM");
    }
    expect(await p.fin).toBe(0);
    expect(p.journal()).toContain("process admin à l'écoute");
  }, 120_000);

  it("commandes d'exploitation : module natif, migrations, empreinte, usage", () => {
    const natif = exploitation(dist, instance, "natif");
    expect(natif.code).toBe(0);
    expect(natif.sortie).toMatch(
      new RegExp(`^better-sqlite3 13\\.0\\.3, SQLite 3\\.\\d+\\.\\d+ \\(${CIBLE}, Node v24\\.`),
    );
    const migrations = exploitation(dist, instance, "migrations");
    expect(migrations.code).toBe(0);
    expect(migrations.sortie).toMatch(/^à jour \(\d+ migrations, dernière \d{4}_\w+\)$/);
    expect(exploitation(dist, instance, "empreinte")).toEqual({
      code: 0,
      sortie: `à jour des sources (${fait.empreinte.slice(0, 12)})`,
    });
    expect(exploitation(dist, instance, "autre").code).toBe(2);
  });

  it("natif et empreinte ne lisent pas la configuration : une instance vierge reste vide", () => {
    const vierge = path.join(dossier, "vierge");
    mkdirSync(vierge);
    expect(exploitation(dist, vierge, "natif").code).toBe(0);
    expect(exploitation(dist, vierge, "empreinte").code).toBe(0);
    expect(readdirSync(vierge)).toEqual([]);
  });

  it("une base antérieure à la version Python finale est signalée (le core refuserait de démarrer)", () => {
    const ancienne = path.join(dossier, "ancienne");
    mkdirSync(path.join(ancienne, "user_db"), { recursive: true });
    writeFileSync(path.join(ancienne, "config.json"), "{}\n");
    const r = spawnSync(process.execPath, ["-e", ANCIENNE_BASE, path.join(ancienne, "user_db", "app.db")], {
      cwd: path.join(RACINE, "apps", "core"),
      encoding: "utf-8",
    });
    expect(r.status, r.stderr).toBe(0);
    const sortie = exploitation(dist, ancienne, "migrations");
    expect(sortie.code).toBe(2);
    expect(sortie.sortie).toMatch(/^base antérieure à la version Python finale \(absentes : 0001_\w+/);
  });

  it("le remplacement est atomique : une construction refusée après esbuild laisse le bundle en place", async () => {
    const avant = readFileSync(path.join(dist, "main.mjs"));
    await expect(construire(dist, [CIBLE], { licences: [] })).rejects.toThrow(/licence hors politique/);
    await expect(construire(dist, ["win32-x64"])).rejects.toThrow(/cibles/);
    expect(readFileSync(path.join(dist, "main.mjs")).equals(avant)).toBe(true);
    expect(
      readdirSync(dossier).filter((n) => n.includes(".construction-") || n.includes(".ancien-")),
    ).toEqual([]);
  }, 120_000);

  it("THIRD_PARTY_LICENSES/npm-core.txt et la table de THIRD_PARTY_NOTICES.md sont à jour (npm run licences)", () => {
    expect(readFileSync(path.join(RACINE, "THIRD_PARTY_LICENSES", "npm-core.txt"), "utf-8")).toBe(
      texteLicences(fait.paquets),
    );
    const notices = readFileSync(path.join(RACINE, "THIRD_PARTY_NOTICES.md"), "utf-8");
    expect(tableDansNotices(notices)).toBe(tableLicences(fait.paquets));
    for (const p of fait.paquets) expect(licenceConforme(p.licence, VECTEURS.autorisees), p.nom).toBe(true);
    expect(fait.paquets.map((p) => p.nom)).toEqual(
      expect.arrayContaining(["fastify", "better-sqlite3", "node-addon-api", "pg"]),
    );
    const webp = fait.paquets.find((p) => p.nom === "libwebp");
    expect([webp?.version, webp?.licence]).toEqual([
      "1.6.0",
      "BSD-3-Clause AND MIT AND Apache-2.0 WITH LLVM-exception",
    ]);
    for (const objet of [
      "libwebp, compiled",
      "libwebp, additional grant of patent rights",
      "Emscripten system libraries",
      "musl libc",
      "compiler-rt builtins",
      "dlmalloc",
    ])
      expect(
        webp?.textes.some((t) => t.startsWith(objet)),
        objet,
      ).toBe(true);
    expect(webp?.textes.find((t) => t.startsWith("compiler-rt"))).toContain(
      "The compiler_rt library is dual licensed",
    );
    const jpeg = fait.paquets.find((p) => p.nom === "jpeg-js");
    expect(jpeg?.licence).toBe("BSD-3-Clause AND Apache-2.0");
    expect(jpeg?.textes.join("\n")).toContain("Licensed under the Apache License, Version 2.0");
  });
});

const ANCIENNE_BASE = `
const Database = require("better-sqlite3");
const db = new Database(process.argv[1]);
db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)");
db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at REAL)");
db.close();
`;

describe("licences des paquets livrés", () => {
  it("licenceConforme rejoue licence_conforme du kit (vecteurs Python)", () => {
    expect(VECTEURS.cas.length).toBeGreaterThan(30);
    for (const c of VECTEURS.cas)
      expect(licenceConforme(c.expression, VECTEURS.autorisees), c.expression).toBe(c.conforme);
  });

  it("dossierPaquet retrouve le paquet d'un fichier d'entrée, imbrications et portées comprises", () => {
    expect(dossierPaquet("node_modules/fastify/lib/route.js")).toBe("node_modules/fastify");
    expect(dossierPaquet("node_modules/@fastify/send/index.js")).toBe("node_modules/@fastify/send");
    expect(dossierPaquet("node_modules/a/node_modules/@s/b/x.js")).toBe("node_modules/a/node_modules/@s/b");
    expect(dossierPaquet("packages/db/src/index.ts")).toBeNull();
    expect(dossierPaquet("node_modules/@portee")).toBeNull();
  });

  it("sectionLicenceReadme garde la section « License » jusqu'au titre suivant de même niveau", () => {
    const readme = "# p\n\n## Usage\nx\n\n## License\n\nMIT\n\n### Détail\ny\n\n## Autre\nz\n";
    expect(sectionLicenceReadme(readme)).toBe("## License\n\nMIT\n\n### Détail\ny");
    expect(sectionLicenceReadme("# p\n\n## Licence\r\nISC")).toBe("## Licence\nISC");
    expect(sectionLicenceReadme("# p\nrien")).toBeNull();
  });
});

describe("empreinte des sources", () => {
  let racine = "";
  const liste = [
    "package.json",
    "apps/core/src/main.ts",
    "apps/core/src/sous/b.ts",
    "packages/db/src/index.ts",
  ];

  beforeAll(() => {
    racine = mkdtempSync(path.join(tmpdir(), "elpis-empreinte-"));
    const ecrire = (rel: string, contenu: string) => {
      mkdirSync(path.dirname(path.join(racine, rel)), { recursive: true });
      writeFileSync(path.join(racine, rel), contenu);
    };
    ecrire("package.json", "{}");
    ecrire("apps/core/src/main.ts", "a");
    ecrire("apps/core/src/sous/b.ts", "b");
    ecrire("packages/db/src/index.ts", "d");
  });

  afterAll(() => {
    if (racine) rmSync(racine, { recursive: true, force: true });
  });

  it("ne dépend ni de l'ordre ni des doublons de la liste", () => {
    expect(empreinteSources(racine, [...liste].reverse().concat(liste[0] ?? ""))).toBe(
      empreinteSources(racine, liste),
    );
  });

  it("change avec une source listée ou absente, pas avec un fichier hors de la liste (sauvegarde d'éditeur, reste d'une version)", () => {
    const avant = empreinteSources(racine, liste);
    writeFileSync(path.join(racine, "apps/core/src/main.ts~"), "copie");
    writeFileSync(path.join(racine, "apps/core/src/ancien.ts"), "supprimé depuis");
    expect(empreinteSources(racine, liste)).toBe(avant);
    writeFileSync(path.join(racine, "apps/core/src/sous/b.ts"), "b2");
    const modifiee = empreinteSources(racine, liste);
    expect(modifiee).not.toBe(avant);
    rmSync(path.join(racine, "packages/db/src/index.ts"));
    expect(empreinteSources(racine, liste)).not.toBe(modifiee);
  });
});

describe("code de sortie du core", () => {
  it("75 pour un arrêt qui prépare un redémarrage (réussi ou non), 0 ou 1 pour un arrêt demandé", () => {
    expect(CODE_SORTIE_REDEMARRAGE).toBe(75);
    expect([true, false].map((ok) => codeDeSortie(true, ok))).toEqual([75, 75]);
    expect([codeDeSortie(false, true), codeDeSortie(false, false)]).toEqual([0, 1]);
  });
});
