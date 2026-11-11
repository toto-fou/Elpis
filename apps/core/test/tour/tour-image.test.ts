// SPDX-License-Identifier: MIT
/** apps/core/test/tour/tour-image.test.ts — tour « Images » et outil `generate_image` rejoués contre la vraie app FastAPI (vecteurs : pré-vol, flux, chat persisté, soumissions au moteur, exécution, plafonds de l'outil) ; client parti, pings, journal reprenable et outil dans un tour du modèle. */
import "../moteur-environnement";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dependancesParDefaut, mergeUserSettings } from "@elpis/auth";
import { pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getChat, upsertChat } from "../../src/chats/stockage";
import { buildStateSystemMessage } from "../../src/contexte/etat-compression";
import { getRun, installerBaseExecutions } from "../../src/executions/registre";
import { creerFamilleChat, ouvrirTour } from "../../src/familles/chat";
import { creerFamilleChatControle } from "../../src/familles/chat-controle";
import { getImageConfig } from "../../src/images/config";
import { getImage } from "../../src/images/magasin";
import { installerAppelEnrichissement } from "../../src/images/ports";
import { forgetCapabilities } from "../../src/images/service";
import { brancherLlm } from "../../src/llm/branchement";
import { buildImageBuiltinTool, tailleOutil } from "../../src/outils/integres/image";
import { currentUsageCtx } from "../../src/observabilite/usage-contexte";
import type { UsageContext } from "../../src/observabilite/usage-contexte";
import type { OutilIntegre } from "../../src/outils/catalogue";
import { viderAdmissionPourTests } from "../../src/tour/admission";
import { verrousChat, viderEtatPourTests } from "../../src/tour/etat";
import { reglerExecutionPourTests, runTurn } from "../../src/tour/execution";
import { reglerTourImagePourTests, sourceFromMessage } from "../../src/tour/image";
import { currentRun, reglerJournalPourTests } from "../../src/tour/journal-run";
import { appTest } from "../aides";
import { FauxMoteur } from "../images/faux-moteur";
import { portFerme } from "../llm/faux-serveur";

type Scenario = {
  nom: string;
  uid?: number;
  config?: Dict;
  avant?: unknown[][];
  etats?: Dict[];
  stop?: number;
  panne?: boolean;
  enrichi?: string | null;
  pendant?: [string, Dict[]];
  corps: Dict;
};
type Cas = { nom: string; config?: Dict; prefs?: Dict; appels: unknown[] };

const V = pyJsonLoads(readFileSync(new URL("../vecteurs/tour-image.json", import.meta.url), "utf-8"), {
  mode: "natif",
}) as {
  entrees: {
    scenarios: Scenario[];
    outil: Cas[];
    tailles: [Dict, string, number][];
    sources: unknown[];
    etat_compaction: string;
  };
  sorties: {
    png: string;
    source: string;
    scenarios: Dict[];
    outil: Dict[];
    tailles: string[];
    sources: (Dict | null)[];
  };
};

const HEX32 = /[0-9a-f]{32}/gu;
const RUN = /image-[0-9a-f]{16}/gu;
const CHAT = /^[0-9a-f]{24}$/u;

/** Même normalisation que le générateur : ids d'images numérotés à la première vue, exécutions, graines tirées, durées. */
function normaliser(v: unknown, vus: Map<string, number>): unknown {
  if (Array.isArray(v)) return v.map((x) => normaliser(x, vus));
  if (v !== null && typeof v === "object") {
    const out: Dict = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "duration_s") continue;
      if (k === "elapsed_s" || k === "eta_s") out[k] = "<t>";
      else if (k === "seed" && Number.isInteger(x) && (x as number) >= 1000) out[k] = "<seed>";
      else if (k === "init_image" && typeof x === "string") out[k] = "<image>";
      else out[k] = normaliser(x, vus);
    }
    return out;
  }
  if (typeof v === "string") {
    const s = v.replace(RUN, "<run>").replace(HEX32, (m) => {
      if (!vus.has(m)) vus.set(m, vus.size + 1);
      return `<img${vus.get(m)}>`;
    });
    return CHAT.test(s) ? "<chat>" : s;
  }
  return v;
}

const fil = (x: unknown): unknown => pyJsonLoads(JSON.stringify(x), { mode: "natif" });

