// SPDX-License-Identifier: MIT
/** apps/core/test/images/vecteurs.test.ts — rejeu des vecteurs Python de `imagegen` et `shared_infra/image/config` (moteurs simulés en local). */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import pngjs from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FlottantPy, pyJsonLoads } from "@elpis/commun";
import { parseJsonPy } from "@elpis/config";
import { initialiserBase, semerCleImages } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import { configurerChiffrement, configurerCoffre } from "@elpis/securite";

import {
  dataUrl,
  decodeB64,
  ImageError,
  imageDims,
  imageRequest,
  sniffMime,
  toResult,
} from "../../src/images/base";
import type { ImageRequest, ImageResult } from "../../src/images/base";
import { cleImages, etatCleImages } from "../../src/images/cle";
import {
  effectiveMaxN,
  engineOrigin,
  features,
  getImageConfig,
  imageReady,
  parseSize,
  publicStatus,
  roundStep,
  sidesFor,
  sizeForRatio,
} from "../../src/images/config";
import { COFFRE_DU_CORE, FERNET_SANS_CREATION } from "../../src/secrets/reprise";
import { clean, FALLBACK, PROMPT_NAME } from "../../src/images/enrichissement";
import {
  errorExcerpt,
  jsonBody,
  LARGE_BYTES,
  raiseForStatus,
  Reply,
  SMALL_BYTES,
  tls,
} from "../../src/images/http";
import { endpoint, OpenAIProvider } from "../../src/images/openai";
import { corpsJson } from "../../src/llm/client-http";
import { progressInfo, SdcppProvider } from "../../src/images/sdcpp";
import {
  buildRequest,
  estimerDepuisHistorique,
  modelName,
  NEGATIVE_MAX,
  ProgressTracker,
  PROMPT_MAX,
  SOURCE_MAX_BYTES,
} from "../../src/images/service";
import { dimensionsImage } from "@elpis/images";
import { prepareSource, reduireCapture, reduireLargeur, tailleVignette, vignette } from "@elpis/images";
import type { Dict } from "../../src/python";
import { decoder, lireVecteurs } from "../vecteurs-moteur";
import { lireJpeg, webpAvecAlpha } from "./fabrique";
import { FauxMoteur } from "./faux-moteur";
import type { ReponseScriptee } from "./faux-moteur";

type V = Record<string, unknown>;
const vecteurs = lireVecteurs<V>("images");
const sous = <T = V>(chemin: string): T =>
  chemin.split(".").reduce<unknown>((o, k) => (o as V)[k], vecteurs) as T;
const b64 = (s: string): Uint8Array => Buffer.from(s, "base64");

/** `ImageRequest(**d)` des vecteurs (noms Python). */
function requete(d: V): ImageRequest {
  return imageRequest({
    prompt: d["prompt"] as string,
    width: d["width"] as number,
    height: d["height"] as number,
    ...(d["n"] !== undefined ? { n: d["n"] as number } : {}),
    ...(d["seed"] !== undefined ? { seed: d["seed"] as number } : {}),
    ...(d["negative_prompt"] !== undefined ? { negativePrompt: d["negative_prompt"] as string } : {}),
    ...(d["steps"] !== undefined ? { steps: d["steps"] as number } : {}),
    ...(d["strength"] !== undefined ? { strength: d["strength"] as number } : {}),
    ...(d["edit_mode"] !== undefined ? { editMode: d["edit_mode"] as string } : {}),
    ...(typeof d["init_image"] === "string" ? { initImage: b64(d["init_image"]) } : {}),
  });
}

/** Valeur JSON lue à la Python (`FlottantPy`) ramenée en nombres, NaN et infinis gardés. */
function brut(v: unknown): unknown {
  if (v instanceof FlottantPy) return v.valeur;
  if (Array.isArray(v)) return v.map(brut);
  if (typeof v === "object" && v !== null)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, brut(x)]));
  return v;
}

function issue(f: () => unknown): V {
  try {
    return { valeur: decoder(f()) };
  } catch (e) {
    return { erreur: (e as Error).name };
  }
}

