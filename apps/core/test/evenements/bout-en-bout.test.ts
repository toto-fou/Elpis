// SPDX-License-Identifier: MIT
/** apps/core/test/evenements/bout-en-bout.test.ts — main et admin composés comme en production, en HTTP réel : sonde de main lancée par l'abonnement de l'admin ; un `model_status` et un `[LLM]…` émis par main arrivent au flux staff des deux process, une seule fois chacun. */
import "../llm/environnement-fournisseurs";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { signerSession } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { composer, serviceDuProcess } from "../../src/composition";
import type { Composition } from "../../src/composition";
import { CycleDeVie } from "../../src/cycle";
import { installerCrochetJournal } from "../../src/journal";
import { invalidateCache as oublierAcces } from "../../src/llm/acces-moteurs";
import {
  arreterSondeModeles,
  installerRelaisModeles,
  modelCache,
  viderCacheModeles,
} from "../../src/llm/cache-modeles";
import { closeLlmClient } from "../../src/llm/client-http";
import { invalidate as oublierCaps } from "../../src/llm/fournisseurs/llama-capacites";
import { viderInventaires } from "../../src/llm/fournisseurs/llama-modeles";
import { closeAdminClient } from "../../src/llm/llama-http";
import { invalidateAllModelCaches } from "../../src/llm/modeles";
import { installerOrdonnanceur } from "../../src/llm/ordonnanceur/process";
import { installerDiffusion } from "../../src/llm/ports";
import { loadedModelCache } from "../../src/llm/sante";
import { installerPublicationNotifications, pousserNotification } from "../../src/notifications/envoi";
import { appTest, journalMuet } from "../aides";
import { fauxLlama, portFerme } from "../llm/faux-serveur";
import type { FauxServeur } from "../llm/faux-serveur";
import { attendreQue, ouvrirFlux } from "./aides";
import type { FluxBrut } from "./aides";

type Dict = Record<string, unknown>;

const SECRET = "secret-de-test";
const ADMIN = 1;
const PROPS_ROUTEUR = {
  build_info: "b10545-abc",
  role: "router",
  default_generation_settings: { n_ctx: 8192 },
  total_slots: 1,
};

function inventaire(mCharge: boolean): Dict {
  return {
    data: [
      { id: "golden-model", status: { value: "loaded" } },
      { id: "m", status: { value: mCharge ? "loaded" : "unloaded" } },
    ],
  };
}

/** Caches du moteur et ordonnanceur remis à neuf, comme dans un process qui démarre. */
function moteurANeuf(): void {
  arreterSondeModeles();
  viderCacheModeles();
  oublierCaps();
  viderInventaires();
  invalidateAllModelCaches();
  loadedModelCache.id = null;
  loadedModelCache.ts = 0;
  installerOrdonnanceur(null);
  oublierAcces();
}

/** Trames `data:` d'un flux SSE, décodées. */
function trames(flux: FluxBrut): Dict[] {
  return flux
    .texte()
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as Dict);
}

function etatsModeles(flux: FluxBrut): Dict[] {
  return trames(flux).filter((t) => t["type"] === "model_status");
}

function journaux(flux: FluxBrut): string[] {
  return trames(flux)
    .filter((t) => t["type"] === "log")
    .map((t) => String(t["message"]));
}

