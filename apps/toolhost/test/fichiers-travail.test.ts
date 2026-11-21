// SPDX-License-Identifier: MIT
/** apps/toolhost/test/fichiers-travail.test.ts — /work lu et écrit pour la sauvegarde et la restauration du core, servi par le vrai agent du bac : trames, bac arrêté démarré puis arrêté de nouveau, fichier écrit ou refusé, enveloppe exigée. */
import { request } from "node:http";
import { getEventListeners } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { EtatBac } from "@elpis/bac";
import { AgentClient } from "@elpis/fichiers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BacTest, PYTHON } from "../../../packages/fichiers/test/aides";
import { CycleDeVie } from "../src/cycle";
import { configTest, dossierTemporaire, entetes, hoteTest, journalMuet } from "./aides";
import type { HoteTest } from "./aides";

let tmp = "";
let nettoyer: () => void = () => undefined;
let h: HoteTest;
let arrets = 0;
let agent: AgentClient;
let cycle: CycleDeVie;
let ecouteursBase = 0;
let ouvertes = 0;
let fermees = 0;

/** Bac de test : démarré à la demande de l'agent, arrêts comptés. */
class BacSuivi extends BacTest {
  lancements = 0;
  barriere: Promise<void> | null = null;

  override async ensureRunning(): Promise<EtatBac> {
    if (!this.running) this.lancements++;
    if (this.barriere) await this.barriere;
    this.running = true;
    return super.ensureRunning();
  }
}

let bac: BacSuivi;

type Trame = ["J", Record<string, unknown>] | ["D", Buffer];

/** Trames « genre, longueur sur 4 octets, corps » d'une réponse. */
function lireTrames(brut: Buffer): Trame[] {
  const sortie: Trame[] = [];
  for (let i = 0; i < brut.length;) {
    const genre = brut.subarray(i, i + 1).toString("latin1");
    const n = brut.readUInt32BE(i + 1);
    const corps = brut.subarray(i + 5, i + 5 + n);
    sortie.push(
      genre === "J" ? ["J", JSON.parse(corps.toString()) as Record<string, unknown>] : ["D", corps],
    );
    i += 5 + n;
  }
  return sortie;
}

async function sauvegarde(plus: Record<string, string> = entetes()) {
  return h.app.inject({ method: "POST", url: "/api/internal/sandbox/backup-work", headers: plus });
}