/** `_issue` du générateur : images, valeur ou erreur. */
async function issueAsync(f: () => Promise<unknown>): Promise<V> {
  try {
    const res = await f();
    if (Array.isArray(res) && res.every((r) => typeof r === "object" && r !== null && "mime" in r)) {
      return {
        images: (res as ImageResult[]).map((r) => ({
          mime: r.mime,
          width: r.width,
          height: r.height,
          seed: r.seed,
          revised_prompt: r.revisedPrompt,
          empreinte: Buffer.from(r.data.subarray(0, 12)).toString("base64"),
          taille: r.data.length,
        })),
      };
    }
    return { valeur: JSON.parse(JSON.stringify(res)) as unknown };
  } catch (e) {
    if (!(e instanceof ImageError)) throw e;
    return { erreur: { code: e.code, message: e.message, status: e.status } };
  }
}

describe("configuration (shared_infra/image/config.py)", () => {
  it("parse_size, round_step, size_for_ratio, engine_origin", () => {
    for (const c of sous<V[]>("config.tailles"))
      expect(
        issue(() => parseSize(c["entree"])),
        String(c["entree"]),
      ).toEqual("erreur" in c ? { erreur: c["erreur"] } : { valeur: c["valeur"] });
    for (const c of sous<V[]>("config.pas")) expect(roundStep(c["entree"] as number)).toBe(c["valeur"]);
    for (const c of sous<V[]>("config.ratios")) {
      const attendu = "erreur" in c ? { erreur: "RangeError" } : { valeur: c["valeur"] };
      expect(
        issue(() => sizeForRatio(c["ratio"], c["cote"] as number)),
        `${String(c["ratio"])} ${String(c["cote"])}`,
      ).toEqual(attendu);
    }
    for (const c of sous<V[]>("config.origines"))
      expect(engineOrigin(c["entree"]), String(c["entree"])).toBe(c["valeur"]);
  });

  it("get_image_config : défauts, bornes et coercition de chaque section", () => {
    const configs = sous<V[]>("config.configs");
    expect(configs.length).toBeGreaterThanOrEqual(25);
    for (const c of configs) {
      const cfg = getImageConfig({ image: parseJsonPy(c["section"] as string) });
      const contexte = (c["section"] as string).slice(0, 80);
      expect(decoder(JSON.parse(JSON.stringify(cfg))), contexte).toEqual(decoder(c["config"]));
      expect(features(cfg), contexte).toEqual(c["features"]);
      expect(effectiveMaxN(cfg), contexte).toBe(c["max_n"]);
      expect(imageReady(cfg), contexte).toBe(c["pret"]);
      expect(sidesFor(cfg), contexte).toEqual(c["cotes"]);
      expect(publicStatus(cfg), contexte).toEqual(c["public"]);
    }
    expect(getImageConfig({})).toEqual(sous("config.config_vue_nulle"));
    for (const c of sous<V[]>("config.dalle"))
      expect(effectiveMaxN({ provider: c["provider"], model: c["model"], max_n: c["max_n"] })).toBe(
        c["valeur"],
      );
  });

  it("clé API scellée par Python (Fernet partagé) : rangée dans le coffre avec son origine, même clé et même état qu'avant", async () => {
    configurerChiffrement({ cleEnv: sous<string>("cle_fernet"), fichierCle: "/inexistant/.encryption_key" });
    const dossier = mkdtempSync(join(tmpdir(), "elpis-cle-images-"));
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: join(dossier, "absente.key"),
      repli: join(dossier, ".vault.key"),
    });
    const t = ouvrirBaseDeTest("sqlite");
    try {
      await initialiserBase(t.base);
      for (const c of sous<V[]>("cles")) {
        await t.base.run("DELETE FROM vault_secrets");
        await semerCleImages(
          t.base,
          { coffre: COFFRE_DU_CORE, fernet: FERNET_SANS_CREATION },
          c["api_key_enc"] as string,
        );
        const cfg = { api_key_enc: c["api_key_enc"], url: c["url"] };
        expect(await cleImages(cfg, t.base), c["nom"] as string).toBe(c["cle"]);
        expect(await etatCleImages(cfg, t.base), c["nom"] as string).toEqual(c["etat"]);
      }
    } finally {
      await t.fermer();
      rmSync(dossier, { recursive: true, force: true });
    }
  });
});

