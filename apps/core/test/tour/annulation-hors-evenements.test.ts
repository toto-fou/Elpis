// SPDX-License-Identifier: MIT
/** apps/core/test/tour/annulation-hors-evenements.test.ts — invariant 6 : un Stop annule le tour par son AbortSignal, jamais par les événements système (diffusés à la console : un identifiant de conversation n'y passe pas). */
import { signerSession } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { CancelledError } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OptionsRun } from "../../src/boucle/orchestrateur";
import { installerTokenHex } from "../../src/boucle/ports";
import type { SortieRun } from "../../src/boucle/sortie";
import { composer } from "../../src/composition";
import { installerCrochetJournal } from "../../src/journal";
import { installerRelaisModeles } from "../../src/llm/cache-modeles";
import { installerDiffusion } from "../../src/llm/ports";
import { buildTaskBuiltinTool } from "../../src/outils/integres/task";
import { installerManifesteMcp } from "../../src/outils/ports";
import { registerChatTask, viderEtatPourTests } from "../../src/tour/etat";
import { appTest, journalMuet } from "../aides";

const T = 1_791_331_200;
const CHAT = "c0ffee00-1234-4abc-9def-0123456789ab";

let t: BaseDeTest;
let dep: DependancesAuth & DependancesJetons;
let restaurer: () => void = () => undefined;

beforeEach(async () => {
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  await t.base.run(
    "INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES ('alice', 's', 'h', 0)",
  );
  dep = {
    base: t.base,
    config: () => ({}),
    attributsCookie: () => ({
      cookie_name: "mcpwebui_session",
      same_site: "lax",
      https_only: false,
      max_age: 86400,
    }),
    secret: () => "secret-de-test",
    jetonService: () => "",
    maintenant: () => T,
  };
  process.env["ELPIS_TASK_RESUME_DIR"] = mkdtempSync(path.join(tmpdir(), "elpis-reprise-"));
  restaurer = surchargerConfig({
    LLAMA_URL: "http://127.0.0.1:1/v1/chat/completions",
    LLAMA_PROVIDER_TYPE: "llamacpp",
  });
});

afterEach(async () => {
  restaurer();
  installerTokenHex(null);
  installerManifesteMcp(null);
  rmSync(process.env["ELPIS_TASK_RESUME_DIR"]!, { recursive: true, force: true });
  delete process.env["ELPIS_TASK_RESUME_DIR"];
  viderEtatPourTests();
  installerCrochetJournal(null);
  installerDiffusion(null);
  installerRelaisModeles(null);
  await t.fermer();
});

describe("invariant 6 : aucune annulation par les événements système", () => {
  it("Stop et arrêt d'un sous-agent : chacun s'arrête par son signal ; sur le bus système, des journaux seulement, sans l'identifiant", async () => {
    const c = await composer("main", t.base, journalMuet, dep);
    const app = await appTest({ ...c, mode: "main" });
    const bus = c.evenements.systemEvents;
    const vus: unknown[] = [];
    const [fanout, broadcast, noter] = [
      bus.fanout.bind(bus),
      bus.broadcast.bind(bus),
      bus.noterLigneJournal.bind(bus),
    ];
    bus.fanout = (message, donnees) => (vus.push(message), fanout(message, donnees));
    bus.broadcast = (message, options) => (vus.push(message), broadcast(message, options));
    bus.noterLigneJournal = (level, message, date) => (
      vus.push({ type: "log", level, message }),
      noter(level, message, date)
    );
    try {
      const tour = new AbortController();
      registerChatTask(1, tour, CHAT);
      installerManifesteMcp({ defaultOnCategories: () => [] });
      installerTokenHex((n) => "ab".repeat(n));
      const etapes: Record<string, unknown>[] = [];
      const runner = (o: OptionsRun): Promise<SortieRun> =>
        new Promise((_ok, ko) =>
          o.signal!.addEventListener("abort", () => ko(o.signal!.reason), { once: true }),
        );
      const enfant = buildTaskBuiltinTool({
        username: "alice",
        chatId: CHAT,
        model: "m",
        samplingOverride: null,
        isCancelled: null,
        onEvent: (e) => void etapes.push(e),
        runner,
      })["task"]!.handler({ subagent_type: "explore", prompt: "x" }) as Promise<string>;
      for (let i = 0; i < 100 && !etapes.some((e) => e["child_id"]); i++)
        await new Promise((r) => setTimeout(r, 5));
      const childId = String(etapes.find((e) => e["child_id"])?.["child_id"]);

      const cookie = `mcpwebui_session=${signerSession({ user_id: 1, _login_ts: T - 10 }, "secret-de-test", T)}`;
      const arret = await app.inject({
        method: "POST",
        url: "/api/chat/task-cancel",
        headers: { cookie },
        payload: { child_id: childId },
      });
      expect(arret.json()).toEqual({ status: "cancelled", active: true });
      expect(JSON.parse(await enfant)).toMatchObject({ error: "task_cancelled" });
      const stop = await app.inject({
        method: "POST",
        url: "/api/chat/cancel",
        headers: { cookie },
        payload: { chat_id: CHAT },
      });
      expect(stop.json()).toEqual({ status: "cancelled" });
      expect(tour.signal.reason).toBeInstanceOf(CancelledError);

      const historique = bus.getRecentLogs().map((l) => ({ type: "log", message: l.message }));
      const tout = [...vus, ...historique];
      expect(tout.some((m) => JSON.stringify(m).includes("[chat_cancel]"))).toBe(true);
      expect(tout.filter((m) => JSON.stringify(m).includes(CHAT))).toEqual([]);
      expect(vus.filter((m) => (m as { type?: unknown }).type !== "log")).toEqual([]);
    } finally {
      bus.fanout = fanout;
      bus.broadcast = broadcast;
      bus.noterLigneJournal = noter;
      await app.close();
    }
  });
});
