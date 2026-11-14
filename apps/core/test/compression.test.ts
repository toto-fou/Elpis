// SPDX-License-Identifier: MIT
/** apps/core/test/compression.test.ts — encodage négocié, variantes en mémoire, JSON compressé à la volée (même origine seulement), flux jamais compressés ni retardés. */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { SEUIL_JSON, VariantesEnMemoire, encodageAccepte } from "../src/interface/compression";
import type { DefinitionRoute } from "../src/routes";
import { appTest } from "./aides";

const MEME_ORIGINE = { "sec-fetch-site": "same-origin", "accept-encoding": "gzip, deflate, br, zstd" };
const gros = {
  messages: Array.from({ length: 400 }, (_, i) => ({
    role: "assistant",
    content: `Réponse ${i} détaillée.`,
  })),
};
const dossier = mkdtempSync(join(tmpdir(), "elpis-compression-"));
let app: FastifyInstance;

const attendre = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const r = (chemin: string, traiter: DefinitionRoute["traiter"]): DefinitionRoute => ({
    methode: "GET",
    chemin,
    processus: ["main"],
    acces: "public",
    traiter,
  });
  app = await appTest({
    familles: [
      {
        nom: "compression",
        routes: [
          r("/gros", (_q, rep) => rep.send(gros)),
          r("/petit", (_q, rep) => rep.send({ ok: true })),
          r("/joint", (_q, rep) => rep.header("content-disposition", "attachment").send(gros)),
          r("/etag", (_q, rep) => rep.header("etag", '"x"').send(gros)),
          r("/texte", (_q, rep) => rep.type("text/plain").send(JSON.stringify(gros))),
          r("/erreur", (_q, rep) => rep.code(500).send(gros)),
          r("/ndjson", (_q, rep) =>
            rep.type("application/x-ndjson").send(Readable.from([JSON.stringify(gros) + "\n"])),
          ),
          r("/flux", async (_q, rep) => {
            rep.hijack();
            rep.raw.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
            rep.raw.flushHeaders();
            for (let i = 0; i < 5; i++) {
              rep.raw.write(JSON.stringify({ i, texte: "x".repeat(SEUIL_JSON) }) + "\n");
              await attendre(60);
            }
            rep.raw.end();
          }),
        ],
      },
    ],
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await app.close();
  rmSync(dossier, { recursive: true, force: true });
});

describe("encodage accepté", () => {
  it("brotli puis gzip, q=0 refuse, * pour les absents, rien sinon", () => {
    expect(encodageAccepte(undefined)).toBeNull();
    expect(encodageAccepte("")).toBeNull();
    expect(encodageAccepte("identity")).toBeNull();
    expect(encodageAccepte("gzip, deflate")).toBe("gzip");
    expect(encodageAccepte("gzip, deflate, br, zstd")).toBe("br");
    expect(encodageAccepte("br;q=0, gzip")).toBe("gzip");
    expect(encodageAccepte("gzip;q=0")).toBeNull();
    expect(encodageAccepte("br;q=0.2, gzip;q=0.9")).toBe("gzip");
    expect(encodageAccepte("GZIP;Q=0.5, BR;Q=0.8")).toBe("br");
    expect(encodageAccepte("*")).toBe("br");
    expect(encodageAccepte("*;q=0, gzip")).toBe("gzip");
    expect(encodageAccepte("br;q=abc, gzip")).toBe("gzip");
  });
});

