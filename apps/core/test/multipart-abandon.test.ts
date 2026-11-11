// SPDX-License-Identifier: MIT
/** apps/core/test/multipart-abandon.test.ts — client parti à tout moment (création du dossier, envoi du corps, traitement) : temporaire du formulaire toujours supprimé, jamais avant la fin du traitement. */
import { existsSync } from "node:fs";
import type * as FsPromesses from "node:fs/promises";
import { connect } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { dirname } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Famille } from "../src/routes";
import { appTest } from "./aides";
import { lireFormulaire } from "@elpis/http";

const verrou = vi.hoisted(() => ({
  cree: null as ((dossier: string) => void) | null,
  attente: null as Promise<void> | null,
}));

vi.mock("node:fs/promises", async (original) => {
  const vrai = await original<typeof FsPromesses>();
  return {
    ...vrai,
    mkdtemp: async (prefixe: string) => {
      const dossier = await vrai.mkdtemp(prefixe);
      verrou.cree?.(dossier);
      if (verrou.attente !== null) await verrou.attente;
      return dossier;
    },
  };
});

const B = "----limite-abandon";
const TETE = `--${B}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`;
const FIN = `\r\n--${B}--\r\n`;

const etat = {
  lu: null as ((chemin: string | null) => void) | null,
  traitement: null as Promise<void> | null,
  fini: null as (() => void) | null,
};

const famille: Famille = {
  nom: "abandon",
  routes: [
    {
      methode: "POST",
      chemin: "/abandon",
      processus: ["main"],
      acces: "public",
      traiter: async (req) => {
        try {
          const f = await lireFormulaire(req);
          const fichier = f.get("file");
          etat.lu?.(fichier === undefined || typeof fichier === "string" ? null : fichier.chemin);
          if (etat.traitement !== null) await etat.traitement;
          return { n: f.entrees.length };
        } finally {
          etat.fini?.();
        }
      },
    },
  ],
};

let app: FastifyInstance;
let port = 0;

beforeAll(async () => {
  app = await appTest({ familles: [famille] });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  verrou.cree = null;
  verrou.attente = null;
  etat.lu = null;
  etat.traitement = null;
  etat.fini = null;
});

function differe<T = void>(): { promesse: Promise<T>; resoudre: (v: T) => void } {
  let resoudre!: (v: T) => void;
  const promesse = new Promise<T>((r) => (resoudre = r));
  return { promesse, resoudre };
}

function envoyer(corps: string, longueur: number): Socket {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => {});
  socket.write(
    `POST /abandon HTTP/1.1\r\nHost: t\r\nContent-Type: multipart/form-data; boundary=${B}\r\n` +
      `Content-Length: ${longueur}\r\n\r\n${corps}`,
  );
  return socket;
}

async function connexionsFermees(): Promise<void> {
  await vi.waitFor(async () => {
    const n = await new Promise<number>((r, e) =>
      app.server.getConnections((err, c) => (err ? e(err) : r(c))),
    );
    expect(n).toBe(0);
  });
}

describe("multipart : client parti, temporaire toujours supprimé", () => {
  it("pendant la création du dossier temporaire (mkdtemp en cours)", async () => {
    const cree = differe<string>();
    const reprise = differe();
    const fini = differe();
    verrou.cree = cree.resoudre;
    verrou.attente = reprise.promesse;
    etat.fini = fini.resoudre;
    const socket = envoyer(TETE + "x".repeat(10), TETE.length + 1000 + FIN.length);
    const dossier = await cree.promesse;
    socket.destroy();
    await connexionsFermees();
    reprise.resoudre();
    await fini.promesse;
    await vi.waitFor(() => expect(existsSync(dossier)).toBe(false));
  });

  it("pendant l'envoi du fichier", async () => {
    const cree = differe<string>();
    const fini = differe();
    verrou.cree = cree.resoudre;
    etat.fini = fini.resoudre;
    const socket = envoyer(TETE + "x".repeat(10), TETE.length + 1000 + FIN.length);
    const dossier = await cree.promesse;
    socket.destroy();
    await fini.promesse;
    await vi.waitFor(() => expect(existsSync(dossier)).toBe(false));
  });

  it("corps reçu, traitement en cours : fichier gardé jusqu'à la fin du traitement, puis supprimé", async () => {
    const lu = differe<string | null>();
    const reprise = differe();
    const fini = differe();
    etat.lu = lu.resoudre;
    etat.traitement = reprise.promesse;
    etat.fini = fini.resoudre;
    const corps = TETE + "abc" + FIN;
    const socket = envoyer(corps, Buffer.byteLength(corps));
    const chemin = await lu.promesse;
    expect(chemin).not.toBeNull();
    socket.destroy();
    await connexionsFermees();
    expect(existsSync(chemin as string)).toBe(true);
    reprise.resoudre();
    await fini.promesse;
    await vi.waitFor(() => expect(existsSync(dirname(chemin as string))).toBe(false));
  });

  it("réponse envoyée normalement : dossier supprimé après la réponse", async () => {
    const lu = differe<string | null>();
    etat.lu = lu.resoudre;
    const corps = TETE + "abc" + FIN;
    const r = await app.inject({
      method: "POST",
      url: "/abandon",
      headers: { "content-type": `multipart/form-data; boundary=${B}` },
      payload: corps,
    });
    expect([r.statusCode, r.json()]).toEqual([200, { n: 1 }]);
    const chemin = await lu.promesse;
    await vi.waitFor(() => expect(existsSync(dirname(chemin as string))).toBe(false));
  });
});
