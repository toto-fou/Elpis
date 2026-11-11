// SPDX-License-Identifier: MIT
/** apps/toolhost/test/import-ax.test.ts — reprise au démarrage des anciens identifiants AX de la base de l'hôte : comptes retrouvés par leur nom ou leur forme canonique, lignes déchiffrées (Fernet de l'hôte) remises compte par compte au core, effacées sans trace sous le verrou de schéma après accusé de réception (compte disparu et valeur indéchiffrable aussi), gardées si le core ne répond pas ; rappels du client (enveloppe du compte, identité en trois états, forme canonique). */
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { initialiserBase, ouvrirBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { configurerChiffrement, encrypt, IDENTITY_HEADER, verify } from "@elpis/securite";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { boucleRepriseAx, reprendreIdentifiantsAx } from "../src/import-ax";
import type { PrendreVerrou } from "../src/import-ax";
import { ClientRappel } from "../src/rappel";
import type { CompteSigne, IssueAx, LigneAxRemise } from "../src/rappel";
import { journalMuet, SVC } from "./aides";

const dossier = mkdtempSync(path.join(tmpdir(), "elpis-import-ax-"));
let base: Base;
let chemin: string;
let n = 0;

beforeEach(async () => {
  chemin = path.join(dossier, `hote-${++n}.db`);
  base = ouvrirBase({ backend: "sqlite", path: chemin });
  await initialiserBase(base);
  configurerChiffrement({ cleEnv: "cle-de-l-hote", fichierCle: path.join(dossier, "inutilise.key") });
});

afterEach(async () => {
  await base.fermer();
});

afterAll(() => rmSync(dossier, { recursive: true, force: true }));

const inserer = (owner: string, site: string, username: string, password: string) =>
  base.run("INSERT INTO ax_credentials (owner, site, username, password, use_count) VALUES (?, ?, ?, ?, 1)", [
    owner,
    site,
    username,
    password,
  ]);

const octets = (): string =>
  ["", "-wal"]
    .filter((s) => existsSync(chemin + s))
    .map((s) => readFileSync(chemin + s).toString("latin1"))
    .join("");

/** Verrou de schéma des essais : pris et rendu, relevé. */
const verrous = { pris: 0 };
const verrou: PrendreVerrou = async () => {
  verrous.pris += 1;
  return { rendre: async () => undefined };
};

/** Faux rappels : comptes connus (dont un par sa seule forme canonique), inconnus ou injoignables ; lignes reçues relevées ; issues rendues par site. */
function fauxRappel(issues: Record<string, Partial<IssueAx>> = {}) {
  const recues: { compte: CompteSigne; lignes: LigneAxRemise[] }[] = [];
  return {
    recues,
    actif: true,
    compteParNom: async (nom: string, canonique = false) =>
      nom === "alice"
        ? { etat: "connu" as const, compte: { user_id: 7, username: "alice" } }
        : nom === "jeandupont" && canonique
          ? { etat: "connu" as const, compte: { user_id: 8, username: "jean.dupont" } }
          : nom === "carol"
            ? { etat: "injoignable" as const }
            : { etat: "inconnu" as const },
    importerAx: async (compte: CompteSigne, lignes: readonly LigneAxRemise[]) => {
      recues.push({ compte, lignes: [...lignes] });
      return lignes.map((l) => ({ status: "imported", reason: "", name: "x", ...(issues[l.site] ?? {}) }));
    },
  };
}

describe("reprise des identifiants AX de la base de l'hôte", () => {
  it("clair et Fernet remis déchiffrés au core pour leur compte ; acquittées, disparues et indéchiffrables retirées ; injoignables et échecs gardés ; VACUUM", async () => {
    const fernet = encrypt("mdp-chiffre-2");
    configurerChiffrement({ cleEnv: "autre-cle", fichierCle: path.join(dossier, "inutilise.key") });
    const perdu = encrypt("mdp-perdu-3");
    configurerChiffrement({ cleEnv: "cle-de-l-hote", fichierCle: path.join(dossier, "inutilise.key") });
    await inserer("alice", "https://intranet.lan:8443", "admin", "mdp-clair-1");
    await inserer("alice", "https://srv.lan", "svc", fernet);
    await inserer("alice", "https://perdu.lan", "x", perdu);
    await inserer("alice", "vieux.lan:8080", "x", "mdp-vieux-4");
    await inserer("alice", "https://plein.lan", "x", "mdp-plein-5");
    await inserer("bob", "https://bob.lan", "b", "mdp-orphelin-6");
    await inserer("carol", "https://carol.lan", "c", "mdp-attente-7");
    await inserer("jeandupont", "https://jean.lan", "j", "mdp-canonique-8");
    const rappel = fauxRappel({
      "vieux.lan:8080": { status: "skipped", reason: "no_origin" },
      "https://plein.lan": { status: "failed", reason: "limit" },
      "https://srv.lan": { status: "exists", name: "deja" },
    });
    verrous.pris = 0;
    const bilan = await reprendreIdentifiantsAx(base, rappel, journalMuet, verrou);
    expect(verrous.pris).toBe(1);
    expect(rappel.recues).toEqual([
      {
        compte: { user_id: 7, username: "alice" },
        lignes: [
          { site: "https://intranet.lan:8443", username: "admin", password: "mdp-clair-1" },
          { site: "https://plein.lan", username: "x", password: "mdp-plein-5" },
          { site: "https://srv.lan", username: "svc", password: "mdp-chiffre-2" },
          { site: "vieux.lan:8080", username: "x", password: "mdp-vieux-4" },
        ],
      },
      {
        compte: { user_id: 8, username: "jean.dupont" },
        lignes: [{ site: "https://jean.lan", username: "j", password: "mdp-canonique-8" }],
      },
    ]);
    expect(await base.all("SELECT owner, site FROM ax_credentials ORDER BY owner, site")).toEqual([
      { owner: "alice", site: "https://plein.lan" },
      { owner: "carol", site: "https://carol.lan" },
    ]);
    expect(bilan).toEqual({ retirees: 6, gardees: 2 });
    for (const v of ["mdp-clair-1", "mdp-vieux-4", "mdp-orphelin-6", "mdp-canonique-8", fernet, perdu])
      expect(octets()).not.toContain(v);
  });

  it("core muet pour le lot : rien n'est retiré ; base vide ou rappels éteints : rien n'est demandé", async () => {
    await inserer("alice", "https://intranet.lan:8443", "admin", "mdp-clair-1");
    const muet = { ...fauxRappel(), importerAx: async () => null };
    verrous.pris = 0;
    expect(await reprendreIdentifiantsAx(base, muet, journalMuet, verrou)).toEqual({
      retirees: 0,
      gardees: 1,
    });
    expect(verrous.pris).toBe(0);
    expect(
      await reprendreIdentifiantsAx(base, { ...fauxRappel(), actif: false }, journalMuet, verrou),
    ).toEqual({
      retirees: 0,
      gardees: 1,
    });
    await base.run("DELETE FROM ax_credentials");
    const vide = fauxRappel();
    expect(await reprendreIdentifiantsAx(base, vide, journalMuet, verrou)).toEqual({
      retirees: 0,
      gardees: 0,
    });
    expect(vide.recues).toEqual([]);
  });

  it("sans clé Fernet : les lignes chiffrées attendent, les claires passent ; la boucle s'arrête quand tout est repris", async () => {
    const fernet = encrypt("mdp-chiffre-2");
    await inserer("alice", "https://srv.lan", "svc", fernet);
    await inserer("alice", "https://intranet.lan:8443", "admin", "mdp-clair-1");
    configurerChiffrement({ cleConfig: 42, fichierCle: "relatif/.encryption_key" });
    const rappel = fauxRappel();
    expect(await reprendreIdentifiantsAx(base, rappel, journalMuet, verrou)).toEqual({
      retirees: 1,
      gardees: 1,
    });
    expect(await base.all("SELECT site FROM ax_credentials")).toEqual([{ site: "https://srv.lan" }]);
    configurerChiffrement({ cleEnv: "cle-de-l-hote", fichierCle: path.join(dossier, "inutilise.key") });
    const arret = new AbortController();
    await boucleRepriseAx(() => base, rappel, journalMuet, arret.signal, verrou);
    expect(await base.all("SELECT site FROM ax_credentials")).toEqual([]);
  });
});

describe("rappels de reprise (client du core)", () => {
  let serveur: Server;
  const vues: { chemin: string; corps: Dict; identite: unknown }[] = [];
  const reponses = new Map<string, [number, unknown]>();

  beforeEach(async () => {
    vues.length = 0;
    serveur = createServer((req, res) => {
      const morceaux: Buffer[] = [];
      req.on("data", (m: Buffer) => morceaux.push(m));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://x");
        const texte = Buffer.concat(morceaux).toString();
        const entete = req.headers[IDENTITY_HEADER];
        vues.push({
          chemin: `${url.pathname}${url.search}`,
          corps: texte ? (JSON.parse(texte) as Dict) : {},
          identite: typeof entete === "string" ? verify(entete, SVC) : null,
        });
        const [statut, corps] = reponses.get(url.pathname) ?? [404, {}];
        res.writeHead(statut, { "content-type": "application/json" }).end(JSON.stringify(corps));
      });
    });
    await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", () => ok()));
  });

  afterEach(async () => {
    reponses.clear();
    serveur.closeAllConnections();
    await new Promise<void>((ok) => serveur.close(() => ok()));
  });

  const client = (): ClientRappel =>
    new ClientRappel({
      appUrl: `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`,
      jeton: SVC,
      journal: journalMuet,
    });

  it("import-ax : enveloppe du compte (sans conversation), une issue par ligne ; réponse incomplète ou refus : non acquitté", async () => {
    reponses.set("/api/internal/secrets/import-ax", [
      200,
      { ok: true, results: [{ site: "https://a.lan", status: "imported", name: "a.lan" }] },
    ]);
    const lignes = [{ site: "https://a.lan", username: "u", password: "mdp-a" }];
    expect(await client().importerAx({ user_id: 7, username: "alice" }, lignes)).toEqual([
      { status: "imported", reason: "", name: "a.lan" },
    ]);
    expect(vues[0]).toMatchObject({
      chemin: "/api/internal/secrets/import-ax",
      corps: { rows: lignes },
      identite: { user_id: 7, username: "alice", chat_id: "" },
    });
    expect(await client().importerAx({ user_id: 7, username: "alice" }, [...lignes, ...lignes])).toBeNull();
    reponses.set("/api/internal/secrets/import-ax", [503, { detail: "x", code: "secret_key_unavailable" }]);
    expect(await client().importerAx({ user_id: 7, username: "alice" }, lignes)).toBeNull();
  });

  it("compte par nom : connu, inconnu (réponse du core), injoignable", async () => {
    reponses.set("/api/internal/identity", [
      200,
      { ok: true, user_id: 7, username: "alice", is_admin: false },
    ]);
    expect(await client().compteParNom("alice")).toEqual({
      etat: "connu",
      compte: { user_id: 7, username: "alice" },
    });
    reponses.set("/api/internal/identity", [200, { ok: false }]);
    expect(await client().compteParNom("bob")).toEqual({ etat: "inconnu" });
    await client().compteParNom("jeandupont", true);
    expect(vues.at(-1)?.chemin).toBe("/api/internal/identity?username=jeandupont&canonical=1");
    reponses.set("/api/internal/identity", [500, {}]);
    expect(await client().compteParNom("carol")).toEqual({ etat: "injoignable" });
    const absent = new ClientRappel({
      appUrl: "http://127.0.0.1:1",
      jeton: SVC,
      journal: journalMuet,
      delaiMs: 500,
    });
    expect(await absent.compteParNom("carol")).toEqual({ etat: "injoignable" });
  });
});
