// SPDX-License-Identifier: MIT
/** apps/core/test/bureau/agent-lan.test.ts — agent bureau hors vecteurs : rejeu borné des seules lectures, délais, mémos dHash, stabilisation, suivi de la matrice, accès par compte, jetons jamais journalisés. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { pyJsonDumps } from "@elpis/commun";
import { invalidateConfigCache, reloadDesktopConfigFromDisk, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  actCore,
  agentReq,
  ATTENTE_AGENT,
  b64decodeStrict,
  fermerAgentsBureau,
  HORLOGE_AUTOMATISATION,
  installerComptesBureau,
  installerHorlogeRejeu,
  installerPrimitivesBureau,
  invalidateA11yMemo,
  lookupActionAnchor,
  memoPut,
  observeCore,
  PRIMITIVES_AGENT,
  pruneActionCache,
  recordActionAnchor,
  REGLAGES_ANCRES,
  REGLAGES_BUREAU,
  reinitialiserMemosBureau,
  resolveTarget,
  resolveTargetStrict,
  runAutomationCore,
  targetAllowed,
} from "../../src/bureau";
import type { Cible } from "../../src/bureau";
import { installerCrochetJournal } from "../../src/journal";
import { FauxLan } from "../faux-lan";
import type { ReponseScriptee } from "../faux-lan";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const shot = (): ReponseScriptee => ({
  statut: 200,
  json: { ok: true, image: PNG_1x1, width: 40, height: 30 },
});
const ok = (champs: Record<string, unknown> = {}): ReponseScriptee => ({
  statut: 200,
  json: { ok: true, ...champs },
});

describe("agent bureau : transport, mémos, stabilisation, matrice", () => {
  let lan: FauxLan;
  let dossier: string;
  let cible: Cible;
  const restaurer: (() => void)[] = [];
  const pauses: number[] = [];
  const dormirAvant = ATTENTE_AGENT.dormir;
  const ttlAvant = { ...REGLAGES_BUREAU };

  beforeAll(async () => {
    lan = await FauxLan.demarrer();
    dossier = mkdtempSync(path.join(tmpdir(), "elpis-agent-lan-"));
    process.env["DESKTOP_SCREENS_DIR"] = path.join(dossier, "ecrans");
    process.env["DESKTOP_ACTIVE_PATH"] = path.join(dossier, "actif.json");
    writeFileSync(
      path.join(dossier, "config.json"),
      pyJsonDumps({
        desktop: {
          targets: [
            { name: "vm1", agent_url: `${lan.url}/a`, default: true },
            { name: "liste", agent_url: `${lan.url}/l`, access: "list", allowed_users: ["carol"] },
          ],
        },
      }),
    );
    restaurer.push(
      surchargerConfig({ CONFIG_JSON_PATH: path.join(dossier, "config.json"), VISION_ENDPOINT_URL: "" }),
    );
    invalidateConfigCache();
    reloadDesktopConfigFromDisk(true);
    cible = {
      name: "vm1",
      os: "linux",
      agent_url: `${lan.url}/a`,
      agent_token: "",
      default: true,
      access: "all",
      allowed_users: [],
    };
    installerPrimitivesBureau(PRIMITIVES_AGENT);
    ATTENTE_AGENT.dormir = async (ms) => void pauses.push(ms);
  });

  afterAll(async () => {
    ATTENTE_AGENT.dormir = dormirAvant;
    Object.assign(REGLAGES_BUREAU, ttlAvant);
    installerPrimitivesBureau(null);
    installerComptesBureau(null);
    installerHorlogeRejeu(null);
    await fermerAgentsBureau();
    await lan.arreter();
    for (const r of restaurer.reverse()) r();
    delete process.env["DESKTOP_SCREENS_DIR"];
    delete process.env["DESKTOP_ACTIVE_PATH"];
    rmSync(dossier, { recursive: true, force: true });
  });

  beforeEach(() => {
    lan.reponses = [];
    lan.vues.length = 0;
    pauses.length = 0;
    reinitialiserMemosBureau();
  });

  it("une lecture coupée est rejouée une fois (300 ms), une action jamais", async () => {
    lan.reponses = [{ statut: 200, coupe: true }, ok({ image: "x" })];
    expect(await agentReq(cible, "/screenshot", {})).toEqual({ ok: true, image: "x" });
    expect(pauses).toEqual([300]);
    lan.reponses = [{ statut: 200, coupe: true }, ok()];
    const r = await agentReq(cible, "/click", { x: 1, y: 1 });
    expect(r).toMatchObject({ ok: false, error: "agent_unreachable", retryable: true });
    expect(lan.vues.map((v) => v.p)).toEqual(["/a/screenshot", "/a/screenshot", "/a/click"]);
    expect(lan.reponses).toHaveLength(1);
  });

  it("délai de lecture : `/ui_tree` rejoué, `/wait_window` jamais (l'attente aurait doublé) ; échéance transmise", async () => {
    // minuteries d'undici à ~0,5 s près : un délai court mais une réponse franchement plus lente
    lan.reponses = [
      { statut: 200, json: {}, delaiMs: 2500 },
      { statut: 200, json: {}, delaiMs: 2500 },
    ];
    const r = await agentReq(cible, "/ui_tree", {}, "POST", 0.2);
    expect(r).toMatchObject({
      error: "agent_timeout",
      message: "control-agent for 'vm1' timed out after 0.2s",
    });
    expect(lan.vues.map((v) => [v.p, v.to])).toEqual([
      ["/a/ui_tree", "0.2"],
      ["/a/ui_tree", "0.2"],
    ]);
    lan.vues.length = 0;
    lan.reponses = [{ statut: 200, json: {}, delaiMs: 2500 }];
    expect(await agentReq(cible, "/wait_window", {}, "POST", 0.2)).toMatchObject({ error: "agent_timeout" });
    expect(lan.vues).toHaveLength(1);
  }, 15_000);

  it("accès par machine : `list` = administrateurs et comptes permis ; identité inconnue refusée ; panne du compte = refus", async () => {
    const liste: Cible = { ...cible, name: "liste", access: "list", allowed_users: ["carol"] };
    installerComptesBureau({ estAdmin: async (nom) => nom === "alice" });
    expect(await targetAllowed(liste, "carol")).toBe(true);
    expect(await targetAllowed(liste, "alice")).toBe(true);
    expect(await targetAllowed(liste, "bob")).toBe(false);
    expect(await targetAllowed(liste, "  ")).toBe(false);
    expect(await targetAllowed(cible, "")).toBe(true);
    installerComptesBureau({
      estAdmin: async () => {
        throw new Error("base");
      },
    });
    expect(await targetAllowed(liste, "alice")).toBe(false);
    expect((await resolveTarget("liste", "bob"))?.name).toBe("vm1");
    expect(await resolveTargetStrict("liste", "bob")).toBeNull();
    installerComptesBureau(null);
  });

  it("mémos : plafond (les plus vieux sortent), purge des expirés, invalidation de toutes les portées d'une cible", async () => {
    const d = new Map<string, { sig: string; ts: number }>();
    const t = Date.now() / 1000;
    for (let i = 0; i < 5; i++) memoPut(d, `k${i}`, { sig: "", ts: t - 100 + i }, 0, 3);
    expect([...d.keys()]).toEqual(["k2", "k3", "k4"]);
    memoPut(d, "neuf", { sig: "", ts: t }, 1, 3);
    expect([...d.keys()]).toEqual(["neuf"]);
    REGLAGES_BUREAU.a11yMemoTtlS = 3600;
    lan.reponses = [shot(), ok({ elements: [] }), shot(), shot(), ok({ elements: [] })];
    await observeCore("alice", "vm1", { use_vision: false });
    await observeCore("alice", "vm1", { use_vision: false });
    invalidateA11yMemo("vm1");
    await observeCore("alice", "vm1", { use_vision: false });
    expect(lan.vues.map((v) => v.p)).toEqual([
      "/a/screenshot",
      "/a/ui_tree",
      "/a/screenshot",
      "/a/screenshot",
      "/a/ui_tree",
    ]);
    REGLAGES_BUREAU.a11yMemoTtlS = 0.01;
    reinitialiserMemosBureau();
    lan.vues.length = 0;
    lan.reponses = [shot(), ok({ elements: [] }), shot(), ok({ elements: [] })];
    await observeCore("alice", "vm1", { use_vision: false });
    await new Promise((fin) => setTimeout(fin, 30));
    await observeCore("alice", "vm1", { use_vision: false });
    expect(lan.vues.map((v) => v.p)).toEqual(["/a/screenshot", "/a/ui_tree", "/a/screenshot", "/a/ui_tree"]);
  });

  it("stabilisation après action : bornée, rend la main dès que l'écran est figé (horloge simulée)", async () => {
    let t = 0;
    installerHorlogeRejeu({ monotone: () => t, dormir: async (s) => void (t += s) });
    lan.reponses = [ok(), shot(), shot(), shot(), shot(), shot()];
    const r = await actCore("alice", "vm1", { op: "key", keys: "a", settle_ms: 1000, observe_after: false });
    expect(r["settle_ms"]).toBe(400);
    expect(lan.vues.map((v) => v.p)).toEqual(["/a/key", "/a/screenshot", "/a/screenshot", "/a/screenshot"]);
    installerHorlogeRejeu(null);
  });

  it("matrice : sondage tant que le script tourne, recul exponentiel borné sur erreurs, suivi perdu après 8 échecs, échéance", async () => {
    const horlogeAvant = { ...HORLOGE_AUTOMATISATION };
    let t = 0;
    const sommes: number[] = [];
    Object.assign(HORLOGE_AUTOMATISATION, {
      maintenant: () => t,
      dormir: async (s: number) => {
        sommes.push(s);
        t += s;
      },
    });
    try {
      lan.reponses = [
        ok(),
        ok({ run_id: "r" }),
        ok({ running: true }),
        ok({ running: true }),
        ok({ running: false, code: 0 }),
      ];
      let doc = await runAutomationCore("alice", ["vm1"], "x", "code");
      expect(sommes).toEqual([1.5, 1.5]);
      expect(doc["ok_count"]).toBe(1);
      sommes.length = 0;
      lan.reponses = [
        ok(),
        ok({ run_id: "r" }),
        ...Array.from({ length: 8 }, () => ({ statut: 500, json: {} })),
        ok(),
      ];
      doc = await runAutomationCore("alice", ["vm1"], "x", "code");
      expect(sommes).toEqual([1.5, 3, 6, 12, 15, 15, 15]);
      expect((doc["results"] as Record<string, unknown>[])[0]).toMatchObject({
        error: "status_lost",
        ok: false,
      });
      expect(lan.vues.at(-1)?.p).toBe("/a/run_stop");
      sommes.length = 0;
      lan.reponses = [ok(), ok({ run_id: "r" }), ok({ running: true }), ok()];
      HORLOGE_AUTOMATISATION.dormir = async (s: number) => void (t += s * 1000);
      doc = await runAutomationCore("alice", ["vm1"], "x", "code", { timeout_s: 30 });
      expect((doc["results"] as Record<string, unknown>[])[0]).toMatchObject({
        error: "timeout",
        summary: "exécution interrompue après 30 s",
      });
    } finally {
      Object.assign(HORLOGE_AUTOMATISATION, horlogeAvant);
    }
  });

  it("aucun jeton de vision dans le journal : il ne part que vers l'agent qui lance le script", async () => {
    const lignes: string[] = [];
    installerCrochetJournal((_n, m) => void lignes.push(m));
    try {
      lan.reponses = [ok(), { statut: 500, json: { detail: "panne" } }];
      const jeton = "evt_" + "s".repeat(40);
      const doc = await runAutomationCore("alice", ["vm1", "absente"], "x", "code", {
        elpis_url: "http://elpis.lan",
        elpis_token: jeton,
      });
      expect(JSON.stringify(doc)).not.toContain("evt_");
      expect(lignes.join("\n")).not.toContain("evt_");
      expect(Buffer.from(lan.vues[1]?.corps ?? "", "base64").toString()).toContain(jeton);
    } finally {
      installerCrochetJournal(null);
    }
  });

  it("base64 strict : linéaire sur une image de plusieurs Mo", () => {
    const gros = Buffer.alloc(12 * 1024 * 1024, 7).toString("base64");
    expect(b64decodeStrict(gros)).toHaveLength(12 * 1024 * 1024);
    expect(() => b64decodeStrict(gros + "\n")).toThrow();
  });
});

describe("mémoire des ancres (editor_action_cache)", () => {
  const bases = ["sqlite", ...(process.env["ELPIS_TEST_PG"] ? ["postgres"] : [])] as const;
  afterEach(() => void (REGLAGES_ANCRES.ttlS = 30 * 86400));

  for (const moteur of bases)
    it(`épingle, relit, vieillit et purge (${moteur})`, async () => {
      const t = ouvrirBaseDeTest(moteur as "sqlite");
      try {
        await initialiserBase(t.base);
        await recordActionAnchor(t.base, "alice::vm1", " Enregistrer ", "saveBtn", "button", [10.9, "20"]);
        expect(await lookupActionAnchor(t.base, "alice::vm1", "ENREGISTRER")).toEqual({
          auto_id: "saveBtn",
          role: "button",
          center: [10, 20],
        });
        await recordActionAnchor(t.base, "alice::vm1", "Enregistrer", "save2", "", ["x", 1]);
        expect(await lookupActionAnchor(t.base, "alice::vm1", "enregistrer")).toEqual({
          auto_id: "save2",
          role: "",
          center: null,
        });
        await recordActionAnchor(t.base, "alice::vm1", "vide", "  ");
        await recordActionAnchor(t.base, "alice::vm1", "  ", "id");
        expect(await lookupActionAnchor(t.base, "alice::vm1", "vide")).toBeNull();
        expect(await lookupActionAnchor(t.base, "bob::vm1", "enregistrer")).toBeNull();
        for (let i = 0; i < 12; i++) await recordActionAnchor(t.base, "alice::vm1", `q${i}`, `id${i}`);
        expect(await pruneActionCache(t.base, 10, 8)).toBe(5);
        REGLAGES_ANCRES.ttlS = 0.001;
        await new Promise((fin) => setTimeout(fin, 20));
        expect(await lookupActionAnchor(t.base, "alice::vm1", "q11")).toBeNull();
        expect(await pruneActionCache(t.base)).toBe(8);
      } finally {
        await t.fermer();
      }
    });
});
