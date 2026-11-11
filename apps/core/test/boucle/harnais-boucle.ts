// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/harnais-boucle.ts — rejeu TS d'un golden du harnais « boucle » (README tests/goldens) : faux moteur, pannes, outils déterministes, sorties assainies. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { surchargerConfig } from "@elpis/config";
import { FlottantPy, pyJsonDumps } from "@elpis/commun";

import { runChatMultiMcp } from "../../src/boucle/orchestrateur";
import { installerDormir, installerTokenHex } from "../../src/boucle/ports";
import type { FluxFn } from "../../src/boucle/run";
import {
  installerPortCompresseur,
  installerProfilReseau,
  installerPromptsCapacites,
} from "../../src/contexte/ports";
import { measuredRatio } from "../../src/contexte/tokens";
import { ConnectError, HTTPStatusError, ReponseHttp } from "../../src/llm/client-http";
import { continueFinalCache } from "../../src/llm/parametres";
import type { OutilIntegre } from "../../src/outils/catalogue";
import type { Dict } from "../../src/python";
import { lireVecteurs } from "../vecteurs-moteur";
import { FauxClient } from "./faux-moteur";

/** Doublure du port des prompts de capacité (B1-19b) : décisions Python pour les catégories actives des goldens. */
const CAPACITES = lireVecteurs<{
  ensembles: Record<string, { runtime_context: boolean; bloc: string | null }>;
}>("boucle-capacites").ensembles;

function capacite(actives: ReadonlySet<string>): { runtime_context: boolean; bloc: string | null } {
  const cle = [...actives].sort().join(",");
  const c = CAPACITES[cle];
  if (c === undefined) throw new Error(`catégories actives sans vecteur : ${cle}`);
  return c;
}

export const RACINE_GOLDENS = new URL("../../../../tests/goldens/", import.meta.url);

/** État partagé avec les `vi.mock` du fichier de test (fenêtre, comptage, catégories, client). */
export interface EtatHarnais {
  client: FauxClient | null;
  ctx: number;
  ratioGele: boolean;
  comptageFactice: boolean;
  categories: Record<string, string> | null;
}

const VOLATILS = new Set([
  "duration",
  "duration_ms",
  "elapsed_ms",
  "elapsed_s",
  "time_ms",
  "read_tps",
  "write_tps",
  "ts",
  "timestamp",
  "wait_ms",
]);
const PAYLOAD_CLAIR_MAX = 60_000;

export function canon(v: unknown): string {
  return pyJsonDumps(v, { ensureAscii: false, indent: 2, sortKeys: true });
}

export function assainir(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(assainir);
  if (v !== null && typeof v === "object" && !(v instanceof FlottantPy))
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !VOLATILS.has(k))
        .map(([k, x]) => [k, assainir(x)]),
    );
  return v;
}

function empreinte(v: unknown): string {
  return createHash("sha256").update(canon(v), "utf8").digest("hex").slice(0, 16);
}

export function payloadsFiges(payloads: readonly unknown[]): unknown {
  if (Array.from(canon(payloads)).length <= PAYLOAD_CLAIR_MAX) return payloads;
  return payloads.map((p) => {
    const d = p as Dict;
    const msgs = (d["messages"] as Dict[] | undefined) ?? [];
    return {
      cles: Object.keys(d).sort(),
      max_tokens: d["max_tokens"] ?? null,
      outils: ((d["tools"] as Dict[] | undefined) ?? []).map((t) => (t["function"] as Dict)["name"]),
      messages: msgs.map((m) => ({
        role: m["role"] ?? null,
        taille: Array.from(canon(m["content"] ?? null)).length,
        empreinte: empreinte(m),
      })),
      empreinte: empreinte(d),
    };
  });
}

/** `blob(c, l)` : texte d'exactement `c` caractères, sentinelles de tête et de queue. */
export function blob(n: number, label: string): string {
  const tete = `<<HEAD ${label}>>\n`;
  const queue = `\n<<TAIL ${label} exit=0>>`;
  const reste = n - tete.length - queue.length;
  const ligne = `${label} sortie ligne deterministe ${"x".repeat(60)}\n`;
  return tete + ligne.repeat(Math.floor(reste / ligne.length) + 1).slice(0, reste) + queue;
}

function messages(entrees: Dict): Dict[] {
  const sortie: Dict[] = [];
  for (const m of entrees["messages"] as Dict[]) {
    if (!("generer" in m)) {
      sortie.push(structuredClone(m));
      continue;
    }
    const premier = Number(m["premier"]);
    for (let i = premier; i < premier + Number(m["nombre"]); i++) {
      const cid = `c${i}`;
      sortie.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: cid,
            type: "function",
            function: { name: "execute_shell", arguments: pyJsonDumps({ command: `./step_${i}.sh` }) },
          },
        ],
      });
      sortie.push({ role: "tool", tool_call_id: cid, content: blob(Number(m["taille"]), `shell${i}`) });
    }
  }
  return sortie;
}

