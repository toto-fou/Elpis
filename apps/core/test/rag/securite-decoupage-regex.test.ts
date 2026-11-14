// SPDX-License-Identifier: MIT
/** apps/core/test/rag/securite-decoupage-regex.test.ts — regex de découpage d'un utilisateur : hors de la boucle d'événements, limite du document entier, échec visible sans reprise automatique ; regex ordinaires et autres méthodes inchangées. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DECOUPAGE_RAG_DEFAUT } from "@elpis/contracts";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { decouperAvecRedecoupes, decouperHorsBoucle, ErreurRag } from "@elpis/rag";
import type { Bloc } from "@elpis/rag";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { apercuDecoupageRag, avecPlaceApercuRag, ecrireDecoupageDocumentRag } from "../../src/rag/decoupage";
import { ErreurRouteRag } from "../../src/rag/http";
import { ServiceIndexationRag } from "../../src/rag/service";
import { lireDocument } from "../../src/rag/travaux";
import { TravailleurRag } from "../../src/rag/travailleur";
import type { ReglagesTravailleurRag } from "../../src/rag/travailleur";
import {
  blocsDuTexte,
  creerCollection,
  creerCompte,
  demarrerFauxEmbeddings,
  demarrerFauxExtracteur,
  FauxQdrant,
  flux,
  JETON_EXTRACTEUR,
  jusqua,
} from "./aides-indexation";
import type { FauxEmbeddings, FauxExtracteur } from "./aides-indexation";

const ENV = ["RAG_SERVICE_URL", "RAG_SERVICE_TOKEN", "RAG_STORE_DIR", "ELPIS_RAG_ACCESS_DIR"] as const;
const RAPIDE: Partial<ReglagesTravailleurRag> = {
  tickActifMs: 15,
  tickInactifMs: 30,
  tickDesactiveMs: 30,
  battementMs: 30,
  attenteMinMs: 80,
  attenteMaxMs: 200,
  debitEvenementsMs: 40,
  arretMs: 5_000,
};
/** Motif à rebours exponentiel sur `aaa…!` : aucune exécution ne finit avant le délai de 2 s par exécution. */
const CATASTROPHE = "^(a+)+$";
const PIEGES = Array.from({ length: 6 }, (_, i) => `${"a".repeat(45)}!${i}`).join("\n\n");
const CONTRAT = "# Contrat\n\nArticle 1 alpha. Article 2 beta.\n\nArticle 3 gamma delta.";
const regex = (valeur: string): Record<string, unknown> => ({
  methode: "regex",
  valeur,
  unite: "caracteres",
  taille: 100,
  chevauchement: 0,
  taille_max: 200,
});
const PAR_PARAGRAPHE = {
  methode: "separateur",
  valeur: "\\n\\n",
  unite: "caracteres",
  taille: 100,
  chevauchement: 0,
  taille_max: 200,
};

/** Tours de la boucle d'événements pendant un calcul, et plus long écart entre deux tours. */
function sonderBoucle(): { tours: () => number; plusLongEcart: () => number; arreter: () => void } {
  let tours = 0;
  let ecart = 0;
  let dernier = Date.now();
  const minuterie = setInterval(() => {
    const t = Date.now();
    ecart = Math.max(ecart, t - dernier);
    dernier = t;
    tours++;
  }, 5);
  return { tours: () => tours, plusLongEcart: () => ecart, arreter: () => clearInterval(minuterie) };
}

async function codeRejet(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "accepte";
  } catch (e) {
    return e instanceof ErreurRag || e instanceof ErreurRouteRag ? e.code : String(e);
  }
}

