// SPDX-License-Identifier: MIT
/** apps/core/test/parite/capture.test.ts — rejeu de forme de la capture de parité : fonctions de capture_parite.py rejouées sur leurs vecteurs, export réel du middleware Python rejoué sur l'app composée ; ELPIS_CAPTURE_EXPORT=<dossier des captures> rejoue un export de recette. */
import "../moteur-environnement";

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { estDict, pyJsonLoads, strPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { creerGardes } from "@elpis/auth";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase, ouvrirBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerChiffrement, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { remplacerBase } from "../../src/base";
import { upsertChat } from "../../src/chats/stockage";
import { composer } from "../../src/composition";
import { installerCrochetJournal } from "../../src/journal";
import { installerRelaisModeles } from "../../src/llm/cache-modeles";
import { installerDiffusion } from "../../src/llm/ports";
import { appTest, journalMuet, lignesJournal } from "../aides";
import { dependancesAuth, gardesDeTest } from "../exploitation/aides";
import {
  Anonymiseur,
  attribuerChemins,
  compatibles,
  comparer,
  forme,
  rejouerCapture,
  signature,
} from "./capture";
import type { RequeteConcrete, Rejeu } from "./capture";

const V = pyJsonLoads(readFileSync(new URL("../vecteurs/capture-parite.json", import.meta.url), "utf-8")) as {
  entrees: {
    cle: string;
    cles: unknown[];
    valeurs: [string, unknown][];
    corps: [string, string, number | null][];
    formes: unknown[];
    compat: [unknown, unknown][];
    signatures: Dict[];
    signatures_en_plus: Dict[];
    comparaisons: [number, number][];
    comparaisons_en_plus: [number, number][];
    chats: [number, string, string, Dict[], number][];
  };
  sorties: {
    pures: {
      cles: string[];
      valeurs: unknown[];
      corps: unknown[];
      formes: unknown[];
      compatibles: boolean[];
      signatures: Dict[];
      comparaisons: string[][];
    };
    export: Dict[];
  };
};
const E = V.entrees;
const A = new Anonymiseur(Buffer.from(E.cle, "utf-8"));

describe("capture_parite.py rejoué (vecteurs)", () => {
  it("clés, valeurs et corps anonymisés comme le Python", () => {
    expect(E.cles.map((k) => A.nomDeCle(k))).toEqual(V.sorties.pures.cles);
    expect(E.valeurs.map(([c, v]) => A.valeur(c, v))).toEqual(V.sorties.pures.valeurs);
    expect(E.corps.map(([b, ct, t]) => A.corps(Buffer.from(b, "utf-8"), ct, t))).toEqual(
      V.sorties.pures.corps,
    );
  });

  it("forme, compatibilité, signature et comparaison comme le Python", () => {
    expect(E.formes.map((x) => forme(x))).toEqual(V.sorties.pures.formes);
    expect(E.compat.map(([a, b]) => compatibles(a, b))).toEqual(V.sorties.pures.compatibles);
    const toutes = [...E.signatures, ...E.signatures_en_plus];
    expect(toutes.map((c) => signature(c))).toEqual(V.sorties.pures.signatures);
    expect(
      [...E.comparaisons, ...E.comparaisons_en_plus].map(([i, j]) => comparer(toutes[i]!, toutes[j]!)),
    ).toEqual(V.sorties.pures.comparaisons);
  });
});

describe("chemins réels des captures (identifiants-chemins.jsonl)", () => {
  it("k-ième requête de la clé (process, méthode, gabarit le plus littéral, classe de statut) ; requêtes différées (statut 0) ignorées", () => {
    const cap = (gabarit: string, statut: number): Dict => ({
      process: "main",
      methode: "GET",
      gabarit,
      reponse: { statut },
    });
    const req = (chemin: string, statut: number, qui: string | null = "a"): RequeteConcrete => ({
      process: "main",
      methode: "GET",
      chemin,
      qui,
      statut,
    });
    const captures = [
      cap("/api/x/{id}", 200),
      cap("/api/x/search", 200),
      cap("/api/x/{id}", 404),
      cap("/api/x/{id}", 200),
      cap("/api/f/{p:path}", 200),
      cap("/api/x/{id}", 200),
    ];
    const requetes = [
      req("/api/x/1", 0),
      req("/api/x/search", 200),
      req("/api/x/2", 200, null),
      req("/api/x/3", 404),
      req("/api/x/4", 201),
      req("/api/f/a/b.txt", 200),
    ];
    expect(attribuerChemins(captures, requetes).map((r) => r && `${r.chemin} ${String(r.qui)}`)).toEqual([
      "/api/x/2 null",
      "/api/x/search a",
      "/api/x/3 a",
      "/api/x/4 a",
      "/api/f/a/b.txt a",
      null,
    ]);
  });
});

/** App main composée sur une base préparée, comptes par `x-uid`. */
async function appComposee(t: BaseDeTest): Promise<{ app: FastifyInstance; fermer: () => Promise<void> }> {
  const c = await composer("main", t.base, journalMuet, dependancesAuth(t.base));
  const app = await appTest({ ...c, mode: "main", gardes: gardesDeTest(t.base) });
  return {
    app,
    fermer: async () => {
      await app.close();
      c.evenements.systemEvents.fermer({ type: "fin" });
    },
  };
}

describe("export du middleware Python rejoué sur l'app TS", () => {
  let dossier: string;
  let restaurer: () => void;
  let t: BaseDeTest;
  const auditAvant = process.env["ELPIS_AUDIT_DIR"];

  beforeAll(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-parite-"));
    writeFileSync(join(dossier, "config.json"), "{}");
    process.env["ELPIS_AUDIT_DIR"] = join(dossier, "audit");
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await t.base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES('alice', 's', 'h', 0, 0)",
    );
    for (const [uid, id, titre, messages, ts] of E.chats)
      await upsertChat(t.base, uid, id, titre, messages, ts);
  });

  afterAll(async () => {
    await t.fermer();
    restaurer();
    if (auditAvant === undefined) delete process.env["ELPIS_AUDIT_DIR"];
    else process.env["ELPIS_AUDIT_DIR"] = auditAvant;
    oublierConfigurationAudit();
    installerCrochetJournal(null);
    installerDiffusion(null);
    installerRelaisModeles(null);
    rmSync(dossier, { recursive: true, force: true });
  });

  it("chaque capture rejouable a la même signature ; les autres sont comptées avec leur raison", async () => {
    const { app, fermer } = await appComposee(t);
    try {
      const bilan: [string, string][] = [];
      for (const c of V.sorties.export) {
        const r = await rejouerCapture(app, c, { "x-uid": "1" }, A);
        bilan.push([
          `${String(c["methode"])} ${String(c["gabarit"])}`,
          r.rejouee ? r.ecarts.join(" ; ") || "parité" : `non rejouable : ${r.raison}`,
        ]);
      }
      expect(bilan).toEqual([
        ["GET /api/saved/chats", "parité"],
        ["GET /api/saved/chats/{chat_id}", "parité"],
        ["GET /api/saved/chats/{chat_id}", "parité"],
        ["GET /api/chat/{chat_id}/compression-state", "parité"],
        ["GET /api/chat/{chat_id}/compression-state", "parité"],
        ["POST /api/chat/cancel", "parité"],
        ["POST /api/chat/{chat_id}/compress", "parité"],
        ["GET <non routé>", "non rejouable : non routé"],
        ["POST /api/chat-saved-stream3", "non rejouable : corps non JSON"],
      ]);
    } finally {
      await fermer();
    }
  });
});

