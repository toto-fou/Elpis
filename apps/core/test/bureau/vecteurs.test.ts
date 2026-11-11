// SPDX-License-Identifier: MIT
/** apps/core/test/bureau/vecteurs.test.ts — rejeu des vecteurs Python de `_detection_client`, `_desktop_session` et `_desktop_replay` (transport, primitives et horloge simulés). */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, onTestFinished } from "vitest";

import { FlottantPy, pyJsonLoads } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";

import {
  actKwargs,
  ambiguousQueryCandidates,
  anchorPoint,
  assignStableIds,
  center,
  chatCompletionsUrl,
  clampTimeout,
  coerceBox,
  corpsJsonRequests,
  countOk,
  DEFAULT_TIMEOUT_MS,
  detect,
  DETECT_MAX_WIDTH,
  ELEMENT_POLL_MS,
  elementCenter,
  elKey,
  ErreurRequests,
  expectCmp,
  expectQuery,
  extractDesktopFrame,
  extractJsonArray,
  extractTagItems,
  findArray,
  findListOfDicts,
  getActiveTarget,
  getScreenDims,
  hamHex,
  installerAncres,
  installerHorlogeRejeu,
  installerPrimitivesBureau,
  iouXyxy,
  isNum,
  labelOf,
  LLM_FORMATS,
  MAX_RETRY,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  nativeSize,
  obsKey,
  pickBest,
  PRESETS,
  PROMPT_FILES,
  promptText,
  readText,
  registerDesktopObservation,
  replayScenario,
  resolveElementImpl,
  RETRY_BACKOFF_MS,
  scoreOf,
  setActiveTarget,
  setScreenDims,
  SETTLE_POLL_MS,
  SETTLE_QUIET_MS,
  SIG_SAME,
  sniffMime,
  sondeOk,
  STABLE_CEILING_MS,
  stepLabel,
  stepOnError,
  stepRetry,
  suivreRedirections,
  TEXT_POLL_MS,
  textCmp,
  toXyxyNative,
  validatePoint,
  valueMatches,
} from "../../src/bureau";
import type { PrimitivesBureau, ReponseHttp, RequeteHttp, RequetePost } from "../../src/bureau";
import { dimensionsImage } from "@elpis/images";
import type { Dict } from "../../src/python";
import { decoder, lireVecteurs } from "../vecteurs-moteur";

type Attendu = { valeur?: unknown; erreur?: string };
type Reponse = {
  statut?: number;
  texte?: string;
  octets?: string;
  entetes?: Record<string, string>;
  exception?: string;
};
type Vue = {
  url: string;
  entetes: Record<string, string>;
  content_type?: string | null;
  corps?: string;
  timeout?: number;
};
type Scenario = {
  nom: string;
  image?: string;
  options: Dict;
  reponses: Reponse[];
  requetes: Vue[];
  sortie: Attendu;
  erreur: string;
  corps_approche?: boolean;
};
type V = {
  detection: Dict & { detections: Scenario[]; lectures: Scenario[]; images: Record<string, string> };
  session: Dict;
  rejeu: Dict & { scenarios: Dict[] };
};
const vecteurs = lireVecteurs<V>("bureau");
const det = vecteurs.detection;
const ses = vecteurs.session;
const rej = vecteurs.rejeu;

/** Valeurs du moteur comparables au JSON des vecteurs (flottants Python, entiers longs). */
function brut(v: unknown): unknown {
  if (v instanceof FlottantPy) return v.valeur;
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(brut);
  if (typeof v === "object" && v !== null)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, brut(x)]));
  return v;
}

function liste<T>(cle: unknown): T[] {
  return cle as T[];
}

/** `{valeur}` ou `{erreur: classe}` : la classe Python est le `name` de l'erreur levée. */
function rejouer(f: () => unknown, attendu: Attendu, contexte: string): void {
  if (attendu.erreur !== undefined) {
    let levee: unknown = null;
    try {
      f();
    } catch (e) {
      levee = e;
    }
    expect((levee as Error | null)?.name, contexte).toBe(attendu.erreur);
    return;
  }
  expect(brut(f()), contexte).toEqual(decoder(attendu.valeur));
}

