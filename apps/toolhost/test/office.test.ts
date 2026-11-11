// SPDX-License-Identifier: MIT
/** apps/toolhost/test/office.test.ts — aperçus Office et PDF de l'hôte (tests/shared_infra/test_sandbox_office_routes.py, test_office_xlsx, test_office_pages, test_office_convert) : vrai agent Python sans conteneur, LibreOffice simulé. */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { ecrireZip } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { AgentClient } from "@elpis/fichiers";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BacTest, dossierTemporaire, PYTHON } from "../../../packages/fichiers/test/aides";
import { creerAppToolhost } from "../src/app";
import { RAPPEL_ABSENT } from "../src/fichiers/commun";
import { attendreTachesOffice, oublierElagages } from "../src/office/apercu";
import {
  acquireFirst,
  buildArgv,
  childEnv,
  ensureProfile,
  ErreurOffice,
  readLogTail,
  releaseLock,
  runSofficeReel,
  surchargerDossierVerrous,
  surchargerLanceur,
  tryLock,
} from "../src/office/conversion";
import type { LanceurSoffice } from "../src/office/conversion";
import { routesOffice } from "../src/office/routes";
import { AnalyseurXml, analyserTout, parcourir } from "../src/office/xml";
import { configTest, entetes, journalMuet } from "./aides";

const CT_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const CT_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const DATE: [number, number, number, number, number, number] = [2020, 1, 1, 0, 0, 0];

function ooxml(ct: string, extra: Record<string, string> = {}): Buffer {
  return ecrireZip(
    Object.entries({ "[Content_Types].xml": `<Types><Override ContentType="${ct}"/></Types>`, ...extra }).map(
      ([nom, contenu]) => ({
        nom,
        donnees: Buffer.from(contenu),
        dateHeure: DATE,
        attributsExternes: 0o600 << 16,
      }),
    ),
  );
}

const XLSX = ooxml(CT_XLSX, {
  "xl/workbook.xml":
    '<workbook><sheets><sheet name="A"/><sheet name="B" state="hidden"/></sheets></workbook>',
  "xl/worksheets/sheet1.xml":
    '<worksheet><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c>' +
    '<c r="B1" t="inlineStr"><is><t>y</t></is></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c></row>' +
    "</sheetData></worksheet>",
  "xl/worksheets/sheet2.xml":
    '<worksheet><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>secret</t></is></c></row>' +
    "</sheetData></worksheet>",
  "_rels/.rels":
    '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
});

interface Etat {
  appels: string[][];
  mode: "ok" | "timeout" | "nooutput";
  delai: number;
  pages: number | null;
}

const etat: Etat = { appels: [], mode: "ok", delai: 0, pages: null };

/** `_fake_run` du Python : PDF de 3 pages (ou des pages demandées), délai, échec silencieux. */
const lanceurFactice: LanceurSoffice = async (argv, _env, o) => {
  etat.appels.push([...argv]);
  if (etat.delai) await new Promise((r) => setTimeout(r, etat.delai));
  const conv = argv[argv.indexOf("--convert-to") + 1] ?? "";
  if (etat.mode === "timeout")
    throw new ErreurOffice("timeout", 504, "Conversion trop longue (délai dépassé)");
  if (etat.mode === "nooutput") {
    writeFileSync(o.logPath, "Error: source file could not be loaded\n");
    return 0;
  }
  expect(conv.startsWith("csv:")).toBe(false);
  const plage = /"PageRange":\{"type":"string","value":"1-(\d+)"\}/u.exec(conv);
  const n = etat.pages === null ? 3 : Math.min(etat.pages, Number(plage?.[1] ?? etat.pages));
  writeFileSync(path.join(o.cwd, "out", "in.pdf"), "%PDF-1.7\n" + "<</Type/Page>>\n".repeat(n));
  writeFileSync(o.logPath, "convert ok\n");
  return 0;
};

