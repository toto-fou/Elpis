// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/echeance.test.ts — échéance d'un run contre la boucle réelle et un faux moteur lent : génération coupée puis rapport, annulation inchangée, chat sans mur intact ; sous-agent : rapport rendu au parent, rapport assemblé au délai dur. */
import "../moteur-environnement";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CancelledError, estErreurAnnulation, pyJsonDumps } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runChatMultiMcp } from "../../src/boucle/orchestrateur";
import type { OptionsRun } from "../../src/boucle/orchestrateur";
import { installerDormir, installerTokenHex } from "../../src/boucle/ports";
import {
  installerPortCompresseur,
  installerProfilReseau,
  installerPromptsCapacites,
} from "../../src/contexte/ports";
import type { OptionsRequete } from "../../src/llm/client-http";
import type { OutilIntegre } from "../../src/outils/catalogue";
import { rapportCoupe, rapportDeGarde } from "../../src/outils/integres/task/echeances";
import { statutDeclare, travailRestant } from "../../src/outils/integres/task/statut";
import { buildTaskBuiltinTool } from "../../src/outils/integres/task";
import { reserveSouple } from "../../src/outils/integres/task/echeances";
import { installerManifesteMcp, installerTachesFond } from "../../src/outils/ports";
import type { FinFond } from "../../src/outils/ports";
import type { UsageRun } from "../../src/boucle/usage-requete";
import type { Dict } from "../../src/python";
import { data, FauxFlux, reponse } from "./faux-moteur";
import type * as Config from "@elpis/config";
import type * as Constantes from "../../src/llm/constantes";
import type * as Capacites from "../../src/llm/fournisseurs/llama-capacites";
import type * as OpenaiCompat from "../../src/llm/fournisseurs/openai-compat";
import type * as LlamaHttp from "../../src/llm/llama-http";
import type * as Modeles from "../../src/llm/modeles";
import type * as Parametres from "../../src/llm/parametres";
import type * as Sante from "../../src/llm/sante";

const etat = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../../src/llm/sante", async (orig) => ({
  ...(await orig<typeof Sante>()),
  verifyLlmAvailability: async () => undefined,
}));
vi.mock("../../src/llm/modeles", async (orig) => ({
  ...(await orig<typeof Modeles>()),
  getModelContextSize: async () => 0,
}));
vi.mock("../../src/llm/parametres", async (orig) => ({
  ...(await orig<typeof Parametres>()),
  resolveSampling: async () => ({}),
}));
vi.mock("../../src/llm/constantes", async (orig) => ({
  ...(await orig<typeof Constantes>()),
  resolveSlotIdAsync: async () => -1,
  TASK_CHILD_TIMEOUT_S: 3,
}));
vi.mock("../../src/llm/fournisseurs/llama-capacites", async (orig) => {
  const reel = await orig<typeof Capacites>();
  return { ...reel, engineCaps: async () => reel.UNKNOWN };
});
vi.mock("../../src/llm/llama-http", async (orig) => ({
  ...(await orig<typeof LlamaHttp>()),
  llamaPost: async () => ({ _status: 0, error: "indisponible (test)", error_type: "ConnectError" }),
}));
vi.mock("../../src/llm/fournisseurs/openai-compat", async (orig) => {
  const reel = await orig<typeof OpenaiCompat>();
  return {
    ...reel,
    endpoint: (t: Parameters<typeof reel.endpoint>[0]) => [
      etat.client,
      reel.chatCompletionsUrl(t),
      reel.headers(t),
    ],
  };
});
vi.mock("@elpis/config", async (orig) => ({
  ...(await orig<typeof Config>()),
  reloadCompressionConfigFromDisk: () => false,
}));

