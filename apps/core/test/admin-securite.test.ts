// SPDX-License-Identifier: MIT
/** apps/core/test/admin-securite.test.ts — console : sessions, HTTPS, écoute, compression et config.json rejoués contre admin/security.py et config.py (vecteurs), sur SQLite et PostgreSQL. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut, ligneUtilisateur } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import type { Valeur } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { masquerSecretsTexte } from "../src/admin/config";
import { caddyEcoute, redemarrerApp } from "../src/admin/securite";
import { creerFamilleAdminConfig } from "../src/familles/admin-config";
import { creerFamilleAdminSecurite } from "../src/familles/admin-securite";
import { appTest, champsAuditV0, journalMuet, sansActionsTs } from "./aides";

interface Etape {
  compte?: string;
  m?: string;
  u?: string;
  corps?: string;
  local?: boolean;
  entetes?: Record<string, string>;
  config?: unknown;
  config_brut?: string;
  caddy?: number[];
  sql?: [string, Valeur[]];
}

interface Sortie {
  statut?: number;
  corps?: string;
  entetes?: Record<string, string>;
  audit: unknown[];
  evenements: unknown[][];
  config: string | null;
  bak: string | null;
}

const V = JSON.parse(readFileSync(new URL("./vecteurs/admin-securite.json", import.meta.url), "utf-8")) as {
  comptes: [string, number][];
  t0: number;
  entetes: string[];
  etapes: Etape[];
  ids: Record<string, number>;
  sorties: Sortie[];
};

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

/** Écart voulu au Python : la console ne reçoit pas les secrets de config.json, le vecteur Python les porte en clair. */
function avecSecretsMasques(corps: string | undefined): string | undefined {
  if (corps === undefined) return undefined;
  const { content } = JSON.parse(corps) as { content: string };
  return JSON.stringify({ content: masquerSecretsTexte(content) });
}

function sansCharset(entetes: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entetes).map(([k, v]) => [k, k === "content-type" ? (v.split(";")[0] ?? "") : v]),
  );
}

