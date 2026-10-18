// SPDX-License-Identifier: MIT
/** packages/navigateur/src/client.ts — client du service navigateur (port des fonctions de llm_core/tools/firefox_tools.py) : propriétaire imposé à chaque requête, enveloppes d'erreur, rognage des résultats, DSL des cibles. */
import { request } from "undici";

import {
  clesOrdonnees,
  estDict,
  estErreurPython,
  intPy,
  lowerPy,
  poserCle,
  prefixePy,
  pyJsonDumps,
  pyJsonLoads,
  quotePy,
  reprPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { clipText, err } from "@elpis/outils-mcp";

import { getPwSessionOwner, pwVerbOf } from "./session";
import { browserUrlBlockReason, refusMessage } from "./url";
import type { OptionsGardeNavigateur } from "./url";

/** Couples méthode/chemin appelés par les outils `pw_*` (extraits du source Python par le générateur de vecteurs). */
export const POINTS_D_ENTREE: readonly (readonly [string, string])[] = [
  ["GET", "/frames"],
  ["GET", "/health"],
  ["GET", "/list_tabs"],
  ["GET", "/mock/list"],
  ["GET", "/network"],
  ["GET", "/observe"],
  ["GET", "/recorder/dump"],
  ["GET", "/recorder/status"],
  ["GET", "/sessions"],
  ["GET", "/smart_inspect"],
  ["POST", "/a11y_audit"],
  ["POST", "/action"],
  ["POST", "/chain"],
  ["POST", "/cleanup"],
  ["POST", "/close_tab"],
  ["POST", "/dialog"],
  ["POST", "/element_info"],
  ["POST", "/element_screenshot"],
  ["POST", "/evaluate"],
  ["POST", "/expect"],
  ["POST", "/extract_table"],
  ["POST", "/extract_text"],
  ["POST", "/handle_dropdown"],
  ["POST", "/locator"],
  ["POST", "/mock/add"],
  ["POST", "/mock/clear"],
  ["POST", "/mock/remove"],
  ["POST", "/new_tab"],
  ["POST", "/print_pdf"],
  ["POST", "/recorder/clear"],
  ["POST", "/recorder/start"],
  ["POST", "/recorder/stop"],
  ["POST", "/save_state"],
  ["POST", "/screenshot"],
  ["POST", "/start"],
  ["POST", "/stop"],
  ["POST", "/switch_tab"],
  ["POST", "/trace_export"],
  ["POST", "/visual"],
  ["POST", "/wait_for"],
  ["POST", "/wait_for_dynamic"],
];

/** Route de l'application qui relaie une capture PNG du service. */
export const SCREENSHOT_URL_PREFIX = "/api/playwright/screenshot/";
const SLUG = /[^a-z0-9]+/gu;

const ANSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, "gu");

/** Texte sans séquences ANSI (journaux d'appel colorés de Playwright). */
export function sansAnsi(texte: string): string {
  return texte.replace(ANSI, "");
}

