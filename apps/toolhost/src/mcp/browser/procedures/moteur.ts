// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/procedures/moteur.ts — interpréteur déterministe des procédures : l'arbre est rejoué par les mêmes chemins que pw_act et pw_login, sans LLM, avec budget, annulation et arrêt sur geste ambigu. */
import { setTimeout as dormir } from "node:timers/promises";

import { estDict } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { refusCible } from "@elpis/contracts";
import type { Act, Condition, Login, Noeud, Procedure } from "@elpis/contracts";
import { messageErreur } from "@elpis/mcp";
import { dslToSelector, echapperDsl, errPw } from "@elpis/navigateur";
import type { ClientNavigateur } from "@elpis/navigateur";
import type { ContexteAppel, Golden } from "@elpis/outils-mcp";
import goldenBrowser from "@elpis/outils-mcp/goldens/browser.json" with { type: "json" };

import type { ServicesBrowser } from "../appel";
import { nettoyerResultat, secretsRecents } from "../creds";
import { byNonNuls, pwAct } from "../elements";
import { pwLogin } from "../login";

/** Budget d'une exécution : tentatives de geste (cibles essayées comprises) et durée. */
export const BUDGET = {
  gestes: 60,
  dureeMs: 200_000,
  attenteMs: 5000,
  pasMs: 150,
  etapes: 200,
  /** Délai de résolution d'une cible qui n'est pas la dernière : une absente doit laisser vite la place à la suivante. */
  reserveMs: 1500,
} as const;

/** Codes d'un geste qui n'a rien fait : la cible suivante peut être essayée, y compris pour un clic. */
const SANS_EFFET: ReadonlySet<string> = new Set([
  "element_not_found",
  "target_not_found",
  "ambiguous_target",
  "url_blocked",
  "action_required",
  "target_required",
  "option_required",
  "option_not_found",
  "element_detached",
]);
/** Codes d'échec d'une cible que la réparation de l'arbre peut corriger (constatés avant toute action). */
const REPARABLES: ReadonlySet<string> = new Set([
  "element_not_found",
  "target_not_found",
  "ambiguous_target",
  "element_detached",
  "option_not_found",
]);
/** Seuls gestes sans effet de bord : après tout autre geste (fill et select relancent des événements input/change), un expect raté arrête tout. */
const SANS_EFFET_DE_BORD: ReadonlySet<string> = new Set(["goto", "hover", "wait"]);

export type StatutRun = "ok" | "failed" | "needs_confirmation" | "cancelled";

export interface Etape {
  path: string;
  act: string;
  target_used: string | null;
  ok: boolean;
  ms: number;
  reason?: string;
}
export interface EchecRun {
  path: string;
  reason: string;
  tried_targets: string[];
  /** Échec sans effet constaté avant l'action (ou lecture seule) : le modèle peut réparer l'arbre. */
  repairable?: boolean;
  /** Codes des cibles essayées, dans l'ordre. */
  codes?: string[];
  /** Gestes déjà joués dans cette exécution (ou reprise), du plus ancien au plus récent. */
  played?: GestePasse[];
}
export interface GestePasse {
  path: string;
  act: string;
  target_used: string | null;
  /** Un `expect` a confirmé l'effet du geste. */
  expect_confirmed: boolean;
}
export interface ResultatRun {
  status: StatutRun;
  steps: Etape[];
  failed_at?: EchecRun;
  node_path?: string;
  description?: string;
  url: string;
  title: string;
  duration_ms: number;
  attempts: number;
}

export interface OptionsRun {
  readonly sessionId: string;
  readonly username: string;
  readonly params: Readonly<Record<string, string | number>>;
  /** Nœuds `confirm` autorisés à s'exécuter. */
  readonly confirmed: readonly string[];
  /** Chemin d'un nœud à reprendre : ce qui le précède est tenu pour fait (page conservée par la session). */
  readonly reprise: string | null;
}

