// SPDX-License-Identifier: MIT
/** apps/core/test/relais/corps-precoce.test.ts — hôte qui répond avant la fin du corps : réponse relayée aussitôt, reste du corps vidé, connexion du client réutilisable, rien ne fuit. */
import { connect } from "node:net";
import type { Socket } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attendre, attendreQue, FauxToolhost, JETON, monterBanc } from "./aides";
import type { Banc } from "./aides";

interface Echange {
  statut: number;
  corps: string;
}

const EXPIRE = Symbol("délai expiré");

function avecDelai<T>(promesse: Promise<T>, ms: number): Promise<T | typeof EXPIRE> {
  let minuteur: NodeJS.Timeout | undefined;
  const delai = new Promise<typeof EXPIRE>((fin) => (minuteur = setTimeout(() => fin(EXPIRE), ms)));
  return Promise.race([promesse, delai]).finally(() => clearTimeout(minuteur));
}

/** Première réponse complète de `tampon` (Content-Length ou chunked) et sa longueur ; `null` si incomplète. */
function analyser(tampon: Buffer): (Echange & { longueur: number }) | null {
  const fin = tampon.indexOf("\r\n\r\n");
  if (fin < 0) return null;
  const lignes = tampon.subarray(0, fin).toString("latin1").split("\r\n");
  const statut = Number((lignes[0] ?? "").split(" ")[1]);
  const entetes = new Map(
    lignes
      .slice(1)
      .map((l) => [l.slice(0, l.indexOf(":")).trim().toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]),
  );
  let pos = fin + 4;
  if (entetes.get("transfer-encoding") === "chunked") {
    const morceaux: Buffer[] = [];
    for (;;) {
      const eol = tampon.indexOf("\r\n", pos);
      if (eol < 0) return null;
      const taille = Number.parseInt(tampon.subarray(pos, eol).toString("latin1"), 16);
      if (tampon.length < eol + 2 + taille + 2) return null;
      morceaux.push(tampon.subarray(eol + 2, eol + 2 + taille));
      pos = eol + 2 + taille + 2;
      if (taille === 0) return { statut, corps: Buffer.concat(morceaux).toString(), longueur: pos };
    }
  }
  const taille = Number(entetes.get("content-length") ?? "0");
  if (tampon.length < pos + taille) return null;
  return { statut, corps: tampon.subarray(pos, pos + taille).toString(), longueur: pos + taille };
}

/** Client « à la httpx » sur une seule connexion : écrit toute sa requête avant de lire la réponse, puis réutilise la connexion. */
class ClientBrut {
  private recu = Buffer.alloc(0);
  private reveil: (() => void) | undefined;
  ferme = false;
  readonly socket: Socket;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (d: Buffer) => {
      this.recu = Buffer.concat([this.recu, d]);
      this.reveil?.();
    });
    socket.on("close", () => {
      this.ferme = true;
      this.reveil?.();
    });
    socket.on("error", () => undefined);
  }

  static ouvrir(url: string): Promise<ClientBrut> {
    const u = new URL(url);
    return new Promise((fin, echec) => {
      const s = connect(Number(u.port), u.hostname, () => fin(new ClientBrut(s)));
      s.once("error", echec);
    });
  }

  ecrire(donnees: Buffer | string, ms = 10_000): Promise<void | typeof EXPIRE> {
    return avecDelai(
      new Promise<void>((fin, echec) => this.socket.write(donnees, (e) => (e ? echec(e) : fin()))),
      ms,
    );
  }

  async reponse(ms = 10_000): Promise<Echange | typeof EXPIRE> {
    const limite = Date.now() + ms;
    for (;;) {
      const r = analyser(this.recu);
      if (r !== null) {
        this.recu = this.recu.subarray(r.longueur);
        return { statut: r.statut, corps: r.corps };
      }
      if (this.ferme || Date.now() > limite) return EXPIRE;
      await avecDelai(new Promise<void>((fin) => (this.reveil = fin)), limite - Date.now());
      this.reveil = undefined;
    }
  }

  fermer(): void {
    this.socket.destroy();
  }
}