/** `(a or 0) + (b or 0)` à la Python : entier si les deux le sont, flottant sinon. */
function sommePy(a: unknown, b: unknown): unknown {
  const val = (x: unknown): number | FlottantPy =>
    x === null || x === undefined || x === false || x === 0 || x === "" ? 0 : (x as number);
  const [x, y] = [val(a), val(b)];
  const flottant = (v: unknown): boolean =>
    v instanceof FlottantPy || (typeof v === "number" && !Number.isInteger(v));
  const nombre = (v: unknown): number => (v instanceof FlottantPy ? v.valeur : Number(v));
  if (typeof x === "string" || typeof y === "string" || (typeof x === "object" && !(x instanceof FlottantPy)))
    throw new TypeError("unsupported operand type(s) for +");
  const s = nombre(x) + nombre(y);
  return flottant(x) || flottant(y) ? (Number.isInteger(s) ? new FlottantPy(s) : s) : s;
}

/** Outils du golden : comportements déterministes, durées réelles, barrières (lancement simultané, 5 s au plus). */
function outils(entrees: Dict): Record<string, OutilIntegre> {
  const groupes = new Map<
    string,
    { attendus: number; arrives: number; liberer: () => void; ouvert: Promise<void> }
  >();
  for (const o of (entrees["outils"] as Dict[] | undefined) ?? []) {
    const b = o["barriere"] as string | undefined;
    if (!b) continue;
    const g = groupes.get(b);
    if (g) g.attendus++;
    else {
      let liberer: () => void = () => undefined;
      const ouvert = new Promise<void>((ok) => (liberer = ok));
      groupes.set(b, { attendus: 1, arrives: 0, liberer, ouvert });
    }
  }
  const table: Record<string, OutilIntegre> = {};
  for (const o of (entrees["outils"] as Dict[] | undefined) ?? []) {
    const def = o["definition"] as Dict;
    const nom = (def["function"] as Dict)["name"] as string;
    table[nom] = {
      definition: def,
      handler: async (args: Dict) => {
        if (o["duree_s"]) await new Promise((r) => setTimeout(r, Number(o["duree_s"]) * 1000));
        const b = o["barriere"] as string | undefined;
        if (b) {
          const g = groupes.get(b)!;
          g.arrives++;
          if (g.arrives >= g.attendus) g.liberer();
          let minuterie: NodeJS.Timeout | undefined;
          await Promise.race([
            g.ouvert,
            new Promise(
              (_ok, ko) => (minuterie = setTimeout(() => ko(new Error("barrière incomplète")), 5000)),
            ),
          ]).finally(() => clearTimeout(minuterie));
        }
        const c = o["comportement"];
        if (c === "echec") throw new Error(String(o["message"] ?? "échec de l'outil"));
        if (c === "marque")
          return pyJsonDumps({ ok: true, marque: args["x"] ?? null }, { ensureAscii: false });
        if (c === "somme")
          return pyJsonDumps({ ok: true, sum: sommePy(args["a"], args["b"]) }, { ensureAscii: false });
        if (c === "echo") return pyJsonDumps({ ok: true, echo: args }, { ensureAscii: false });
        return pyJsonDumps({ ok: true });
      },
    };
  }
  return table;
}

/** Fonction de flux enveloppée : la panne de l'appel `i` remplace l'appel (réponse, connexion, HTTP) ; ce que la boucle a transmis est relevé. */
function avecPannes(reel: FluxFn, pannes: Dict[], interceptes: unknown[]): FluxFn {
  let n = 0;
  return async (msgs, tools, o) => {
    const i = n++;
    const trace = JSON.parse(
      pyJsonDumps(
        { messages: msgs, tools: tools ?? [], tool_choice: o.toolChoice ?? null },
        { ensureAscii: false },
      ),
    ) as unknown;
    for (const p of pannes) {
      if (p["appel"] !== i && p["appel"] !== "tous") continue;
      interceptes.push(trace);
      if ("connexion" in p) throw new ConnectError(String(p["connexion"]));
      if ("http" in p) {
        const h = p["http"] as Dict;
        const requete = { method: "POST", url: "http://moteur.invalid/v1/chat/completions" };
        throw new HTTPStatusError(`HTTP ${String(h["statut"])}`, {
          request: requete,
          response: new ReponseHttp({
            statusCode: Number(h["statut"]),
            request: requete,
            text: String(h["corps"]),
          }),
        });
      }
      return structuredClone(p["reponse"]) as Dict;
    }
    return reel(msgs, tools, o);
  };
}

