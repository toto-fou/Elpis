// SPDX-License-Identifier: MIT
/** apps/core/test/git/routes.test.ts — `/api/git/connectors*` rejouées contre le routeur Python (vecteurs) avec le même faux serveur d'API (boucle locale permise ici seulement) : redirections, SSRF, erreurs, audit, lignes en base (jetons dans le coffre). */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";

import { createUser } from "@elpis/auth";
import { HttpError, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerCoffre } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { creerFamilleGit } from "../../src/familles/git";
import { brancherAdressesInterdites } from "../../src/git/garde";
import { COLONNES_SECRET, dechiffrerLigne } from "../../src/secrets/stockage";
import type { LigneSecret } from "../../src/secrets/stockage";
import { appTest } from "../aides";

type Regle = "auth" | [number, string, Record<string, string>, string];
const TEXTE = readFileSync(new URL("../vecteurs/git-routes.json", import.meta.url), "utf-8");
const V = JSON.parse(TEXTE) as {
  serveur: Record<string, Regle>;
  bon: string;
  ids: Record<string, number>;
  reponses: { statut: number; corps: string; audits: Record<string, unknown>[] }[];
  lignes: Record<string, unknown>[];
};
const ETAPES = (pyJsonLoads(TEXTE) as { etapes: [string, string, string, unknown][] }).etapes;
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
/** Écart voulu (coffre) : changer l'hôte (64) ou le type (66) sans saisir de jeton efface le jeton que le Python gardait ; en 64, saisi à nouveau, il rejoint le Python (en 68, un nouveau jeton remplace celui du Python). */
const ETAPE_HOTE_SANS_JETON = 64;
const ETAPE_TYPE_SANS_JETON = 66;
/** Écart voulu (portée par chemin) : un seul compte par portée ; le vecteur en crée plusieurs sur un même hôte, distingués par leur libellé : chaque création reçoit son libellé pour chemin (comptes actifs, cohérents avec leur secret) ; le doublon de l'étape 35, que l'index unique du Python faisait échouer en 500, est refusé en 409. */
const ETAPE_DOUBLON = 35;
const REFUS_DOUBLON = {
  statut: 409,
  corps: '{"detail":"Un autre compte s\'applique déjà à gh.example:8443/colle."}',
};
/** Corps d'une création du vecteur, son libellé pour chemin (« faux » : l'organisation `bob`, dont le vecteur liste un dépôt). */
function avecPortee(corps: unknown): unknown {
  const libelle =
    typeof corps === "object" && corps !== null ? (corps as Record<string, unknown>)["label"] : "";
  if (typeof libelle !== "string" || !libelle) return corps;
  return { ...(corps as object), path: libelle === "faux" ? "bob" : libelle };
}
/** Écart voulu (coffre) : la liste dit `vault` où le Python disait `plain`. */
const versCoffre = (corps: string | undefined): string | undefined =>
  corps?.replaceAll('"token_scheme":"plain"', '"token_scheme":"vault"');
/** Écart voulu (portée par chemin) : `path` d'un compte et de l'analyse d'une URL, absent du Python ; « Compte » où il disait « Connecteur ». */
const sansPortee = (corps: string): string =>
  corps.replace(/"path":(?:"[^"]*"|null),/gu, "").replaceAll("Compte introuvable", "Connecteur introuvable");
/** Écart voulu (portée par chemin) : la liste est triée par hôte puis portée, celle du Python par hôte puis libellé : remise dans son ordre avant comparaison. */
function ordrePython(corps: string): string {
  if (!corps.startsWith('{"connectors":[')) return corps;
  const d = JSON.parse(corps) as { connectors: { host: string; label: string }[] };
  const cle = (c: { host: string; label: string }): string => `${c.host}\u0000${c.label}`;
  d.connectors.sort((a, b) => (cle(a) < cle(b) ? -1 : cle(a) > cle(b) ? 1 : 0));
  return JSON.stringify(d);
}

function fauxServeur(): Promise<Server> {
  const srv = createServer((req, res) => {
    let regle = V.serveur[req.url ?? ""];
    if (regle === "auth")
      regle =
        req.headers.authorization === V.bon
          ? [200, "OK", {}, JSON.stringify({ login: "bob", n: 1.5 })]
          : [401, "Unauthorized", {}, '{"message": "bad credentials"}'];
    const [statut, raison, entetes, corps] = regle ?? [404, "Not Found", {}, "inconnu"];
    const octets = Buffer.from(corps, "utf-8");
    res.writeHead(statut, raison, { ...entetes, "content-length": String(octets.length) });
    res.end(octets);
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv)));
}

