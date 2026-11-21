// SPDX-License-Identifier: MIT
/** browser-service/src/routes/connexion.ts — /login_precheck et /login : connexion avec un secret du coffre que le modèle ne voit jamais (session isolée, saisie par le service, issue jugée, documents remplacés). */
import type { Application, Request, Response } from "express";
import type { Frame, Locator, Page, Route } from "playwright";
import type { ServiceContext, Session } from "../contexte.ts";
import { refusUrl } from "../destinations.ts";
import { brancherOnglet } from "../evenements.ts";
import { ACTION_TIMEOUT_MS, NOT_FOUND_GRACE_MS, cibleDepuisParams } from "../localisateur.ts";
import { intercepteurs } from "../requete.ts";
import { sansAnsi } from "../result_util.ts";
import type { ParamsCible } from "../result_util.ts";
import {
  chargeRequete,
  choisirVisible,
  controlerChamp,
  controlerPoignee,
  decrireChamp,
  detecterChamps,
  erreurSecret,
  formesSecret,
  origineDe,
  purgerTexte,
  remplirChamp,
  requetePorteSecret,
  verifierBoutonParDefaut,
  verifierFormulaire,
  viderChamp,
} from "../secret_util.ts";
import type { DescriptionChamp, ErreurSecret, Poignee } from "../secret_util.ts";
import { closeSession } from "../sessions.ts";

/** Champ de connexion. */
type Champ = "username" | "password";

/** Cible d'un champ de connexion, du bouton d'envoi ou de wait_for : une ref de pw_find ou by_*, et l'indice parmi ses correspondances. */
interface CibleLogin {
  ref?: string;
  by_role?: string;
  by_name?: string;
  by_text?: string;
  by_label?: string;
  by_placeholder?: string;
  by_test_id?: string;
  by_alt?: string;
  by_title?: string;
  by_css?: string;
  nth?: number;
}

/** Corps de /login_precheck et /login (origine et valeurs du secret : /login seulement). */
interface CorpsLogin {
  username_target?: CibleLogin;
  password_target?: CibleLogin;
  submit_target?: CibleLogin;
  wait_for?: CibleLogin;
  timeout?: number;
  secret_origin?: string;
  username_value?: string;
  password_value?: string;
}

/** Candidats d'une cible de connexion. */
interface CandidatsLogin {
  candidats: Locator;
  nth: number | null | undefined;
  params: ParamsCible;
}

/** Connexion contrôlée sans valeurs : champs et leurs origines, bouton d'envoi, cible de wait_for, poignées à libérer. */
interface PrepLogin {
  handles: Poignee[];
  champs: Partial<Record<Champ, Poignee>>;
  origines: Partial<Record<Champ, string>>;
  detectes: Champ[];
  submit: Poignee | null;
  origine: string | null;
  timeout: number;
  cw: CandidatsLogin | null;
}

/** Erreur attrapée d'une connexion (codée par erreurSecret, ou levée par Playwright). */
type ErreurAttrapee = Partial<ErreurSecret> | null | undefined;

/** Statut HTTP et corps d'une réponse de connexion. */
interface SortieLogin {
  statut: number;
  corps: Record<string, unknown>;
}

/** Documents qui ont reçu le secret : remplacés, fermés, ou session fermée. */
interface BilanRemplacement {
  remplacees: number;
  fermees: number;
  sessionFermee: boolean;
}

/** État réseau d'une connexion, partagé par la garde réseau et la surveillance de l'issue. */
interface EtatGarde {
  navigue: boolean;
  enVol: number;
  repondu: number;
  bloquees: number;
  coupees: number;
  saisie: boolean;
}

/** Issue d'un envoi. */
type IssueLogin =
  | "no_change"
  | "navigated"
  | "wait_for"
  | "field_gone"
  | "form_invalid"
  | "login_form_shown_again"
  | "wait_for_missing";

/** Ce que issueConnexion surveille après l'envoi. */
interface SuiviIssue {
  fin: number;
  nouvelles: Page[];
  etat: EtatGarde;
  avecSecret: boolean;
  origineSecret: string | null;
}

