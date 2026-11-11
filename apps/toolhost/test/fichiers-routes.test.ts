// SPDX-License-Identifier: MIT
/** apps/toolhost/test/fichiers-routes.test.ts — routes de fichiers de l'éditeur sur l'hôte TS, servies par le vrai agent Python du bac (sans conteneur) : arbre, quota, écritures et préconditions, envois, structure, recherche, remplacement, archives, historique. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { oublierOccupations } from "@elpis/bac";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { AgentClient } from "@elpis/fichiers";
import { interpreteurPython } from "@elpis/mcp";
import { discoverSkillsBySource } from "@elpis/skills";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BacTest, PYTHON } from "../../../packages/fichiers/test/aides";
import { fermerBaseHote, ouvrirBaseHote } from "../src/base-hote";
import { arreterFilsCalcul } from "../src/fichiers/calcul-execution";
import { configTest, dossierTemporaire, entetes, hoteTest, journalMuet } from "./aides";
import type { HoteTest } from "./aides";

/** Python du dépôt (ELPIS_PYTHON, sinon venv/) : ruff et python-docx pour les cas qui les demandent. */
const PYTHON_DEPOT = interpreteurPython();

let tmp = "";
let nettoyer: () => void = () => undefined;
let restaurer: () => void = () => undefined;
let bac: BacTest;
let agent: AgentClient;
let h: HoteTest;
let W = "";

type Rep = {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  rawPayload: Buffer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- corps JSON libre des réponses comparées
  json(): any;
};

async function appel(
  methode: string,
  url: string,
  corps?: unknown,
  plus: Record<string, string> = {},
): Promise<Rep> {
  const brut =
    corps === undefined
      ? undefined
      : typeof corps === "string" || Buffer.isBuffer(corps)
        ? corps
        : JSON.stringify(corps);
  return (await h.app.inject({
    method: methode as "GET",
    url,
    headers: {
      ...entetes(),
      ...(corps !== undefined && typeof corps !== "string" && !Buffer.isBuffer(corps)
        ? { "content-type": "application/json" }
        : {}),
      ...plus,
    },
    ...(brut !== undefined ? { payload: brut } : {}),
  })) as unknown as Rep;
}

/** Corps multipart (fichiers et champs), comme un formulaire du navigateur. */
function multipart(parties: { nom: string; fichier?: string; contenu: string | Buffer }[]): [Buffer, string] {
  const borne = "----elpis-test-borne";
  const morceaux: Buffer[] = [];
  for (const p of parties) {
    morceaux.push(
      Buffer.from(
        `--${borne}\r\nContent-Disposition: form-data; name="${p.nom}"${p.fichier !== undefined ? `; filename="${p.fichier}"` : ""}\r\n` +
          (p.fichier !== undefined ? "Content-Type: application/octet-stream\r\n" : "") +
          "\r\n",
      ),
      Buffer.isBuffer(p.contenu) ? p.contenu : Buffer.from(p.contenu),
      Buffer.from("\r\n"),
    );
  }
  morceaux.push(Buffer.from(`--${borne}--\r\n`));
  return [Buffer.concat(morceaux), `multipart/form-data; boundary=${borne}`];
}

/** Archive tar.gz minimale (ustar) d'un fichier ; `nom` libre (« ../x » compris). */
function tarGz(fichiers: Record<string, string>): Buffer {
  const blocs: Buffer[] = [];
  for (const [nom, contenu] of Object.entries(fichiers)) {
    const e = Buffer.alloc(512);
    e.write(nom, 0, 100, "utf8");
    e.write("0000644\0", 100);
    e.write("0000000\0", 108);
    e.write("0000000\0", 116);
    e.write(Buffer.byteLength(contenu).toString(8).padStart(11, "0") + "\0", 124);
    e.write("00000000000\0", 136);
    e.fill(0x20, 148, 156);
    e.write("0", 156);
    e.write("ustar\0", 257);
    e.write("00", 263);
    let somme = 0;
    for (const o of e) somme += o;
    e.write(somme.toString(8).padStart(6, "0") + "\0 ", 148);
    blocs.push(e, Buffer.from(contenu), Buffer.alloc((512 - (Buffer.byteLength(contenu) % 512)) % 512));
  }
  blocs.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocs));
}

