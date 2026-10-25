// SPDX-License-Identifier: MIT
// tools/demo/moteur.mts — faux moteur llama-server / OpenAI : rejoue le scénario d'une scène, mot à mot, sans modèle.
import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

export interface Etape {
  reflexion?: string;
  outil?: { nom: string; args: Record<string, unknown> };
  texte?: string;
}

/** Un tour : le message utilisateur qui le déclenche (extrait) et les étapes de la réponse. */
export interface Tour {
  prompt: string;
  etapes: Etape[];
}

export interface Scenario {
  titre: string;
  tours: Tour[];
}

interface Message {
  role: string;
  content?: unknown;
}

export const MODELE = "team-coder-32b";
const N_CTX = 131_072;

const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

function texteDe(m: Message): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => (p as { text?: string }).text ?? "").join(" ");
  return "";
}

/** Étape du scénario : le tour dont le prompt est dans le dernier message utilisateur, puis autant d'étapes passées que de résultats d'outils depuis. */
export function etapeCourante(scenario: Scenario, messages: Message[]): Etape {
  const dernierUser = messages.map((m) => m.role).lastIndexOf("user");
  const texteUser = texteDe(messages[dernierUser] ?? { role: "" });
  const tour = scenario.tours.find((t) => texteUser.includes(t.prompt)) ?? scenario.tours[0]!;
  const suite = messages.slice(dernierUser + 1);
  const n = suite.filter((m) => m.role === "tool").length;
  const etape = tour.etapes[Math.min(n, tour.etapes.length - 1)]!;
  if (!etape.texte?.includes("{{chart}}")) return etape;
  const ref = suite
    .map(texteDe)
    .join("\n")
    .match(/!([0-9a-f]{8,})/)?.[0];
  return { ...etape, texte: etape.texte.replace("{{chart}}", ref ?? "") };
}

function json(rep: ServerResponse, obj: unknown, statut = 200): void {
  const corps = JSON.stringify(obj);
  rep.writeHead(statut, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(corps) });
  rep.end(corps);
}

