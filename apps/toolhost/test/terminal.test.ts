// SPDX-License-Identifier: MIT
/** apps/toolhost/test/terminal.test.ts — terminal de l'hôte avec un vrai PTY (node-pty) sur un faux `docker` : porte, WebSocket, SSE, sessions nommées, 4001 du relais, éviction, nettoyage, quota, arrêt, base de l'hôte, et absence du blocage Python après `/api/terminal/kill`. */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { appelDocker, privdrop } from "@elpis/bac";
import { HttpError } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { fermerBaseHote, ouvrirBaseHote } from "../src/base-hote";
import { CycleDeVie } from "../src/cycle";
import {
  construireCommandePty,
  PTY_EXEC_USER,
  PTY_PRIVDROP_WRAP,
  Terminal,
  Terminaux,
} from "../src/terminal/pty";
import { installerUsageTerminal } from "../src/terminal/quota";
import { SessionsTerminal } from "../src/terminal/sessions";
import { boucleWs, reglagesWs, tamponner } from "../src/terminal/ws";
import { configTest, entetes, hoteTest, journalMuet, SVC } from "./aides";
import type { HoteTest } from "./aides";
import { attendre, creerFauxDockerTerminal, FausseSocket, FauxPty, lanceurFactice } from "./terminal-aides";
import type { FauxDockerTerminal } from "./terminal-aides";

interface ClientWs {
  ws: WebSocket;
  textes: unknown[];
  sortie: () => string;
  code: () => number | null;
  fin: Promise<number>;
}

function connecter(port: number, chemin: string, en: Record<string, string> = entetes()): Promise<ClientWs> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${chemin}`, { headers: en });
  const textes: unknown[] = [];
  const morceaux: Buffer[] = [];
  let code: number | null = null;
  ws.on("message", (d: Buffer, binaire: boolean) => {
    if (binaire) morceaux.push(d);
    else textes.push(JSON.parse(d.toString("utf-8")) as unknown);
  });
  const fin = new Promise<number>((ok) =>
    ws.on("close", (c: number) => {
      code = c;
      ok(c);
    }),
  );
  return new Promise((ok, ko) => {
    ws.once("open", () =>
      ok({ ws, textes, sortie: () => Buffer.concat(morceaux).toString("utf-8"), code: () => code, fin }),
    );
    ws.once("unexpected-response", (_q, r) => ko(new Error(`HTTP ${r.statusCode ?? 0}`)));
    ws.once("error", ko);
  });
}

/** Première trame texte (l'accueil arrive après l'ouverture : réglages du compte lus d'abord). */
async function accueil(c: ClientWs): Promise<unknown> {
  await attendre(() => c.textes.length > 0 || c.code() !== null);
  return c.textes[0];
}

/** Lecture d'un flux SSE brut jusqu'à sa fin (ou annulation). */
async function lireSse(
  port: number,
  signal?: AbortSignal,
): Promise<{ statut: number; texte: () => string; fin: Promise<void> }> {
  const r = await fetch(`http://127.0.0.1:${port}/api/terminal/stream`, {
    headers: entetes(),
    ...(signal ? { signal } : {}),
  });
  let texte = "";
  const decodeur = new TextDecoder();
  const fin = (async () => {
    if (!r.body) return;
    try {
      for await (const m of r.body) texte += decodeur.decode(m as Uint8Array, { stream: true });
    } catch {
      return;
    }
  })();
  return { statut: r.status, texte: () => texte, fin };
}

function sortieSse(texte: string): string {
  return texte
    .split("\n\n")
    .filter((l) => l.startsWith("data: ") && !l.startsWith("data: ["))
    .map((l) => Buffer.from(l.slice(6), "base64").toString("utf-8"))
    .join("");
}

