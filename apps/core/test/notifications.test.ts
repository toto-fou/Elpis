// SPDX-License-Identifier: MIT
/** apps/core/test/notifications.test.ts — centre de notifications : routes et envoi rejoués contre le Python (vecteurs), rétention, pagination, cloisonnement, bus. */
import { readFileSync } from "node:fs";

import { createUser } from "@elpis/auth";
import { HttpError, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FileAttente } from "../src/evenements/file";
import { SystemEvents } from "../src/evenements/systeme";
import type { ElementSysteme } from "../src/evenements/systeme";
import { creerFamilleNotifications } from "../src/familles/notifications";
import {
  installerPublicationNotifications,
  LIVE_BODY_MAX,
  pousserNotification,
} from "../src/notifications/envoi";
import {
  clearAll,
  countUnread,
  createNotification,
  deleteNotification,
  listNotifications,
  markAllRead,
  markRead,
  markUnread,
  MAX_PER_USER,
  pruneRefNotifications,
} from "../src/notifications/stockage";
import { appTest } from "./aides";

type Envoi = [string, string, string, string, string, number | string | null, boolean, number];

const V = pyJsonLoads(readFileSync(new URL("./vecteurs/notifications.json", import.meta.url), "utf-8"), {
  mode: "natif",
}) as {
  comptes: [string, number][];
  envois: Envoi[];
  etapes: [string | null, string, string, number?][];
  operations: [string, unknown[]][];
  ids: Record<string, number>;
  envoyes: { id: number | null; evenements: Record<string, unknown>[] }[];
  reponses: { statut: number; corps: string }[];
  magasin: { resultat?: string; erreur?: string; message?: string }[];
};

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

/** Garde de session des tests : compte lu dans `x-uid`, 401 sans lui. */
const gardes = {
  session: (req: { headers: Record<string, unknown>; utilisateur?: unknown }) => {
    const uid = req.headers["x-uid"];
    if (!uid) throw new HttpError(401, "not logged in");
    req.utilisateur = { id: Number(uid), username: null };
  },
};

async function baseAvecComptes(moteur: "sqlite" | "postgres"): Promise<BaseDeTest> {
  const t = ouvrirBaseDeTest(moteur);
  await initialiserBase(t.base);
  for (const [nom, admin] of V.comptes) await createUser(t.base, nom, `mdp-${nom}`, { isAdmin: admin });
  return t;
}

describe.each(MOTEURS)("routes et envoi rejoués contre le Python (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;

  beforeAll(async () => {
    t = await baseAvecComptes(moteur);
    app = await appTest({ familles: [creerFamilleNotifications({ base: t.base })], gardes });
  });

  afterAll(async () => {
    vi.useRealTimers();
    installerPublicationNotifications(null);
    await app.close();
    await t.fermer();
  });

  it("envois, événements live, réponses et magasin identiques (vecteurs)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const evenements: Record<string, unknown>[] = [];
    installerPublicationNotifications((m) => void evenements.push(m));
    const ids: number[] = [];
    for (const [i, [nom, kind, title, body, refType, refId, live, quand]] of V.envois.entries()) {
      vi.setSystemTime(quand * 1000);
      const avant = evenements.length;
      const nid = await pousserNotification(t.base, V.ids[nom] ?? 0, kind, title, {
        body,
        refType,
        refId,
        live,
      });
      const attendu = V.envoyes[i];
      expect(nid, `envoi ${i}`).toBe(attendu?.id);
      expect(
        evenements.slice(avant).map((e) => pyJsonDumps(e)),
        `envoi ${i}`,
      ).toEqual((attendu?.evenements ?? []).map((e) => pyJsonDumps(e)));
      ids.push(nid ?? 0);
    }
    for (const [i, [nom, methode, chemin, statutTs]] of V.etapes.entries()) {
      vi.setSystemTime((1_900_000_000 + 10 * i) * 1000);
      const url = ids.reduce((s, id, k) => s.replaceAll(`{n${k}}`, String(id)), chemin);
      const r = await app.inject({
        method: methode as "GET",
        url,
        headers: nom ? { "x-uid": String(V.ids[nom]) } : {},
      });
      const attendu = V.reponses[i];
      if (statutTs !== undefined) {
        expect(r.statusCode, `étape ${i} : ${methode} ${chemin} (écart déclaré)`).toBe(statutTs);
        continue;
      }
      expect({ statut: r.statusCode, corps: r.body }, `étape ${i} : ${methode} ${chemin}`).toEqual(attendu);
    }
    if (moteur !== "sqlite") return;
    const b = t.base;
    const operations: Record<string, (a: unknown[]) => Promise<unknown>> = {
      create_notification: ([u, k, ti, bo, rt, ri]) =>
        createNotification(
          b,
          u as number,
          k as string,
          ti as string,
          bo as string,
          rt as string,
          ri as number,
        ),
      prune_ref_notifications: ([u, rt, ri, keep]) =>
        pruneRefNotifications(b, u as number, rt as string, ri as number, keep),
      list_notifications: ([u, limite, avant]) =>
        listNotifications(b, u as number, limite as number, avant as number | null),
      mark_read: ([u, n]) => markRead(b, u as number, n as number),
      mark_unread: ([u, n]) => markUnread(b, u as number, n as number),
      delete_notification: ([u, n]) => deleteNotification(b, u as number, n as number),
      mark_all_read: ([u]) => markAllRead(b, u as number),
      count_unread: ([u]) => countUnread(b, u as number),
      clear_all: ([u]) => clearAll(b, u as number),
    };
    for (const [i, [fonction, args]] of V.operations.entries()) {
      vi.setSystemTime((2_000_000_000 + 10 * i) * 1000);
      const f = operations[fonction];
      if (!f) throw new Error(`opération inconnue : ${fonction}`);
      const resultat = await f([V.ids[args[0] as string], ...args.slice(1)]);
      expect(
        { resultat: pyJsonDumps(resultat, { ensureAscii: false }) },
        `magasin ${i} : ${fonction}`,
      ).toEqual(V.magasin[i]);
    }
  });
});

