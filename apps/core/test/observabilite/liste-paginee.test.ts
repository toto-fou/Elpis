// SPDX-License-Identifier: MIT
/** apps/core/test/observabilite/liste-paginee.test.ts — listes Exécutions et Erreurs d'outils de la console : total, décalage, recherche, tri en liste blanche, bornes (SQLite et PostgreSQL). */
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerFamilleAdminRuns } from "../../src/familles/admin-runs";
import { creerFamilleMetriques } from "../../src/familles/metriques";
import { requeteTotal } from "../../src/familles/admin-runs";
import { conditionRecherche, motifRecherche } from "../../src/familles/liste-paginee";
import type { ContexteMetriques } from "../../src/observabilite/fournisseurs/base";
import { appTest } from "../aides";
import { comptesDeTest, gardesDeTest } from "../exploitation/aides";

const T0 = 1_800_000_000;
interface Corps {
  items: Record<string, unknown>[];
  total: number;
  offset: number;
  limit: number;
}

describe("aides de recherche", () => {
  it("jokers et barre inverse neutralisés, casse ignorée, longueur bornée, vide ignoré", () => {
    expect(motifRecherche("  ")).toBeNull();
    expect(motifRecherche("A%b_c\\d")).toBe("%A\\%b\\_c\\\\d%");
    // La casse n'est pas touchée ici : le moteur plie les deux côtés (LOWER(col) LIKE LOWER(?)).
    expect(motifRecherche("ÉCHEC Ab")).toBe("%ÉCHEC Ab%");
    expect(motifRecherche("x".repeat(500))).toBe(`%${"x".repeat(100)}%`);
    expect(conditionRecherche("a", ["c1", "c2"])).toEqual({
      sql: "(LOWER(c1) LIKE LOWER(?) ESCAPE '\\' OR LOWER(c2) LIKE LOWER(?) ESCAPE '\\')",
      params: ["%a%", "%a%"],
    });
  });
});

