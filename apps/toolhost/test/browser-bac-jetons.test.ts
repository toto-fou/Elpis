// SPDX-License-Identifier: MIT
/** apps/toolhost/test/browser-bac-jetons.test.ts — jetons du service et du relais du navigateur d'un bac : posés dans le dossier d'exécution privé de l'hôte (0700, fichiers 0600), jamais dans le dossier du compte ; neufs à chaque lancement du service ; après un redémarrage de l'hôte, relus et réutilisés si le service les accepte. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { surchargerConfig } from "@elpis/config";
import { chargerAutorite, cheminsNavigateurBac } from "@elpis/navigateur";

const dossier = mkdtempSync(path.join(tmpdir(), "nav-jetons-"));
const lancements: { service: string; relais: string }[] = [];
let arrets = 0;
let arretLentMs = 0;
let actifAuLancement: boolean[] = [];
let serveur: Server | null = null;
let jetonServi = "";

/** Faux service du bac : répond /health 200 au seul jeton qu'on lui a donné au lancement. */
async function ecouter(socket: string, jeton: string): Promise<void> {
  await fermerService();
  jetonServi = jeton;
  rmSync(socket, { force: true });
  serveur = createServer((req, res) => {
    const ok = req.headers["authorization"] === `Bearer ${jetonServi}`;
    res.statusCode = ok ? 200 : 401;
    res.end(JSON.stringify({ ok, uptime_sec: 5 }));
  });
  await new Promise<void>((fin) => serveur?.listen(socket, fin));
}

async function fermerService(): Promise<void> {
  const s = serveur;
  serveur = null;
  if (s) await new Promise<void>((fin) => (s.closeAllConnections(), s.close(() => fin())));
}

vi.mock("../src/mcp/espace", () => ({
  bacDuCompteOutil: async (): Promise<unknown> => ({
    networkProfile: { id: "isolated", mode: "none", ips: [], domains: [], ports: [] },
    ensureRunning: async () => ({ running: true }),
    marquerActivite: async () => undefined,
    stopNavigateur: async () => {
      arrets++;
      if (arretLentMs > 0) setTimeout(() => void fermerService(), arretLentMs);
      else await fermerService();
    },
    startNavigateur: async (env: Record<string, string>) => {
      actifAuLancement.push(serveur !== null);
      lancements.push({
        service: env["BROWSER_SERVICE_TOKEN"] ?? "",
        relais: env["BROWSER_RELAY_TOKEN"] ?? "",
      });
      await ecouter(cheminsNavigateurBac("alice").socket, env["BROWSER_SERVICE_TOKEN"] ?? "");
    },
  }),
}));
vi.mock("@elpis/bac", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  montagesNavigateur: () => [],
}));

const { arreterNavigateursBac, injectionsNavigateurBac, reglagesNavigateurBac, serviceDuCompte } =
  await import("../src/mcp/browser/bac");

let restaurer: () => void = () => undefined;

beforeAll(() => {
  restaurer = surchargerConfig({ SANDBOX_DIR: path.join(dossier, "sb") });
  process.env["RUNTIME_DIRECTORY"] = path.join(dossier, "run");
  injectionsNavigateurBac.autorite = chargerAutorite(path.join(dossier, "ca"));
  reglagesNavigateurBac.sondeMs = 10;
  mkdirSync(path.dirname(cheminsNavigateurBac("alice").socket), { recursive: true });
});

afterEach(async () => {
  await arreterNavigateursBac();
  await fermerService();
  lancements.length = 0;
  arrets = 0;
  arretLentMs = 0;
  actifAuLancement = [];
  rmSync(path.join(dossier, "run"), { recursive: true, force: true });
});

afterAll(() => {
  restaurer();
  delete process.env["RUNTIME_DIRECTORY"];
  injectionsNavigateurBac.autorite = null;
  rmSync(dossier, { recursive: true, force: true });
});

const lire = (f: string): string => readFileSync(f, "utf8").trim();