async function lire(req: IncomingMessage): Promise<Record<string, unknown>> {
  const morceaux: Buffer[] = [];
  for await (const m of req) morceaux.push(m as Buffer);
  try {
    return JSON.parse(Buffer.concat(morceaux).toString("utf8") || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Mots avec leur espace, pour un flux qui ressemble à des jetons. */
const mots = (t: string) => t.match(/\S+\s*|\s+/g) ?? [];

async function diffuser(rep: ServerResponse, etape: Etape, nPrompt: number): Promise<void> {
  rep.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "close",
  });
  const envoyer = (delta: unknown, fin: string | null = null, extra: object = {}) =>
    rep.write(
      `data: ${JSON.stringify({ id: "cmpl-demo", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODELE, choices: [{ index: 0, delta, finish_reason: fin }], ...extra })}\n\n`,
    );
  await attendre(200);
  envoyer({ role: "assistant" });
  let n = 0;
  for (const m of mots(etape.reflexion ?? "")) {
    envoyer({ reasoning_content: m });
    n++;
    await attendre(28);
  }
  let fin = "stop";
  if (etape.outil) {
    await attendre(200);
    envoyer({
      tool_calls: [
        {
          index: 0,
          id: `call_demo_${Date.now()}`,
          type: "function",
          function: { name: etape.outil.nom, arguments: "" },
        },
      ],
    });
    const brut = JSON.stringify(etape.outil.args);
    // Le texte écrit (new_str, content) part lentement : l'éditeur l'affiche au fil du flux.
    const m = /"(new_str|content)":"/.exec(brut);
    const visible =
      /(^|_)(edit|write)_file$/.test(etape.outil.nom) && m ? m.index + m[0].length : brut.length;
    for (let i = 0; i < brut.length;) {
      const lent = i >= visible;
      const pas = lent ? 3 : 24;
      envoyer({ tool_calls: [{ index: 0, function: { arguments: brut.slice(i, i + pas) } }] });
      i += pas;
      n++;
      await attendre(lent ? 14 : 8);
    }
    fin = "tool_calls";
  } else {
    for (const m of mots(etape.texte ?? "")) {
      envoyer({ content: m });
      n++;
      await attendre(22 + Math.floor(Math.random() * 14));
    }
  }
  const ms = n * 30;
  envoyer({}, fin, {
    usage: { prompt_tokens: nPrompt, completion_tokens: n, total_tokens: nPrompt + n },
    timings: {
      prompt_n: nPrompt,
      predicted_n: n,
      prompt_ms: nPrompt / 2.5,
      predicted_ms: ms,
      predicted_per_second: (n * 1000) / ms,
      prompt_per_second: 2500,
      cache_n: 0,
    },
  });
  rep.end("data: [DONE]\n\n");
}

export function demarrer(port: number, scenario: Scenario, journal?: string): void {
  createServer(async (req, rep) => {
    const chemin = (req.url ?? "/").split("?")[0];
    if (req.method === "GET") {
      if (chemin === "/health" || chemin === "/v1/health") return json(rep, { status: "ok" });
      if (chemin === "/props")
        return json(rep, {
          role: "single-model",
          total_slots: 2,
          model_alias: MODELE,
          model_path: `/models/${MODELE}.gguf`,
          default_generation_settings: { n_ctx: N_CTX, model: MODELE, params: { temperature: 0.7 } },
          modalities: { vision: false, audio: false },
          build_info: "demo",
          chat_template: "",
          chat_template_caps: {},
        });
      if (chemin === "/slots")
        return json(
          rep,
          [0, 1].map((id) => ({ id, id_task: -1, n_ctx: N_CTX, is_processing: false })),
        );
      if (chemin === "/v1/models" || chemin === "/models")
        return json(rep, {
          object: "list",
          data: [
            {
              id: MODELE,
              object: "model",
              created: 0,
              owned_by: "demo",
              status: { value: "loaded" },
              meta: { n_ctx_train: N_CTX },
            },
          ],
          models: [{ name: MODELE, model: MODELE }],
        });
      return json(rep, { error: { message: "not found", code: 404 } }, 404);
    }
    const corps = await lire(req);
    const messages = (corps["messages"] as Message[] | undefined) ?? [];
    const outils = (corps["tools"] as unknown[] | undefined) ?? [];
    if (journal)
      appendFileSync(
        journal,
        JSON.stringify({
          p: chemin,
          stream: corps["stream"],
          outils: outils.map((t) => (t as { function?: { name?: string } }).function?.name),
          roles: messages.map((m) => m.role),
          dernier: texteDe(messages.at(-1) ?? { role: "" }).slice(0, 300),
        }) + "\n",
      );
    if (chemin === "/tokenize")
      return json(rep, {
        tokens: [...Array(Math.ceil(JSON.stringify(corps["content"] ?? "").length / 4)).keys()],
      });
    if (chemin === "/apply-template") return json(rep, { prompt: messages.map(texteDe).join("\n") });
    if (chemin !== "/v1/chat/completions" && chemin !== "/chat/completions")
      return json(rep, { error: { message: "not found", code: 404 } }, 404);
    const nPrompt = 1800 + Math.ceil(messages.map(texteDe).join("").length / 4);
    // Requête annexe (titre du chat) : sans outils.
    const etape: Etape = outils.length === 0 ? { texte: scenario.titre } : etapeCourante(scenario, messages);
    if (corps["stream"]) return diffuser(rep, etape, nPrompt);
    return json(rep, {
      id: "cmpl-demo",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MODELE,
      choices: [
        { index: 0, message: { role: "assistant", content: etape.texte ?? "" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: nPrompt, completion_tokens: 8, total_tokens: nPrompt + 8 },
    });
  }).listen(port, "127.0.0.1");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [port, scene, journal] = process.argv.slice(2);
  const { scenario } = (await import(pathToFileURL(scene!).href)) as { scenario: Scenario };
  demarrer(Number(port), scenario, journal);
  console.log(`demo engine on 127.0.0.1:${port} (${scene})`);
}