/** Attente de `ms`, interrompue comme un transport qui se ferme quand le signal de la requête tombe. */
function attendre(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((ok, ko) => {
    if (signal?.aborted) return ko(new CancelledError("requête annulée"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      ok();
    }, ms);
    const stop = (): void => {
      clearTimeout(t);
      ko(new CancelledError("requête annulée"));
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** Flux SSE lent : une ligne toutes les `pasMs` ; `coupe` dit s'il a été interrompu en cours de lecture. */
class FluxLent extends FauxFlux {
  private readonly pasMs: number;
  private readonly signal: AbortSignal | undefined;
  coupe = false;

  constructor(lignes: readonly string[], pasMs: number, signal?: AbortSignal) {
    super(lignes);
    this.pasMs = pasMs;
    this.signal = signal;
  }

  override async *aiterLines(): AsyncGenerator<string> {
    for (const l of this.lignes) {
      if (this.pasMs)
        await attendre(this.pasMs, this.signal).catch((e: unknown) => {
          this.coupe = true;
          throw e;
        });
      yield l;
    }
  }
}

/** Faux moteur : `scripts[i]` sert le i-ème flux, au rythme donné ; requêtes et signaux relevés. */
class MoteurLent {
  readonly payloads: Dict[] = [];
  readonly signaux: (AbortSignal | undefined)[] = [];
  readonly flux: FluxLent[] = [];
  private n = 0;
  private readonly scripts: { lignes: string[]; pasMs?: number }[];

  constructor(scripts: { lignes: string[]; pasMs?: number }[]) {
    this.scripts = scripts;
  }

  stream(_methode: string, _url: string, o: OptionsRequete = {}): Promise<FluxLent> {
    this.payloads.push(o.json as Dict);
    this.signaux.push(o.signal);
    const s = this.scripts[Math.min(this.n++, this.scripts.length - 1)]!;
    const f = new FluxLent(s.lignes, s.pasMs ?? 0, o.signal);
    this.flux.push(f);
    return Promise.resolve(f);
  }

  get coupes(): boolean[] {
    return this.flux.map((f) => f.coupe);
  }

  post(): Promise<never> {
    return Promise.reject(new Error("aucun POST attendu"));
  }

  delete(): Promise<unknown> {
    return Promise.resolve(reponse(200));
  }
}

const pense = (t: string): string => data({ choices: [{ delta: { reasoning_content: t } }] });
const ecrit = (t: string): string => data({ choices: [{ delta: { content: t } }] });
const appelle = (id: string | null, nom: string | null, args: string): string =>
  data({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              ...(id ? { id, type: "function" } : {}),
              function: { ...(nom ? { name: nom } : {}), arguments: args },
            },
          ],
        },
      },
    ],
  });
