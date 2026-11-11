// SPDX-License-Identifier: MIT
/** apps/core/test/robustesse.test.ts — gardes et traitements synchrones, routage, erreurs atypiques, arrêt, journal. */
import type { OutgoingHttpHeaders } from "node:http";

import { describe, expect, it } from "vitest";
import type { FastifyReply } from "fastify";

import { creerApp } from "../src/app";
import { CycleDeVie } from "../src/cycle";
import { Journal } from "../src/journal";
import type { DefinitionRoute, Famille } from "../src/routes";
import { appTest, journalMuet } from "./aides";
import { HttpError } from "@elpis/commun";
import { ENTETES_SECURITE, entetesFlux, PREPARATIONS_FLUX } from "@elpis/http";
import type { PreparationFlux } from "@elpis/http";

const route = (
  chemin: string,
  traiter: DefinitionRoute["traiter"],
  acces: DefinitionRoute["acces"] = "public",
) => ({
  methode: "GET" as const,
  chemin,
  processus: ["main"] as const,
  acces,
  traiter,
});

const famille: Famille = {
  nom: "essai",
  routes: [
    route("/garde-sync", () => ({ ok: true }), "session"),
    route("/vide-sync", () => undefined),
    route("/vide-async", async () => undefined),
    route("/f/:nom", (req) => ({ n: (req.params as { nom: string }).nom.length })),
    route("/nul", () => {
      throw null;
    }),
    route("/statut-600", () => {
      throw new HttpError(600, "x");
    }),
    route("/fuite", () => {
      throw Object.assign(new Error("connect ECONNREFUSED user=elpis password=secret"), { statusCode: 400 });
    }),
    route("/piece-jointe", (_req, rep: FastifyReply) => {
      void rep.header("content-disposition", "attachment; filename=x.txt");
      throw new HttpError(404, "absent");
    }),
  ],
};