describe.each(MOTEURS)("magasin (%s)", (moteur) => {
  let t: BaseDeTest;
  let alice: number;
  let bob: number;

  beforeEach(async () => {
    t = await baseAvecComptes(moteur);
    alice = V.ids["alice"] ?? 2;
    bob = V.ids["bob"] ?? 3;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await t.fermer();
  });

  it("rétention : les plus récentes seulement, au-delà de MAX_PER_USER (test_purge_caps_per_user)", async () => {
    for (let i = 0; i < MAX_PER_USER + 3; i++) await createNotification(t.base, alice, "k", `n${i}`);
    await createNotification(t.base, bob, "k", "bob");
    const items = await listNotifications(t.base, alice, 1000);
    expect(items).toHaveLength(MAX_PER_USER);
    expect(items[0]?.["title"]).toBe(`n${MAX_PER_USER + 2}`);
    expect(items.at(-1)?.["title"]).toBe("n3");
    expect(await countUnread(t.base, bob)).toBe(1);
  });

  it("pagination par (created_at, id) : aucune notification sautée (test_notifications_pagination)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const ids: number[] = [];
    for (const [i, quand] of [100, 50, 75, 100].entries()) {
      vi.setSystemTime(quand * 1000);
      ids.push(await createNotification(t.base, alice, "k", `n${i + 1}`));
    }
    const vues: string[] = [];
    let page = await listNotifications(t.base, alice, 1);
    while (page.length > 0) {
      vues.push(String(page[0]?.["title"]));
      page = await listNotifications(t.base, alice, 1, Number(page.at(-1)?.["id"]));
    }
    expect(vues).toEqual(["n4", "n1", "n3", "n2"]);
    await t.base.run("DELETE FROM notifications WHERE id=?", [ids[2] ?? 0]);
    expect((await listNotifications(t.base, alice, 10, ids[2] ?? 0)).map((r) => r["title"])).toEqual([
      "n1",
      "n2",
    ]);
    const autre = await createNotification(t.base, bob, "k", "autre");
    expect((await listNotifications(t.base, alice, 10, autre)).map((r) => r["title"])).toEqual([
      "n4",
      "n1",
      "n2",
    ]);
  });

  it("cloisonnement : lu, non lu et suppression sans effet sur la notification d'un autre compte", async () => {
    const a = await createNotification(t.base, alice, "k", "a");
    expect(await markRead(t.base, bob, a)).toBe(false);
    expect(await markUnread(t.base, bob, a)).toBe(false);
    expect(await deleteNotification(t.base, bob, a)).toBe(false);
    expect(await clearAll(t.base, bob)).toBe(0);
    expect(await markRead(t.base, alice, a)).toBe(true);
    expect(await markRead(t.base, alice, a)).toBe(false);
    expect(await markUnread(t.base, alice, a)).toBe(true);
    expect(await countUnread(t.base, alice)).toBe(1);
  });

  it("suppression du compte : ses notifications partent avec lui (test_cascade_delete_on_user_removal)", async () => {
    await createNotification(t.base, alice, "k", "a");
    if (moteur === "sqlite") await t.base.exec("PRAGMA foreign_keys=ON");
    await t.base.run("DELETE FROM users WHERE id=?", [alice]);
    expect(await listNotifications(t.base, alice)).toEqual([]);
  });

  it("purge par source : texte numérique et entier désignent la même source (PostgreSQL : colonne texte)", async () => {
    for (const ref of [5, "5", 5])
      await createNotification(t.base, alice, "routine_ok", "r", "", "routine", ref);
    expect(await pruneRefNotifications(t.base, alice, "routine", 5, 1)).toBe(2);
    expect((await listNotifications(t.base, alice)).map((r) => r["ref_id"])).toEqual([5]);
  });
});