let dossier: string;
let nettoyer: () => void;
let bac: BacTest;
let work: string;
let app: FastifyInstance;
let racineCompte: string;
let restaurer: () => void;
const envAvant = { ...process.env };

function config(valeur: Dict): void {
  writeFileSync(path.join(dossier, "config.json"), JSON.stringify(valeur));
  invalidateConfigCache();
}

beforeAll(async () => {
  [dossier, nettoyer] = dossierTemporaire("elpis-office-");
  bac = new BacTest(dossier, "alice");
  work = bac.sandboxPath;
  await bac.startAgent(false);
});

afterAll(async () => {
  await bac.arreter();
  nettoyer();
});

beforeEach(async () => {
  rmSync(path.join(dossier, "cache"), { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  mkdirSync(path.join(work, "docs"), { recursive: true });
  writeFileSync(path.join(work, "docs", "Rapport final.docx"), ooxml(CT_DOCX));
  writeFileSync(path.join(work, "docs", "t.xlsx"), XLSX);
  writeFileSync(path.join(work, "docs", "doc.pdf"), "%PDF-1.7\n1 0 obj<</Type/Page>>endobj\n%%EOF");
  writeFileSync(path.join(work, "docs", "faux.pdf"), "<html><script>alert(1)</script></html>");
  writeFileSync(path.join(work, "docs", "note.txt"), "x");
  const soffice = path.join(dossier, "soffice");
  writeFileSync(soffice, "#!/bin/sh\nexit 0\n");
  chmodSync(soffice, 0o755);
  process.env["APP_OFFICE_CACHE_DIR"] = path.join(dossier, "cache");
  process.env["APP_SOFFICE_BIN"] = soffice;
  restaurer = surchargerConfig({ CONFIG_JSON_PATH: path.join(dossier, "config.json") });
  config({ office_preview: { isolation: "none" } });
  surchargerDossierVerrous(path.join(dossier, "locks"));
  surchargerLanceur(lanceurFactice);
  oublierElagages();
  Object.assign(etat, { appels: [], mode: "ok", delai: 0, pages: null });
  racineCompte = work;
  const agent = new AgentClient(bac);
  app = await creerAppToolhost({
    tc: configTest(),
    familles: [
      {
        nom: "office",
        routes: routesOffice({
          bac: { racine: async () => racineCompte, agent: async () => agent },
          rappel: RAPPEL_ABSENT,
          journal: journalMuet,
        }),
      },
    ],
    journal: journalMuet,
  });
});

afterEach(async () => {
  await attendreTachesOffice();
  await app.close();
  surchargerLanceur(null);
  surchargerDossierVerrous(null);
  restaurer();
  invalidateConfigCache();
  for (const k of ["APP_OFFICE_CACHE_DIR", "APP_SOFFICE_BIN", "PATH"]) {
    if (envAvant[k] === undefined) delete process.env[k];
    else process.env[k] = envAvant[k];
  }
});

async function preparer(chemin: string, vue?: string): Promise<{ statut: number; corps: Dict }> {
  const r = await app.inject({
    method: "POST",
    url: "/api/sandbox/office/prepare",
    headers: { ...entetes(7, "alice"), "content-type": "application/json" },
    payload: JSON.stringify(vue === undefined ? { path: chemin } : { path: chemin, view: vue }),
  });
  return { statut: r.statusCode, corps: r.json() as Dict };
}

function lire(url: string, h: Record<string, string> = {}) {
  return app.inject({ method: "GET", url, headers: { ...entetes(7, "alice"), ...h } });
}

const detail = (c: Dict): Dict => c["detail"] as Dict;

describe.skipIf(!PYTHON)("routes des aperçus Office (agent Python sans conteneur)", () => {
  it("docx : préparation, puis PDF servi depuis le cache (inline, immuable, plage)", async () => {
    const r = await preparer("docs/Rapport final.docx");
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    const d = r.corps;
    expect([d["kind"], d["view"], d["grid"], d["rel"]]).toEqual([
      "docx",
      "pages",
      null,
      "docs/Rapport final.docx",
    ]);
    expect(typeof d["mtime"]).toBe("number");
    const pages = d["pages"] as Dict;
    expect([pages["count"], pages["truncated"]]).toEqual([3, false]);
    expect(pages["url"]).toBe(`/api/sandbox/office/pdf/${String(d["key"])}/Rapport%20final.pdf`);
    expect(etat.appels).toHaveLength(1);
    const argv = etat.appels[0] as string[];
    expect(argv).toContain("--infilter=MS Word 2007 XML");
    expect(argv.some((a) => a.startsWith("pdf:writer_pdf_Export:") && a.includes("PageRange"))).toBe(true);
    const encore = await preparer("/work/docs/Rapport final.docx");
    expect(encore.corps["key"]).toBe(d["key"]);
    expect(etat.appels).toHaveLength(1);
    const pdf = await lire(String(pages["url"]));
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["x-content-type-options"]).toBe("nosniff");
    expect(pdf.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(pdf.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(String(pdf.headers["cache-control"])).toContain("immutable");
    expect(String(pdf.headers["content-disposition"]).startsWith("inline;")).toBe(true);
    expect(pdf.body.startsWith("%PDF-")).toBe(true);
    const part = await lire(String(pages["url"]), { range: "bytes=0-3" });
    expect([part.statusCode, part.body]).toEqual([206, "%PDF"]);
  });

  it("une modification du fichier change la clé", async () => {
    const k1 = (await preparer("docs/Rapport final.docx")).corps["key"];
    writeFileSync(
      path.join(work, "docs", "Rapport final.docx"),
      ooxml(CT_DOCX, { "word/document.xml": "<w/>" }),
    );
    const k2 = (await preparer("docs/Rapport final.docx")).corps["key"];
    expect(k1).not.toBe(k2);
    expect(etat.appels).toHaveLength(2);
  });

  it("PDF natif sans conversion, faux PDF refusé", async () => {
    const r = await preparer("docs/doc.pdf");
    expect(r.statut).toBe(200);
    expect(etat.appels).toEqual([]);
    expect((await lire(String((r.corps["pages"] as Dict)["url"]))).body.startsWith("%PDF-1.7")).toBe(true);
    const faux = await preparer("docs/faux.pdf");
    expect([faux.statut, detail(faux.corps)["code"]]).toEqual([422, "invalid"]);
  });

  it("xlsx : grille par défaut (aucune conversion), feuille masquée à la demande, puis pages sous la même clé", async () => {
    const r = await preparer("docs/t.xlsx");
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    const d = r.corps;
    expect([d["view"], d["pages"]]).toEqual(["grid", null]);
    expect(etat.appels).toEqual([]);
    const feuilles = (d["grid"] as Dict)["sheets"] as Dict[];
    expect(feuilles.map((s) => [s["name"], s["hidden"], s["rows"], s["cols"]])).toEqual([
      ["A", false, 2, 2],
      ["B", true, 1, 1],
    ]);
    const m = await lire(`/api/sandbox/office/sheet/${String(d["key"])}/0/0`);
    expect([m.statusCode, m.json()]).toEqual([
      200,
      [
        ["x", "y"],
        ["1", "2"],
      ],
    ]);
    expect(String(m.headers["cache-control"])).toContain("immutable");
    expect([m.headers["x-office-rows"], m.headers["x-office-complete"]]).toEqual(["2", "1"]);
    const absent = await lire(`/api/sandbox/office/sheet/${String(d["key"])}/0/1`);
    expect([absent.statusCode, detail(absent.json() as Dict)["code"]]).toEqual([404, "expired"]);
    const cachee = await lire(`/api/sandbox/office/sheet/${String(d["key"])}/1/0`);
    expect([cachee.statusCode, cachee.json()]).toEqual([200, [["secret"]]]);
    const p = (await preparer("docs/t.xlsx", "pages")).corps;
    expect(p["key"]).toBe(d["key"]);
    expect(p["has"]).toEqual({ pages: true, grid: true });
    expect((etat.appels.at(-1) ?? []).some((a) => a.startsWith("pdf:calc_pdf_Export:"))).toBe(true);
  });

  it("clé invalide (400), absente (404), d'un autre compte (404)", async () => {
    expect((await lire("/api/sandbox/office/pdf/abc/x.pdf")).statusCode).toBe(400);
    const r = await lire(`/api/sandbox/office/pdf/${"f".repeat(40)}/x.pdf`);
    expect([r.statusCode, detail(r.json() as Dict)["code"]]).toEqual([404, "expired"]);
    const cle = String((await preparer("docs/doc.pdf")).corps["key"]);
    racineCompte = path.join(dossier, "sb", "bob", "work");
    mkdirSync(racineCompte, { recursive: true });
    expect((await lire(`/api/sandbox/office/pdf/${cle}/doc.pdf`)).statusCode).toBe(404);
    expect((await lire(`/api/sandbox/office/sheet/${cle}/x/0`)).statusCode).toBe(422);
  });

  it.each([
    ["../../bob/work/x.docx", 404, "not_found"],
    ["docs/absent.docx", 404, "not_found"],
    ["docs/note.txt", 415, "unsupported"],
  ])("chemin %s → %i %s", async (chemin, statut, code) => {
    const r = await preparer(chemin);
    expect([r.statut, detail(r.corps)["code"]]).toEqual([statut, code]);
  });

  it("requête invalide", async () => {
    const brut = await app.inject({
      method: "POST",
      url: "/api/sandbox/office/prepare",
      headers: { ...entetes(7, "alice"), "content-type": "application/json" },
      payload: "pas du json",
    });
    expect([brut.statusCode, brut.json()]).toEqual([
      400,
      { detail: { code: "invalid", message: "Requête invalide" } },
    ]);
    expect((await preparer("")).statut).toBe(400);
    expect((await preparer("a.docx", "html")).statut).toBe(400);
  });

  it("drapeau coupé : Office refusé, PDF servi", async () => {
    config({ office_preview: { isolation: "none" }, features: { office_preview: false } });
    const r = await preparer("docs/Rapport final.docx");
    expect([r.statut, detail(r.corps)["code"]]).toEqual([403, "disabled"]);
    expect((await preparer("docs/doc.pdf")).statut).toBe(200);
  });

  it("LibreOffice absent, délai dépassé, échec silencieux (dossier de travail nettoyé)", async () => {
    process.env["APP_SOFFICE_BIN"] = path.join(dossier, "absent");
    const bin = path.join(dossier, "bin");
    mkdirSync(bin, { recursive: true });
    if (!existsSync(path.join(bin, "flock"))) symlinkSync("/usr/bin/flock", path.join(bin, "flock"));
    process.env["PATH"] = bin;
    const r = await preparer("docs/Rapport final.docx");
    expect([r.statut, detail(r.corps)["code"]]).toEqual([503, "soffice_missing"]);
    process.env["PATH"] = envAvant["PATH"];
    process.env["APP_SOFFICE_BIN"] = path.join(dossier, "soffice");
    etat.mode = "timeout";
    expect(detail((await preparer("docs/Rapport final.docx")).corps)["code"]).toBe("timeout");
    etat.mode = "nooutput";
    const e = await preparer("docs/Rapport final.docx");
    expect([e.statut, detail(e.corps)["code"]]).toEqual([500, "failed"]);
    expect(
      readdirSync(path.join(dossier, "cache", "u", "alice")).filter((n) => n.startsWith(".tmp-")),
    ).toEqual([]);
  });

  it("conversions occupées (créneau tenu par ce processus) : 503 busy, puis servie une fois rendu", async () => {
    config({ office_preview: { isolation: "none", wait_s: 1, slots: 1, slots_per_user: 1, timeout_s: 5 } });
    const tenu = await tryLock("slot-0");
    try {
      const r = await preparer("docs/Rapport final.docx");
      expect([r.statut, detail(r.corps)["code"]]).toEqual([503, "busy"]);
    } finally {
      releaseLock(tenu);
    }
    expect((await preparer("docs/Rapport final.docx")).statut).toBe(200);
  });

  it("demandes simultanées : une seule conversion", async () => {
    etat.delai = 300;
    const rs = await Promise.all([1, 2, 3].map(() => preparer("docs/Rapport final.docx")));
    expect(rs.map((r) => r.statut)).toEqual([200, 200, 200]);
    expect(new Set(rs.map((r) => r.corps["key"])).size).toBe(1);
    expect(etat.appels).toHaveLength(1);
  });

  it("document long : premières pages d'abord, passe complète en fond (révision dans l'URL)", async () => {
    config({ office_preview: { isolation: "none", first_pages: 2 } });
    etat.pages = 5;
    const r = await preparer("docs/Rapport final.docx");
    const pages = r.corps["pages"] as Dict;
    expect([pages["count"], pages["partial"]]).toEqual([2, true]);
    await attendreTachesOffice();
    const encore = (await preparer("docs/Rapport final.docx")).corps["pages"] as Dict;
    expect([encore["count"], encore["partial"], encore["truncated"]]).toEqual([5, false, false]);
    expect(String(encore["url"]).endsWith("?r=1")).toBe(true);
    expect(etat.appels).toHaveLength(2);
    const cle = String(r.corps["key"]);
    expect(existsSync(path.join(dossier, "cache", "u", "alice", cle, "src.docx"))).toBe(false);
  });

  it("classeur : copié dans le cache, morceaux bâtis à la demande, classeur sans feuille refusé", async () => {
    const lignes = Array.from(
      { length: 1500 },
      (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`,
    );
    writeFileSync(
      path.join(work, "docs", "gros.xlsx"),
      ooxml(CT_XLSX, {
        "xl/workbook.xml": '<workbook><sheets><sheet name="G"/></sheets></workbook>',
        "xl/worksheets/sheet1.xml": `<worksheet><dimension ref="A1:A1500"/><sheetData>${lignes.join("")}</sheetData></worksheet>`,
      }),
    );
    const d = (await preparer("docs/gros.xlsx")).corps;
    const f = ((d["grid"] as Dict)["sheets"] as Dict[])[0] as Dict;
    expect([f["rows"], f["chunks"], f["complete"]]).toEqual([1500, 5, false]);
    rmSync(path.join(work, "docs", "gros.xlsx"));
    const m = await lire(`/api/sandbox/office/sheet/${String(d["key"])}/0/7`);
    expect(m.statusCode).toBe(200);
    expect((m.json() as string[][])[0]).toEqual(["1400"]);
    expect(m.headers["x-office-complete"]).toBe("1");
    expect((await lire(`/api/sandbox/office/sheet/${String(d["key"])}/3/0`)).statusCode).toBe(404);
    writeFileSync(path.join(work, "docs", "vide.xlsx"), ooxml(CT_XLSX, { "xl/workbook.xml": "<workbook/>" }));
    const v = await preparer("docs/vide.xlsx");
    expect([v.statut, detail(v.corps)["message"]]).toEqual([422, "Classeur sans feuille lisible"]);
  });

  it("manifeste au format du Python (relu par lui)", async () => {
    const d = (await preparer("docs/t.xlsx")).corps;
    const brut = readFileSync(
      path.join(dossier, "cache", "u", "alice", String(d["key"]), "manifest.json"),
      "utf-8",
    );
    expect(brut.startsWith('{"v": 1, "key": ')).toBe(true);
    const relu = runPython(
      "import json,sys; m=json.load(open(sys.argv[1])); print(m['v'], m['kind'], type(m['mtime']).__name__, m['grid']['sheets'][0]['rows'])",
      path.join(dossier, "cache", "u", "alice", String(d["key"]), "manifest.json"),
    );
    expect(relu.trim()).toBe("1 xlsx float 2");
    expect(statSync(path.join(dossier, "cache")).mode & 0o777).toBe(0o700);
  });
});

function runPython(code: string, ...args: string[]): string {
  return spawnSync(PYTHON as string, ["-c", code, ...args], { encoding: "utf8" }).stdout;
}

describe("conversion (office_convert)", () => {
  it("argv en prison : filtre forcé, sortie, profil et travail montés", () => {
    const argv = buildArgv({
      isolation: "bwrap",
      soffice: "/usr/lib/libreoffice/program/soffice",
      profil: "/c/profiles/slot-0",
      job: "/c/u/a/.tmp-x",
      kind: "docx",
      inName: "in.docx",
      convertTo: "pdf:writer_pdf_Export",
      timeoutS: 60,
    });
    const lo = argv.slice(argv.indexOf("/usr/lib/libreoffice/program/soffice"));
    expect(lo).toEqual([
      "/usr/lib/libreoffice/program/soffice",
      "--headless",
      "--norestore",
      "--nologo",
      "--nodefault",
      "--nolockcheck",
      "-env:UserInstallation=file:///profile",
      "--infilter=MS Word 2007 XML",
      "--convert-to",
      "pdf:writer_pdf_Export",
      "--outdir",
      "/job/out",
      "/job/in.docx",
    ]);
    const i = argv.indexOf("--bind");
    expect(argv.slice(i, i + 6)).toEqual([
      "--bind",
      "/c/profiles/slot-0",
      "/profile",
      "--bind",
      "/c/u/a/.tmp-x",
      "/job",
    ]);
    expect(argv).toContain("--unshare-all");
    const sans = buildArgv({
      isolation: "none",
      soffice: "/s",
      profil: "/p",
      job: "/j",
      kind: "xlsx",
      inName: "in.xlsx",
      convertTo: "pdf",
      timeoutS: 5,
    });
    expect(sans).not.toContain("--unshare-all");
    expect(sans.slice(sans.indexOf("/s"))).toContain("/j/in.xlsx");
  });

  it("environnement minimal, sans secret", () => {
    process.env["SESSION_SECRET"] = "fuite";
    try {
      expect(childEnv("bwrap", "/p", "/j")).toEqual({
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        HOME: "/profile",
        TMPDIR: "/tmp",
      });
      expect(childEnv("none", "/p", "/j")).toEqual({
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        HOME: "/p",
        TMPDIR: "/j/tmp",
      });
    } finally {
      delete process.env["SESSION_SECRET"];
    }
  });

  it("verrou exclusif (même processus), premier créneau libre, puis occupé", async () => {
    const [d, fin] = dossierTemporaire("elpis-office-verrous-");
    surchargerDossierVerrous(d);
    try {
      const a = await tryLock("slot-0");
      expect(a).not.toBeNull();
      expect(await tryLock("slot-0")).toBeNull();
      expect(await tryLock("../x")).toBeNull();
      const [fd, nom] = await acquireFirst(["slot-0", "slot-1"], performance.now() / 1000 + 1);
      expect(nom).toBe("slot-1");
      await expect(acquireFirst(["slot-0", "slot-1"], performance.now() / 1000)).rejects.toMatchObject({
        code: "busy",
      });
      releaseLock(a);
      releaseLock(fd);
      const b = await tryLock("slot-0");
      expect(b).not.toBeNull();
      releaseLock(b);
    } finally {
      surchargerDossierVerrous(null);
      fin();
    }
  });

  it("profil semé, verrou résiduel retiré", () => {
    const [d, fin] = dossierTemporaire("elpis-office-profil-");
    try {
      const p = path.join(d, "profiles", "slot-0");
      ensureProfile(p);
      expect(readFileSync(path.join(p, "user", "registrymodifications.xcu"), "utf-8")).toContain(
        "DisableMacrosExecution",
      );
      writeFileSync(path.join(p, ".lock"), "x");
      ensureProfile(p);
      expect(existsSync(path.join(p, ".lock"))).toBe(false);
    } finally {
      fin();
    }
  });

  it("délai dépassé : tout le groupe tué ; code rendu et journal", async () => {
    const [d, fin] = dossierTemporaire("elpis-office-run-");
    try {
      const marque = path.join(d, "vivant");
      const debut = performance.now();
      await expect(
        runSofficeReel(
          ["/bin/sh", "-c", `(sleep 3; touch ${marque}) & sleep 30`],
          { PATH: "/usr/bin:/bin" },
          {
            cwd: d,
            logPath: path.join(d, "lo.log"),
            timeoutS: 0.3,
          },
        ),
      ).rejects.toMatchObject({ code: "timeout", status: 504 });
      expect(performance.now() - debut).toBeLessThan(3000);
      await new Promise((r) => setTimeout(r, 3500));
      expect(existsSync(marque)).toBe(false);
      const rc = await runSofficeReel(
        ["/bin/sh", "-c", "echo javaldx: x; echo bonjour; exit 3"],
        { PATH: "/usr/bin:/bin" },
        {
          cwd: d,
          logPath: path.join(d, "lo2.log"),
          timeoutS: 5,
        },
      );
      expect(rc).toBe(3);
      expect(readLogTail(path.join(d, "lo2.log"))).toBe("bonjour");
      const tue = await runSofficeReel(
        ["/bin/sh", "-c", "kill -USR1 $$"],
        { PATH: "/usr/bin:/bin" },
        { cwd: d, logPath: path.join(d, "lo3.log"), timeoutS: 5 },
      );
      expect(tue).toBe(-10);
      const arret = new AbortController();
      const annule = runSofficeReel(
        ["/bin/sh", "-c", `(sleep 3; touch ${marque}) & sleep 30`],
        { PATH: "/usr/bin:/bin" },
        { cwd: d, logPath: path.join(d, "lo4.log"), timeoutS: 30, signal: arret.signal },
      );
      setTimeout(() => arret.abort(new ErreurOffice("cancelled", 503, "arrêt")), 200);
      await expect(annule).rejects.toMatchObject({ code: "cancelled", status: 503 });
      await new Promise((r) => setTimeout(r, 3500));
      expect(existsSync(marque)).toBe(false);
    } finally {
      fin();
    }
  }, 20_000);
});

describe("analyseur XML", () => {
  it("grosses balises reçues par blocs : chaque caractère lu une fois ; imbrication profonde parcourue", () => {
    const MO = 1 << 20;
    for (const doc of [
      `<r a="${">".repeat(4 * MO)}"/>`,
      `<r>${"x".repeat(4 * MO)}</r>`,
      `<r><![CDATA[${"]".repeat(4 * MO)}x]]></r>`,
      `<r><?pi ${"?".repeat(4 * MO)}x?><!--${"x".repeat(4 * MO)}--></r>`,
    ]) {
      const octets = Buffer.from(doc);
      const debut = performance.now();
      const a = new AnalyseurXml();
      for (let i = 0; i < octets.length; i += 16384) a.nourrir(octets.subarray(i, i + 16384));
      expect(a.terminer().tag).toBe("r");
      expect(performance.now() - debut).toBeLessThan(3000);
    }
    const profond = analyserTout(Buffer.from("<a>".repeat(20_000) + "<b/>" + "</a>".repeat(20_000)));
    expect([...parcourir(profond)].length).toBe(20_001);
    expect([...parcourir(profond, "b")].map((e) => e.tag)).toEqual(["b"]);
  });
});