describe.skipIf(!PYTHON)("routes de fichiers de l'hôte TS (agent Python réel)", () => {
  beforeAll(async () => {
    [tmp, nettoyer] = dossierTemporaire("elpis-th-fichiers-");
    bac = new BacTest(tmp, "hugo");
    W = bac.sandboxPath;
    await bac.startAgent(false);
    agent = new AgentClient(bac);
  }, 60_000);

  afterAll(async () => {
    await arreterFilsCalcul();
    await bac?.arreter();
    nettoyer();
  });

  beforeEach(async () => {
    vi.stubEnv("APP_SANDBOX_DIR", path.join(tmp, "sb"));
    vi.stubEnv("APP_FILE_HISTORY_DIR", path.join(tmp, "fh"));
    vi.stubEnv("ELPIS_PYTHON", PYTHON_DEPOT);
    writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ app: { sandbox_quota_mb: 5120 } }));
    invalidateConfigCache();
    restaurer = surchargerConfig({
      SANDBOX_DIR: path.join(tmp, "sb"),
      CONFIG_JSON_PATH: path.join(tmp, "config.json"),
    });
    oublierOccupations();
    execFileSync("sh", ["-c", `rm -rf "${W}"/* "${W}"/.[!.]* 2>/dev/null; true`]);
    h = await hoteTest(configTest(), { bacFichiers: { racine: async () => W, agent: async () => agent } });
  });

  afterEach(async () => {
    await h.fermer();
    restaurer();
    vi.unstubAllEnvs();
  });

  it("arbre : dossiers d'abord, noms sans casse, cachés sur demande, liens jamais listés", async () => {
    mkdirSync(path.join(W, "src"));
    writeFileSync(path.join(W, "src", "b.py"), "b");
    writeFileSync(path.join(W, "A.txt"), "aaa");
    writeFileSync(path.join(W, ".cache"), "");
    symlinkSync("A.txt", path.join(W, "lien"));
    const r = await appel("GET", "/api/sandbox/tree");
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-cache");
    expect(r.json()).toEqual({
      root: "work",
      items: [
        {
          name: "src",
          path: "src",
          type: "folder",
          children: [{ name: "b.py", path: "src/b.py", type: "file", size: 1 }],
        },
        { name: "A.txt", path: "A.txt", type: "file", size: 3 },
      ],
      truncated: false,
      max_entries: 20000,
    });
    const caches = await appel("GET", "/api/sandbox/tree?include_hidden=true");
    expect(caches.json().items.map((i: { name: string }) => i.name)).toEqual(["src", ".cache", "A.txt"]);
    expect((await appel("GET", "/api/sandbox/tree?include_hidden=peut-etre")).statusCode).toBe(422);
  });

  it("quota : flottants comme Python (100 entier au-delà), octets restants", async () => {
    writeFileSync(path.join(W, "f"), Buffer.alloc(1536 * 1024));
    const r = await appel("GET", "/api/sandbox/quota");
    expect(r.body).toMatch(
      /^\{"used_mb":1\.5\d*,"quota_mb":5120,"pct":0\.0,"used_bytes":\d+,"quota_bytes":5368709120,"remaining_bytes":\d+\}$/u,
    );
    writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ app: { sandbox_quota_mb: 1 } }));
    invalidateConfigCache();
    oublierOccupations();
    expect((await appel("GET", "/api/sandbox/quota")).body).toMatch(
      /"quota_mb":1,"pct":100,.*"remaining_bytes":0\}$/u,
    );
    writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ app: { sandbox_quota_mb: 0 } }));
    invalidateConfigCache();
    oublierOccupations();
    const illimite = (await appel("GET", "/api/sandbox/quota")).json();
    expect([illimite.quota_mb, illimite.pct, illimite.quota_bytes, illimite.remaining_bytes]).toEqual([
      0,
      0,
      0,
      null,
    ]);
  });

  it("sauvegarde : mesures notées dans la base de l'hôte (log_metric)", async () => {
    const fin = surchargerConfig({ DB_BACKEND: "sqlite", DB_PATH: path.join(tmp, "hote.db") });
    invalidateConfigCache();
    try {
      const base = await ouvrirBaseHote(() => journalMuet);
      if (base === null) throw new Error("base de l'hôte non ouverte");
      expect(
        (await appel("POST", "/api/sandbox/save", { path: "m.py", content: "x = 1\n" })).statusCode,
      ).toBe(200);
      const lignes = await base.all<{ event_type: string; tags_json: string; user_id: unknown }>(
        "SELECT event_type, tags_json, user_id FROM metric_events ORDER BY id",
      );
      expect(lignes.map((l) => [l.event_type, l.user_id])).toEqual([
        ["code_write_time", null],
        ["sandbox_write", null],
      ]);
      expect(lignes[1]?.tags_json).toMatch(/^\{"ext": "py", "size": 6, "user": "[^"]+"\}$/u);
    } finally {
      await fermerBaseHote();
      fin();
      invalidateConfigCache();
    }
  });

  it("sauvegarde : création, précondition (412), si absent (409), binaire refusé, dossier, base64, quota", async () => {
    const cree = await appel("POST", "/api/sandbox/save", { path: "/work/n/a.txt", content: "bonjour" });
    expect(cree.statusCode).toBe(200);
    const c = cree.json();
    expect(c).toMatchObject({ ok: true, size: 7 });
    expect(c.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(readFileSync(path.join(W, "n", "a.txt"), "utf8")).toBe("bonjour");
    const conflit = await appel("POST", "/api/sandbox/save", {
      path: "n/a.txt",
      content: "x",
      expected_sha256: "0".repeat(64),
    });
    expect(conflit.statusCode).toBe(412);
    expect(conflit.json().detail).toMatchObject({ code: "conflict", missing: false, sha256: c.sha256 });
    const ok = await appel("POST", "/api/sandbox/save", {
      path: "n/a.txt",
      content: "v2",
      expected_sha256: c.sha256,
    });
    expect(ok.statusCode).toBe(200);
    const mtime = await appel("POST", "/api/sandbox/save", {
      path: "n/a.txt",
      content: "v3",
      expected_mtime: 1,
    });
    expect(mtime.statusCode).toBe(412);
    expect(
      (await appel("POST", "/api/sandbox/save", { path: "n/a.txt", content: "x", if_absent: true })).json(),
    ).toEqual({
      detail: { code: "exists", message: "Un fichier porte déjà ce nom" },
    });
    expect((await appel("POST", "/api/sandbox/save", { path: "n", content: "x" })).json()).toEqual({
      detail: { code: "is_dir", message: "Un dossier porte ce nom" },
    });
    writeFileSync(path.join(W, "img.png"), Buffer.from("89504e470d0a1a0a00", "hex"));
    expect((await appel("POST", "/api/sandbox/save", { path: "img.png", content: "texte" })).statusCode).toBe(
      409,
    );
    const b64 = await appel("POST", "/api/sandbox/save", {
      path: "img.png",
      content_b64: Buffer.from([0, 1, 2]).toString("base64"),
    });
    expect(b64.statusCode).toBe(200);
    expect([...readFileSync(path.join(W, "img.png"))]).toEqual([0, 1, 2]);
    expect((await appel("POST", "/api/sandbox/save", { path: "x", content_b64: "@@" })).json()).toEqual({
      detail: "content_b64 invalide",
    });
    expect((await appel("POST", "/api/sandbox/save", { path: "../x", content: "x" })).statusCode).toBe(403);
    expect((await appel("POST", "/api/sandbox/save", { content: "x" })).json()).toEqual({
      detail: "Path required",
    });
    expect((await appel("POST", "/api/sandbox/save", { path: "x", content: "\ud800" })).statusCode).toBe(400);
    expect((await appel("POST", "/api/sandbox/save", { path: "x", content: 1 })).json()).toEqual({
      detail: "Content (string) required",
    });
    expect(
      (await appel("POST", "/api/sandbox/save", { path: "x", content: "", expected_mtime: true })).statusCode,
    ).toBe(400);
    writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ app: { sandbox_quota_mb: 1 } }));
    invalidateConfigCache();
    const quota = await appel("POST", "/api/sandbox/save", {
      path: "gros.txt",
      content: "z".repeat(2 * 1024 * 1024),
    });
    expect(quota.json()).toEqual({ detail: "Quota sandbox dépassé (1 Mo)" });
    expect(
      (await appel("POST", "/api/sandbox/save", "{pas du json", { "content-type": "application/json" }))
        .statusCode,
    ).toBe(500);
  });

  it("historique de session : écritures notées, fichier, version par empreinte", async () => {
    await appel("POST", "/api/sandbox/save", { path: "h.txt", content: "un" });
    await appel("POST", "/api/sandbox/save", { path: "h.txt", content: "deux" });
    const info = await appel("GET", "/api/sandbox/history");
    expect(info.headers["cache-control"]).toBe("no-cache, no-store, must-revalidate");
    expect(info.json().files[0]).toMatchObject({ path: "h.txt", versions: 2, last_source: "editor" });
    const f = (await appel("GET", "/api/sandbox/history/file?path=h.txt")).json();
    expect(f.current).toMatchObject({ exists: true, size: 4 });
    const sha = f.versions[f.versions.length - 1].sha as string;
    const blob = await appel("GET", `/api/sandbox/history/blob?sha=${sha.toUpperCase()}`);
    expect([blob.statusCode, blob.body, blob.headers["content-type"]]).toEqual([
      200,
      "deux",
      "text/plain; charset=utf-8",
    ]);
    expect((await appel("GET", "/api/sandbox/history/file?path=absent")).statusCode).toBe(404);
    expect((await appel("GET", "/api/sandbox/history/file")).json()).toEqual({ detail: "Chemin requis" });
    expect((await appel("GET", "/api/sandbox/history/blob?sha=zz")).statusCode).toBe(404);
  });

  it("envoi multiple : chemins hors du bac, dossier homonyme et fichiers écrits", async () => {
    mkdirSync(path.join(W, "dos"));
    const [corps, type] = multipart([
      { nom: "files", fichier: "a.txt", contenu: "A" },
      { nom: "files", fichier: "b.txt", contenu: "BB" },
      { nom: "files", fichier: "c.txt", contenu: "C" },
      { nom: "paths", contenu: "up/a.txt" },
      { nom: "paths", contenu: "../b.txt" },
      { nom: "paths", contenu: "dos" },
    ]);
    const r = await appel("POST", "/api/sandbox/upload", corps, { "content-type": type });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j).toMatchObject({
      ok: true,
      saved: 1,
      skipped: [
        { path: "../b.txt", reason: "path_escape" },
        { path: "dos", reason: "is_directory" },
      ],
    });
    expect(Object.keys(j.mtimes)).toEqual(["up/a.txt"]);
    expect(readFileSync(path.join(W, "up", "a.txt"), "utf8")).toBe("A");
    const manque = await appel(
      "POST",
      "/api/sandbox/upload",
      multipart([{ nom: "paths", contenu: "x" }])[0],
      {
        "content-type": type,
      },
    );
    expect(manque.statusCode).toBe(422);
    expect(manque.json().detail[0]).toMatchObject({ type: "missing", loc: ["body", "files"] });
  });

  it("envoi par morceaux : deux morceaux promus, taille incohérente, annulation", async () => {
    const base = "/api/sandbox/upload-chunk?path=gros/f.bin&total=2&size=6&upload_id=u1";
    const r0 = await appel("POST", `${base}&index=0`, Buffer.from("abc"), {
      "content-type": "application/octet-stream",
    });
    expect(r0.json()).toEqual({ ok: true, done: false });
    expect(existsSync(path.join(W, "gros", "f.bin.u1.elpis-upload.part"))).toBe(true);
    const r1 = await appel("POST", `${base}&index=1`, Buffer.from("def"), {
      "content-type": "application/octet-stream",
    });
    expect(r1.json()).toMatchObject({ ok: true, done: true, path: "gros/f.bin" });
    expect(readFileSync(path.join(W, "gros", "f.bin"), "utf8")).toBe("abcdef");
    const faux = await appel(
      "POST",
      "/api/sandbox/upload-chunk?path=g2&index=0&total=1&size=2",
      Buffer.from("abc"),
      {
        "content-type": "application/octet-stream",
      },
    );
    expect(faux.json()).toEqual({ detail: "Taille reçue incohérente — import du fichier annulé" });
    const interrompu = await appel(
      "POST",
      "/api/sandbox/upload-chunk?path=g3&index=1&total=2&size=2",
      Buffer.from("a"),
      {
        "content-type": "application/octet-stream",
      },
    );
    expect(interrompu.json()).toEqual({ detail: "Import interrompu" });
    expect((await appel("POST", "/api/sandbox/upload-chunk?path=x&index=a", Buffer.from(""))).json()).toEqual(
      {
        detail: "Paramètres chunk invalides",
      },
    );
    expect(
      (await appel("POST", "/api/sandbox/upload-chunk?path=x&upload_id=a%20b", Buffer.from(""))).json(),
    ).toEqual({
      detail: "upload_id invalide",
    });
    await appel(
      "POST",
      "/api/sandbox/upload-chunk?path=g4&index=0&total=2&size=4&upload_id=z",
      Buffer.from("ab"),
      {
        "content-type": "application/octet-stream",
      },
    );
    expect((await appel("DELETE", "/api/sandbox/upload-chunk?path=g4&upload_id=z")).json()).toEqual({
      ok: true,
      removed: true,
    });
    expect((await appel("DELETE", "/api/sandbox/upload-chunk?path=g4&upload_id=z")).json()).toEqual({
      ok: true,
      removed: false,
    });
    expect((await appel("DELETE", "/api/sandbox/upload-chunk")).json()).toEqual({ detail: "Chemin requis" });
  });

  it("pré-contrôle : écrasements déduits, borne la plus stricte nommée", async () => {
    writeFileSync(path.join(W, "e.bin"), Buffer.alloc(100));
    writeFileSync(
      path.join(tmp, "config.json"),
      JSON.stringify({ app: { sandbox_quota_mb: 1, sandbox_import_max_pct: 50 } }),
    );
    const r = (
      await appel("POST", "/api/sandbox/upload-precheck", {
        files: [
          { path: "e.bin", size: 150 },
          { path: "n.bin", size: 600 * 1024 },
          { path: "../x", size: 1 },
        ],
      })
    ).json();
    expect(Object.keys(r)).toEqual([
      "fits",
      "reason",
      "allowed_bytes",
      "needed_bytes",
      "total_bytes",
      "overwrite_bytes",
      "escaped",
      "detailed",
      "unlimited",
      "quota_bytes",
      "used_bytes",
      "remaining_bytes",
      "limit_bytes",
      "max_pct",
    ]);
    expect(r).toMatchObject({
      fits: false,
      reason: "import_limit",
      allowed_bytes: 524288,
      needed_bytes: 50 + 600 * 1024,
      total_bytes: 150 + 600 * 1024,
      overwrite_bytes: 100,
      escaped: 1,
      detailed: true,
      quota_bytes: 1048576,
      max_pct: 50,
    });
    expect((await appel("POST", "/api/sandbox/upload-precheck", { total_bytes: "x" })).json()).toEqual({
      detail: "total_bytes invalide",
    });
    expect((await appel("POST", "/api/sandbox/upload-precheck", [])).json()).toEqual({
      detail: "Corps invalide",
    });
  });

  it("structure : dossier, renommage sans écrasement, copie, suppression, vidage", async () => {
    expect((await appel("POST", "/api/sandbox/mkdir", { path: "d/e" })).json()).toEqual({ ok: true });
    writeFileSync(path.join(W, "d", "e", "f.txt"), "F");
    writeFileSync(path.join(W, "g.txt"), "G");
    expect(
      (await appel("POST", "/api/sandbox/rename", { old_path: "g.txt", new_path: "d/e/f.txt" })).json(),
    ).toEqual({
      detail: "Un élément porte déjà ce nom à cet endroit",
    });
    expect(
      (await appel("POST", "/api/sandbox/rename", { old_path: "absent", new_path: "x" })).json(),
    ).toEqual({
      detail: "Source not found",
    });
    expect(
      (await appel("POST", "/api/sandbox/rename", { old_path: "g.txt", new_path: "h.txt" })).json(),
    ).toEqual({ ok: true });
    expect((await appel("POST", "/api/sandbox/copy", { src: "d", dst: "d/e/copie" })).json()).toEqual({
      detail: "Impossible de copier un dossier dans lui-même",
    });
    expect((await appel("POST", "/api/sandbox/copy", { src: "d", dst: "d2" })).json()).toEqual({
      ok: true,
      path: "d2",
    });
    expect(readFileSync(path.join(W, "d2", "e", "f.txt"), "utf8")).toBe("F");
    expect((await appel("DELETE", "/api/sandbox/delete?path=d2")).json()).toEqual({ ok: true });
    expect(existsSync(path.join(W, "d2"))).toBe(false);
    expect((await appel("DELETE", "/api/sandbox/delete?path=absent")).json()).toEqual({
      detail: "Not found",
    });
    expect((await appel("POST", "/api/sandbox/mkdir", {})).json()).toEqual({ detail: "Path required" });
    expect((await appel("POST", "/api/sandbox/clear")).json()).toMatchObject({ ok: true });
    expect(existsSync(path.join(W, "h.txt"))).toBe(false);
  });

  it("téléchargement : fichier entier (X-Sha256), dossier en zip, plusieurs fichiers ; serve et plage par l'agent, types de mimetypes", async () => {
    writeFileSync(path.join(W, "nom é.txt"), "contenu");
    mkdirSync(path.join(W, "dz"));
    writeFileSync(path.join(W, "dz", "x"), "x");
    const r = await appel("GET", `/api/sandbox/download?path=${encodeURIComponent("nom é.txt")}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("contenu");
    expect(r.headers).toMatchObject({
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": "attachment; filename*=utf-8''nom%20%C3%A9.txt",
      "x-size": "7",
      "access-control-expose-headers": "X-Mtime, X-Sha256, X-Size",
      "cache-control": "no-cache, no-store, must-revalidate",
    });
    expect(r.headers["x-sha256"]).toMatch(/^[0-9a-f]{64}$/u);
    const zip = await appel("GET", "/api/sandbox/download?path=dz");
    expect([zip.statusCode, zip.headers["content-type"], zip.headers["content-disposition"]]).toEqual([
      200,
      "application/zip",
      'attachment; filename="dz.zip"',
    ]);
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe("PK");
    const multi = await appel("POST", "/api/sandbox/download-multi", {
      paths: ["nom é.txt", "../x", "absent"],
    });
    expect([multi.statusCode, multi.headers["x-files-zipped"]]).toEqual([200, "1"]);
    expect((await appel("POST", "/api/sandbox/download-multi", { paths: [] })).statusCode).toBe(400);
    expect((await appel("POST", "/api/sandbox/download-multi", { paths: ["absent"] })).statusCode).toBe(404);
    expect((await appel("GET", "/api/sandbox/download?path=absent")).json()).toEqual({ detail: "Not found" });
    writeFileSync(path.join(W, "dz", "i.png"), "0123456789");
    const servi = await appel("GET", "/api/sandbox/serve/dz/i.png");
    expect([servi.statusCode, servi.body, servi.headers["content-type"]]).toEqual([
      200,
      "0123456789",
      "image/png",
    ]);
    expect(servi.headers).toMatchObject({ "accept-ranges": "bytes", "x-content-type-options": "nosniff" });
    const plage = await appel("GET", "/api/sandbox/serve/dz/i.png", undefined, { range: "bytes=2-4" });
    expect([plage.statusCode, plage.body, plage.headers["content-range"]]).toEqual([
      206,
      "234",
      "bytes 2-4/10",
    ]);
    expect(
      (
        await appel("GET", "/api/sandbox/serve/dz/i.png", undefined, {
          "if-none-match": String(servi.headers["etag"]),
        })
      ).statusCode,
    ).toBe(304);
    const partiel = await appel("GET", "/api/sandbox/download?path=dz/i.png", undefined, {
      range: "bytes=-3",
    });
    expect([
      partiel.statusCode,
      partiel.body,
      partiel.headers["content-type"],
      partiel.headers["x-sha256"],
    ]).toEqual([206, "789", "image/png", undefined]);
    expect(partiel.headers).toMatchObject({
      "content-disposition": 'attachment; filename="i.png"',
      "x-size": "10",
      "access-control-expose-headers": "X-Mtime, X-Size",
    });
    expect((await appel("GET", "/api/sandbox/serve/dz")).statusCode).toBe(404);
    expect((await appel("GET", "/api/sandbox/serve/..%2F..%2Fetc%2Fpasswd")).statusCode).toBe(404);
  });

  it("recherche par nom et par contenu, avec aperçu", async () => {
    writeFileSync(path.join(W, "alpha.py"), "x = 1\nprint('cible')\n");
    writeFileSync(path.join(W, "image.png"), "cible");
    const nom = (await appel("GET", "/api/sandbox/search?q=alp&mode=name")).json();
    expect(nom).toEqual({
      items: [{ path: "alpha.py", name: "alpha.py", type: "file" }],
      errors: 0,
      truncated: false,
    });
    const contenu = (await appel("GET", "/api/sandbox/search?q=CIBLE")).json();
    expect(contenu.items).toEqual([
      { path: "alpha.py", name: "alpha.py", line: 2, col: 8, preview: "print('cible')" },
    ]);
    expect((await appel("GET", "/api/sandbox/search?q=")).json()).toEqual({ items: [] });
  });

  it("grep et remplacement (expressions de Python, aperçu puis application, refus lisibles)", async () => {
    writeFileSync(path.join(W, "a.txt"), "aXbXc\nfin X\n");
    writeFileSync(path.join(W, "b.md"), "rien\n");
    const g = (await appel("POST", "/api/sandbox/grep", { query: "x", glob: "*.txt" })).json();
    expect(g).toMatchObject({ total_files_scanned: 1, truncated: false });
    expect(g.matches.map((m: { line: number; col: number }) => [m.line, m.col])).toEqual([
      [1, 2],
      [2, 5],
    ]);
    expect((await appel("POST", "/api/sandbox/grep", { query: "(", regex: true })).json().detail).toBe(
      "Regex invalide : missing ), unterminated subpattern at position 0",
    );
    expect((await appel("POST", "/api/sandbox/grep", { query: " " })).json()).toEqual({
      detail: "Query vide",
    });
    const apercu = (
      await appel("POST", "/api/sandbox/replace", {
        query: "(?P<l>X)",
        replacement: "[\\g<l>$1]",
        regex: true,
        case_sensitive: true,
        dry_run: true,
      })
    ).json();
    expect(apercu).toEqual({
      files: [
        {
          path: "a.txt",
          count: 3,
          samples: [
            { line: 1, before: "aXbXc", after: "a[XX]b[XX]c" },
            { line: 2, before: "fin X", after: "fin [XX]" },
          ],
        },
      ],
      total: 3,
      truncated: false,
      skipped: [],
    });
    const app = (
      await appel("POST", "/api/sandbox/replace", {
        query: "|X",
        replacement: "-",
        regex: true,
        case_sensitive: true,
        paths: ["a.txt", "./a.txt", "work/a.txt", ".h"],
      })
    ).json();
    expect(app.files).toHaveLength(1);
    expect(app.skipped).toEqual([
      { path: "work/a.txt", reason: "hors champ" },
      { path: ".h", reason: "hors champ" },
    ]);
    expect(readFileSync(path.join(W, "a.txt"), "utf8")).toBe("-a---b---c-\n-f-i-n- ---\n");
    expect(
      (
        await appel("POST", "/api/sandbox/replace", {
          query: "x",
          replacement: "\\q",
          regex: true,
          dry_run: true,
        })
      ).json(),
    ).toEqual({
      detail: "Remplacement invalide : bad escape \\q at position 0",
    });
    expect((await appel("POST", "/api/sandbox/replace", { query: "x", replacement: "y" })).json()).toEqual({
      detail: "paths requis pour appliquer",
    });
  });

  it("état des onglets : changés, supprimés, dossiers, hors du bac ignorés", async () => {
    writeFileSync(path.join(W, "t.txt"), "abc");
    mkdirSync(path.join(W, "dd"));
    const r = (
      await appel("POST", "/api/sandbox/check-mtimes", {
        files: [
          { path: "t.txt", mtime: 1 },
          { path: "absent", mtime: 1 },
          { path: "dd", mtime: 1 },
          { path: "../x", mtime: 1 },
          { path: "t.txt", mtime: true },
        ],
      })
    ).json();
    expect(r.truncated).toBe(false);
    expect(r.stale[0]).toMatchObject({ path: "t.txt", size: 3 });
    expect(r.stale[0].sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(r.stale.slice(1)).toEqual([
      { path: "absent", missing: true },
      { path: "dd", not_file: true },
    ]);
    expect((await appel("POST", "/api/sandbox/check-mtimes", { files: 3 })).json()).toEqual({
      detail: "files doit être une liste",
    });
  });

  it("miroir des skills : tar.gz extrait hors de /work, archive invalide → 400, chemins sortants ignorés", async () => {
    const [corps, type] = multipart([
      { nom: "archive", fichier: "s.tgz", contenu: tarGz({ "s1/SKILL.md": "# s1", "../evade": "x" }) },
    ]);
    const miroir = path.join(bac.P, "skills");
    expect(await discoverSkillsBySource("user", miroir)).toEqual([]);
    const r = await appel("POST", "/api/sandbox/skills-mirror", corps, { "content-type": type });
    expect(r.json()).toEqual({ ok: true, files: 1 });
    expect((await discoverSkillsBySource("user", miroir)).map((s) => s.name)).toEqual(["s1"]);
    expect(readFileSync(path.join(bac.P, "skills", "s1", "SKILL.md"), "utf8")).toBe("# s1");
    expect(existsSync(path.join(bac.P, "evade"))).toBe(false);
    const [faux] = multipart([{ nom: "archive", fichier: "s.tgz", contenu: "pas une archive" }]);
    const mauvais = await appel("POST", "/api/sandbox/skills-mirror", faux, { "content-type": type });
    expect(mauvais.json()).toEqual({ detail: "archive invalide" });
    expect(existsSync(path.join(bac.P, ".skills-mirror.tmp"))).toBe(false);
  });

  it("export de /work en tar.gz par l'agent", async () => {
    writeFileSync(path.join(W, "e.txt"), "export");
    const r = await appel("GET", "/api/sandbox/export");
    expect([
      r.statusCode,
      r.headers["content-type"],
      r.headers["content-disposition"],
      r.headers["cache-control"],
    ]).toEqual([200, "application/gzip", 'attachment; filename="work.tar.gz"', "no-store"]);
    expect([...r.rawPayload.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
  });

  it("lint et format par ruff", async () => {
    const lint = (
      await appel("POST", "/api/sandbox/lint", { content: "import os\n", filename: "a.py" })
    ).json();
    expect(lint.diagnostics[0]).toMatchObject({ code: "F401", row: 1, severity: 8 });
    expect((await appel("POST", "/api/sandbox/lint", { content: "x", filename: "a.js" })).json()).toEqual({
      diagnostics: [],
    });
    expect(
      (await appel("POST", "/api/sandbox/format", { content: "x=1\n", filename: "d/a.py" })).json(),
    ).toEqual({ content: "x = 1\n" });
    expect(
      (await appel("POST", "/api/sandbox/format", { content: "def (:\n", filename: "a.py" })).statusCode,
    ).toBe(422);
    expect((await appel("POST", "/api/sandbox/format", { content: "x", filename: "a.js" })).json()).toEqual({
      detail: "Formatage disponible pour Python seulement",
    });
  });
});
