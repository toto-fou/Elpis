// SPDX-License-Identifier: MIT
/** apps/toolhost/test/office-soffice.test.ts — aperçus avec le vrai LibreOffice sous bwrap (ELPIS_SOFFICE_TESTS=1, comme tests/shared_infra/test_office_soffice_real.py). */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { AgentClient } from "@elpis/fichiers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BacTest, dossierTemporaire, PYTHON } from "../../../packages/fichiers/test/aides";
import { creerAppToolhost } from "../src/app";
import { RAPPEL_ABSENT } from "../src/fichiers/commun";
import { attendreTachesOffice } from "../src/office/apercu";
import { countPdfPages, sofficeBin, surchargerDossierVerrous } from "../src/office/conversion";
import { routesOffice } from "../src/office/routes";
import { configTest, entetes, journalMuet } from "./aides";

const ACTIF = process.env["ELPIS_SOFFICE_TESTS"] === "1" && Boolean(PYTHON) && Boolean(sofficeBin());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(new URL("./vecteurs/toolhost_office.json", import.meta.url), "utf-8"));

describe.skipIf(!ACTIF)("vrai LibreOffice sous bwrap", () => {
  let dossier = "";
  let nettoyer = (): void => undefined;
  let bac: BacTest;
  let restaurer = (): void => undefined;

  beforeAll(async () => {
    [dossier, nettoyer] = dossierTemporaire("elpis-office-lo-");
    bac = new BacTest(dossier, "alice");
    mkdirSync(path.join(bac.sandboxPath, "docs"), { recursive: true });
    writeFileSync(path.join(bac.sandboxPath, "docs", "vrai.docx"), Buffer.from(V.docx[0].b64, "base64"));
    writeFileSync(
      path.join(bac.sandboxPath, "docs", "classeur.xlsx"),
      Buffer.from(V.classeurs.find((c: { nom: string }) => c.nom === "complet").b64, "base64"),
    );
    await bac.startAgent(false);
    process.env["APP_OFFICE_CACHE_DIR"] = path.join(dossier, "cache");
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: path.join(dossier, "config.json") });
    invalidateConfigCache();
    surchargerDossierVerrous(path.join(dossier, "locks"));
  });

  afterAll(async () => {
    await attendreTachesOffice();
    surchargerDossierVerrous(null);
    restaurer();
    delete process.env["APP_OFFICE_CACHE_DIR"];
    await bac.arreter();
    nettoyer();
  });

  it("docx et xlsx (vue pages) convertis en PDF dans la prison", async () => {
    const agent = new AgentClient(bac);
    const app = await creerAppToolhost({
      tc: configTest(),
      familles: [
        {
          nom: "office",
          routes: routesOffice({
            bac: { racine: async () => bac.sandboxPath, agent: async () => agent },
            rappel: RAPPEL_ABSENT,
            journal: journalMuet,
          }),
        },
      ],
      journal: journalMuet,
    });
    try {
      for (const [chemin, vue] of [
        ["docs/vrai.docx", undefined],
        ["docs/classeur.xlsx", "pages"],
      ] as const) {
        const r = await app.inject({
          method: "POST",
          url: "/api/sandbox/office/prepare",
          headers: { ...entetes(7, "alice"), "content-type": "application/json" },
          payload: JSON.stringify({ path: chemin, ...(vue ? { view: vue } : {}) }),
        });
        expect(r.statusCode, r.body).toBe(200);
        const pages = (r.json() as Dict)["pages"] as Dict;
        expect(Number(pages["count"])).toBeGreaterThanOrEqual(1);
        const pdf = await app.inject({
          method: "GET",
          url: String(pages["url"]),
          headers: entetes(7, "alice"),
        });
        expect(pdf.statusCode).toBe(200);
        expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
        const cle = String((r.json() as Dict)["key"]);
        expect(await countPdfPages(path.join(dossier, "cache", "u", "alice", cle, "doc.pdf"))).toBe(
          pages["count"],
        );
      }
    } finally {
      await app.close();
    }
  }, 180_000);
});
