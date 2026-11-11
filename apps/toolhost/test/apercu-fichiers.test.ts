// SPDX-License-Identifier: MIT
/** apps/toolhost/test/apercu-fichiers.test.ts — aperçu des fichiers du bac (pv) sur un agent en mémoire : ETag, 304, plages, réécriture, résolveur, origine opaque, fichier changé, agent indisponible. */
import type { Dict } from "@elpis/commun";
import { AgentError } from "@elpis/fichiers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerFamilleApercuFichiers } from "../src/apercu-fichiers";
import type { BacDuCompte } from "../src/apercu-fichiers";
import { creerAppToolhost } from "../src/app";
import { BLOC_REPONSE, entetesSecurite, etagAgent } from "../src/reponse-agent";
import type { AgentLecture } from "../src/reponse-agent";
import { configTest, entetes, journalMuet } from "./aides";

/** Agent en mémoire : fichiers `rel → octets`, version (mtime, inode) par fichier, refus `changed` programmables. */
class AgentMemoire implements AgentLecture {
  readonly fichiers = new Map<string, { octets: Buffer; ns: bigint; ino: number }>();
  readonly dossiers = new Set<string>(["site"]);
  changements = 0;
  lectures = 0;

  ecrire(rel: string, contenu: string | Buffer, ns = 1_700_000_000_123_456_789n, ino = 42): void {
    this.fichiers.set(rel, { octets: Buffer.from(contenu), ns, ino });
  }

  async stat(paths: Iterable<string>): Promise<Dict[]> {
    return [...paths].map((p) => {
      const f = this.fichiers.get(p);
      if (f) return { entry: p, kind: "file", size: f.octets.length, mtime_ns: f.ns, ino: f.ino };
      return this.dossiers.has(p) ? { entry: p, kind: "dir" } : { entry: p, kind: null };
    });
  }

  async read(
    p: string,
    o: { offset?: number; length?: number; maxBytes?: number; expectSize?: number | bigint } = {},
  ): Promise<{ data: Buffer; stat: Dict }> {
    this.lectures++;
    if (this.changements > 0) {
      this.changements--;
      throw new AgentError("changed", "fichier changé");
    }
    const f = this.fichiers.get(p);
    if (!f) throw new AgentError("not_found", p);
    const debut = o.offset ?? 0;
    const fin = o.length === undefined ? f.octets.length : debut + o.length;
    return { data: f.octets.subarray(debut, Math.min(fin, debut + (o.maxBytes ?? 64 << 20))), stat: {} };
  }
}