const REFUS = '{"detail":"Not Found"}';
let banc: Banc;
let hote: FauxToolhost;
let cookie: string;

function tete(chemin: string, taille: number | null): string {
  const corps =
    taille === null ? "" : `content-type: application/octet-stream\r\ncontent-length: ${taille}\r\n`;
  return `${taille === null ? "GET" : "POST"} ${chemin} HTTP/1.1\r\nhost: elpis\r\ncookie: ${cookie}\r\n${corps}\r\n`;
}

beforeEach(async () => {
  hote = await new FauxToolhost().demarrer();
  hote.traitements.set("/api/sandbox/refus", (_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(REFUS);
  });
  banc = await monterBanc();
  banc.manifeste(
    { main: { url: hote.url, token: JETON, relay: true } },
    { strategy: "single", host: "main" },
  );
  cookie = await banc.connecter(1);
});

afterEach(async () => {
  await banc.fermer();
  await hote.arreter();
});

describe("relais HTTP : réponse de l'hôte avant la fin du corps", () => {
  it("réponse relayée dès le premier octet du corps ; le reste, envoyé ensuite, est vidé et la connexion sert la requête suivante", async () => {
    for (const taille of [2, 200_000, 3_000_000]) {
      const c = await ClientBrut.ouvrir(banc.url);
      expect(await c.ecrire(`${tete("/api/sandbox/refus", taille)}a`)).toBeUndefined();
      expect(await c.reponse(), `${taille} : réponse avant la fin du corps`).toEqual({
        statut: 404,
        corps: REFUS,
      });
      await attendre(20);
      expect(
        await c.ecrire(Buffer.alloc(taille - 1, 0x61)),
        `${taille} : reste du corps accepté`,
      ).toBeUndefined();
      expect(await c.ecrire(tete("/api/sandbox/suite", null))).toBeUndefined();
      const suite = await c.reponse(5_000);
      expect(suite === EXPIRE ? suite : suite.statut, `${taille} : requête suivante`).toBe(200);
      c.fermer();
    }
  });

  it("client qui écrit tout son corps avant de lire (1 octet, 200 Ko, 3 Mo, connexion réutilisée) : jamais bloqué, rien ne fuit", async () => {
    const ouvertes = new Set<Socket>();
    banc.app.server.on("connection", (s: Socket) => {
      ouvertes.add(s);
      s.on("close", () => ouvertes.delete(s));
    });
    const c = await ClientBrut.ouvrir(banc.url);
    for (const [taille, essais] of [
      [1, 300],
      [200_000, 60],
      [3_000_000, 15],
    ] as const) {
      const corps = Buffer.alloc(taille, 0x62);
      for (let i = 0; i < essais; i++) {
        const envoi = await c.ecrire(Buffer.concat([Buffer.from(tete("/api/sandbox/refus", taille)), corps]));
        expect(envoi, `${taille} n°${i} : corps écrit`).toBeUndefined();
        expect(await c.reponse(5_000), `${taille} n°${i}`).toEqual({ statut: 404, corps: REFUS });
      }
    }
    const suite = await c.ecrire(tete("/api/sandbox/suite", null));
    expect([suite, await c.reponse(5_000)].map((r) => (r === EXPIRE ? "expiré" : r))).toEqual([
      undefined,
      expect.objectContaining({ statut: 200 }),
    ]);
    c.fermer();
    await attendreQue(() => c.ferme);
    await attendreQue(() => hote.sockets.size <= 1 && ouvertes.size === 0);
  });

  it("client parti en plein corps : la requête vers l'hôte est abandonnée", async () => {
    hote.traitements.set("/api/sandbox/lent", (req) => {
      req.on("data", () => undefined);
    });
    const c = await ClientBrut.ouvrir(banc.url);
    await c.ecrire(tete("/api/sandbox/lent", 1_000_000));
    await c.ecrire(Buffer.alloc(1000, 0x63));
    await attendreQue(() => hote.requetes.some((r) => r.url === "/api/sandbox/lent"));
    c.fermer();
    await attendreQue(() => hote.requetes.find((r) => r.url === "/api/sandbox/lent")?.fermee === true);
    await attendreQue(() => hote.sockets.size === 0);
  });
});