let t: BaseDeTest;
let app: FastifyInstance;
let sd: FauxMoteur;
let dossier: string;
let restaurer: () => void;
let portMort = 0;
const etat = {
  etats: [] as Dict[],
  stop: null as number | null,
  sondages: 0,
  chat: "",
  demande: null as unknown,
  pendant: null as [string, Dict[]] | null,
};
const enrichi = { sortie: null as string | null, contexte: null as UsageContext | null };
let url = "";

function ecrireConfig(bloc: Dict): void {
  writeFileSync(
    join(dossier, "config.json"),
    JSON.stringify({ image: { enabled: true, url, provider: "sdcpp", max_n: 4, ...bloc } }),
    "utf-8",
  );
  invalidateConfigCache();
  forgetCapabilities();
}

const repondre = (rep: ServerResponse, statut: number, corps: unknown): void => {
  rep.writeHead(statut, { "content-type": "application/json" });
  rep.end(JSON.stringify(corps));
};

const soumissions = (): unknown[] =>
  sd.sur("/sdcpp/v1/img_gen").map((r) => pyJsonLoads(r.corps.toString("utf-8"), { mode: "natif" }));

beforeAll(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-tour-image-"));
  restaurer = surchargerConfig({
    DB_PATH: join(dossier, "user_db", "app.db"),
    CONFIG_JSON_PATH: join(dossier, "config.json"),
  });
  reglerJournalPourTests({ dossier: join(dossier, "runs"), balayage: false });
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  brancherLlm(t.base);
  installerBaseExecutions(t.base);
  for (const [nom, admin] of [
    ["alice", 0],
    ["bob", 0],
    ["carol", 1],
  ] as const)
    await t.base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES(?,?,?,?,?)",
      [nom, "s", "h", 0, admin],
    );
  await mergeUserSettings(t.base, 2, (r) => void (r["image_enabled"] = false));
  installerAppelEnrichissement(async () => {
    enrichi.contexte = currentUsageCtx();
    if (enrichi.sortie === null) throw new Error("modèle éteint");
    return enrichi.sortie;
  });
  portMort = await portFerme();
  sd = await FauxMoteur.demarrer();
  url = sd.url;
  sd.route("GET /sdcpp/v1/capabilities", (_r, rep) =>
    repondre(rep, 200, {
      model: { name: "qwen-image" },
      current_mode: "img_gen",
      limits: { max_batch_count: 8 },
    }),
  );
  sd.route("POST /sdcpp/v1/img_gen", (_r, rep) => repondre(rep, 202, { id: "job1", status: "queued" }));
  sd.route("POST /sdcpp/v1/jobs/job1/cancel", (_r, rep) => repondre(rep, 200, {}));
  sd.route("GET /sdcpp/v1/jobs/job1", async (_r, rep) => {
    etat.sondages += 1;
    etat.demande ??= currentRun(1, etat.chat)?.["image_request"] ?? null;
    if (etat.pendant && etat.sondages === 1)
      await upsertChat(t.base, 1, etat.chat, etat.pendant[0], etat.pendant[1], Date.now() / 1000);
    if (etat.stop === etat.sondages)
      await app.inject({
        method: "POST",
        url: "/api/chat/cancel",
        headers: { "x-uid": "1", "content-type": "application/json" },
        payload: JSON.stringify({ chat_id: etat.chat }),
      });
    const e = etat.etats.shift();
    if (e) repondre(rep, 200, e["started"] === "{maintenant}" ? { ...e, started: Date.now() / 1000 } : e);
    else repondre(rep, 200, { status: "completed", result: { images: [{ b64_json: V.sorties.png }] } });
  });
  app = await appTest({
    familles: [
      creerFamilleChat({ base: t.base, dormir: async () => undefined }),
      creerFamilleChatControle({ base: t.base, auth: dependancesParDefaut(t.base) }),
    ],
    gardes: {
      session: async (req) => {
        req.utilisateur = { id: Number(req.headers["x-uid"] ?? 1), username: "x" };
        Object.assign(req, { session: { get: () => undefined } });
      },
    },
  });
});

afterAll(async () => {
  await app.close();
  await sd.arreter();
  installerAppelEnrichissement(null);
  installerBaseExecutions(null);
  reglerJournalPourTests(null);
  reglerExecutionPourTests(null);
  reglerTourImagePourTests(null);
  viderEtatPourTests();
  viderAdmissionPourTests();
  await t.fermer();
  restaurer();
  invalidateConfigCache();
  forgetCapabilities();
  rmSync(dossier, { recursive: true, force: true });
});

