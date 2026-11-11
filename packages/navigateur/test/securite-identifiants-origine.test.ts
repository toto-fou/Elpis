// SPDX-License-Identifier: MIT
/** packages/navigateur/test/securite-identifiants-origine.test.ts — identifiants de sites après le coffre « Secrets » : statistiques des sites tirées des identifiants donnés par l'appelant (jamais d'`ax_credentials`), aucun indice au prompt, alias et réduction d'IP de la mémoire AX, purges des anciennes lignes. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteCredentials,
  deleteOwnerCredentials,
  deleteSite,
  getSiteStats,
  listSitesWithStats,
  normalizeUrl,
  renderFullDomForPrompt,
} from "../src/ax";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const JENKINS = "http://192.168.0.10:8080";

describe.each(MOTEURS)("identifiants de sites liés à l'origine exacte (%s)", (moteur) => {
  let t: BaseDeTest;
  let dossier: string;
  let restaurer: (() => void) | null = null;

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    dossier = mkdtempSync(join(tmpdir(), "elpis-origine-"));
  });

  afterEach(async () => {
    restaurer?.();
    restaurer = null;
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  const cles = async (): Promise<string[]> =>
    (await t.base.all<{ site: string }>("SELECT site FROM ax_credentials ORDER BY site")).map((r) => r.site);
  /** Ligne d'avant la correction : clé sans origine. */
  const ancienne = (site: string, owner = "alice"): Promise<unknown> =>
    t.base.run(
      "INSERT INTO ax_credentials (owner, site, username, password, last_ok, use_count) VALUES (?, ?, 'ancien', 'mdp-ancien', 1000.5, 4)",
      [owner, site],
    );
  /** Page apprise : la mémoire AX connaît ce site. */
  const noeud = (site: string): Promise<unknown> =>
    t.base.run(
      "INSERT INTO ax_nodes (site, path, node_type, role, name, node_key, verified_count, last_ok, stale) VALUES (?, '/', 'element', 'button', 'Ok', 'k1', 3, 1000.5, 0)",
      [site],
    );

  /** Ligne d'`ax_credentials` posée telle quelle (origine exacte ou ancienne clé). */
  const ligne = (site: string, owner = "alice", password = "mdp-ligne"): Promise<unknown> =>
    t.base.run(
      "INSERT INTO ax_credentials (owner, site, username, password, last_ok, use_count) VALUES (?, ?, 'ligne', ?, 1000.5, 2)",
      [owner, site, password],
    );

  it("statistiques : rien d'`ax_credentials` (ni origine exacte ni ancienne clé), seulement ce que donne l'appelant", async () => {
    await noeud(":8080");
    await ligne(JENKINS);
    await ancienne(":8080");
    expect(await listSitesWithStats(t.base)).toEqual([
      expect.objectContaining({
        site: ":8080",
        has_credentials: false,
        cred_username: null,
        cred_origin: null,
        cred_use_count: 0,
      }),
    ]);
    const coffre = (site: string) =>
      site === ":8080" ? { username: "admin", origin: JENKINS, use_count: 5, last_ok: 1700.5 } : undefined;
    expect(await listSitesWithStats(t.base, coffre)).toEqual([
      expect.objectContaining({
        site: ":8080",
        has_credentials: true,
        cred_username: "admin",
        cred_origin: JENKINS,
        cred_use_count: 5,
      }),
    ]);
    expect(await getSiteStats(t.base, ":8080", coffre)).toMatchObject({
      has_credentials: true,
      cred_username: "admin",
      cred_origin: JENKINS,
      cred_use_count: 5,
    });
    expect(await getSiteStats(t.base, ":8080")).toMatchObject({ has_credentials: false, cred_last_ok: null });
    expect(JSON.stringify(await listSitesWithStats(t.base, coffre))).not.toContain("mdp");
  });

  it("prompt : aucun indice d'identifiants, même avec des lignes de l'origine exacte", async () => {
    await noeud(":8080");
    await ligne(JENKINS, "alice", "mdp-jenkins");
    await ancienne(":8080");
    const rendu = await renderFullDomForPrompt(t.base, ":8080", 6000, "alice");
    expect(rendu).not.toContain("CREDENTIALS");
    expect(rendu).not.toContain("ligne");
    expect(rendu).not.toContain("mdp-jenkins");
  });

  it("alias de port et réduction de toute IP : appliqués aux sites de la mémoire AX", async () => {
    const fichier = join(dossier, "config.json");
    writeFileSync(
      fichier,
      JSON.stringify({ app: { ax_site_aliases: { "8443": "portail" }, ax_dedup_any_ip: true } }),
    );
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: fichier });
    expect(normalizeUrl("https://a.lan:8443/x")[0]).toBe("portail");
    expect(normalizeUrl("https://b.lan:8443/x")[0]).toBe("portail");
    expect(normalizeUrl("http://93.184.216.34:9000/")[0]).toBe(":9000");
    expect(normalizeUrl("http://93.184.216.35:9000/")[0]).toBe(":9000");
  });

  it("purges des anciennes lignes : le site AX retire ses origines et son ancienne clé ; les autres sites restent", async () => {
    await ancienne(":8080");
    await ligne(JENKINS, "alice");
    await ligne("http://192.168.0.20:8080", "bob");
    await ligne("https://autre.lan", "alice");

    expect(await deleteCredentials(t.base, ":8080", "alice")).toBe(true);
    expect(await cles()).toEqual(["http://192.168.0.20:8080", "https://autre.lan"]);
    expect(await deleteCredentials(t.base, ":8080", "alice")).toBe(false);

    await ancienne(":8080");
    expect(await deleteCredentials(t.base, "http://192.168.0.99:8080/x")).toBe(true);
    expect(await cles()).toEqual(["https://autre.lan"]);

    await ligne(JENKINS, "alice");
    await ancienne(":8080");
    expect(await deleteSite(t.base, ":8080", true)).toMatchObject({ deleted: { credentials: 2 } });
    expect(await deleteSite(t.base, "autre.lan", false)).toMatchObject({ deleted: { credentials: 0 } });
    expect(await cles()).toEqual(["https://autre.lan"]);

    expect(await deleteOwnerCredentials(t.base, "alice")).toBe(1);
    expect(await cles()).toEqual([]);
  });
});