// ======================== CONNEXION AVEC UN SECRET DU COFFRE ========================
// Le modèle ne saisit jamais un secret par un geste : /login_precheck contrôle les champs sans valeur ; /login, en une requête exclusive (toute
// autre route de la session répond 409 secret_login_busy), isole la session, recharge la page depuis le réseau, saisit, soumet, juge l'issue et
// remplace les documents qui ont reçu le secret. Avant et après, la session est ordinaire.
const BUDGET_LOGIN_MS = parseInt(process.env.PW_LOGIN_BUDGET_MS || "40000", 10);
// Attente d'une réaction de la page après la soumission (navigation, champ retiré), sauf requête porteuse encore en vol.
const REACTION_LOGIN_MS = parseInt(process.env.PW_LOGIN_REACTION_MS || "15000", 10);
const POST_BUDGET_MS = parseInt(process.env.PW_LOGIN_POST_BUDGET_MS || "15000", 10);
// Plafond absolu d'une connexion depuis l'arrivée de la requête, post-traitement compris.
const PLAFOND_LOGIN_MS = parseInt(process.env.PW_LOGIN_CEILING_MS || "62000", 10);
const FERMETURE_MS = 4000;
const CLES_CIBLE_LOGIN = [
  "ref",
  "by_role",
  "by_name",
  "by_text",
  "by_label",
  "by_placeholder",
  "by_test_id",
  "by_alt",
  "by_title",
  "by_css",
] as const;
const MDP_VISIBLE = "input[type=password i]:not([autocomplete~=new-password i])";
const avecDelai = <T>(promesse: Promise<T>, ms: number) =>
  Promise.race([
    promesse,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(Object.assign(new Error("délai"), { name: "TimeoutError" })), ms),
    ),
  ]);

// Candidats d'une cible de connexion (ref ou by_*) ; null sans cible, secret_target_required si elle ne désigne rien.
async function candidatsLogin(
  ctx: ServiceContext,
  req: Request<CorpsLogin>,
  t: CibleLogin | undefined,
  quoi: string,
): Promise<CandidatsLogin | null> {
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const params: ParamsCible = {};
  for (const k of CLES_CIBLE_LOGIN) if (t[k] !== undefined && t[k] !== null && t[k] !== "") params[k] = t[k];
  if (!Object.keys(params).length) return null;
  const c = await cibleDepuisParams(ctx, req.session!.page, params, req.sessionId!, NOT_FOUND_GRACE_MS);
  if (!c) throw erreurSecret("secret_target_required", `${quoi} matches nothing on this page.`, 400);
  const nth =
    Number.isInteger(t.nth) && t.nth! >= 0 && !String(params.ref || "").includes("#") ? t.nth : null;
  return { candidats: c.liste || c.loc, nth, params };
}

async function libererLogin(p: PrepLogin | null) {
  if (p) for (const h of p.handles) await h.dispose().catch(() => {});
}

// Champs (cibles ou détectés), formulaires, bouton et origine contrôlés sans valeur ; `valeurs` (login) limite la détection aux champs à remplir.
async function preparerLogin(
  ctx: ServiceContext,
  req: Request<CorpsLogin>,
  { fin = Infinity, valeurs = null }: { fin?: number; valeurs?: Record<Champ, string> | null } = {},
): Promise<PrepLogin> {
  const b = req.body;
  const timeout = Math.max(
    500,
    Math.min(Number(b.timeout) || ACTION_TIMEOUT_MS, ACTION_TIMEOUT_MS * 2, fin - Date.now()),
  );
  const p: PrepLogin = {
    handles: [],
    champs: {},
    origines: {},
    detectes: [],
    submit: null,
    origine: null,
    timeout,
    cw: null,
  };
  try {
    const auto: Champ[] = [];
    for (const champ of ["username", "password"] as const) {
      const c = await candidatsLogin(ctx, req, b[`${champ}_target` as const], `${champ}_target`);
      if (c && valeurs && !valeurs[champ])
        throw erreurSecret(
          "secret_target_required",
          `${champ}_target is given but no ${champ} value comes with it.`,
          400,
        );
      if (c) {
        const r = await controlerChamp(c.candidats, { champ, timeout, nth: c.nth });
        p.handles.push(r.h);
        p.champs[champ] = r.h;
        p.origines[champ] = r.origine;
      } else if (!valeurs || valeurs[champ]) auto.push(champ);
    }
    if (auto.length) {
      const d = await detecterChamps(req.session!.page, { champs: auto, timeout });
      for (const champ of auto) if (d[champ]) p.handles.push(d[champ]);
      for (const champ of auto) {
        if (!d[champ]) continue;
        p.origines[champ] = await controlerPoignee(d[champ], champ);
        p.champs[champ] = d[champ];
        p.detectes.push(champ);
      }
    }
    if (!Object.keys(p.champs).length)
      throw erreurSecret("secret_target_required", "No login field found on this page.", 400, {
        fix: "Pass username_target and/or password_target (label, placeholder, role and name, or a ref from pw_find).",
      });
    const origines = new Set(Object.values(p.origines));
    if (origines.size > 1)
      throw erreurSecret(
        "secret_scope_mismatch",
        `The login fields are in frames of different origins (${[...origines].join(", ")}): refused.`,
        403,
      );
    p.origine = [...origines][0]!;
    for (const h of Object.values(p.champs)) await verifierFormulaire(h, p.origine);
    const cs = await candidatsLogin(ctx, req, b.submit_target, "submit_target");
    if (cs) {
      p.submit = await choisirVisible(cs.candidats, { timeout, nth: cs.nth, quoi: "submit_target" });
      p.handles.push(p.submit);
      const fr = await p.submit.ownerFrame();
      if (!fr || origineDe(fr.url()) !== p.origine)
        throw erreurSecret(
          "secret_scope_mismatch",
          "submit_target is not on the login fields' origin: refused.",
          403,
        );
      await verifierFormulaire(p.submit, p.origine);
    } else await verifierBoutonParDefaut(p.champs.password || p.champs.username!, p.origine);
    p.cw = await candidatsLogin(ctx, req, b.wait_for, "wait_for");
    return p;
  } catch (e) {
    await libererLogin(p);
    throw e;
  }
}