describe("types communs (imagegen/base.py)", () => {
  it("codes d'erreur, base64, signatures, tailles d'en-tête, résultats", () => {
    for (const c of sous<V[]>("base.codes")) {
      const e = new ImageError("m", { code: c["code"] as string });
      expect([e.retryable, e.payload()]).toEqual([c["retryable"], c["payload"]]);
    }
    for (const c of sous<V[]>("base.b64")) {
      let obtenu: V;
      try {
        obtenu = { octets: Buffer.from(decodeB64(c["entree"])).toString("base64") };
      } catch (e) {
        obtenu = { erreur: (e as ImageError).code, message: (e as ImageError).message };
      }
      const { entree: _e, ...attendu } = c;
      expect(obtenu, JSON.stringify(c["entree"])).toEqual(attendu);
    }
    const images = sous<V[]>("base.images");
    expect(images.length).toBeGreaterThanOrEqual(35);
    for (const c of images) {
      const data = b64(c["octets"] as string);
      expect(sniffMime(data), c["nom"] as string).toBe(c["mime"]);
      expect(imageDims(data, [-1, -2]), c["nom"] as string).toEqual(c["dims"]);
    }
    expect(dataUrl(Uint8Array.from([0, 1, 0xfe, 0xff]))).toBe(sous("base.data_url"));
    for (const c of sous<V[]>("base.resultats")) {
      const brut = c["nom"] === "octets_png" || c["nom"] === "eps" ? null : undefined;
      void brut;
    }
    for (const c of sous<V[]>("base.vignettes")) {
      const [w, h] = c["taille"] as [number, number];
      expect(tailleVignette(w, h), `${w}x${h}`).toEqual(c["vignette"]);
    }
    expect(sous("base.constantes")).toEqual({
      hint: "Vérifiez Administration › Modèles et services › Images.",
      formats: ["PNG", "JPEG", "WEBP"],
      queue_max_s: 3600,
    });
  });

  it("to_result : octets, base64, data URL, refus", () => {
    const png = b64((sous<V[]>("base.images")[0] as V)["octets"] as string);
    const entrees: Readonly<Record<string, unknown>> = {
      octets_png: png,
      b64_png: Buffer.from(png).toString("base64"),
      data_url: "data:image/png;base64," + Buffer.from(png).toString("base64"),
      pas_image: Buffer.from("bonjour").toString("base64"),
      illisible: "@@@@@",
      eps: Buffer.from("%!PS"),
    };
    for (const c of sous<V[]>("base.resultats")) {
      let obtenu: V;
      try {
        const r = toResult(entrees[c["nom"] as string], [10, 20], { seed: 7, revisedPrompt: "rp" });
        obtenu = {
          valeur: {
            mime: r.mime,
            width: r.width,
            height: r.height,
            seed: r.seed,
            revised_prompt: r.revisedPrompt,
            taille: r.data.length,
          },
        };
      } catch (e) {
        const x = e as ImageError;
        obtenu = {
          erreur: {
            code: x.code,
            message: x.message,
            retryable: x.retryable,
            payload: x.payload(),
            status: x.status,
          },
        };
      }
      const attendu =
        c["erreur"] !== undefined
          ? { erreur: { ...(c["erreur"] as V), detail: undefined } }
          : { valeur: c["valeur"] };
      if ("erreur" in attendu) delete (attendu.erreur as V)["detail"];
      expect(obtenu, c["nom"] as string).toEqual(attendu);
    }
  });
});