async function rejouerAsync(f: () => Promise<unknown>, attendu: Attendu, contexte: string): Promise<void> {
  if (attendu.erreur !== undefined) {
    await expect(f(), contexte).rejects.toMatchObject({ name: attendu.erreur });
    return;
  }
  expect(brut(await f()), contexte).toEqual(decoder(attendu.valeur));
}

const images = Object.fromEntries(Object.entries(det.images).map(([k, b]) => [k, Buffer.from(b, "base64")]));

/** Corps comparable au vecteur : frontière normalisée, images remplacées par `<IMAGE:nom>` ou `<IMAGE:LxH>`. */
function corpsNormalise(r: RequetePost): { corps: string; type: string } {
  const borne = /boundary=([0-9a-f]{32})$/.exec(r.typeContenu)?.[1];
  let octets = Buffer.from(r.corps);
  if (borne) octets = Buffer.from(octets.toString("latin1").replaceAll(borne, "<BORNE>"), "latin1");
  let texte = octets.toString("latin1");
  texte = texte.replace(/data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)/g, (_, mime: string, b64: string) => {
    const o = Buffer.from(b64, "base64");
    const nom = Object.entries(images).find(([, x]) => x.length > 0 && x.equals(o))?.[0];
    const dims = dimensionsImage(o);
    return `data:${mime};base64,<IMAGE:${nom ?? (dims ? `${dims[0]}x${dims[1]}` : "?")}>`;
  });
  for (const [nom, o] of Object.entries(images)) {
    if (o.length === 0) continue;
    texte = texte.split(o.toString("latin1")).join(`<IMAGE:${nom}>`);
  }
  return {
    corps: Buffer.from(texte, "latin1").toString("base64"),
    type: borne ? r.typeContenu.replace(borne, "<BORNE>") : r.typeContenu,
  };
}

/** Transport simulé : mêmes réponses que l'adaptateur Python, requêtes enregistrées. */
function fauxPoster(reponses: Reponse[], vues: RequetePost[]) {
  const file = [...reponses];
  return async (r: RequetePost) => {
    vues.push(r);
    const rep = (file.length > 1 ? file.shift() : file[0]) ?? {};
    if (rep.exception) throw new ErreurRequests(rep.exception, "simulé");
    const entetes = rep.entetes ?? { "Content-Type": "application/json" };
    const type = Object.entries(entetes).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? null;
    return {
      statut: rep.statut ?? 200,
      corps: rep.octets ? Buffer.from(rep.octets, "base64") : Buffer.from(rep.texte ?? "", "utf-8"),
      typeContenu: type,
    };
  };
}

function optionsDetection(o: Dict): Dict {
  const noms: Record<string, string> = {
    auth_header: "authHeader",
    auth_token: "authToken",
    response_map: "responseMap",
    native_w: "nativeW",
    native_h: "nativeH",
  };
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [noms[k] ?? k, v]));
}

function comparerRequetes(sc: Scenario, vues: RequetePost[]): void {
  const envoyees = sc.requetes.filter((v) => v.corps !== undefined);
  expect(vues.length, sc.nom).toBe(envoyees.length);
  envoyees.forEach((v, i) => {
    const r = vues[i];
    if (r === undefined) return;
    const n = corpsNormalise(r);
    expect(r.url, sc.nom).toBe(v.url);
    expect(n.type, sc.nom).toBe(v.content_type);
    expect(Buffer.from(n.corps, "base64").toString("latin1"), sc.nom).toBe(
      Buffer.from(v.corps ?? "", "base64").toString("latin1"),
    );
    expect(r.entetes, sc.nom).toEqual(v.entetes);
    expect(r.delai, sc.nom).toBe(v.timeout);
  });
}