describe("envoi (test_notifications_push)", () => {
  let t: BaseDeTest;

  beforeEach(async () => {
    t = await baseAvecComptes("sqlite");
  });

  afterEach(async () => {
    installerPublicationNotifications(null);
    await t.fermer();
  });

  it("sans bus installé : persistée, aucun événement", async () => {
    const nid = await pousserNotification(t.base, 2, "routine_ok", "T");
    expect(nid).toBe(1);
    expect(await countUnread(t.base, 2)).toBe(1);
  });

  it("création en échec : `null`, aucun événement ; bus en échec : id rendu quand même", async () => {
    const vus: unknown[] = [];
    installerPublicationNotifications((m) => void vus.push(m));
    const enPanne = { transaction: () => Promise.reject(new Error("db down")) } as unknown as Base;
    expect(await pousserNotification(enPanne, 2, "routine_ok", "T")).toBeNull();
    expect(vus).toEqual([]);
    installerPublicationNotifications(() => {
      throw new Error("bus coupé");
    });
    expect(await pousserNotification(t.base, 2, "routine_ok", "T")).toBe(1);
    installerPublicationNotifications(() => Promise.reject(new Error("bus coupé")));
    expect(await pousserNotification(t.base, 2, "routine_ok", "T", { body: "b" })).toBe(2);
  });

  it("live: false n'émet rien ; corps de l'aperçu borné à LIVE_BODY_MAX points de code", async () => {
    const vus: Record<string, unknown>[] = [];
    installerPublicationNotifications((m) => void vus.push(m));
    await pousserNotification(t.base, 2, "k", "T", { live: false });
    expect(vus).toEqual([]);
    await pousserNotification(t.base, 2, "k", "T", { body: "😀".repeat(LIVE_BODY_MAX + 5) });
    const data = vus[0]?.["data"] as Record<string, unknown>;
    expect(data["body"]).toBe("😀".repeat(LIVE_BODY_MAX));
    expect(data["unread"]).toBe(2);
  });

  it("sur le bus système : remise aux seuls flux du destinataire, badge à jour", async () => {
    const bus = new SystemEvents();
    const files = [2, 3].map((uid) => {
      const file = new FileAttente<ElementSysteme>();
      bus.clients.set(file, { staff: false, uid });
      return file;
    });
    installerPublicationNotifications((m) => bus.broadcast(m));
    const nid = await pousserNotification(t.base, 2, "routine_ok", "Fini", { refType: "routine", refId: 4 });
    expect(files.map((f) => f.taille)).toEqual([1, 0]);
    expect(files[0]?.retirer()).toBe(
      pyJsonDumps({
        type: "notification",
        data: {
          user_id: 2,
          id: nid,
          kind: "routine_ok",
          title: "Fini",
          body: "",
          ref_type: "routine",
          ref_id: 4,
          unread: 1,
        },
      }),
    );
  });
});