describe("gardes et traitements", () => {
  it("une garde synchrone qui autorise laisse passer ; un traitement sans retour répond null", async () => {
    const app = await appTest({ familles: [famille], gardes: { session: () => undefined } });
    const garde = await app.inject({ method: "GET", url: "/garde-sync" });
    expect(garde.statusCode).toBe(200);
    for (const url of ["/vide-sync", "/vide-async"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(200);
      expect(r.body, url).toBe("null");
      expect(r.headers["content-type"], url).toContain("application/json");
    }
    await app.close();
  });

  it("la garde passe avant la lecture du corps", async () => {
    let appels = 0;
    const app = await appTest({
      limiteCorps: 1024,
      familles: [{ nom: "g", routes: [{ ...route("/p", () => "ok", "session"), methode: "POST" }] }],
      gardes: {
        session: () => {
          appels++;
          throw new HttpError(401, "Non connecté");
        },
      },
    });
    const r = await app.inject({
      method: "POST",
      url: "/p",
      payload: "x".repeat(4096),
      headers: { "content-type": "text/plain" },
    });
    expect([r.statusCode, appels]).toEqual([401, 1]);
    await app.close();
  });

  it("main refuse une route d'administration, sauf le canal interne", async () => {
    const admin: Famille = {
      nom: "a",
      routes: [{ ...route("/api/admin/users/reset", () => 1), processus: ["main", "admin"] }],
    };
    await expect(appTest({ familles: [admin] })).rejects.toThrow(/ne se monte pas dans main/);
    const interne: Famille = { nom: "i", routes: [route("/api/admin/internal/restart-self", () => 1)] };
    const app = await appTest({ familles: [interne] });
    expect(app.elpis.routes).toHaveLength(1);
    await app.close();
  });
});

describe("routage et erreurs atypiques", () => {
  it("paramètre de chemin long accepté ; URL mal encodée : 404 detail avec en-têtes", async () => {
    const app = await appTest({ familles: [famille], gardes: { session: () => undefined } });
    expect((await app.inject({ method: "GET", url: "/f/" + "a".repeat(300) })).json()).toEqual({ n: 300 });
    const mal = await app.inject({ method: "GET", url: "/%zz" });
    expect(mal.statusCode).toBe(404);
    expect(mal.json()).toEqual({ detail: "Not Found" });
    for (const [nom, valeur] of ENTETES_SECURITE) expect(mal.headers[nom]).toBe(valeur);
    await app.close();
  });

  it("throw null, statut hors bornes, message d'une erreur non Fastify : 500 texte sans fuite", async () => {
    const app = await appTest({ familles: [famille], gardes: { session: () => undefined } });
    for (const url of ["/nul", "/statut-600", "/fuite"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(500);
      expect(r.body, url).toBe("Internal Server Error");
    }
    await app.close();
  });

  it("une réponse d'erreur ne garde pas les en-têtes posés par la route", async () => {
    const app = await appTest({ familles: [famille], gardes: { session: () => undefined } });
    const r = await app.inject({ method: "GET", url: "/piece-jointe" });
    expect(r.statusCode).toBe(404);
    expect(r.headers["content-disposition"]).toBeUndefined();
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    await app.close();
  });

  it("pendant l'arrêt, les réponses ferment la connexion", async () => {
    let arret = false;
    const app = await creerApp({ mode: "main", journal: journalMuet, arretEnCours: () => arret });
    expect((await app.inject({ method: "GET", url: "/api/health" })).headers["connection"]).not.toBe("close");
    arret = true;
    expect((await app.inject({ method: "GET", url: "/api/health" })).headers["connection"]).toBe("close");
    await app.close();
  });

  it("entetesFlux fusionne la sécurité et les en-têtes de la réponse", async () => {
    let capture: OutgoingHttpHeaders = {};
    const app = await appTest({
      familles: [
        {
          nom: "flux",
          routes: [
            route("/flux", (_req, rep: FastifyReply) => {
              capture = entetesFlux(rep, { "content-type": "text/event-stream" });
              return "ok";
            }),
          ],
        },
      ],
    });
    await app.inject({ method: "GET", url: "/flux" });
    expect(capture["x-content-type-options"]).toBe("nosniff");
    expect(capture["content-type"]).toBe("text/event-stream");
    await app.close();
  });

  it("entetesFlux rejoue les préparations des extensions et garde les Set-Cookie multiples", async () => {
    let capture: OutgoingHttpHeaders = {};
    const app = await appTest({
      familles: [
        {
          nom: "flux",
          routes: [
            route("/flux", (_req, rep: FastifyReply) => {
              void rep.header("set-cookie", "a=1; path=/");
              capture = entetesFlux(rep);
              return "ok";
            }),
          ],
        },
      ],
    });
    app.getDecorator<PreparationFlux[]>(PREPARATIONS_FLUX).push((_r, rep) => {
      void rep.header("set-cookie", "b=2; path=/");
    });
    await app.inject({ method: "GET", url: "/flux" });
    expect(capture["set-cookie"]).toEqual(["a=1; path=/", "b=2; path=/"]);
    await app.close();
  });
});

describe("arrêt et journal", () => {
  it("les tâches de fond se terminent avant les actions d'arrêt ; une action bloquée est abandonnée", async () => {
    const ordre: string[] = [];
    const cycle = new CycleDeVie(journalMuet);
    cycle.suivre(
      "fond",
      new Promise<void>((fin) =>
        cycle.signalArret.addEventListener("abort", () => {
          ordre.push("fond");
          fin();
        }),
      ),
    );
    cycle.alArret("pool", () => ordre.push("pool"));
    cycle.alArret("bloquee", () => new Promise(() => {}));
    cycle.alArret("apres", () => ordre.push("apres"));
    await cycle.executerArrets(1_000, 50);
    expect(ordre).toEqual(["fond", "pool", "apres"]);
  });

  it("APP_LOG_LEVEL aux noms de Python ; un err qui n'est pas une Error reste visible", () => {
    const avant = process.env["APP_LOG_LEVEL"];
    process.env["APP_LOG_LEVEL"] = "WARNING";
    const lignes: string[] = [];
    const j = new Journal({ sortie: (l) => lignes.push(l) });
    j.info("caché");
    j.warn({ err: "texte" }, "visible");
    if (avant === undefined) delete process.env["APP_LOG_LEVEL"];
    else process.env["APP_LOG_LEVEL"] = avant;
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toContain('{"err":"texte"}');
    process.env["APP_LOG_LEVEL"] = "toString";
    expect(new Journal().level).toBe("info");
    if (avant === undefined) delete process.env["APP_LOG_LEVEL"];
    else process.env["APP_LOG_LEVEL"] = avant;
  });
});