function remplacer(v: unknown, idsPar: Map<string, string[]>, chatMsgs: unknown[]): unknown {
  if (v === "{source}") return V.sorties.source;
  if (typeof v === "string") {
    let s = v;
    for (const [nom, ids] of idsPar) s = s.replaceAll(`{img:${nom}}`, ids[0] ?? "");
    return s;
  }
  if (Array.isArray(v))
    return v.flatMap((x) => (x === "{chat}" ? chatMsgs : [remplacer(x, idsPar, chatMsgs)]));
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remplacer(x, idsPar, chatMsgs)]));
  return v;
}

function releveIds(v: unknown, ids: string[]): string[] {
  if (Array.isArray(v)) for (const x of v) releveIds(x, ids);
  else if (v !== null && typeof v === "object") {
    const id = (v as Dict)["id"];
    if (typeof id === "string" && /^[0-9a-f]{32}$/u.test(id) && !ids.includes(id)) ids.push(id);
    for (const x of Object.values(v)) releveIds(x, ids);
  }
  return ids;
}

/** Lignes du magasin : conversation, description, modèle et paramètres rangés de chaque image. */
async function lignes(uid: number, ids: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const id of ids) {
    const r = await getImage(t.base, uid, id);
    out.push(
      r === null
        ? null
        : [r["chat_id"], r["prompt"], r["model"], pyJsonLoads(String(r["params_json"]), { mode: "natif" })],
    );
  }
  return out;
}

async function attendre<T>(lire: () => Promise<T>, fini: (x: T) => boolean): Promise<T> {
  let x = await lire();
  for (let i = 0; i < 200 && !fini(x); i++) {
    await new Promise((ok) => setTimeout(ok, 10));
    x = await lire();
  }
  return x;
}

async function jouer(sc: Scenario, idsPar: Map<string, string[]>): Promise<Dict> {
  url = sc.panne ? `http://127.0.0.1:${portMort}` : sd.url;
  ecrireConfig(sc.config ?? {});
  sd.requetes.length = 0;
  Object.assign(etat, {
    etats: (sc.etats ?? []).map((e) => ({ ...e })),
    sondages: 0,
    stop: sc.stop ?? null,
    demande: null,
    pendant: sc.pendant ?? null,
  });
  enrichi.sortie = sc.enrichi ?? null;
  const uid = sc.uid ?? 1;
  const jetons = [];
  for (const a of sc.avant ?? []) {
    if (a[0] === "verrou") jetons.push(verrousChat.acquire("gen", uid, a[1] as string));
    else if (a[0] === "compression") jetons.push(verrousChat.acquire("compact", uid, a[1] as string));
    else if (a[0] === "chat") {
      let msgs = a[3] as Dict[];
      if (a.length > 4)
        msgs = [buildStateSystemMessage(V.entrees.etat_compaction, a[4] as number, 2, 2, ""), ...msgs];
      await upsertChat(t.base, uid, a[1] as string, a[2] as string, msgs, 100.0);
    }
  }
  const cid0 = sc.corps["chat_id"] as string;
  const existant = cid0 && cid0.length < 192 ? await getChat(t.base, uid, cid0) : null;
  const corps = remplacer(sc.corps, idsPar, (existant?.["messages"] as unknown[]) ?? []) as Dict;
  etat.chat = corps["chat_id"] as string;
  const r = await app.inject({
    method: "POST",
    url: "/api/chat-saved-stream3",
    headers: { "x-uid": String(uid), "content-type": "application/json" },
    payload: JSON.stringify(corps),
  });
  for (const j of jetons) verrousChat.release(j);
  const evenements =
    r.statusCode === 200
      ? r.body
          .split("\n")
          .filter((l) => l)
          .map((l) => pyJsonLoads(l, { mode: "natif" }) as Dict)
      : null;
  const fin = evenements?.at(-1);
  const cid = (corps["chat_id"] as string) || ((fin?.["chat_id"] as string | undefined) ?? "");
  let run: unknown[] | null = null;
  const runIds = fin?.["run_ids"] as string[] | undefined;
  if (runIds?.length) {
    const row = await attendre(
      () => getRun(t.base, runIds[0]!),
      (x) => x !== null && x["status"] !== "running",
    );
    run = row ? [row["kind"], row["status"], row["error_kind"] || "", row["chat_id"], row["model"]] : null;
  }
  const verrou = cid
    ? await attendre(
        async () => verrousChat.isHeld("gen", uid, cid),
        (x) => !x,
      )
    : false;
  const chat = cid && cid.length < 192 ? await getChat(t.base, uid, cid) : null;
  idsPar.set(sc.nom, releveIds(evenements, []));
  const images = await lignes(uid, idsPar.get(sc.nom)!);
  return {
    statut: r.statusCode,
    corps: r.statusCode === 200 ? null : r.body,
    evenements,
    chat: chat === null ? null : { title: chat["title"], messages: chat["messages"] },
    soumissions: soumissions(),
    annule: sd.requetes.some((q) => q.chemin.endsWith("/cancel")),
    run,
    verrou,
    images,
  };
}

