// SPDX-License-Identifier: MIT
/** apps/toolhost/test/securite-chiffrement-identifiants.test.ts — anciens mots de passe de sites chiffrés (Fernet) : jamais déchiffrés ni joints par pw_session, rien écrit ; l'hôte ne charge aucune clé de chiffrement (le core déchiffre les lignes reprises dans le coffre). */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase, ouvrirBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirEnMemoire, ServeurOutils } from "@elpis/outils-mcp";
import type { ConnexionEnMemoire } from "@elpis/outils-mcp";
import { configurerChiffrement, encrypt } from "@elpis/securite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientBrut } from "../../../packages/outils-mcp/test/aides";
import { baseHote, fermerBaseHote, ouvrirBaseHote } from "../src/base-hote";
import { outilsBrowser } from "../src/mcp/browser";
import { journalMuet } from "./aides";
import { FauxNavigateur } from "./faux-navigateur";

const dossier = mkdtempSync(path.join(tmpdir(), "elpis-chiffrement-identifiants-"));
const SITE = "http://192.168.0.10:8080";
const MDP = "mdp-tres-secret-42";
const FICHIER = path.join(dossier, "inutilise", ".encryption_key");
let faux: FauxNavigateur;
let base: Base;
let cheminBase: string;
let connexion: ConnexionEnMemoire;
let b: ClientBrut;
let numero = 0;

beforeAll(async () => {
  faux = await FauxNavigateur.demarrer();
});

beforeEach(async () => {
  faux.brancher();
  vi.stubEnv("PW_OWNERS_DIR", path.join(dossier, "owners"));
  configurerChiffrement({ cleEnv: "cle-de-test", fichierCle: FICHIER });
  cheminBase = path.join(dossier, `ax-${++numero}.db`);
  base = ouvrirBase({ backend: "sqlite", path: cheminBase });
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
  FauxNavigateur.debrancher();
  await faux.arreter();
  rmSync(dossier, { recursive: true, force: true });
});

const demarrer = (args: Dict): Promise<Dict> =>
  b.appeler("pw_session", { action: "start", ...args }, { username: "alice" });

function dernierStart(): Dict {
  const vues = faux.vues.filter((v) => v.methode === "POST" && v.chemin === "/start");
  return JSON.parse((vues[vues.length - 1] as { corps: string }).corps) as Dict;
}

const stocke = async (): Promise<string | undefined> =>
  (await base.get<{ password: string }>("SELECT password FROM ax_credentials"))?.password;

/** Octets du fichier de la base et de son journal WAL, tels qu'une copie les verrait. */
function octetsDeLaBase(): Buffer {
  return Buffer.concat(
    ["", "-wal"].filter((s) => existsSync(cheminBase + s)).map((s) => readFileSync(cheminBase + s)),
  );
}

describe("pw_session : ancien mot de passe chiffré jamais rejoint", () => {
  it("ligne Fernet de l'origine : ni déchiffrée ni jointe, la ligne reste telle quelle et le fichier ne porte aucun clair", async () => {
    const jeton = encrypt(MDP);
    await base.run(
      "INSERT INTO ax_credentials (owner, site, username, password, last_ok, use_count) VALUES ('alice', ?, 'compte-site', ?, 1000.5, 4)",
      [SITE, jeton],
    );
    const r = await demarrer({ url: `${SITE}/login` });
    expect(r["isError"]).not.toBe(true);
    expect(JSON.stringify(r)).not.toContain(MDP);
    expect(dernierStart()).not.toHaveProperty("password");
    expect(dernierStart()).not.toHaveProperty("username");
    expect(await stocke()).toBe(jeton);
    expect(octetsDeLaBase().includes(MDP)).toBe(false);
  });
});

describe("base de l'hôte : aucune clé de chiffrement", () => {
  const restaurations: (() => void)[] = [];

  function basePropre(): string {
    const d = mkdtempSync(path.join(dossier, "hote-"));
    restaurations.push(surchargerConfig({ DB_BACKEND: "sqlite", DB_PATH: path.join(d, "toolhost.db") }));
    invalidateConfigCache();
    return d;
  }

  afterEach(async () => {
    await fermerBaseHote();
    vi.unstubAllEnvs();
    while (restaurations.length) restaurations.pop()?.();
    invalidateConfigCache();
  });

  it("ouvrir la base ne pointe jamais la clé héritée près d'elle : aucun `.encryption_key` créé", async () => {
    vi.stubEnv("APP_ENCRYPTION_KEY", "");
    configurerChiffrement({ cleEnv: "", fichierCle: FICHIER });
    const d = basePropre();
    await ouvrirBaseHote(() => journalMuet);
    expect(baseHote()).not.toBeNull();
    encrypt(MDP);
    expect(existsSync(path.join(d, ".encryption_key"))).toBe(false);
    expect(existsSync(FICHIER)).toBe(true);
  });
});