type Issue = { k: "ok" } | { k: "fail" } | { k: "halt"; statut: Exclude<StatutRun, "ok"> };
const OK: Issue = { k: "ok" };
const FAIL: Issue = { k: "fail" };
const halte = (statut: Exclude<StatutRun, "ok">): Issue => ({ k: "halt", statut });

class Annulation extends Error {}

const GESTES: Readonly<Record<string, string>> = {
  click: "click",
  fill: "fill",
  select: "select",
  press: "press",
  check: "check",
  uncheck: "uncheck",
  hover: "hover",
};

/** Paramètres facultatifs d'un outil `pw_*` à leur défaut du golden (le moteur appelle les traitements sans passer par la validation MCP). */
function defauts(nom: string): Dict {
  const f = GOLDEN.fonctions[nom];
  return Object.fromEntries(
    (f?.parametres ?? []).filter((p) => !p.requis).map((p) => [p.nom, p.defaut ?? null]),
  );
}

const GOLDEN = goldenBrowser as unknown as Golden;
const echappeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/** Origine d'une adresse, `""` si elle n'en a pas (about:blank…). */
function origineDe(u: string): string {
  try {
    const o = new URL(u).origin;
    return o === "null" ? "" : o;
  } catch {
    return "";
  }
}

/** Code et message d'un résultat d'outil en échec, `null` s'il a réussi. */
function echec(r: unknown): { code: string; message: string } | null {
  if (!estDict(r)) return { code: "bad_result", message: "résultat illisible" };
  const code = typeof r["error"] === "string" ? r["error"] : typeof r["code"] === "string" ? r["code"] : "";
  if (r["ok"] === false || code !== "") {
    const m = typeof r["message"] === "string" ? r["message"] : "";
    return { code: code || "failed", message: m.slice(0, 200) };
  }
  return null;
}

/** Adresse courante d'une session (`/sessions` ne prend pas le verrou de la session). */
async function adresseSession(client: ClientNavigateur, sessionId: string): Promise<string> {
  const r = await client.req("GET", "/sessions");
  const l = estDict(r) && Array.isArray(r["sessions"]) ? (r["sessions"] as unknown[]) : [];
  const x = l.find((e) => estDict(e) && e["session_id"] === sessionId);
  return estDict(x) && typeof x["url"] === "string" ? x["url"] : await client.axGetCurrentUrl(sessionId);
}

/** Page de la session sans fragment (origine, chemin et requête triée sans suivi ; adresse purgée par le service), `""` si illisible : liée à l'attente de confirmation. */
export async function pageCourante(client: ClientNavigateur, sessionId: string): Promise<string> {
  try {
    const u = new URL(await adresseSession(client, sessionId));
    // Query comprise (paramètres triés, suivi publicitaire exclu), ancre ignorée : /transfert?to=alice et ?to=bob sont deux pages.
    const q = [...u.searchParams]
      .filter(([k]) => !/^(utm_.*|utm|fbclid|gclid)$/iu.test(k))
      .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
    const requete = new URLSearchParams(q).toString();
    return `${u.origin}${u.pathname}${requete ? `?${requete}` : ""}`;
  } catch {
    return "";
  }
}

class Execution {
  readonly steps: Etape[] = [];
  echec: EchecRun | null = null;
  confirmation: { path: string; description: string } | null = null;
  tentatives = 0;
  private url = "";
  private readonly t0 = Date.now();
  private readonly abandon: Promise<never>;
  private readonly arreter: () => void;
  private annule = false;
  private readonly joues: GestePasse[] = [];
  /** Un geste à effet (click, press, fill, select, check, uncheck) a réussi sans `expect` : plus rien n'est réparable ensuite. */
  private effetSansExpect = false;
  private readonly confirmesFaits = new Set<string>();
  private readonly act: (a: Dict, c: ContexteAppel, b: Dict) => Promise<unknown>;
  private readonly connexion: (a: Dict, c: ContexteAppel, b: Dict) => Promise<unknown>;

