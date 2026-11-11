// SPDX-License-Identifier: MIT
/** apps/core/test/bascule-session.test.ts — cutover des sessions (décision 3, E80) : un vrai cookie du Python est refusé proprement par main et admin, sans trace au journal ; la reconnexion pose un cookie TS qui le remplace. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyserMandataires, createUser, dependancesParDefaut, lireSession } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { composer } from "../src/composition";
import { installerCrochetJournal } from "../src/journal";
import { installerRelaisModeles } from "../src/llm/cache-modeles";
import { installerDiffusion } from "../src/llm/ports";
import { ligneJournal } from "../src/evenements/journal-commun";
import type { LigneJournal } from "../src/evenements/systeme";
import { journalAcces } from "../src/observabilite/journal-acces";
import { appTest, effacementUnifie, journalMuet, lignesJournal } from "./aides";

const V = JSON.parse(readFileSync(new URL("./vecteurs/session-python.json", import.meta.url), "utf-8")) as {
  secret: string;
  t: number;
  set_cookie: string;
  valeur: string;
  session_relue_par_python: Record<string, unknown>;
  logout_cookie_illisible: [number, unknown, string[]];
  retour_arriere: { cookie_ts: string; session_vue_par_python: unknown; set_cookie: string[] };
};
const NOM = "mcpwebui_session";
const ANCIEN = `${NOM}=${V.valeur}`;
const MOT_DE_PASSE = "mot-de-passe-de-la-bascule-1";
/** Fragments du cookie du Python qui ne doivent apparaître dans aucun journal. */
const FRAGMENTS = [V.valeur, ...V.valeur.split(".").filter((f) => f.length >= 6)];

/** Attributs d'un Set-Cookie, valeur retirée. */
const attributs = (entete: string): string => entete.split(";").slice(1).join(";").trim();