describe("détection : fonctions pures", () => {
  it("boîtes, conversions en pixels natifs, libellés, scores", () => {
    for (const c of liste<Attendu & { entree: string }>(det["boites"]))
      rejouer(() => coerceBox(pyJsonLoads(c.entree)), c, c.entree);
    for (const c of liste<
      Attendu & { boite: unknown[]; format: string; coords: string; sent: number[]; natif: number[] }
    >(det["natifs"])) {
      const boite = c.boite.map((x) =>
        typeof x === "string" ? Number(x === "nan" ? NaN : x === "inf" ? Infinity : x) : (x as number),
      );
      const [sw = 0, sh = 0] = c.sent;
      const [nw = 0, nh = 0] = c.natif;
      rejouer(() => toXyxyNative(boite, c.format, c.coords, sw, sh, nw, nh), c, JSON.stringify(c));
    }
    for (const c of liste<Attendu & { item: string; cles: string[] }>(det["labels"]))
      rejouer(() => labelOf(pyJsonLoads(c.item), c.cles), c, c.item);
    for (const c of liste<Attendu & { item: string; cles: string[] }>(det["scores"]))
      rejouer(() => scoreOf(pyJsonLoads(c.item), c.cles), c, c.item);
    for (const c of liste<{ entree: string; valeur: boolean }>(det["nombres"]))
      expect(isNum(pyJsonLoads(c.entree)), c.entree).toBe(c.valeur);
  });

  it("listes et tableaux d'éléments, adresse chat, JSON et balises des LLM, IoU, MIME", () => {
    for (const c of liste<Attendu & { charge: string; cles: string[] }>(det["listes"]))
      rejouer(() => findListOfDicts(pyJsonLoads(c.charge), c.cles), c, c.charge);
    for (const c of liste<Attendu & { charge: string; cles: string[] }>(det["tableaux"]))
      rejouer(() => findArray(pyJsonLoads(c.charge), c.cles), c, c.charge);
    for (const c of liste<{ entree: string | null; valeur: string }>(det["urls_chat"]))
      expect(chatCompletionsUrl(c.entree), String(c.entree)).toBe(c.valeur);
    for (const c of liste<Attendu & { texte: unknown }>(det["json"]))
      rejouer(() => extractJsonArray(c.texte), c, String(c.texte));
    for (const c of liste<Attendu & { texte: unknown }>(det["tags"]))
      rejouer(() => extractTagItems(c.texte), c, String(c.texte));
    for (const c of liste<{ a: number[]; b: number[]; valeur: number }>(det["ious"]))
      expect(iouXyxy(c.a, c.b)).toBe(c.valeur);
    for (const c of liste<{ octets: string; mime: string }>(det["mimes"]))
      expect(sniffMime(Buffer.from(c.octets, "base64"))).toBe(c.mime);
  });

  it("préréglages, formats LLM, largeur envoyée, prompts embarqués et éditables", () => {
    expect(brut(PRESETS)).toEqual(det["presets"]);
    expect([...LLM_FORMATS].sort()).toEqual(det["formats_llm"]);
    expect(DETECT_MAX_WIDTH).toBe(det["largeur_max"]);
    expect(PROMPT_FILES).toEqual(det["replis"]);
    for (const [cat, texte] of Object.entries(det["prompts"] as Record<string, string>))
      expect(promptText(cat), cat).toBe(texte);
  });

  it("taille native lue sur l'en-tête (GIF : non lu, écart assumé)", () => {
    for (const c of liste<{ image: string; valeur: number[] }>(det["tailles"])) {
      const img = images[c.image] ?? Buffer.alloc(0);
      expect(nativeSize(img), c.image).toEqual(c.image === "gif" ? [0, 0] : c.valeur);
    }
  });
});

describe("détection : requêtes envoyées et réponses lues comme requests", () => {
  it(`${det.detections.length} scénarios detect()`, async () => {
    for (const sc of det.detections) {
      const vues: RequetePost[] = [];
      const options = { ...optionsDetection(sc.options), poster: fauxPoster(sc.reponses, vues) };
      const img = images[sc.image ?? "1280"] ?? Buffer.alloc(0);
      let erreur = "";
      await rejouerAsync(
        async () => {
          const r = await detect(img, options as never);
          erreur = r.erreur;
          return r.elements;
        },
        sc.sortie,
        sc.nom,
      );
      if (sc.sortie.erreur === undefined) expect(erreur, sc.nom).toBe(sc.erreur);
      comparerRequetes(sc, vues);
    }
  });

  it(`${det.lectures.length} scénarios read_text()`, async () => {
    for (const sc of det.lectures) {
      const vues: RequetePost[] = [];
      const options = { ...optionsDetection(sc.options), poster: fauxPoster(sc.reponses, vues) };
      let erreur = "";
      await rejouerAsync(
        async () => {
          const r = await readText(images["1280"] ?? Buffer.alloc(0), options as never);
          erreur = r.erreur;
          return r.texte;
        },
        sc.sortie,
        sc.nom,
      );
      if (sc.sortie.erreur === undefined) expect(erreur, sc.nom).toBe(sc.erreur);
      comparerRequetes(sc, vues);
    }
  });
});