// Réponse d'une erreur de connexion : erreur codée telle quelle, sinon échec générique (jamais un message Playwright, qui peut citer une saisie).
function erreurLogin(e: ErreurAttrapee): SortieLogin {
  if (e && e.code && e.statut)
    return { statut: e.statut, corps: { error: e.message, code: e.code, ...(e.details || {}) } };
  if (e && e.name === "TimeoutError")
    return { statut: 408, corps: { error: "Timed out during login.", code: "secret_login_failed" } };
  return {
    statut: 500,
    corps: { error: "Login failed: the page could not be driven.", code: "secret_login_failed" },
  };
}

// Identifiant (frame + chargement) du document principal : il change à chaque vraie navigation.
async function idPrincipal(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    return `${frameTree.frame.id}:${frameTree.frame.loaderId}`;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// Chaque onglet qui a reçu le secret est remplacé par un onglet neuf, chargé en GET sur son adresse si elle ne porte aucun secret, historique vidé (aucun retour ne rejoue le POST) ; sinon fermé, puis la session.
async function remplacerDocuments(
  s: Session,
  saisies: ReadonlySet<Page>,
  finPost: number,
  formes: string[],
): Promise<BilanRemplacement> {
  const bilan: BilanRemplacement = { remplacees: 0, fermees: 0, sessionFermee: false };
  const borne = () => Math.max(300, Math.min(4000, finPost - Date.now()));
  for (const vieux of saisies) {
    if (vieux.isClosed()) continue;
    let cible: string | null = null;
    try {
      const u = vieux.url();
      if (/^https?:/i.test(u) && purgerTexte(u, formes) === u) cible = u;
    } catch {
      cible = null;
    }
    const neuf = await avecDelai(s.context.newPage(), borne()).catch(() => null);
    if (neuf) {
      brancherOnglet(s, neuf);
      const i = s.tabs.indexOf(vieux);
      if (i >= 0) s.tabs[i] = neuf;
      else s.tabs.push(neuf);
      if (s.page === vieux) s.page = neuf;
    }
    vieux.__elpisFermeParService = true;
    try {
      await avecDelai(vieux.close(), borne());
    } catch {
      bilan.sessionFermee = true;
      return bilan;
    }
    if (!neuf) {
      bilan.fermees++;
      continue;
    }
    bilan.remplacees++;
    if (cible) await avecDelai(neuf.goto(cible, { waitUntil: "commit" }), borne()).catch(() => {});
    await avecDelai(
      s.context
        .newCDPSession(neuf)
        .then((cdp) => cdp.send("Page.resetNavigationHistory").finally(() => cdp.detach().catch(() => {}))),
      borne(),
    ).catch(() => {});
  }
  if (!s.tabs.some((t) => !t.isClosed())) {
    try {
      const np = await avecDelai(s.context.newPage(), 3000);
      brancherOnglet(s, np);
      s.tabs.push(np);
      s.page = np;
    } catch {
      bilan.sessionFermee = true;
    }
  }
  return bilan;
}

// Un champ mot de passe visible sur l'origine du secret (formulaire de connexion réaffiché).
async function motDePasseVisible(page: Page, origineSecret: string | null) {
  for (const f of page.frames()) {
    if (f.isDetached() || origineDe(f.url()) !== origineSecret) continue;
    if ((await avecDelai(f.locator(MDP_VISIBLE).filter({ visible: true }).count(), 1000).catch(() => 0)) > 0)
      return true;
  }
  return false;
}

// Message d'erreur affiché par la page (alerte, région live), purgé et borné, pour expliquer un échec avant le remplacement des documents.
async function messagePage(page: Page, formes: string[]) {
  const textes = await avecDelai(
    page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "[role=alert], [aria-live=assertive], [aria-live=polite], .error, .alert",
        ),
      )
        .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 3),
    ),
    1500,
  ).catch(() => []);
  return purgerTexte(textes.join(" | "), formes).substring(0, 300);
}

