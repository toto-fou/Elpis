// SPDX-License-Identifier: MIT
/** apps/core/test/images/moteurs.test.ts — moteurs d'images contre de faux serveurs locaux : Stop, délais, TLS de la PKI interne, plafonds, pannes. */
import { afterEach, describe, expect, it } from "vitest";

import { chargerJsonPy, pyJsonLoads } from "@elpis/commun";

import { ImageError, imageRequest } from "../../src/images/base";
import { avecClient, fetch } from "../../src/images/http";
import { OpenAIProvider } from "../../src/images/openai";
import { SdcppProvider } from "../../src/images/sdcpp";
import { CA_TEST, CERT_SERVEUR, CLE_SERVEUR } from "../llm/pki-test";
import { portFerme } from "../llm/faux-serveur";
import { FauxMoteur } from "./faux-moteur";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAUklEQVR4nO3PMQ0AIADAMEAI/qUgCxEcDcmqYJtn7/GzpQNeNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oF2vFwFk2XER3gAAAABJRU5ErkJggg==",
  "base64",
);
const json = (v: unknown): { texte: string } => ({ texte: JSON.stringify(v) });
const sansSuivi = (): void => undefined;

let moteurs: FauxMoteur[] = [];
async function moteur(options: { cert?: string; cle?: string } = {}): Promise<FauxMoteur> {
  const m = await FauxMoteur.demarrer(options);
  moteurs.push(m);
  return m;
}
afterEach(async () => {
  await Promise.all(moteurs.map((m) => m.arreter()));
  moteurs = [];
});

async function erreur(p: Promise<unknown>): Promise<ImageError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ImageError) return e;
    throw e;
  }
  throw new Error("aucune erreur levée");
}

describe("sd-server", () => {
  it("Stop pendant le sondage : le job est annulé côté serveur, l'erreur est « cancelled »", async () => {
    const m = await moteur();
    m.file("POST /sdcpp/v1/img_gen", [{ statut: 202, ...json({ id: "j9" }) }]);
    m.file("GET /sdcpp/v1/jobs/j9", [json({ status: "queued", queue_position: 3 })]);
    m.file("POST /sdcpp/v1/jobs/j9/cancel", [{ statut: 200, texte: "{}" }]);
    const stop = new AbortController();
    const suivi: unknown[] = [];
    const p = new SdcppProvider(m.url, { sondage: { premier: 0.05, max: 0.05 } }).generate(
      imageRequest({ prompt: "x", width: 64, height: 64, seed: 1 }),
      (state, qp) => {
        suivi.push([state, qp]);
        stop.abort();
      },
      stop.signal,
    );
    const e = await erreur(p);
    expect([e.code, e.message, e.retryable]).toEqual(["cancelled", "Génération annulée.", true]);
    expect(suivi).toEqual([["queued", 3]]);
    expect(m.sur("/sdcpp/v1/jobs/j9/cancel")).toHaveLength(1);
    const apres = m.requetes.findIndex((r) => r.chemin.endsWith("/cancel"));
    expect(m.requetes.slice(apres + 1)).toEqual([]);
  });

  it("Stop avant la soumission : rien ne part vers le moteur", async () => {
    const m = await moteur();
    const stop = new AbortController();
    stop.abort();
    const e = await erreur(
      new SdcppProvider(m.url).generate(
        imageRequest({ prompt: "x", width: 64, height: 64 }),
        sansSuivi,
        stop.signal,
      ),
    );
    expect(e.code).toBe("cancelled");
    expect(m.requetes).toEqual([]);
  });

  it("annulation impossible (moteur parti) : l'erreur d'origine remonte", async () => {
    const m = await moteur();
    m.file("POST /sdcpp/v1/img_gen", [{ statut: 202, ...json({ id: "j1" }) }]);
    m.file("GET /sdcpp/v1/jobs/j1", [{ statut: 500, ...json({ error: "panne" }) }]);
    m.file("POST /sdcpp/v1/jobs/j1/cancel", [{ panne: "coupé" }]);
    const e = await erreur(
      new SdcppProvider(m.url, { sondage: { premier: 0, max: 0 } }).generate(
        imageRequest({ prompt: "x", width: 64, height: 64, seed: 1 }),
        sansSuivi,
      ),
    );
    expect([e.code, e.message, e.status]).toEqual(["engine", "Moteur d'images en erreur (HTTP 500).", 500]);
    expect(m.sur("/sdcpp/v1/jobs/j1/cancel")).toHaveLength(1);
  });

  it("moteur éteint : « injoignable », détail au journal seulement", async () => {
    const port = await portFerme();
    const e = await erreur(new SdcppProvider(`http://127.0.0.1:${port}`).capabilities());
    expect(e.code).toBe("unavailable");
    expect(e.message).toBe(
      "Moteur d'images injoignable. Vérifiez Administration › Modèles et services › Images.",
    );
    expect(e.detail).toContain(`127.0.0.1:${port}`);
  });

  it("réponse de contrôle démesurée sans longueur annoncée : coupée au plafond (too_large)", async () => {
    const m = await moteur();
    m.route("GET /sdcpp/v1/capabilities", (_r, rep) => {
      rep.writeHead(200, { "content-type": "application/json" });
      const bloc = Buffer.alloc(256 * 1024, 0x20);
      for (let i = 0; i < 12; i++) rep.write(bloc);
      rep.end("{}");
    });
    const e = await erreur(new SdcppProvider(m.url).capabilities());
    expect([e.code, e.message]).toEqual(["too_large", "Réponse du moteur trop volumineuse."]);
  });
});