async function essayerOutil(cas: Cas): Promise<Dict> {
  url = sd.url;
  ecrireConfig(cas.config ?? {});
  sd.requetes.length = 0;
  Object.assign(etat, { etats: [], stop: null, sondages: 0, pendant: null });
  const evs: unknown[] = [];
  const sink: Dict = {};
  const outil: Record<string, OutilIntegre> = buildImageBuiltinTool({
    base: t.base,
    userId: 1,
    chatId: "chat-outil",
    onEvent: (ev) => void evs.push(fil(ev)),
    sink,
    prefs: cas.prefs ?? null,
  });
  const resultats: unknown[] = [];
  const g = outil["generate_image"];
  if (g)
    for (const a of cas.appels) {
      if (Array.isArray(a) && a[0] === "config") {
        ecrireConfig({ ...(cas.config ?? {}), ...(a[1] as Dict) });
        continue;
      }
      resultats.push(await g.handler(a as Dict));
    }
  return {
    definition: g ? fil(g.definition) : null,
    resultats,
    evenements: evs,
    sink: fil(sink),
    soumissions: soumissions(),
    images: await lignes(1, releveIds(sink, [])),
  };
}

describe("vecteurs du Python", () => {
  it("scénarios du tour et de l'outil : flux, chat persisté, moteur, exécution identiques", async () => {
    reglerTourImagePourTests({ pingS: 3600 });
    const idsPar = new Map<string, string[]>();
    const scenarios: Dict[] = [];
    for (const sc of V.entrees.scenarios) scenarios.push(await jouer(sc, idsPar));
    const outil: Dict[] = [];
    for (const cas of V.entrees.outil) outil.push(await essayerOutil(cas));
    const n = normaliser({ scenarios, outil }, new Map()) as { scenarios: Dict[]; outil: Dict[] };
    for (const [i, sc] of V.entrees.scenarios.entries())
      expect(n.scenarios[i], `scénario ${sc.nom}`).toEqual(V.sorties.scenarios[i]);
    for (const [i, cas] of V.entrees.outil.entries())
      expect(n.outil[i], `outil ${cas.nom}`).toEqual(V.sorties.outil[i]);
  }, 120_000);

  it("taille demandée par l'outil et source d'une édition", () => {
    const tailles = V.entrees.tailles.map(([bloc, ratio, side]) =>
      tailleOutil(
        getImageConfig({ image: { enabled: true, url, provider: "sdcpp", max_n: 4, ...bloc } }),
        ratio,
        side,
      ),
    );
    expect(tailles).toEqual(V.sorties.tailles);
    const sources = V.entrees.sources.map((c) => {
      try {
        const b = sourceFromMessage(c);
        return b === null ? null : { octets: Buffer.from(b).toString("base64") };
      } catch (e) {
        const x = e as { code?: string; message: string; status?: number | null };
        return x.code === undefined
          ? { exception: "AttributeError" }
          : { erreur: [x.code, x.message, x.status] };
      }
    });
    expect(sources).toEqual(V.sorties.sources);
  });
});