describe.each(MOTEURS)("/api/git/connectors (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let srv: Server;
  let port = "";
  const audits: Record<string, unknown>[] = [];

  beforeAll(async () => {
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: "/nonexistent/vault.key",
      repli: "/nonexistent/.vault.key",
    });
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    for (const nom of ["alice", "bob"]) await createUser(t.base, nom, `mdp-${nom}`, { isAdmin: 0 });
    brancherAdressesInterdites(() => false);
    srv = await fauxServeur();
    port = String((srv.address() as AddressInfo).port);
    app = await appTest({
      familles: [
        creerFamilleGit({
          base: t.base,
          auditer: (e) =>
            audits.push({ user_id: e.userId, username: e.username, action: e.action, details: e.details }),
        }),
      ],
      gardes: {
        session: (req) => {
          if (req.headers["x-uid"] === undefined) throw new HttpError(401, "not logged in");
          req.utilisateur = { id: Number(req.headers["x-uid"]), username: null };
        },
      },
    });
  });

  afterAll(async () => {
    brancherAdressesInterdites(null);
    vi.useRealTimers();
    await app.close();
    await new Promise((ok) => srv.close(ok));
    await t.fermer();
  });

  it("rejoue les étapes : mêmes réponses au texte près, mêmes audits, mêmes lignes (vecteurs)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const crees: number[] = [];
    const versPython = (s: string): string => s.replaceAll(port, "<PORT>");
    for (const [i, [nom, methode, cheminBrut, corps]] of ETAPES.entries()) {
      vi.setSystemTime((1_800_000_000.5 + 10 * i) * 1000);
      let chemin = cheminBrut;
      for (let k = crees.length - 1; k >= 0; k--) chemin = chemin.replaceAll(`{c${k}}`, String(crees[k]));
      const entetes: Record<string, string> = { "x-uid": String(V.ids[nom]) };
      let charge: string | undefined;
      if (typeof corps === "string" && corps.startsWith("<<")) charge = corps.slice(2, -2);
      else if (corps !== null && corps !== undefined)
        charge = pyJsonDumps(
          methode === "POST" && cheminBrut === "/api/git/connectors" ? avecPortee(corps) : corps,
          { ensureAscii: false },
        ).replaceAll("<PORT>", port);
      if (charge !== undefined) entetes["content-type"] = "application/json";
      let avant = audits.length;
      let r = await app.inject({
        method: methode as "GET" | "POST" | "PUT" | "DELETE",
        url: chemin,
        headers: entetes,
        payload: charge,
      });
      if (i === ETAPE_HOTE_SANS_JETON || i === ETAPE_TYPE_SANS_JETON) {
        const id = Number(chemin.split("/").at(-1));
        expect(
          await t.base.get("SELECT secret_id, token_enc FROM git_connectors WHERE id = ?", [id]),
          `étape ${i} (écart voulu : jeton effacé)`,
        ).toEqual({ secret_id: null, token_enc: "" });
      }
      if (i === ETAPE_HOTE_SANS_JETON) {
        avant = audits.length;
        r = await app.inject({
          method: "PUT",
          url: chemin,
          headers: { ...entetes, "content-type": "application/json" },
          payload: JSON.stringify({ token: "mauvais" }),
        });
      }
      if (methode === "POST" && chemin === "/api/git/connectors" && r.statusCode === 200)
        crees.push((r.json() as { id: number }).id);
      const attendu = i === ETAPE_DOUBLON ? { ...REFUS_DOUBLON, audits: [] } : V.reponses[i];
      expect(r.statusCode, `étape ${i} ${methode} ${chemin}`).toBe(attendu?.statut);
      expect(sansPortee(ordrePython(versPython(r.body))), `étape ${i} ${methode} ${chemin}`).toBe(
        versCoffre(attendu?.corps),
      );
      expect(JSON.parse(versPython(JSON.stringify(audits.slice(avant)))), `étape ${i}`).toEqual(
        attendu?.audits,
      );
    }
    const lignes = await t.base.all<Record<string, unknown>>(
      "SELECT id, owner_user_id, provider_type, host, api_base, label, username, token_enc, token_scheme, " +
        "CASE WHEN last_used IS NULL THEN 0 ELSE 1 END AS utilise, secret_id FROM git_connectors ORDER BY id",
    );
    expect(lignes.every((l) => l["token_enc"] === "" && l["token_scheme"] === "vault")).toBe(true);
    // Écart voulu (coffre) : le jeton que le Python gardait en clair est dans le coffre ; relu, il est le même.
    const relues = [];
    for (const { secret_id: sid, ...l } of lignes) {
      const s = await t.base.get<LigneSecret & Record<string, unknown>>(
        `SELECT ${COLONNES_SECRET} FROM vault_secrets WHERE id = ?`,
        [Number(sid)],
      );
      relues.push({ ...l, token_enc: s ? dechiffrerLigne(s) : null, token_scheme: "plain" });
    }
    expect(JSON.parse(versPython(JSON.stringify(relues)))).toEqual(V.lignes);
  });
});