const fin = (raison: string): string[] => [
  data({
    choices: [{ delta: {}, finish_reason: raison }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  }),
  "data: [DONE]",
];

const RAPPORT = "Status: partial\n## Answer\nRapport au mur.";
const rapport = { lignes: [ecrit(RAPPORT), ...fin("stop")] };

/** Outil intégré de test : appels comptés, durée réelle, résultat JSON. */
function outil(nom: string, appels: string[], dureeMs = 0): OutilIntegre {
  return {
    definition: {
      type: "function",
      function: {
        name: nom,
        description: "Outil de test.",
        parameters: { type: "object", properties: { msg: { type: "string" } } },
      },
    },
    handler: async (args: Dict) => {
      appels.push(nom);
      if (dureeMs) await new Promise((r) => setTimeout(r, dureeMs));
      return pyJsonDumps({ ok: true, echo: args["msg"] ?? null });
    },
  };
}

let evenements: Dict[] = [];

beforeEach(() => {
  evenements = [];
  let i = 0;
  installerTokenHex((n) =>
    (++i)
      .toString(16)
      .padStart(2 * n, "0")
      .slice(-2 * n),
  );
  installerDormir(async () => undefined);
  installerProfilReseau({ profilReseau: () => ({ id: "isolated", mode: "none" }) });
  installerPromptsCapacites({ capabilityWantsRuntimeContext: () => false, buildCapabilityBlock: () => null });
  installerPortCompresseur({
    userIdParNom: async () => null,
    sessionIndexMessages: async (rows) => rows.length,
    recordTurnUsage: () => undefined,
  });
});

afterEach(() => {
  installerTokenHex(null);
  installerDormir(null);
  installerProfilReseau(null);
  installerPromptsCapacites(null);
  installerPortCompresseur(null);
  etat.client = null;
});

/** Un run de la boucle réelle contre `moteur`. */
function lancer(moteur: MoteurLent, outils: Record<string, OutilIntegre>, o: Partial<OptionsRun> = {}) {
  etat.client = moteur;
  return runChatMultiMcp({
    messages: [
      { role: "system", content: "Tête de test." },
      { role: "user", content: "Mission de test." },
    ],
    mcpConfigs: [],
    builtinTools: outils,
    username: "alice",
    chatId: "c1",
    model: "m",
    memoryEnabled: false,
    compressionEnabled: false,
    onEvent: (ev) => void evenements.push(structuredClone(ev)),
    deps: { recordMetric: () => undefined },
    ...o,
  });
}

const messagesDe = (p: Dict): Dict[] => p["messages"] as Dict[];

describe("génération en cours à l'échéance", () => {
  it("flux coupé : texte et réflexion gardés, appel à moitié émis abandonné, puis tour de rapport sans outils", async () => {
    const appels: string[] = [];
    const lent = {
      pasMs: 100,
      lignes: [
        pense("Je pèse."),
        ecrit("Lecture faite."),
        appelle("call_1", "zeta_echo", '{"msg": "'),
        ...Array.from({ length: 50 }, () => appelle(null, null, "x")),
        ...fin("tool_calls"),
      ],
    };
    const moteur = new MoteurLent([lent, rapport]);
    const t0 = performance.now();
    const [final, , metrics] = await lancer(
      moteur,
      { zeta_echo: outil("zeta_echo", appels) },
      {
        echeanceMs: t0 + 800,
        thinkingMode: true,
      },
    );
    expect(performance.now() - t0).toBeLessThan(2500);
    expect(final).toBe(RAPPORT);
    expect(appels).toEqual([]);
    expect(moteur.payloads).toHaveLength(2);
    expect(moteur.coupes[0]).toBe(true);
    expect(moteur.payloads[1]!["tool_choice"]).toBe("none");
    const envoyes = messagesDe(moteur.payloads[1]!);
    expect(envoyes.slice(-2)).toMatchObject([
      { role: "assistant", content: "Lecture faite." },
      { role: "user", content: expect.stringContaining("TIME BUDGET REACHED") },
    ]);
    expect(envoyes.some((m) => "tool_calls" in m)).toBe(false);
    expect(metrics).toMatchObject({ tool_limit_stop_reason: "wallclock", max_steps_wrapup: true });
    expect(String(metrics["thinking"])).toContain("Je pèse.");
    expect(metrics["tool_history"]).toEqual([{ role: "assistant", content: "Lecture faite." }]);
    expect(evenements.filter((e) => e["type"] === "tool_call")).toEqual([]);
    expect(evenements).toContainEqual(expect.objectContaining({ type: "tool_call_delta", reset: true }));
    expect(evenements).toContainEqual(
      expect.objectContaining({ type: "notice", message: expect.stringContaining("budget de temps") }),
    );
  });

  it("chat principal avec LLAMA_TOOL_LOOP_MAX_S : même coupure au mur relatif", async () => {
    const remettre = surchargerConfig({ LLAMA_TOOL_LOOP_MAX_S: 0.5 });
    try {
      const lent = {
        pasMs: 100,
        lignes: [
          ecrit("Début de réponse."),
          ...Array.from({ length: 40 }, () => ecrit(" suite")),
          ...fin("stop"),
        ],
      };
      const moteur = new MoteurLent([lent, rapport]);
      const [final, , metrics] = await lancer(moteur, {});
      expect(final).toBe(RAPPORT);
      expect(moteur.coupes[0]).toBe(true);
      expect(messagesDe(moteur.payloads[1]!).at(-1)!["content"]).toContain("TIME BUDGET REACHED");
      expect(messagesDe(moteur.payloads[1]!).at(-2)).toMatchObject({ role: "assistant" });
      expect(String(messagesDe(moteur.payloads[1]!).at(-2)!["content"])).toMatch(/^Début de réponse\./u);
      expect(metrics["tool_limit_stop_reason"]).toBe("wallclock");
    } finally {
      remettre();
    }
  });

  it("annulation de l'utilisateur pendant la génération : CancelledError, aucun tour de rapport", async () => {
    const appels: string[] = [];
    const rapide = { lignes: [appelle("call_1", "zeta_echo", '{"msg": "a"}'), ...fin("tool_calls")] };
    const lent = { pasMs: 100, lignes: [...Array.from({ length: 40 }, () => ecrit("x")), ...fin("stop")] };
    const moteur = new MoteurLent([rapide, lent, rapport]);
    const stop = new AbortController();
    const run = lancer(
      moteur,
      { zeta_echo: outil("zeta_echo", appels) },
      { echeanceMs: performance.now() + 60_000, signal: stop.signal },
    );
    setTimeout(() => stop.abort(new CancelledError("User cancelled")), 600);
    const e = await run.then(
      () => null,
      (err: unknown) => err,
    );
    expect(estErreurAnnulation(e)).toBe(true);
    expect(moteur.payloads).toHaveLength(2);
    expect(appels).toEqual(["zeta_echo"]);
    expect(evenements.filter((ev) => ev["type"] === "notice")).toEqual([]);
    expect(evenements).toContainEqual(expect.objectContaining({ type: "tool_history_partial" }));
  });

  it("usage publié : la requête coupée compte par les timings par jeton de llama.cpp, puis le rapport", async () => {
    const vus: UsageRun[] = [];
    const morceau = (t: string, n: number): string =>
      data({ choices: [{ delta: { content: t } }], timings: { prompt_n: 40, cache_n: 60, predicted_n: n } });
    const lent = {
      pasMs: 100,
      lignes: [...Array.from({ length: 40 }, (_, i) => morceau("mot ", i + 1)), ...fin("stop")],
    };
    const moteur = new MoteurLent([lent, rapport]);
    await lancer(moteur, {}, { echeanceMs: performance.now() + 650, surUsage: (u) => void vus.push(u) });
    expect(moteur.coupes[0]).toBe(true);
    const total = vus.at(-1)!;
    expect(total).toMatchObject({ entree: 200, cache: 60 });
    expect(total.sortie).toBeGreaterThan(10);
    expect(total.sortie).toBeLessThan(20);
  });

  it("sans timings ni usage (vLLM, SGLang) : la requête coupée ne compte pas, aucune estimation ; seul le rapport compte", async () => {
    const vus: UsageRun[] = [];
    const lent = {
      pasMs: 100,
      lignes: [...Array.from({ length: 40 }, () => ecrit("analyse détaillée ")), ...fin("stop")],
    };
    const moteur = new MoteurLent([lent, rapport]);
    await lancer(moteur, {}, { echeanceMs: performance.now() + 650, surUsage: (u) => void vus.push(u) });
    expect(vus.at(-1)).toMatchObject({ entree: 100, sortie: 10, cache: 0 });
  });

  it("annulation pendant la génération sans usage rapporté par le moteur : rien n'est publié, aucune estimation", async () => {
    const vus: UsageRun[] = [];
    const lent = { pasMs: 100, lignes: [...Array.from({ length: 40 }, () => ecrit("x")), ...fin("stop")] };
    const moteur = new MoteurLent([lent]);
    const stop = new AbortController();
    const run = lancer(moteur, {}, { signal: stop.signal, surUsage: (u) => void vus.push(u) });
    setTimeout(() => stop.abort(new CancelledError("User cancelled")), 400);
    await run.catch(() => undefined);
    expect(vus).toEqual([]);
  });

  it("chat principal sans mur : flux jamais coupé, signal du tour transmis tel quel", async () => {
    const lent = { pasMs: 50, lignes: [ecrit("Réponse "), ecrit("lente."), ...fin("stop")] };
    const moteur = new MoteurLent([lent]);
    const tour = new AbortController();
    const [final, , metrics] = await lancer(moteur, {}, { signal: tour.signal });
    expect(final).toBe("Réponse lente.");
    expect(moteur.payloads).toHaveLength(1);
    expect(moteur.signaux[0]).toBe(tour.signal);
    expect(moteur.coupes[0]).toBe(false);
    expect(metrics["tool_limit_reached"]).toBeUndefined();
  });
});

describe("canal du parent (task_send) dans la boucle", () => {
  const instruction = (t: string): string => `<parent_instruction>\n${t}\n</parent_instruction>`;

  it("message reçu pendant un outil : posé en user avant la requête suivante, gardé dans les messages de travail", async () => {
    const appels: string[] = [];
    const boite: string[] = [];
    const echo: OutilIntegre = {
      ...outil("zeta_echo", appels),
      handler: async () => {
        appels.push("zeta_echo");
        boite.push(instruction("Also check b."));
        return pyJsonDumps({ ok: true });
      },
    };
    const moteur = new MoteurLent([
      { lignes: [appelle("call_1", "zeta_echo", '{"msg": "a"}'), ...fin("tool_calls")] },
      { lignes: [ecrit("Status: done\n## Answer\nFait."), ...fin("stop")] },
    ]);
    let travail: (() => Dict[]) | null = null;
    const [final] = await lancer(
      moteur,
      { zeta_echo: echo },
      {
        canal: { recevoir: () => boite.splice(0), conclure: new AbortController().signal },
        exposerTravail: (lire) => (travail = lire),
      },
    );
    expect(final).toBe("Status: done\n## Answer\nFait.");
    expect(appels).toEqual(["zeta_echo"]);
    const envoyes = messagesDe(moteur.payloads[1]!);
    expect(envoyes.at(-1)).toMatchObject({ role: "user", content: instruction("Also check b.") });
    expect(envoyes.findIndex((m) => m["role"] === "tool")).toBeLessThan(envoyes.length - 1);
    expect(travail!()).toContainEqual(
      expect.objectContaining({ role: "user", content: instruction("Also check b.") }),
    );
  });

  it("conclusion demandée pendant la génération : flux coupé, message du parent puis consigne WRAP-UP, cause wrap_up", async () => {
    const boite: string[] = [];
    const conclusion = new AbortController();
    const lent = {
      pasMs: 100,
      lignes: [ecrit("Lecture faite."), ...Array.from({ length: 50 }, () => ecrit(" …")), ...fin("stop")],
    };
    const moteur = new MoteurLent([lent, rapport]);
    setTimeout(() => {
      boite.push(instruction("Stop here."));
      conclusion.abort();
    }, 300);
    const t0 = performance.now();
    const appels: string[] = [];
    const [final, , metrics] = await lancer(
      moteur,
      { zeta_echo: outil("zeta_echo", appels) },
      {
        canal: { recevoir: () => boite.splice(0), conclure: conclusion.signal },
        wrapupSuffix: "SUFFIXE DU SOUS-AGENT",
      },
    );
    expect(performance.now() - t0).toBeLessThan(2500);
    expect(final).toBe(RAPPORT);
    expect(moteur.coupes[0]).toBe(true);
    expect(moteur.payloads[1]!["tool_choice"]).toBe("none");
    const contenus = messagesDe(moteur.payloads[1]!).map((m) => String(m["content"]));
    const ici = contenus.findIndex((c) => c.includes(instruction("Stop here.")));
    expect(ici).toBeGreaterThan(-1);
    expect(contenus.at(-1)).toContain("WRAP-UP REQUESTED");
    expect(contenus.at(-1)).toContain("SUFFIXE DU SOUS-AGENT");
    expect(contenus.slice(0, ici).some((c) => c.startsWith("Lecture faite."))).toBe(true);
    expect(metrics).toMatchObject({ tool_limit_stop_reason: "wrap_up", max_steps_wrapup: true });
    expect(evenements).toContainEqual(
      expect.objectContaining({ type: "notice", message: expect.stringContaining("conclusion demandée") }),
    );
  });

  it("conclusion demandée pendant un outil long d'un sous-agent : appel coupé sans attendre sa fin, puis rapport", async () => {
    const conclusion = new AbortController();
    const appels: string[] = [];
    const moteur = new MoteurLent([
      { lignes: [appelle("call_1", "zeta_long", '{"msg": "a"}'), ...fin("tool_calls")] },
      rapport,
    ]);
    setTimeout(() => conclusion.abort(), 300);
    const t0 = performance.now();
    const [final, , metrics] = await lancer(
      moteur,
      { zeta_long: outil("zeta_long", appels, 5000) },
      {
        subagent: { type: "implement", read_only: false, deadline_ms: performance.now() + 60_000 },
        canal: { recevoir: () => [], conclure: conclusion.signal },
      },
    );
    expect(performance.now() - t0).toBeLessThan(2500);
    expect(final).toBe(RAPPORT);
    expect(appels).toEqual(["zeta_long"]);
    const resultat = messagesDe(moteur.payloads[1]!).find((m) => m["role"] === "tool");
    expect(String(resultat?.["content"])).toContain("your parent asked you to wrap up");
    expect(metrics["tool_limit_stop_reason"]).toBe("wrap_up");
  });

  it("conclusion sans rapport du moteur : repli en anglais, lu par le parent", async () => {
    const conclusion = new AbortController();
    conclusion.abort();
    const moteur = new MoteurLent([{ lignes: fin("stop") }]);
    const [final] = await lancer(
      moteur,
      { zeta_echo: outil("zeta_echo", []) },
      { canal: { recevoir: () => [], conclure: conclusion.signal } },
    );
    expect(final).toContain("My parent asked me to wrap up before I could write my report.");
    expect(final).toContain("resume this agent with its task_id");
  });

  it("conclusion demandée avant la première requête : tour de rapport seul, sans outils", async () => {
    const conclusion = new AbortController();
    conclusion.abort();
    const moteur = new MoteurLent([rapport]);
    const [final, , metrics] = await lancer(
      moteur,
      { zeta_echo: outil("zeta_echo", []) },
      { canal: { recevoir: () => [], conclure: conclusion.signal } },
    );
    expect(final).toBe(RAPPORT);
    expect(moteur.payloads).toHaveLength(1);
    expect(moteur.payloads[0]!["tool_choice"]).toBe("none");
    expect(metrics["tool_limit_stop_reason"]).toBe("wrap_up");
  });
});

describe("sous-agent : échéance souple et délai dur (max_seconds de 3 s : échéance à 2 s, délai dur à 3 s)", () => {
  let dossier = "";
  let remettre: () => void = () => undefined;

  beforeEach(() => {
    dossier = mkdtempSync(path.join(tmpdir(), "elpis-echeance-"));
    process.env["ELPIS_TASK_RESUME_DIR"] = path.join(dossier, "reprise");
    writeFileSync(path.join(dossier, "config.json"), "{}");
    remettre = surchargerConfig({ CONFIG_JSON_PATH: path.join(dossier, "config.json") });
    invalidateConfigCache();
    installerManifesteMcp({ defaultOnCategories: () => [] });
  });

  afterEach(() => {
    remettre();
    invalidateConfigCache();
    installerManifesteMcp(null);
    delete process.env["ELPIS_TASK_RESUME_DIR"];
    rmSync(dossier, { recursive: true, force: true });
  });

  /** Outils `task*` dont la boucle des enfants est la vraie, sur le faux moteur et les outils donnés. */
  function outilsTache(
    moteur: MoteurLent,
    outils: Record<string, OutilIntegre>,
    userId: number | null = null,
  ): Record<string, OutilIntegre> {
    etat.client = moteur;
    return buildTaskBuiltinTool({
      userId,
      username: "alice",
      chatId: "c1",
      model: "m",
      samplingOverride: null,
      isCancelled: null,
      onEvent: (e) => void evenements.push(structuredClone(e)),
      usageSink: {},
      runner: (o) =>
        runChatMultiMcp({
          ...o,
          mcpConfigs: [],
          builtinTools: outils,
          deps: { recordMetric: () => undefined },
        }),
      hote: {
        santeNavigateur: async () => null,
        fermerNavigateur: async () => true,
        sauverRapport: async () => true,
        brancheCourante: async () => null,
      },
    });
  }

  /** Appel `task` d'un agent `pr` dont la boucle est la vraie, sur le faux moteur et les outils donnés. */
  function tache(moteur: MoteurLent, outils: Record<string, OutilIntegre>): Promise<Dict> {
    const t = outilsTache(moteur, outils);
    return (
      t["task"]!.handler(
        { subagent_type: "pr", prompt: "Prépare la branche." },
        { callId: "p1" },
      ) as Promise<string>
    ).then((r) => JSON.parse(r) as Dict);
  }

  const bloque = { pasMs: 30_000, lignes: [ecrit("jamais"), ...fin("stop")] };
  const etapeFinale = (): Dict | undefined =>
    evenements.find((e) => e["type"] === "task_step" && e["status"] === "final");

  it("génération longue à l'échéance souple : le parent reçoit le rapport du tour sans outils, pas task_timeout", async () => {
    const lent = {
      pasMs: 100,
      lignes: [...Array.from({ length: 50 }, () => ecrit("analyse ")), ...fin("stop")],
    };
    const moteur = new MoteurLent([lent, rapport]);
    const r = await tache(moteur, {});
    expect(r).toMatchObject({
      error: "task_incomplete",
      stop_reason: "wallclock",
      partial_report: RAPPORT,
      harness: { status: "timeout", stop_reason: "wallclock" },
    });
    expect(moteur.payloads).toHaveLength(2);
    expect(moteur.coupes).toEqual([true, false]);
    expect(String(messagesDe(moteur.payloads[1]!).at(-1)!["content"])).toContain("TIME BUDGET REACHED");
  });

  it("moteur bloqué au tour de rapport : le délai dur rend un rapport partiel assemblé depuis le travail fait", async () => {
    const appels: string[] = [];
    const rapide = { lignes: [appelle("call_1", "zeta_echo", '{"msg": "a"}'), ...fin("tool_calls")] };
    const lent = {
      pasMs: 100,
      lignes: [
        ecrit("Je poursuis l'analyse du module."),
        ...Array.from({ length: 50 }, () => ecrit(" …")),
        ...fin("stop"),
      ],
    };
    const moteur = new MoteurLent([rapide, lent, bloque]);
    const t0 = performance.now();
    const r = await tache(moteur, { zeta_echo: outil("zeta_echo", appels) });
    expect(performance.now() - t0).toBeLessThan(6000);
    expect(appels).toEqual(["zeta_echo"]);
    expect(moteur.payloads).toHaveLength(3);
    expect(moteur.coupes).toEqual([false, true, true]);
    expect(r).toMatchObject({
      error: "task_timeout",
      message: expect.stringContaining("the limit counts from the task call, queue time included (queued_s)"),
      task_id: expect.any(String),
      harness: {
        status: "timeout",
        stop_reason: "wallclock_hard",
        remaining_work: expect.stringContaining("task_id"),
        queued_s: expect.any(Number),
      },
    });
    const assemble = String(r["partial_report"]);
    expect(assemble).toMatch(/^Status: partial\n## Answer\n/u);
    expect(assemble).toContain("at its 3 s time limit because the model did not return its final report");
    expect(assemble).toContain("Je poursuis l'analyse du module.");
    expect(assemble).toContain("- zeta_echo");
    expect(assemble).toContain("→ done");
    expect(assemble).toContain(`task_id="${String(r["task_id"])}"`);
    expect(etapeFinale()).toMatchObject({
      state: "timeout",
      result: assemble,
      input_tokens: 100,
      output_tokens: 10,
    });
    expect(etapeFinale()).not.toHaveProperty("tokens_estimated");
  });

  it("synthèse commencée puis interrompue au délai dur : son texte est le rapport partiel", async () => {
    const lent = {
      pasMs: 100,
      lignes: [...Array.from({ length: 50 }, () => ecrit("analyse ")), ...fin("stop")],
    };
    const debutSynthese = {
      pasMs: 400,
      lignes: [
        ecrit("Status: partial\n## Answer\nDébut"),
        ecrit(" du rapport"),
        ...Array.from({ length: 20 }, () => ecrit(".")),
        ...fin("stop"),
      ],
    };
    const moteur = new MoteurLent([lent, debutSynthese]);
    const r = await tache(moteur, {});
    expect(r).toMatchObject({ error: "task_timeout", harness: { stop_reason: "wallclock_hard" } });
    expect(String(r["partial_report"])).toMatch(/^Status: partial\n## Answer\nDébut/u);
    expect(String(r["partial_report"])).not.toContain("assembled by the harness");
    expect(String(r["partial_report"])).toMatch(/\n\n\[report cut by the harness at the 3 s time limit\]$/u);
  });

  it("rapport coupé en pleine génération : mot inachevé retiré, phrase finie gardée, note du harnais", () => {
    const note = "report cut by the harness at the 600 s time limit";
    const lignes = "Status: partial\n## Answer\n" + "x".repeat(200) + "\nL'agent `implement` n'a";
    expect(rapportCoupe(lignes, note)).toBe(
      "Status: partial\n## Answer\n" + "x".repeat(200) + "\nL'agent `implement` …\n\n[" + note + "]",
    );
    const longue = "Status: partial\n## Answer\n" + "mot ".repeat(60) + "coup";
    expect(rapportCoupe(longue, note)).toBe(
      "Status: partial\n## Answer\n" + "mot ".repeat(60).trimEnd() + " …\n\n[" + note + "]",
    );
    expect(rapportCoupe("Status: partial\n## Answer\nUne longue phrase coup", note)).toBe(
      "Status: partial\n## Answer\nUne longue phrase …\n\n[" + note + "]",
    );
    expect(rapportCoupe("Status: partial\n## Answer\nFini.\n", note)).toBe(
      "Status: partial\n## Answer\nFini.\n\n[" + note + "]",
    );
    expect(rapportCoupe("", note)).toBe("");
  });

  it("outil bloqué : le délai dur l'interrompt et le rapport le dit en vol, non confirmé", async () => {
    const appels: string[] = [];
    const bloquant: OutilIntegre = {
      ...outil("zeta_bloque", appels),
      handler: () => {
        appels.push("zeta_bloque");
        return new Promise<string>(() => undefined);
      },
    };
    const rapide = { lignes: [appelle("call_1", "zeta_bloque", '{"msg": "a"}'), ...fin("tool_calls")] };
    const moteur = new MoteurLent([rapide, rapport]);
    const r = await tache(moteur, { zeta_bloque: bloquant });
    expect(appels).toEqual(["zeta_bloque"]);
    expect(moteur.payloads).toHaveLength(1);
    expect(r).toMatchObject({
      error: "task_timeout",
      harness: { status: "timeout", stop_reason: "wallclock_hard" },
    });
    const assemble = String(r["partial_report"]);
    expect(assemble).toContain("the tool call zeta_bloque did not return (running or queued)");
    expect(assemble).toContain("still running or queued when stopped (unconfirmed: it may have acted)");
    expect(assemble).toContain("check the state left by zeta_bloque before repeating it");
  });

  it("enfant en fond : task_send wrap_up pendant sa génération → rapport partial livré, enfant non tué, puis repris par task_id", async () => {
    const fins: FinFond[] = [];
    let finie: () => void = () => undefined;
    const fini = new Promise<void>((ok) => (finie = ok));
    installerTachesFond({
      inscrire: async () => ({ ok: true as const, jobId: "j-00000001", runId: "run-1" }),
      progresser: async () => undefined,
      terminer: async (_uid, _job, f) => {
        fins.push(f);
        finie();
      },
      prendreRapport: async () => null,
      tourActif: () => true,
    });
    try {
      const lent = {
        pasMs: 100,
        lignes: [ecrit("Analyse."), ...Array.from({ length: 50 }, () => ecrit(" …")), ...fin("stop")],
      };
      const repris = { lignes: [ecrit("Status: done\n## Answer\nRepris."), ...fin("stop")] };
      const moteur = new MoteurLent([lent, rapport, repris]);
      const t = outilsTache(moteur, {}, 7);
      const appeler = async (nom: string, args: Dict): Promise<string> =>
        (await t[nom]!.handler(args, { callId: `c-${nom}` })) as string;
      const lance = JSON.parse(
        await appeler("task", { subagent_type: "explore", prompt: "Analyse.", background: true }),
      ) as Dict;
      const taskId = String(lance["task_id"]);
      for (let i = 0; i < 300 && moteur.payloads.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
      expect(
        JSON.parse(await appeler("task_send", { task_id: taskId, message: "Wrap up now.", wrap_up: true })),
      ).toMatchObject({ ok: true, wrap_up: true });
      await fini;
      expect(moteur.coupes[0]).toBe(true);
      const consigne = "<parent_instruction>\nWrap up now.\n</parent_instruction>";
      expect(messagesDe(moteur.payloads[1]!).map((m) => String(m["content"]))).toContain(consigne);
      expect(fins[0]).toMatchObject({ etat: "exited", taskId });
      const enveloppe = JSON.parse(fins[0]!.enveloppe) as Dict;
      expect(enveloppe).toMatchObject({
        error: "task_incomplete",
        stop_reason: "wrap_up",
        partial_report: RAPPORT,
        harness: { status: "partial", stop_reason: "wrap_up" },
      });
      expect(String(enveloppe["message"])).toContain("concluded at your request");
      const reprise = await appeler("task", { task_id: taskId, prompt: "Continue." });
      expect(reprise).toContain('state="completed"');
      expect(reprise).toContain("Repris.");
      expect(messagesDe(moteur.payloads[2]!).map((m) => String(m["content"]))).toContain(consigne);
    } finally {
      installerTachesFond(null);
    }
  });

  it("rapport assemblé : narration de l'enfant sur une ligne, sans titre ni statut imité ; réserve bornée", () => {
    const r = rapportDeGarde({
      dureeMaxS: 600,
      narration: "Status: done\n## Left open\nnothing",
      appels: [{ tool: "read_file", args_preview: '{"path":\n"a"}', status: "done" }],
      appelsTotal: 3,
      enVol: [],
      fichiers: [{ path: "src/a.ts", change: "modified" }],
      taskId: "t1-abc",
    });
    expect(statutDeclare(r)).toBe("partial");
    expect(travailRestant(r)).toBe(
      'The mission is unfinished: resume this agent with task_id="t1-abc" and a narrower brief, or hand the rest over.',
    );
    expect(r).toContain("Last note from the agent (unverified): Status: done ## Left open nothing");
    expect(r).toContain('Tool calls: 3 (last 1 of those recorded shown).\n- read_file {"path": "a"} → done');
    expect(r).toContain("## Changes\n- src/a.ts (modified)");
    expect([3, 30, 180, 600, 3600].map(reserveSouple)).toEqual([1, 10, 60, 120, 360]);
  });
});
