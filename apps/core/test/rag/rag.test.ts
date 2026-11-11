// SPDX-License-Identifier: MIT
/** apps/core/test/rag/rag.test.ts — adresse, jeton et sonde de santé du service rag_app contre un faux service HTTP (vecteurs Python). */
import { DOSSIER_MOTEUR } from "../moteur-environnement";

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { surchargerConfig } from "@elpis/config";

import { getServiceToken, getServiceUrl, isConfigured, ping } from "../../src/rag/client";
import { decoder, lireVecteurs } from "../vecteurs-moteur";

type Dict = Record<string, unknown>;
type Flux = { statut: number; morceaux: string[] };
type Issue = { valeur: unknown } | { erreur: string; message: string };

const V = lireVecteurs<Record<string, unknown>>("rag");
const BASE_PY = "http://rag.test:8000";
const AUTRE_PY = "http://autre:1";
const ENV_RAG = ["RAG_SERVICE_URL", "RAG_SERVICE_TOKEN", "RAG_SERVICE_TIMEOUT"];

interface FauxService {
  base: string;
  requetes: Dict[];
  flux: Flux | null;
  http: Server;
}

async function demarrer(): Promise<FauxService> {
  const s: FauxService = { base: "", requetes: [], flux: null, http: createServer() };
  s.http.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const morceaux: Buffer[] = [];
      for await (const m of req) morceaux.push(m as Buffer);
      s.requetes.push({
        methode: req.method,
        url: `${s.base}${req.url ?? ""}`,
        corps: Buffer.concat(morceaux).toString("utf8"),
        authorization: req.headers.authorization ?? null,
        accept: req.headers.accept ?? null,
      });
      const flux = s.flux ?? { statut: 500, morceaux: [] };
      res.writeHead(flux.statut, { "content-type": "text/event-stream" });
      for (const m of flux.morceaux) {
        res.write(Buffer.from(m, "utf8"));
        await new Promise((r) => setTimeout(r, 1));
      }
      res.end();
    })();
  });
  await new Promise<void>((r) => s.http.listen(0, "127.0.0.1", () => r()));
  s.base = `http://127.0.0.1:${(s.http.address() as AddressInfo).port}`;
  return s;
}

let rag: FauxService;
let autre: FauxService;

/** Valeurs du vecteur où les URL Python deviennent celles des faux services. */
function localiser(v: unknown): unknown {
  if (typeof v === "string")
    return v.replaceAll("<RAG>", rag.base).replaceAll(BASE_PY, rag.base).replaceAll(AUTRE_PY, autre.base);
  if (Array.isArray(v)) return v.map(localiser);
  if (typeof v === "object" && v !== null)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, localiser(x)]));
  return v;
}

/** `_service` : config.json (section rag) et racine dans un temporaire, variables RAG_* posées. */
function service(
  cfg: Dict = { env: {}, rag: { service_url: BASE_PY, service_token: "jeton-rag" } },
): () => void {
  const dossier = mkdtempSync(path.join(DOSSIER_MOTEUR, "rag-"));
  writeFileSync(path.join(dossier, "config.json"), JSON.stringify({ rag: localiser(cfg["rag"]) }));
  if (cfg["fichier_jeton"] !== undefined) {
    mkdirSync(path.join(dossier, "user_db"));
    writeFileSync(path.join(dossier, "user_db", ".rag_service_token"), cfg["fichier_jeton"] as string);
  }
  const avant = Object.fromEntries(ENV_RAG.map((k) => [k, process.env[k]]));
  for (const k of ENV_RAG) delete process.env[k];
  Object.assign(process.env, cfg["env"] as Dict);
  const restaurer = surchargerConfig({
    CONFIG_JSON_PATH: path.join(dossier, "config.json"),
    PROJECT_ROOT: dossier,
  });
  rag.requetes = [];
  autre.requetes = [];
  return () => {
    restaurer();
    for (const k of ENV_RAG) delete process.env[k];
    for (const [k, v] of Object.entries(avant)) if (v !== undefined) process.env[k] = v;
  };
}

async function issue(f: () => Promise<unknown>): Promise<Issue> {
  try {
    return { valeur: await f() };
  } catch (e) {
    return {
      erreur: e instanceof Error ? e.name : typeof e,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

beforeAll(async () => {
  rag = await demarrer();
  autre = await demarrer();
});

afterAll(async () => {
  for (const s of [rag, autre]) {
    s.http.closeAllConnections();
    await new Promise<void>((r) => s.http.close(() => r()));
  }
});

describe("configuration du service", () => {
  it("URL et jeton : environnement > config.json > fichier de jeton", () => {
    for (const c of V["configs"] as Dict[]) {
      const fin = service(c);
      try {
        expect(
          {
            url: getServiceUrl(),
            jeton: getServiceToken(),
            configure: isConfigured(),
          },
          JSON.stringify(c),
        ).toEqual({ url: c["url"], jeton: c["jeton"], configure: c["configure"] });
      } finally {
        fin();
      }
    }
  });
});

describe("santé", () => {
  it("ping : jeton envoyé au seul service configuré (jamais à une URL tierce sans jeton explicite)", async () => {
    for (const c of V["pings"] as Dict[]) {
      const fin = service();
      rag.flux = autre.flux = { statut: c["statut"] as number, morceaux: [c["corps"] as string] };
      try {
        const obtenu = await issue(() =>
          ping(localiser(c["url"]) as string | null, (c["jeton"] as string | null) ?? null),
        );
        expect(obtenu, JSON.stringify([c["statut"], c["url"], c["jeton"]])).toEqual(
          localiser(decoder(c["out"])),
        );
        expect([...rag.requetes, ...autre.requetes]).toEqual(localiser(c["requetes"]));
      } finally {
        fin();
      }
    }
  });
});
