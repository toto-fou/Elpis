// SPDX-License-Identifier: MIT
/** apps/core/test/securite-session-methode.test.ts — une session n'est valable que si sa méthode de connexion l'est encore : fournisseur éteint ou retiré du fichier, mode « administrateurs seulement ». */
import {
  createUser,
  dependancesParDefaut,
  dependancesSession,
  metaSession,
  ouvrirSession,
  revaliderFlux,
  Session,
  validerSession,
} from "@elpis/auth";
import type { DependancesAuth, MethodeConnexion } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { creerCompte, demarrerCore } from "../../../packages/contracts/test/core/aides";
import type { CoreDeTest } from "../../../packages/contracts/test/core/aides";
import { sessionAdmise } from "../src/identite/session";
import { configDeTest, ldapValide, oidcValide } from "./identite/aides";
import type { ConfigDeTest } from "./identite/aides";

describe("méthode de connexion relue à chaud (sessions et flux)", () => {
  let t: BaseDeTest;
  let cfg: ConfigDeTest;
  let simple = 0;
  let admin = 0;
  let auth: DependancesAuth;

  beforeEach(async () => {
    cfg = configDeTest();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    simple = await createUser(t.base, "bob", "mdp-bob", { isAdmin: 0 });
    admin = await createUser(t.base, "root", "mdp-root", { isAdmin: 1 });
    auth = { ...dependancesParDefaut(t.base), sessionAdmise };
  });

  afterEach(async () => {
    cfg.fermer();
    await t.fermer();
  });

  const ouvrir = (uid: number, methode: MethodeConnexion): Session => {
    const s = new Session();
    ouvrirSession(s, { uid, methode, maintenant: Date.now() / 1000, dureeMax: 3600 });
    return s;
  };
  const valide = async (s: Session, uid: number): Promise<boolean> =>
    (await validerSession(s, uid, dependancesSession(auth))).valide;
  const fluxGarde = (s: Session, uid: number): Promise<boolean> =>
    revaliderFlux(auth, uid, s.get("_login_ts"), s.get("_sid"), metaSession(s));

  it("sans section auth : rien ne change (mot de passe, ou méthode absente d'une session d'avant)", async () => {
    cfg.ecrire({});
    const s = ouvrir(simple, "password");
    expect(await valide(s, simple)).toBe(true);
    expect(await fluxGarde(ouvrir(simple, "password"), simple)).toBe(true);
    const ancienne = new Session({ user_id: simple, _login_ts: Date.now() / 1000 });
    expect(await valide(ancienne, simple)).toBe(true);
  });

  it.each([
    ["ldap:annuaire", ldapValide()],
    ["oidc:sso", oidcValide()],
  ] as const)(
    "%s : éteint dans le fichier, la session et le flux sont refusés à la requête suivante",
    async (methode, f) => {
      cfg.ecrire({ auth: { providers: [{ ...f, enabled: true }] } });
      expect(await valide(ouvrir(simple, methode), simple)).toBe(true);
      expect(await fluxGarde(ouvrir(simple, methode), simple)).toBe(true);
      cfg.ecrire({ auth: { providers: [{ ...f, enabled: false }] } });
      expect(await valide(ouvrir(simple, methode), simple)).toBe(false);
      expect(await fluxGarde(ouvrir(simple, methode), simple)).toBe(false);
    },
  );

  it("fournisseur retiré du fichier : session et flux refusés ; autre fournisseur actif sans effet", async () => {
    cfg.ecrire({ auth: { providers: [{ ...oidcValide(), enabled: true }] } });
    expect(await valide(ouvrir(simple, "ldap:annuaire"), simple)).toBe(false);
    expect(await fluxGarde(ouvrir(simple, "ldap:annuaire"), simple)).toBe(false);
    expect(await valide(ouvrir(simple, "oidc:sso"), simple)).toBe(true);
  });

  it("mode admins : session par mot de passe d'un non-administrateur refusée, celle d'un administrateur gardée ; retour au mode all", async () => {
    cfg.ecrire({ auth: { local: { mode: "admins" } } });
    expect(await valide(ouvrir(simple, "password"), simple)).toBe(false);
    expect(await fluxGarde(ouvrir(simple, "password"), simple)).toBe(false);
    expect(await valide(ouvrir(admin, "password"), admin)).toBe(true);
    expect(await fluxGarde(ouvrir(admin, "password"), admin)).toBe(true);
    cfg.ecrire({ auth: { local: { mode: "all" } } });
    expect(await valide(ouvrir(simple, "password"), simple)).toBe(true);
    expect(await fluxGarde(ouvrir(simple, "password"), simple)).toBe(true);
  });

  it("une session d'un fournisseur n'est pas touchée par le mode local", async () => {
    cfg.ecrire({ auth: { local: { mode: "admins" }, providers: [{ ...ldapValide(), enabled: true }] } });
    expect(await valide(ouvrir(simple, "ldap:annuaire"), simple)).toBe(true);
  });
});

describe("mode administrateurs seulement : le cœur réel coupe la session par mot de passe (console)", () => {
  let core: CoreDeTest;
  let cfg: ConfigDeTest;

  beforeAll(async () => {
    core = await demarrerCore("admin");
    cfg = configDeTest();
    await creerCompte(core.base, "racine", "mdp-racine-1", 1);
    await creerCompte(core.base, "bob", "mdp-bob-1");
  });

  afterAll(async () => {
    cfg.fermer();
    await core.fermer();
  });

  it("cookie d'un non-administrateur refusé au mode admins, nouvelle connexion refusée, retour au mode all", async () => {
    const cookieBob = await core.connecter("bob", "mdp-bob-1");
    const cookieRacine = await core.connecter("racine", "mdp-racine-1");
    const moi = async (cookie: string) =>
      (await core.app.inject({ method: "GET", url: "/api/me-lite", headers: { cookie } })).json().logged_in;
    expect(await moi(cookieBob)).toBe(true);
    cfg.ecrire({ auth: { local: { mode: "admins" } } });
    expect(await moi(cookieBob)).toBe(false);
    expect(await moi(cookieRacine)).toBe(true);
    cfg.ecrire({ auth: { local: { mode: "all" } } });
    expect(await core.connecter("bob", "mdp-bob-1")).not.toBe("");
  });
});
