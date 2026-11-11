// SPDX-License-Identifier: MIT
/** apps/core/test/journal-securite/catalogue-reglages.test.ts — journal de sécurité des réglages (config.json, compression) et de la sécurité de la console. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut } from "@elpis/auth";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerFamilleAdminAgents } from "../../src/familles/admin-agents";
import { creerFamilleAdminConfig } from "../../src/familles/admin-config";
import { creerFamilleAdminExecuteurs } from "../../src/familles/admin-executeurs";
import { creerFamilleAdminSecurite } from "../../src/familles/admin-securite";
import { creerFamilleMetriques } from "../../src/familles/metriques";
import type { ContexteMetriques } from "../../src/observabilite/fournisseurs/base";
import { appTest, journalMuet } from "../aides";
import { journalDeTest } from "./aides-journal";
import type { JournalDeTest } from "./aides-journal";

describe("journal de sécurité : réglages et sécurité de la console", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let j: JournalDeTest;
  let dossier: string;
  let fichier: string;
  let restaurer: () => void;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "root", "mdp-root", { isAdmin: 1 });
    await createUser(t.base, "bob", "mdp-bob", { isAdmin: 0 });
    dossier = mkdtempSync(join(tmpdir(), "elpis-cat-reglages-"));
    fichier = join(dossier, "config.json");
    writeFileSync(fichier, JSON.stringify({ app: { nom: "x" }, security: { listen: "lan" } }));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: fichier });
    invalidateConfigCache();
    j = journalDeTest("admin");
    app = await appTest({
      mode: "admin",
      familles: [
        creerFamilleAdminConfig({ journal: journalMuet, fermerClientCompression: async () => {} }),
        creerFamilleAdminSecurite({
          base: t.base,
          auth: dependancesParDefaut(t.base),
          journal: journalMuet,
          revoquer: async () => null,
          diffuser: async () => true,
          cycleVie: { redemarrerMain: async () => false, programmerRechargement: () => {} },
          sonderPort: async () => true,
        }),
        creerFamilleAdminExecuteurs({ base: t.base, journal: journalMuet }),
        creerFamilleAdminAgents({ journal: journalMuet }),
        creerFamilleMetriques({
          base: t.base,
          auth: dependancesParDefaut(t.base),
          contexte: {} as ContexteMetriques,
          genererJeton: () => "Jeton-Scrape-Secret-1",
        }),
      ],
      gardes: {
        admin: (req) => {
          req.utilisateur = { id: 1, username: "root" };
        },
        staff: (req) => {
          req.utilisateur = { id: 1, username: "root" };
        },
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    restaurer?.();
    invalidateConfigCache();
    j?.fermer();
    await t?.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("PATCH : champs changés, secret masqué, rien sur un conflit", async () => {
    const r = await app.inject({
      method: "PATCH",
      url: "/api/admin/config",
      payload: {
        force: true,
        changes: [
          { path: "app.nom", to: "y" },
          { path: "llm.secret_perso", to: "Secret-Config-1" },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
    expect(j.derniere("admin.config.patch")).toMatchObject({
      outcome: "success",
      user_id: 1,
      username: "root",
      details: {
        force: true,
        changes: [
          { path: "app.nom", before: "x", after: "y" },
          { path: "llm.secret_perso", before: null, after: "********" },
        ],
      },
    });
    expect(j.derniere("admin.config.patch").ip).not.toBeNull();
    const avant = j.de("admin.config.patch").length;
    const conflit = await app.inject({
      method: "PATCH",
      url: "/api/admin/config",
      payload: { changes: [{ path: "app.nom", from: "faux", to: "z" }] },
    });
    expect(conflit.statusCode).toBe(409);
    expect(j.de("admin.config.patch")).toHaveLength(avant);
    expect(j.brut()).not.toContain("Secret-Config-1");
  });

  it("enregistrement du fichier : différence entre le disque et le contenu écrit", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/config-file",
      payload: {
        type: "main",
        content: JSON.stringify({ app: { nom: "w" }, nouveau: 1, security: { listen: "lan" } }),
      },
    });
    expect(r.statusCode).toBe(200);
    const { changes } = j.derniere("admin.config.file_save").details as { changes: { path: string }[] };
    expect(changes.map((c) => c.path)).toEqual(
      expect.arrayContaining(["app.nom", "nouveau", "llm.secret_perso"]),
    );
  });

  it("secrets imbriqués : jetons clients MCP, listes, dicts supprimés, jamais dans le texte du journal", async () => {
    writeFileSync(
      fichier,
      JSON.stringify({
        app: { nom: "x" },
        security: { listen: "lan" },
        rag: { embed: { url: "http://e", api_key: "Secret-Embed-1" } },
        mcp: { local_client_tokens: { "Jeton-Client-Ancien-1": "git" } },
      }),
    );
    invalidateConfigCache();
    const r = await app.inject({
      method: "PATCH",
      url: "/api/admin/config",
      payload: {
        force: true,
        changes: [
          { path: "mcp.local_client_tokens.Jeton-Client-Patch-2", to: "git,fs" },
          { path: "desktop.targets", to: [{ name: "p", agent_token: "Secret-Agent-1234567890abcdef" }] },
          { path: "rag.embed", delete: true },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
    expect(j.derniere("admin.config.patch").details["changes"]).toEqual([
      { path: "desktop.targets", before: null, after: [{ name: "p", agent_token: "********" }] },
      { path: "mcp.local_client_tokens", before: "********", after: "********" },
      { path: "rag.embed.api_key", before: "********", after: null },
      { path: "rag.embed.url", before: "http://e", after: null },
    ]);
    const enregistre = await app.inject({
      method: "POST",
      url: "/api/admin/config-file",
      payload: {
        type: "main",
        content: JSON.stringify({
          app: { nom: "x" },
          security: { listen: "lan" },
          mcp: { local_client_tokens: { "Jeton-Client-Fichier-3": "git" } },
          voice: { stt: { token: "Secret-Stt-1" } },
        }),
      },
    });
    expect(enregistre.statusCode).toBe(200);
    const { changes } = j.derniere("admin.config.file_save").details as { changes: { path: string }[] };
    expect(changes).toContainEqual({
      path: "mcp.local_client_tokens",
      before: "********",
      after: "********",
    });
    expect(j.brut()).not.toMatch(/Jeton-Client|Secret-Embed|Secret-Agent|Secret-Stt/u);
  });

  it("enregistrement d'un gros fichier : ligne entière (pas de résumé tronqué), reste compté dans more", async () => {
    const gros = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`cle${String(i).padStart(2, "0")}`, "v".repeat(190)]),
    );
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/config-file",
      payload: {
        type: "main",
        content: JSON.stringify({ app: { nom: "x" }, security: { listen: "lan" }, ...gros }),
      },
    });
    expect(r.statusCode).toBe(200);
    const d = j.derniere("admin.config.file_save").details as {
      changes: unknown[];
      more?: number;
      _truncated?: boolean;
    };
    expect(d._truncated).toBeUndefined();
    expect(d.changes.length).toBeGreaterThan(0);
    expect(d.more).toBeGreaterThan(0);
  });

  it("compression : champs modifiés", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/compression-config",
      payload: { enabled: true, keep_recent_turns: 7, endpoint_url: "http://u:Secret-Compression@h.test/x" },
    });
    expect(r.statusCode).toBe(200);
    const { changes } = j.derniere("admin.config.compression").details as { changes: { path: string }[] };
    expect(changes.map((c) => c.path)).toContain("keep_recent_turns");
    expect(j.brut()).not.toContain("Secret-Compression");
  });

  it("exécuteurs, sous-agents, jeton de scrape : compte et IP du client, jeton jamais écrit", async () => {
    await app.inject({
      method: "POST",
      url: "/api/admin/executors",
      payload: { executors: { force_user_docker: true } },
    });
    await app.inject({ method: "POST", url: "/api/admin/agents", payload: { agents: {} } });
    const r = await app.inject({ method: "POST", url: "/api/admin/metrics/scrape-token", payload: {} });
    expect(r.statusCode).toBe(200);
    for (const action of [
      "admin.executors.update",
      "admin.agents.update",
      "admin.metrics.scrape_token.generate",
    ])
      expect(j.derniere(action)).toMatchObject({ user_id: 1, username: "root", ip: expect.any(String) });
    expect(j.brut()).not.toContain("Jeton-Scrape-Secret-1");
  });

  it("sécurité : écoute, HTTPS et levée de révocation", async () => {
    await app.inject({ method: "POST", url: "/api/admin/security/listen", payload: { listen: "local" } });
    expect(j.derniere("admin.security.listen").details).toEqual({ before: "lan", after: "local" });
    await app.inject({ method: "POST", url: "/api/admin/security/https", payload: { enabled: true } });
    expect(j.derniere("admin.security.https").details).toEqual({ before: false, after: true });
    await app.inject({ method: "POST", url: "/api/admin/security/sessions/clear-user-revocation/2" });
    expect(j.derniere("admin.security.sessions.clear_user_revocation").details).toEqual({
      target_user_id: 2,
    });
  });
});
