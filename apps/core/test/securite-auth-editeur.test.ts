// SPDX-License-Identifier: MIT
/** apps/core/test/securite-auth-editeur.test.ts — l'éditeur générique de config.json ne crée ni ne modifie `auth` (disque lisible ou non), n'écrit rien quand la fusion échoue et refuse les valeurs trop imbriquées. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type * as AdminConfig from "../src/admin/config";
import { creerFamilleAdminConfig } from "../src/familles/admin-config";
import { appTest, journalMuet } from "./aides";
import { configDeTest, ldapValide } from "./identite/aides";
import type { ConfigDeTest } from "./identite/aides";

const AUTH = { public_url: "https://elpis.exemple.lan", local: { mode: "all" }, providers: [ldapValide()] };
const AUTH_HOSTILE = {
  public_url: "https://elpis.exemple.lan",
  local: { mode: "admins" },
  providers: [ldapValide({ enabled: true })],
};

const fusionEnPanne = vi.hoisted(() => ({ actif: false }));

vi.mock("../src/admin/config", async (original) => {
  const reel = await original<typeof AdminConfig>();
  return {
    ...reel,
    applySectionOwnership: (...a: Parameters<typeof reel.applySectionOwnership>) => {
      if (fusionEnPanne.actif) throw new RangeError("Maximum call stack size exceeded");
      return reel.applySectionOwnership(...a);
    },
  };
});

describe("config.json : l'éditeur générique et la section `auth`", () => {
  let cfg: ConfigDeTest;
  let dossier: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    cfg = configDeTest();
    dossier = mkdtempSync(join(tmpdir(), "elpis-securite-editeur-"));
    configureAudit({
      service: "admin",
      auditDir: join(dossier, "audit"),
      hmacKeyPath: join(dossier, "sans-cle"),
    });
    app = await appTest({
      mode: "admin",
      familles: [
        creerFamilleAdminConfig({ journal: journalMuet, fermerClientCompression: async () => undefined }),
      ],
      gardes: {
        admin: async (req) => void (req.utilisateur = { id: 1, username: "chef" }),
        staff: async (req) => void (req.utilisateur = { id: 1, username: "chef" }),
        session: async (req) => void (req.utilisateur = { id: 1, username: "chef" }),
        service: async () => undefined,
      },
    });
  });

  afterAll(async () => {
    await app.close();
    oublierConfigurationAudit();
    cfg.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  const enregistrer = (contenu: string): Promise<{ statusCode: number }> =>
    app.inject({
      method: "POST",
      url: "/api/admin/config-file",
      payload: { type: "main", content: contenu },
    });
  const fichier = (): string => (existsSync(cfg.chemin) ? readFileSync(cfg.chemin, "utf8") : "");
  const profond = (n: number): unknown => {
    let v: unknown = 1;
    for (let i = 0; i < n; i++) v = [v];
    return v;
  };

  it("disque illisible : `auth` n'est jamais écrite ; journal de sécurité et sous-agents gardent leur réparation par l'éditeur", async () => {
    writeFileSync(cfg.chemin, "{ pas du json");
    const r = await enregistrer(
      JSON.stringify({
        app: { nom: "x" },
        auth: AUTH_HOSTILE,
        agents: { a: 1 },
        security: { audit: { b: 2 } },
      }),
    );
    expect(r.statusCode).toBe(200);
    const ecrit = JSON.parse(fichier()) as Record<string, unknown>;
    expect([
      ecrit["app"],
      ecrit["auth"],
      ecrit["agents"],
      (ecrit["security"] as Record<string, unknown>)["audit"],
    ]).toEqual([{ nom: "x" }, undefined, { a: 1 }, { b: 2 }]);
  });

  it("disque lisible : `auth` du disque inchangée, celle du formulaire ignorée", async () => {
    cfg.ecrire({ app: {}, auth: AUTH });
    await enregistrer(JSON.stringify({ app: {}, auth: AUTH_HOSTILE }));
    expect(JSON.parse(fichier())["auth"]).toEqual(AUTH);
  });

  it("fusion qui échoue : 500 et fichier inchangé, jamais le texte reçu", async () => {
    cfg.ecrire({ app: {} });
    const avant = fichier();
    fusionEnPanne.actif = true;
    try {
      const r = await enregistrer(JSON.stringify({ app: { nom: "y" }, auth: AUTH_HOSTILE }));
      expect(r.statusCode).toBe(500);
    } finally {
      fusionEnPanne.actif = false;
    }
    expect(fichier()).toBe(avant);
  });

  it("valeur profonde au même chemin dans le disque et le formulaire : refusée, `auth` jamais écrite", async () => {
    const creux = `${"[".repeat(5000)}${"]".repeat(5000)}`;
    writeFileSync(cfg.chemin, `{"database":${creux},"app":{}}`);
    const avant = fichier();
    const r = await enregistrer(`{"database":${creux},"auth":${JSON.stringify(AUTH_HOSTILE)}}`);
    expect(r.statusCode).toBe(400);
    expect(fichier()).toBe(avant);
  });

  it("valeur imbriquée au-delà de 64 niveaux : refusée, rien d'écrit ; 64 niveaux acceptés", async () => {
    cfg.ecrire({ app: {} });
    const avant = fichier();
    expect((await enregistrer(JSON.stringify({ app: profond(70) }))).statusCode).toBe(400);
    const texte = `{"app":${"[".repeat(5000)}${"]".repeat(5000)}}`;
    expect((await enregistrer(texte)).statusCode).toBe(400);
    expect(fichier()).toBe(avant);
    expect((await enregistrer(JSON.stringify({ app: profond(60) }))).statusCode).toBe(200);
    const r = await app.inject({
      method: "PATCH",
      url: "/api/admin/config",
      payload: { changes: [{ path: "app.x", to: profond(70) }], force: true },
    });
    expect(r.statusCode).toBe(400);
  });
});