describe("aperçu des fichiers du bac (pv)", () => {
  const agent = new AgentMemoire();
  const bac: BacDuCompte = { racine: async () => "/srv/sb/hugo/work", agent: async () => agent };
  let app: FastifyInstance;
  const pv = (reste: string): string => `/api/sandbox/pv/7-1-0123456789abcdef0123456789abcdef/${reste}`;

  beforeAll(async () => {
    agent.ecrire("data.json", '{"a":1}');
    agent.ecrire("site/index.html", '<html><head><link href="/style.css"></head></html>');
    agent.ecrire("site/style.css", "body{background:url(/img/fond.png)}");
    agent.ecrire("img/fond.png", Buffer.from("89504e47", "hex"));
    agent.ecrire("dessin.svg", "<svg/>");
    agent.ecrire("doc.pdf", "%PDF-1.4");
    agent.ecrire("gros.bin", Buffer.alloc(BLOC_REPONSE * 2 + 5, 7));
    app = await creerAppToolhost({
      tc: configTest(),
      familles: [creerFamilleApercuFichiers(bac)],
      journal: journalMuet,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("fichier servi par l'agent : ETag, Last-Modified, plages acceptées, revalidation, nosniff, CORS `*`", async () => {
    const r = await app.inject({ url: pv("data.json"), headers: entetes() });
    expect([r.statusCode, r.body]).toEqual([200, '{"a":1}']);
    expect(r.headers).toMatchObject({
      "content-type": "application/json",
      "content-length": "7",
      etag: etagAgent(7, 1_700_000_000_123_456_789n, 42),
      "last-modified": "Tue, 14 Nov 2023 22:13:20 GMT",
      "accept-ranges": "bytes",
      "cache-control": "no-cache, must-revalidate",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
    });
    expect(r.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
  });

  it("304 sur If-None-Match, 206 d'une plage, 416 hors du fichier, If-Range périmé : fichier entier", async () => {
    const etag = etagAgent(7, 1_700_000_000_123_456_789n, 42);
    const n = await app.inject({
      url: pv("data.json"),
      headers: { ...entetes(), "if-none-match": `"x", ${etag}` },
    });
    expect([n.statusCode, n.body, n.headers["access-control-allow-origin"]]).toEqual([304, "", "*"]);
    const p = await app.inject({ url: pv("data.json"), headers: { ...entetes(), range: "bytes=1-3" } });
    expect([p.statusCode, p.body, p.headers["content-range"]]).toEqual([206, '"a"', "bytes 1-3/7"]);
    const h = await app.inject({ url: pv("data.json"), headers: { ...entetes(), range: "bytes=9-" } });
    expect([h.statusCode, h.headers["content-range"], h.body]).toEqual([416, "bytes */7", ""]);
    const i = await app.inject({
      url: pv("data.json"),
      headers: { ...entetes(), range: "bytes=1-3", "if-range": '"ancien"' },
    });
    expect([i.statusCode, i.body]).toEqual([200, '{"a":1}']);
  });

  it("HTML et CSS réécrits vers le résolveur ; types actifs (tout `*+xml` compris) en origine opaque, PDF sans `sandbox`", async () => {
    const h = await app.inject({ url: pv("site/index.html"), headers: entetes() });
    expect(h.statusCode).toBe(200);
    expect(h.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(h.headers["content-security-policy"]).toBe(
      "sandbox allow-scripts allow-forms allow-popups allow-modals",
    );
    expect(h.body).toContain(
      'href="/api/sandbox/pv/7-1-0123456789abcdef0123456789abcdef/~r/dsite/style.css"',
    );
    expect(h.body).toContain(
      '})("/api/sandbox/pv/7-1-0123456789abcdef0123456789abcdef/~r/dsite/");</script>',
    );
    const c = await app.inject({ url: pv("site/style.css"), headers: entetes() });
    expect(c.body).toBe(
      "body{background:url(/api/sandbox/pv/7-1-0123456789abcdef0123456789abcdef/~r/dsite/img/fond.png)}",
    );
    const s = await app.inject({ url: pv("dessin.svg"), headers: entetes() });
    expect(s.headers["content-security-policy"]).toMatch(/^sandbox /u);
    for (const [type, actif] of [
      ["application/rss+xml", true],
      ["application/xslt+xml; charset=utf-8", true],
      [" Application/Atom+XML ", true],
      ["text/xsl", true],
      ["application/json", false],
      ["image/png", false],
    ] as const) {
      const h: Record<string, string> = {};
      entetesSecurite(h, type);
      expect([type, h["content-security-policy"] !== undefined, h["x-content-type-options"]]).toEqual([
        type,
        actif,
        "nosniff",
      ]);
    }
    const d = await app.inject({ url: pv("doc.pdf"), headers: entetes() });
    expect([d.headers["content-type"], d.headers["content-security-policy"]]).toEqual([
      "application/pdf",
      "frame-ancestors 'self'",
    ]);
  });

  it("résolveur : cherché dans le dossier du document puis en remontant ; introuvable, dossier ou hors du bac : 404", async () => {
    const r = await app.inject({ url: pv("~r/dsite/img/fond.png"), headers: entetes() });
    expect([r.statusCode, r.headers["content-type"]]).toEqual([200, "image/png"]);
    for (const reste of [
      "~r/dsite/absent.png",
      "~r/x/y",
      "absent",
      "site",
      "..%2F..%2Fetc%2Fpasswd",
      "~r/d",
    ]) {
      const n = await app.inject({ url: pv(reste), headers: entetes() });
      expect([reste, n.statusCode, n.json()]).toEqual([reste, 404, { detail: "Not found" }]);
    }
  });

  it("gros fichier lu par blocs ; changé avant l'envoi : repris une fois, encore changé : 503 Retry-After", async () => {
    const g = await app.inject({ url: pv("gros.bin"), headers: entetes() });
    expect([g.statusCode, g.rawPayload.length]).toEqual([200, BLOC_REPONSE * 2 + 5]);
    agent.changements = 1;
    const un = await app.inject({ url: pv("data.json"), headers: entetes() });
    expect([un.statusCode, un.body]).toEqual([200, '{"a":1}']);
    agent.changements = 2;
    const deux = await app.inject({ url: pv("data.json"), headers: entetes() });
    expect([deux.statusCode, deux.headers["retry-after"], deux.json()]).toEqual([
      503,
      "1",
      { detail: "Fichier en cours de modification — réessayez." },
    ]);
    expect(deux.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("agent indisponible : 503 ; jeton hors de la forme émise par main : 403 ; sans enveloppe : 401 ; HEAD : 404 du montage", async () => {
    const indisponible = (): Promise<never> => Promise.reject(new AgentError("agent_unavailable", "arrêté"));
    const a = await creerAppToolhost({
      tc: configTest(),
      familles: [
        creerFamilleApercuFichiers({
          racine: async () => "/srv/sb/hugo/work",
          agent: async () => ({ stat: indisponible, read: indisponible }),
        }),
      ],
      journal: journalMuet,
    });
    const r = await a.inject({ url: pv("x"), headers: entetes() });
    expect([r.statusCode, r.json()]).toEqual([
      503,
      { detail: "Environnement sandbox arrêté — nouvelle tentative dans quelques instants." },
    ]);
    await a.close();
    for (const jeton of [
      `%20${"7-1-" + "a".repeat(32)}`,
      "7-1-abc",
      `7-1-${"A".repeat(32)}`,
      `%D9%A7-1-${"a".repeat(32)}`,
    ]) {
      const j = await app.inject({ url: `/api/sandbox/pv/${jeton}/data.json`, headers: entetes() });
      expect([jeton, j.statusCode, j.json()]).toEqual([
        jeton,
        403,
        { detail: "Aperçu expiré : rechargez-le" },
      ]);
    }
    expect((await app.inject({ url: pv("data.json") })).statusCode).toBe(401);
    const h = await app.inject({ method: "HEAD", url: pv("data.json"), headers: entetes() });
    expect(h.statusCode).toBe(404);
  });
});