const EXPORT = process.env["ELPIS_CAPTURE_EXPORT"];
const CHEMINS = process.env["ELPIS_CAPTURE_CHEMINS"];
const COMPTES = process.env["ELPIS_CAPTURE_COMPTES"];
const DONNEES = process.env["ELPIS_CAPTURE_DONNEES"];
// Compte des parcours navigateur par process (`main=cap-alice,admin=cap-admin`) : leurs requêtes manquent à identifiants-chemins.jsonl.
const NAVIGATEUR: Readonly<Record<string, string>> = Object.fromEntries(
  (process.env["ELPIS_CAPTURE_NAVIGATEUR"] ?? "")
    .split(",")
    .filter((x) => x.includes("="))
    .map((x) => x.split("=", 2) as [string, string]),
);
// Ports de l'instance de recette (rapports/capture-recette-plan.md) : le `base` de identifiants-chemins.jsonl.
const PROCESS_PAR_PORT: Readonly<Record<string, string>> = {
  "18001": "main",
  "18002": "admin",
  "18765": "toolhost",
};

/** Bilan d'une route : rejouées, parité, premiers écarts, non rejouables par raison. */
interface BilanRoute {
  rejouees: number;
  parite: number;
  ecarts: string[];
  non_rejouables: Record<string, number>;
}

/** Cookie de session d'un compte par une vraie connexion sur l'app TS (`login-lite`), `null` si elle échoue. */
async function connecter(app: FastifyInstance, username: string, password: string): Promise<string | null> {
  const r = await app.inject({ method: "POST", url: "/api/login-lite", payload: { username, password } });
  const brut = r.headers["set-cookie"];
  const premier = (Array.isArray(brut) ? brut[0] : brut)?.split(";")[0];
  return r.statusCode === 200 && premier ? premier : null;
}

