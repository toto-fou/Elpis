// SPDX-License-Identifier: MIT
/** apps/core/test/groupes.test.ts — groupes et suppression complète d'un compte rejoués contre accounts/groups.py et users.delete_user_full (vecteurs), sur SQLite et PostgreSQL. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createGroup,
  createUser,
  deleteGroup,
  ErreurGroupe,
  getAllUsersWithGroups,
  getGroup,
  listGroups,
  setUserGroups,
  updateGroup,
} from "@elpis/auth";
import { comparePointsDeCode, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { ErreurIntegrite, initialiserBase } from "@elpis/db";
import type { Valeur } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteUserFull } from "../src/comptes/suppression";
import { root as racineImages } from "../src/images/magasin";
import { deletePrincipalRows } from "../src/llm/acces-moteurs";

interface Etape {
  op: string;
  name?: string;
  description?: string;
  id?: number;
  uid?: number;
  ids?: number[];
  sql?: string;
  params?: Valeur[];
  rel?: string;
}

const V = JSON.parse(readFileSync(new URL("./vecteurs/groupes.json", import.meta.url), "utf-8")) as {
  comptes: [string, number][];
  t0: number;
  etapes: Etape[];
  sorties: ({ r: string } | { erreur: string; message: string })[];
};

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

const TABLES: Record<string, string> = {
  groups: 'SELECT id, name, description FROM "groups" ORDER BY id',
  user_groups: "SELECT user_id, group_id FROM user_groups ORDER BY user_id, group_id",
  politiques:
    "SELECT principal_type, principal_id, engine_keys, can_manage_models FROM llm_engine_policies ORDER BY principal_type, principal_id",
  users: "SELECT id FROM users ORDER BY id",
  chats: "SELECT id, user_id FROM chats ORDER BY id",
  saved_prompts: "SELECT user_id FROM saved_prompts ORDER BY id",
  shared_prompts: "SELECT from_user_id, to_user_id FROM shared_prompts ORDER BY id",
  tool_tokens: "SELECT user_id, token_hash FROM tool_tokens ORDER BY id",
  oauth_tokens: "SELECT user_id FROM oauth_tokens ORDER BY id",
  oauth_codes: "SELECT user_id FROM oauth_codes ORDER BY code_hash",
  generated_images: "SELECT id, user_id FROM generated_images ORDER BY id",
};

/** PostgreSQL agrège les groupes d'un compte dans un ordre libre (`string_agg` sans ORDER BY), comme le Python sur PostgreSQL. */
function sansOrdreAgrege(texte: string): string {
  const v = pyJsonLoads(texte) as unknown;
  if (!Array.isArray(v)) return texte;
  for (const u of v as Dict[]) {
    if (typeof u["group_names"] === "string")
      u["group_names"] = u["group_names"].split(", ").sort(comparePointsDeCode).join(", ");
    if (Array.isArray(u["group_ids"]))
      u["group_ids"] = [...(u["group_ids"] as number[])].sort((a, b) => a - b);
  }
  return pyJsonDumps(v, { ensureAscii: false });
}

describe.each(MOTEURS)("groupes et suppression d'un compte (%s)", (moteur) => {
  let t: BaseDeTest;
  let dossier: string;
  let restaurer: () => void;

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    dossier = mkdtempSync(join(tmpdir(), "elpis-groupes-"));
    restaurer = surchargerConfig({ DB_PATH: join(dossier, "user_db", "app.db") });
    for (const [nom, admin] of V.comptes)
      await createUser(t.base, nom, `mdp-${nom}`, { isAdmin: admin, maintenant: V.t0 });
  });

  afterAll(async () => {
    try {
      await t?.fermer();
    } finally {
      restaurer?.();
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  });

  async function etat(): Promise<Dict> {
    const out: Dict = {};
    for (const [k, sql] of Object.entries(TABLES))
      out[k] = (await t.base.valeurs(sql)).map((l) =>
        l.map((c) => (typeof c === "string" && /^\d+$/u.test(c) && k !== "chats" ? Number(c) : c)),
      );
    out["dossiers"] = existsSync(racineImages()) ? readdirSync(racineImages()).sort(comparePointsDeCode) : [];
    return out;
  }

  async function executer(e: Etape): Promise<unknown> {
    const b = t.base;
    switch (e.op) {
      case "lister":
        return listGroups(b);
      case "creer":
        return createGroup(b, e.name ?? "", e.description ?? "", V.t0);
      case "lire":
        return getGroup(b, e.id ?? 0);
      case "modifier":
        return updateGroup(b, e.id ?? 0, e.name ?? "", e.description ?? "");
      case "supprimer":
        return deleteGroup(b, e.id ?? 0, (x) => deletePrincipalRows(x, "group", e.id, b));
      case "affecter":
        await setUserGroups(b, e.uid ?? 0, e.ids ?? []);
        return null;
      case "tous":
        return getAllUsersWithGroups(b);
      case "supprimer_compte":
        return deleteUserFull(b, e.uid ?? 0);
      case "sql":
        await b.run(e.sql ?? "", e.params ?? []);
        return null;
      case "fichier": {
        const p = join(racineImages(), e.rel ?? "");
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, "png");
        return null;
      }
      case "etat":
        return etat();
      default:
        throw new Error(`étape inconnue : ${e.op}`);
    }
  }

  it("rejoue le scénario et rend les mêmes résultats et le même état des tables (vecteurs)", async () => {
    for (const [i, e] of V.etapes.entries()) {
      const attendu = V.sorties[i];
      let obtenu: unknown;
      try {
        const r = await executer(e);
        obtenu = { r: pyJsonDumps(r ?? null, { ensureAscii: false }) };
      } catch (x) {
        if (x instanceof ErreurGroupe) obtenu = { erreur: "ValueError", message: x.message };
        else if (x instanceof ErreurIntegrite) obtenu = { erreur: "IntegrityError", message: "" };
        else throw x;
      }
      if (
        moteur === "postgres" &&
        e.op === "tous" &&
        attendu &&
        "r" in attendu &&
        obtenu &&
        "r" in (obtenu as Dict)
      )
        expect(sansOrdreAgrege((obtenu as { r: string }).r), JSON.stringify(e)).toBe(
          sansOrdreAgrege(attendu.r),
        );
      else expect(obtenu, `${i} ${JSON.stringify(e)}`).toEqual(attendu);
    }
  });
});