describe("transport (imagegen/http.py)", () => {
  it("extraits d'erreur, codes HTTP traduits, corps JSON, plafonds", () => {
    for (const c of sous<V[]>("transport.extraits")) {
      const octets =
        c["octets"] !== undefined ? b64(c["octets"] as string) : Buffer.from(c["texte"] as string, "utf-8");
      expect(errorExcerpt(new Reply(c["statut"] as number, octets)), JSON.stringify(c).slice(0, 80)).toBe(
        c["valeur"],
      );
    }
    for (const c of sous<V[]>("transport.statuts")) {
      let obtenu: V;
      try {
        raiseForStatus(new Reply(c["code"] as number, Buffer.from(c["texte"] as string, "utf-8")), "quoi");
        obtenu = { valeur: null };
      } catch (e) {
        const x = e as ImageError;
        obtenu = {
          erreur: {
            code: x.code,
            message: x.message,
            detail: x.detail,
            status: x.status,
            retryable: x.retryable,
            payload: x.payload(),
          },
        };
      }
      const { code: _c, texte: _t, ...attendu } = c;
      expect(obtenu, `${String(c["code"])} ${String(c["texte"])}`).toEqual(attendu);
    }
    for (const c of sous<V[]>("transport.corps")) {
      let obtenu: V;
      try {
        obtenu = {
          valeur: brut(jsonBody(new Reply(200, Buffer.from(c["texte"] as string, "utf-8")), "quoi")),
        };
      } catch (e) {
        obtenu = { erreur: (e as ImageError).code, message: (e as ImageError).message };
      }
      const { texte: _t, ...attendu } = c;
      expect(obtenu, c["texte"] as string).toEqual(decoder(attendu));
    }
    expect(sous("transport.plafonds")).toEqual({ petit: SMALL_BYTES, grand: LARGE_BYTES });
  });

  it("TLS : magasin du système, CA collée lue comme OpenSSL", () => {
    for (const c of sous<V[]>("tls")) {
      let obtenu: V;
      try {
        const r = tls(c["verify"] as boolean, c["ca"] as string);
        obtenu = { valeur: r === false ? false : "contexte" };
      } catch (e) {
        obtenu = { erreur: (e as ImageError).code, message: (e as ImageError).message };
      }
      const { nom: _n, verify: _v, ca: _c, ...attendu } = c;
      expect(obtenu, c["nom"] as string).toEqual(attendu);
    }
  });
});