describe("terminal de l'hôte (vrai PTY, faux docker)", () => {
  let dossier: string;
  let docker: FauxDockerTerminal;
  let t: BaseDeTest;
  let h: HoteTest;
  let port = 0;
  let restaurer: () => void = () => undefined;

  beforeAll(async () => {
    dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-terminal-")));
    docker = creerFauxDockerTerminal(path.join(dossier, "docker"));
    vi.stubEnv("PATH", `${docker.bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
    writeFileSync(path.join(dossier, "config.json"), "{}");
    restaurer = surchargerConfig({
      SANDBOX_DIR: path.join(dossier, "sb"),
      CONFIG_JSON_PATH: path.join(dossier, "config.json"),
    });
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    h = await hoteTest(configTest(), { base: t.base });
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    port = (h.app.server.address() as AddressInfo).port;
  });

  afterEach(() => {
    docker.poser("arrete", false);
    installerUsageTerminal(null);
    h.composition.terminaux.tuerTout();
  });

  afterAll(async () => {
    await h?.fermer();
    await t?.fermer();
    restaurer();
    vi.unstubAllEnvs();
    privdrop.oublierSondes();
    if (dossier) rmSync(dossier, { recursive: true, force: true });
  });

  it("porte : sans jeton 401 en HTTP et 403 à la poignée de main WebSocket", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/terminal/sessions`);
    expect(r.status).toBe(401);
    await expect(connecter(port, "/ws/terminal", {})).rejects.toThrow("HTTP 403");
    await expect(connecter(port, "/ws/terminal", { authorization: `Bearer ${SVC}` })).rejects.toThrow(
      "HTTP 403",
    );
    const get = await fetch(`http://127.0.0.1:${port}/ws/terminal`, { headers: entetes() });
    expect([get.status, await get.text()]).toEqual([404, "Not Found"]);
  });

  it("conteneur arrêté : 503 container_not_ready, WebSocket fermée en 1011 ; frappe vide sans PTY", async () => {
    docker.poser("arrete");
    const appel = (url: string, corps?: string) =>
      fetch(`http://127.0.0.1:${port}${url}`, {
        method: corps === undefined ? "GET" : "POST",
        headers: { ...entetes(), "content-type": "application/json" },
        ...(corps === undefined ? {} : { body: corps }),
      });
    for (const [url, corps] of [
      ["/api/terminal/input", '{"data": "ls"}'],
      ["/api/terminal/resize", '{"rows": 3}'],
      ["/api/terminal/stream", undefined],
    ] as const) {
      const r = await appel(url, corps);
      expect([r.status, await r.json()]).toEqual([
        503,
        {
          detail: {
            error: "container_not_ready",
            message:
              "Le container Docker n'est pas démarré. Démarre-le dans tes paramètres ou utilise la modal d'init.",
          },
        },
      ]);
    }
    expect(await (await appel("/api/terminal/input", '{"data": ""}')).json()).toEqual({ ok: true });
    const c = await connecter(port, "/ws/terminal");
    expect(await c.fin).toBe(1011);
    expect(c.textes).toEqual([]);
    expect(h.composition.terminaux.taille).toBe(0);
  });

  it("WebSocket : accueil, argv du PTY (historique puis root + setpriv), écho, taille, ping ; reconnexion et fin du shell", async () => {
    privdrop.oublierSondes();
    const a = await connecter(port, "/ws/terminal");
    await attendre(() => a.sortie().includes("$ "));
    expect(await accueil(a)).toEqual({ type: "hello", fresh_shell: true });
    expect(docker.argvPty()[0]).toEqual(construireCommandePty("elpis-sb-hugo").slice(1));
    expect(docker.argvPty()[0]?.slice(2, 4)).toEqual(["--user", PTY_EXEC_USER]);
    a.ws.send(JSON.stringify({ op: "resize", rows: 33, cols: 101 }));
    a.ws.send(Buffer.from("echo bon$((1+1))jour; stty size\r"));
    await attendre(() => a.sortie().includes("bon2jour") && a.sortie().includes("33 101"));
    a.ws.send(JSON.stringify({ op: "ping" }));
    await attendre(() => a.textes.length >= 2);
    expect(a.textes[1]).toEqual({ type: "pong" });

    const b = await connecter(port, "/ws/terminal");
    expect(await a.fin).toBe(1000);
    expect(await accueil(b)).toEqual({ type: "hello", fresh_shell: false });
    b.ws.send(Buffer.from("exit\r"));
    expect(await b.fin).toBe(1000);
    expect(b.textes.at(-1)).toEqual({ type: "exit" });

    docker.poser("privdrop-ok");
    privdrop.oublierSondes();
    const c = await connecter(port, "/ws/terminal");
    expect(await accueil(c)).toEqual({ type: "hello", fresh_shell: true });
    const argv = docker.argvPty().find((x) => x[3] === "0:0");
    expect(argv).toEqual(construireCommandePty("elpis-sb-hugo").slice(1));
    expect(argv?.slice(19, 24)).toEqual(["/bin/sh", "-c", PTY_PRIVDROP_WRAP, "--", "10001"]);
    c.ws.close();
    await c.fin;
    docker.poser("privdrop-ok", false);
  });

  it("SSE : sortie en base64, frappe par POST, [EOF] dès /api/terminal/kill — et pas de blocage ensuite (sous-processus, /health, nouveau shell)", async () => {
    const s = await lireSse(port);
    expect(s.statut).toBe(200);
    const frappe = await fetch(`http://127.0.0.1:${port}/api/terminal/input`, {
      method: "POST",
      headers: { ...entetes(), "content-type": "application/json" },
      body: JSON.stringify({ data: "echo sse$((40+2))\r" }),
    });
    expect(await frappe.json()).toEqual({ ok: true });
    await attendre(() => sortieSse(s.texte()).includes("sse42"));
    const debut = performance.now();
    const kill = await fetch(`http://127.0.0.1:${port}/api/terminal/kill`, {
      method: "POST",
      headers: entetes(),
    });
    expect(await kill.json()).toEqual({ ok: true });
    await s.fin;
    expect(s.texte().endsWith("data: [EOF]\n\n")).toBe(true);
    const resultats = await Promise.all(Array.from({ length: 12 }, () => appelDocker(["version"], 5_000)));
    expect(resultats.every((r) => r.code === 0)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    const c = await connecter(port, "/ws/terminal");
    expect(await accueil(c)).toEqual({ type: "hello", fresh_shell: true });
    c.ws.send(Buffer.from("echo apres$((1+2))kill\r"));
    await attendre(() => c.sortie().includes("apres3kill"));
    expect(performance.now() - debut).toBeLessThan(10_000);
    c.ws.close();
    await c.fin;
  });

  it("sessions nommées : noms par défaut, plafond 4 (429), renommage, suppression, WebSocket 4002/4004", async () => {
    const appel = async (methode: string, url: string, corps?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}${url}`, {
        method: methode,
        headers: { ...entetes(8, "lea"), "content-type": "application/json" },
        ...(corps === undefined ? {} : { body: typeof corps === "string" ? corps : JSON.stringify(corps) }),
      });
      return { statut: r.status, corps: (await r.json()) as Record<string, unknown> };
    };
    const ids: string[] = [];
    for (const corps of [undefined, { name: "  build  " }, {}, "pas du json"]) {
      const r = await appel("POST", "/api/terminal/sessions", corps);
      expect(r.statut).toBe(200);
      expect(Object.keys(r.corps)).toEqual(["ok", "session", "max"]);
      const s = r.corps["session"] as Record<string, unknown>;
      expect(Object.keys(s)).toEqual(["id", "uid", "tid", "name", "created_at", "last_connected_at"]);
      expect(s["id"]).toMatch(/^t_[A-Za-z0-9_-]{12}$/u);
      ids.push(String(s["id"]));
    }
    const liste = await appel("GET", "/api/terminal/sessions");
    expect((liste.corps["sessions"] as { name: string }[]).map((s) => s.name)).toEqual([
      "Terminal 1",
      "build",
      "Terminal 2",
      "Terminal 3",
    ]);
    expect(liste.corps["max"]).toBe(4);
    expect(await appel("POST", "/api/terminal/sessions", {})).toEqual({
      statut: 429,
      corps: { detail: { error: "limit_reached", max: 4, current: 4 } },
    });
    expect(await appel("PATCH", "/api/terminal/sessions/a.b", { name: "x" })).toEqual({
      statut: 400,
      corps: { detail: "invalid sid" },
    });
    expect(await appel("PATCH", `/api/terminal/sessions/${ids[0] ?? ""}`, { name: "  " })).toEqual({
      statut: 400,
      corps: { detail: "name required" },
    });
    expect(await appel("PATCH", "/api/terminal/sessions/t_inconnu", { name: "x" })).toEqual({
      statut: 404,
      corps: { detail: "session not found" },
    });
    expect(await appel("PATCH", `/api/terminal/sessions/${ids[0] ?? ""}`, { name: " déploiement " })).toEqual(
      {
        statut: 200,
        corps: { ok: true },
      },
    );
    const nomme = await connecter(port, `/ws/terminal/${ids[0] ?? ""}`, entetes(8, "lea"));
    expect(await accueil(nomme)).toEqual({ type: "hello", fresh_shell: true });
    expect(h.composition.terminaux.duCompte(8).map((x) => x.sid)).toEqual([ids[0]]);
    expect(await appel("DELETE", `/api/terminal/sessions/${ids[0] ?? ""}`)).toEqual({
      statut: 200,
      corps: { ok: true },
    });
    expect(await nomme.fin).toBe(1000);
    expect(nomme.textes.at(-1)).toEqual({ type: "exit" });
    expect(await appel("DELETE", `/api/terminal/sessions/${ids[0] ?? ""}`)).toEqual({
      statut: 404,
      corps: { detail: "session not found" },
    });
    const invalide = await connecter(port, "/ws/terminal/a.b", entetes(8, "lea"));
    expect(await invalide.fin).toBe(4002);
    const inconnue = await connecter(port, `/ws/terminal/${ids[0] ?? ""}`, entetes(8, "lea"));
    expect(await inconnue.fin).toBe(4004);
    const autre = await connecter(port, `/ws/terminal/${ids[1] ?? ""}`, entetes(9, "zoe"));
    expect(await autre.fin).toBe(4004);
    const inter = await connecter(port, "/ws/terminal", {
      ...entetes(8, "lea"),
      origin: "http://ailleurs.lan",
    });
    expect(await inter.fin).toBe(4003);
  });

  it("4001 venu du relais : tous les PTY du compte tués ; les autres comptes intacts", async () => {
    const a = await connecter(port, "/ws/terminal", entetes(10, "ana"));
    const sid = (
      (await (
        await fetch(`http://127.0.0.1:${port}/api/terminal/sessions`, {
          method: "POST",
          headers: { ...entetes(10, "ana"), "content-type": "application/json" },
          body: "{}",
        })
      ).json()) as { session: { id: string } }
    ).session.id;
    const b = await connecter(port, `/ws/terminal/${sid}`, entetes(10, "ana"));
    const autre = await connecter(port, "/ws/terminal", entetes(11, "bob"));
    await Promise.all([accueil(a), accueil(b), accueil(autre)]);
    expect(h.composition.terminaux.duCompte(10)).toHaveLength(2);
    a.ws.close(4001, "session expired");
    await attendre(() => h.composition.terminaux.duCompte(10).length === 0);
    expect(await b.fin).toBe(1000);
    expect(h.composition.terminaux.duCompte(11)).toHaveLength(1);
    autre.ws.close(1000);
    await autre.fin;
    expect(h.composition.terminaux.duCompte(11)).toHaveLength(1);
  });

  it("4001 reçu pendant la création du PTY : les PTY du compte sont tués dès qu'il existe", async () => {
    const autre = await connecter(port, "/ws/terminal/inexistante", entetes(13, "ida"));
    expect(await autre.fin).toBe(4004);
    const sid = (
      (await (
        await fetch(`http://127.0.0.1:${port}/api/terminal/sessions`, {
          method: "POST",
          headers: { ...entetes(13, "ida"), "content-type": "application/json" },
          body: "{}",
        })
      ).json()) as { session: { id: string } }
    ).session.id;
    const vivant = await connecter(port, `/ws/terminal/${sid}`, entetes(13, "ida"));
    await accueil(vivant);
    docker.poser("lent");
    try {
      const c = await connecter(port, "/ws/terminal", entetes(13, "ida"));
      c.ws.close(4001, "session expired");
      expect(await vivant.fin).toBe(1000);
      await attendre(() => h.composition.terminaux.duCompte(13).length === 0, 5_000);
      await new Promise((ok) => setTimeout(ok, 1_500));
      expect(h.composition.terminaux.duCompte(13)).toEqual([]);
    } finally {
      docker.poser("lent", false);
    }
  });

  it("arrêt du process : WebSocket fermées en 1012, flux SSE terminé par [EOF], PTY tués", async () => {
    const cycle = new CycleDeVie(journalMuet);
    const h2 = await hoteTest(configTest(), { base: t.base, cycle });
    await h2.app.listen({ port: 0, host: "127.0.0.1" });
    const p2 = (h2.app.server.address() as AddressInfo).port;
    try {
      const ws = await connecter(p2, "/ws/terminal", entetes(12, "eva"));
      await accueil(ws);
      const s = await lireSse(p2);
      expect(s.statut).toBe(200);
      cycle.annoncerArret();
      expect(await ws.fin).toBe(1012);
      await s.fin;
      expect(s.texte().endsWith("data: [EOF]\n\n")).toBe(true);
      await cycle.executerArrets(100, 2_000);
      expect(h2.composition.terminaux.taille).toBe(0);
    } finally {
      await h2.fermer();
    }
  });
});