// Issue après la soumission : navigation, onglet, cible wait_for, champ retiré, formulaire invalide ou rien (réponse porteuse sans suite 3 s, fenêtre écoulée) ; puis mot de passe réaffiché 1 s ou cible absente.
async function issueConnexion(page: Page, p: PrepLogin, suivi: SuiviIssue): Promise<IssueLogin> {
  const { fin, nouvelles, etat, avecSecret, origineSecret } = suivi;
  const observe = p.champs.password || p.champs.username!;
  const debut = Date.now();
  const finReaction = Math.min(fin, debut + REACTION_LOGIN_MS);
  const lim = () => Math.max(300, Math.min(2000, fin - Date.now()));
  let issue: IssueLogin = "no_change";
  while (Date.now() < fin) {
    if (etat.navigue || nouvelles.length) {
      issue = "navigated";
      break;
    }
    if (
      p.cw &&
      (await avecDelai(p.cw.candidats.filter({ visible: true }).count(), lim()).catch(() => 0)) > 0
    ) {
      issue = "wait_for";
      break;
    }
    const vu = await avecDelai(
      observe.evaluate((el) => ({
        parti: !el.isConnected || el.getClientRects().length === 0,
        invalide: Boolean(
          (el as HTMLInputElement).form && (el as HTMLInputElement).form!.querySelector(":invalid"),
        ),
      })),
      lim(),
    ).catch((e: Error | null) => ({ parti: !(e && e.name === "TimeoutError"), invalide: false }));
    if (vu.parti) {
      issue = "field_gone";
      break;
    }
    if (vu.invalide && !etat.enVol && !etat.repondu && Date.now() - debut > 1000) {
      issue = "form_invalid";
      break;
    }
    if (!etat.enVol && ((etat.repondu && Date.now() - etat.repondu > 3000) || Date.now() >= finReaction))
      break;
    await page.waitForTimeout(150).catch(() => {});
  }
  for (const t = Math.min(fin, Date.now() + 1000); issue === "field_gone" && !etat.navigue && Date.now() < t;)
    await page.waitForTimeout(100).catch(() => {});
  if (issue === "field_gone" && etat.navigue) issue = "navigated";
  if (issue === "navigated" || issue === "field_gone")
    await page
      .waitForLoadState("domcontentloaded", { timeout: Math.max(300, Math.min(3000, fin - Date.now())) })
      .catch(() => {});
  if (issue === "no_change" || issue === "form_invalid" || issue === "wait_for" || nouvelles.length)
    return issue;
  const limite = p.cw ? fin : Math.min(fin, Date.now() + 1500);
  let depuis = 0;
  while (Date.now() < limite) {
    if (p.cw && (await avecDelai(p.cw.candidats.filter({ visible: true }).count(), lim()).catch(() => 0)) > 0)
      return "wait_for";
    if (avecSecret && (await motDePasseVisible(page, origineSecret))) {
      depuis ||= Date.now();
      if (Date.now() - depuis >= 1000) return "login_form_shown_again";
    } else depuis = 0;
    await page.waitForTimeout(150).catch(() => {});
  }
  return p.cw ? "wait_for_missing" : issue;
}