describe("découpage avec regex hors de la boucle", () => {
  const blocs = blocsDuTexte(PIEGES) as Bloc[];
  const contrat = blocsDuTexte(CONTRAT) as Bloc[];
  const moteurRegex = (valeur: string) => ({ methode: "regex" as const, valeur, tailleJetons: 100 });

  it("une regex ordinaire donne exactement les passages du découpage sur place, redécoupes comprises", async () => {
    const params = moteurRegex("Article \\d");
    const redecoupes = [
      { index: 1, params: moteurRegex("beta") },
      { index: 9, params: moteurRegex("x") },
    ];
    const r = await decouperHorsBoucle(contrat, params, redecoupes, {
      regexLenteFatale: true,
      delaiMs: 60_000,
    });
    expect(r).toEqual(decouperAvecRedecoupes(contrat, params, redecoupes));
    expect(r.passages.length).toBeGreaterThan(2);
    expect(r.ignores).toEqual([9]);
  });

  it("sans regex, le découpage reste sur place et ne dépend pas de la limite du thread", async () => {
    const params = { methode: "taille" as const, tailleJetons: 20, chevauchementJetons: 0 };
    expect(await decouperHorsBoucle(contrat, params, [], { delaiMs: 0 })).toEqual(
      decouperAvecRedecoupes(contrat, params, []),
    );
  });

  it("une regex qui ne finit pas rend la main à la boucle et lève `delai` si le mode le demande", async () => {
    const sonde = sonderBoucle();
    const code = await codeRejet(
      decouperHorsBoucle(blocs, moteurRegex(CATASTROPHE), [], { regexLenteFatale: true, delaiMs: 60_000 }),
    );
    sonde.arreter();
    expect(code).toBe("delai");
    expect(sonde.tours()).toBeGreaterThan(10);
  });

  it("la limite du document tue le thread avant le délai de 2 s d'une exécution, qui retomberait sur la taille", async () => {
    const code = await codeRejet(decouperHorsBoucle(blocs, moteurRegex(CATASTROPHE), [], { delaiMs: 200 }));
    expect(code).toBe("delai");
  });

  it("l'abandon par l'appelant tue le thread et rend la raison du signal", async () => {
    const c = new AbortController();
    const p = decouperHorsBoucle(blocs, moteurRegex(CATASTROPHE), [], { delaiMs: 60_000, signal: c.signal });
    const raison = new Error("abandon du banc");
    setTimeout(() => c.abort(raison), 20);
    await expect(p).rejects.toBe(raison);
  });

  it("l'aperçu d'une regex catastrophique reste refusé en `regex_invalide`, hors de la boucle", async () => {
    const sonde = sonderBoucle();
    const code = await codeRejet(
      apercuDecoupageRag(blocs, DECOUPAGE_RAG_DEFAUT, "txt", {
        params: regex(CATASTROPHE) as never,
        redecoupes: [],
      }),
    );
    sonde.arreter();
    expect(code).toBe("regex_invalide");
    expect(sonde.tours()).toBeGreaterThan(10);
  });

  it("un aperçu à la fois par compte : la rafale attend son tour, puis 429 ; les autres comptes passent", async () => {
    const signal = new AbortController().signal;
    let liberer: () => void = () => undefined;
    const premier = avecPlaceApercuRag(
      1001,
      signal,
      () =>
        new Promise<string>((ok) => {
          liberer = () => ok("premier");
        }),
    );
    let deuxiemeLance = false;
    const deuxieme = avecPlaceApercuRag(1001, signal, async () => {
      deuxiemeLance = true;
      return "deuxieme";
    });
    expect(await avecPlaceApercuRag(1002, signal, async () => "autre compte")).toBe("autre compte");
    expect(await codeRejet(avecPlaceApercuRag(1001, signal, async () => "trop tard", 10))).toBe(
      "trop_de_requetes",
    );
    const parti = new AbortController();
    const abandonne = avecPlaceApercuRag(1001, parti.signal, async () => "jamais");
    parti.abort();
    expect(await codeRejet(abandonne)).toBe("decoupage_trop_long");
    expect(deuxiemeLance).toBe(false);
    liberer();
    expect(await premier).toBe("premier");
    expect(await deuxieme).toBe("deuxieme");
    expect(deuxiemeLance).toBe(true);
  });
});

