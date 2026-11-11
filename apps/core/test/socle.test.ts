// SPDX-License-Identifier: MIT
/** apps/core/test/socle.test.ts — mode, montage par process, en-têtes de sécurité, cycle de vie, journal, écoute. */
import { describe, expect, it } from "vitest";

import { creerApp } from "../src/app";
import { CycleDeVie } from "../src/cycle";
import { adresseEcoute } from "../src/ecoute";
import { installerCrochetJournal, Journal } from "../src/journal";
import { resoudreModeApp } from "../src/mode";
import type { Famille } from "../src/routes";
import { appTest, journalMuet } from "./aides";
import { HttpError } from "@elpis/commun";
import { corpsLu, ENTETES_SECURITE } from "@elpis/http";
import type { FastifyRequest } from "fastify";

const famille: Famille = {
  nom: "essai",
  routes: [
    {
      methode: "GET",
      chemin: "/api/commun",
      processus: ["main", "admin"],
      acces: "public",
      traiter: () => ({ ok: 1 }),
    },
    {
      methode: "GET",
      chemin: "/api/admin/x",
      processus: ["admin"],
      acces: "admin",
      traiter: () => ({ ok: 2 }),
    },
    {
      methode: "GET",
      chemin: "/api/chat/x",
      processus: ["main"],
      acces: "session",
      traiter: () => ({ ok: 3 }),
    },
    {
      methode: "GET",
      chemin: "/apercu",
      processus: ["main"],
      acces: "public",
      traiter: (_req, rep) => rep.header("content-security-policy", "sandbox").send("ok"),
    },
  ],
};

const refuser = () => {
  throw new HttpError(401, "Non connecté");
};

describe("mode du process", () => {
  it("absent ou invalide ⇒ main ; full non porté ⇒ main avec avertissement", () => {
    const lignes: string[] = [];
    const j = new Journal({ sortie: (l) => lignes.push(l) });
    expect(resoudreModeApp(undefined)).toBe("main");
    expect(resoudreModeApp(" ADMIN ")).toBe("admin");
    expect(resoudreModeApp("full", j)).toBe("main");
    expect(resoudreModeApp("x", j)).toBe("main");
    expect(lignes).toHaveLength(2);
  });
});

describe("montage selon le process", () => {
  it("aucune route d'administration dans main", async () => {
    const app = await appTest({ familles: [famille], gardes: { session: refuser, admin: refuser } });
    expect(app.elpis.routes.map((r) => r.chemin)).toEqual(["/api/commun", "/api/chat/x", "/apercu"]);
    expect((await app.inject({ method: "GET", url: "/api/admin/x" })).statusCode).toBe(404);
    await app.close();
  });

  it("admin ne monte que ses routes et les routes partagées", async () => {
    const app = await creerApp({
      mode: "admin",
      familles: [famille],
      gardes: { admin: refuser },
      journal: journalMuet,
    });
    expect(app.elpis.routes.map((r) => r.chemin)).toEqual(["/api/commun", "/api/admin/x"]);
    await app.close();
  });

  it("refuse une route dont la garde manque", async () => {
    await expect(appTest({ familles: [famille] })).rejects.toThrow(/garde « session » absente/);
  });

  it("la garde s'exécute avant la route", async () => {
    const app = await appTest({ familles: [famille], gardes: { session: refuser, admin: refuser } });
    const r = await app.inject({ method: "GET", url: "/api/chat/x" });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ detail: "Non connecté" });
    await app.close();
  });
});

describe("corps propre à une route", () => {
  it("limite (413), contrôle avant toute lecture, corps ignoré ; limite listée sur la route montée", async () => {
    const avant: string[] = [];
    const lu = (req: FastifyRequest) => ({ octets: corpsLu(req).length });
    const app = await appTest({
      familles: [
        {
          nom: "corps",
          routes: [
            {
              methode: "POST",
              chemin: "/api/borne",
              processus: ["main"],
              acces: "public",
              corps: { limite: 16 },
              traiter: lu,
            },
            {
              methode: "POST",
              chemin: "/api/garde",
              processus: ["main"],
              acces: "public",
              corps: {
                limite: 4,
                avant: (req) => {
                  avant.push(req.url);
                  refuser();
                },
              },
              traiter: lu,
            },
            {
              methode: "POST",
              chemin: "/api/ignore",
              processus: ["main"],
              acces: "public",
              corps: { limite: 0, avant: () => false },
              traiter: lu,
            },
          ],
        },
      ],
    });
    const poster = (url: string, payload: string) =>
      app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload });
    expect((await poster("/api/borne", '"0123456789"')).json()).toEqual({ octets: 12 });
    const trop = await poster("/api/borne", '"0123456789abcdef"');
    expect([trop.statusCode, trop.json()]).toEqual([413, { detail: "Corps trop volumineux." }]);
    const garde = await poster("/api/garde", '"0123456789"');
    expect([garde.statusCode, avant]).toEqual([401, ["/api/garde"]]);
    expect((await poster("/api/ignore", '{"a": 1}')).json()).toEqual({ octets: 0 });
    expect(
      Object.fromEntries(
        app.elpis.routes.filter((r) => r.famille === "corps").map((r) => [r.chemin, r.corps]),
      ),
    ).toEqual({ "/api/borne": 16, "/api/garde": 4, "/api/ignore": 0 });
    await app.close();
  });
});