// Garde réseau de /login : aucun script de service worker enregistré ; pendant la saisie, toute requête vers une autre origine est coupée ; ensuite, une requête qui porte le mot de passe (adresse, corps, en-têtes) ne part qu'en POST vers son origine, sans suivre un 307/308 ailleurs.
function gardeReseau(formes: string[], origineSecret: string | null, etat: EtatGarde) {
  return async (route: Route) => {
    const rq = route.request();
    if (rq.headers()["service-worker"] === "script") return route.abort("blockedbyclient").catch(() => {});
    const avecSecret = requetePorteSecret(rq.url(), chargeRequete(rq), formes);
    if (etat.saisie && origineDe(rq.url()) !== origineSecret) {
      if (avecSecret) etat.bloquees++;
      else etat.coupees++;
      return route.abort("blockedbyclient").catch(() => {});
    }
    if (!avecSecret) return route.fallback().catch(() => {});
    const bloquer = (raison: string) => {
      etat.bloquees++;
      return route.abort(raison).catch(() => {});
    };
    if (
      rq.method() !== "POST" ||
      origineDe(rq.url()) !== origineSecret ||
      (await refusUrl(rq.url()).catch(() => "refus"))
    )
      return bloquer("blockedbyclient");
    etat.enVol++;
    // La requête suit le chemin du navigateur jusqu'au relais de l'hôte, qui seul remplace le substitut par la valeur.
    rq.response()
      .catch(() => null)
      .finally(() => {
        etat.enVol--;
        etat.repondu = Date.now();
      });
    return route.fallback().catch(() => {});
  };
}

// Corps d'une issue de connexion : succès (200), requête porteuse bloquée (403 secret_scope_mismatch), sinon échec (422 secret_login_failed).
function sortieConnexion(
  issue: IssueLogin,
  {
    bloquee,
    docChange,
    p,
    nouvelles,
  }: { bloquee: boolean; docChange: boolean; p: PrepLogin; nouvelles: Page[] },
): SortieLogin {
  const commun = {
    outcome: issue,
    navigated: docChange,
    fields: Object.keys(p.champs),
    detected: p.detectes,
    ...(nouvelles.length ? { opened_tab: true } : {}),
  };
  if (bloquee)
    return {
      statut: 403,
      corps: {
        ok: false,
        ...commun,
        outcome: "blocked",
        code: "secret_scope_mismatch",
        error:
          "A request carrying the secret was blocked (not a POST, another origin, or a redirect to another origin): this page does not allow a safe login.",
        fix: "Ask the user to check the login page; do not retry on this page.",
      },
    };
  if (["navigated", "field_gone", "wait_for"].includes(issue))
    return { statut: 200, corps: { ok: true, status: "submitted", ...commun } };
  const raisons: Partial<Record<IssueLogin, string>> = {
    no_change:
      "nothing changed after submission (credentials refused, extra field, captcha or two-factor step)",
    login_form_shown_again: "the login form came back after submission (credentials refused?)",
    wait_for_missing: "the page changed but the wait_for target never appeared",
    form_invalid:
      "the browser refused to submit the form (a field is invalid, e.g. a username that is not an e-mail address)",
  };
  return {
    statut: 422,
    corps: {
      ok: false,
      ...commun,
      code: "secret_login_failed",
      error: `The login did not succeed: ${raisons[issue] || issue}. The fields were cleared.`,
      fix: "Look at the page (pw_page inspect). If a login field was not detected, pass username_target/password_target.",
    },
  };
}

// Isolement avant toute saisie (le champ ne reçoit que le substitut, inutile hors de la fenêtre et de l'origine du secret) : journaux sans corps ni requête porteuse, mocks suspendus, garde réseau, service workers de l'origine retirés, page rechargée depuis le réseau (aucun script d'avant n'y reste) ; chaque étape faite ajoute son retour à `defaire`.
async function isolerConnexion(
  s: Session,
  page: Page,
  {
    garde,
    formes,
    origine,
    fin,
    defaire,
  }: {
    garde: (route: Route) => Promise<void>;
    formes: string[];
    origine: string;
    fin: number;
    defaire: (() => unknown)[];
  },
) {
  s.networkLog.formes = formes;
  if (s.dialogState) s.dialogState.formes = formes;
  s._mocksSuspendus = true;
  defaire.push(() => {
    s.networkLog.formes = null;
    if (s.dialogState) s.dialogState.formes = null;
    s._mocksSuspendus = false;
  });
  await s.context.route("**/*", garde);
  defaire.push(() => s.context.unroute("**/*", garde));
  const cdp = await s.context.newCDPSession(page);
  try {
    await cdp.send("Storage.clearDataForOrigin", { origin: origine, storageTypes: "service_workers" });
    const avant = await idPrincipal(page);
    await page.reload({ waitUntil: "domcontentloaded", timeout: Math.max(500, fin - Date.now()) });
    if ((await idPrincipal(page)) === avant)
      throw erreurSecret(
        "secret_login_failed",
        "The login page could not be loaded again from the network: nothing was typed.",
        422,
      );
  } finally {
    await cdp.detach().catch(() => {});
  }
  await Promise.race([
    page.waitForLoadState("networkidle").catch(() => {}),
    page.waitForTimeout(Math.max(0, Math.min(3000, fin - Date.now() - 20000))),
  ]);
}

