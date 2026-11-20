// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/securite-compte-suspendu-boucle.test.ts — une exécution en cours relit l'état du compte à chaque étape et avant chaque lot d'outils, et s'arrête sans événement de suspension ; une lecture en échec ne tue pas un compte actif. */
import "../moteur-environnement";

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createUser } from "@elpis/auth";
import { CancelledError, pyJsonDumps } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { runChatMultiMcp } from "../../src/boucle/orchestrateur";
import { brancherBoucle } from "../../src/boucle/branchements";
import {
  compteSuspenduLu,
  installerCompteSuspendu,
  installerDormir,
  installerTokenHex,
} from "../../src/boucle/ports";
import {
  installerPortCompresseur,
  installerProfilReseau,
  installerPromptsCapacites,
} from "../../src/contexte/ports";
import { EngineRef, useEngine } from "../../src/llm/moteurs";
import { oublierSondes } from "../../src/llm/sonde-moteur";
import type { OutilIntegre } from "../../src/outils/catalogue";
import type { Dict } from "../../src/python";
import { data, FauxClient } from "./faux-moteur";
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

const BLOC = '<tool_call>{"name": "zeta_shell", "arguments": {"command": "ls"}}</tool_call>';
let suspendu = false;
let lectures: number[] = [];
let lectureEnPanne = false;

