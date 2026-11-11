// SPDX-License-Identifier: MIT
/** apps/core/test/tour/goldens-flux-route.test.ts — rejoue les goldens `flux_route_outils_*` (route de chat, chemin outils) comme tests/chatbot/flux_route_harness.py : file, garde d'ordonnancement, boucle et titre simulés, base réelle. */
import "../moteur-environnement";

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeUserSettings } from "@elpis/auth";
import { CancelledError, copieProfondePy, estDict, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { brancherGardeUrl } from "@elpis/mcp";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deleteChat, getChat, upsertChat } from "../../src/chats/stockage";
import { creerFamilleChat, ouvrirTour } from "../../src/familles/chat";
import { LLMQueueAborted } from "../../src/llm/ordonnanceur";
import { viderAdmissionPourTests } from "../../src/tour/admission";
import { getActiveChatTask, markChatCancelled, verrousChat, viderEtatPourTests } from "../../src/tour/etat";
import { reglerExecutionPourTests, runTurn } from "../../src/tour/execution";
import { reglerJournalPourTests } from "../../src/tour/journal-run";
import { appTest } from "../aides";

const DOSSIER = new URL("../../../../tests/goldens/", import.meta.url);
const NOMS = readdirSync(DOSSIER)
  .filter((n) => n.startsWith("flux_route_outils") && n.endsWith(".json"))
  .map((n) => n.slice(0, -5))
  .sort();

const JETONS = ["content_token", "thinking_token"];
const MESSAGE_VALEURS = ["role", "content", "thinking", "isTruncated", "toolLoopTruncated", "cancelled"];
const FINAL_VALEURS = [
  "assistant",
  "chat_id",
  "thinking",
  "title",
  "truncated",
  "truncated_in_think",
  "tool_limit_reached",
  "cancelled",
  "persisted",
  "persist_error",
  "plan_mode_done",
];

const trie = (d: Dict): string[] => Object.keys(d).sort();

function normMessages(messages: unknown): Dict[] {
  return (Array.isArray(messages) ? messages : []).map((m: Dict) => {
    const n: Dict = { cles: trie(m) };
    for (const k of MESSAGE_VALEURS) if (k in m) n[k] = m[k];
    return n;
  });
}

/** Sans `ping`, jetons consécutifs d'un même type fusionnés, `final` réduit à sa forme, sans `n` ni `ts`. */
function norm(events: Dict[]): Dict[] {
  const out: Dict[] = [];
  for (const e of events) {
    const t = e["type"] as string;
    if (t === "ping") continue;
    const dernier = out.at(-1);
    if (JETONS.includes(t) && dernier && dernier["type"] === t) {
      dernier["text"] = (dernier["text"] as string) + String(e["text"] ?? "");
      continue;
    }
    if (t === "final") {
      const f: Dict = { type: t, cles: trie(e) };
      for (const k of FINAL_VALEURS) if (k in e) f[k] = e[k];
      f["run_ids"] = Array.isArray(e["run_ids"]) ? e["run_ids"].length : 0;
      f["metrics"] = estDict(e["metrics"]) ? trie(e["metrics"]) : (e["metrics"] ?? null);
      out.push(f);
    } else if (JETONS.includes(t)) out.push({ type: t, text: e["text"] ?? "" });
    else out.push(Object.fromEntries(Object.entries(e).filter(([k]) => k !== "n" && k !== "ts")));
  }
  return out;
}

let t: BaseDeTest;
let app: FastifyInstance;
let dossier = "";

beforeAll(async () => {
  brancherGardeUrl(async () => null);
});

afterAll(() => {
  brancherGardeUrl(null);
});

beforeEach(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-flux-route-"));
  chmodSync(dossier, 0o700);
  reglerJournalPourTests({ dossier: join(dossier, "runs"), balayage: false });
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  await t.base.run(
    "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES('alice', 's', 'h', 0, 0)",
  );
  app = await appTest({
    familles: [creerFamilleChat({ base: t.base })],
    gardes: {
      session: async (req) => {
        req.utilisateur = { id: 1, username: "alice" };
      },
    },
  });
});

