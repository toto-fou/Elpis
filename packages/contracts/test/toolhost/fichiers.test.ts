// SPDX-License-Identifier: MIT
/** packages/contracts/test/toolhost/fichiers.test.ts — contrats des routes de fichiers du bac rejoués contre l'hôte d'outils réel servi par l'agent Python du bac (sans conteneur) : arbre, quota, recherche, état disque, écritures, envois, remplacement, historique, archives. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { oublierOccupations } from "@elpis/bac";
import { ecrireZip } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { AgentClient } from "@elpis/fichiers";
import { interpreteurPython } from "@elpis/mcp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

import { schemaDetailRefusEnregistrement } from "../../src";
import { attendreTachesOffice } from "../../../../apps/toolhost/src/office/apercu";
import { arreterFilsCalcul } from "../../../../apps/toolhost/src/fichiers/calcul-execution";
import { configTest, dossierTemporaire } from "../../../../apps/toolhost/test/aides";
import { BacTest, PYTHON } from "../../../fichiers/test/aides";
import { appelerHote, hoteTest, routesDuDomaine, verifierToolhost } from "./aides";
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
const couvertes = new Set<string>();

/** Appel + vérification : le corps est rendu tel que validé (succès) ou en erreur `{detail}`. */
async function ok(methode: string, url: string, corps?: unknown, plus: Record<string, string> = {}) {
  const r = await appelerHote(h, methode, url, corps, plus);
  return { statut: r.statut, corps: verifierToolhost(methode, url, r, couvertes) as Record<string, unknown> };
}

