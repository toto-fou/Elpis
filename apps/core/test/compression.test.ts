// SPDX-License-Identifier: MIT
/** apps/core/test/compression.test.ts — encodage négocié, variantes en mémoire, JSON compressé à la volée (nos pages seulement : Fetch Metadata, ou Referer en HTTP direct), flux jamais compressés ni retardés. */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { surchargerConfig } from "@elpis/config";

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

describe("HTTP direct, sans Fetch Metadata (installation par défaut sur le réseau local)", () => {
  const LAN = { host: "lan.test:8001", referer: "http://lan.test:8001/", "accept-encoding": "gzip, deflate" };
  const depuis = (headers: Record<string, string>, remoteAddress = "192.168.1.20") =>
    app.inject({ method: "GET", url: "/gros", headers, remoteAddress });

  it("Referer d'une de nos pages, connexion en clair sans mandataire : compressé", async () => {
    for (const referer of [
      "http://lan.test:8001/",
      "http://lan.test:8001/admin",
      "http://lan.test:8001/?x=1",
    ]) {
      const r = await depuis({ ...LAN, referer });
      expect(r.headers["content-encoding"], referer).toBe("gzip");
      expect(JSON.parse(gunzipSync(r.rawPayload).toString())).toEqual(gros);
    }
  });

  it("jamais : sans Referer, autre hôte ou page, HTTPS annoncé, en-tête de relais, boucle locale, Sec-Fetch-Site inter-site", async () => {
    const sans = { host: LAN.host, "accept-encoding": LAN["accept-encoding"] };
    const cas: [Record<string, string>, string?][] = [
      [sans],
      [{ ...LAN, referer: "http://autre.test:8001/" }],
      [{ ...LAN, referer: "http://lan.test:8002/" }],
      [{ ...LAN, referer: "http://lan.test:8001/apercu-code" }],
      [{ ...LAN, referer: "https://lan.test:8001/" }],
      [{ ...LAN, referer: "pas une url" }],
      [{ ...LAN, "x-forwarded-for": "10.0.0.9" }],
      [{ ...LAN, "x-forwarded-proto": "https" }],
      [{ ...LAN, forwarded: "for=10.0.0.9;proto=https" }],
      [{ ...LAN, via: "1.1 frontal" }],
      [{ ...LAN, "x-real-ip": "10.0.0.9" }],
      [{ ...LAN, "sec-fetch-site": "cross-site" }],
      [LAN, "127.0.0.1"],
      [LAN, "::1"],
      [LAN, "::ffff:127.0.0.1"],
    ];
    for (const [headers, pair] of cas) {
      const r = await depuis(headers, pair);
      expect(
        [r.statusCode, r.headers["content-encoding"]],
        `${JSON.stringify(headers)} ${pair ?? ""}`,
      ).toEqual([200, undefined]);
    }
  });

  it("frontal configuré (security.https) ou mandataire de confiance : Sec-Fetch-Site seul", async () => {
    const chemin = join(dossier, "config-https.json");
    writeFileSync(chemin, JSON.stringify({ security: { https: { enabled: true } } }));
    const restaurer = surchargerConfig({ CONFIG_JSON_PATH: chemin });
    try {
      expect((await depuis(LAN)).headers["content-encoding"]).toBeUndefined();
      expect((await depuis({ ...LAN, "sec-fetch-site": "same-origin" })).headers["content-encoding"]).toBe(
        "gzip",
      );
    } finally {
      restaurer();
    }
    const avant = process.env["ACCESS_LOG_TRUSTED_PROXIES"];
    process.env["ACCESS_LOG_TRUSTED_PROXIES"] = "192.168.1.0/24";
    const derriere = await appTest({
      familles: [
        {
          nom: "derriere",
          routes: [
            {
              methode: "GET",
              chemin: "/gros",
              processus: ["main"],
              acces: "public",
              traiter: (_q, rep) => rep.send(gros),
            },
          ],
        },
      ],
    });
    try {
      const r = await derriere.inject({
        method: "GET",
        url: "/gros",
        headers: LAN,
        remoteAddress: "192.168.1.20",
      });
      expect(r.headers["content-encoding"]).toBeUndefined();
    } finally {
      await derriere.close();
      if (avant === undefined) delete process.env["ACCESS_LOG_TRUSTED_PROXIES"];
      else process.env["ACCESS_LOG_TRUSTED_PROXIES"] = avant;
    }
  });
});