afterEach(async () => {
  await app.close();
  await t.fermer();
  reglerExecutionPourTests(null);
  reglerJournalPourTests(null);
  viderEtatPourTests();
  viderAdmissionPourTests();
  rmSync(dossier, { recursive: true, force: true });
});

const base = async (chatId: string): Promise<Dict[] | null> => {
  const chat = await getChat(t.base, 1, chatId);
  return chat === null ? null : normMessages(chat["messages"]);
};

interface Rejeu {
  evenements: Dict[];
  sorties: Dict;
}

/** Base, réglages du compte, file, fenêtre, garde, boucle et titre simulés comme le harnais Python. */
async function preparer(entrees: Dict, pendant: () => Promise<void>): Promise<{ enAttente: { v: boolean } }> {
  if (entrees["reglages_compte"])
    await mergeUserSettings(t.base, 1, (r) => void Object.assign(r, entrees["reglages_compte"]));
  for (const c of entrees["base"] as Dict[])
    await upsertChat(
      t.base,
      1,
      c["chat_id"] as string,
      c["titre"] as string,
      c["messages"],
      c["horodatage"] as number,
    );
  const m = entrees["moteur"] as Dict;
  const enAttente = { v: false };
  reglerExecutionPourTests({
    etatFile: async () => ({ ...(entrees["file"] as Dict) }),
    contexteModele: async () => entrees["n_ctx"] as number,
    admission: async (o, fn) => {
      await o.onWait(0.25);
      if (entrees["stop_en_file"]) {
        enAttente.v = true;
        while (!o.cancelProbe() && !o.signal.aborted) await new Promise((ok) => setTimeout(ok, 50));
        throw new LLMQueueAborted("attente du modèle interrompue à votre demande");
      }
      if (entrees["abandon_file"]) throw new LLMQueueAborted("attente du modèle interrompue à votre demande");
      return fn(null);
    },
    boucle: async (o) => {
      let attendre = true;
      for (const ev of m["evenements"] as Dict[]) {
        await o.onEvent!(copieProfondePy(ev));
        if (attendre && ev["type"] === "content_token") {
          attendre = false;
          await Promise.race([
            pendant(),
            new Promise<never>((_, ko) => {
              const s = o.signal!;
              if (s.aborted) ko(s.reason);
              s.addEventListener("abort", () => ko(s.reason), { once: true });
            }),
          ]);
        }
      }
      if ("panne" in m) throw Object.assign(new Error(m["panne"] as string), { name: "RuntimeError" });
      return [m["final"] as string, [], copieProfondePy(m["metrics"] as Dict)];
    },
    titre: async () => ("titre" in m ? (m["titre"] as string) : null),
  });
  return { enAttente };
}

async function finDuRun(chatId: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (getActiveChatTask(1, chatId) === null && !verrousChat.isHeld("gen", 1, chatId)) return;
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error("le run ne s'est pas terminé");
}

