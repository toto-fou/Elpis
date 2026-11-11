// SPDX-License-Identifier: MIT
/** apps/core/test/multipart.test.ts — formulaires multipart rejoués contre FastAPI (UploadFile, Form) : limites, 400, 422, copie plafonnée. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Famille } from "../src/routes";
import { appTest } from "./aides";
import { corpsJson, enregistrerBorne, lireFormulaire, valeursFormulaire } from "@elpis/http";

type Partie = {
  nom: string;
  valeur: string | { motif: string; fois: number };
  filename: string | null;
  ct: string | null;
  extra: string;
  fois: number;
};
interface Cas {
  nom: string;
  url: string;
  entetes: Record<string, string>;
  brut?: string;
  brut_hex?: string;
  prefixe?: string;
  parties?: Partie[];
  fin?: boolean;
  statut: number;
  reponse: unknown;
}

const V = JSON.parse(readFileSync(new URL("./vecteurs/multipart.json", import.meta.url), "utf-8")) as {
  boundary: string;
  cas: Cas[];
};

function corps(c: Cas): Buffer {
  if (c.brut !== undefined) return Buffer.from(c.brut, "utf8");
  if (c.brut_hex !== undefined) return Buffer.from(c.brut_hex, "hex");
  const morceaux: Buffer[] = [Buffer.from(c.prefixe ?? "")];
  for (const p of c.parties ?? []) {
    for (let i = 0; i < p.fois; i++) {
      let h = `Content-Disposition: form-data; name="${p.nom.replace("{i}", String(i))}"`;
      if (p.filename !== null) h += `; filename="${p.filename.replace("{i}", String(i))}"`;
      h += p.extra;
      if (p.ct) h += `\r\nContent-Type: ${p.ct}`;
      const valeur =
        typeof p.valeur === "string"
          ? Buffer.from(p.valeur, "utf8")
          : Buffer.from(p.valeur.motif.repeat(p.valeur.fois), "latin1");
      morceaux.push(Buffer.from(`--${V.boundary}\r\n${h}\r\n\r\n`), valeur, Buffer.from("\r\n"));
    }
  }
  if (c.fin !== false) morceaux.push(Buffer.from(`--${V.boundary}--\r\n`));
  return Buffer.concat(morceaux);
}

const manquant = (nom: string) => ({
  type: "missing",
  loc: ["body", nom],
  msg: "Field required",
  input: null,
});

/** Écarts connus de busboy : type absent = text/plain, nom non UTF-8 en U+FFFD, parties non form-data ignorées, préambule toléré, corps tronqué. */
const ECARTS: Record<string, (c: Cas) => [number, unknown]> = {
  mille_fichiers: (c) => [c.statut, { ...(c.reponse as object), content_type: "text/plain" }],
  sans_fin_apres_partie_complete: () => [422, { detail: [manquant("file"), manquant("nom")] }],
  nom_fichier_latin1: (c) => [c.statut, { ...(c.reponse as object), filename: "\ufffdt\ufffd.png" }],
  attachment: () => [422, { detail: [manquant("file")] }],
  preambule: () => [200, { filename: "a.png", content_type: "image/png", taille: 3, debut: "YWJj" }],
};

const famille: Famille = {
  nom: "formulaires",
  routes: [
    {
      methode: "POST",
      chemin: "/f",
      processus: ["main"],
      acces: "public",
      traiter: async (req) => {
        const { file } = valeursFormulaire(await lireFormulaire(req), {
          file: { type: "fichier", requis: true },
        });
        const data = await readFile(file.chemin);
        return {
          filename: file.filename,
          content_type: file.contentType,
          taille: data.length,
          debut: data.subarray(0, 16).toString("base64"),
        };
      },
    },
    {
      methode: "POST",
      chemin: "/f2",
      processus: ["main"],
      acces: "public",
      traiter: async (req) => {
        const v = valeursFormulaire(await lireFormulaire(req), {
          file: { type: "fichier", requis: true },
          nom: { type: "texte", requis: true },
        });
        return { filename: v.file.filename, nom: v.nom.slice(0, 20), taille_nom: v.nom.length };
      },
    },
    {
      methode: "POST",
      chemin: "/opt",
      processus: ["main"],
      acces: "public",
      traiter: async (req) => {
        const { file } = valeursFormulaire(await lireFormulaire(req), {
          file: { type: "fichier", requis: false },
        });
        return { file: file === null ? null : file.filename };
      },
    },
    {
      methode: "POST",
      chemin: "/json",
      processus: ["main"],
      acces: "public",
      traiter: (req) => ({ recu: corpsJson(req), octets: req.corpsBrut.length }),
    },
    {
      methode: "POST",
      chemin: "/copie",
      processus: ["main"],
      acces: "public",
      traiter: async (req) => {
        const { file } = valeursFormulaire(await lireFormulaire(req), {
          file: { type: "fichier", requis: true },
        });
        const destination = join(String(req.headers["x-dossier"]), "copie.bin");
        return { octets: await enregistrerBorne(file, destination, 5 * 1024 * 1024), chemin: file.chemin };
      },
    },
  ],
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await appTest({ familles: [famille] });
});

afterAll(async () => {
  await app.close();
});