type JournalAncres = unknown[][];

function ancres(epingle: (scope: string, q: string) => unknown, journal: JournalAncres): void {
  installerAncres({
    lookupActionAnchor: async (scope, q) => {
      journal.push(["lookup", scope, q]);
      return epingle(scope, q) as never;
    },
    recordActionAnchor: async (scope, q, aid, o) => {
      journal.push(["record", scope, q, aid, o.role, brut(o.center)]);
    },
  });
}

describe("détection : redirections de requests.post (Session.resolve_redirects)", () => {
  type Saut = { statut: number; location?: string };
  type CasRedirection = { nom: string; url?: string; entetes?: Record<string, string> };

  it("méthode, adresse, corps et en-têtes de chaque envoi ; même issue (statut ou exception)", async () => {
    const cas = liste<CasRedirection & { reponses: Saut[]; envois: Dict[]; issue: Attendu }>(
      det["redirections"],
    );
    expect(cas.length).toBeGreaterThanOrEqual(40);
    for (const sc of cas) {
      const envois: Dict[] = [];
      const file = [...sc.reponses];
      const envoi = async (q: RequeteHttp): Promise<ReponseHttp> => {
        envois.push({
          methode: q.methode,
          url: q.url,
          corps: q.corps === null ? null : Buffer.from(q.corps).toString("utf-8"),
          entetes: { ...q.entetes },
        });
        const r = (file.length > 1 ? file.shift() : file[0]) ?? { statut: 200 };
        return { statut: r.statut, corps: Buffer.alloc(0), typeContenu: null, location: r.location ?? null };
      };
      const requete: RequetePost = {
        url: sc.url ?? "http://det.test:8000/detect",
        corps: corpsJsonRequests({ image: "x" }),
        typeContenu: "application/json",
        entetes: sc.entetes ?? { Authorization: "Bearer jeton" },
        delai: 5,
      };
      let issue: Attendu;
      try {
        issue = { valeur: (await suivreRedirections(envoi, requete)).statut };
      } catch (e) {
        const nom = (e as Error).name;
        issue = { erreur: nom === "RangeError" ? "ValueError" : nom };
      }
      expect(issue, sc.nom).toEqual(sc.issue);
      expect(envois, sc.nom).toEqual(sc.envois);
    }
  });
});