/** Stop ou départ du navigateur après le premier jeton de réponse ; Stop pendant l'attente d'un créneau. */
async function piloter(entrees: Dict): Promise<Rejeu> {
  let feuVert: () => void = () => undefined;
  const feu = new Promise<void>((ok) => (feuVert = ok));
  const prep = await preparer(entrees, () => feu);
  const requete = entrees["requete"] as Dict;
  const chatId = requete["chat_id"] as string;
  const tour = await ouvrirTour({ base: t.base }, 1, copieProfondePy(requete));
  const client = new AbortController();
  const it = runTurn({ base: t.base }, tour.plan, tour.res, tour.base, client.signal)[Symbol.asyncIterator]();
  const events: Dict[] = [];
  const lireJusqua = async (arret: (e: Dict) => boolean): Promise<void> => {
    for (;;) {
      const r = await it.next();
      if (r.done) throw new Error(`flux fini trop tôt : ${JSON.stringify(events)}`);
      events.push(pyJsonLoads(pyJsonDumps(r.value)) as Dict);
      if (arret(r.value)) return;
    }
  };
  const lireTout = async (): Promise<void> => {
    for (;;) {
      const r = await it.next();
      if (r.done) return;
      events.push(pyJsonLoads(pyJsonDumps(r.value)) as Dict);
    }
  };
  if (entrees["stop_en_file"]) {
    await lireJusqua((e) => e["type"] === "queue_status" && "waited_ms" in e);
    expect(prep.enAttente.v, "flux sans attente de créneau").toBe(true);
    markChatCancelled(1, chatId);
    if (entrees["stop_en_file"] === "ce_worker")
      getActiveChatTask(1, chatId)?.abort(new CancelledError("chat cancelled"));
    await lireTout();
    await finDuRun(chatId);
    return { evenements: events, sorties: { evenements: norm(events), base_apres: await base(chatId) } };
  }
  await lireJusqua((e) => e["type"] === "content_token");
  const tache = getActiveChatTask(1, chatId);
  expect(tache).not.toBeNull();
  if (entrees["pendant"] === "stop") {
    markChatCancelled(1, chatId);
    tache!.abort(new CancelledError("chat cancelled"));
    await lireTout();
    await finDuRun(chatId);
    return { evenements: events, sorties: { evenements: norm(events), base_apres: await base(chatId) } };
  }
  client.abort();
  await it.return!(undefined);
  expect(getActiveChatTask(1, chatId), "run arrêté au lieu d'être détaché").not.toBeNull();
  feuVert();
  await finDuRun(chatId);
  return {
    evenements: events,
    sorties: { evenements_avant_depart: norm(events), base_apres: await base(chatId) },
  };
}