describe("terminal : registre, éviction, nettoyage, quota (PTY factices)", () => {
  let dossier: string;
  let docker: FauxDockerTerminal;
  let t: BaseDeTest;
  let restaurer: () => void = () => undefined;
  const reglages = { ...reglagesWs };

  beforeAll(async () => {
    dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-terminal-faux-")));
    docker = creerFauxDockerTerminal(path.join(dossier, "docker"));
    vi.stubEnv("PATH", `${docker.bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
    writeFileSync(path.join(dossier, "config.json"), "{}");
    restaurer = surchargerConfig({
      SANDBOX_DIR: path.join(dossier, "sb"),
      CONFIG_JSON_PATH: path.join(dossier, "config.json"),
    });
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
  });

  afterEach(() => {
    Object.assign(reglagesWs, reglages);
    installerUsageTerminal(null);
  });

  afterAll(async () => {
    await t?.fermer();
    restaurer();
    vi.unstubAllEnvs();
    if (dossier) rmSync(dossier, { recursive: true, force: true });
  });

  it("plafond par compte : le PTY le plus inactif est évincé avant d'en créer un autre", async () => {
    const faux = lanceurFactice();
    const h = await hoteTest(configTest(), { base: t.base, lanceurPty: faux.lanceur, maxPtyParCompte: 2 });
    try {
      const r = h.composition.terminaux;
      const a = await r.obtenir(20, "a");
      const b = await r.obtenir(20, "b");
      await r.obtenir(21, "x");
      a.lastIo = 1;
      b.lastIo = 2;
      await r.obtenir(20, "c");
      expect(r.duCompte(20).map((x) => x.sid)).toEqual(["b", "c"]);
      expect(faux.crees[0]?.signaux).toEqual(["SIGKILL"]);
      expect(r.duCompte(21)).toHaveLength(1);
      expect(await r.obtenir(20, "b")).toBe(b);
    } finally {
      await h.fermer();
    }
  });

  it("taille demandée pendant le démarrage de docker exec : SIGWINCH renvoyé après la première sortie puis à 1 s et 3 s", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const pty = new FauxPty();
      const term = new Terminal(pty.commeIPty(), 1, "s", "/tmp", "elpis-sb-x");
      const winch = () => kill.mock.calls.filter((c) => c[0] === pty.pid && c[1] === "SIGWINCH").length;
      term.redimensionner(25, 90);
      expect([pty.tailles, winch()]).toEqual([[[25, 90]], 1]);
      pty.emettre(Buffer.from("$ "));
      vi.advanceTimersByTime(100);
      expect(winch()).toBe(2);
      vi.advanceTimersByTime(900);
      expect(winch()).toBe(3);
      vi.advanceTimersByTime(2_000);
      expect(winch()).toBe(4);
      term.redimensionner(30, 100);
      expect(winch()).toBe(5);
      pty.sortir();
      term.redimensionner(31, 101);
      vi.advanceTimersByTime(5_000);
      expect(winch()).toBe(5);
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("frappe : écrite dans le maître non bloquant, le reste gardé dans l'ordre jusqu'à 1 Mio puis refusée", async () => {
    const fifo = path.join(dossier, "maitre.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const lecture = openSync(fifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const ecriture = openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
    try {
      const pty = new FauxPty();
      pty.fd = ecriture;
      const term = new Terminal(pty.commeIPty(), 1, "s", "/tmp", "elpis-sb-x");
      const envoye: Buffer[] = [];
      let refus: unknown = null;
      for (let i = 0; i < 40 && refus === null; i++) {
        const morceau = Buffer.alloc(64 * 1024, i % 251);
        try {
          term.ecrire(morceau);
          envoye.push(morceau);
        } catch (e) {
          refus = e;
        }
      }
      expect((refus as Error).message).toBe("terminal saturé");
      expect(pty.ecrits).toEqual([]);
      const attendu = Buffer.concat(envoye);
      const recu: Buffer[] = [];
      let total = 0;
      const tampon = Buffer.alloc(64 * 1024);
      for (let i = 0; i < 2_000 && total < attendu.length; i++) {
        let n = 0;
        try {
          n = readSync(lecture, tampon);
        } catch {
          n = 0;
        }
        if (n > 0) {
          recu.push(Buffer.from(tampon.subarray(0, n)));
          total += n;
        } else await new Promise((ok) => setTimeout(ok, 5));
      }
      expect(Buffer.concat(recu).equals(attendu)).toBe(true);
      term.ecrire(Buffer.from("ok"));
      term.tuer();
      expect(() => term.ecrire(Buffer.from("x"))).toThrow("terminal closed");
    } finally {
      closeSync(lecture);
      closeSync(ecriture);
    }
  });

  it("contre-pression WebSocket : PTY en pause au-delà de 2 Mio en attente d'envoi, repris sous 512 Kio", async () => {
    const pty = new FauxPty();
    const term = new Terminal(pty.commeIPty(), 1, "s", "/tmp", "elpis-sb-x");
    const socket = new FausseSocket();
    const ctx = {
      terminaux: new Terminaux({ journal: journalMuet }),
      base: () => Promise.reject(new Error("sans base")),
      journal: journalMuet,
    };
    const boucle = boucleWs(socket.commeWs(), term, ctx, tamponner(socket.commeWs()));
    await attendre(() => socket.trames.length > 0);
    expect(pty.enPause).toBe(false);
    socket.bufferedAmount = 3 * 1024 * 1024;
    pty.emettre(Buffer.from("a"));
    expect(pty.enPause).toBe(true);
    socket.bufferedAmount = 0;
    pty.emettre(Buffer.from("b"));
    expect(pty.enPause).toBe(false);
    socket.fermeParLeClient(1000);
    await boucle;
    expect(pty.enPause).toBe(true);
  });

  it("créations : deux demandes simultanées, un seul PTY ; arrêt (session, compte, tout) pendant la création : rien de lancé", async () => {
    const faux = lanceurFactice();
    const h = await hoteTest(configTest(), { base: t.base, lanceurPty: faux.lanceur });
    try {
      const r = h.composition.terminaux;
      const [a, b] = await Promise.all([r.obtenir(60, "x"), r.obtenir(60, "x")]);
      expect(a).toBe(b);
      expect(faux.crees).toHaveLength(1);
      docker.poser("lent");
      const pendant = async (uid: number, sid: string, arreter: () => void): Promise<unknown> => {
        const enCours = r.obtenir(uid, sid).catch((e: unknown) => e);
        await new Promise((ok) => setTimeout(ok, 200));
        arreter();
        return enCours;
      };
      for (const [uid, sid, arreter] of [
        [61, "default", () => r.tuerSession(61, "default")],
        [62, "y", () => r.tuerDuCompte(62)],
        [63, "z", () => r.tuerTout()],
      ] as const)
        expect(((await pendant(uid, sid, arreter)) as Error).message).toBe(
          "terminal fermé pendant sa création",
        );
      expect(((await pendant(64, "w", () => r.tuerSession(64, "autre"))) as { uid: number }).uid).toBe(64);
      expect(faux.crees).toHaveLength(2);
      expect([r.duCompte(61), r.duCompte(62), r.duCompte(63)]).toEqual([[], [], []]);
    } finally {
      docker.poser("lent", false);
      await h.fermer();
    }
  });

  it("nettoyage : PTY inactif depuis plus de 30 min tué, lignes sans reconnexion depuis 7 jours purgées", async () => {
    const faux = lanceurFactice();
    const h = await hoteTest(configTest(), { base: t.base, lanceurPty: faux.lanceur });
    try {
      const r = h.composition.terminaux;
      const vieux = await r.obtenir(30, "v");
      await r.obtenir(30, "n");
      vieux.lastIo = Date.now() / 1000 - 1801;
      const maintenant = Math.floor(Date.now() / 1000);
      await t.base.run("DELETE FROM terminal_sessions");
      await t.base.run(
        "INSERT INTO terminal_sessions (id, uid, tid, name, created_at, last_connected_at) VALUES (?, 30, NULL, 'x', ?, ?), (?, 30, NULL, 'y', ?, ?)",
        ["t_vieille", maintenant - 8 * 86400, maintenant - 8 * 86400, "t_recente", maintenant, maintenant],
      );
      await h.composition.nettoyerTerminaux();
      expect(r.duCompte(30).map((x) => x.sid)).toEqual(["n"]);
      expect((await t.base.all("SELECT id FROM terminal_sessions")).map((l) => l["id"])).toEqual([
        "t_recente",
      ]);
    } finally {
      await h.fermer();
    }
  });

  it("quota (WebSocket) : avertissement à 90 % une fois, puis au dépassement avis, PTY tué et fermeture 1000 sans trame exit", async () => {
    Object.assign(reglagesWs, { ticMs: 20, intervalleQuotaS: 0 });
    const occupation = { octets: 0 };
    const faux = lanceurFactice();
    const h = await hoteTest(configTest(), { base: t.base, lanceurPty: faux.lanceur });
    installerUsageTerminal(async () => occupation.octets);
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const p = (h.app.server.address() as AddressInfo).port;
    try {
      const c = await connecter(p, "/ws/terminal", entetes(40, "quota"));
      await accueil(c);
      occupation.octets = 5120 * 1024 * 1024 * 0.95;
      await attendre(() => c.sortie().includes("Quota sandbox à 95 %"));
      occupation.octets = 5120 * 1024 * 1024 + 1;
      expect(await c.fin).toBe(1000);
      expect(c.sortie()).toContain("QUOTA SANDBOX DÉPASSÉ — session fermée");
      expect(c.sortie().match(/Quota sandbox à/gu)).toHaveLength(1);
      expect(c.textes.filter((x) => (x as { type: string }).type === "exit")).toEqual([]);
      expect(faux.crees[0]?.signaux).toEqual(["SIGKILL"]);
    } finally {
      await h.fermer();
    }
  });

  it("quota (SSE) : sondé toutes les 33 trames, dépassement → avis, PTY tué, [EOF] ; plafond lu dans les réglages du compte", async () => {
    let mesure = 0;
    const faux = lanceurFactice();
    const h = await hoteTest(configTest(), { base: t.base, lanceurPty: faux.lanceur });
    installerUsageTerminal(async (_u, _r, quota) => {
      mesure += 1;
      return quota + 1;
    });
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const p = (h.app.server.address() as AddressInfo).port;
    try {
      const s = await lireSse(p);
      const pty = faux.crees[0];
      for (let i = 0; i < 32; i++) pty?.emettre(Buffer.from(`l${i}\n`));
      await new Promise((ok) => setTimeout(ok, 50));
      expect(mesure).toBe(0);
      pty?.emettre(Buffer.from("l32\n"));
      await s.fin;
      expect(mesure).toBe(1);
      expect(sortieSse(s.texte())).toContain("QUOTA DÉPASSÉ");
      expect(s.texte().endsWith("data: [EOF]\n\n")).toBe(true);
      expect(pty?.signaux).toEqual(["SIGKILL"]);
    } finally {
      await h.fermer();
    }
  });
});

describe("base de l'hôte (baseHote) pour les sessions", () => {
  let dossier: string;
  let restaurer: () => void = () => undefined;

  beforeAll(() => {
    dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-terminal-base-")));
    const docker = creerFauxDockerTerminal(path.join(dossier, "docker"));
    vi.stubEnv("PATH", `${docker.bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
    writeFileSync(path.join(dossier, "config.json"), "{}");
    restaurer = surchargerConfig({
      SANDBOX_DIR: path.join(dossier, "sb"),
      CONFIG_JSON_PATH: path.join(dossier, "config.json"),
      DB_BACKEND: "sqlite",
      DB_PATH: path.join(dossier, "hote", "toolhost.db"),
    });
  });

  afterAll(async () => {
    await fermerBaseHote();
    restaurer();
    vi.unstubAllEnvs();
    if (dossier) rmSync(dossier, { recursive: true, force: true });
  });

  it("base non ouverte : sessions nommées en 500, WebSocket nommée en 1011, terminal par défaut utilisable ; ouverte au démarrage : sessions servies", async () => {
    const faux = lanceurFactice();
    const h = await hoteTest(configTest(), { lanceurPty: faux.lanceur });
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const p = (h.app.server.address() as AddressInfo).port;
    try {
      await fermerBaseHote();
      const r = await h.app.inject({ method: "GET", url: "/api/terminal/sessions", headers: entetes() });
      expect([r.statusCode, r.body]).toEqual([500, "Internal Server Error"]);
      const nomme = await connecter(p, "/ws/terminal/t_abc", entetes());
      expect(await nomme.fin).toBe(1011);
      const defaut = await connecter(p, "/ws/terminal", entetes());
      expect(await accueil(defaut)).toEqual({ type: "hello", fresh_shell: true });
      defaut.ws.close();
      await defaut.fin;

      expect(await ouvrirBaseHote(() => journalMuet)).not.toBeNull();
      const ok = await h.app.inject({ method: "GET", url: "/api/terminal/sessions", headers: entetes() });
      expect([ok.statusCode, ok.json()]).toEqual([200, { sessions: [], max: 4 }]);
    } finally {
      await h.fermer();
    }
  });
});

describe.each(["sqlite", "postgres"] as const)("sessions du terminal sur %s", (moteur) => {
  const actif = moteur === "sqlite" || Boolean(PG_DE_TEST);
  let t: BaseDeTest | undefined;

  afterAll(async () => {
    await t?.fermer();
  });

  it.skipIf(!actif)(
    "table assurée sans schéma posé, plafond sous verrou d'écriture, liste, renommage, suppression, purge",
    async () => {
      t = ouvrirBaseDeTest(moteur);
      const s = new SessionsTerminal(() => Promise.resolve((t as BaseDeTest).base));
      const lignes = await Promise.all(
        [1, 2, 3, 4, 5, 6].map((i) => s.inserer(50, null, `n${i}`).catch((e: unknown) => e)),
      );
      const refus = lignes.filter((l) => l instanceof HttpError) as HttpError[];
      expect(refus.map((e) => [e.statusCode, e.detail])).toEqual([
        [429, { error: "limit_reached", max: 4, current: 4 }],
        [429, { error: "limit_reached", max: 4, current: 4 }],
      ]);
      await s.inserer(51, 3, "équipe");
      const miennes = await s.lister(50);
      expect(miennes).toHaveLength(4);
      expect(Object.keys(miennes[0] ?? {})).toEqual([
        "id",
        "uid",
        "tid",
        "name",
        "created_at",
        "last_connected_at",
      ]);
      expect(miennes.every((l) => l.uid === 50 && l.tid === null)).toBe(true);
      const id = miennes[0]?.id ?? "";
      expect(await s.obtenir(id, 51)).toBeNull();
      expect(await s.renommer(id, 50, `  ${"é".repeat(70)}  `)).toBe(true);
      expect((await s.obtenir(id, 50))?.name).toBe("é".repeat(64));
      expect(await s.renommer(id, 50, "   ")).toBe(false);
      expect(await s.supprimer(id, 51)).toBe(false);
      expect(await s.supprimer(id, 50)).toBe(true);
      expect(await s.lister(51, 3)).toHaveLength(1);
      await (t as BaseDeTest).base.run("UPDATE terminal_sessions SET last_connected_at = 1 WHERE uid = 50");
      expect(await s.purger()).toBe(3);
      expect(await s.lister(50)).toEqual([]);
    },
  );
});
