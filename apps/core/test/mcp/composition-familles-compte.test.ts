// SPDX-License-Identifier: MIT
/** apps/core/test/mcp/composition-familles-compte.test.ts — la composition de main enregistre les familles memory et todo sur le serveur MCP du process ; admin n'en crée aucun. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { oublierConfigurationAudit } from "@elpis/securite";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { composer } from "../../src/composition";
import {
  oublierServeurEnProcessus,
  serveurEnProcessus,
  serviceEnProcessus,
} from "../../src/outils/mcp/en-processus";
import { journalMuet } from "../aides";

let t: BaseDeTest;
let audit: string;
const auditAvant = process.env["ELPIS_AUDIT_DIR"];

beforeAll(() => {
  audit = mkdtempSync(join(tmpdir(), "elpis-audit-familles-"));
  process.env["ELPIS_AUDIT_DIR"] = audit;
});

afterAll(() => {
  if (auditAvant === undefined) delete process.env["ELPIS_AUDIT_DIR"];
  else process.env["ELPIS_AUDIT_DIR"] = auditAvant;
  oublierConfigurationAudit();
  rmSync(audit, { recursive: true, force: true });
});

beforeEach(async () => {
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  oublierServeurEnProcessus();
});

afterEach(async () => {
  await serviceEnProcessus()?.fermer();
  oublierServeurEnProcessus();
  await t.fermer();
});

const dep = (): Parameters<typeof composer>[3] => ({
  base: t.base,
  config: () => ({}),
  attributsCookie: () => ({ cookie_name: "s", same_site: "lax", https_only: false, max_age: 86400 }),
  secret: () => "secret-de-test",
  jetonService: () => "",
  maintenant: () => 1_791_331_200,
});

describe("composition : familles du compte portées", () => {
  it("main : chart, memory et todo enregistrées sur le serveur MCP en processus, sous leurs outils figés", async () => {
    await composer("main", t.base, journalMuet, dep());
    expect(serveurEnProcessus()?.famillesActives).toEqual(["chart", "memory", "skill", "todo"]);
    expect(serveurEnProcessus()?.familleDe("todowrite")).toBe("todo");
    expect(serveurEnProcessus()?.familleDe("memory")).toBe("memory");
    expect(serveurEnProcessus()?.familleDe("session_search")).toBe("memory");
    expect(serveurEnProcessus()?.familleDe("chart_bar")).toBe("chart");
    expect(serveurEnProcessus()?.familleDe("chart_table")).toBe("chart");
    expect(serveurEnProcessus()?.familleDe("skill_save")).toBe("skill");
  });

  it("admin : aucun serveur MCP en processus, donc aucune famille", async () => {
    await composer("admin", t.base, journalMuet, dep());
    expect(serveurEnProcessus()).toBeNull();
  });
});
