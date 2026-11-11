// SPDX-License-Identifier: MIT
/** frontend/test/champs-admin.test.ts — l'index Ctrl+K de la console est à jour des gabarits et cohérent avec le registre. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { construire, lireIndex, rendre } from "../champs-admin.mts";
import { NAV_ADMIN } from "../src/features/admin/registre";

const FRONTEND = join(import.meta.dirname, "..");

describe("index des champs de la console", () => {
  const champs = construire();

  it("est à jour des gabarits", () => {
    expect(lireIndex()).toBe(rendre(champs));
  });

  it("vise une page du registre et un data-field réel", () => {
    const pages = new Set(Object.keys(NAV_ADMIN.pages));
    const dossier = join(FRONTEND, "src", "components", "admin");
    const gabarits = readdirSync(dossier)
      .filter((f) => /^Page.*\.vue$/.test(f))
      .map((f) => readFileSync(join(dossier, f), "utf8"))
      .join("");
    expect(champs.length).toBeGreaterThan(80);
    for (const c of champs) {
      expect(pages.has(c.page), c.path).toBe(true);
      expect(gabarits).toContain(`data-field="${c.store}:${c.path}"`);
      expect(c.label).not.toBe("");
      expect(c.label).not.toContain("{{");
    }
  });

  it("garde des repères", () => {
    const par = new Map(champs.map((c) => [`${c.store}:${c.path}`, c]));
    expect(par.get("config:llama.ip")?.page).toBe("inference");
    expect(par.get("config:maintenance.metrics_retention_days")?.label).toBe("Compteurs");
    expect(par.get("config:security.session.cookie_name")?.page).toBe("sessions");
    expect(par.get("exec:limits.memory_mb")?.page).toBe("sandbox-limits");
  });

  it("logo de l'écran de connexion : sa propre phrase, pas celle du logo de l'application", () => {
    const logo = construire().find((c) => c.path === "login_page.logo_b64");
    expect(logo).toMatchObject({ label: "Logo", page: "instance", store: "config" });
    expect(logo?.hint).toContain("carte de connexion");
    expect(logo?.hint).not.toMatch(/avatar|application/u);
  });

  it("les onglets (Onglet*.vue) ne portent aucun data-field : l'index ne lit que Page*.vue", () => {
    const dossier = join(FRONTEND, "src", "components", "admin");
    for (const f of readdirSync(dossier).filter((n) => /^Onglet.*\.vue$/.test(n))) {
      expect(readFileSync(join(dossier, f), "utf8"), f).not.toContain("data-field=");
    }
  });
});