describe("au-delà des vecteurs", () => {
  it("client parti en plein calcul : le tour finit seul et persiste ; pings pendant le silence", async () => {
    url = sd.url;
    ecrireConfig({});
    reglerTourImagePourTests({ pingS: 0.05 });
    Object.assign(etat, {
      etats: [{ status: "generating" }, { status: "generating" }],
      stop: null,
      chat: "parti",
    });
    const adresse = await app.listen({ port: 0, host: "127.0.0.1" });
    const lignes: string[] = [];
    await new Promise<void>((ok, ko) => {
      const req = request(
        `${adresse}/api/chat-saved-stream3`,
        { method: "POST", headers: { "content-type": "application/json", "x-uid": "1" } },
        (rep) => {
          rep.setEncoding("utf-8");
          rep.on("data", (morceau: string) => {
            lignes.push(...morceau.split("\n").filter((l) => l));
            if (lignes.some((l) => l.includes('"ping"'))) {
              req.destroy();
              ok();
            }
          });
        },
      );
      req.on("error", (e) => (lignes.some((l) => l.includes('"ping"')) ? ok() : ko(e)));
      req.end(
        JSON.stringify({ chat_id: "parti", messages: [{ role: "user", content: "un chat" }], image_gen: {} }),
      );
    });
    expect(lignes[0]).toContain('"type": "mode"');
    const chat = await attendre(
      () => getChat(t.base, 1, "parti"),
      (c) => ((c?.["messages"] as Dict[] | undefined)?.length ?? 0) === 2,
    );
    expect((chat!["messages"] as Dict[])[1]).toMatchObject({ content: "[Image générée : « un chat »]" });
    expect(
      await attendre(
        async () => verrousChat.isHeld("gen", 1, "parti"),
        (x) => !x,
      ),
    ).toBe(false);
    reglerTourImagePourTests({ pingS: 3600 });
  });

  it("prompt enrichi : l'appel au modèle compte pour le compte et la conversation", async () => {
    url = sd.url;
    ecrireConfig({ enhance_enabled: true });
    Object.assign(etat, { etats: [], stop: null, chat: "usage", demande: null });
    enrichi.sortie = "A lighthouse in a storm";
    enrichi.contexte = null;
    const r = await app.inject({
      method: "POST",
      url: "/api/chat-saved-stream3",
      headers: { "x-uid": "1", "content-type": "application/json" },
      payload: JSON.stringify({
        chat_id: "usage",
        messages: [{ role: "user", content: "un phare" }],
        image_gen: { enhance: true },
      }),
    });
    enrichi.sortie = null;
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('"type": "image_prompt"');
    expect(enrichi.contexte).toEqual({ source: "chat", userId: 1, originId: "usage", parentId: "" });
  });

  it("rattachement : le journal du run porte la demande du message", async () => {
    url = sd.url;
    ecrireConfig({});
    Object.assign(etat, { etats: [{ status: "generating" }], stop: null, chat: "journal", demande: null });
    const r = await app.inject({
      method: "POST",
      url: "/api/chat-saved-stream3",
      headers: { "x-uid": "1", "content-type": "application/json" },
      payload: JSON.stringify({
        chat_id: "journal",
        resumable: true,
        messages: [{ role: "user", content: "un chat" }],
        image_gen: { ratio: "4:3", side: 768, size: "1024x768" },
      }),
    });
    expect(r.statusCode).toBe(200);
    const question = ((await getChat(t.base, 1, "journal"))!["messages"] as Dict[])[0]!;
    expect(etat.demande).toEqual(question["image_request"]);
    expect(etat.demande).toMatchObject({ size: "1024x768", ratio: "4:3" });
  });

  it("outil dans un tour du modèle : proposé, appelé, images posées sur le message (tool_images)", async () => {
    url = sd.url;
    ecrireConfig({});
    sd.requetes.length = 0;
    Object.assign(etat, { etats: [], stop: null, chat: "outil" });
    let proposes: string[] = [];
    reglerExecutionPourTests({
      etatFile: async () => ({ kind: "ready" }),
      contexteModele: async () => 0,
      admission: async (_o, fn) => fn(null),
      titre: async () => null,
      boucle: async (o) => {
        const outils = new Map(
          o.builtinTools instanceof Map ? o.builtinTools : Object.entries(o.builtinTools ?? {}),
        );
        proposes = [...outils.keys()];
        await outils.get("generate_image")!.handler({ prompt: "a red fox" });
        return ["Voici.", [], {}];
      },
    });
    try {
      const tour = await ouvrirTour({ base: t.base }, 1, {
        chat_id: "outil",
        messages: [{ role: "user", content: "dessine un renard" }],
      });
      expect(tour.plan.imageToolOn).toBe(true);
      const evs: Dict[] = [];
      for await (const ev of runTurn(
        { base: t.base },
        tour.plan,
        tour.res,
        tour.base,
        new AbortController().signal,
      ))
        evs.push(ev);
      expect(proposes).toContain("generate_image");
      expect(evs.filter((e) => e["source"] === "tool").map((e) => e["type"])).toEqual([
        "image_progress",
        "image",
      ]);
      const assistant = ((await getChat(t.base, 1, "outil"))!["messages"] as Dict[]).at(-1)!;
      expect(assistant["tool_images"]).toHaveLength(1);
      expect((soumissions()[0] as Dict)["prompt"]).toBe("a red fox");
    } finally {
      reglerExecutionPourTests(null);
    }
  });
});
