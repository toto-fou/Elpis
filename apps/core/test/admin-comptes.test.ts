// SPDX-License-Identifier: MIT
/** apps/core/test/admin-comptes.test.ts — console : comptes, groupes, accès LLM et clients OAuth rejoués contre admin/users.py, groups.py et oauth.py (vecteurs), sur SQLite et PostgreSQL. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { createUser, dependancesParDefaut, ligneUtilisateur } from "@elpis/auth";
import { HttpError, pyJsonDumps, versFlottantPy } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import type { Valeur } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { oublierOccupations } from "../src/admin/bac";
import type { PortBac } from "../src/admin/bac";
import { creerFamilleAdminComptes } from "../src/familles/admin-comptes";
import { appTest, champsAuditV0, journalMuet, sansActionsTs } from "./aides";

interface Etape {
  compte?: string;
  m?: string;
  u?: string;
  corps?: string;
  config?: unknown;
  fichier?: [string, number];
  dossier?: [string, number];
  lien?: [string, string];
  sql?: [string, Valeur[]];
  lire?: string;
  existe?: string;
}

interface Sortie {
  statut?: number;
  corps?: string;
  entetes?: Record<string, string>;
  lignes?: string;
  existe?: boolean;
  audit: unknown[];
  revoques: unknown[];
  bac: unknown[][];
  config: string | null;
}

const V = JSON.parse(readFileSync(new URL("./vecteurs/admin-comptes.json", import.meta.url), "utf-8")) as {
  comptes: [string, number][];
  t0: number;
  entetes: string[];
  etapes: Etape[];
  ids: Record<string, number>;
  sorties: Sortie[];
};

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

/** Écart voulu (relecture M1) : un reset de mot de passe réussi publie aussi la révocation du compte, que le Python omet. */
function ecartResetPassword(e: Etape, attendu: Sortie): Sortie {
  if (e.u !== "/api/admin/reset-password" || attendu.statut !== 200) return attendu;
  return {
    ...attendu,
    revoques: [Number((JSON.parse(e.corps ?? "{}") as { target_id: unknown }).target_id)],
  };
}