function adresse(app: FastifyInstance): string {
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

const ENV = ["ELPIS_AUDIT_DIR", "ELPIS_ENGINE_ACCESS_DIR", "MAIN_INTERNAL_URL"] as const;

describe("bus d'événements composé (main et admin)", () => {
  let dossier: string;
  let t: BaseDeTest;
  let llama: FauxServeur;
  let restaurer: () => void;
  const envAvant: Partial<Record<(typeof ENV)[number], string>> = {};

  beforeEach(async () => {
    dossier = mkdtempSync(path.join(tmpdir(), "elpis-bus-bout-en-bout-"));
    for (const nom of ENV) if (process.env[nom] !== undefined) envAvant[nom] = process.env[nom];
    process.env["ELPIS_AUDIT_DIR"] = path.join(dossier, "audit");
    process.env["ELPIS_ENGINE_ACCESS_DIR"] = path.join(dossier, "acces");
    oublierConfigurationAudit();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await t.base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES ('admin', 's', 'h', 0, 1)",
    );
    llama = await fauxLlama({ props: PROPS_ROUTEUR, modeles: inventaire(false) });
    llama.route("POST /models/load", (_req: unknown, rep: ServerResponse) => {
      llama.json("GET /v1/models", inventaire(true));
      rep.writeHead(200, { "content-type": "application/json" });
      rep.end(JSON.stringify({ success: true }));
    });
    const configJson = path.join(dossier, "config.json");
    writeFileSync(configJson, JSON.stringify({ llm: { scheduling_mode: "classic" } }));
    restaurer = surchargerConfig({
      LLAMA_URL: `${llama.url}/v1/chat/completions`,
      LLAMA_PROVIDER_TYPE: "llamacpp",
      LLAMA_MODEL: "golden-model",
      LLAMA_MAX_MODELS: 1,
      LLAMA_MAX_CONCURRENCY: 1,
      LLM_SCHEDULING_MODE: "classic",
      CONFIG_JSON_PATH: configJson,
    });
    invalidateConfigCache();
    moteurANeuf();
  });

  afterEach(async () => {
    moteurANeuf();
    installerDiffusion(null);
    installerRelaisModeles(null);
    installerCrochetJournal(null);
    restaurer();
    await closeLlmClient();
    await closeAdminClient();
    await llama.arreter();
    await t.fermer();
    for (const nom of ENV) {
      if (envAvant[nom] === undefined) delete process.env[nom];
      else process.env[nom] = envAvant[nom];
    }
    oublierConfigurationAudit();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("un model_status et un [LLM]… émis par main : flux staff de main, et de l'admin par le canal interne et le journal commun ; un changement, un seul model_status ; la sonde de main part avec l'abonnement de l'admin", async () => {
    const dep: DependancesAuth & DependancesJetons = {
      base: t.base,
      config: () => ({}),
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax",
        https_only: false,
        max_age: 86400,
      }),
      secret: () => SECRET,
      jetonService: () => "",
    };
    const portMain = await portFerme();
    process.env["MAIN_INTERNAL_URL"] = `http://127.0.0.1:${portMain}`;
    const cycleAdmin = new CycleDeVie(journalMuet);
    const cycleMain = new CycleDeVie(journalMuet);
    const admin: Composition = await composer("admin", t.base, journalMuet, dep, dossier, {
      cycle: cycleAdmin,
    });
    const main: Composition = await composer("main", t.base, journalMuet, dep, dossier, { cycle: cycleMain });
    const appAdmin = await appTest({ ...admin, mode: "admin" });
    const appMain = await appTest(main);
    const flux: FluxBrut[] = [];
    const canal = main.evenements.canal;
    const toutRelaye = (): Promise<void> =>
      attendreQue(
        () => canal !== undefined && admin.evenements.abonnement?.dernierId === canal.id(canal.dernierSeq),
        5_000,
        "canal relu par l'admin",
      );
    try {
      await appMain.listen({ host: "127.0.0.1", port: portMain });
      await appAdmin.listen({ host: "127.0.0.1", port: 0 });
      await cycleMain.demarrer("main");
      await cycleAdmin.demarrer("admin");
      await attendreQue(() => admin.evenements.abonnement?.connecte === true, 5_000, "canal interne");
      await attendreQue(() => Array.isArray(modelCache["models"]), 5_000, "sonde de main");
      await toutRelaye();

      const maintenant = Math.floor(Date.now() / 1000);
      const cookie = `mcpwebui_session=${signerSession({ user_id: ADMIN, _login_ts: maintenant - 10 }, SECRET, maintenant)}`;
      const [fluxMain, fluxAdmin] = [
        await ouvrirFlux(`${adresse(appMain)}/api/system-events?logs=1`, { cookie }),
        await ouvrirFlux(`${adresse(appAdmin)}/api/system-events?logs=1`, { cookie }),
      ] as const;
      flux.push(fluxMain, fluxAdmin);
      expect([fluxMain.statut, fluxAdmin.statut]).toEqual([200, 200]);
      await attendreQue(
        () =>
          main.evenements.suiviJournal?.positionne === true &&
          admin.evenements.suiviJournal?.positionne === true,
        5_000,
        "suivi du journal commun",
      );

      const charge = await appMain.inject({
        method: "POST",
        url: "/api/llm/models/load",
        headers: { cookie },
        payload: { model_path: "m" },
      });
      expect(charge.json()).toMatchObject({ ok: true });
      const attendus = [
        `[${serviceDuProcess("main")}/app] [LLM] Chargement modèle: m (par admin)`,
        `[${serviceDuProcess("main")}/app] [LLM] Modèle chargé: m`,
      ];
      main.evenements.systemEvents.broadcast({ type: "model_changed", data: { sentinelle: 1 } });
      for (const f of [fluxMain, fluxAdmin]) {
        await attendreQue(
          () => trames(f).some((x) => x["type"] === "model_changed"),
          5_000,
          "sentinelle après le model_status",
        );
        await attendreQue(
          () => attendus.every((m) => journaux(f).includes(m)),
          5_000,
          "[LLM] du journal commun",
        );
      }
      for (const f of [fluxMain, fluxAdmin]) {
        expect(etatsModeles(f)).toEqual([
          {
            type: "model_status",
            data: expect.objectContaining({
              models: ["golden-model", "m"],
              models_loaded: [{ id: "golden-model" }, { id: "m" }],
              server_reachable: true,
            }),
          },
        ]);
        expect(journaux(f).filter((m) => m.includes("[LLM]"))).toEqual(attendus);
      }
      expect(trames(fluxAdmin).find((x) => x["type"] === "log")).toMatchObject({
        service: serviceDuProcess("main"),
        category: "app",
      });
    } finally {
      for (const f of flux) f.fermer();
      cycleAdmin.annoncerArret();
      cycleMain.annoncerArret();
      await appAdmin.close();
      await appMain.close();
      await cycleAdmin.executerArrets();
      await cycleMain.executerArrets();
    }
  });

  it("notification créée par l'admin : poussée par le canal interne aux flux de main de son seul destinataire", async () => {
    for (const nom of ["alice", "bob"])
      await t.base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES (?, 's', 'h', 0, 0)",
        [nom],
      );
    const [alice, bob] = [2, 3];
    const dep: DependancesAuth & DependancesJetons = {
      base: t.base,
      config: () => ({}),
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax",
        https_only: false,
        max_age: 86400,
      }),
      secret: () => SECRET,
      jetonService: () => "",
    };
    const portMain = await portFerme();
    process.env["MAIN_INTERNAL_URL"] = `http://127.0.0.1:${portMain}`;
    const cycleAdmin = new CycleDeVie(journalMuet);
    const cycleMain = new CycleDeVie(journalMuet);
    const main: Composition = await composer("main", t.base, journalMuet, dep, dossier, { cycle: cycleMain });
    const admin: Composition = await composer("admin", t.base, journalMuet, dep, dossier, {
      cycle: cycleAdmin,
    });
    const appAdmin = await appTest({ ...admin, mode: "admin" });
    const appMain = await appTest(main);
    const flux: FluxBrut[] = [];
    try {
      await appMain.listen({ host: "127.0.0.1", port: portMain });
      await appAdmin.listen({ host: "127.0.0.1", port: 0 });
      await cycleMain.demarrer("main");
      await cycleAdmin.demarrer("admin");
      await attendreQue(() => admin.evenements.abonnement?.connecte === true, 5_000, "canal interne");
      const maintenant = Math.floor(Date.now() / 1000);
      const cookie = (uid: number): Record<string, string> => ({
        cookie: `mcpwebui_session=${signerSession({ user_id: uid, _login_ts: maintenant - 10 }, SECRET, maintenant)}`,
      });
      const [fAlice, fBob, fAdmin, fAliceAdmin] = [
        await ouvrirFlux(`${adresse(appMain)}/api/system-events?logs=1`, cookie(alice)),
        await ouvrirFlux(`${adresse(appMain)}/api/system-events?logs=1`, cookie(bob)),
        await ouvrirFlux(`${adresse(appMain)}/api/system-events?logs=1`, cookie(ADMIN)),
        await ouvrirFlux(`${adresse(appAdmin)}/api/system-events?logs=1`, cookie(alice)),
      ] as const;
      flux.push(fAlice, fBob, fAdmin, fAliceAdmin);
      await attendreQue(() => main.evenements.systemEvents.nombreClients === 3, 5_000, "flux de main");
      installerPublicationNotifications((m) => void admin.evenements.diffuserPartout(m));
      const nid = await pousserNotification(t.base, alice, "daily_report", "Rapport quotidien", {
        body: "Résumé",
      });
      expect(nid).not.toBeNull();
      const notifications = (f: FluxBrut): Dict[] => trames(f).filter((x) => x["type"] === "notification");
      for (const f of [fAlice, fAliceAdmin])
        await attendreQue(() => notifications(f).length === 1, 5_000, "notification du destinataire");
      expect(notifications(fAlice)).toEqual([
        {
          type: "notification",
          data: {
            user_id: alice,
            id: nid,
            kind: "daily_report",
            title: "Rapport quotidien",
            body: "Résumé",
            ref_type: "",
            ref_id: null,
            unread: 1,
          },
        },
      ]);
      main.evenements.systemEvents.broadcast({ type: "model_changed", data: { sentinelle: 1 } });
      for (const f of [fBob, fAdmin])
        await attendreQue(() => trames(f).some((x) => x["type"] === "model_changed"), 5_000, "sentinelle");
      expect([notifications(fBob), notifications(fAdmin), notifications(fAliceAdmin).length]).toEqual([
        [],
        [],
        1,
      ]);
    } finally {
      installerPublicationNotifications(null);
      for (const f of flux) f.fermer();
      cycleAdmin.annoncerArret();
      cycleMain.annoncerArret();
      await appAdmin.close();
      await appMain.close();
      await cycleAdmin.executerArrets();
      await cycleMain.executerArrets();
    }
  });
});
