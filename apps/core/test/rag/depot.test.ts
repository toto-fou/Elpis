// SPDX-License-Identifier: MIT
/** apps/core/test/rag/depot.test.ts — dépôt RAG sur SQLite et PostgreSQL : noms hostiles, plafonds (fichier, stockage, documents), course entre deux dépôts, doublon, remplacement, droits, import depuis la sandbox. */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { schemaSystemeTravailRag } from "@elpis/contracts";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assainirCheminRag } from "../../src/rag/depot";
import { nettoyerMagasinRag } from "../../src/rag/entretien";
import { RefusIndexationRag } from "../../src/rag/erreurs-indexation";
import { definirQuotaRagCompte } from "../../src/rag/quotas";
import { ServiceIndexationRag } from "../../src/rag/service";
import { creerCollection, creerCompte, FauxQdrant, flux, JETON_EXTRACTEUR } from "./aides-indexation";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const ENV = ["RAG_SERVICE_URL", "RAG_SERVICE_TOKEN", "RAG_STORE_DIR", "ELPIS_RAG_ACCESS_DIR"] as const;

let dossier: string;
let configJson: string;
let magasin: string;
let restaurer: () => void;
const avant = new Map<string, string | undefined>();

function ecrireConfig(rag: Record<string, unknown> = {}): void {
  writeFileSync(
    configJson,
    JSON.stringify({
      rag: {
        store_dir: magasin,
        service_url: "http://127.0.0.1:9",
        service_token: JETON_EXTRACTEUR,
        embed: { url: "http://127.0.0.1:9", model: "m1" },
        ...rag,
      },
    }),
  );
  invalidateConfigCache();
}

beforeAll(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-rag-depot-"));
  configJson = join(dossier, "config.json");
  magasin = join(dossier, "magasin");
  for (const k of ENV) avant.set(k, process.env[k]);
  for (const k of ENV) delete process.env[k];
  process.env["ELPIS_RAG_ACCESS_DIR"] = join(dossier, "temoin");
  restaurer = surchargerConfig({ CONFIG_JSON_PATH: configJson, DB_PATH: join(dossier, "user_db", "app.db") });
});

afterAll(() => {
  restaurer();
  for (const k of ENV) {
    const v = avant.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dossier, { recursive: true, force: true });
});

describe("assainirCheminRag", () => {
  it("garde un nom simple, normalise en NFC, découpe les dossiers permis", () => {
    expect(assainirCheminRag("Rapport annuel.PDF")).toEqual({
      rel_path: "Rapport annuel.PDF",
      name: "Rapport annuel.PDF",
      ext: "pdf",
    });
    expect(assainirCheminRag("e\u0301te\u0301.md").rel_path).toBe("été.md");
    expect(assainirCheminRag(" docs / 2024 / note.txt ", { dossier: true })).toEqual({
      rel_path: "docs/2024/note.txt",
      name: "note.txt",
      ext: "txt",
    });
  });

  it("refuse les noms hostiles avec un code stable", () => {
    const refus = (brut: unknown, dossier = false): string => {
      try {
        assainirCheminRag(brut, { dossier });
        return "accepte";
      } catch (e) {
        return e instanceof RefusIndexationRag ? e.code : "autre";
      }
    };
    for (const brut of [
      "../x.pdf",
      "a/../b.txt",
      "./a.txt",
      "/etc/passwd.txt",
      "a\u0000.txt",
      "a\nb.txt",
      "a\\b.txt",
      "\u202Etxt.exe.md",
      "",
      ".",
      "a//b.txt",
      `${"é".repeat(130)}.txt`,
      "x".repeat(1100),
      "\ud800.txt",
      42,
      null,
    ])
      expect(refus(brut, true), JSON.stringify(brut)).toBe("nom_invalide");
    expect(refus("docs/a.txt")).toBe("nom_invalide");
    expect(refus(Array.from({ length: 33 }, () => "d").join("/") + "/a.txt", true)).toBe("nom_invalide");
    for (const brut of ["virus.exe", "archive.zip", "sans_extension", ".pdf", "a.pdf.part", "image.png"])
      expect(refus(brut), brut).toBe("extension_refusee");
  });
});