// Messages du TS qui portent une donnée (action, condition, délai) : code fixe à la place du slug.
const CODES_MESSAGE: readonly (readonly [RegExp, string])[] = [
  [/^unknown action\b|^action=.* unknown$/u, "unknown_action"],
  [/^condition=.* unknown$/u, "unknown_condition"],
  [/^Timeout \(/u, "timeout"],
  [/^Playwright error \(\d+\)$/u, "service_error"],
  [/^target or selector required/u, "target_required"],
  [/^session_id required/u, "session_id_required"],
  [/^ax memory query failed/u, "ax_memory_error"],
];

/** Code d'une erreur du TS : code déjà propre gardé, motif connu (message avec donnée), sinon slug du message fixe. */
export function codeNavigateur(msg: unknown): string {
  const texte = strPy(msg);
  if (/^[a-z][a-z0-9_]{0,39}$/u.test(texte)) return texte;
  for (const [motif, code] of CODES_MESSAGE) if (motif.test(texte)) return code;
  const slug = lowerPy(texte)
    .replace(SLUG, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 40);
  return slug || "browser_error";
}

/** `_err` : code stable (`codeNavigateur`, écart voulu au slug Python pour les messages porteurs de données), message sans ANSI, correctif. */
export function errPw(
  msg: unknown,
  hint: string | null = "",
  options: { code?: string; message?: string; fix?: string | null; [cle: string]: unknown } = {},
): Dict {
  const { code, message, fix, ...contexte } = options;
  const correctif = (veritePy(fix) ? fix : hint) || null;
  return err(code || codeNavigateur(msg), sansAnsi(message || strPy(msg)), { ...contexte, fix: correctif });
}

// Erreur sans code d'un service ancien : motif connu, sinon `browser_error` (jamais un morceau du message).
const CODES_SERVICE: readonly (readonly [RegExp, string])[] = [
  [/Timeout \d+ms exceeded/u, "timeout"],
  [/^Navigation (échouée|failed)|net::ERR_|NS_ERROR_/u, "navigation_failed"],
];

/** Code d'une erreur du service qui n'en porte pas : code propre gardé, motif connu, `browser_error`, `service_error` sans message. */
export function codeDuService(msg: string | null): string {
  if (msg === null) return "service_error";
  if (/^[a-z][a-z0-9_]{0,39}$/u.test(msg)) return msg;
  for (const [motif, code] of CODES_SERVICE) if (motif.test(msg)) return code;
  return "browser_error";
}

/** Champs d'une erreur du service hors enveloppe (suggestions, candidats, options…), sans les clés de l'enveloppe. */
function contexteDuService(c: Dict): Dict {
  const out: Dict = {};
  for (const [k, v] of Object.entries(c))
    if (!["error", "code", "fix", "message", "ok", "status", "owner", "tab_hint"].includes(k)) out[k] = v;
  return out;
}

/** `PLAYWRIGHT_RESULT_BUDGET` (24 000 par défaut, 4 000 au moins), lu à l'appel ; une valeur illisible lève comme `int()`. */
export function budgetResultat(): number {
  const brut = process.env["PLAYWRIGHT_RESULT_BUDGET"] ?? "24000";
  return Math.max(4000, intPy(brut || 24000));
}

function longueurJson(obj: unknown): number | null {
  try {
    return pyJsonDumps(obj).length;
  } catch {
    return null;
  }
}

/** `_clip_result` : rien si le résultat tient dans le budget ; sinon champs texte rognés (profondeur 12), puis enveloppe partielle au-delà du double. */
export function clipResult(obj: unknown, strCap = 2000): unknown {
  const budget = budgetResultat();
  const n = longueurJson(obj);
  if (n === null || n <= budget) return obj;
  const parcourir = (o: unknown, profondeur: number): unknown => {
    if (profondeur > 12) return o;
    if (typeof o === "string")
      return Array.from(o).length > strCap ? clipText(o, strCap, { label: "champ" }) : o;
    if (estDict(o)) {
      const d: Dict = {};
      for (const k of clesOrdonnees(o)) poserCle(d, k, parcourir(o[k], profondeur + 1));
      return d;
    }
    if (Array.isArray(o)) return o.map((v) => parcourir(v, profondeur + 1));
    return o;
  };
  const rogne = parcourir(obj, 0);
  const m = longueurJson(rogne);
  if (m !== null && m > budget * 2)
    return {
      ok: true,
      _truncated: true,
      note: "page result too large even after clipping — use level='lite', viewport_only=True, or a narrower selector/target",
      partial: prefixePy(reprPy(rogne), budget),
    };
  return rogne;
}

/** `_avec_proprietaire`, mais IMPOSÉ : `owner` écrase toujours celui d'un appelant (écart : Python gardait la valeur déjà présente). */
export function avecProprietaire(
  owner: string,
  corps: unknown,
  params: Dict | null,
  methode: string,
): [unknown, Dict | null] {
  if (!owner) return [corps, params];
  if (methode === "GET") return [corps, { ...(params ?? {}), owner }];
  if (corps === null || corps === undefined || estDict(corps)) return [{ ...(corps ?? {}), owner }, params];
  return [corps, params];
}

/** Onglet actif rappelé par le service sur une erreur (`tab_hint`, écart voulu) : message complété, onglet actif et nombre d'onglets ; `{}` sinon. */
export function rappelOnglet(c: Dict, message: string): Dict {
  if (typeof c["tab_hint"] !== "string" || !c["tab_hint"]) return {};
  return {
    message: `${message} [${c["tab_hint"]}]`,
    active_tab: c["active_tab"] ?? null,
    total_tabs: c["total_tabs"] ?? null,
  };
}

/** `_refus_url` : enveloppe `url_blocked` avec le message du service si la garde refuse l'adresse, sinon `null` (garde en échec : le service tranche). */
export async function refusUrl(url: unknown, options: OptionsGardeNavigateur = {}): Promise<Dict | null> {
  const texte = veritePy(url) ? strPy(url) : "";
  let motif: string | null;
  try {
    motif = await browserUrlBlockReason(texte, options);
  } catch {
    return null;
  }
  if (!motif) return null;
  return errPw("url_blocked", "", {
    message: refusMessage(texte, motif),
    fix: "choisissez une adresse http(s) d'un site hors de la machine qui héberge Elpis",
  });
}

/** `_refus_session_d_autrui` : une session inconnue ou d'un autre compte est refusée (le service revérifie le propriétaire). */
export async function refusSessionDAutrui(sessionId: unknown, username: string): Promise<Dict | null> {
  if (!veritePy(sessionId)) return null;
  let proprio: string | null;
  try {
    proprio = await getPwSessionOwner(strPy(sessionId));
  } catch {
    proprio = null;
  }
  if (proprio !== null && proprio === username) return null;
  return errPw("not_your_session", "", {
    message:
      proprio === null
        ? "session de navigateur inconnue pour ce compte"
        : "cette session de navigateur appartient à un autre utilisateur",
    fix: "pw_session(action='start', url=…) ouvre (ou retrouve) la vôtre",
  });
}

/** `_corps_json` : corps JSON s'il est un objet, sinon `{}`. */
export function corpsJson(texte: string): Dict {
  try {
    const corps = pyJsonLoads(texte);
    return estDict(corps) ? corps : {};
  } catch {
    return {};
  }
}

/** `params=` de requests : `urlencode(doseq=True)` en `quote_plus`, valeurs `None` omises, autres valeurs par `str()`. */
export function encoderParams(params: Dict | null): string {
  const paires: string[] = [];
  const plus = (s: string): string => quotePy(s, " ").replaceAll(" ", "+");
  for (const [k, v] of Object.entries(params ?? {}))
    for (const x of Array.isArray(v) ? v : [v])
      if (x !== null && x !== undefined) paires.push(`${plus(k)}=${plus(strPy(x))}`);
  return paires.join("&");
}

export interface OptionsClientNavigateur {
  /** Propriétaire transmis à chaque requête (`pw_owner` du compte) ; obligatoire. */
  owner: string;
  /** `PLAYWRIGHT_API_URL`, `http://localhost:3000` par défaut. */
  base?: string;
  /** `PLAYWRIGHT_TIMEOUT` en secondes, 10 par défaut. */
  delaiS?: number;
}

export interface OptionsRequete {
  json?: unknown;
  params?: Dict | null;
  timeout?: number | null;
}

export type Echec = { genre: "connexion" | "delai" | "autre"; message: string };

const CODES_DELAI: ReadonlySet<string> = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
// `ConnectionError` de requests (dont `ConnectTimeout`, résolution et TLS) : erreurs système, sockets d'undici, certificats ; le reste est rendu par son message.
const CODES_CONNEXION: ReadonlySet<string> = new Set([
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_CLOSED",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
]);
const CODES_CONNEXION_MOTIF =
  /^(E(?!RR_)[A-Z_]+|ERR_(TLS|SSL)_[A-Z_]+|CERT_[A-Z_]+|UNABLE_TO_[A-Z_]+|(DEPTH_ZERO_)?SELF_SIGNED_[A-Z_]+)$/u;

/** Échec d'undici rangé comme requests : délai de lecture, connexion impossible (« service absent »), autre. */
export function classerErreur(e: unknown): Echec {
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : String(e);
  if (typeof code === "string" && CODES_DELAI.has(code)) return { genre: "delai", message };
  if (typeof code === "string" && (CODES_CONNEXION_MOTIF.test(code) || CODES_CONNEXION.has(code)))
    return { genre: "connexion", message };
  return { genre: "autre", message };
}

/** Client d'un appel d'outil : le propriétaire est fixé à la construction et ajouté à chaque requête. */
export class ClientNavigateur {
  readonly owner: string;
  readonly base: string;
  readonly delaiS: number;

  constructor(o: OptionsClientNavigateur) {
    if (!o.owner) throw new Error("client du service navigateur sans propriétaire");
    this.owner = o.owner;
    this.base = o.base ?? process.env["PLAYWRIGHT_API_URL"] ?? "http://localhost:3000";
    this.delaiS = o.delaiS ?? intPy(process.env["PLAYWRIGHT_TIMEOUT"] ?? "10");
  }

  /** Une requête au service : statut et texte, ou l'échec classé comme requests (connexion, délai, autre). */
  private async envoyer(
    methode: string,
    endpoint: string,
    o: OptionsRequete,
  ): Promise<{ statut: number; texte: string } | Echec> {
    const t = o.timeout ?? this.delaiS;
    const [corps, params] = avecProprietaire(this.owner, o.json ?? null, o.params ?? null, methode);
    let url: string;
    let charge: string | undefined;
    try {
      const query = methode === "GET" ? encoderParams(params) : "";
      url = `${this.base}${endpoint}${query ? `?${query}` : ""}`;
      if (methode !== "GET" && corps !== null) charge = pyJsonDumps(corps, { allowNan: false });
    } catch (e) {
      return { genre: "autre", message: e instanceof Error ? e.message : String(e) };
    }
    if (!(t > 0))
      return {
        genre: "autre",
        message: `Attempted to set connect timeout to ${t}, but the timeout cannot be set to a value less than or equal to 0.`,
      };
    try {
      const r = await request(url, {
        method: methode === "GET" ? "GET" : "POST",
        headers: charge === undefined ? {} : { "content-type": "application/json" },
        body: charge,
        headersTimeout: t * 1000,
        bodyTimeout: t * 1000,
      });
      return { statut: r.statusCode, texte: await r.body.text() };
    } catch (e) {
      return classerErreur(e);
    }
  }

  /** `_req` : résultat JSON rogné, ou enveloppe d'erreur (410, code stable du service à tout statut — écart : Python ne le lisait qu'en 404 —, autre statut, service absent, délai). */
  async req(methode: string, endpoint: string, o: OptionsRequete = {}): Promise<unknown> {
    const t = o.timeout ?? this.delaiS;
    const r = await this.envoyer(methode, endpoint, o);
    if ("genre" in r) {
      if (r.genre === "connexion") return errPw("Playwright server not running", "start it: node server.js");
      if (r.genre === "delai")
        return errPw(`Timeout (${t}s)`, "the page may be slow or stuck; retry or simplify the action");
      return errPw(r.message, "", { code: "browser_error" });
    }
    if (r.statut === 410) return errPw("Session expired", "reopen with pw_session(action='start')");
    if (r.statut !== 200) {
      const c = corpsJson(r.texte);
      const msg = typeof c["error"] === "string" ? c["error"] : null;
      const onglet = msg ? rappelOnglet(c, msg) : {};
      // Erreur codée du service (tout statut) : son code, son message, son contexte (suggestions, candidats…) et l'onglet actif.
      if (msg && typeof c["code"] === "string" && c["code"])
        return errPw(c["code"], "", {
          message: msg,
          fix: strPy(veritePy(c["fix"]) ? c["fix"] : ""),
          ...contexteDuService(c),
          ...onglet,
        });
      if (r.statut === 404) return errPw("Session not found", "start one with pw_session(action='start')");
      return errPw(msg || `Playwright error (${r.statut})`, msg ? null : prefixePy(r.texte, 500) || null, {
        code: codeDuService(msg),
        ...onglet,
      });
    }
    try {
      return clipResult(pyJsonLoads(r.texte));
    } catch (e) {
      return errPw(e instanceof Error ? e.message : String(e), "", { code: "invalid_response" });
    }
  }

  /** `_req_status` : `[statut, corps]` sans enveloppe (408 « pas encore » distingué d'une erreur) ; -1 sur échec de transport. */
  async reqStatus(methode: string, endpoint: string, o: OptionsRequete = {}): Promise<[number, Dict]> {
    const r = await this.envoyer(methode, endpoint, o);
    if ("genre" in r) {
      if (r.genre === "connexion") return [-1, { error: "connection_refused" }];
      if (r.genre === "delai") return [-1, { error: "client_timeout" }];
      return [-1, { error: r.message }];
    }
    try {
      const corps = pyJsonLoads(r.texte);
      return [r.statut, estDict(corps) ? corps : { value: corps }];
    } catch {
      return [r.statut, { error: prefixePy(r.texte || "", 500) }];
    }
  }

  /** `_finish_act` : instantané léger de la page joint au résultat d'une action réussie (bonus : jamais d'échec). */
  async finishAct(
    result: unknown,
    sessionId: string,
    observe: boolean,
    maxItems: unknown = 25,
  ): Promise<unknown> {
    if (observe && estDict(result) && !veritePy(result["error"])) {
      try {
        const snap = await this.req("GET", "/smart_inspect", {
          params: {
            session_id: sessionId,
            level: "lite",
            viewport_only: "true",
            max_items: clampItems(maxItems, 25),
            skip_screenshot: "true",
          },
        });
        if (estDict(snap) && !veritePy(snap["error"])) result = { ...result, page_after: snap };
      } catch {
        // observation en prime : le résultat de l'action reste intact
      }
    }
    return clipResult(result);
  }

  /** `_ax_get_current_url` : URL de la page courante, `""` sinon. */
  async axGetCurrentUrl(sessionId: string): Promise<string> {
    try {
      const r = await this.req("GET", "/smart_inspect", {
        params: { session_id: sessionId, skip_screenshot: "true", level: "lite" },
      });
      if (estDict(r)) return veritePy(r["url"]) ? (r["url"] as string) : "";
    } catch {
      return "";
    }
    return "";
  }
}

/** Clés du DSL de cible (`role=button|name=Login`). */
export const DSL_KEYS: ReadonlySet<string> = new Set([
  "role",
  "name",
  "text",
  "label",
  "placeholder",
  "test_id",
  "css",
  "xpath",
  "ref",
  "alt",
  "title",
  "nth",
]);

/** `|` qui sépare deux clés du DSL : non échappé et suivi d'une clé connue puis de `=` (ailleurs, il reste dans la valeur). */
const SEPARATEUR_DSL = new RegExp(String.raw`(?<!\\)\|(?=\s*(?:${[...DSL_KEYS].join("|")})\s*=)`, "giu");

/** Valeur insérée dans une cible DSL : un `|` qui y annoncerait une clé est échappé (`\|`). */
export function echapperDsl(valeur: string): string {
  return valeur.replace(SEPARATEUR_DSL, "\\|");
}

/** `_parse_target_dsl` : premier `=` séparateur, clés nettoyées et en minuscules, valeurs gardées telles quelles (`\|` rendu `|`), `nth` entier ; écart : un `|` coupe la cible seulement devant `clé=`. */
export function parseTargetDsl(target: string): Dict {
  if (!target) return {};
  const out: Dict = {};
  for (const morceau of target.split(SEPARATEUR_DSL)) {
    const i = morceau.indexOf("=");
    if (i < 0) continue;
    const k = lowerPy(stripPy(morceau.slice(0, i)));
    const v = morceau.slice(i + 1).replace(/\\\|/gu, "|");
    if (!DSL_KEYS.has(k)) continue;
    if (k !== "nth") out[k] = v;
    else
      try {
        out[k] = intPy(stripPy(v));
      } catch (e) {
        if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
      }
  }
  return out;
}

/** `_dsl_to_selector` : sélecteur Playwright unique (ref, test_id, css, xpath, label, placeholder, texte, nom), `""` sinon. */
export function dslToSelector(target: string): string {
  const d = parseTargetDsl(target);
  const v = (k: string): string => (veritePy(d[k]) ? strPy(d[k]) : "");
  if (v("ref")) return `ref:${v("ref")}`;
  if (v("test_id")) return `[data-testid="${v("test_id")}"]`;
  if (v("css")) return v("css");
  if (v("xpath")) return `xpath=${v("xpath")}`;
  if (v("label")) return `label=${v("label")}`;
  if (v("placeholder")) return `placeholder=${v("placeholder")}`;
  if (v("text")) return v("text");
  if (v("name")) return v("name");
  return "";
}

/** `_wait_payload` : `{wait_after: entier}` si possible, la valeur brute sinon, `{}` si vide. */
export function waitPayload(waitAfter: unknown): Dict {
  if (!veritePy(waitAfter)) return {};
  try {
    return { wait_after: intPy(waitAfter) };
  } catch (e) {
    if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
    return { wait_after: waitAfter };
  }
}

/** `_clamp_items` : entier borné à [1, 200], la valeur par défaut si illisible. */
export function clampItems(n: unknown, defaut = 25): number {
  try {
    return Math.max(1, Math.min(intPy(n), 200));
  } catch (e) {
    if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
    return defaut;
  }
}

/** `_screenshot_result` : forme stable de `pw_page(action='screenshot')` (fichier, URL de l'application, étape) ; une erreur passe telle quelle. */
export function screenshotResult(r: unknown, o: { fullPage?: unknown; target?: string } = {}): unknown {
  if (!estDict(r) || veritePy(r["error"])) return r;
  const fichier = r["screenshot"];
  const out: Dict = {
    ok: true,
    action: "screenshot",
    screenshot: fichier ?? null,
    screenshot_url: typeof fichier === "string" && fichier ? SCREENSHOT_URL_PREFIX + fichier : null,
    full_page: veritePy(o.fullPage ?? false),
  };
  if (o.target) out["target"] = o.target;
  const pas = r["screenshot_step"];
  if (
    typeof pas === "boolean" ||
    typeof pas === "bigint" ||
    (typeof pas === "number" && Number.isInteger(pas))
  )
    out["screenshot_step"] = pas;
  if (veritePy(r["elements"])) out["elements"] = r["elements"];
  return out;
}

export interface Locateur {
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  test_id?: string;
  css?: string;
  xpath?: string;
  alt?: string;
  title?: string;
  ref?: string;
  nth?: unknown;
  max?: unknown;
  target?: string;
}

/** `_build_locator_payload` : le DSL l'emporte sur les paramètres séparés ; charge `by_*` et paramètres résolus (mémoire AX). */
export function buildLocatorPayload(o: Locateur = {}): [Dict, Dict] {
  const dsl = parseTargetDsl(o.target ?? "");
  const pris = (k: keyof Locateur, defaut: unknown): unknown => (Object.hasOwn(dsl, k) ? dsl[k] : defaut);
  const r: Dict = {};
  for (const k of [
    "role",
    "name",
    "text",
    "label",
    "placeholder",
    "test_id",
    "css",
    "xpath",
    "alt",
    "title",
    "ref",
  ] as const)
    r[k] = pris(k, o[k] ?? "");
  const nth = pris("nth", o.nth ?? -1);
  const ou = (v: unknown): unknown => (veritePy(v) ? v : null);
  const entierPositif =
    typeof nth === "boolean" ||
    ((typeof nth === "number" || typeof nth === "bigint") && Number.isInteger(Number(nth)) && nth >= 0);
  const charge: Dict = {
    by_role: ou(r["role"]),
    by_name: ou(r["name"]),
    by_text: ou(r["text"]),
    by_label: ou(r["label"]),
    by_placeholder: ou(r["placeholder"]),
    by_test_id: ou(r["test_id"]),
    by_css: ou(r["css"]),
    by_xpath: ou(r["xpath"]),
    by_alt: ou(r["alt"]),
    by_title: ou(r["title"]),
    ref: ou(r["ref"]),
    nth: entierPositif ? nth : null,
    max: o.max ?? 5,
  };
  const resolus: Dict = {
    role: r["role"],
    name: r["name"],
    text: r["text"],
    label: r["label"],
    placeholder: r["placeholder"],
    test_id: r["test_id"],
    css: r["css"],
    xpath: r["xpath"],
    ref: r["ref"],
    nth,
  };
  return [charge, resolus];
}

/** `_first` : premier synonyme texte non vide, nettoyé. */
export function first(...candidats: unknown[]): string {
  for (const c of candidats) if (typeof c === "string" && stripPy(c)) return stripPy(c);
  return "";
}

/** `_merge_value` : premier synonyme texte non vide, SANS nettoyage (une saisie peut finir par une espace). */
export function mergeValue(...candidats: unknown[]): string {
  for (const c of candidats) if (typeof c === "string" && c !== "") return c;
  return "";
}

/** `pw_verb` : verbe effectif d'un appel `pw_*` (même règle que le suivi des sessions). */
export const pwVerb = pwVerbOf;

/** `_merge_target` : `target` (DSL) l'emporte ; un `selector` CSS brut devient `css=…`, un `selector` déjà en DSL reste tel quel. */
export function mergeTarget(target: string, selector: string): string {
  const t = stripPy(target || "");
  if (t) return t;
  const s = stripPy(selector || "");
  if (!s) return "";
  return Object.keys(parseTargetDsl(s)).length ? s : `css=${s}`;
}

/** `_dsl_to_by_kw` : DSL → paramètres `by_*` plats (absents = `null`). */
export function dslToByKw(target: string): Dict {
  const d = parseTargetDsl(target);
  const v = (k: string): unknown => (Object.hasOwn(d, k) ? d[k] : null);
  return {
    by_role: v("role"),
    by_name: v("name"),
    by_text: v("text"),
    by_label: v("label"),
    by_placeholder: v("placeholder"),
    by_test_id: v("test_id"),
    by_css: v("css"),
    by_xpath: v("xpath"),
    by_alt: v("alt"),
    by_title: v("title"),
    ref: v("ref"),
    nth: v("nth"),
  };
}

const ou = (...vs: unknown[]): unknown => vs.find((v) => veritePy(v)) ?? vs.at(-1);

/** `_ax_extract_nodes_from_inspect` : nœuds `{role, name}` des listes connues puis de l'arbre (`tree` ou `ax_tree`). */
export function axExtractNodesFromInspect(inspectResult: unknown): Dict[] {
  const noeuds: Dict[] = [];
  if (!estDict(inspectResult)) return noeuds;
  const candidats: unknown[] = [];
  for (const k of ["elements", "interactive", "interactives", "buttons", "inputs", "links", "nodes"]) {
    const v = inspectResult[k];
    if (Array.isArray(v)) candidats.push(...v);
  }
  const arbre = ou(inspectResult["tree"], inspectResult["ax_tree"]);
  const parcourir = (n: unknown): void => {
    if (estDict(n)) {
      const role = ou(n["role"], n["type"], "");
      const nom = ou(n["name"], n["text"], n["label"], "");
      if (veritePy(role)) noeuds.push({ role, name: nom });
      for (const cle of ["children", "nodes"]) {
        const enfants = ou(n[cle], []);
        for (const c of Array.isArray(enfants) ? enfants : estDict(enfants) ? Object.keys(enfants) : [])
          parcourir(c);
      }
    } else if (Array.isArray(n)) for (const c of n) parcourir(c);
  };
  if (Array.isArray(arbre) || estDict(arbre)) parcourir(arbre);
  for (const c of candidats) {
    if (!estDict(c)) continue;
    const role = ou(c["role"], c["tag"], c["type"], "");
    const nom = ou(c["name"], c["text"], c["label"], c["accessible_name"], "");
    if (veritePy(role)) noeuds.push({ role, name: nom });
  }
  return noeuds;
}
