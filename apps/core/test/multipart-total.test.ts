// SPDX-License-Identifier: MIT
/** apps/core/test/multipart-total.test.ts — total d'un formulaire multipart borné au plafond du corps (plus le plafond par fichier de la route) : 413, temporaires supprimés, connexion fermée. */
import { existsSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Famille } from "../src/routes";
import { appTest } from "./aides";
import { lireFormulaire } from "@elpis/http";
import type { OptionsFormulaire } from "@elpis/http";

const B = "----limite-total";
const KIO = 1024;
const temporaires: string[] = [];

/** Corps multipart : `fichiers` et `champs` de `taille` octets chacun. */
function corps(fichiers: number, champs: number, taille: number): Buffer {
  const morceaux: Buffer[] = [];
  for (let i = 0; i < fichiers; i++)
    morceaux.push(
      Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="f${i}"; filename="f${i}.bin"\r\n\r\n`),
      Buffer.alloc(taille, "f"),
      Buffer.from("\r\n"),
    );
  for (let i = 0; i < champs; i++)
    morceaux.push(
      Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="c${i}"\r\n\r\n`),
      Buffer.alloc(taille, "c"),
      Buffer.from("\r\n"),
    );
  morceaux.push(Buffer.from(`--${B}--\r\n`));
  return Buffer.concat(morceaux);
}

function route(chemin: string, options: OptionsFormulaire): Famille["routes"][number] {
  return {
    methode: "POST",
    chemin,
    processus: ["main"],
    acces: "public",
    traiter: async (req) => {
      const f = await lireFormulaire(req, options);
      for (const [, v] of f.entrees) if (typeof v !== "string") temporaires.push(v.chemin);
      return { n: f.entrees.length };
    },
  };
}

const famille: Famille = {
  nom: "total",
  routes: [
    route("/defaut", {}),
    route("/route", { limiteFichier: 3 * 1024 * KIO }),
    route("/infini", { limiteTotale: Number.POSITIVE_INFINITY }),
  ],
};

let app: FastifyInstance;
let port = 0;

beforeAll(async () => {
  app = await appTest({ familles: [famille], limiteCorps: 1024 * KIO });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await app.close();
});

/** Envoi sur une vraie socket gardée ouverte : statut, en-tête `connection`, socket fermée par le serveur. */
function envoyer(
  chemin: string,
  charge: Buffer,
): Promise<{ statut: number; connexion: string; fermee: boolean }> {
  return new Promise((fini, echec) => {
    const q = request(
      {
        port,
        host: "127.0.0.1",
        method: "POST",
        path: chemin,
        headers: { "content-type": `multipart/form-data; boundary=${B}`, "content-length": charge.length },
        agent: false,
      },
      (r) => {
        r.resume();
        r.on("end", () => {
          const s = q.socket;
          const etat = { statut: r.statusCode ?? 0, connexion: String(r.headers.connection) };
          if (s === null || s.destroyed) return fini({ ...etat, fermee: true });
          s.once("close", () => fini({ ...etat, fermee: true }));
        });
      },
    );
    q.on("error", (e: NodeJS.ErrnoException) =>
      e.code === "EPIPE" || e.code === "ECONNRESET" ? undefined : echec(e),
    );
    q.end(charge);
  });
}

describe("multipart : taille totale bornée", () => {
  it("fichiers ou champs réunis au-delà du plafond du corps : 413, connexion fermée", async () => {
    for (const charge of [corps(3, 0, 600 * KIO), corps(0, 3, 600 * KIO)]) {
      const r = await envoyer("/defaut", charge);
      expect(r).toEqual({ statut: 413, connexion: "close", fermee: true });
    }
  });

  it("sous le plafond, plafond par fichier de la route ajouté, total infini : formulaire lu, temporaires supprimés", async () => {
    const inj = (url: string, charge: Buffer) =>
      app.inject({
        method: "POST",
        url,
        headers: { "content-type": `multipart/form-data; boundary=${B}` },
        payload: charge,
      });
    expect((await inj("/defaut", corps(1, 1, 400 * KIO))).json()).toEqual({ n: 2 });
    expect((await inj("/route", corps(1, 0, 2 * 1024 * KIO))).json()).toEqual({ n: 1 });
    expect((await inj("/route", corps(2, 0, 2560 * KIO))).statusCode).toBe(413);
    expect((await inj("/infini", corps(3, 0, 600 * KIO))).json()).toEqual({ n: 3 });
    await vi.waitFor(() => expect(temporaires.filter((t) => existsSync(t))).toEqual([]));
  });
});