  private readonly s: ServicesBrowser;
  private readonly ctx: ContexteAppel;
  private readonly client: ClientNavigateur;
  private readonly p: Procedure;
  private readonly o: OptionsRun;

  constructor(s: ServicesBrowser, ctx: ContexteAppel, client: ClientNavigateur, p: Procedure, o: OptionsRun) {
    this.s = s;
    this.ctx = ctx;
    this.client = client;
    this.p = p;
    this.o = o;
    this.act = pwAct(s);
    this.connexion = pwLogin(s);
    let rejeter: (e: Error) => void = () => undefined;
    this.abandon = new Promise<never>((_, rej) => {
      rejeter = rej;
    });
    this.abandon.catch(() => undefined);
    const sur = (): void => rejeter(new Annulation());
    this.arreter = () => ctx.signal.removeEventListener("abort", sur);
    if (ctx.signal.aborted) sur();
    else ctx.signal.addEventListener("abort", sur, { once: true });
  }

  fin(): void {
    this.arreter();
  }

  get ecoule(): number {
    return Date.now() - this.t0;
  }

  /** Adresse courante de la session. */
  async adresse(): Promise<string> {
    return adresseSession(this.client, this.o.sessionId);
  }

  async amorcer(): Promise<void> {
    this.url = await this.adresse().catch(() => "");
  }

  /** URL et titre de la page à la fin, purgés comme tout résultat pw_*. */
  async page(): Promise<{ url: string; title: string }> {
    // Annulé : la session peut encore tenir un geste (verrou), la page n'est pas relue.
    if (this.annule) return nettoyerResultat({ url: this.url, title: "" }, secretsRecents(this.o.username));
    try {
      const r = await this.client.req("GET", "/smart_inspect", {
        params: { session_id: this.o.sessionId, level: "lite", skip_screenshot: "true", max_items: 1 },
        timeout: 5,
      });
      if (estDict(r) && typeof r["url"] === "string") {
        const sortie = nettoyerResultat(
          { url: r["url"], title: typeof r["title"] === "string" ? r["title"] : "" },
          secretsRecents(this.o.username),
        );
        return sortie;
      }
    } catch {
      // page en prime : le résultat de l'exécution reste valable
    }
    return nettoyerResultat({ url: this.url, title: "" }, secretsRecents(this.o.username));
  }