describe.skipIf(!EXPORT)("export de recette (ELPIS_CAPTURE_EXPORT)", () => {
  it("rapport de parité par route (ELPIS_CAPTURE_BASE : copie de la base de recette ; ELPIS_CAPTURE_CHEMINS et _COMPTES : chemins réels et vraies sessions, sinon ELPIS_CAPTURE_UID ; ELPIS_CAPTURE_DONNEES : copie du dossier de données de la recette ; ELPIS_CAPTURE_NAVIGATEUR : compte des parcours navigateur)", async () => {
    const captures = (readdirSync(EXPORT!, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .flatMap((f) =>
        readFileSync(join(EXPORT!, f), "utf-8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => pyJsonLoads(l) as Dict),
      );
    expect(captures.length).toBeGreaterThan(0);
    const requetes: RequeteConcrete[] = CHEMINS
      ? readFileSync(CHEMINS, "utf-8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as Dict)
          .map((e) => ({
            process: PROCESS_PAR_PORT[strPy(e["base"])] ?? strPy(e["base"]),
            methode: strPy(e["m"]),
            chemin: strPy(e["p"]),
            qui: typeof e["qui"] === "string" ? e["qui"] : null,
            statut: Number(e["s"]),
          }))
      : [];
    const concrets = CHEMINS ? attribuerChemins(captures, requetes) : null;
    const comptes = COMPTES ? (JSON.parse(readFileSync(COMPTES, "utf-8")) as Record<string, string>) : {};
    const dossier = mkdtempSync(join(tmpdir(), "elpis-parite-recette-"));
    if (DONNEES) copyFileSync(join(DONNEES, "config.json"), join(dossier, "config.json"));
    else writeFileSync(join(dossier, "config.json"), "{}");
    const serveursAvant = process.env["MCP_SERVERS_DIR"];
    if (DONNEES) process.env["MCP_SERVERS_DIR"] = join(DONNEES, "mcp_custom_servers");
    const auditAvant = process.env["ELPIS_AUDIT_DIR"];
    process.env["ELPIS_AUDIT_DIR"] = join(dossier, "audit");
    const restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    const source = process.env["ELPIS_CAPTURE_BASE"];
    const deTest = source ? null : ouvrirBaseDeTest("sqlite");
    if (source) copyFileSync(source, join(dossier, "app.db"));
    const base: Base = deTest?.base ?? ouvrirBase({ backend: "sqlite", path: join(dossier, "app.db") });
    const par: Record<string, BilanRoute> = {};
    const details: Dict[] = [];
    const bilan = (k: string): BilanRoute =>
      (par[k] ??= { rejouees: 0, parite: 0, ecarts: [], non_rejouables: {} });
    for (const cap of captures.filter((x) => x["process"] !== "main" && x["process"] !== "admin")) {
      const b = bilan(`${String(cap["process"])} ${String(cap["methode"])} ${String(cap["gabarit"])}`);
      const raison = `process ${String(cap["process"])} non rejoué`;
      b.non_rejouables[raison] = (b.non_rejouables[raison] ?? 0) + 1;
    }
    const connectes = new Set<string>();
    try {
      await initialiserBase(base);
      remplacerBase(base);
      if (DONNEES) configurerChiffrement({ fichierCle: join(DONNEES, "db", ".encryption_key") });
      for (const mode of ["main", "admin"] as const) {
        const c = await composer(mode, base, journalMuet, dependancesAuth(base));
        const gardes = CHEMINS ? creerGardes(dependancesAuth(base)) : gardesDeTest(base);
        const app = await appTest({ ...c, mode, gardes });
        const cookies = new Map<string, string | null>();
        const cookie = async (qui: string, neuf: boolean): Promise<string | null> => {
          const mdp = comptes[qui];
          if (neuf || !cookies.has(qui)) cookies.set(qui, mdp ? await connecter(app, qui, mdp) : null);
          const valeur = cookies.get(qui) ?? null;
          if (valeur) connectes.add(`${mode}:${qui}`);
          return valeur;
        };
        try {
          for (const [i, cap] of captures.entries()) {
            if (cap["process"] !== mode) continue;
            const cle = `${mode} ${String(cap["methode"])} ${String(cap["gabarit"])}`;
            const b = bilan(cle);
            const concret = concrets?.[i];
            const reponsePy = (cap["reponse"] ?? {}) as Dict;
            const jsonPy = ((reponsePy["corps"] ?? {}) as Dict)["json"];
            // Python a répondu à un client sans session (401, ou `logged_in` faux) : rejoué sans cookie, le compte du parcours n'y était pas connecté.
            const anonyme =
              Number(reponsePy["statut"]) === 401 || (estDict(jsonPy) && jsonPy["logged_in"] === false);
            const parNavigateur = Boolean(concrets && !concret && NAVIGATEUR[mode]);
            const fluxPy = String(((reponsePy["en_tetes"] ?? {}) as Dict)["content-type"] ?? "").startsWith(
              "text/event-stream",
            );
            const qui = anonyme
              ? null
              : (concret?.qui ?? (parNavigateur ? (NAVIGATEUR[mode] ?? null) : null));
            const avant = lignesJournal.length;
            const rejouer = async (neuf: boolean): Promise<Rejeu> => {
              if (concrets && !concret && !parNavigateur)
                return { rejouee: false, raison: "requête réelle introuvable" };
              if (parNavigateur && fluxPy)
                return { rejouee: false, raison: "flux du navigateur (sans fin au rejeu)" };
              if (!concrets)
                return rejouerCapture(app, cap, { "x-uid": process.env["ELPIS_CAPTURE_UID"] ?? "1" }, A);
              const ck = qui ? await cookie(qui, neuf) : null;
              if (qui && !ck)
                return { rejouee: false, raison: `compte ${qui} : connexion impossible au rejeu` };
              return rejouerCapture(app, cap, ck ? { cookie: ck } : {}, A, concret?.chemin);
            };
            const essai = async (neuf: boolean): Promise<Rejeu> => {
              try {
                return await Promise.race([
                  rejouer(neuf),
                  new Promise<Rejeu>((fin) =>
                    setTimeout(
                      () => fin({ rejouee: false, raison: "délai de 30 s dépassé" }),
                      30_000,
                    ).unref(),
                  ),
                ]);
              } catch (e) {
                return {
                  rejouee: true,
                  ecarts: [`exception : ${e instanceof Error ? e.message : String(e)}`],
                };
              }
            };
            let r = await essai(false);
            if (r.rejouee && qui && r.ecarts.some((e) => / ≠ 401$/u.test(e))) r = await essai(true);
            if (!r.rejouee) b.non_rejouables[r.raison] = (b.non_rejouables[r.raison] ?? 0) + 1;
            else {
              b.rejouees++;
              if (!r.ecarts.length) b.parite++;
              else
                details.push({
                  cle,
                  chemin: concret?.chemin ?? (parNavigateur ? "[navigateur]" : null),
                  qui,
                  ecarts: r.ecarts,
                  journal: r.ecarts.some((e) => / ≠ 5\d\d$/u.test(e))
                    ? lignesJournal
                        .slice(avant)
                        .filter((l) => /ERROR|CRITICAL/u.test(l))
                        .slice(0, 2)
                    : [],
                });
              for (const e of r.ecarts) if (b.ecarts.length < 3 && !b.ecarts.includes(e)) b.ecarts.push(e);
            }
          }
        } finally {
          await app.close();
          c.evenements.systemEvents.fermer({ type: "fin" });
        }
      }
    } finally {
      remplacerBase(undefined);
      if (deTest) await deTest.fermer();
      else await base.fermer();
      restaurer();
      invalidateConfigCache();
      if (auditAvant === undefined) delete process.env["ELPIS_AUDIT_DIR"];
      else process.env["ELPIS_AUDIT_DIR"] = auditAvant;
      if (serveursAvant === undefined) delete process.env["MCP_SERVERS_DIR"];
      else process.env["MCP_SERVERS_DIR"] = serveursAvant;
      oublierConfigurationAudit();
      installerCrochetJournal(null);
      installerDiffusion(null);
      installerRelaisModeles(null);
      rmSync(dossier, { recursive: true, force: true });
    }
    const routes = Object.values(par);
    const rapport = {
      captures: captures.length,
      routes: routes.length,
      rejouees: routes.reduce((n, b) => n + b.rejouees, 0),
      parite: routes.reduce((n, b) => n + b.parite, 0),
      sessions: [...connectes].sort(),
      par_route: Object.fromEntries(Object.entries(par).sort(([a], [b]) => (a < b ? -1 : 1))),
      details,
    };
    const sortie = process.env["ELPIS_CAPTURE_RAPPORT"] ?? join(".vitest", "rapport-parite.json");
    mkdirSync(dirname(sortie), { recursive: true });
    writeFileSync(sortie, JSON.stringify(rapport, null, 2) + "\n", "utf-8");
    console.log(
      `parité de forme : ${rapport.parite}/${rapport.rejouees} rejouées identiques, rapport : ${sortie}`,
    );
    expect(rapport.rejouees).toBeGreaterThan(0);
  }, 600_000);
});