describe.each(MOTEURS)("dépôt RAG (%s)", (moteur) => {
  let t: BaseDeTest;
  let alice: number;
  let bob: number;
  let col: string;
  let q: FauxQdrant;
  let evenements: Record<string, unknown>[];
  let service: ServiceIndexationRag;
  let reveils: number;

  beforeEach(async () => {
    ecrireConfig();
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    alice = await creerCompte(t.base, "alice");
    bob = await creerCompte(t.base, "bob");
    col = await creerCollection(t.base, alice, "Contrats");
    q = new FauxQdrant();
    evenements = [];
    reveils = 0;
    service = new ServiceIndexationRag({
      base: t.base,
      diffuser: (m) => void evenements.push(m),
      reveiller: () => void reveils++,
      qdrant: () => q,
    });
  });

  afterEach(async () => {
    await t.fermer();
    rmSync(magasin, { recursive: true, force: true });
  });

  const sources = (uid = alice, c = col): string[] => {
    const d = join(magasin, String(uid), c, "sources");
    return existsSync(d) ? readdirSync(d).sort() : [];
  };

  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "accepte";
    } catch (e) {
      return e instanceof RefusIndexationRag ? e.code : `autre: ${String(e)}`;
    }
  };

  it("écrit la source en flux sous l'identifiant du document, crée la ligne en attente et le travail, diffuse rag_job", async () => {
    const contenu = "# Contrat\n\nLe renouvellement est automatique.";
    const r = await service.deposer(alice, col, { nom: "contrat.md", flux: flux(contenu) });
    expect(r.statut).toBe("ajoute");
    expect(r.document).toMatchObject({
      rel_path: "contrat.md",
      name: "contrat.md",
      ext: "md",
      status: "pending",
      bytes: Buffer.byteLength(contenu),
    });
    expect(r.travail).toMatchObject({ kind: "ingest", status: "queued", total: 1, done: 0, failed: 0 });
    expect(sources()).toEqual([`${r.document.id}.md`]);
    expect(readFileSync(join(magasin, String(alice), col, "sources", `${r.document.id}.md`), "utf8")).toBe(
      contenu,
    );
    const ligne = await t.base.get<{ sha256: string; added_by: number }>(
      "SELECT sha256, added_by FROM rag_documents WHERE id=?",
      [r.document.id],
    );
    expect(ligne?.sha256).toBe(createHash("sha256").update(contenu).digest("hex"));
    expect(Number(ligne?.added_by)).toBe(alice);
    const c = await t.base.get<{ doc_count: unknown; bytes: unknown; status: unknown }>(
      "SELECT doc_count, bytes, status FROM rag_collections WHERE id=?",
      [col],
    );
    expect([Number(c?.doc_count), Number(c?.bytes), c?.status]).toEqual([
      1,
      Buffer.byteLength(contenu),
      "indexing",
    ]);
    expect(evenements).toHaveLength(1);
    expect(schemaSystemeTravailRag.parse(evenements[0]).data).toMatchObject({
      user_id: alice,
      collection_id: col,
    });
    expect(reveils).toBe(1);
    const second = await service.deposer(alice, col, {
      nom: "d/annexe.txt",
      flux: flux("Annexe."),
      dossier: true,
    });
    expect(second.travail?.id).toBe(r.travail?.id);
    expect(second.travail?.total).toBe(2);
    expect(second.document.rel_path).toBe("d/annexe.txt");
  });

  it("même contenu déjà présent : « deja_present », rien n'est créé, aucun fichier ne reste", async () => {
    const a = await service.deposer(alice, col, { nom: "a.txt", flux: flux("Même texte.") });
    const b = await service.deposer(alice, col, { nom: "copie.txt", flux: flux("Même texte.") });
    expect(b.statut).toBe("deja_present");
    expect(b.document.id).toBe(a.document.id);
    expect(b.travail).toBeNull();
    expect(sources()).toEqual([`${a.document.id}.txt`]);
    const [n] = await t.base.valeurs<[unknown]>("SELECT COUNT(*) FROM rag_documents");
    expect(Number(n?.[0])).toBe(1);
  });

  it("même chemin, autre contenu : nouvelle version sous le même identifiant, remise en file", async () => {
    const a = await service.deposer(alice, col, { nom: "a.txt", flux: flux("Version 1.") });
    await t.base.run("UPDATE rag_documents SET status='ready', indexed_at=1 WHERE id=?", [a.document.id]);
    const rel = join(magasin, String(alice), col);
    writeFileSync(join(rel, "extraits", `${a.document.id}.json`), "{}");
    mkdirSync(join(rel, "pages", a.document.id));
    writeFileSync(join(rel, "pages", a.document.id, "1.webp"), "x");
    const b = await service.deposer(alice, col, { nom: "a.txt", flux: flux("Version 2, plus longue.") });
    expect(b.statut).toBe("remplace");
    expect(b.document).toMatchObject({ id: a.document.id, status: "pending", indexed_at: null, bytes: 23 });
    expect(readFileSync(join(magasin, String(alice), col, "sources", `${a.document.id}.txt`), "utf8")).toBe(
      "Version 2, plus longue.",
    );
    expect(sources()).toEqual([`${a.document.id}.txt`]);
    expect(readdirSync(join(rel, "extraits"))).toEqual([]);
    expect(readdirSync(join(rel, "pages"))).toEqual([]);
  });

  it("plafond par fichier : refus annoncé avant lecture, ou en cours de flux, sans rien laisser", async () => {
    await definirQuotaRagCompte(t.base, alice, { file_mb: 1 });
    let lus = 0;
    async function* compteur(): AsyncGenerator<Uint8Array> {
      lus++;
      yield Buffer.alloc(10);
    }
    expect(
      await code(service.deposer(alice, col, { nom: "a.txt", flux: compteur(), taille: 2 * 1024 * 1024 })),
    ).toBe("fichier_trop_gros");
    expect(lus).toBe(0);
    expect(
      await code(
        service.deposer(alice, col, { nom: "a.txt", flux: flux(Buffer.alloc(1024 * 1024 + 1, 97), 65536) }),
      ),
    ).toBe("fichier_trop_gros");
    expect(sources()).toEqual([]);
    expect(
      await code(
        service.deposer(alice, col, { nom: "a.txt", flux: flux(Buffer.alloc(1024 * 1024, 97), 65536) }),
      ),
    ).toBe("accepte");
  });

  it("stockage du compte : deux dépôts parallèles qui tiennent chacun mais pas ensemble, un seul passe", async () => {
    await definirQuotaRagCompte(t.base, alice, { storage_mb: 1 });
    const col2 = await creerCollection(t.base, alice, "Autre");
    const gros = (o: number): Buffer => Buffer.alloc(700 * 1024, o);
    const issues = await Promise.all([
      code(service.deposer(alice, col, { nom: "a.txt", flux: flux(gros(97), 32768) })),
      code(service.deposer(alice, col2, { nom: "b.txt", flux: flux(gros(98), 32768) })),
    ]);
    expect(issues.sort()).toEqual(["accepte", "quota_stockage"]);
    expect(sources(alice, col).length + sources(alice, col2).length).toBe(1);
    const [o] = await t.base.valeurs<[unknown]>("SELECT COALESCE(SUM(bytes), 0) FROM rag_documents");
    expect(Number(o?.[0])).toBe(700 * 1024);
  });

  it("documents par collection : au-delà du plafond, refus ; un remplacement reste permis", async () => {
    await definirQuotaRagCompte(t.base, alice, { docs_per_collection: 2 });
    expect(await code(service.deposer(alice, col, { nom: "a.txt", flux: flux("un") }))).toBe("accepte");
    expect(await code(service.deposer(alice, col, { nom: "b.txt", flux: flux("deux") }))).toBe("accepte");
    expect(await code(service.deposer(alice, col, { nom: "c.txt", flux: flux("trois") }))).toBe(
      "quota_documents",
    );
    expect(await code(service.deposer(alice, col, { nom: "b.txt", flux: flux("deux bis") }))).toBe("accepte");
    const issues = await Promise.all(
      ["d.txt", "e.txt"].map(async (nom) => {
        await definirQuotaRagCompte(t.base, alice, { docs_per_collection: 3 });
        return code(service.deposer(alice, col, { nom, flux: flux(`contenu ${nom}`) }));
      }),
    );
    expect(issues.sort()).toEqual(["accepte", "quota_documents"]);
    expect(sources()).toHaveLength(3);
  });

  it("fichier vide, flux coupé, nom hostile, extension refusée : refus sans fichier", async () => {
    expect(await code(service.deposer(alice, col, { nom: "vide.txt", flux: flux("") }))).toBe("fichier_vide");
    async function* casse(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("début");
      throw new Error("connexion coupée");
    }
    expect(await code(service.deposer(alice, col, { nom: "a.txt", flux: casse() }))).toBe("depot_interrompu");
    const ctrl = new AbortController();
    async function* lent(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("a");
      ctrl.abort();
      yield Buffer.from("b");
    }
    expect(await code(service.deposer(alice, col, { nom: "a.txt", flux: lent() }, ctrl.signal))).toBe(
      "depot_interrompu",
    );
    expect(await code(service.deposer(alice, col, { nom: "../../x.txt", flux: flux("x") }))).toBe(
      "nom_invalide",
    );
    expect(await code(service.deposer(alice, col, { nom: "x.sh", flux: flux("x") }))).toBe(
      "extension_refusee",
    );
    expect(sources()).toEqual([]);
    const [n] = await t.base.valeurs<[unknown]>("SELECT COUNT(*) FROM rag_documents");
    expect(Number(n?.[0])).toBe(0);
  });

  it("droits : un autre compte ne voit pas la collection, un lecteur ne peut rien déposer, RAG désactivé refusé", async () => {
    expect(await code(service.deposer(bob, col, { nom: "a.txt", flux: flux("x") }))).toBe(
      "collection_introuvable",
    );
    expect(await code(service.deposer(alice, "pas-un-uuid", { nom: "a.txt", flux: flux("x") }))).toBe(
      "collection_introuvable",
    );
    const admin = await creerCompte(t.base, "dora", true);
    const publique = await creerCollection(t.base, admin, "Publique", { visibility: "all" });
    expect(await code(service.deposer(bob, publique, { nom: "a.txt", flux: flux("x") }))).toBe(
      "non_proprietaire",
    );
    expect(sources(admin, publique)).toEqual([]);
    expect(existsSync(join(magasin, String(bob)))).toBe(false);
    ecrireConfig({ embed: { url: "", model: "m1" } });
    expect(await code(service.deposer(alice, col, { nom: "a.txt", flux: flux("x") }))).toBe("rag_desactive");
  });

  it("collection supprimée pendant le flux : refus, dossier recréé retiré", async () => {
    async function* pendant(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("début ");
      await t.base.run("DELETE FROM rag_collections WHERE id=?", [col]);
      rmSync(join(magasin, String(alice), col), { recursive: true, force: true });
      yield Buffer.from("fin");
    }
    expect(await code(service.deposer(alice, col, { nom: "a.txt", flux: pendant() }))).toBe(
      "collection_introuvable",
    );
    expect(existsSync(join(magasin, String(alice), col))).toBe(false);
  });

  it("entretien du magasin : dépôts abandonnés et fichiers sans document retirés, le reste gardé", async () => {
    const r = await service.deposer(alice, col, { nom: "garde.txt", flux: flux("Gardé.") });
    const rel = join(magasin, String(alice), col);
    const orphelin = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    writeFileSync(join(rel, "sources", `${orphelin}.pdf`), "x");
    writeFileSync(join(rel, "sources", `${orphelin}.txt.part`), "x");
    writeFileSync(join(rel, "extraits", `${orphelin}.json`), "{}");
    writeFileSync(join(rel, "extraits", `${r.document.id}.json`), "{}");
    writeFileSync(join(rel, "sources", "autre-nom.txt"), "x");
    expect(await nettoyerMagasinRag(t.base)).toBe(0);
    expect(await nettoyerMagasinRag(t.base, Date.now() + 2 * 3600_000)).toBe(2);
    expect(sources()).toEqual([`${orphelin}.txt.part`, `${r.document.id}.txt`, "autre-nom.txt"].sort());
    expect(await nettoyerMagasinRag(t.base, Date.now() + 7 * 3600_000)).toBe(1);
    expect(sources()).toEqual([`${r.document.id}.txt`, "autre-nom.txt"].sort());
    expect(readdirSync(join(rel, "extraits"))).toEqual([`${r.document.id}.json`]);
  });

  it("import depuis la sandbox : identité relayée, fichiers déposés, dossiers et refus par fichier", async () => {
    const vus: { chemin: string; entete: string }[] = [];
    const hote = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      const chemin = u.searchParams.get("path") ?? "";
      vus.push({ chemin, entete: String(req.headers["x-test-identite"] ?? "") });
      if (u.pathname !== "/api/sandbox/download") return void res.writeHead(404).end();
      if (chemin === "/work/docs/note.md")
        return void res.writeHead(200, { "content-type": "text/markdown" }).end("# Note\n\nTexte.");
      if (chemin === "docs/rapport.txt")
        return void res.writeHead(200, { "content-type": "text/plain" }).end("Rapport.");
      if (chemin === "dossier.pdf")
        return void res.writeHead(200, { "content-type": "application/zip" }).end("PK");
      return void res.writeHead(404, { "content-type": "application/json" }).end('{"detail":"Not found"}');
    });
    await new Promise<void>((r) => hote.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(hote.address() as AddressInfo).port}`;
    const s = new ServiceIndexationRag({
      base: t.base,
      qdrant: () => q,
      hoteSandbox: async (uid) => ({ id: "local", url, token: `jeton-${uid}`, relay: false }),
      entetesSandbox: async (h, uid) => ({
        authorization: `Bearer ${h.token}`,
        "x-test-identite": `compte-${uid}`,
      }),
    });
    try {
      const r = await s.importerDepuisSandbox(alice, col, [
        "/work/docs/note.md",
        "docs/rapport.txt",
        "dossier.pdf",
        "absent.txt",
        "../x.txt",
        "outil.sh",
      ]);
      expect(r.map((x) => [x.chemin, x.statut, x.code ?? null])).toEqual([
        ["/work/docs/note.md", "ajoute", null],
        ["docs/rapport.txt", "ajoute", null],
        ["dossier.pdf", "refuse", "dossier_refuse"],
        ["absent.txt", "refuse", "sandbox_fichier"],
        ["../x.txt", "refuse", "nom_invalide"],
        ["outil.sh", "refuse", "extension_refusee"],
      ]);
      expect(r[0]?.document?.rel_path).toBe("docs/note.md");
      expect(vus.every((v) => v.entete === `compte-${alice}`)).toBe(true);
      expect(vus.map((v) => v.chemin)).toEqual([
        "/work/docs/note.md",
        "docs/rapport.txt",
        "dossier.pdf",
        "absent.txt",
      ]);
      expect(await code(s.importerDepuisSandbox(bob, col, ["a.txt"]))).toBe("collection_introuvable");
      expect(
        await code(
          s.importerDepuisSandbox(
            alice,
            col,
            Array.from({ length: 501 }, (_, i) => `${i}.txt`),
          ),
        ),
      ).toBe("trop_de_fichiers");
      const sansHote = new ServiceIndexationRag({
        base: t.base,
        qdrant: () => q,
        hoteSandbox: async () => null,
      });
      expect(await code(sansHote.importerDepuisSandbox(alice, col, ["a.txt"]))).toBe("sandbox_indisponible");
    } finally {
      hote.closeAllConnections();
      await new Promise<void>((r) => hote.close(() => r()));
    }
  });
});
