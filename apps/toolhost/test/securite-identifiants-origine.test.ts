// SPDX-License-Identifier: MIT
/** apps/toolhost/test/securite-identifiants-origine.test.ts — pw_session et les anciens identifiants AX : une ligne d'`ax_credentials` (origine exacte ou ancienne clé) n'est plus jamais jointe au démarrage ni réécrite ; username et password refusés par le schéma. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { initialiserBase, ouvrirBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirEnMemoire, ServeurOutils } from "@elpis/outils-mcp";
import type { ConnexionEnMemoire } from "@elpis/outils-mcp";
import { configurerChiffrement } from "@elpis/securite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientBrut } from "../../../packages/outils-mcp/test/aides";
import { outilsBrowser } from "../src/mcp/browser";
import { journalMuet } from "./aides";
import { FauxNavigateur, SESSION } from "./faux-navigateur";

const dossier = mkdtempSync(path.join(tmpdir(), "elpis-identifiants-origine-"));
const JENKINS = "http://192.168.0.10:8080";
const PIRATE = "http://192.168.0.66:8080";
let faux: FauxNavigateur;
let base: Base;
let connexion: ConnexionEnMemoire;
let b: ClientBrut;

beforeAll(async () => {
  faux = await FauxNavigateur.demarrer();
});

beforeEach(async () => {
  vi.stubEnv("PLAYWRIGHT_API_URL", faux.url);
  vi.stubEnv("PW_OWNERS_DIR", path.join(dossier, "owners"));
  configurerChiffrement({ cleEnv: "cle-de-test", fichierCle: "/inexistant/.encryption_key" });
  base = ouvrirBase({ backend: "sqlite", path: path.join(dossier, `ax-${Date.now()}.db`) });
  await initialiserBase(base);
  const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
  serveur.enregistrerFamille("browser", outilsBrowser({ ax: () => base, journal: journalMuet }));
  connexion = await ouvrirEnMemoire(serveur);
  b = new ClientBrut(connexion.transport);
  await b.demarrer();
  await b.initialiser();
});

afterEach(async () => {
  await connexion.fermer();
  await base.fermer();
  vi.unstubAllEnvs();
  faux.reinitialiser();
});

afterAll(async () => {
  await faux.arreter();
  rmSync(dossier, { recursive: true, force: true });
});

const demarrer = (args: Dict): Promise<Dict> =>
  b.appeler("pw_session", { action: "start", ...args }, { username: "alice" });

/** Corps du dernier `/start` reçu par le service. */
function dernierStart(): Dict {
  const vues = faux.vues.filter((v) => v.methode === "POST" && v.chemin === "/start");
  return JSON.parse((vues[vues.length - 1] as { corps: string }).corps) as Dict;
}

const lignes = async (): Promise<Dict[]> =>
  base.all("SELECT owner, site, username, password, use_count FROM ax_credentials ORDER BY site");

describe("pw_session : plus de mémoire des identifiants de sites (coffre « Secrets »)", () => {
  it("ligne enregistrée pour l'origine exacte, ou ancienne clé sans origine : jamais jointe, jamais relue ni réécrite", async () => {
    await base.run(
      "INSERT INTO ax_credentials (owner, site, username, password, last_ok, use_count) VALUES ('alice', ?, 'alice', 'mdp-jenkins', 1000.5, 4)",
      [JENKINS],
    );
    await base.run(
      "INSERT INTO ax_credentials (owner, site, username, password, last_ok, use_count) VALUES ('alice', ':8080', 'ancien', 'mdp-ancien', 1000.5, 4)",
    );
    const avant = await lignes();
    for (const url of [`${JENKINS}/login`, `${JENKINS}/job/x`, `${PIRATE}/`]) {
      const r = await demarrer({ url });
      expect(r["isError"]).not.toBe(true);
      expect(JSON.stringify(r)).not.toMatch(/mdp-(jenkins|ancien)/u);
      const corps = dernierStart();
      expect(corps["url"]).toBe(url);
      for (const k of ["username", "password", "credentials_origin", "secure"])
        expect(corps).not.toHaveProperty(k);
    }
    expect(await lignes()).toEqual(avant);
  });

  it("redirection vers une autre origine : rien n'est joint ni enregistré", async () => {
    faux.imposees.set("POST /start", [
      [200, { status: "started", session_id: SESSION, url: `${PIRATE}/login`, final_url: `${PIRATE}/login` }],
    ]);
    await demarrer({ url: `${JENKINS}/` });
    expect(await lignes()).toEqual([]);
    expect(dernierStart()).not.toHaveProperty("password");
  });

  it("username et password passés par le modèle : refusés par le schéma, aucun démarrage", async () => {
    for (const extra of [{ username: "alice" }, { password: "mdp" }]) {
      const r = await demarrer({ url: `${JENKINS}/login`, ...extra });
      expect(r["isError"]).toBe(true);
    }
    expect(faux.vues.filter((v) => v.chemin === "/start")).toEqual([]);
  });
});