  private sub(texte: string, mode: "texte" | "dsl" | "url"): string {
    return texte.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_, nom: string) => {
      const v = Object.hasOwn(this.o.params, nom) ? String(this.o.params[nom]) : "";
      return mode === "dsl" ? echapperDsl(v) : mode === "url" ? encodeURIComponent(v) : v;
    });
  }

  private subCondition(c: Condition): Condition {
    return {
      ...(c.url_path !== undefined ? { url_path: this.sub(c.url_path, "texte") } : {}),
      ...(c.visible !== undefined ? { visible: this.sub(c.visible, "dsl") } : {}),
      ...(c.text !== undefined ? { text: this.sub(c.text, "texte") } : {}),
      ...(c.not !== undefined ? { not: this.subCondition(c.not) } : {}),
    };
  }

  private noter(
    path: string,
    act: string,
    cible: string | null,
    ok: boolean,
    t: number,
    reason?: string,
  ): void {
    if (this.steps.length >= BUDGET.etapes) return;
    this.steps.push({
      path,
      act,
      target_used: cible,
      ok,
      ms: Date.now() - t,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  private rate(
    path: string,
    reason: string,
    tried: string[] = [],
    reparable = false,
    codes: string[] = [],
  ): void {
    this.echec = {
      path,
      reason,
      tried_targets: tried,
      repairable: reparable && !this.effetSansExpect,
      codes,
      played: this.joues.slice(-20),
    };
  }

  /** Arrêt avant un geste : annulation de l'appel ou budget épuisé. */
  private arret(path: string): Issue | null {
    if (this.annule || this.ctx.signal.aborted) {
      this.annule = true;
      return halte("cancelled");
    }
    if (this.tentatives >= BUDGET.gestes || this.ecoule > BUDGET.dureeMs) {
      this.rate(
        path,
        this.tentatives >= BUDGET.gestes ? "budget_exceeded: gestes" : "budget_exceeded: durée",
      );
      return halte("failed");
    }
    return null;
  }

  /** Un outil `pw_*` par son traitement (garde d'URL, mémoire AX, session sécurisée) ; jamais d'exception, annulation immédiate. */
  private async appeler(
    f: (a: Dict, c: ContexteAppel, b: Dict) => Promise<unknown>,
    args: Dict,
    nom: string,
  ): Promise<unknown> {
    const a: Dict = { ...defauts(nom), session_id: this.o.sessionId, observe: false, ...args };
    try {
      const r = await Promise.race([f(a, this.ctx, a), this.abandon]);
      return nettoyerResultat(r, secretsRecents(this.o.username));
    } catch (e) {
      if (e instanceof Annulation) {
        this.annule = true;
        return errPw("cancelled", "", { message: "appel annulé" });
      }
      return errPw("run_error", "", { message: messageErreur(e) });
    }
  }

  private majUrl(r: unknown): void {
    if (estDict(r)) {
      const u = r["url"] ?? r["current_url"];
      if (typeof u === "string" && u !== "") this.url = u;
    }
  }

  /** Condition évaluée une fois : booléen, ou message d'erreur du service. */
  private async instant(c: Condition): Promise<boolean | string> {
    if (c.url_path !== undefined) {
      const u = await this.adresse().catch(() => "");
      if (!this.urlConforme(u, c.url_path)) return false;
    }
    if (c.visible !== undefined) {
      const refus = refusCible(c.visible);
      if (refus !== null) return `invalid_target: ${refus}`;
      const v = await this.visible(c.visible);
      if (v !== true) return v;
    }
    if (c.text !== undefined) {
      const r = await this.client.req("POST", "/extract_text", { json: { session_id: this.o.sessionId } });
      if (!estDict(r) || r["ok"] === false || typeof r["error"] === "string") return "extract_text";
      if (!String(r["text"] ?? "").includes(c.text)) return false;
    }
    if (c.not !== undefined) {
      const n = await this.instant(c.not);
      if (typeof n === "string") return n;
      if (n) return false;
    }
    return true;
  }

  /** Adresse de l'origine de la procédure dont le chemin égale le motif (`*` = n'importe quelle suite). */
  private urlConforme(u: string, motif: string): boolean {
    try {
      const x = new URL(u);
      const re = (motif.startsWith("/") ? motif : `/${motif}`).split("*").map(echappeRegex).join(".*");
      return x.origin === this.p.origin && new RegExp(`^${re}$`, "u").test(x.pathname);
    } catch {
      return false;
    }
  }

  /** Cible visible maintenant ? Booléen, ou message d'erreur du service. */
  private async visible(cible: string): Promise<boolean | string> {
    const [code, corps] = await this.client.reqStatus("POST", "/wait_for_dynamic", {
      json: {
        session_id: this.o.sessionId,
        selector: dslToSelector(cible),
        condition: "visible",
        timeout: 150,
        poll_interval: 50,
        ...byNonNuls(cible),
      },
      timeout: 10,
    });
    if (code === 200) return true;
    if (code === 408) return false;
    return typeof corps["error"] === "string" ? corps["error"].slice(0, 120) : `wait_for_dynamic ${code}`;
  }

  /** Condition attendue jusqu'à l'échéance : vrai, faux ou message d'erreur. */
  private async attendre(c: Condition, ms: number): Promise<boolean | string> {
    const echeance = Date.now() + ms;
    for (;;) {
      if (this.ctx.signal.aborted || this.annule) return "cancelled";
      if (this.ecoule > BUDGET.dureeMs) return "budget";
      let r: boolean | string;
      try {
        r = await Promise.race([this.instant(c), this.abandon]);
      } catch {
        this.annule = true;
        return "cancelled";
      }
      if (r !== false) return r;
      if (Date.now() + BUDGET.pasMs > echeance) return false;
      await dormir(BUDGET.pasMs).catch(() => undefined);
    }
  }

  /** Un geste sur une cible après l'autre ; la suivante n'est essayée que si la précédente n'a rien fait. */
  private async geste(n: Act, path: string, cibles: string[], v: string): Promise<Issue> {
    const t = Date.now();
    const essais = cibles.length > 0 ? cibles : [""];
    const tried: string[] = [];
    const codes: string[] = [];
    for (const [i, cible] of essais.entries()) {
      const stop = this.arret(path);
      if (stop) return stop;
      this.tentatives += 1;
      // Seule l'attente de présence d'une cible de repli est courte : le geste garde son délai.
      const presence =
        i < essais.length - 1 ? Math.min(n.timeout_ms ?? BUDGET.reserveMs, BUDGET.reserveMs) : undefined;
      const r = await this.appeler(
        this.act,
        {
          action: GESTES[n.act] ?? n.act,
          target: cible,
          v,
          _expected_origin: this.p.origin,
          _sans_repli: true,
          ...(n.timeout_ms !== undefined ? { _timeout_ms: n.timeout_ms } : {}),
          ...(presence !== undefined ? { _presence_ms: presence } : {}),
        },
        "pw_act",
      );
      if (this.annule) return halte("cancelled");
      const e = echec(r);
      if (e === null) {
        this.majUrl(r);
        if (origineDe(this.url) !== this.p.origin) {
          this.noter(path, n.act, cible || null, false, t, "origin_changed");
          this.rate(
            path,
            `origin_changed: la page est maintenant sur « ${origineDe(this.url) || "aucune origine"} » (le geste a eu lieu) : arrêt`,
            [cible],
          );
          return halte("failed");
        }
        return this.apres(n, path, cible, t);
      }
      const raison = `${e.code}${e.message ? `: ${e.message}` : ""}`;
      tried.push(cible || "(sans cible)");
      codes.push(e.code);
      this.noter(path, n.act, cible || null, false, t, raison);
      if (e.code === "origin_mismatch") {
        this.rate(path, raison, tried, false, codes);
        return FAIL;
      }
      if (SANS_EFFET.has(e.code)) {
        this.rate(
          path,
          raison,
          tried,
          codes.every((c) => REPARABLES.has(c)),
          codes,
        );
        continue;
      }
      this.rate(path, `ambiguous: ${raison} (le geste a peut-être agi : arrêt sans rejeu)`, tried);
      return halte("failed");
    }
    return FAIL;
  }

  /** Postcondition `expect` d'un geste réussi. */
  private async apres(n: Act, path: string, cible: string, t: number): Promise<Issue> {
    if (n.expect !== undefined) {
      const r = await this.attendre(this.subCondition(n.expect), n.timeout_ms ?? BUDGET.attenteMs);
      if (r === "cancelled") return halte("cancelled");
      if (r === "budget") {
        this.rate(path, "budget_exceeded: durée", [cible]);
        return halte("failed");
      }
      if (r !== true) {
        const raison = r === false ? "expect_failed" : `expect_error: ${r}`;
        this.noter(path, n.act, cible || null, false, t, raison);
        // Le geste a agi : ni repli ni suite, aucun autre nœud ne doit croire que rien n'a eu lieu.
        if (!SANS_EFFET_DE_BORD.has(n.act)) {
          this.rate(
            path,
            `acted_unconfirmed: ${raison} (le geste a eu lieu, son effet n'est pas confirmé : arrêt)`,
            [cible],
          );
          return halte("failed");
        }
        this.rate(path, raison, [cible], r === false);
        return FAIL;
      }
    }
    this.noter(path, n.act, cible || null, true, t);
    this.joues.push({
      path,
      act: n.act,
      target_used: cible || null,
      expect_confirmed: n.expect !== undefined,
    });
    if (!SANS_EFFET_DE_BORD.has(n.act) && n.expect === undefined) this.effetSansExpect = true;
    return OK;
  }

  private async executerAct(n: Act, path: string): Promise<Issue> {
    const stop = this.arret(path);
    if (stop) return stop;
    const t = Date.now();
    const cibles = (n.t ?? []).map((x) => this.sub(x, "dsl"));
    const v = n.v === undefined ? "" : this.sub(n.v, "texte");
    for (const c of cibles) {
      const r = refusCible(c);
      if (r !== null) return this.refus(path, n, t, `invalid_target: ${r}`, true);
    }
    if (n.confirm === true) {
      if (!this.o.confirmed.includes(path)) {
        const cible =
          cibles.length > 1
            ? `l'une de [${cibles.join(" | ")}] (la première qui existe)`
            : (cibles[0] ?? n.url ?? "");
        const quoi = [n.act, cible, v && n.act !== "fill" ? v : v ? `← ${v}` : ""].filter(Boolean).join(" ");
        this.confirmation = { path, description: quoi.slice(0, 400) };
        return halte("needs_confirmation");
      }
      // Un accord vaut une exécution du nœud, jamais davantage dans le même appel.
      if (this.confirmesFaits.has(path)) return this.refus(path, n, t, "confirm_already_used");
      this.confirmesFaits.add(path);
    }
    if (n.act === "goto") return this.aller(n, path, t);
    if (origineDe(this.url) !== this.p.origin)
      return this.refus(
        path,
        n,
        t,
        `origin_mismatch: la page est sur « ${origineDe(this.url) || "aucune origine"} », la procédure vise ${this.p.origin}`,
      );
    if (n.act === "wait") return this.attendreCible(n, path, cibles, t);
    return this.geste(n, path, cibles, v);
  }

  private refus(path: string, n: Act, t: number, raison: string, reparable = false): Issue {
    this.noter(path, n.act, null, false, t, raison);
    this.rate(path, raison, [], reparable);
    return FAIL;
  }

  private async aller(n: Act, path: string, t: number): Promise<Issue> {
    let adresse: string;
    try {
      adresse = new URL(this.sub(n.url ?? "", "url"), this.p.origin).href;
    } catch {
      return this.refus(path, n, t, "invalid_url");
    }
    if (origineDe(adresse) !== this.p.origin) return this.refus(path, n, t, "url_hors_origine");
    this.tentatives += 1;
    const r = await this.appeler(this.act, { action: "goto", url: adresse }, "pw_act");
    if (this.annule) return halte("cancelled");
    const e = echec(r);
    if (e !== null) return this.refus(path, n, t, `${e.code}${e.message ? `: ${e.message}` : ""}`);
    this.majUrl(r);
    return this.apres(n, path, "", t);
  }

  private async attendreCible(n: Act, path: string, cibles: string[], t: number): Promise<Issue> {
    const echeance = Date.now() + (n.timeout_ms ?? BUDGET.attenteMs);
    this.tentatives += 1;
    for (;;) {
      if (this.ctx.signal.aborted) {
        this.annule = true;
        return halte("cancelled");
      }
      if (this.ecoule > BUDGET.dureeMs) {
        this.rate(path, "budget_exceeded: durée", cibles);
        return halte("failed");
      }
      for (const c of cibles) {
        let r: boolean | string;
        try {
          r = await Promise.race([this.visible(c), this.abandon]);
        } catch {
          this.annule = true;
          return halte("cancelled");
        }
        if (r === true) {
          this.noter(path, "wait", c, true, t);
          return OK;
        }
      }
      if (Date.now() + BUDGET.pasMs > echeance) break;
      await dormir(BUDGET.pasMs).catch(() => undefined);
    }
    this.noter(path, "wait", null, false, t, "wait_timeout");
    this.rate(path, "wait_timeout", cibles, true);
    return FAIL;
  }

  private async connecter(l: Login, path: string): Promise<Issue> {
    const stop = this.arret(path);
    if (stop) return stop;
    const t = Date.now();
    const nom = /^\{(.+)\}$/u.exec(l.creds)?.[1] ?? "";
    if (origineDe(this.url) !== this.p.origin) {
      this.noter(path, "login", null, false, t, "origin_mismatch");
      this.rate(path, `origin_mismatch: la procédure vise ${this.p.origin}`);
      return FAIL;
    }
    const cible = (k: string | undefined): string => (k === undefined ? "" : this.sub(k, "dsl"));
    for (const k of [l.password_target, l.username_target, l.submit_target, l.wait_for]) {
      const refus = k === undefined ? null : refusCible(cible(k));
      if (refus !== null) {
        this.noter(path, "login", null, false, t, `invalid_target: ${refus}`);
        this.rate(path, `invalid_target: ${refus}`);
        return FAIL;
      }
    }
    this.tentatives += 1;
    const r = await this.appeler(
      this.connexion,
      {
        creds: String(this.o.params[nom] ?? ""),
        password_target: cible(l.password_target),
        username_target: cible(l.username_target),
        submit_target: cible(l.submit_target),
        wait_for: cible(l.wait_for),
      },
      "pw_login",
    );
    if (this.annule) return halte("cancelled");
    const e = echec(r);
    this.majUrl(r);
    const issue = estDict(r) && typeof r["outcome"] === "string" ? r["outcome"] : "";
    if (e !== null) {
      const raison = `${e.code}${issue ? ` (${issue})` : ""}${e.message ? `: ${e.message}` : ""}`;
      this.noter(path, "login", null, false, t, raison);
      this.rate(path, raison);
      // Un jeton a peut-être été consommé : ni repli ni nouvel essai.
      return halte("failed");
    }
    // Une navigation vers une page d'échec compte pour une réussite de pw_login : la cible d'arrivée tranche.
    {
      const arrivee = await this.attendre({ visible: cible(l.wait_for) }, BUDGET.attenteMs);
      if (arrivee === "cancelled") return halte("cancelled");
      if (arrivee === "budget") {
        this.rate(path, "budget_exceeded: durée");
        return halte("failed");
      }
      if (arrivee !== true) {
        this.noter(path, "login", null, false, t, "login_not_confirmed");
        this.rate(path, "login_not_confirmed: la cible wait_for n'est pas apparue après la connexion");
        return halte("failed");
      }
    }
    this.noter(path, "login", null, true, t);
    return OK;
  }

  private async pause(ms: number, path: string): Promise<Issue> {
    const stop = this.arret(path);
    if (stop) return stop;
    const t = Date.now();
    const reste = Math.max(0, BUDGET.dureeMs - this.ecoule);
    try {
      await dormir(Math.min(ms, reste), undefined, { signal: this.ctx.signal });
    } catch {
      this.annule = true;
      return halte("cancelled");
    }
    this.noter(path, "wait_ms", null, true, t);
    return OK;
  }

  /** Nœud et sous-arbre ; `reprise` = segments restants du chemin du nœud à reprendre (ce qui précède sur ce chemin est tenu pour fait). */
  async noeud(n: Noeud, path: string, reprise: string[] | null): Promise<Issue> {
    const r = reprise !== null && reprise.length > 0 ? reprise : null;
    if ("seq" in n) {
      const debut = r !== null ? Number(r[0]) : 0;
      for (let i = debut; i < n.seq.length; i++) {
        const x = await this.noeud(
          n.seq[i] as Noeud,
          `${path}.${i}`,
          i === debut && r !== null ? r.slice(1) : null,
        );
        if (x.k !== "ok") return x;
      }
      return OK;
    }
    if ("sel" in n) {
      const debut = r !== null ? Number(r[0]) : 0;
      for (let i = debut; i < n.sel.length; i++) {
        const x = await this.noeud(
          n.sel[i] as Noeud,
          `${path}.${i}`,
          i === debut && r !== null ? r.slice(1) : null,
        );
        if (x.k !== "fail") return x;
      }
      return FAIL;
    }
    if ("if" in n) return this.si(n, path, r);
    if ("retry" in n) {
      for (let i = 0; i < n.max; i++) {
        const x = await this.noeud(n.retry, `${path}.retry`, i === 0 && r !== null ? r.slice(1) : null);
        if (x.k !== "fail") return x;
        if (i + 1 < n.max) await dormir(BUDGET.pasMs * 2).catch(() => undefined);
      }
      return FAIL;
    }
    if ("login" in n) return this.connecter(n.login, path);
    if ("wait_ms" in n) return this.pause(n.wait_ms, path);
    return this.executerAct(n, path);
  }

  private async si(n: Extract<Noeud, { if: Condition }>, path: string, r: string[] | null): Promise<Issue> {
    if (r !== null) {
      const branche = r[0] === "then" ? n.then : n.else;
      return branche === undefined ? OK : this.noeud(branche, `${path}.${r[0]}`, r.slice(1));
    }
    const stop = this.arret(path);
    if (stop) return stop;
    const t = Date.now();
    const vrai = await this.attendre(this.subCondition(n.if), 0);
    if (vrai === "cancelled") return halte("cancelled");
    if (vrai === "budget") {
      this.rate(path, "budget_exceeded: durée");
      return halte("failed");
    }
    if (typeof vrai === "string") {
      this.noter(path, "if", null, false, t, `condition_error: ${vrai}`);
      this.rate(path, `condition_error: ${vrai}`);
      return FAIL;
    }
    this.noter(path, "if", null, vrai, t);
    if (n.then === undefined && n.else === undefined) {
      if (!vrai) this.rate(path, "condition_false", [], true);
      return vrai ? OK : FAIL;
    }
    const branche = vrai ? n.then : n.else;
    return branche === undefined ? OK : this.noeud(branche, `${path}.${vrai ? "then" : "else"}`, null);
  }
}

/** Exécute la procédure déjà validée sur la session ; le résultat est toujours un objet JSON (statut ok, failed, needs_confirmation ou cancelled). */
export async function executer(
  s: ServicesBrowser,
  ctx: ContexteAppel,
  client: ClientNavigateur,
  p: Procedure,
  o: OptionsRun,
): Promise<ResultatRun> {
  const x = new Execution(s, ctx, client, p, o);
  let statut: StatutRun = "failed";
  try {
    await x.amorcer();
    const reprise = o.reprise !== null && o.reprise.startsWith("0.") ? o.reprise.split(".").slice(1) : null;
    const i = await x.noeud(p.root, "0", reprise);
    statut = i.k === "ok" ? "ok" : i.k === "halt" ? i.statut : "failed";
    if (statut === "failed" && x.echec === null) x.echec = { path: "0", reason: "failed", tried_targets: [] };
  } catch (e) {
    x.echec = { path: "0", reason: `run_error: ${messageErreur(e)}`, tried_targets: [] };
  } finally {
    x.fin();
  }
  const page = await x.page();
  return nettoyerResultat(
    {
      status: statut,
      steps: x.steps,
      ...(statut === "failed" && x.echec !== null ? { failed_at: x.echec } : {}),
      ...(statut === "needs_confirmation" && x.confirmation !== null
        ? { node_path: x.confirmation.path, description: x.confirmation.description }
        : {}),
      ...page,
      duration_ms: x.ecoule,
      attempts: x.tentatives,
    },
    secretsRecents(o.username),
  );
}