describe("moteurs : charges, avancée, scénarios rejoués", () => {
  it("endpoint, charges sd-server et OpenAI, champs multipart", () => {
    for (const c of sous<V[]>("moteurs.endpoints"))
      expect(endpoint(c["base"] as string, c["suffixe"] as string)).toBe(c["valeur"]);
    for (const c of sous<V[]>("moteurs.charges_sdcpp")) {
      const charge = new SdcppProvider("http://x").buildPayload(requete(c["requete"] as V));
      expect(JSON.parse(JSON.stringify(charge)), JSON.stringify(c["requete"])).toEqual(c["charge"]);
      expect(corpsJson(charge).toString("utf-8"), JSON.stringify(c["requete"])).toBe(c["corps"]);
    }
    for (const c of sous<V[]>("moteurs.charges_openai")) {
      const p = new OpenAIProvider("http://x", { model: c["model"] as string });
      const charge = p.buildPayload(requete(c["requete"] as V));
      expect(charge, String(c["model"])).toEqual(c["charge"]);
      expect(Object.fromEntries(Object.entries(charge).map(([k, v]) => [k, String(v)]))).toEqual(c["champs"]);
    }
  });

  it("progress_info : ne lit que ce que le job publie", () => {
    const cas = sous<V[]>("moteurs.progres");
    expect(cas.length).toBeGreaterThanOrEqual(45);
    for (const c of cas) {
      const info: V = { ...progressInfo(pyJsonLoads(c["texte"] as string) as Dict) };
      const attendu = { ...(decoder(c["valeur"]) as V) };
      if (Array.isArray(attendu["preview_key"]))
        attendu["preview_key"] = (attendu["preview_key"] as unknown[]).join(":");
      expect(brut(info), c["texte"] as string).toEqual(attendu);
    }
  });

  let moteur: FauxMoteur;
  beforeAll(async () => {
    moteur = await FauxMoteur.demarrer();
  });
  afterAll(async () => {
    await moteur.arreter();
  });

  const remplacer = (r: ReponseScriptee, de: string, vers: string): ReponseScriptee =>
    r.texte === undefined ? r : { ...r, texte: r.texte.replaceAll(de, vers) };

  /** Requêtes reçues, comme le `gestion` du générateur les note (frontière multipart remplacée). */
  function vues(depuis: number, de = "", vers = ""): V[] {
    return moteur.requetes.slice(depuis).map((r) => {
      const ctype = r.entetes["content-type"] ?? null;
      let corps: unknown = r.corps.length ? r.corps.toString("utf-8") : null;
      let typeVu: unknown = ctype;
      if (typeof ctype === "string" && ctype.startsWith("multipart/form-data")) {
        const borne = ctype.split("boundary=")[1] ?? "";
        corps = {
          $octets: Buffer.from(r.corps.toString("latin1").replaceAll(borne, "<BORNE>"), "latin1").toString(
            "base64",
          ),
        };
        typeVu = ctype.replace(borne, "<BORNE>");
      }
      return {
        methode: r.methode,
        chemin: r.chemin,
        authorization: r.entetes["authorization"] ?? null,
        content_type: typeVu,
        corps: typeof corps === "string" && de ? corps.replaceAll(vers, de) : corps,
      };
    });
  }

  const sansHote = (v: V[]): V[] => v.map(({ hote: _h, ...reste }) => reste);

  it("sd-server : scénarios du générateur rejoués à l'identique (requêtes, avancée, issue)", async () => {
    const scenarios = sous<V[]>("moteurs.sdcpp");
    expect(scenarios.length).toBeGreaterThanOrEqual(24);
    for (const sc of scenarios) {
      const horloge = { t: 1_000_000.0 };
      const reponses = sc["reponses"] as Record<string, ReponseScriptee[]>;
      for (const [cle, file] of Object.entries(reponses)) moteur.file(cle, file);
      const depuis = moteur.requetes.length;
      const controleur = new AbortController();
      let sondages = 0;
      moteur.surRequete = (r) => {
        if (r.methode === "GET" && r.chemin.startsWith("/sdcpp/v1/jobs/")) {
          horloge.t += sc["pas_horloge"] as number;
          sondages++;
          if (sc["stop_apres"] !== null && sondages >= (sc["stop_apres"] as number))
            setImmediate(() => controleur.abort());
        }
      };
      const evenements: unknown[] = [];
      const p = new SdcppProvider(moteur.url + "/", {
        timeoutSec: sc["timeout_sec"] as number,
        apiKey: sc["api_key"] as string,
        horloges: { monotone: () => horloge.t, murale: () => horloge.t + 0.25 },
        sondage: { premier: 0, max: 0 },
        delais: { sondage: 0.3 },
        tirerGraine: () => 123456789,
      });
      const req = requete(sc["requete"] as V);
      const obtenu = await issueAsync(() =>
        p.generate(
          req,
          (state, qp, info) => {
            evenements.push([state, qp ?? null, brut(info ?? null)]);
          },
          controleur.signal,
        ),
      );
      const nom = sc["nom"] as string;
      expect(obtenu, nom).toEqual(
        sc["images"] !== undefined ? { images: sc["images"] } : { erreur: sc["erreur"] },
      );
      expect(vues(depuis), nom).toEqual(sansHote(sc["requetes"] as V[]));
      expect(evenements, nom).toEqual(decoder(sc["evenements"]));
      expect(req.seed, nom).toBe(sc["graine_finale"]);
      moteur.surRequete = () => undefined;
      for (const cle of Object.keys(reponses)) moteur.file(cle, []);
    }
  });

  it("sd-server : capacités et modèle chargé", async () => {
    for (const c of sous<V[]>("moteurs.capacites_sdcpp")) {
      const depuis = moteur.requetes.length;
      const url = c["nom"] === "sans_adresse" ? "" : moteur.url;
      if (c["reponse"] !== undefined)
        moteur.file("GET /sdcpp/v1/capabilities", [{ texte: c["reponse"] as string }]);
      else if (c["reponse_brute"] !== undefined)
        moteur.file("GET /sdcpp/v1/capabilities", [c["reponse_brute"] as ReponseScriptee]);
      const p = new SdcppProvider(url, { delais: { capacites: 0.3 } });
      expect(await issueAsync(() => p.capabilities()), JSON.stringify(c).slice(0, 60)).toEqual(
        c["capacites"],
      );
      if (c["modeles"] !== undefined) expect(await issueAsync(() => p.listModels())).toEqual(c["modeles"]);
      expect(vues(depuis)).toEqual(sansHote(c["requetes"] as V[]));
    }
  });

  it("OpenAI : scénarios rejoués (charges, multipart, téléchargement par URL, erreurs)", async () => {
    const scenarios = sous<V[]>("moteurs.openai.scenarios");
    expect(scenarios.length).toBeGreaterThanOrEqual(15);
    const OA = "http://oa.test:8000";
    for (const sc of scenarios) {
      const reponses = sc["reponses"] as Record<string, ReponseScriptee[]>;
      for (const [cle, file] of Object.entries(reponses))
        moteur.file(
          cle,
          file.map((r) => remplacer(r, OA, moteur.url)),
        );
      const depuis = moteur.requetes.length;
      const url = (sc["url"] as string).replace(OA, moteur.url);
      const p = new OpenAIProvider(url, { model: sc["model"] as string, apiKey: sc["api_key"] as string });
      const req = requete(sc["requete"] as V);
      expect(p.buildPayload(req)).toEqual(sc["charge"]);
      const evenements: unknown[] = [];
      const obtenu = await issueAsync(() =>
        p.generate(req, (state, qp, info) => {
          evenements.push([state, qp ?? null, Object.keys(info ?? {}).sort()]);
        }),
      );
      const nom = sc["nom"] as string;
      expect(obtenu, nom).toEqual(
        sc["images"] !== undefined ? { images: sc["images"] } : { erreur: sc["erreur"] },
      );
      expect(vues(depuis), nom).toEqual(sansHote(sc["requetes"] as V[]));
      expect(evenements, nom).toEqual(sc["evenements"]);
      for (const cle of Object.keys(reponses)) moteur.file(cle, []);
    }
    for (const c of sous<V[]>("moteurs.openai.modeles")) {
      moteur.file("GET /v1/models", [{ texte: c["reponse"] as string }]);
      const depuis = moteur.requetes.length;
      const p = new OpenAIProvider(moteur.url + "/v1", { model: "m", apiKey: "k" });
      expect(await issueAsync(() => p.listModels()), c["reponse"] as string).toEqual(c["modeles"]);
      expect(await issueAsync(() => p.capabilities()), c["reponse"] as string).toEqual(c["capacites"]);
      expect(vues(depuis)).toEqual(sansHote(c["requetes"] as V[]));
    }
  });
});