describe("multipart : vecteurs FastAPI 0.136 / Starlette 1.0", () => {
  it.each(V.cas.map((c) => [c.nom, c] as const))("%s", async (_n, c) => {
    const r = await app.inject({ method: "POST", url: c.url, headers: c.entetes, payload: corps(c) });
    expect([r.statusCode, r.json()]).toEqual(ECARTS[c.nom]?.(c) ?? [c.statut, c.reponse]);
  });
});

describe("fichiers temporaires et copie plafonnée", () => {
  const fichier = (taille: number): Cas => ({
    nom: "copie",
    url: "/copie",
    entetes: { "content-type": `multipart/form-data; boundary=${V.boundary}` },
    parties: [
      {
        nom: "file",
        valeur: { motif: "z", fois: taille },
        filename: "a.bin",
        ct: "application/octet-stream",
        extra: "",
        fois: 1,
      },
    ],
    statut: 0,
    reponse: null,
  });

  it("copie sous le plafond, temporaire supprimé après la réponse", async () => {
    const dossier = mkdtempSync(join(tmpdir(), "elpis-copie-"));
    try {
      const c = fichier(1000);
      const r = await app.inject({
        method: "POST",
        url: c.url,
        headers: { ...c.entetes, "x-dossier": dossier },
        payload: corps(c),
      });
      expect(r.statusCode).toBe(200);
      const { octets, chemin } = r.json<{ octets: number; chemin: string }>();
      expect(octets).toBe(1000);
      expect(readFileSync(join(dossier, "copie.bin"), "latin1")).toBe("z".repeat(1000));
      await vi.waitFor(() => expect(existsSync(chemin)).toBe(false));
    } finally {
      rmSync(dossier, { recursive: true, force: true });
    }
  });

  it("au-delà du plafond : 413 en Mo entiers, rien sur le disque", async () => {
    const dossier = mkdtempSync(join(tmpdir(), "elpis-copie-"));
    try {
      const c = fichier(5 * 1024 * 1024 + 1);
      const r = await app.inject({
        method: "POST",
        url: c.url,
        headers: { ...c.entetes, "x-dossier": dossier },
        payload: corps(c),
      });
      expect([r.statusCode, r.json()]).toEqual([
        413,
        { detail: "Fichier trop volumineux (plafond : 5 Mo)." },
      ]);
      expect(existsSync(join(dossier, "copie.bin"))).toBe(false);
    } finally {
      rmSync(dossier, { recursive: true, force: true });
    }
  });
});

describe("cohabitation avec le lecteur de corps", () => {
  const mp = { "content-type": `multipart/form-data; boundary=${V.boundary}` };
  const partie = (nom: string, valeur: string, ct = ""): Partie => ({
    nom,
    valeur,
    filename: null,
    ct,
    extra: "",
    fois: 1,
  });

  it("un corps JSON reste en octets ; un multipart envoyé à une route JSON donne le 400 de request.json()", async () => {
    const j = await app.inject({
      method: "POST",
      url: "/json",
      headers: { "content-type": "application/json" },
      payload: '{"a": 1}',
    });
    expect(j.json()).toEqual({ recu: { a: 1 }, octets: 8 });
    const m = await app.inject({
      method: "POST",
      url: "/json",
      headers: mp,
      payload: corps({ ...fichierVide, parties: [partie("a", "b")] }),
    });
    expect(m.statusCode).toBe(400);
    expect(m.json<{ detail: string }>().detail).toMatch(/^Corps JSON invalide/u);
  });

  it("écarts de busboy : type de partie normalisé (IMAGE/PNG), Content-Length de partie ignoré par la copie plafonnée", async () => {
    const brut = (entetesPartie: string) =>
      Buffer.from(
        `--${V.boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n${entetesPartie}\r\n\r\nabc\r\n--${V.boundary}--\r\n`,
      );
    const type = await app.inject({
      method: "POST",
      url: "/f",
      headers: mp,
      payload: brut("Content-Type: IMAGE/PNG"),
    });
    expect(type.json<{ content_type: string }>().content_type).toBe("image/png");
    const dossier = mkdtempSync(join(tmpdir(), "elpis-copie-"));
    try {
      const longueur = await app.inject({
        method: "POST",
        url: "/copie",
        headers: { ...mp, "x-dossier": dossier },
        payload: brut("Content-Type: image/png\r\nContent-Length: 99999999"),
      });
      expect(longueur.json<{ octets: number }>().octets).toBe(3);
    } finally {
      rmSync(dossier, { recursive: true, force: true });
    }
  });

  it("écarts de @fastify/multipart : champ typé JSON relu, nom de champ du prototype refusé (400)", async () => {
    const json = await app.inject({
      method: "POST",
      url: "/f2",
      headers: mp,
      payload: corps({
        ...fichierVide,
        parties: [
          { ...partie("file", "a"), filename: "a.png" },
          partie("nom", '{"a": 1}', "application/json"),
        ],
      }),
    });
    expect(json.json()).toEqual({ filename: "a.png", nom: '{"a":1}', taille_nom: 7 });
    const proto = await app.inject({
      method: "POST",
      url: "/opt",
      headers: mp,
      payload: corps({ ...fichierVide, parties: [partie("constructor", "x")] }),
    });
    expect([proto.statusCode, proto.json()]).toEqual([
      400,
      { detail: "There was an error parsing the body" },
    ]);
  });
});

const fichierVide: Cas = { nom: "", url: "", entetes: {}, statut: 0, reponse: null };