const ecrit = (t: string): string => data({ choices: [{ delta: { content: t } }] });
const fin = (raison = "stop"): string[] => [
  data({
    choices: [{ delta: {}, finish_reason: raison }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  }),
  "data: [DONE]",
];
const dit = (t: string): string[] => [ecrit(t), ...fin()];

let evenements: Dict[] = [];
let lances: string[] = [];
let infosMoteur: { statut: number; corps: unknown } = { statut: 200, corps: {} };
let racineMoteur = "";

const serveurInfos = createServer((_req, res) => {
  res.writeHead(infosMoteur.statut, { "content-type": "application/json" });
  res.end(JSON.stringify(infosMoteur.corps));
});

beforeAll(async () => {
  await new Promise<void>((ok) => serveurInfos.listen(0, "127.0.0.1", ok));
  racineMoteur = `http://127.0.0.1:${(serveurInfos.address() as AddressInfo).port}`;
});
afterAll(async () => {
  serveurInfos.closeAllConnections();
  await new Promise((ok) => serveurInfos.close(ok));
});

function zetaShell(): OutilIntegre {
  return {
    definition: {
      type: "function",
      function: {
        name: "zeta_shell",
        description: "Outil de test.",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    },
    handler: async (args: Dict) => {
      lances.push(String(args["command"] ?? ""));
      return pyJsonDumps({ ok: true });
    },
  };
}

beforeEach(() => {
  evenements = [];
  lances = [];
  infosMoteur = { statut: 200, corps: {} };
  oublierSondes();
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
  oublierSondes();
});

const moteurDe = (type: string): EngineRef =>
  new EngineRef({ key: `conn:${type.length}`, baseRoot: racineMoteur, providerType: type });

beforeEach(() => {
  suspendu = false;
  lectureEnPanne = false;
  lectures = [];
  installerCompteSuspendu(async (uid) => {
    lectures.push(uid);
    if (lectureEnPanne) throw new Error("base indisponible");
    return suspendu;
  });
});
afterEach(() => installerCompteSuspendu(null));

const lancer = (client: FauxClient, userId: number | null = 7): Promise<unknown> => {
  etat.client = client;
  return useEngine(moteurDe("llamacpp"), () =>
    runChatMultiMcp({
      messages: [
        { role: "system", content: "Tête de test." },
        { role: "user", content: "Lance." },
      ],
      mcpConfigs: [],
      builtinTools: { zeta_shell: zetaShell() },
      username: "alice",
      userId,
      chatId: "c1",
      model: "m",
      memoryEnabled: false,
      compressionEnabled: false,
      onEvent: (ev) => void evenements.push(structuredClone(ev)),
      deps: { recordMetric: () => undefined },
    }),
  );
};

describe("boucle : compte suspendu relu à chaque étape, sans événement", () => {
  it("suspendu avant la première étape : aucune requête au moteur", async () => {
    suspendu = true;
    const client = new FauxClient([dit("Bonjour.")]);
    await expect(lancer(client)).rejects.toBeInstanceOf(CancelledError);
    expect(client.nStream).toBe(0);
  });

  it("suspendu pendant un lot d'outils : l'étape suivante n'a pas lieu", async () => {
    const client = new FauxClient([dit(BLOC), dit("Fait.")]);
    let n = 0;
    installerCompteSuspendu(async () => (n++, n > 3));
    await expect(lancer(client)).rejects.toBeInstanceOf(CancelledError);
    expect(client.nStream).toBe(1);
    expect(lances).toEqual(["ls"]);
  });

  it("suspendu pendant un lot de trois outils : l'outil dont la relecture voit la suspension et les suivants ne sont pas lancés", async () => {
    const trois = ["a", "b", "c"]
      .map((c) => `<tool_call>{"name": "zeta_shell", "arguments": {"command": "${c}"}}</tool_call>`)
      .join("");
    const client = new FauxClient([dit(trois), dit("Fait.")]);
    let n = 0;
    installerCompteSuspendu(async () => (n++, n > 4));
    await expect(lancer(client)).rejects.toBeInstanceOf(CancelledError);
    expect(client.nStream).toBe(1);
    expect([...lances].sort()).toEqual(["a", "b"]);
  });

  it("le vrai branchement relit la base : seule la colonne de suspension est lue, un compte inconnu est actif", async () => {
    const t = ouvrirBaseDeTest("sqlite");
    try {
      await initialiserBase(t.base);
      const uid = await createUser(t.base, "alice", "mdp-alice", { isAdmin: 0 });
      const requetes: string[] = [];
      const espion = new Proxy(t.base, {
        get: (c, p) => {
          const v = Reflect.get(c, p) as unknown;
          if (p !== "get") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(c) : v;
          return (sql: string, ...r: unknown[]) => {
            requetes.push(sql);
            return (v as (...a: unknown[]) => unknown).call(c, sql, ...r);
          };
        },
      });
      brancherBoucle(espion as typeof t.base);
      const lire = (u: number): Promise<boolean> => compteSuspenduLu(u, () => undefined);
      expect(await lire(uid)).toBe(false);
      await t.base.run("UPDATE users SET suspended_at=100 WHERE id=?", [uid]);
      expect(await lire(uid)).toBe(true);
      expect(await lire(uid + 99)).toBe(false);
      expect(requetes.every((s) => /^SELECT suspended_at FROM users WHERE id\s*=\s*\?$/u.test(s))).toBe(true);
    } finally {
      await t.fermer();
    }
  });

  it("suspendu entre la réponse du modèle et le lot d'outils : l'outil n'est pas lancé", async () => {
    const client = new FauxClient([dit(BLOC), dit("Fait.")]);
    let n = 0;
    installerCompteSuspendu(async () => (n++, n > 1));
    await expect(lancer(client)).rejects.toBeInstanceOf(CancelledError);
    expect(client.nStream).toBe(1);
    expect(lances).toEqual([]);
  });

  it("lecture de l'état en échec : le compte actif continue", async () => {
    lectureEnPanne = true;
    const client = new FauxClient([dit(BLOC), dit("Fait.")]);
    await lancer(client);
    expect(client.nStream).toBe(2);
    expect(lances).toEqual(["ls"]);
  });

  it("compte inconnu de l'appelant (userId absent) : aucune lecture", async () => {
    const client = new FauxClient([dit("Bonjour.")]);
    await lancer(client, null);
    expect(lectures).toEqual([]);
  });
});