describe("service (imagegen/service.py) et enrichissement", () => {
  it("build_request : validation sur les vecteurs", async () => {
    const demandes = sous<V[]>("service.demandes");
    expect(demandes.length).toBeGreaterThanOrEqual(50);
    for (const c of demandes) {
      let obtenu: V;
      try {
        const r = await buildRequest(
          c["cfg"] as Dict,
          c["prompt"],
          c["opts"] as Dict,
          (c["caps"] as Dict | null) ?? null,
        );
        obtenu = {
          valeur: {
            prompt: r.prompt,
            width: r.width,
            height: r.height,
            n: r.n,
            seed: r.seed,
            negative_prompt: r.negativePrompt,
            steps: r.steps,
            strength: r.strength,
            edit_mode: r.editMode,
          },
        };
      } catch (e) {
        obtenu =
          e instanceof ImageError
            ? { erreur: { code: e.code, message: e.message, status: e.status } }
            : { exception: (e as Error).name };
      }
      const { cfg: _c, prompt: _p, opts: _o, caps: _k, ...attendu } = c;
      expect(obtenu, JSON.stringify([c["prompt"], c["opts"], c["caps"]]).slice(0, 120)).toEqual(attendu);
    }
  });

  it("build_request avec image source : recadrée à la taille demandée, PNG RGB, force bornée", async () => {
    for (const c of sous<V[]>("service.sources")) {
      const opts = { size: `${String(c["w"])}x${String(c["h"])}`, ...(c["opts"] as Dict) };
      let obtenu: V;
      try {
        const r = await buildRequest(
          {
            provider: "sdcpp",
            url: "http://sd",
            model: "",
            max_n: 4,
            max_side: 2048,
            default_side: 1024,
            size_policy: "free",
            sizes: [],
            edit_mode: "init",
          },
          "x",
          opts,
          null,
          b64(c["octets"] as string),
        );
        const dims = r.initImage === null ? null : imageDims(r.initImage, [0, 0]);
        obtenu = {
          valeur: {
            taille: dims === null ? null : [...dims],
            mode: r.initImage === null ? null : "RGB",
            strength: r.strength,
            edit_mode: r.editMode,
          },
        };
      } catch (e) {
        const x = e as ImageError;
        obtenu = { erreur: { code: x.code, message: x.message, status: x.status } };
      }
      expect(obtenu, c["nom"] as string).toEqual(
        c["valeur"] !== undefined ? { valeur: c["valeur"] } : { erreur: c["erreur"] },
      );
    }
  });

  it("estimation, suivi d'avancée, nom du modèle, constantes", () => {
    for (const c of sous<V[]>("service.estimations")) {
      const [w, h, n] = c["req"] as [number, number, number];
      expect(
        estimerDepuisHistorique(
          c["historique"] as [number, number][],
          imageRequest({ prompt: "x", width: w, height: h, n }),
        ),
      ).toBe(c["valeur"]);
    }
    const horloge = { t: 500.0 };
    for (const c of sous<V[]>("service.suivis")) {
      const t = new ProgressTracker(
        imageRequest({ prompt: "x", width: 64, height: 32, n: 2 }),
        (c["eta"] as number | null) ?? null,
        {
          monotone: () => horloge.t,
          murale: () => horloge.t + 1000.0,
        },
      );
      const evts: unknown[] = [t.event()];
      for (const [state, qp, info, dt] of c["etapes"] as [string, unknown, Dict | null, number][]) {
        t.update(state, qp, info);
        horloge.t += dt;
        evts.push(t.event(), t.event("tool"));
      }
      expect(evts, JSON.stringify(c["etapes"])).toEqual(c["evenements"]);
      expect(t.genSeconds()).toBe(c["gen_seconds"]);
    }
    for (const c of sous<V[]>("service.modeles"))
      expect(modelName(c["cfg"] as Dict, (c["caps"] as Dict | null) ?? null)).toBe(c["valeur"]);
    expect(sous("service.constantes")).toEqual({
      prompt_max: PROMPT_MAX,
      negative_max: NEGATIVE_MAX,
      source_max: SOURCE_MAX_BYTES,
    });
  });

  it("enrichissement : nettoyage de la sortie du modèle", () => {
    for (const c of sous<V[]>("enrichissement.nettoyage"))
      expect(clean(c["sortie"] as string, c["original"] as string), c["sortie"] as string).toBe(c["valeur"]);
    expect([FALLBACK, PROMPT_NAME]).toEqual([sous("enrichissement.repli"), sous("enrichissement.nom")]);
  });
});

