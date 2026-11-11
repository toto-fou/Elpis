// SPDX-License-Identifier: MIT
/** apps/core/test/outils.test.ts — `POST /api/tools/extract-text` rejoué contre le routeur Python (vecteurs) ; garde avant le formulaire. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { HttpError } from "@elpis/commun";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { familleOutils } from "../src/familles/outils";
import { appTest } from "./aides";

interface Partie {
  nom: string;
  fichier: string | null;
  type: string | null;
  hex: string | [string, number];
}

const V = JSON.parse(readFileSync(new URL("./vecteurs/outils.json", import.meta.url), "utf-8")) as {
  borne: string;
  etapes: Partie[][];
  reponses: { statut: number; corps?: string; empreinte?: string; taille?: number }[];
};

function corps(parties: Partie[]): Buffer {
  const morceaux: Buffer[] = [];
  for (const p of parties) {
    let entete = `Content-Disposition: form-data; name="${p.nom}"`;
    if (p.fichier !== null) entete += `; filename="${p.fichier}"`;
    if (p.type !== null) entete += `\r\nContent-Type: ${p.type}`;
    const motif = Buffer.from(Array.isArray(p.hex) ? p.hex[0] : p.hex, "hex");
    const contenu = Array.isArray(p.hex) ? Buffer.alloc(motif.length * p.hex[1], motif) : motif;
    morceaux.push(Buffer.from(`--${V.borne}\r\n${entete}\r\n\r\n`, "utf-8"), contenu, Buffer.from("\r\n"));
  }
  morceaux.push(Buffer.from(`--${V.borne}--\r\n`));
  return Buffer.concat(morceaux);
}

describe("POST /api/tools/extract-text", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await appTest({
      familles: [familleOutils],
      gardes: {
        session: (req) => {
          if (req.headers["x-uid"] === undefined) throw new HttpError(401, "not logged in");
          req.utilisateur = { id: Number(req.headers["x-uid"]), username: null };
        },
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("rend les mêmes réponses que FastAPI, au texte près (vecteurs)", async () => {
    for (const [i, parties] of V.etapes.entries()) {
      const r = await app.inject({
        method: "POST",
        url: "/api/tools/extract-text",
        headers: { "x-uid": "1", "content-type": `multipart/form-data; boundary=${V.borne}` },
        payload: corps(parties),
      });
      const attendu = V.reponses[i];
      expect(r.statusCode, `étape ${i}`).toBe(attendu?.statut);
      if (attendu?.corps !== undefined) expect(r.body, `étape ${i}`).toBe(attendu.corps);
      else {
        expect(r.rawPayload.length, `étape ${i}`).toBe(attendu?.taille);
        expect(createHash("sha256").update(r.rawPayload).digest("hex"), `étape ${i}`).toBe(
          attendu?.empreinte,
        );
      }
    }
  });

  it("un anonyme est refusé avant la lecture du formulaire (E15)", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/tools/extract-text",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: "pas un formulaire",
    });
    expect(r.statusCode).toBe(401);
  });
});