describe("cutover des sessions : cookie du Python présenté au core TS", () => {
  let dossier: string;
  let t: BaseDeTest;
  let restaurer: () => void;
  const apps: Partial<Record<"main" | "admin", FastifyInstance>> = {};
  const fermetures: (() => Promise<void> | void)[] = [];
  const acces: string[] = [];
  let debutJournal = 0;
  const auditAvant = process.env["ELPIS_AUDIT_DIR"];

  beforeAll(async () => {
    debutJournal = lignesJournal.length;
    dossier = mkdtempSync(join(tmpdir(), "elpis-bascule-session-"));
    writeFileSync(join(dossier, "config.json"), "{}");
    process.env["ELPIS_AUDIT_DIR"] = join(dossier, "audit");
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    expect(await createUser(t.base, "alice", MOT_DE_PASSE, { maintenant: V.t })).toBe(
      V.session_relue_par_python["user_id"],
    );
    const dep: DependancesAuth & DependancesJetons = {
      ...dependancesParDefaut(t.base),
      config: () => ({}),
      attributsCookie: () => ({ cookie_name: NOM, same_site: "lax", https_only: false, max_age: 86400 }),
      secret: () => V.secret,
      jetonService: () => "",
      maintenant: () => V.t,
    };
    for (const mode of ["main", "admin"] as const) {
      const c = await composer(mode, t.base, journalMuet, dep, dossier);
      const ecrire = (e: LigneJournal): void => void acces.push(ligneJournal(e, mode));
      apps[mode] = await appTest({
        ...c,
        mode,
        extensions: [
          journalAcces({
            service: mode,
            mandataires: analyserMandataires("127.0.0.0/8"),
            ecrire: () => ecrire,
          }),
          ...(c.extensions ?? []),
        ],
      });
      fermetures.push(async () => {
        await apps[mode]?.close();
        c.evenements.systemEvents.fermer({ type: "fin" });
      });
    }
  });

  afterAll(async () => {
    for (const f of fermetures) await f();
    await t.fermer();
    restaurer();
    if (auditAvant === undefined) delete process.env["ELPIS_AUDIT_DIR"];
    else process.env["ELPIS_AUDIT_DIR"] = auditAvant;
    oublierConfigurationAudit();
    installerCrochetJournal(null);
    installerDiffusion(null);
    installerRelaisModeles(null);
    rmSync(dossier, { recursive: true, force: true });
  });

  const requete = (
    mode: "main" | "admin",
    method: "GET" | "POST",
    url: string,
    cookie: string,
    payload?: unknown,
  ) =>
    (apps[mode] as FastifyInstance).inject({
      method,
      url,
      headers: { host: "lan.test", origin: "http://lan.test", cookie },
      remoteAddress: "10.0.0.5",
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  it("vecteur : session que le Python relit valide (même secret, compte 1) et que le TS ne lit pas", () => {
    expect(V.session_relue_par_python).toMatchObject({ user_id: 1, _sid: "sid-de-la-session-python" });
    expect(lireSession(V.valeur, V.secret, 86400, V.t)).toBeNull();
  });

  it("retour arrière (python-final) : cookie que le TS lit valide ; le vecteur (rejoué par tests/migration) le montre ignoré par le Python, sans Set-Cookie", () => {
    expect(lireSession(V.retour_arriere.cookie_ts, V.secret, 86400, V.t)).toMatchObject({ user_id: 1 });
    expect([V.retour_arriere.session_vue_par_python, V.retour_arriere.set_cookie]).toEqual([{}, []]);
  });

  it("main et admin : toute route GET sous session, staff ou admin répond 401 « pas connecté », jamais 500 ni 2xx, sans Set-Cookie", async () => {
    const vues: string[] = [];
    for (const mode of ["main", "admin"] as const) {
      const app = apps[mode] as FastifyInstance;
      const gardees = app.elpis.routes.filter(
        (r) =>
          ["session", "staff", "admin"].includes(String(r.acces)) &&
          r.methodes.includes("GET") &&
          !r.chemin.includes(":") &&
          !r.chemin.includes("*"),
      );
      expect(gardees.length, mode).toBeGreaterThan(10);
      for (const r of gardees) {
        const rep = await requete(mode, "GET", r.chemin, ANCIEN);
        vues.push(`${mode} ${r.chemin} ${rep.statusCode}`);
        expect([rep.statusCode, rep.headers["set-cookie"]], `${mode} ${r.chemin}`).toEqual([401, undefined]);
        expect(rep.json(), `${mode} ${r.chemin}`).toEqual({ detail: "not logged in" });
      }
    }
    expect(vues.length).toBeGreaterThan(40);
  });

  it("pages et état de connexion : SPA servie, me-lite « non connecté », auth/check 401, sans Set-Cookie", async () => {
    let rep = await requete("main", "GET", "/", ANCIEN);
    expect([rep.statusCode, String(rep.headers["content-type"])]).toEqual([200, "text/html; charset=utf-8"]);
    rep = await requete("admin", "GET", "/admin", ANCIEN);
    expect(rep.statusCode).toBe(200);
    rep = await requete("main", "GET", "/api/me-lite", ANCIEN);
    expect([rep.statusCode, rep.json(), rep.headers["set-cookie"]]).toEqual([
      200,
      { logged_in: false },
      undefined,
    ]);
    rep = await requete("main", "GET", "/api/auth/check", ANCIEN);
    expect([rep.statusCode, rep.json()]).toEqual([401, { detail: "not authenticated" }]);
  });

  it("déconnexion avec l'ancien cookie : 200, une seule suppression (celle de la route, forme unique du TS) ; aucun effacement du middleware pour une session illisible", async () => {
    const rep = await requete("main", "POST", "/api/logout-lite", ANCIEN);
    const [statut, corps, entetes] = V.logout_cookie_illisible as [number, unknown, string[]];
    expect([rep.statusCode, rep.json(), ([] as string[]).concat(rep.headers["set-cookie"] ?? [])]).toEqual([
      statut,
      corps,
      entetes.map(effacementUnifie),
    ]);
  });

  it("reconnexion : login-lite avec l'ancien cookie (même site) pose un cookie TS qui le remplace (même nom, chemin et attributs que le Python), session ouverte", async () => {
    const rep: LightMyRequestResponse = await requete("main", "POST", "/api/login-lite", ANCIEN, {
      username: "alice",
      password: MOT_DE_PASSE,
    });
    expect([rep.statusCode, rep.json()]).toEqual([
      200,
      { ok: true, is_admin: false, must_change_password: false },
    ]);
    const poses = ([] as string[]).concat(rep.headers["set-cookie"] ?? []);
    expect(poses).toHaveLength(1);
    const pose = poses[0] ?? "";
    expect(pose.startsWith(`${NOM}=`)).toBe(true);
    expect(attributs(pose)).toBe(attributs(V.set_cookie));
    expect(pose.toLowerCase()).not.toContain("domain=");
    const nouveau = pose.split(";")[0] ?? "";
    expect(nouveau).not.toBe(ANCIEN);
    expect(lireSession(nouveau.slice(NOM.length + 1), V.secret, 86400, V.t)).toMatchObject({
      user_id: 1,
      _login_ts: V.t,
    });
    const moi = await requete("main", "GET", "/api/me-lite", nouveau);
    expect(moi.json()).toMatchObject({ logged_in: true, id: 1, username: "alice" });
    expect((await requete("main", "GET", "/api/auth/check", nouveau)).statusCode).toBe(204);
    const reservee = (apps.admin as FastifyInstance).elpis.routes.find(
      (r) => r.acces === "admin" && r.methodes.includes("GET") && !/[:*]/u.test(r.chemin),
    );
    const refus = await requete("admin", "GET", reservee?.chemin ?? "", nouveau);
    expect([refus.statusCode, refus.json()]).toEqual([403, { detail: "Admin required" }]);
  });

  it("journaux : ni le cookie du Python ni un fragment, aucune erreur ; les lignes d'accès de l'ancien cookie sont anonymes", () => {
    const journal = lignesJournal.slice(debutJournal);
    for (const ligne of [...journal, ...acces])
      for (const f of FRAGMENTS) expect(ligne.includes(f), ligne).toBe(false);
    expect(journal.filter((l) => / ERROR /u.test(l))).toEqual([]);
    expect(acces.length).toBeGreaterThan(40);
    expect(acces.filter((l) => /"status": 5\d\d/u.test(l))).toEqual([]);
  });
});