export function registerLoginRoutes(app: Application, ctx: ServiceContext) {
  const { getSession } = intercepteurs(ctx);
  app.post("/login_precheck", getSession, async (req: Request<CorpsLogin>, res: Response) => {
    let p: PrepLogin | null = null;
    try {
      p = await preparerLogin(ctx, req);
      const targets: Record<string, DescriptionChamp> = {};
      for (const [champ, h] of Object.entries(p.champs)) targets[champ] = await decrireChamp(h);
      res.json({
        ok: true,
        frame_origin: p.origine,
        fields: Object.keys(p.champs),
        detected: p.detectes,
        submit: Boolean(p.submit),
        targets,
      });
    } catch (e) {
      const r = erreurLogin(e as ErreurAttrapee);
      res.status(r.statut).json(r.corps);
    } finally {
      await libererLogin(p);
    }
  });

  app.post(
    "/login",
    getSession,
    async (req: Request<CorpsLogin>, res: Response): Promise<Response | void> => {
      const s = req.session!;
      const b = req.body;
      const origineSecret = origineDe(b.secret_origin);
      const uv = typeof b.username_value === "string" ? b.username_value : "";
      const pv = typeof b.password_value === "string" ? b.password_value : "";
      const formes = formesSecret(pv);
      if (s._enregistre)
        return res.status(400).json({
          error:
            "This session records a HAR or a trace: open a session without recording to log in with a vault secret.",
          code: "recording_with_credentials",
        });
      const fin = req.recuA! + BUDGET_LOGIN_MS - 500;
      // Drapeau de session, indépendant du verrou et de la connexion HTTP (un client parti rend le verrou) : levé à la toute fin du post-traitement.
      s._connexionEnCours = true;
      s._aConnecte = true;
      const etat = { navigue: false, enVol: 0, repondu: 0, bloquees: 0, coupees: 0, saisie: false };
      const garde = gardeReseau(formes, origineSecret, etat);
      const phaseSaisie = (oui: boolean) => {
        etat.saisie = oui;
      };
      const saisies = new Set<Page>();
      const nouvelles: Page[] = [];
      const surPage = (pg: Page) => {
        nouvelles.push(pg);
      };
      const defaire: (() => unknown)[] = [];
      let p: PrepLogin | null = null,
        avecSecret = false,
        tape = false,
        sortie: SortieLogin,
        message = "";
      let post: BilanRemplacement = { remplacees: 0, fermees: 0, sessionFermee: false };
      s.context.on("page", surPage);
      try {
        try {
          if (!origineSecret)
            throw erreurSecret(
              "secret_scope_mismatch",
              "secret_origin must be an http(s) origin (scheme://host[:port]).",
              400,
            );
          if (!uv && !pv)
            throw erreurSecret(
              "secret_target_required",
              "Nothing to type: username_value and password_value are both empty.",
              400,
            );
          if (pv && !formes.length)
            throw erreurSecret(
              "secret_login_failed",
              "A password shorter than 3 characters cannot be guarded or purged: login refused.",
              400,
            );
          if (pv) await isolerConnexion(s, s.page, { garde, formes, origine: origineSecret, fin, defaire });
          const prep = preparerLogin(ctx, req, { fin, valeurs: { username: uv, password: pv } });
          try {
            p = await avecDelai(prep, Math.max(500, fin - Date.now()));
          } catch (e) {
            prep.then(libererLogin, () => {});
            throw e;
          }
          if (p.origine !== origineSecret)
            throw erreurSecret(
              "secret_scope_mismatch",
              `The login fields are on ${p.origine}, not on the secret's origin (${origineSecret}): nothing was typed.`,
              403,
            );
          avecSecret = Boolean(p.champs.password);
          if (avecSecret)
            for (const h of Object.values(p.champs))
              saisies.add((await avecDelai(h.ownerFrame(), 3000))!.page());
          const page = s.page;
          const surNav = (f: Frame) => {
            if (f === page.mainFrame()) etat.navigue = true;
          };
          page.on("framenavigated", surNav);
          try {
            for (const champ of ["username", "password"] as const) {
              const h = p.champs[champ];
              if (!h) continue;
              if ((await controlerPoignee(h, champ)) !== origineSecret)
                throw erreurSecret(
                  "secret_scope_mismatch",
                  "The field's frame left the secret's origin: nothing more was typed.",
                  403,
                );
              await verifierFormulaire(h, origineSecret);
              tape = true;
              if (avecSecret) phaseSaisie(true);
              await remplirChamp(h, champ === "password" ? pv : uv, {
                champ,
                timeout: p.timeout,
                delaiAvant: fin,
              });
            }
            const observe = p.champs.password || p.champs.username!;
            const avantId = await avecDelai(idPrincipal(page), 2000).catch(() => "");
            const t = Math.max(500, Math.min(p.timeout, fin - Date.now()));
            if (etat.saisie) await page.waitForTimeout(150).catch(() => {});
            phaseSaisie(false);
            if (p.submit) await p.submit.click({ timeout: t, noWaitAfter: true });
            else await observe.press("Enter", { timeout: t, noWaitAfter: true });
            const issue = await issueConnexion(page, p, { fin, nouvelles, etat, avecSecret, origineSecret });
            const apresId = await avecDelai(idPrincipal(page), 2000).catch(() => avantId);
            const bloquee = issue !== "wait_for" && (etat.bloquees > 0 || /^chrome-error:/.test(page.url()));
            sortie = sortieConnexion(issue, {
              bloquee,
              docChange: avantId !== "" && apresId !== avantId,
              p,
              nouvelles,
            });
          } finally {
            phaseSaisie(false);
            page.off("framenavigated", surNav);
          }
        } catch (e) {
          sortie = erreurLogin(e as ErreurAttrapee);
          console.warn(
            `[login] ${req.sessionId!.substring(0, 8)}… ${purgerTexte(
              sansAnsi(String(e && (e as Error).message)),
              formes,
            )
              .split("\n")[0]!
              .substring(0, 200)}`,
          );
        }
        s.context.off("page", surPage);
        if (p && tape && sortie.statut !== 200) {
          message = await messagePage(s.page, formes);
          for (const h of Object.values(p.champs)) await viderChamp(h);
        }
        await libererLogin(p).catch(() => {});
        if (avecSecret && saisies.size) {
          try {
            post = await remplacerDocuments(
              s,
              saisies,
              Math.max(
                Date.now() + 4000,
                Math.min(Date.now() + POST_BUDGET_MS, req.recuA! + PLAFOND_LOGIN_MS),
              ),
              formes,
            );
          } catch {
            post = { remplacees: 0, fermees: 0, sessionFermee: true };
          }
          if (post.sessionFermee)
            await avecDelai(
              closeSession(ctx, req.sessionId!, "login_echec_ferme", { lockHeld: true }),
              FERMETURE_MS,
            ).catch(() => {});
        }
      } finally {
        for (const retour of defaire.reverse())
          await Promise.resolve()
            .then(retour)
            .catch(() => {});
        s._connexionEnCours = false;
      }
      let url = "",
        titre = "";
      if (!post.sessionFermee) {
        try {
          url = s.page.url();
          titre = await avecDelai(s.page.title(), 1500).catch(() => "");
        } catch {
          url = "";
        }
      }
      const corps = {
        ...sortie.corps,
        ...(message ? { page_message: message } : {}),
        ...(post.sessionFermee
          ? {
              ok: false,
              outcome: "session_closed",
              session_closed: true,
              code: "secret_login_failed",
              error:
                "The documents that received the secret could not be replaced: the session was closed for safety.",
              fix: "Start a new session.",
            }
          : {}),
        url: purgerTexte(url, formes).substring(0, 300),
        title: purgerTexte(titre, formes).substring(0, 200),
        documents_replaced: post.remplacees,
        ...(post.fermees
          ? {
              page_closed: true,
              warning:
                "A document that received the secret could not be replaced: its page was closed for safety.",
            }
          : {}),
      };
      res.status(post.sessionFermee ? 422 : sortie.statut).json(corps);
    },
  );
}