describe("OpenAI", () => {
  it("Stop pendant l'appel : la requête est abandonnée (le serveur voit la coupure)", async () => {
    const m = await moteur();
    let coupe = false;
    m.route("POST /v1/images/generations", (_r, rep) => {
      rep.on("close", () => (coupe = !rep.writableFinished));
    });
    const stop = new AbortController();
    const p = new OpenAIProvider(m.url, { model: "m" }).generate(
      imageRequest({ prompt: "x", width: 64, height: 64 }),
      () => {
        setTimeout(() => stop.abort(), 50);
      },
      stop.signal,
    );
    const e = await erreur(p);
    expect(e.code).toBe("cancelled");
    await new Promise((ok) => setTimeout(ok, 50));
    expect(coupe).toBe(true);
  });

  it("délai de l'administrateur dépassé : « timeout »", async () => {
    const m = await moteur();
    m.route("POST /v1/images/generations", () => undefined);
    const e = await erreur(
      new OpenAIProvider(m.url, { model: "m", timeoutSec: 1 }).generate(
        imageRequest({ prompt: "x", width: 64, height: 64 }),
        sansSuivi,
      ),
    );
    expect(e.code).toBe("timeout");
  });

  it("la clé part avec l'appel, jamais avec le téléchargement d'une image", async () => {
    const m = await moteur();
    m.route("POST /v1/images/generations", (_r, rep) => {
      rep.writeHead(200, { "content-type": "application/json" });
      rep.end(JSON.stringify({ data: [{ url: `${m.url}/f/x.png` }] }));
    });
    m.file("GET /f/x.png", [{ octets: PNG.toString("base64") }]);
    const out = await new OpenAIProvider(m.url, { model: "gpt-image-1", apiKey: "secret" }).generate(
      imageRequest({ prompt: "x", width: 64, height: 64 }),
      sansSuivi,
    );
    expect([out.length, out[0]?.mime, out[0]?.width]).toEqual([1, "image/png", 64]);
    expect(m.sur("/v1/images/generations")[0]?.entetes["authorization"]).toBe("Bearer secret");
    expect(m.sur("/f/x.png")[0]?.entetes["authorization"]).toBeUndefined();
  });
});

describe("TLS : PKI interne", () => {
  it("CA collée en console : connexion vérifiée ; sans elle : refusée ; case décochée : acceptée", async () => {
    const m = await moteur({ cert: CERT_SERVEUR, cle: CLE_SERVEUR });
    m.file("GET /sdcpp/v1/capabilities", [json({ model: { name: "m.gguf" } })]);
    const avecCa = await new SdcppProvider(m.url, { caPem: CA_TEST }).capabilities();
    expect(avecCa["model"]).toBe("m.gguf");
    const refus = await erreur(new SdcppProvider(m.url).capabilities());
    expect(refus.code).toBe("unavailable");
    const sansVerif = await new SdcppProvider(m.url, { verify: false, caPem: "nimporte" }).capabilities();
    expect(sansVerif["model"]).toBe("m.gguf");
    const illisible = await erreur(
      new SdcppProvider(m.url, {
        caPem: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
      }).capabilities(),
    );
    expect([illisible.code, illisible.message]).toEqual([
      "unavailable",
      "Autorité de certification illisible. Vérifiez Administration › Modèles et services › Images.",
    ]);
  });

  it("le pool d'un appel est fermé à la sortie (aucune connexion laissée ouverte)", async () => {
    const m = await moteur();
    m.file("GET /x", [{ texte: "ok" }]);
    await avecClient(5, {}, async (c) => {
      const r = await fetch(c, "GET", `${m.url}/x`);
      expect(r.text).toBe("ok");
    });
    await new Promise((ok) => setTimeout(ok, 50));
    const sockets = (m as unknown as { sockets: Set<unknown> }).sockets.size;
    expect(sockets).toBe(0);
  });
});

describe("réponses JSON : analyse native, même rendu que `pyJsonLoads`", () => {
  it("flottants entiers, entiers longs, -0, NaN, clés, erreurs ; un lot de 32 Mo sans bloquer la boucle", () => {
    const issue = (f: () => unknown): unknown => {
      try {
        return { valeur: f() };
      } catch (e) {
        return { erreur: String(e) };
      }
    };
    const textes = [
      '{"a": 1, "b": 1.0, "c": -0, "d": -0.0, "e": 1e400, "f": 12345678901234567890, "g": 0.5, "h": [1E2, 2e-3, -1.5e+3]}',
      '{"__proto__": {"x": 1}, "2": "deux", "1": "un", "a": "\\u00e9\\ud83d\\ude00\\ud800", "a": 3}',
      "[NaN, Infinity, -Infinity, -0.0]",
      "1" + "0".repeat(4301),
      "-" + "9".repeat(4300),
      "",
      "[1,]",
      '{"a" 1}',
      "\ufeff{}",
      "  [ ]  ",
      "null",
      '"\\x"',
      "01",
      '["\u0001"]',
    ];
    for (const t of textes)
      expect(
        issue(() => chargerJsonPy(t)),
        t.slice(0, 40),
      ).toStrictEqual(issue(() => pyJsonLoads(t)));
    const lot = JSON.stringify({ data: [{ b64_json: "A".repeat(32 * 1024 * 1024) }] });
    const t0 = performance.now();
    const v = chargerJsonPy(lot) as { data: { b64_json: string }[] };
    expect(v.data[0]?.b64_json.length).toBe(32 * 1024 * 1024);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