describe("session bureau", () => {
  it("points d'action bornés, centres, départage des candidats, clés", () => {
    for (const c of liste<Attendu & { point: string; dims: number[] | null }>(ses["points"]))
      rejouer(
        () => validatePoint(pyJsonLoads(c.point), c.dims ? [c.dims[0] ?? 0, c.dims[1] ?? 0] : null),
        c,
        c.point,
      );
    for (const c of liste<Attendu & { element: string }>(ses["centres"]))
      rejouer(() => elementCenter(pyJsonLoads(c.element)), c, c.element);
    for (const c of liste<Attendu & { candidats: string; options: Dict }>(ses["candidats"])) {
      const near = c.options["near"] as number[] | undefined;
      rejouer(
        () =>
          pickBest(pyJsonLoads(c.candidats) as unknown[], {
            near: near ? [near[0] ?? 0, near[1] ?? 0] : null,
            role: c.options["role"],
            query: c.options["query"],
          }),
        c,
        c.candidats,
      );
    }
    expect(["u", "", null, "é"].map((u, i) => obsKey(u, ["t", "", null, "vm 1"][i]))).toEqual(ses["cles"]);
  });

  it("ids stables d'une observation à l'autre", () => {
    liste<{ entree: string; ids: unknown[] }[]>(ses["sequences"]).forEach((seq, i) => {
      for (const etape of seq) {
        const els = pyJsonLoads(etape.entree) as Dict[];
        assignStableIds("vec", `vec-ids-${i}`, els);
        registerDesktopObservation("vec", `vec-ids-${i}`, els);
        expect(
          els.map((e) => brut(e["id"] ?? null)),
          etape.entree,
        ).toEqual(etape.ids);
      }
    });
  });

  it("résolution (ancres épinglées et apprises) et requêtes ambiguës", async () => {
    let i = 0;
    for (const c of liste<{
      elements: string;
      options: Dict;
      epingle: unknown;
      sortie: Attendu;
      sortie_bis: Attendu;
      ancres: unknown[][];
    }>(ses["resolutions"])) {
      const cible = `vec-res-${i++}`;
      registerDesktopObservation(
        "vec",
        cible,
        assignStableIds("vec", cible, pyJsonLoads(c.elements) as unknown[]),
      );
      const journal: JournalAncres = [];
      ancres(() => (c.epingle ? { auto_id: c.epingle, role: "", center: null } : null), journal);
      const near = c.options["near"] as number[] | undefined;
      const criteres = { ...c.options, near: near ? ([near[0] ?? 0, near[1] ?? 0] as const) : undefined };
      await rejouerAsync(() => resolveElementImpl("vec", cible, criteres), c.sortie, c.elements);
      await rejouerAsync(() => resolveElementImpl("vec", cible, criteres), c.sortie_bis, c.elements);
      expect(journal, c.elements).toEqual(c.ancres);
    }
    i = 0;
    for (const c of liste<
      Attendu & { elements: string; requete: unknown; epingle: unknown; ancres: unknown[][] }
    >(ses["ambigus"])) {
      const cible = `vec-amb-${i++}`;
      registerDesktopObservation(
        "vec",
        cible,
        assignStableIds("vec", cible, pyJsonLoads(c.elements) as unknown[]),
      );
      const journal: JournalAncres = [];
      ancres(() => (c.epingle ? { auto_id: c.epingle } : null), journal);
      await rejouerAsync(() => ambiguousQueryCandidates("vec", cible, c.requete), c, c.elements);
      expect(journal, c.elements).toEqual(c.ancres);
    }
    installerAncres(null);
  });

  it("trames d'un résultat desktop_* et dimensions d'écran", () => {
    for (const c of liste<Attendu & { outil: unknown; args: unknown; resultat: unknown }>(ses["trames"]))
      rejouer(
        () => extractDesktopFrame(c.outil, c.args, c.resultat, 1_700_000_000.123),
        c,
        String(c.resultat),
      );
    let i = 0;
    for (const c of liste<Attendu & { w: unknown; h: unknown; lu: unknown }>(ses["dimensions"])) {
      const cible = `vec-dims-${i++}`;
      rejouer(() => setScreenDims("vec", cible, c.w, c.h) ?? null, c, JSON.stringify(c));
      expect(getScreenDims("vec", cible), JSON.stringify(c)).toEqual(c.lu);
    }
  });

  it("cible active par compte : même fichier JSON que Python", async () => {
    const dossier = mkdtempSync(join(tmpdir(), "elpis-actif-"));
    onTestFinished(() => rmSync(dossier, { recursive: true, force: true }));
    const chemin = join(dossier, "sous", "desktop_active.json");
    const avant = process.env["DESKTOP_ACTIVE_PATH"];
    process.env["DESKTOP_ACTIVE_PATH"] = chemin;
    try {
      for (const c of liste<Dict>(ses["cibles_actives"])) {
        if ("utilisateur" in c) {
          await setActiveTarget(c["utilisateur"] as string, c["cible"] as string);
          expect(readFileSync(chemin, "utf-8"), JSON.stringify(c)).toBe(c["fichier"]);
          expect(await getActiveTarget(c["utilisateur"] as string)).toBe(c["lue"]);
          continue;
        }
        writeFileSync(chemin, c["contenu"] as string, "utf-8");
        expect(await getActiveTarget("alice"), String(c["contenu"])).toBe(c["lue"]);
        await rejouerAsync(
          async () => (await setActiveTarget("carol", "vm9")) ?? null,
          c["ecriture"] as Attendu,
          String(c["contenu"]),
        );
        expect(readFileSync(chemin, "utf-8"), String(c["contenu"])).toBe(c["apres"]);
      }
    } finally {
      if (avant === undefined) delete process.env["DESKTOP_ACTIVE_PATH"];
      else process.env["DESKTOP_ACTIVE_PATH"] = avant;
    }
  });
});