/** Droits rendus avant suppression (un dossier en 0500 bloquerait le nettoyage). */
function rendreDroits(racine: string): void {
  if (!existsSync(racine)) return;
  for (const e of readdirSync(racine, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(racine, e.name);
    chmodSync(p, 0o700);
    rendreDroits(p);
  }
}

describe.each(MOTEURS)("console : comptes, groupes, clients OAuth (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let dossier: string;
  let bac: string;
  let audit: string;
  let configJson: string;
  let restaurer: () => void;
  const horloge = V.t0;
  const revoques: unknown[] = [];
  const appels: unknown[][] = [];

  const port: PortBac = {
    async supprimerSurHote() {
      return null;
    },
    async retirerConteneur() {},
    async purgerTravail(uid, username, travail) {
      appels.push(["purger", uid, username, relative(bac, travail)]);
      rendreDroits(travail);
      rmSync(travail, { recursive: true });
    },
    async detruireConteneur(uid, username, travail, profil) {
      appels.push(["detruire", uid, username, relative(bac, travail), profil]);
      if (username === "eve") throw new Error("docker absent");
    },
  };

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    for (const [nom, admin] of V.comptes)
      await createUser(t.base, nom, `mdp-${nom}`, { isAdmin: admin, maintenant: horloge });
    dossier = mkdtempSync(join(tmpdir(), "elpis-admin-comptes-"));
    bac = join(dossier, "sb");
    audit = join(dossier, "audit");
    configJson = join(dossier, "config.json");
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: configJson, SANDBOX_DIR: bac });
    invalidateConfigCache();
    oublierOccupations();
    configureAudit({
      service: "admin",
      auditDir: audit,
      hmacKeyPath: join(dossier, "sans-cle"),
      maintenant: () => horloge,
    });
    const auth = { ...dependancesParDefaut(t.base), maintenant: () => horloge };
    app = await appTest({
      mode: "admin",
      familles: [
        creerFamilleAdminComptes({
          base: t.base,
          auth,
          journal: journalMuet,
          revoquer: async (uid) => {
            revoques.push(uid);
            return null;
          },
          bac: port,
        }),
      ],
      gardes: {
        admin: async (req) => {
          const uid = req.headers["x-uid"];
          if (!uid) throw new HttpError(401, "not logged in");
          const ligne = await ligneUtilisateur(t.base, Number(uid));
          req.utilisateur = { id: Number(uid), username: ligne ? String(ligne.username) : null };
          if (!ligne || Number(ligne.is_admin) !== 1) throw new HttpError(403, "Admin required");
        },
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
      if (dossier) {
        rendreDroits(dossier);
        rmSync(dossier, { recursive: true, force: true });
      }
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

  it("rejoue les étapes : réponses, audit, révocations, pilote du bac et config.json (vecteurs)", async () => {
    let vus = 0;
    let configAvant: string | null = null;
    for (const [i, e] of V.etapes.entries()) {
      revoques.length = 0;
      appels.length = 0;
      const res: Partial<Sortie> = {};
      if (e.config !== undefined) {
        writeFileSync(configJson, JSON.stringify(e.config, null, 2));
        invalidateConfigCache();
      } else if (e.fichier) {
        const p = join(bac, e.fichier[0]);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, "x".repeat(e.fichier[1]));
      } else if (e.dossier) chmodSync(join(bac, e.dossier[0]), e.dossier[1]);
      else if (e.lien) {
        const p = join(bac, e.lien[0]);
        mkdirSync(dirname(p), { recursive: true });
        if (existsSync(p) && statSync(p).isDirectory()) rmSync(p, { recursive: true });
        symlinkSync(join(bac, e.lien[1]), p);
      } else if (e.sql) await t.base.run(e.sql[0], e.sql[1]);
      else if (e.lire !== undefined) {
        const lignes = (await t.base.valeurs(e.lire)).map((l) =>
          l.map((c, k) =>
            k === 4 ? versFlottantPy(Number(c)) : typeof c === "string" && k !== 1 && k !== 5 ? Number(c) : c,
          ),
        );
        res.lignes = pyJsonDumps(lignes, { ensureAscii: false });
      } else if (e.existe !== undefined) res.existe = existsSync(join(bac, e.existe));
      else {
        const entetes: Record<string, string> = {};
        if (e.corps !== undefined) entetes["content-type"] = "application/json";
        if (e.compte) entetes["x-uid"] = String(V.ids[e.compte]);
        const r = await app.inject({
          method: e.m as "GET",
          url: e.u ?? "",
          headers: entetes,
          ...(e.corps !== undefined ? { payload: Buffer.from(e.corps) } : {}),
        });
        const vusEntetes: Record<string, string> = {};
        for (const k of V.entetes) {
          const v = r.headers[k];
          if (v !== undefined)
            vusEntetes[k] = k === "content-type" ? (String(v).split(";")[0] ?? "") : String(v);
        }
        res.statut = r.statusCode;
        res.corps = r.body.replaceAll(bac, "{bac}");
        res.entetes = vusEntetes;
      }
      const lignes = lignesAudit();
      res.audit = lignes.slice(vus);
      vus = lignes.length;
      res.revoques = [...revoques];
      res.bac = appels.map((a) => [...a]);
      const texte = existsSync(configJson) ? readFileSync(configJson, "utf-8") : null;
      res.config = texte !== configAvant && e.config === undefined ? texte : null;
      configAvant = texte;
      const vecteur = V.sorties[i] as Sortie;
      const attendu = ecartResetPassword(e, {
        ...vecteur,
        audit: (vecteur.audit as string[]).map(champsAuditV0),
      });
      const attenduNormalise = attendu.entetes
        ? {
            ...attendu,
            entetes: Object.fromEntries(
              Object.entries(attendu.entetes).map(([k, v]) => [
                k,
                k === "content-type" ? (v.split(";")[0] ?? "") : v,
              ]),
            ),
          }
        : attendu;
      expect(res, `étape ${i} : ${JSON.stringify(e).slice(0, 160)}`).toEqual(attenduNormalise);
    }
  });
});
