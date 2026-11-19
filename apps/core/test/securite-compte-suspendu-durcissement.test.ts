// SPDX-License-Identifier: MIT
/** apps/core/test/securite-compte-suspendu-durcissement.test.ts — suspension en une écriture, réactivation sans session ressuscitée, sous-agents en fond coupés, publication vers main retentée, colonnes d'état ajoutées à une base déjà peuplée. */
import {
  compteSuspendu,
  createUser,
  dependancesParDefaut,
  dependancesSession,
  ligneUtilisateur,
  Session,
  validerSession,
} from "@elpis/auth";
import { CycleDeVie } from "../src/cycle";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { reactiver, suspendre } from "../src/comptes/etat";
import { brancherEvenements } from "../src/evenements/branchement";
import { annulerEnFondDuCompte, FOND } from "../src/outils/integres/task/fond";
import type { EnFond } from "../src/outils/integres/task/fond";
import { ACTIFS, cle } from "../src/outils/integres/task/registre";
import { journalMuet } from "./aides";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

type Fn = (...a: unknown[]) => unknown;

/** Base dont chaque `run` passe par `surRun`, y compris ceux d'une transaction `ecriture` (la suspension écrit sous la garde de l'administrateur local). */
function baseEspionnee<T extends object>(
  cible: T,
  surRun: (sql: string, suite: () => unknown) => unknown,
): T {
  return new Proxy(cible, {
    get(c, prop) {
      const v = Reflect.get(c, prop) as unknown;
      if (prop === "run")
        return (sql: string, ...reste: unknown[]) => surRun(sql, () => (v as Fn).call(c, sql, ...reste));
      if (prop === "ecriture")
        return (f: (x: object) => unknown) => (v as Fn).call(c, (x: object) => f(baseEspionnee(x, surRun)));
      return typeof v === "function" ? (v as Fn).bind(c) : v;
    },
  });
}
const T0 = 1_800_000_000;

describe.each(MOTEURS)("suspension et réactivation : écriture unique, sessions (%s)", (moteur) => {
  let t: BaseDeTest;
  let alice = 0;
  let horloge = T0;

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    alice = await createUser(t.base, "alice", "mdp-alice", { maintenant: T0 });
  });

  afterAll(async () => t?.fermer());

  const dep = (base = t.base): Parameters<typeof suspendre>[0] => ({
    base,
    acces: dependancesParDefaut(base),
    maintenant: () => horloge,
    publierSuspension: async () => true,
    journal: journalMuet,
  });

  it("suspendre : une seule écriture pose état, auteur et coupure des sessions ; un échec d'écriture ne change rien", async () => {
    await t.base.run("UPDATE users SET suspended_at=0, suspended_by=NULL, session_min_ts=0 WHERE id=?", [
      alice,
    ]);
    const ecritures: string[] = [];
    const espion = baseEspionnee(t.base, (sql, suite) => {
      ecritures.push(sql);
      return suite();
    });
    const bilan = await suspendre(dep(espion), alice, "admin");
    expect(bilan.change).toBe(true);
    expect(ecritures.filter((s) => s.startsWith("UPDATE users"))).toHaveLength(1);
    const ligne = await ligneUtilisateur(t.base, alice);
    expect([Number(ligne?.suspended_at), ligne?.suspended_by, Number(ligne?.session_min_ts)]).toEqual([
      T0,
      "admin",
      T0,
    ]);
    await t.base.run("UPDATE users SET suspended_at=0, suspended_by=NULL, session_min_ts=0 WHERE id=?", [
      alice,
    ]);
    const casse = baseEspionnee(t.base, async () => {
      throw new Error("écriture refusée");
    });
    await expect(suspendre(dep(casse), alice, "admin")).rejects.toThrow("écriture refusée");
    const intact = await ligneUtilisateur(t.base, alice);
    expect([compteSuspendu(intact), Number(intact?.session_min_ts)]).toEqual([false, 0]);
  });

  it("réactivation : une session datée après la coupure (connexion en vol) reste morte, une session neuve vit, le min ne baisse jamais", async () => {
    await t.base.run("UPDATE users SET suspended_at=0, suspended_by=NULL, session_min_ts=0 WHERE id=?", [
      alice,
    ]);
    horloge = T0 + 100;
    await suspendre(dep(), alice, "admin");
    const dependances = {
      ...dependancesParDefaut(t.base),
      maintenant: () => horloge,
      config: () => ({}),
    };
    const valide = async (login: number): Promise<boolean> =>
      (
        await validerSession(
          new Session({ user_id: alice, _login_ts: login, _sid: `s${login}` }),
          alice,
          dependancesSession(dependances),
        )
      ).valide;
    const enVol = horloge + 1;
    expect(await valide(enVol)).toBe(false);
    horloge = T0 + 200;
    expect(await reactiver({ base: t.base, maintenant: () => horloge }, alice)).toBe(true);
    expect(await valide(enVol)).toBe(false);
    expect(await valide(horloge + 1)).toBe(true);
    await t.base.run("UPDATE users SET suspended_at=?, suspended_by='x' WHERE id=?", [horloge, alice]);
    await reactiver({ base: t.base, maintenant: () => T0 }, alice);
    expect(Number((await ligneUtilisateur(t.base, alice))?.session_min_ts)).toBe(T0 + 200);
  });

  it("valeur de suspension illisible ou négative : suspendu, et suspendre n'écrase rien", async () => {
    if (moteur === "sqlite") {
      await t.base.run("UPDATE users SET suspended_at='abc', suspended_by='dir' WHERE id=?", [alice]);
      expect(compteSuspendu(await ligneUtilisateur(t.base, alice))).toBe(true);
      expect((await suspendre(dep(), alice, "admin")).change).toBe(false);
      expect((await ligneUtilisateur(t.base, alice))?.suspended_by).toBe("dir");
      expect(await reactiver({ base: t.base, maintenant: () => horloge }, alice)).toBe(true);
    }
    await t.base.run("UPDATE users SET suspended_at=-5, suspended_by='dir' WHERE id=?", [alice]);
    expect(compteSuspendu(await ligneUtilisateur(t.base, alice))).toBe(true);
    expect((await suspendre(dep(), alice, "admin")).change).toBe(false);
    expect(await reactiver({ base: t.base, maintenant: () => horloge }, alice)).toBe(true);
    expect(compteSuspendu(await ligneUtilisateur(t.base, alice))).toBe(false);
  });
});