describe("rejeu : fonctions pures", () => {
  it("délais, comparaisons de texte, modes, comptes, requêtes d'attente", () => {
    for (const c of liste<{ entree: unknown; valeur: number }>(rej["timeouts"]))
      expect(clampTimeout(c.entree), String(c.entree)).toBe(c.valeur);
    for (const c of liste<Attendu & { h: unknown; n: unknown; cmp: unknown }>(rej["comparaisons"]))
      rejouer(() => textCmp(c.h, c.n, c.cmp), c, JSON.stringify(c));
    for (const c of liste<{ attente: string; valeur: string }>(rej["modes"]))
      expect(expectCmp(pyJsonLoads(c.attente)), c.attente).toBe(c.valeur);
    for (const c of liste<{ v: unknown; n: unknown; cmp: unknown; valeur: boolean }>(rej["valeurs"]))
      expect(valueMatches(c.v, c.n, c.cmp), JSON.stringify(c)).toBe(c.valeur);
    for (const c of liste<{ cnt: number; op: unknown; n: number; valeur: boolean }>(rej["comptes"]))
      expect(countOk(c.cnt, c.op, c.n), JSON.stringify(c)).toBe(c.valeur);
    for (const c of liste<{ attente: string; valeur: string }>(rej["requetes"]))
      expect(expectQuery(pyJsonLoads(c.attente)), c.attente).toBe(c.valeur);
  });

  it("libellés, points d'ancre, centres, arguments, réessais, politiques, clés, sondes, Hamming, constantes", () => {
    for (const c of liste<Attendu & { pas: string }>(rej["labels"]))
      rejouer(() => stepLabel(pyJsonLoads(c.pas)), c, c.pas);
    for (const c of liste<Attendu & { ancre: string }>(rej["points"]))
      rejouer(() => anchorPoint(pyJsonLoads(c.ancre)), c, c.ancre);
    for (const c of liste<Attendu & { element: string }>(rej["centres"]))
      rejouer(() => center(pyJsonLoads(c.element)), c, c.element);
    for (const c of liste<{ args: string; valeur: unknown }>(rej["arguments"]))
      expect(brut(actKwargs(pyJsonLoads(c.args))), c.args).toEqual(c.valeur);
    for (const c of liste<{ pas: string; valeur: number }>(rej["reessais"]))
      expect(stepRetry(pyJsonLoads(c.pas)), c.pas).toBe(c.valeur);
    for (const c of liste<{ pas: string; defaut: string; valeur: string }>(rej["politiques"]))
      expect(stepOnError(pyJsonLoads(c.pas), c.defaut), c.pas).toBe(c.valeur);
    for (const c of liste<{ element: string; valeur: string }>(rej["cles_elements"]))
      expect(elKey(pyJsonLoads(c.element)), c.element).toBe(c.valeur);
    for (const c of liste<{ obs: string; valeur: boolean }>(rej["sondes"]))
      expect(sondeOk(pyJsonLoads(c.obs)), c.obs).toBe(c.valeur);
    for (const c of liste<{ a: unknown; b: unknown; valeur: number }>(rej["hamming"]))
      expect(hamHex(c.a, c.b), JSON.stringify(c)).toBe(c.valeur);
    expect({
      defaut: DEFAULT_TIMEOUT_MS,
      min: MIN_TIMEOUT_MS,
      max: MAX_TIMEOUT_MS,
      stable: STABLE_CEILING_MS,
      calme: SETTLE_QUIET_MS,
      sondage: SETTLE_POLL_MS,
      element: ELEMENT_POLL_MS,
      texte: TEXT_POLL_MS,
      identique: SIG_SAME,
      pause: RETRY_BACKOFF_MS,
      reessais: MAX_RETRY,
    }).toEqual(rej["constantes"]);
  });
});

