// SPDX-License-Identifier: MIT
/** apps/core/test/rag/extracteur.test.ts — client de l'extracteur : flux NDJSON morcelé, progression, erreurs classées (document, panne, douteux), jeton, délai et abandon. */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  delaiExtractionMs,
  ErreurExtraction,
  extraireDocument,
  lignesNdjson,
  lireBloc,
} from "../../src/rag/extracteur";

type Gestion = (req: IncomingMessage, res: ServerResponse, corps: unknown) => void | Promise<void>;

let serveur: Server;
let url: string;
let gestion: Gestion = (_q, r) => void r.end();
const recus: { corps: unknown; jeton: string }[] = [];

beforeAll(async () => {
  serveur = createServer((req, res) => {
    const morceaux: Buffer[] = [];
    req.on("data", (m: Buffer) => morceaux.push(m));
    req.on("end", () => {
      const corps = JSON.parse(Buffer.concat(morceaux).toString("utf8") || "null") as unknown;
      recus.push({ corps, jeton: String(req.headers["authorization"] ?? "") });
      void gestion(req, res, corps);
    });
  });
  await new Promise<void>((r) => serveur.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
});

afterAll(async () => {
  serveur.closeAllConnections();
  await new Promise<void>((r) => serveur.close(() => r()));
});

const ndjson = (res: ServerResponse): void =>
  void res.writeHead(200, { "content-type": "application/x-ndjson" });

async function erreur(p: Promise<unknown>): Promise<[string, string]> {
  try {
    await p;
    return ["", ""];
  } catch (e) {
    if (e instanceof ErreurExtraction) return [e.nature, e.code];
    throw e;
  }
}

describe("client de l'extracteur", () => {
  it("lit un résultat coupé en morceaux (UTF-8 à cheval), rapporte la progression, envoie jeton et chemin relatif", async () => {
    const resultat = Buffer.from(
      `${JSON.stringify({ type: "progress", done: 1, total: 2 })}\n` +
        `${JSON.stringify({
          type: "result",
          meta: { pages: 2, title: "Été", text_layer: true, mime: "application/pdf" },
          blocks: [
            { kind: "heading", text: "Résumé", level: 1, page: 1, boxes: [[1, 2, 3, 4]] },
            { kind: "paragraph", text: "Écrit à Noël — œuvre", page: 2, boxes: [[1, 2, 3], "x"] },
            { kind: "image", text: "ignoré" },
            { kind: "table", text: "| a |", sheet: "Ventes", slide: 0 },
          ],
          warnings: [{ code: "empty_pages", message: "Pages vides", pages: [3] }],
        })}\n`,
      "utf8",
    );
    gestion = async (_q, res) => {
      ndjson(res);
      for (let i = 0; i < resultat.length; i += 5) {
        res.write(resultat.subarray(i, i + 5));
        await new Promise((r) => setImmediate(r));
      }
      res.end();
    };
    const progres: [number, number][] = [];
    const r = await extraireDocument({
      source: "7/c/sources/d.pdf",
      ext: "pdf",
      ocr: true,
      url,
      jeton: "secret",
      surProgres: (a, b) => progres.push([a, b]),
    });
    expect(recus.at(-1)).toEqual({
      corps: { source: "7/c/sources/d.pdf", ext: "pdf", ocr: true },
      jeton: "Bearer secret",
    });
    expect(progres).toEqual([[1, 2]]);
    expect(r.meta).toEqual({ pages: 2, title: "Été", text_layer: true, mime: "application/pdf" });
    expect(r.blocs).toEqual([
      { kind: "heading", text: "Résumé", level: 1, page: 1, boxes: [[1, 2, 3, 4]] },
      { kind: "paragraph", text: "Écrit à Noël — œuvre", page: 2 },
      { kind: "table", text: "| a |", sheet: "Ventes" },
    ]);
    expect(r.avertissements).toEqual([{ code: "empty_pages", message: "Pages vides" }]);
  });

  it("OCR : réglages du modèle de vision envoyés avec `ocr` seulement, jamais sans adresse", async () => {
    gestion = (_q, res) => {
      ndjson(res);
      res.end(`${JSON.stringify({ type: "result", meta: {}, blocks: [], warnings: [] })}\n`);
    };
    const service = {
      url: "http://vision.lan:8090",
      model: "ocr",
      api_key: "cle-ocr",
      timeout_s: 60,
      max_side_px: 1024,
      max_tokens: 4096,
    };
    await extraireDocument({ source: "s.pdf", ext: "pdf", ocr: true, url, serviceOcr: service });
    expect(recus.at(-1)?.corps).toEqual({ source: "s.pdf", ext: "pdf", ocr: true, ocr_service: service });
    await extraireDocument({ source: "s.pdf", ext: "pdf", ocr: false, url, serviceOcr: service });
    expect(recus.at(-1)?.corps).toEqual({ source: "s.pdf", ext: "pdf", ocr: false });
    await extraireDocument({ source: "s.pdf", ext: "pdf", ocr: true, url, serviceOcr: null });
    expect(recus.at(-1)?.corps).toEqual({ source: "s.pdf", ext: "pdf", ocr: true });
  });

  it("ligne d'erreur : échec du document au code du contrat ; code inconnu ramené à corrupt", async () => {
    gestion = (_q, res) => {
      ndjson(res);
      res.end(`${JSON.stringify({ type: "error", code: "no_text", message: "Aucun texte." })}\n`);
    };
    expect(await erreur(extraireDocument({ source: "s", ext: "pdf", url }))).toEqual(["document", "no_text"]);
    gestion = (_q, res) => {
      ndjson(res);
      res.end(`${JSON.stringify({ type: "error", code: "bizarre", message: "?" })}\n`);
    };
    expect(await erreur(extraireDocument({ source: "s", ext: "pdf", url }))).toEqual(["document", "corrupt"]);
  });

  it("erreurs HTTP : 404 = source absente (document), 503 et 401 = panne ; service injoignable ou non configuré = panne", async () => {
    for (const [statut, attendu] of [
      [404, ["document", "source_missing"]],
      [400, ["document", "internal"]],
      [503, ["panne", "extractor_unavailable"]],
      [401, ["panne", "extractor_unavailable"]],
    ] as const) {
      gestion = (_q, res) =>
        void res.writeHead(statut, { "content-type": "application/json" }).end('{"detail":{"code":"x"}}');
      expect(await erreur(extraireDocument({ source: "s", ext: "pdf", url })), String(statut)).toEqual(
        attendu,
      );
    }
    expect(await erreur(extraireDocument({ source: "s", ext: "pdf", url: "http://127.0.0.1:9" }))).toEqual([
      "panne",
      "extractor_unavailable",
    ]);
    expect(await erreur(extraireDocument({ source: "s", ext: "pdf", url: "" }))).toEqual([
      "panne",
      "extractor_unavailable",
    ]);
  });

  it("flux sans résultat, ligne illisible, flux coupé, délai : douteux", async () => {
    gestion = (_q, res) => {
      ndjson(res);
      res.end(`${JSON.stringify({ type: "progress", done: 0, total: 1 })}\n`);
    };
    expect(await erreur(extraireDocument({ source: "s", ext: "pdf", url }))).toEqual(["douteux", "internal"]);
    gestion = (_q, res) => {
      ndjson(res);
      res.end("pas du json\n");
    };
    expect(await erreur(extraireDocument({ source: "s", ext: "pdf", url }))).toEqual(["douteux", "internal"]);
    gestion = async (_q, res) => {
      ndjson(res);
      res.write('{"type":"progress","done":0,"total":1}\n{"type":"res');
      await new Promise((r) => setTimeout(r, 20));
      res.destroy();
    };
    expect((await erreur(extraireDocument({ source: "s", ext: "pdf", url })))[0]).toBe("douteux");
    gestion = (_q, res) => {
      ndjson(res);
      res.write(`${JSON.stringify({ type: "progress", done: 0, total: 1 })}\n`);
    };
    expect(await erreur(extraireDocument({ source: "s", ext: "pdf", url, delaiMs: 150 }))).toEqual([
      "douteux",
      "timeout",
    ]);
  });

  it("abandon de l'appelant : relancé tel quel, jamais converti en erreur d'extraction", async () => {
    gestion = (_q, res) => {
      ndjson(res);
      res.write(`${JSON.stringify({ type: "progress", done: 0, total: 1 })}\n`);
    };
    const ctrl = new AbortController();
    const raison = new Error("suspendu");
    setTimeout(() => ctrl.abort(raison), 50);
    await expect(extraireDocument({ source: "s", ext: "pdf", url, signal: ctrl.signal })).rejects.toBe(
      raison,
    );
  });

  it("aides : lignes NDJSON, blocs mal formés, délai lu de l'environnement de l'extracteur", async () => {
    async function* morceaux(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("a\n\nb");
      yield Buffer.from("c\r\n");
      yield Buffer.from("d");
    }
    const lignes: string[] = [];
    for await (const l of lignesNdjson(morceaux())) lignes.push(l);
    expect(lignes).toEqual(["a", "bc", "d"]);
    expect(lireBloc({ kind: "paragraph" })).toBeNull();
    expect(lireBloc(null)).toBeNull();
    expect(lireBloc({ kind: "code", text: "x", level: -1, page: 1.5 })).toEqual({ kind: "code", text: "x" });
    expect(delaiExtractionMs({ RAG_EXTRACT_TIMEOUT_S: "120" })).toBe(180_000);
    expect(delaiExtractionMs({ RAG_EXTRACT_TIMEOUT_S: "abc" })).toBe(360_000);
    expect(delaiExtractionMs({})).toBe(360_000);
  });
});