describe("en-têtes de sécurité", () => {
  it("sur une réponse, un 404 et une erreur ; une route garde les siens", async () => {
    const app = await appTest({ familles: [famille], gardes: { session: refuser, admin: refuser } });
    for (const url of ["/api/commun", "/nulle-part", "/api/chat/x"]) {
      const r = await app.inject({ method: "GET", url });
      for (const [nom, valeur] of ENTETES_SECURITE) expect(r.headers[nom], `${url} ${nom}`).toBe(valeur);
    }
    const apercu = await app.inject({ method: "GET", url: "/apercu" });
    expect(apercu.headers["content-security-policy"]).toBe("sandbox");
    await app.close();
  });

  it("/api/health répond ok", async () => {
    const app = await creerApp({ mode: "admin", journal: journalMuet });
    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toEqual({ status: "ok" });
    await app.close();
  });
});

describe("cycle de vie", () => {
  it("ordre, modes, échec toléré, arrière-plan, arrêt", async () => {
    const ordre: string[] = [];
    const cycle = new CycleDeVie(journalMuet);
    cycle.auDemarrage("a", () => ordre.push("a"));
    cycle.auDemarrage("echec", () => {
      throw new Error("x");
    });
    cycle.auDemarrage("admin-seul", () => ordre.push("admin"), { modes: ["admin"] });
    cycle.auDemarrage("fond", async () => ordre.push("fond"), { arrierePlan: true });
    cycle.auDemarrage("b", () => ordre.push("b"));
    cycle.alArret("z1", () => ordre.push("z1"));
    cycle.alArret("z2", () => ordre.push("z2"));
    await cycle.demarrer("main");
    expect(cycle.arretEnCours).toBe(false);
    await cycle.executerArrets();
    expect(cycle.signalArret.aborted).toBe(true);
    expect(ordre).toEqual(["a", "b", "fond", "z1", "z2"]);
  });

  it("n'attend pas indéfiniment une tâche de fond bloquée", async () => {
    const cycle = new CycleDeVie(journalMuet);
    cycle.suivre("bloquee", new Promise(() => {}));
    const debut = Date.now();
    await cycle.executerArrets(50);
    expect(Date.now() - debut).toBeLessThan(2_000);
  });
});

describe("journal et écoute", () => {
  it("préfixe [domaine], niveau minimal, pile de l'erreur", () => {
    const lignes: string[] = [];
    const j = new Journal({ niveau: "info", sortie: (l) => lignes.push(l) }).child({ domaine: "chat" });
    j.debug("caché");
    j.info({ uid: 3 }, "tour lancé");
    j.error({ err: new Error("boum") }, "échec");
    expect(lignes).toHaveLength(2);
    expect(lignes[0]).toMatch(/ INFO \[chat\] tour lancé \{"uid":3\}$/);
    expect(lignes[1]).toContain("ERROR [chat] échec\n    Error: boum");
  });

  it("crochet du process : chaque ligne écrite y passe (niveau Python, message sans horodatage, même date) ; en échec, la ligne reste écrite", () => {
    const lignes: string[] = [];
    const copies: [string, string, Date][] = [];
    const j = new Journal({ niveau: "info", sortie: (l) => lignes.push(l) }).child({ domaine: "llm" });
    try {
      installerCrochetJournal((niveau, message, date) => void copies.push([niveau, message, date]));
      j.debug("caché");
      j.warn({ n: 2 }, "lent");
      j.fatal({ err: new Error("boum") }, "arrêt");
      expect(copies.map(([n, m]) => [n, m.split("\n")[0]])).toEqual([
        ["WARNING", '[llm] lent {"n":2}'],
        ["CRITICAL", "[llm] arrêt"],
      ]);
      expect(copies[1]?.[1]).toContain("\n    Error: boum");
      expect(lignes[0]).toBe(`${copies[0]?.[2].toISOString()} WARNING [llm] lent {"n":2}`);
      installerCrochetJournal(() => {
        throw new Error("crochet en panne");
      });
      j.error("toujours écrit");
      expect(lignes.at(-1)).toMatch(/ ERROR \[llm\] toujours écrit$/);
      installerCrochetJournal(null);
      j.info("sans copie");
      expect(copies).toHaveLength(2);
    } finally {
      installerCrochetJournal(null);
    }
  });

  it("BIND et ports par défaut", () => {
    expect(adresseEcoute(undefined, "main")).toEqual({ hote: "127.0.0.1", port: 8001 });
    expect(adresseEcoute("", "admin")).toEqual({ hote: "127.0.0.1", port: 8002 });
    expect(adresseEcoute("0.0.0.0:9001", "main")).toEqual({ hote: "0.0.0.0", port: 9001 });
    expect(adresseEcoute("[::1]:8001", "main")).toEqual({ hote: "::1", port: 8001 });
    expect(() => adresseEcoute("x:99999", "main")).toThrow(/BIND invalide/);
  });
});