function multipart(parties: { nom: string; fichier?: string; contenu: string | Buffer }[]): [Buffer, string] {
  const borne = "----elpis-contrat-borne";
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

/** Archive tar.gz minimale (ustar) d'un fichier par nom. */
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

describe.skipIf(!PYTHON)("contrats REST : fichiers du bac (hôte d'outils réel, agent Python)", () => {
  beforeAll(async () => {
    [tmp, nettoyer] = dossierTemporaire("elpis-ct-fichiers-");
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
    writeFileSync(
      path.join(tmp, "config.json"),
      JSON.stringify({ app: { sandbox_quota_mb: 5120 }, office_preview: { isolation: "none" } }),
    );
    vi.stubEnv("APP_OFFICE_CACHE_DIR", path.join(tmp, "cache-office"));
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
    await attendreTachesOffice();
    await h.fermer();
    restaurer();
    vi.unstubAllEnvs();
  });

  it("lecture : arbre, quota, recherche par contenu et par nom, état des onglets", async () => {
    mkdirSync(path.join(W, "src"));
    writeFileSync(path.join(W, "src", "b.py"), "import os\nvaleur = 1\n");
    writeFileSync(path.join(W, "A.txt"), "alpha valeur");
    mkdirSync(path.join(W, "dd"));
    expect((await ok("GET", "/api/sandbox/tree")).corps["items"]).toHaveLength(3);
    await ok("GET", "/api/sandbox/tree?include_hidden=true");
    await ok("GET", "/api/sandbox/quota");
    writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ app: { sandbox_quota_mb: 0 } }));
    invalidateConfigCache();
    oublierOccupations();
    expect((await ok("GET", "/api/sandbox/quota")).corps["remaining_bytes"]).toBeNull();
    const contenu = await ok("GET", "/api/sandbox/search?q=valeur");
    expect((contenu.corps["items"] as unknown[]).length).toBe(2);
    expect((await ok("GET", "/api/sandbox/search?q=b.py&mode=name")).corps["items"]).toHaveLength(1);
    expect((await ok("GET", "/api/sandbox/search?q=")).corps).toEqual({ items: [] });
    const etats = await ok("POST", "/api/sandbox/check-mtimes", {
      files: [
        { path: "A.txt", mtime: 1, size: 12 },
        { path: "absent", mtime: 1 },
        { path: "dd", mtime: 1 },
      ],
    });
    expect(etats.corps["stale"]).toHaveLength(3);
    expect((await ok("POST", "/api/sandbox/check-mtimes", { files: 3 })).statut).toBe(400);
  });

  it("docx : texte d'un document, refus d'un autre format", async () => {
    const zip = execFileSync(
      PYTHON_DEPOT,
      [
        "-c",
        "import io,sys,docx;d=docx.Document();d.add_paragraph('Bonjour');b=io.BytesIO();d.save(b);sys.stdout.buffer.write(b.getvalue())",
      ],
      { maxBuffer: 1 << 22 },
    );
    writeFileSync(path.join(W, "d.docx"), zip);
    writeFileSync(path.join(W, "a.txt"), "x");
    const docx = await ok("GET", "/api/sandbox/read-docx?path=d.docx");
    expect(docx.corps).toMatchObject({ format: "docx", read_only: true });
    expect((await ok("GET", "/api/sandbox/read-docx?path=a.txt")).statut).toBe(400);
  });

  it("écriture : enregistrement, conflits, structure, copie, vidage", async () => {
    const neuf = await ok("POST", "/api/sandbox/save", { path: "n/x.txt", content: "un", if_absent: true });
    expect(neuf.corps["ok"]).toBe(true);
    const existe = await ok("POST", "/api/sandbox/save", {
      path: "n/x.txt",
      content: "deux",
      if_absent: true,
    });
    expect(existe.statut).toBe(409);
    expect(schemaDetailRefusEnregistrement.parse(existe.corps["detail"])).toMatchObject({ code: "exists" });
    const conflit = await ok("POST", "/api/sandbox/save", {
      path: "n/x.txt",
      content: "trois",
      expected_mtime: 1,
      expected_sha256: "0".repeat(64),
    });
    expect(conflit.statut).toBe(412);
    expect(schemaDetailRefusEnregistrement.parse(conflit.corps["detail"])).toMatchObject({
      code: "conflict",
    });
    await ok("POST", "/api/sandbox/save", {
      path: "n/x.txt",
      content: "quatre",
      expected_sha256: neuf.corps["sha256"],
      source: "restore",
    });
    await ok("POST", "/api/sandbox/save", {
      path: "n/b.bin",
      content_b64: Buffer.from("bin").toString("base64"),
    });
    await ok("POST", "/api/sandbox/mkdir", { path: "dossier/sous" });
    await ok("POST", "/api/sandbox/rename", { old_path: "n/x.txt", new_path: "n/y.txt" });
    await ok("POST", "/api/sandbox/copy", { src: "n/y.txt", dst: "copie.txt" });
    await ok("DELETE", "/api/sandbox/delete", { path: "copie.txt" });
    expect((await ok("POST", "/api/sandbox/clear")).corps["deleted"]).toBeGreaterThan(0);
  });

  it("envois : formulaire, morceaux, annulation, pré-contrôle", async () => {
    const [corps, type] = multipart([
      { nom: "files", fichier: "a.txt", contenu: "alpha" },
      { nom: "paths", contenu: "up/a.txt" },
    ]);
    const envoi = await ok("POST", "/api/sandbox/upload", corps, { "content-type": type });
    expect(envoi.corps["saved"]).toBe(1);
    const base = "/api/sandbox/upload-chunk?path=gros/f.bin&total=2&size=6&upload_id=u1";
    const octets = { "content-type": "application/octet-stream" };
    expect((await ok("POST", `${base}&index=0`, Buffer.from("abc"), octets)).corps["done"]).toBe(false);
    expect((await ok("POST", `${base}&index=1`, Buffer.from("def"), octets)).corps["done"]).toBe(true);
    await ok(
      "POST",
      "/api/sandbox/upload-chunk?path=g&index=0&total=2&size=4&upload_id=z",
      Buffer.from("ab"),
      octets,
    );
    expect((await ok("DELETE", "/api/sandbox/upload-chunk?path=g&upload_id=z")).corps["removed"]).toBe(true);
    await ok("POST", "/api/sandbox/upload-precheck", { files: [{ path: "a.txt", size: 5 }], total_bytes: 5 });
    await ok("POST", "/api/sandbox/upload-precheck", { total_bytes: 12 });
  });

  it("recherche et remplacement dans les fichiers, diagnostics et formatage", async () => {
    writeFileSync(path.join(W, "a.py"), "import os\nx=1\nvaleur = 1\n");
    writeFileSync(path.join(W, "b.txt"), "valeur valeur\n");
    const grep = await ok("POST", "/api/sandbox/grep", { query: "valeur" });
    expect(grep.corps["matches"]).toHaveLength(2);
    await ok("POST", "/api/sandbox/grep", {
      query: "val.*",
      regex: true,
      glob: "*.txt",
      include_hidden: true,
    });
    expect((await ok("POST", "/api/sandbox/grep", { query: " " })).statut).toBe(400);
    const apercu = await ok("POST", "/api/sandbox/replace", {
      query: "valeur",
      replacement: "v",
      dry_run: true,
    });
    expect(apercu.corps["total"]).toBe(3);
    const applique = await ok("POST", "/api/sandbox/replace", {
      query: "valeur",
      replacement: "v",
      paths: ["b.txt"],
    });
    expect(applique.corps["total"]).toBe(2);
    const diag = await ok("POST", "/api/sandbox/lint", { content: "import os\n", filename: "a.py" });
    expect(diag.corps["diagnostics"]).not.toEqual([]);
    await ok("POST", "/api/sandbox/lint", { content: "x", filename: "a.js" });
    await ok("POST", "/api/sandbox/format", { content: "x=1\n", filename: "a.py" });
    expect((await ok("POST", "/api/sandbox/format", { content: "def (:\n", filename: "a.py" })).statut).toBe(
      422,
    );
  });

  it("historique de session, import d'archive et miroir des skills", async () => {
    await ok("POST", "/api/sandbox/save", { path: "h.txt", content: "v1" });
    await ok("POST", "/api/sandbox/save", { path: "h.txt", content: "v2" });
    expect((await ok("GET", "/api/sandbox/history")).corps["files"]).not.toEqual([]);
    expect((await ok("GET", "/api/sandbox/history/file?path=h.txt")).corps["versions"]).toHaveLength(2);
    expect((await ok("GET", "/api/sandbox/history/file?path=absent")).statut).toBe(404);
    const [archive, type] = multipart([
      { nom: "archive", fichier: "x.tgz", contenu: tarGz({ "imp/k.txt": "k" }) },
    ]);
    await ok("POST", "/api/sandbox/import", archive, { "content-type": type });
    const [miroir] = multipart([
      { nom: "archive", fichier: "s.tgz", contenu: tarGz({ "s1/SKILL.md": "# s1" }) },
    ]);
    expect((await ok("POST", "/api/sandbox/skills-mirror", miroir, { "content-type": type })).corps).toEqual({
      ok: true,
      files: 1,
    });
  });

  it("aperçus Office : PDF en pages, classeur xlsx en grille", async () => {
    writeFileSync(path.join(W, "doc.pdf"), "%PDF-1.7\n1 0 obj<</Type/Page>>endobj\n%%EOF");
    const pdf = await ok("POST", "/api/sandbox/office/prepare", { path: "doc.pdf" });
    expect(pdf.corps).toMatchObject({ kind: "pdf", view: "pages", grid: null });
    const entrees = {
      "[Content_Types].xml":
        '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
      "xl/workbook.xml":
        '<workbook><sheets><sheet name="A"/><sheet name="B" state="hidden"/></sheets></workbook>',
      "xl/worksheets/sheet1.xml":
        '<worksheet><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>',
      "xl/worksheets/sheet2.xml":
        '<worksheet><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
      "_rels/.rels":
        '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    };
    writeFileSync(
      path.join(W, "t.xlsx"),
      ecrireZip(
        Object.entries(entrees).map(([nom, contenu]) => ({
          nom,
          donnees: Buffer.from(contenu),
          dateHeure: [2020, 1, 1, 0, 0, 0],
          attributsExternes: 0o600 << 16,
        })),
      ),
    );
    const grille = await ok("POST", "/api/sandbox/office/prepare", { path: "t.xlsx", view: "grid" });
    expect(grille.corps).toMatchObject({ kind: "xlsx", view: "grid", pages: null });
    expect((await ok("POST", "/api/sandbox/office/prepare", { path: "a.zip" })).statut).toBe(415);
  });

  it("toutes les routes du domaine ont été interrogées", () => {
    for (const domaine of ["bac-fichiers", "bac-office"]) {
      const attendues = routesDuDomaine(domaine);
      expect([...couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
    }
  });
});