describe.each(MOTEURS)("console : sécurité et configuration (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let dossier: string;
  let audit: string;
  let configJson: string;
  let restaurer: () => void;
  const horloge = V.t0;
  const evenements: unknown[][] = [];
  const ouverts = new Set<number>();

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    for (const [nom, admin] of V.comptes)
      await createUser(t.base, nom, `mdp-${nom}`, { isAdmin: admin, maintenant: horloge });
    dossier = mkdtempSync(join(tmpdir(), "elpis-admin-securite-"));
    audit = join(dossier, "audit");
    configJson = join(dossier, "config.json");
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: configJson });
    invalidateConfigCache();
    configureAudit({
      service: "admin",
      auditDir: audit,
      hmacKeyPath: join(dossier, "sans-cle"),
      maintenant: () => horloge,
    });
    const auth = { ...dependancesParDefaut(t.base), maintenant: () => horloge };
    const role = async (req: FastifyRequest, roles: number[], message: string): Promise<void> => {
      const uid = req.headers["x-uid"];
      if (!uid) throw new HttpError(401, "not logged in");
      const ligne = await ligneUtilisateur(t.base, Number(uid));
      req.utilisateur = { id: Number(uid), username: ligne ? String(ligne.username) : null };
      if (!ligne || !roles.includes(Number(ligne.is_admin))) throw new HttpError(403, message);
    };
    app = await appTest({
      mode: "admin",
      familles: [
        creerFamilleAdminSecurite({
          base: t.base,
          auth,
          journal: journalMuet,
          revoquer: async (uid) => {
            evenements.push(["session_revoked", uid]);
            return null;
          },
          diffuser: async (m) => {
            evenements.push([m["type"], m["message"]]);
            return true;
          },
          cycleVie: {
            redemarrerMain: async () => false,
            programmerRechargement: (delai) => {
              evenements.push(["recharger", delai]);
            },
          },
          sonderPort: async (port) => ouverts.has(port),
        }),
        creerFamilleAdminConfig({
          journal: journalMuet,
          fermerClientCompression: async () => {
            evenements.push(["fermer_client"]);
          },
        }),
      ],
      gardes: {
        admin: (req) => role(req, [1], "Admin required"),
        staff: (req) => role(req, [1, 2], "Staff required"),
      },
    });
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      restaurer?.();
      invalidateConfigCache();
      oublierConfigurationAudit();
      await t?.fermer();
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  });

  function lignesAudit(): unknown[] {
    if (!existsSync(audit)) return [];
    // Les actions ajoutées par le TS sont un écart voulu à la référence Python : retirées avant comparaison.
    return sansActionsTs(
      readdirSync(audit)
        .sort()
        .flatMap((f) =>
          readFileSync(join(audit, f), "utf-8")
            .split("\n")
            .filter((l) => l !== ""),
        ),
    ).map(champsAuditV0);
  }

  const lire = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf-8") : null);

  it("rejoue les étapes : réponses, audit, diffusions, config.json et sa copie (vecteurs)", async () => {
    let vus = 0;
    const avant: Record<"config" | "bak", string | null> = { config: null, bak: null };
    const bak = join(dossier, "config.json.bak");
    for (const [i, e] of V.etapes.entries()) {
      evenements.length = 0;
      const res: Partial<Sortie> = {};
      if (e.config !== undefined || e.config_brut !== undefined) {
        writeFileSync(configJson, e.config_brut ?? JSON.stringify(e.config, null, 2));
        invalidateConfigCache();
      } else if (e.caddy) {
        ouverts.clear();
        for (const p of e.caddy) ouverts.add(p);
      } else if (e.sql) await t.base.run(e.sql[0], e.sql[1]);
      else {
        const entetes: Record<string, string> = { host: "testserver", ...(e.entetes ?? {}) };
        if (e.corps !== undefined) entetes["content-type"] = "application/json";
        if (e.compte) entetes["x-uid"] = String(V.ids[e.compte]);
        const r = await app.inject({
          method: e.m as "GET",
          url: e.u ?? "",
          headers: entetes,
          remoteAddress: e.local ? "127.0.0.1" : "testclient",
          ...(e.corps !== undefined ? { payload: Buffer.from(e.corps) } : {}),
        });
        const vusEntetes: Record<string, string> = {};
        for (const k of V.entetes) {
          const v = r.headers[k];
          if (v !== undefined) vusEntetes[k] = String(v);
        }
        res.statut = r.statusCode;
        res.corps = r.body;
        res.entetes = sansCharset(vusEntetes);
      }
      const lignes = lignesAudit();
      res.audit = lignes.slice(vus);
      vus = lignes.length;
      res.evenements = evenements.map((x) => [...x]);
      const ecrit = e.config !== undefined || e.config_brut !== undefined;
      for (const [cle, chemin] of [
        ["config", configJson],
        ["bak", bak],
      ] as const) {
        const texte = lire(chemin);
        res[cle] = texte !== avant[cle] && !ecrit ? texte : null;
        avant[cle] = texte;
      }
      const vecteur = V.sorties[i] as Sortie;
      const lu: Sortie = { ...vecteur, audit: (vecteur.audit as string[]).map(champsAuditV0) };
      const attendu: Sortie =
        e.m === "GET" && e.u?.startsWith("/api/admin/config-file") && lu.statut === 200
          ? { ...lu, corps: avecSecretsMasques(lu.corps) as string }
          : lu;
      expect(res, `étape ${i} : ${JSON.stringify(e).slice(0, 160)}`).toEqual(
        attendu.entetes ? { ...attendu, entetes: sansCharset(attendu.entetes) } : attendu,
      );
    }
  });

  it("config.json illisible : jamais écrasé par les écrivains de la console (écart voulu au Python)", async () => {
    const brut = "{ pas du json";
    writeFileSync(configJson, brut);
    invalidateConfigCache();
    const appel = (m: "POST", u: string, corps?: unknown) =>
      app.inject({
        method: m,
        url: u,
        headers: { host: "testserver", "x-uid": String(V.ids["alice"]), "content-type": "application/json" },
        payload: JSON.stringify(corps ?? {}),
        remoteAddress: "127.0.0.1",
      });
    const illisible = { detail: "config.json est illisible : corrigez-le avant d'enregistrer." };
    for (const [u, corps] of [
      ["/api/admin/security/sessions/revoke-all", {}],
      ["/api/admin/security/https", { enabled: false }],
      ["/api/admin/security/listen", { listen: "lan" }],
    ] as const) {
      const r = await appel("POST", u, corps);
      expect([r.statusCode, r.json()], u).toEqual([500, illisible]);
    }
    const r = await appel("POST", "/api/admin/compression-config", { enabled: true });
    expect([r.statusCode, r.json()]).toEqual([500, illisible]);
    expect(readFileSync(configJson, "utf-8")).toBe(brut);
  });

  it("compression-config : une erreur de validation ne laisse aucun réglage modifié en mémoire", async () => {
    writeFileSync(configJson, "{}");
    invalidateConfigCache();
    const appel = (m: "GET" | "POST", corps?: unknown) =>
      app.inject({
        method: m,
        url: "/api/admin/compression-config",
        headers: { host: "testserver", "x-uid": String(V.ids["alice"]), "content-type": "application/json" },
        ...(corps === undefined ? {} : { payload: JSON.stringify(corps) }),
        remoteAddress: "127.0.0.1",
      });
    const avant = (await appel("GET")).json();
    const r = await appel("POST", { enabled: !avant.enabled, keep_recent_turns: 7, external_model: 1 });
    expect(r.statusCode).toBe(500);
    expect((await appel("GET")).json()).toEqual(avant);
  });
});

describe("sonde de Caddy et redémarrage", () => {
  it("port hors bornes ou fermé : faux ; port en écoute : vrai", async () => {
    const serveur = createServer((so) => so.end());
    await new Promise<void>((r) => serveur.listen(0, "127.0.0.1", r));
    try {
      expect(await caddyEcoute((serveur.address() as AddressInfo).port)).toBe(true);
      for (const p of [70000, -1, 2 ** 31, 1]) expect(await caddyEcoute(p), String(p)).toBe(false);
    } finally {
      serveur.close();
    }
  });

  it("sans cycle de vie : rien n'est diffusé, main n'est pas redémarré", async () => {
    const diffusions: unknown[] = [];
    const ok = await redemarrerApp(
      { journal: journalMuet, diffuser: async (m) => diffusions.push(m), maintenant: () => 1 },
      "message",
    );
    expect([ok, diffusions]).toEqual([false, []]);
  });
});