describe.each(MOTEURS)("colonnes d'état ajoutées à une base existante et peuplée (%s)", (moteur) => {
  it("les comptes d'avant restent actifs, sans connexion connue, et se suspendent puis se réactivent", async () => {
    const t = ouvrirBaseDeTest(moteur);
    try {
      await initialiserBase(t.base);
      const ancien = await createUser(t.base, "ancien", "mdp", { maintenant: T0 });
      for (const c of ["suspended_at", "suspended_by", "last_login_at"])
        await t.base.run(`ALTER TABLE users DROP COLUMN ${c}`);
      await initialiserBase(t.base);
      const ligne = await ligneUtilisateur(t.base, ancien);
      expect([compteSuspendu(ligne), Number(ligne?.last_login_at ?? 0)]).toEqual([false, 0]);
      const dep = {
        base: t.base,
        acces: dependancesParDefaut(t.base),
        maintenant: () => T0,
        publierSuspension: async () => true,
        journal: journalMuet,
      };
      expect((await suspendre(dep, ancien, "admin")).change).toBe(true);
      expect(compteSuspendu(await ligneUtilisateur(t.base, ancien))).toBe(true);
      expect(await reactiver({ base: t.base, maintenant: () => T0 + 1 }, ancien)).toBe(true);
    } finally {
      await t.fermer();
    }
  });
});

describe("sous-agents en fond : arrêtés avec les exécutions du compte", () => {
  afterEach(() => {
    FOND.clear();
    ACTIFS.clear();
  });

  const enregistrer = (uid: number, username: string, id: string): AbortController => {
    const arret = new AbortController();
    ACTIFS.set(cle(username, id), { agent: "explore", chatId: "c1", t0: 0, arret });
    FOND.set(cle(username, id), { uid, username, taskId: id, actif: true } as unknown as EnFond);
    return arret;
  };

  it("annulerEnFondDuCompte coupe tous les enfants actifs du compte et seulement les siens", () => {
    const a1 = enregistrer(7, "alice", "t1");
    const a2 = enregistrer(7, "alice", "t2");
    const b1 = enregistrer(8, "bob", "t1");
    expect(annulerEnFondDuCompte(7)).toBe(2);
    expect([a1.signal.aborted, a2.signal.aborted, b1.signal.aborted]).toEqual([true, true, false]);
    expect(annulerEnFondDuCompte(7)).toBe(2);
  });
});

describe("publication de la suspension vers main : nouveaux essais bornés", () => {
  const admin = (reponses: boolean[]): { evt: ReturnType<typeof brancherEvenements>; appels: number } => {
    const etat = { appels: 0 };
    const evt = brancherEvenements({
      mode: "admin",
      cycle: new CycleDeVie(journalMuet),
      auth: { ...dependancesParDefaut(ouvrirBaseDeTest("sqlite").base, () => "secret-de-test") },
      journal: journalMuet,
      canal: {
        delaisEssaiSuspensionMs: [0, 0],
        fetch: (async () => {
          const ok = reponses[Math.min(etat.appels, reponses.length - 1)] ?? false;
          etat.appels += 1;
          return new Response(null, { status: ok ? 200 : 503 });
        }) as typeof fetch,
      },
    });
    return {
      evt,
      get appels() {
        return etat.appels;
      },
    };
  };

  it("main répond au deuxième essai : propagé ; toujours muet : propage faux après trois essais", async () => {
    const ok = admin([false, true]);
    expect((await ok.evt.suspendre(5)).propage).toBe(true);
    expect(ok.appels).toBe(2);
    const muet = admin([false]);
    expect((await muet.evt.suspendre(5)).propage).toBe(false);
    expect(muet.appels).toBe(3);
  });

  it("main qui ne répond jamais : la requête de l'administrateur n'est retenue que huit secondes environ", async () => {
    const delais: number[] = [];
    const evt = brancherEvenements({
      mode: "admin",
      cycle: new CycleDeVie(journalMuet),
      auth: { ...dependancesParDefaut(ouvrirBaseDeTest("sqlite").base, () => "secret-de-test") },
      journal: journalMuet,
      canal: {
        fetch: ((_url: unknown, init?: RequestInit) =>
          new Promise((_ok, ko) => {
            const debut = Date.now();
            init?.signal?.addEventListener("abort", () => {
              delais.push(Date.now() - debut);
              ko(new Error("délai dépassé"));
            });
          })) as typeof fetch,
      },
    });
    const debut = Date.now();
    expect((await evt.suspendre(5)).propage).toBe(false);
    expect(Date.now() - debut).toBeLessThan(8_800);
    expect(delais.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...delais)).toBeLessThan(1_800);
  }, 20_000);
});