function formulaire(chemin: string, contenu: string): [Buffer, string] {
  const borne = "----elpis-travail";
  const corps = Buffer.concat([
    Buffer.from(`--${borne}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${chemin}\r\n`),
    Buffer.from(
      `--${borne}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${Buffer.byteLength(contenu)}\r\n`,
    ),
    Buffer.from(
      `--${borne}\r\nContent-Disposition: form-data; name="data"; filename="f"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.from(contenu),
    Buffer.from(`\r\n--${borne}--\r\n`),
  ]);
  return [corps, `multipart/form-data; boundary=${borne}`];
}

async function ecrire(chemin: string, contenu: string, plus: Record<string, string> = entetes()) {
  const [payload, type] = formulaire(chemin, contenu);
  return h.app.inject({
    method: "POST",
    url: "/api/internal/sandbox/work-file",
    headers: { ...plus, "content-type": type },
    payload,
  });
}

describe.skipIf(!PYTHON)("/work pour la sauvegarde et la restauration", () => {
  beforeAll(async () => {
    [tmp, nettoyer] = dossierTemporaire("elpis-th-travail-");
    bac = new BacSuivi(tmp, "hugo");
    await bac.startAgent(false);
  }, 60_000);

  afterAll(async () => {
    await bac?.arreter();
    nettoyer();
  });

  beforeEach(async () => {
    arrets = 0;
    bac.running = true;
    bac.lancements = 0;
    writeFileSync(path.join(bac.sandboxPath, "a.txt"), "contenu");
    mkdirSync(path.join(bac.sandboxPath, "sous"), { recursive: true });
    writeFileSync(path.join(bac.sandboxPath, "sous", "x.sh"), "#!/bin/sh\n");
    chmodSync(path.join(bac.sandboxPath, "sous", "x.sh"), 0o750);
    chmodSync(path.join(bac.sandboxPath, "a.txt"), 0o644);
    utimesSync(path.join(bac.sandboxPath, "a.txt"), 1_700_000_000, 1_700_000_000);
    agent = new AgentClient(bac);
    ouvertes = 0;
    fermees = 0;
    bac.barriere = null;
    const ouvrir = agent.archive.bind(agent);
    agent.archive = async (...a: Parameters<AgentClient["archive"]>) => {
      const flux = await ouvrir(...a);
      ouvertes++;
      const fermer = flux.fermer.bind(flux);
      flux.fermer = async () => {
        fermees++;
        await fermer();
      };
      return flux;
    };
    cycle = new CycleDeVie(journalMuet);
    h = await hoteTest(configTest(), {
      cycle,
      bacFichiers: {
        racine: async () => bac.sandboxPath,
        agent: async () => agent,
        arreter: async () => {
          arrets++;
          bac.running = false;
        },
      },
    });
    ecouteursBase = getEventListeners(cycle.signalArret, "abort").length;
  });

  afterEach(() => h.fermer());

  it("fichiers en trames (entrée, octets, bilan), bac en marche laissé tel quel", async () => {
    const r = await sauvegarde();
    expect([r.statusCode, r.headers["content-type"], r.headers["cache-control"]]).toEqual([
      200,
      "application/octet-stream",
      "no-store",
    ]);
    const t = lireTrames(r.rawPayload);
    const entrees = t.filter((x): x is ["J", Record<string, unknown>] => x[0] === "J" && "entry" in x[1]);
    expect(entrees.map((e) => [e[1]["entry"], e[1]["size"], e[1]["mode"]]).toSorted()).toEqual([
      ["a.txt", 7, 0o644],
      ["sous/x.sh", 10, 0o750],
    ]);
    const contenu = Buffer.concat(t.filter((x): x is ["D", Buffer] => x[0] === "D").map((x) => x[1]));
    expect(contenu.toString().length).toBe(17);
    expect(t.at(-1)?.[1]).toMatchObject({ fin: expect.any(Object) });
    expect([bac.lancements, arrets]).toEqual([0, 0]);
  });

  it("bac arrêté : démarré pour la lecture, arrêté de nouveau ensuite", async () => {
    bac.running = false;
    const r = await sauvegarde();
    expect(r.statusCode).toBe(200);
    expect([bac.lancements, arrets]).toEqual([1, 1]);
  });

  it("bac arrêté puis utilisé pendant la lecture (date du /work changée) : laissé en marche", async () => {
    bac.running = false;
    const ouvrir = agent.archive.bind(agent);
    agent.archive = (...a: Parameters<AgentClient["archive"]>) => {
      utimesSync(bac.sandboxPath, new Date(), new Date(Date.now() + 5_000));
      return ouvrir(...a);
    };
    const r = await sauvegarde();
    expect(r.statusCode).toBe(200);
    expect([bac.lancements, arrets]).toEqual([1, 0]);
  });

  /** Sauvegarde lancée sur un vrai port ; `couper` abandonne la requête côté client. */
  async function sauvegardeVive(
    surDonnees?: () => void,
  ): Promise<{ couper: () => void; fini: Promise<void> }> {
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (h.app.server.address() as { port: number }).port;
    const req = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/api/internal/sandbox/backup-work",
      headers: entetes(),
    });
    const fini = new Promise<void>((resolve) => {
      req.on("error", () => resolve());
      req.on("response", (res) => {
        res.on("data", () => surDonnees?.());
        res.on("close", () => resolve());
        res.on("error", () => resolve());
      });
    });
    req.end();
    return { couper: () => req.destroy(), fini };
  }

  it("client parti pendant le démarrage du bac : bac arrêté une seule fois, archive jamais laissée ouverte", async () => {
    bac.running = false;
    let ouvrirBarriere: () => void = () => undefined;
    bac.barriere = new Promise<void>((resolve) => (ouvrirBarriere = resolve));
    const vive = await sauvegardeVive();
    await vi.waitFor(() => expect(bac.lancements).toBe(1));
    vive.couper();
    await vive.fini;
    await new Promise((resolve) => setTimeout(resolve, 200));
    ouvrirBarriere();
    await vi.waitFor(() => expect(arrets).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect([arrets, ouvertes - fermees]).toEqual([1, 0]);
    expect(getEventListeners(cycle.signalArret, "abort")).toHaveLength(ecouteursBase);
  });

  it("client parti en cours de lecture : bac arrêté une seule fois, archive fermée une seule fois", async () => {
    bac.running = false;
    writeFileSync(path.join(bac.sandboxPath, "gros.bin"), Buffer.alloc(48 * 1024 * 1024, 1));
    let coupe = false;
    let vive: Awaited<ReturnType<typeof sauvegardeVive>> | null = null;
    vive = await sauvegardeVive(() => {
      if (coupe) return;
      coupe = true;
      vive?.couper();
    });
    await vive.fini;
    await vi.waitFor(() => expect([arrets, fermees]).toEqual([1, 1]));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect([arrets, ouvertes, fermees]).toEqual([1, 1, 1]);
    expect(getEventListeners(cycle.signalArret, "abort")).toHaveLength(ecouteursBase);
  });

  it("signal d'arrêt de l'hôte : aucun écouteur laissé après une sauvegarde", async () => {
    const avant = getEventListeners(cycle.signalArret, "abort").length;
    expect((await sauvegarde()).statusCode).toBe(200);
    expect(getEventListeners(cycle.signalArret, "abort")).toHaveLength(avant);
  });

  it("sans enveloppe valide : 401, rien de lu ni de démarré", async () => {
    bac.running = false;
    expect((await sauvegarde({})).statusCode).toBe(401);
    expect((await sauvegarde({ authorization: "Bearer autre" })).statusCode).toBe(401);
    expect((await ecrire("a.txt", "x", {})).statusCode).toBe(401);
    expect([bac.lancements, arrets]).toEqual([0, 0]);
  });

  it("fichier écrit sous /work, dossiers créés ; refus de l'agent rendu avec son code", async () => {
    const ok = await ecrire("neuf/un.txt", "un");
    expect([ok.statusCode, ok.json()]).toEqual([200, { ok: true }]);
    expect(readFileSync(path.join(bac.sandboxPath, "neuf", "un.txt"), "utf8")).toBe("un");
    const refus = await ecrire("../evasion.txt", "deux");
    expect(refus.statusCode).toBe(200);
    expect(refus.json()).toMatchObject({ ok: false, code: expect.any(String) });
    expect(existsSync(path.join(tmp, "sb", "evasion.txt"))).toBe(false);
  });
});