for (const moteur of ["sqlite", "postgres"] as const) {
  describe.skipIf(moteur === "postgres" && !PG_DE_TEST)(`listes paginées de la console (${moteur})`, () => {
    let t: BaseDeTest;
    let app: FastifyInstance;
    let admin = 0;
    let alice = 0;

    const lire = async (url: string): Promise<{ statut: number; corps: Corps }> => {
      const r = await app.inject({ method: "GET", url, headers: { "x-uid": String(admin) } });
      return { statut: r.statusCode, corps: r.json() as Corps };
    };
    const ids = (c: Corps, cle = "id"): unknown[] => c.items.map((i) => i[cle]);

    beforeAll(async () => {
      t = ouvrirBaseDeTest(moteur);
      await initialiserBase(t.base);
      const comptes = await comptesDeTest(t.base);
      admin = comptes["admin"] as number;
      alice = comptes["alice"] as number;
      // 120 exécutions de premier niveau, la plus récente d'abord par numéro ; un sous-agent à part.
      for (let i = 0; i < 120; i++)
        await t.base.run(
          "INSERT INTO runs(id, kind, user_id, parent_id, started_at, ended_at, status, input_tokens, model, engine, chat_id, tool_families) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
          [
            `chat-r${String(i).padStart(3, "0")}`,
            "chat",
            i % 2 === 0 ? alice : admin,
            "",
            T0 - 1000 - i,
            T0 - 1000 - i + (i % 7) + 1,
            i % 10 === 0 ? "error" : "ok",
            1000 - i,
            i === 5 ? "modele_100%" : i === 6 ? "modeleX100Y" : "m",
            "builtin",
            "c",
            "{}",
          ],
        );
      await t.base.run(
        "INSERT INTO runs(id, kind, user_id, parent_id, started_at, status, model, engine, chat_id, tool_families) VALUES (?,?,?,?,?,?,?,?,?,?)",
        ["subagent-s1", "subagent", alice, "chat-r000", T0 - 900, "ok", "m", "builtin", "c", "{}"],
      );
      await t.base.run(
        "INSERT INTO runs(id, kind, user_id, parent_id, started_at, status, model, engine, chat_id, tool_families) VALUES (?,?,?,?,?,?,?,?,?,?)",
        ["subagent-s0", "subagent", alice, "chat-r000", T0 - 7200, "ok", "m", "builtin", "c", "{}"],
      );
      // Plus vieille que la période maximale (720 h), hors premier niveau : seule la clé la retrouve.
      await t.base.run(
        "INSERT INTO runs(id, kind, user_id, parent_id, started_at, status, model, engine, chat_id, tool_families) VALUES (?,?,?,?,?,?,?,?,?,?)",
        ["chat-ancien", "chat", alice, "chat-r000", T0 - 800 * 3600, "ok", "m", "builtin", "c", "{}"],
      );
      // 130 appels en échec : outil `shell` (serveur `srv`) un sur deux, messages dont un avec « % » et « _ ».
      for (let i = 0; i < 130; i++)
        await t.base.run(
          "INSERT INTO tool_call_metrics(run_id, user_id, tool_name, server_name, status, duration_ms, error_short, ts) " +
            "VALUES (?,?,?,?,?,?,?,?)",
          [
            `chat-r${String(i % 120).padStart(3, "0")}`,
            alice,
            i % 2 === 0 ? "shell" : "read_file",
            i % 2 === 0 ? "srv" : null,
            i % 3 === 0 ? "error" : i % 3 === 1 ? "blocked" : "timeout",
            i,
            i === 11
              ? "Échec réseau"
              : i === 7
                ? "taux 100% atteint"
                : i === 8
                  ? "nom_de_fichier"
                  : i === 9
                    ? "nomXdeXfichier"
                    : "boom",
            T0 - 500 - i,
          ],
        );
      await t.base.run(
        "INSERT INTO tool_call_metrics(run_id, user_id, tool_name, status, duration_ms, ts) VALUES ('chat-r000',?,?,?,1,?)",
        [alice, "shell", "success", T0 - 400],
      );
      const contexte = { base: t.base } as unknown as ContexteMetriques;
      app = await appTest({
        mode: "admin",
        familles: [
          creerFamilleAdminRuns({ base: t.base, maintenant: () => T0 }),
          creerFamilleMetriques({
            base: t.base,
            auth: {} as never,
            contexte,
            exigerEquipe: async () => admin,
          }),
        ],
        gardes: gardesDeTest(t.base),
      });
    });

    afterAll(async () => {
      await app.close();
      await t.fermer();
    });

    describe("exécutions", () => {
      it("total hors pagination, fenêtre renvoyée, pages successives sans recouvrement", async () => {
        const p1 = (await lire("/api/admin/runs?limit=50")).corps;
        expect([p1.total, p1.offset, p1.limit, p1.items.length]).toEqual([120, 0, 50, 50]);
        const p3 = (await lire("/api/admin/runs?limit=50&offset=100")).corps;
        expect([p3.total, p3.offset, p3.items.length]).toEqual([120, 100, 20]);
        expect(ids(p1)[0]).toBe("chat-r000");
        expect(ids(p3)[0]).toBe("chat-r100");
        expect((await lire("/api/admin/runs?limit=50&offset=120")).corps.items).toEqual([]);
        // Appelant historique : sans offset, même contenu qu'avant (200 lignes au plus).
        expect((await lire("/api/admin/runs")).corps.items).toHaveLength(120);
      });

      it("le total suit les filtres (genre, statut, compte, période)", async () => {
        expect((await lire("/api/admin/runs?status=error&limit=5")).corps.total).toBe(12);
        expect((await lire("/api/admin/runs?kind=subagent")).corps.total).toBe(2);
        expect((await lire("/api/admin/runs?kind=subagent&hours=1")).corps.total).toBe(1);
        expect((await lire(`/api/admin/runs?user_id=${alice}`)).corps.total).toBe(60);
      });

      it("décalage borné à 0..100 000", async () => {
        expect((await lire("/api/admin/runs?offset=-5&limit=3")).corps.offset).toBe(0);
        const loin = (await lire("/api/admin/runs?offset=99999999&limit=3")).corps;
        expect([loin.offset, loin.items]).toEqual([100_000, []]);
      });

      it("recherche : compte, modèle, run_id, sans casse ; % et _ littéraux ; vide ignoré", async () => {
        expect((await lire("/api/admin/runs?q=ALICE")).corps.total).toBe(60);
        expect(ids((await lire("/api/admin/runs?q=r007")).corps)).toEqual(["chat-r007"]);
        expect(ids((await lire("/api/admin/runs?q=100%25")).corps)).toEqual(["chat-r005"]);
        expect(ids((await lire("/api/admin/runs?q=modele_1")).corps)).toEqual(["chat-r005"]);
        expect((await lire("/api/admin/runs?q=%25")).corps.total).toBe(1);
        expect((await lire("/api/admin/runs?q=%20%20")).corps.total).toBe(120);
        expect((await lire("/api/admin/runs?q='%20OR%201%3D1%20--")).corps.total).toBe(0);
        expect((await lire(`/api/admin/runs?q=${"a".repeat(5000)}`)).statut).toBe(200);
        expect((await lire("/api/admin/runs?q=r00&status=error")).corps.total).toBe(1);
      });

      it("filtre exact run_id : une seule exécution, y compris un sous-agent ; identifiant invalide refusé", async () => {
        expect(ids((await lire("/api/admin/runs?run_id=subagent-s1")).corps)).toEqual(["subagent-s1"]);
        expect(ids((await lire("/api/admin/runs?run_id=chat-r007&kind=routine")).corps)).toEqual([
          "chat-r007",
        ]);
        expect((await lire("/api/admin/runs?run_id=chat-r00")).corps.total).toBe(0);
        expect((await lire("/api/admin/runs?run_id=a%25b")).statut).toBe(400);
        expect((await lire("/api/admin/runs?run_id=chat")).statut).toBe(400);
      });

      it("run_id donné : la période ne le borne pas", async () => {
        const ancien = (await lire("/api/admin/runs?run_id=chat-ancien&hours=1")).corps;
        expect([ids(ancien), ancien.total]).toEqual([["chat-ancien"], 1]);
        expect((await lire("/api/admin/runs?hours=720&kind=chat&q=ancien")).corps.total).toBe(0);
      });

      it("le total de la liste de premier niveau lit l'index de période, sans jointure sans recherche", async () => {
        const f = { hours: 24, userId: null, kind: "", status: "", limit: 50 };
        const sans = requeteTotal(f, T0);
        expect(sans.sql).not.toContain("JOIN");
        expect(requeteTotal({ ...f, q: "ali" }, T0).sql).toContain("LEFT JOIN users");
        if (moteur === "sqlite") {
          const plan = await t.base.all(`EXPLAIN QUERY PLAN ${sans.sql}`, sans.params);
          expect(plan.map((l) => String(l["detail"])).join("\n")).toContain("idx_runs_started");
        }
      });

      it("départage : deux pages sur une colonne à égalités, sans recouvrement ni trou", async () => {
        const vus: unknown[] = [];
        for (const offset of [0, 50, 100])
          vus.push(
            ...ids((await lire(`/api/admin/runs?sort=status&dir=asc&limit=50&offset=${offset}`)).corps),
          );
        expect(vus).toHaveLength(120);
        expect(new Set(vus).size).toBe(120);
      });

      it("tri en liste blanche, sens asc ou desc, départage stable ; 400 sinon", async () => {
        const asc = (await lire("/api/admin/runs?sort=input_tokens&dir=asc&limit=3")).corps;
        expect(ids(asc)).toEqual(["chat-r119", "chat-r118", "chat-r117"]);
        const desc = (await lire("/api/admin/runs?sort=input_tokens&limit=2")).corps;
        expect(ids(desc)).toEqual(["chat-r000", "chat-r001"]);
        const parNom = (await lire("/api/admin/runs?sort=username&dir=asc&limit=1")).corps;
        expect(parNom.items[0]?.["username"]).toBe("admin");
        expect((await lire("/api/admin/runs?sort=duration&dir=desc&limit=1")).statut).toBe(200);
        const inconnue = await lire("/api/admin/runs?sort=password");
        expect(inconnue.statut).toBe(400);
        expect((await lire("/api/admin/runs?sort=started_at;DROP TABLE runs")).statut).toBe(400);
        expect((await lire("/api/admin/runs?dir=sideways")).statut).toBe(400);
        expect((await lire("/api/admin/runs?sort=kind&dir=asc")).statut).toBe(200);
      });
    });

    describe("erreurs d'outils", () => {
      const URL = "/api/admin/observability/tool-failures";

      it("total hors pagination (succès exclus) et pages successives", async () => {
        const p1 = (await lire(`${URL}?limit=50`)).corps;
        expect([p1.total, p1.offset, p1.limit, p1.items.length]).toEqual([130, 0, 50, 50]);
        const p3 = (await lire(`${URL}?limit=50&offset=100`)).corps;
        expect([p3.offset, p3.items.length]).toEqual([100, 30]);
        expect(p1.items[0]?.["duration_ms"]).toBe(0);
        expect(p3.items[0]?.["duration_ms"]).toBe(100);
      });

      it("filtres statut, outil et serveur ; le total les suit", async () => {
        expect((await lire(`${URL}?status=error`)).corps.total).toBe(44);
        expect((await lire(`${URL}?tool=shell`)).corps.total).toBe(65);
        expect((await lire(`${URL}?server=srv&status=timeout`)).corps.total).toBe(22);
        expect((await lire(`${URL}?tool=inconnu`)).corps.total).toBe(0);
        expect((await lire(`${URL}?status=success`)).statut).toBe(400);
      });

      it("recherche : outil, serveur, run_id, message ; % et _ littéraux", async () => {
        expect((await lire(`${URL}?q=SRV`)).corps.total).toBe(65);
        expect((await lire(`${URL}?q=read_f`)).corps.total).toBe(65);
        expect((await lire(`${URL}?q=chat-r005`)).corps.total).toBe(2);
        expect((await lire(`${URL}?q=100%25`)).corps.total).toBe(1);
        expect((await lire(`${URL}?q=nom_de`)).corps.total).toBe(1);
        expect((await lire(`${URL}?q=%25`)).corps.total).toBe(1);
        expect((await lire(`${URL}?q=_`)).corps.total).toBe(66);
        expect((await lire(`${URL}?q='%20OR%201%3D1%20--`)).corps.total).toBe(0);
      });

      it("recherche : casse pliée par le moteur des deux côtés (même casse trouvée partout)", async () => {
        expect((await lire(`${URL}?q=${encodeURIComponent("Échec")}`)).corps.total).toBe(1);
        // Sur SQLite, LOWER() ne plie que l'ASCII : « échec » ne trouve pas « Échec ». PostgreSQL le trouve selon sa locale.
        if (moteur === "sqlite")
          expect((await lire(`${URL}?q=${encodeURIComponent("échec")}`)).corps.total).toBe(0);
        expect((await lire(`${URL}?q=BOOM`)).corps.total).toBeGreaterThan(100);
      });

      it("départage : trois pages sur une colonne à égalités, sans recouvrement ni trou", async () => {
        const vus: string[] = [];
        for (const offset of [0, 50, 100])
          for (const i of (await lire(`${URL}?sort=status&limit=50&offset=${offset}`)).corps.items)
            vus.push(`${String(i["run_id"])}|${String(i["duration_ms"])}`);
        expect(vus).toHaveLength(130);
        expect(new Set(vus).size).toBe(130);
      });

      it("statut demandé : même résultat qu'avec le filtre « hors succès » seul", async () => {
        expect((await lire(`${URL}?status=timeout`)).corps.total).toBe(43);
      });

      it("tri en liste blanche ; 400 sur colonne ou sens inconnus ; décalage borné", async () => {
        const asc = (await lire(`${URL}?sort=duration_ms&dir=asc&limit=2`)).corps;
        expect(ids(asc, "duration_ms")).toEqual([0, 1]);
        const nom = (await lire(`${URL}?sort=tool_name&dir=asc&limit=1`)).corps;
        expect(nom.items[0]?.["tool_name"]).toBe("read_file");
        expect((await lire(`${URL}?sort=error_short`)).statut).toBe(400);
        expect((await lire(`${URL}?sort=ts&dir=up`)).statut).toBe(400);
        expect((await lire(`${URL}?offset=99999999&limit=2`)).corps).toMatchObject({
          offset: 100_000,
          items: [],
        });
      });
    });
  });
}