async function rejouer(entrees: Dict): Promise<Rejeu> {
  const pendant = entrees["pendant"];
  if (entrees["stop_en_file"] || pendant === "stop" || pendant === "deconnexion") return piloter(entrees);
  const requete = entrees["requete"] as Dict;
  const chatId = requete["chat_id"] as string;
  const sorties: Dict = {};
  await preparer(entrees, async () => {
    if (pendant === "releve_base") {
      if (!("base_pendant_generation" in sorties)) sorties["base_pendant_generation"] = await base(chatId);
    } else if (estDict(pendant)) {
      const c = pendant["ecriture_concurrente"] as Dict;
      await upsertChat(
        t.base,
        1,
        c["chat_id"] as string,
        c["titre"] as string,
        c["messages"],
        Date.now() / 1000 + (c["decalage_s"] as number),
      );
    }
  });
  const r = await app.inject({
    method: "POST",
    url: "/api/chat-saved-stream3",
    headers: { "content-type": "application/json" },
    payload: pyJsonDumps(requete),
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.headers["content-type"]).toBe("application/x-ndjson; charset=utf-8");
  const events = r.body
    .split("\n")
    .filter(Boolean)
    .map((l) => pyJsonLoads(l) as Dict);
  Object.assign(sorties, { evenements: norm(events), base_apres: await base(chatId) });
  return { evenements: events, sorties };
}

async function rejouerGolden(nom: string): Promise<Rejeu> {
  const texte = readFileSync(new URL(`${nom}.json`, DOSSIER), "utf-8");
  const entrees = (pyJsonLoads(texte) as { entrees: Dict }).entrees;
  const rejeu = await rejouer(copieProfondePy(entrees));
  const canon =
    pyJsonDumps({ entrees, ...rejeu.sorties }, { ensureAscii: false, indent: 2, sortKeys: true }) + "\n";
  expect(canon, `dérive vs golden « ${nom} »`).toBe(texte);
  return rejeu;
}

const types = (events: Dict[]): string[] => norm(events).map((e) => e["type"] as string);

describe("goldens flux_route_outils_* (route de chat, chemin outils)", () => {
  it("douze goldens présents (chemin outils, E23)", () => {
    expect(NOMS).toHaveLength(12);
  });

  it.each(NOMS)("%s", async (nom) => {
    await rejouerGolden(nom);
  });

  it("outils : queue_cleared avant les outils, outils avant le final", async () => {
    const tt = types((await rejouerGolden("flux_route_outils")).evenements);
    expect(tt.indexOf("queue_cleared")).toBeLessThan(tt.indexOf("tool_call"));
    expect(tt.indexOf("tool_call")).toBeLessThan(tt.indexOf("final"));
  });

  it("chat neuf : le titre du modèle part dans le final", async () => {
    const f = (await rejouerGolden("flux_route_outils_titre")).sorties["evenements"] as Dict[];
    expect(f.at(-1)).toMatchObject({ type: "final", persisted: true, title: "Titre du modèle" });
  });

  it("reprenable : la question est en base pendant la génération, le final passe sans conflit", async () => {
    const r = await rejouerGolden("flux_route_outils_reprenable");
    expect((r.sorties["base_pendant_generation"] as Dict[]).at(-1)).toEqual({
      cles: ["content", "role"],
      role: "user",
      content: "q1",
    });
    const f = (r.sorties["evenements"] as Dict[]).at(-1)!;
    expect(f["persisted"]).toBe(true);
    expect("persist_error" in f).toBe(false);
  });

  it("panne : error puis final partiel", async () => {
    expect(types((await rejouerGolden("flux_route_outils_panne")).evenements).slice(-2)).toEqual([
      "error",
      "final",
    ]);
  });

  it("abandon de la file : queue_cleared puis final", async () => {
    const tt = types((await rejouerGolden("flux_route_outils_stop_file")).evenements);
    expect(tt.includes("error")).toBe(false);
    expect(tt.slice(-2)).toEqual(["queue_cleared", "final"]);
  });

  it("conflit : rien n'est écrasé, le final le signale", async () => {
    const r = await rejouerGolden("flux_route_outils_conflit");
    expect((r.sorties["evenements"] as Dict[]).at(-1)!["persisted"]).toBe(false);
    expect((r.sorties["base_apres"] as Dict[]).at(-1)!["content"]).toBe("autre réponse");
  });

  it.each(["flux_route_outils_stop_file_ce_worker", "flux_route_outils_stop_file_autre_worker"])(
    "Stop en file (%s) : aucun queue_cleared, final annulé",
    async (nom) => {
      const r = await rejouerGolden(nom);
      const tt = types(r.evenements);
      expect(tt.includes("queue_cleared")).toBe(false);
      expect(tt.at(-1)).toBe("final");
      expect((r.sorties["evenements"] as Dict[]).at(-1)!["cancelled"]).toBe(true);
    },
  );

  it.each(["flux_route_outils_detache", "flux_route_outils_detache_outil"])(
    "déconnexion (%s) : run détaché, réponse complète en base",
    async (nom) => {
      const apres = (await rejouerGolden(nom)).sorties["base_apres"] as Dict[];
      expect(apres.at(-1)!["content"]).toBe("Bonjour.");
      expect("isTruncated" in apres.at(-1)!).toBe(false);
    },
  );
});

describe("conversation supprimée pendant le tour", () => {
  it.each([false, true])("reprenable=%s : le tour fini ne recrée pas la conversation", async (resumable) => {
    const texte = readFileSync(new URL("flux_route_outils_reprenable.json", DOSSIER), "utf-8");
    const entrees = (pyJsonLoads(texte) as { entrees: Dict }).entrees;
    (entrees["requete"] as Dict)["resumable"] = resumable;
    await preparer(entrees, async () => void (await deleteChat(t.base, 1, "c2")));
    const r = await app.inject({
      method: "POST",
      url: "/api/chat-saved-stream3",
      headers: { "content-type": "application/json" },
      payload: pyJsonDumps(entrees["requete"]),
    });
    const fin = r.body
      .split("\n")
      .filter(Boolean)
      .map((l) => pyJsonLoads(l) as Dict)
      .at(-1)!;
    expect(fin).toMatchObject({ type: "final", persisted: false });
    expect(await getChat(t.base, 1, "c2")).toBeNull();
  });
});