describe("variantes en mémoire", () => {
  it("compressées une fois par version, recalculées quand le fichier change, bornées en octets", async () => {
    const f = join(dossier, "a.css");
    writeFileSync(f, "a{color:red}\n".repeat(400));
    const st = (taille: number, ms: number) => ({ mtimeMs: ms, size: taille });
    const v = new VariantesEnMemoire();
    const premier = await v.obtenir(f, st(5200, 1), "gzip");
    expect(gunzipSync(premier).toString()).toBe("a{color:red}\n".repeat(400));
    expect(await v.obtenir(f, st(5200, 1), "gzip")).toBe(premier);
    writeFileSync(f, "b{color:blue}\n".repeat(400));
    utimesSync(f, new Date(), new Date(Date.now() + 5_000));
    const neuf = await v.obtenir(f, st(5600, 2), "br");
    expect(brotliDecompressSync(neuf).toString()).toBe("b{color:blue}\n".repeat(400));
    const petite = new VariantesEnMemoire(premier.length + 1);
    const a = await petite.obtenir(f, st(5600, 2), "gzip");
    await petite.obtenir(f, st(5600, 2), "br");
    expect(await petite.obtenir(f, st(5600, 2), "gzip")).not.toBe(a);
  });

  it("requêtes simultanées à froid : une seule compression ; un échec n'est pas gardé", async () => {
    const f = join(dossier, "simultanee.css");
    writeFileSync(f, "c{margin:0}\n".repeat(2000));
    const v = new VariantesEnMemoire();
    const lot = await Promise.all(
      Array.from({ length: 12 }, () => v.obtenir(f, { mtimeMs: 3, size: 24000 }, "br")),
    );
    expect(lot.every((c) => c === lot[0])).toBe(true);
    const absent = join(dossier, "absent.css");
    await expect(v.obtenir(absent, { mtimeMs: 4, size: 10 }, "gzip")).rejects.toThrow();
    writeFileSync(absent, "d{}\n".repeat(500));
    expect(gunzipSync(await v.obtenir(absent, { mtimeMs: 4, size: 10 }, "gzip")).toString()).toBe(
      "d{}\n".repeat(500),
    );
  });
});

describe("JSON compressé à la volée", () => {
  it("gros corps JSON de même origine : brotli ou gzip selon Accept-Encoding, Vary, longueur juste", async () => {
    for (const [accepte, decoder] of [
      ["gzip, deflate, br", brotliDecompressSync],
      ["gzip, deflate", gunzipSync],
    ] as const) {
      const r = await app.inject({
        method: "GET",
        url: "/gros",
        headers: { ...MEME_ORIGINE, "accept-encoding": accepte },
      });
      expect(r.headers["content-encoding"], accepte).toBe(accepte.includes("br") ? "br" : "gzip");
      expect(String(r.headers["vary"])).toContain("Accept-Encoding");
      expect(Number(r.headers["content-length"])).toBe(r.rawPayload.length);
      expect(r.rawPayload.length).toBeLessThan(JSON.stringify(gros).length / 4);
      expect(JSON.parse(decoder(r.rawPayload).toString())).toEqual(gros);
    }
  });

  it("jamais : inter-site ou sans Sec-Fetch-Site (BREACH), petit, plage, pièce jointe, ETag, autre type, erreur, sans encodage accepté", async () => {
    const cas: [string, Record<string, string>][] = [
      ["/gros", { ...MEME_ORIGINE, "sec-fetch-site": "cross-site" }],
      ["/gros", { ...MEME_ORIGINE, "sec-fetch-site": "same-site" }],
      ["/gros", { "accept-encoding": "gzip, br" }],
      ["/gros", { ...MEME_ORIGINE, range: "bytes=0-10" }],
      ["/gros", { ...MEME_ORIGINE, "accept-encoding": "identity" }],
      ["/petit", MEME_ORIGINE],
      ["/joint", MEME_ORIGINE],
      ["/etag", MEME_ORIGINE],
      ["/texte", MEME_ORIGINE],
      ["/erreur", MEME_ORIGINE],
      ["/ndjson", MEME_ORIGINE],
    ];
    for (const [url, headers] of cas) {
      const r = await app.inject({ method: "GET", url, headers });
      expect(r.headers["content-encoding"], `${url} ${JSON.stringify(headers)}`).toBeUndefined();
    }
  });

  it("flux écrit à la main : ni compressé, ni retenu (chaque ligne arrive à son écriture)", async () => {
    const { port } = app.server.address() as AddressInfo;
    const arrivees = await new Promise<{ encodage: string | undefined; t: number[] }>((ok, ko) => {
      const t0 = performance.now();
      const req = request({ host: "127.0.0.1", port, path: "/flux", headers: MEME_ORIGINE }, (res) => {
        const t: number[] = [];
        res.on("data", () => t.push(performance.now() - t0));
        res.on("end", () => ok({ encodage: res.headers["content-encoding"], t }));
      });
      req.on("error", ko);
      req.end();
    });
    expect(arrivees.encodage).toBeUndefined();
    expect(arrivees.t.length).toBeGreaterThanOrEqual(5);
    expect(arrivees.t[0]).toBeLessThan(200);
    expect(arrivees.t[arrivees.t.length - 1]! - arrivees.t[0]!).toBeGreaterThanOrEqual(200);
  });
});