const empreinte = (o: Uint8Array): string => createHash("sha256").update(o).digest("hex");

/** Image produite relue comme `_lu` du générateur : format, taille, mode, empreinte des pixels et du profil ICC. */
function lu(octets: Uint8Array | null): V | null {
  if (octets === null) return null;
  const d = Buffer.from(octets);
  if (d.subarray(1, 4).toString("latin1") === "PNG") {
    const p = pngjs.PNG.sync.read(d);
    const canaux = { 0: 1, 2: 3, 6: 4 }[p.colorType as 0 | 2 | 6];
    const brut = Buffer.alloc(p.width * p.height * canaux);
    for (let i = 0; i < p.width * p.height; i++)
      for (let c = 0; c < canaux; c++) brut[i * canaux + c] = p.data[i * 4 + c] ?? 0;
    let icc: Uint8Array = Buffer.alloc(0);
    for (let i = 8; i + 8 <= d.length; i += 12 + d.readUInt32BE(i))
      if (d.subarray(i + 4, i + 8).toString("latin1") === "iCCP") {
        const corps = d.subarray(i + 8, i + 8 + d.readUInt32BE(i));
        icc = inflateSync(corps.subarray(corps.indexOf(0) + 2));
      }
    const mode = { 1: "L", 3: "RGB", 4: "RGBA" }[canaux];
    return { format: "PNG", taille: [p.width, p.height], mode, pixels: empreinte(brut), icc: empreinte(icc) };
  }
  if (d[0] === 0xff) {
    const j = lireJpeg(d);
    return { format: "JPEG", taille: [j.largeur, j.hauteur], mode: j.composantes === 1 ? "L" : "RGB" };
  }
  return { format: "WEBP", taille: dimensionsImage(d), mode: webpAvecAlpha(d) ? "RGBA" : "RGB" };
}