/** Primitives scriptées comme l'environnement Python : sondes et observations inscrites dans la session. */
function primitivesScriptees(script: Dict, journal: unknown[]): PrimitivesBureau {
  const files = new Map(Object.entries(script).filter(([, v]) => Array.isArray(v)) as [string, unknown[]][]);
  const suivant = (cle: string, defaut: unknown): unknown => {
    const f = files.get(cle);
    if (!f || f.length === 0) return structuredClone(defaut);
    return structuredClone(f.length > 1 ? f.shift() : f[0]);
  };
  const inscrire = (u: string, t: string, res: unknown): unknown => {
    const r = res as Dict | null;
    if (r && typeof r === "object" && !Array.isArray(r) && r["ok"] !== false && Array.isArray(r["elements"]))
      registerDesktopObservation(u, t, assignStableIds(u, t, r["elements"]));
    return res;
  };
  return {
    grab: async (_u, t) => {
      journal.push(["grab", t]);
      return { ok: true, sig: suivant("sigs", "aaaaaaaaaaaaaaaa") };
    },
    probeTree: async (u, t) => {
      journal.push(["probe", t]);
      return inscrire(u, t, suivant("sondes", { ok: true, elements: [] }));
    },
    observe: async (u, t, o) => {
      journal.push(["observe", t, o.prompt, o.use_vision, o.use_tree, o.persist_frame ?? true]);
      return inscrire(u, t, suivant("observes", { ok: true, elements: [], frame_token: "f" }));
    },
    act: async (_u, t, kw) => {
      journal.push(["act", t, { ...kw }]);
      return suivant("actions", { ok: true, op: kw["op"] ?? null, frame_token: "tok" });
    },
    readText: async (_u, t, o) => {
      journal.push(["read", t, o.element_id ?? ""]);
      return { ok: true, text: suivant("textes", "") };
    },
    launch: async (_u, t, o) => {
      journal.push(["launch", t, o.app, o.timeout_ms]);
      return suivant("lancements", { ok: true, found: true, frame_token: "f" });
    },
    waitWindow: async (_u, t, o) => {
      journal.push([
        "wait_window",
        t,
        { title_re: o.title_re, auto_id: o.auto_id, ready: o.ready, timeout_ms: o.timeout_ms },
      ]);
      return suivant("fenetres", { ok: true, found: true });
    },
  };
}

/** Horloge simulée neuve (une par scénario, comme le module `time` remplacé côté Python). */
function horlogeNeuve(): void {
  const h = { t: 1000.0 };
  installerHorlogeRejeu({
    monotone: () => h.t,
    dormir: async (s) => {
      h.t += s;
    },
  });
}

describe("rejeu de scénarios (primitives et horloge simulées)", () => {
  afterAll(() => {
    installerHorlogeRejeu(null);
    installerPrimitivesBureau(null);
    installerAncres(null);
  });

  it(`${rej.scenarios.length} scénarios : mêmes résultats, mêmes appels aux primitives`, async () => {
    for (const sc of rej.scenarios) {
      const nom = sc["nom"] as string;
      horlogeNeuve();
      const journal: unknown[] = [];
      const ancresVues: JournalAncres = [];
      ancres(() => null, ancresVues);
      installerPrimitivesBureau(primitivesScriptees(sc["script"] as Dict, journal));
      const restaurer =
        "heal" in sc
          ? surchargerConfig({ DESKTOP_REPLAY_SELF_HEAL_MAX: sc["heal"] as number })
          : () => undefined;
      let appels = 0;
      const pasVus: unknown[] = [];
      const arret = sc["arret_apres"] as number | undefined;
      const leve = Boolean(sc["arret_leve"]);
      try {
        await rejouerAsync(
          () =>
            replayScenario(structuredClone(sc["pas"]), "u", sc["cible"] as string, {
              onStep: (rec) => {
                pasVus.push(rec["step_index"]);
                if (sc["leve"]) throw new Error("rappel en panne");
              },
              fromStep: sc["depuis"] ?? 0,
              defaultOnError: (sc["defaut"] as string | undefined) ?? "continue",
              shouldAbort:
                arret !== undefined || leve
                  ? () => {
                      appels += 1;
                      if (leve) throw Object.assign(new Error("arrêt en panne"), { name: "RuntimeError" });
                      return arret !== undefined && appels > arret;
                    }
                  : null,
            }),
          sc["sortie"] as Attendu,
          nom,
        );
      } finally {
        restaurer();
      }
      const records = ancresVues.filter((a) => a[0] === "record").map((a) => ["ancre", ...a]);
      expect(brut([...journal, ...records]), nom).toEqual(decoder(sc["journal"]));
      expect(pasVus, nom).toEqual(sc["pas_vus"]);
      expect(appels, nom).toBe(sc["appels_arret"]);
    }
  });
});