const COMPRESSION_DEFAUT: Dict = {
  COMPRESSION_ENABLED: true,
  COMPRESSION_KEEP_RECENT: 2,
  COMPRESSION_KEEP_BRIDGE: 1,
  COMPRESSION_EXTERNAL_MODEL: "",
  COMPRESSION_ENDPOINT_URL: "",
  COMPRESSION_ENDPOINT_MODEL: "",
  COMPRESSION_ENDPOINT_TIMEOUT_SEC: 30,
  COMPRESSION_MAX_PER_CHAT: 5,
  COMPACTION_BUFFER_TOKENS: 0,
  COMPACTION_PARTIAL_TARGET_RATIO: 0.6,
};

export function lireGolden(nom: string): Dict {
  return JSON.parse(readFileSync(new URL(`${nom}.json`, RACINE_GOLDENS), "utf-8")) as Dict;
}

/** Joue le tour décrit par `entrees` et rend la sortie figée du golden (`tour`, `payloads` ou `types`). */
export async function rejouer(entrees: Dict, etat: EtatHarnais, flux: FluxFn): Promise<Dict> {
  const options = (entrees["options"] ?? {}) as Dict;
  const restaurations: (() => void)[] = [];
  const client = new FauxClient(entrees["appels"] as string[][]);
  etat.client = client;
  etat.ctx = Number(options["contexte"] ?? 0);
  etat.ratioGele = Boolean(options["contexte"]);
  etat.comptageFactice = Boolean(options["comptage_factice"]);
  etat.categories = (options["categories"] as Record<string, string> | undefined) ?? null;
  let i = 0;
  installerTokenHex((nOctets) =>
    (++i)
      .toString(16)
      .padStart(2 * nOctets, "0")
      .slice(-2 * nOctets),
  );
  installerDormir(async () => undefined);
  measuredRatio.clear();
  continueFinalCache.clear();
  installerProfilReseau({ profilReseau: () => ({ id: "isolated", mode: "none" }) });
  installerPromptsCapacites({
    capabilityWantsRuntimeContext: (a) => capacite(a).runtime_context,
    buildCapabilityBlock: (a) => capacite(a).bloc,
  });
  installerPortCompresseur({
    userIdParNom: async () => null,
    sessionIndexMessages: async (rows) => rows.length,
    recordTurnUsage: () => undefined,
  });
  if (options["compression"])
    restaurations.push(
      surchargerConfig({ ...COMPRESSION_DEFAUT, ...(options["compression"] as Dict) } as Parameters<
        typeof surchargerConfig
      >[0]),
    );
  if (options["reglages"])
    restaurations.push(surchargerConfig(options["reglages"] as Parameters<typeof surchargerConfig>[0]));
  const evenements: Dict[] = [];
  const interceptes: unknown[] = [];
  const pannes = (entrees["pannes"] as Dict[] | undefined) ?? [];
  try {
    const [final, , metrics] = await runChatMultiMcp({
      messages: messages(entrees),
      mcpConfigs: [],
      builtinTools: outils(entrees),
      username: "golden",
      chatId: "golden-chat",
      model: "golden-model",
      memoryEnabled: false,
      onEvent: (ev) => void evenements.push(structuredClone(ev)),
      thinkingMode: Boolean(options["reflexion"]),
      ...("compression_du_tour" in options ? { compressionEnabled: false } : {}),
      deps: {
        stream: pannes.length ? avecPannes(flux, pannes, interceptes) : flux,
        recordMetric: () => undefined,
      },
    });
    const releve = entrees["releve"];
    if (releve === "payloads") return { sortie: client.payloads };
    if (releve === "types") return { sortie: evenements.map((e) => e["type"]) };
    const fige: Dict = {
      final,
      evenements: assainir(evenements),
      metrics: assainir(metrics),
      payloads: payloadsFiges(client.payloads),
    };
    if (pannes.length) fige["appels_interceptes"] = payloadsFiges(interceptes);
    return fige;
  } finally {
    for (const r of restaurations.reverse()) r();
    installerTokenHex(null);
    installerDormir(null);
    installerPortCompresseur(null);
    installerPromptsCapacites(null);
    installerProfilReseau(null);
  }
}

/** Forme comparable : nombres normalisés (le `1.0` de Python lu comme `1`), clés de premier niveau hors `entrees`. */
export function normaliser(v: unknown): unknown {
  return JSON.parse(pyJsonDumps(v, { ensureAscii: false })) as unknown;
}