/** Écart connu : Pillow ouvre le GIF dans les réductions de capture ; ici seuls PNG, JPEG et WEBP se décodent. */
const FORMATS_PILLOW_SEULEMENT = new Set(["gif"]);

describe("pixels comme Pillow (prepare_source, _thumbnail, réductions de capture)", () => {
  it("tailles, modes, profil ICC ; pixels identiques pour les sources sans perte (rééchantillonnage de Pillow)", async () => {
    const px = sous<V>("pixels");
    const cas = px["cas"] as V[];
    expect(cas.length).toBeGreaterThanOrEqual(37);
    const [largeurMax, qualite] = [px["largeur_max"] as number, px["qualite_capture"] as number];
    const garder = (v: V | null, exact: boolean, champs = ["format", "taille", "mode", "icc"]): V | null =>
      v === null
        ? null
        : Object.fromEntries(
            Object.entries(v).filter(([k]) => champs.includes(k) || (exact && k === "pixels")),
          );
    for (const c of cas) {
      const [nom, exact] = [c["nom"] as string, c["exact"] as boolean];
      const data = Buffer.from(c["octets"] as string, "base64");
      for (const [taille, attendu] of Object.entries(c["sources"] as Record<string, V>)) {
        const [w = 0, h = 0] = taille.split("x").map(Number);
        let obtenu: V | null;
        try {
          obtenu = lu(await prepareSource(data, w, h));
        } catch (e) {
          obtenu = { erreur: (e as ImageError).code, message: (e as ImageError).message };
        }
        expect(
          garder(obtenu, exact, ["format", "taille", "mode", "icc", "erreur", "message"]),
          `${nom} ${taille}`,
        ).toEqual(garder(attendu, exact, ["format", "taille", "mode", "icc", "erreur", "message"]));
      }
      expect(lu(await vignette(data)), `${nom} vignette`).toEqual(
        garder(c["vignette"] as V | null, false, ["format", "taille", "mode"]),
      );
      if (FORMATS_PILLOW_SEULEMENT.has(nom)) continue;
      const r = await reduireLargeur(data, largeurMax, c["natif"] as number);
      expect(r.largeur, `${nom} largeur envoyée`).toBe(c["largeur_envoyee"]);
      if (c["reduite"] === null) expect(r.octets, `${nom} réduite`).toBe(data);
      else expect(garder(lu(r.octets), exact), `${nom} réduite`).toEqual(garder(c["reduite"] as V, exact));
      const capture = lu(await reduireCapture(data, largeurMax, qualite));
      const attendue = c["capture"] as V | null;
      expect(capture === null ? null : capture["taille"], `${nom} capture`).toEqual(
        attendue === null ? null : attendue["taille"],
      );
    }
  });
});