describe("jetons du navigateur d'un bac", () => {
  it("posés dans le dossier d'exécution (0700, fichiers 0600), jamais dans le dossier du compte ; lus par le résolveur", async () => {
    const s = await serviceDuCompte("alice");
    const c = cheminsNavigateurBac("alice");
    expect(path.dirname(c.jeton)).toBe(path.join(dossier, "run", "navigateur"));
    expect(statSync(path.dirname(c.jeton)).mode & 0o777).toBe(0o700);
    for (const f of [c.jeton, c.jetonRelais]) expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(s.jeton).toBe(lire(c.jeton));
    expect(lancements).toEqual([{ service: lire(c.jeton), relais: lire(c.jetonRelais) }]);
    expect(lancements[0]?.service).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(path.join(dossier, "run", "navigateur")).sort()).toEqual([
      "alice.relay.token",
      "alice.service.token",
    ]);
    expect(readdirSync(c.dossier).filter((n) => n.endsWith(".token"))).toEqual([]);
  });

  it("service sain : jetons et service réutilisés par le même processus, sans relance", async () => {
    await serviceDuCompte("alice");
    const c = cheminsNavigateurBac("alice");
    const avant = [lire(c.jeton), lire(c.jetonRelais)];
    await serviceDuCompte("alice");
    await serviceDuCompte("alice");
    expect(lancements).toHaveLength(1);
    expect(arrets).toBe(0);
    expect([lire(c.jeton), lire(c.jetonRelais)]).toEqual(avant);
  });

  it("hôte d'outils relancé : le service qui accepte les jetons relus est réutilisé, sans relance ni jeton neuf", async () => {
    await serviceDuCompte("alice");
    const c = cheminsNavigateurBac("alice");
    const avant = [lire(c.jeton), lire(c.jetonRelais)];
    await arreterNavigateursBac();
    const s = await serviceDuCompte("alice");
    expect(arrets).toBe(0);
    expect(lancements).toHaveLength(1);
    expect(s.jeton).toBe(avant[0]);
    expect([lire(c.jeton), lire(c.jetonRelais)]).toEqual(avant);
  });

  it("hôte d'outils relancé : le service qui refuse les jetons relus est relancé une fois avec des jetons neufs", async () => {
    await serviceDuCompte("alice");
    const c = cheminsNavigateurBac("alice");
    const premier = { service: lire(c.jeton), relais: lire(c.jetonRelais) };
    await arreterNavigateursBac();
    jetonServi = "autre";
    const s = await serviceDuCompte("alice");
    expect(arrets).toBe(1);
    expect(lancements).toHaveLength(2);
    expect(lancements[1]?.service).not.toBe(premier.service);
    expect(lancements[1]?.relais).not.toBe(premier.relais);
    expect(s.jeton).toBe(lancements[1]?.service);
    expect(lire(c.jeton)).toBe(lancements[1]?.service);
    expect(lire(c.jetonRelais)).toBe(lancements[1]?.relais);
  });

  it("jeton refusé : le nouveau service n'est lancé qu'une fois l'ancien, qui répond encore, disparu", async () => {
    await serviceDuCompte("alice");
    await arreterNavigateursBac();
    jetonServi = "autre";
    arretLentMs = 400;
    await serviceDuCompte("alice");
    expect(arrets).toBe(1);
    expect(actifAuLancement).toEqual([false, false]);
  });

  it("jeton du service : celui de la mémoire, même si le fichier manque ou a changé", async () => {
    const premier = await serviceDuCompte("alice");
    const c = cheminsNavigateurBac("alice");
    rmSync(c.jeton);
    expect((await serviceDuCompte("alice")).jeton).toBe(premier.jeton);
    expect(premier.jeton).toBe(lancements[0]?.service);
  });

  it("service relancé par ce processus (service arrêté) : jetons renouvelés à chaque lancement", async () => {
    await serviceDuCompte("alice");
    await fermerService();
    await serviceDuCompte("alice");
    expect(lancements).toHaveLength(2);
    expect(lancements[1]?.service).not.toBe(lancements[0]?.service);
    expect(lancements[1]?.relais).not.toBe(lancements[0]?.relais);
    expect(existsSync(cheminsNavigateurBac("alice").jeton)).toBe(true);
  });
});
