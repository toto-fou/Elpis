// SPDX-License-Identifier: MIT
/** apps/core/test/images/portee-cle.test.ts — portée d'un jeton : origines exactes réservées au secret d'instance `image-engine` (clé du moteur d'images), refusées sur tout autre jeton, à la création comme à la modification. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { surchargerConfig } from "@elpis/config";
import { initialiserBase, NOM_CLE_IMAGES } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerCoffre, configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normaliserPortee } from "../../src/secrets/portee";
import { creerSecret, modifierSecret } from "../../src/secrets/stockage";

const ORIGINES = { origins: ["HTTP://Moteur.LAN:7860/"] };
const NORMALISEE = { origins: ["http://moteur.lan:7860"] };
const acteur = { userId: null, username: null };
const refus = { statut: 422, code: "secret_scope_invalid" };

describe("portée d'un jeton", () => {
  let t: BaseDeTest;
  let dossier: string;
  let restaurer: () => void;

  beforeEach(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-portee-jeton-"));
    restaurer = surchargerConfig({
      DB_PATH: join(dossier, "app.db"),
      CONFIG_JSON_PATH: join(dossier, "config.json"),
    });
    configureAudit({ service: "main", auditDir: join(dossier, "audit"), hmacKeyPath: "/nonexistent" });
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: join(dossier, "absente.key"),
      repli: join(dossier, ".vault.key"),
    });
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
  });

  afterEach(async () => {
    oublierConfigurationAudit();
    restaurer();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("origines : seulement pour le secret d'instance image-engine", () => {
    expect(normaliserPortee("token", ORIGINES, { proprietaire: null, nom: NOM_CLE_IMAGES })).toEqual(
      NORMALISEE,
    );
    for (const titulaire of [
      undefined,
      { proprietaire: 1, nom: NOM_CLE_IMAGES },
      { proprietaire: null, nom: "autre" },
    ])
      expect(() => normaliserPortee("token", ORIGINES, titulaire)).toThrow(/a token has no scope/u);
    expect(normaliserPortee("token", {}, { proprietaire: 1, nom: "x" })).toEqual({});
  });

  it("autre jeton (d'un compte, ou d'instance sous un autre nom) : origines refusées à la création et à la modification", async () => {
    const uid = await t.base.insertId(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES ('u', '', '', 0)",
    );
    await expect(
      creerSecret(t.base, uid, { name: NOM_CLE_IMAGES, kind: "token", value: "v", scope: ORIGINES }, acteur),
    ).rejects.toMatchObject(refus);
    const perso = await creerSecret(t.base, uid, { name: "tok", kind: "token", value: "v1" }, acteur);
    await expect(
      modifierSecret(t.base, uid, perso.id, { scope: ORIGINES, value: "v2" }, acteur),
    ).rejects.toMatchObject(refus);
    const instance = await creerSecret(t.base, null, { name: "autre", kind: "token", value: "v" }, acteur);
    await expect(
      modifierSecret(t.base, null, instance.id, { scope: ORIGINES, value: "v2" }, acteur),
    ).rejects.toMatchObject(refus);
    const moteur = await creerSecret(
      t.base,
      null,
      { name: NOM_CLE_IMAGES, kind: "token", value: "k", scope: ORIGINES },
      acteur,
    );
    expect(moteur.scope).toEqual(NORMALISEE);
    expect(await t.base.get("SELECT COUNT(*) AS n FROM vault_secrets")).toEqual({ n: 3 });
  });
});