describe("indexation d'un document avec une regex de découpage", () => {
  let dossier: string;
  let configJson: string;
  let magasin: string;
  let restaurer: () => void;
  let ext: FauxExtracteur;
  let emb: FauxEmbeddings;
  const avant = new Map<string, string | undefined>();

  let t: BaseDeTest;
  let alice: number;
  let q: FauxQdrant;
  let w: TravailleurRag;
  let service: ServiceIndexationRag;
  let ctrl: AbortController;
  let boucle: Promise<void>;

  beforeAll(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-rag-securite-regex-"));
    configJson = join(dossier, "config.json");
    magasin = join(dossier, "magasin");
    for (const k of ENV) avant.set(k, process.env[k]);
    for (const k of ENV) delete process.env[k];
    process.env["ELPIS_RAG_ACCESS_DIR"] = join(dossier, "temoin");
    restaurer = surchargerConfig({
      CONFIG_JSON_PATH: configJson,
      DB_PATH: join(dossier, "user_db", "app.db"),
    });
    ext = await demarrerFauxExtracteur(() => magasin);
    emb = await demarrerFauxEmbeddings();
  });

  afterAll(async () => {
    await ext.arreter();
    await emb.arreter();
    restaurer();
    for (const k of ENV) {
      const v = avant.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dossier, { recursive: true, force: true });
  });

  beforeEach(async () => {
    ext.demandes.length = 0;
    writeFileSync(
      configJson,
      JSON.stringify({
        rag: {
          store_dir: magasin,
          service_url: ext.url,
          service_token: JETON_EXTRACTEUR,
          qdrant_url: "http://127.0.0.1:9",
          embed: { url: emb.url, model: "m1", timeout_s: 5 },
          indexation: { concurrence: 2, par_compte: 1 },
        },
      }),
    );
    invalidateConfigCache();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    alice = await creerCompte(t.base, "alice");
    q = new FauxQdrant();
    w = new TravailleurRag({
      base: t.base,
      meneur: { tenu: true, essayer: async () => true },
      notifier: async () => undefined,
      qdrant: () => q,
      reglages: RAPIDE,
    });
    service = new ServiceIndexationRag({ base: t.base, travailleur: w, qdrant: () => q });
    ctrl = new AbortController();
    boucle = w.demarrer(ctrl.signal);
  });

  afterEach(async () => {
    ctrl.abort();
    await w.arreter();
    await boucle;
    await t.fermer();
    rmSync(magasin, { recursive: true, force: true });
  });

  const fileVide = async (): Promise<void> =>
    jusqua(async () => {
      const [n] = await t.base.valeurs<[unknown]>(
        "SELECT COUNT(*) FROM rag_jobs WHERE status IN ('queued', 'running', 'paused')",
      );
      return Number(n?.[0]) === 0;
    }, "plus aucun travail actif");
  const deposer = async (col: string, nom: string, contenu: string): Promise<string> =>
    (await service.deposer(alice, col, { nom, flux: flux(contenu) })).document.id;
  const ligne = async (id: string): Promise<Record<string, unknown>> =>
    (await t.base.get("SELECT * FROM rag_documents WHERE id=?", [id])) ?? {};
  const textesIndexes = (): string[] =>
    [...q.collections.values()]
      .flatMap((c) => [...c.points.values()])
      .sort((a, b) => a.charge.chunk_index - b.charge.chunk_index)
      .map((p) => p.charge.text);

  it("regex de base catastrophique : document en échec, message en français, aucune reprise automatique", async () => {
    const col = await creerCollection(t.base, alice, "Pieges", { chunk: regex(CATASTROPHE) });
    const id = await deposer(col, "piege.txt", PIEGES);
    await fileVide();
    const d = await ligne(id);
    expect(d["status"]).toBe("error");
    expect(d["error_code"]).toBe("chunking_timeout");
    expect(d["error_message"]).toContain("Découpage trop long");
    const [job] = await t.base.valeurs<[unknown, unknown]>("SELECT failed, status FROM rag_jobs");
    expect(job).toEqual([1, "done"]);
    expect(textesIndexes()).toEqual([]);
    const demandes = ext.demandes.length;
    await new Promise((r) => setTimeout(r, 200));
    expect((await ligne(id))["status"]).toBe("error");
    expect(ext.demandes.length).toBe(demandes);
  });

  it("limite du document atteinte avant la fin d'une exécution : même échec, sans attendre son délai", async () => {
    ctrl.abort();
    await w.arreter();
    await boucle;
    w = new TravailleurRag({
      base: t.base,
      meneur: { tenu: true, essayer: async () => true },
      notifier: async () => undefined,
      qdrant: () => q,
      reglages: { ...RAPIDE, decoupageMs: 1 },
    });
    service = new ServiceIndexationRag({ base: t.base, travailleur: w, qdrant: () => q });
    ctrl = new AbortController();
    boucle = w.demarrer(ctrl.signal);
    const col = await creerCollection(t.base, alice, "Limite", { chunk: regex(CATASTROPHE) });
    const id = await deposer(col, "piege.txt", PIEGES);
    await fileVide();
    expect((await ligne(id))["error_code"]).toBe("chunking_timeout");
  });

  it("redécoupes catastrophiques : la boucle reste libre, et un meilleur découpage relancé par l'utilisateur aboutit", async () => {
    const col = await creerCollection(t.base, alice, "Redecoupes", { chunk: PAR_PARAGRAPHE });
    const id = await deposer(col, "piege.txt", PIEGES);
    await fileVide();
    expect((await ligne(id))["status"]).toBe("ready");
    const doc = await lireDocument(t.base, id);
    if (doc === null) throw new Error("document absent");

    ecrireDecoupageDocumentRag(alice, col, id, doc.sha256, {
      redecoupes: [0, 1, 2, 3].map((index) => ({ index, params: regex(CATASTROPHE) as never })),
    });
    const sonde = sonderBoucle();
    await service.reindexer(alice, col, { documents: [id] });
    await fileVide();
    sonde.arreter();
    expect(sonde.plusLongEcart()).toBeLessThan(5_000);
    expect((await ligne(id))["error_code"]).toBe("chunking_timeout");

    ecrireDecoupageDocumentRag(alice, col, id, doc.sha256, {
      redecoupes: [{ index: 0, params: regex("a{10}") as never }],
    });
    await service.reindexer(alice, col, { documents: [id] });
    await fileVide();
    const apres = await ligne(id);
    expect(apres["status"]).toBe("ready");
    expect(apres["error_code"]).toBeNull();
  });

  it("regex ordinaire : mêmes passages indexés que le découpage direct", async () => {
    const col = await creerCollection(t.base, alice, "Contrats", { chunk: regex("Article \\d") });
    const id = await deposer(col, "contrat.txt", CONTRAT);
    await fileVide();
    const d = await ligne(id);
    expect(d["status"]).toBe("ready");
    const attendu = decouperAvecRedecoupes(
      blocsDuTexte(CONTRAT) as Bloc[],
      {
        methode: "regex",
        valeur: "Article \\d",
        tailleJetons: 100,
        tailleMaxJetons: 200,
        chevauchementJetons: 0,
        caracteresParJeton: 1,
      },
      [],
    ).passages.map((p) => p.text);
    expect(attendu.length).toBeGreaterThan(1);
    expect(d["chunk_count"]).toBe(attendu.length);
    expect(textesIndexes()).toEqual(attendu);
  });
});
