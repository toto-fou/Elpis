// SPDX-License-Identifier: MIT
/** apps/core/src/familles/oauth.ts — autorisation OAuth 2.1 des clients MCP (mcp/routes_oauth.py) : découverte, enregistrement, consentement, jetons, révocation, « Connexions ». */
import { createHash } from "node:crypto";

import {
  authenticateClient,
  checkResource,
  ErreurOAuth,
  exchangeCode,
  exigerUtilisateur,
  famillesDePortee,
  issueCode,
  ligneUtilisateur,
  listGrants,
  politiqueOauth,
  redirectionCorrespond,
  refresh,
  registerClient,
  resolveClient,
  resourceBase,
  RESOURCE_PATH,
  revokeGrant,
  revokeToken,
  SCOPE_PREFIX,
  scopesSupported,
} from "@elpis/auth";
import type { ClientOAuth, DependancesAuth, DependancesOAuth, PolitiqueOAuth } from "@elpis/auth";
import {
  decoderUtf8Py,
  ErreurJsonPy,
  ErreurLecturePy,
  HttpError,
  intPy,
  longueurPy,
  lowerPy,
  pyJsonLoads,
  pyJsonLoadsOctets,
  quotePy,
  rstripPy,
  stripPy,
  strPy,
  texteJsonPy,
  urlsplit,
  veritePy,
} from "@elpis/commun";
import { httpsEnabled, httpsPorts } from "@elpis/config";
import { isFamilyName } from "@elpis/mcp";
import { signClaims, urlsafeB64Decode, verifyClaims } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import { urlDeBase } from "../comptes/aides";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
import {
  analyserRequete,
  corpsLu,
  decouperCible,
  desechapper,
  entete,
  installerCorpsBorne,
  reponseJsonPy,
} from "@elpis/http";

export interface DependancesFamilleOAuth {
  readonly auth: DependancesAuth;
  readonly oauth: DependancesOAuth;
  /** `_session_user_id` : compte connecté (session, SSO et 2FA compris), sinon null. */
  readonly compteConnecte?: (requete: FastifyRequest) => Promise<number | null>;
}

const CONSENT_AUD = "elpis-oauth-consent";
const CONSENT_TTL_S = 900;
const CORPS_MAX = 64 * 1024;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
};
const SANS_STOCKAGE = { "Cache-Control": "no-store", Pragma: "no-cache" };
const LIBELLES_FAMILLES: Readonly<Record<string, string>> = {
  fs: "Fichiers de votre sandbox (lecture et écriture)",
  shell: "Terminal de votre sandbox (commandes)",
  git: "Git dans votre sandbox",
  desktop: "Contrôle d'écran des machines autorisées",
  browser: "Navigateur piloté",
  skill_run: "Scripts de vos skills",
};
const PAS_COCHEES = new Set(["desktop", "browser"]);
const SURS_REDIRECTION = ":/%#?=@[]!$&'()*+,;";

const CSS_PAGE = `
:root{--bg:#f8fafc;--card:#fff;--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--accent-fg:#fff;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#111827;--fg:#e2e8f0;--muted:#94a3b8;--line:#1f2937;--accent:#3b82f6;--accent-fg:#fff;--warn:#fbbf24}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;max-width:460px;width:100%;padding:24px}
h1{font-size:16px;margin:0 0 4px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:12px}
.warn{color:var(--warn);font-size:12px}code{font-size:12px;word-break:break-all}
fieldset{border:1px solid var(--line);border-radius:10px;margin:12px 0;padding:8px 12px}
legend{font-size:12px;color:var(--muted);padding:0 4px}label{display:flex;gap:8px;align-items:flex-start;padding:4px 0}
.row{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
button{font:inherit;border-radius:8px;padding:8px 14px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
`;
/** Referrer-Policy same-origin : en http sur le LAN, no-referrer ferait envoyer « Origin: null » au formulaire, refusé par le garde CSRF. */
const ENTETES_PAGE = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  ...SANS_STOCKAGE,
};

/** `_app_url` de routes_cli.py : origine contactée, ou le frontal https s'il est actif ; un Host refusé lève 400. */
export function urlAppStricte(requete: FastifyRequest): string {
  const base = urlDeBase(requete);
  if (!httpsEnabled()) return base;
  const port = httpsPorts().main || 443;
  const hote = (base.split("://")[1] ?? "").split(":")[0] ?? "";
  return port === 443 ? `https://${hote}` : `https://${hote}:${port}`;
}

/** `app_url` : origine publique ; un Host refusé retombe sur la base brute de la requête. */
export function urlApp(requete: FastifyRequest): string {
  try {
    return urlAppStricte(requete);
  } catch {
    const hote =
      entete(requete, "host") ?? `${requete.socket.localAddress ?? ""}:${requete.socket.localPort ?? ""}`;
    return rstripPy(`${requete.protocol}://${hote}/`, "/");
  }
}

export function resourceMetadataUrl(requete: FastifyRequest, famille = ""): string {
  const suffixe = RESOURCE_PATH + (famille ? `/${famille}` : "");
  return `${urlApp(requete)}/.well-known/oauth-protected-resource${suffixe}`;
}

/** `WWW-Authenticate` du relais (RFC 9728) : Bearer nu sans OAuth actif ; un segment inventé n'est jamais recopié. */
export function wwwAuthenticate(
  requete: FastifyRequest,
  config: () => unknown,
  famille = "",
  erreur = "",
): string {
  try {
    if (!politiqueOauth(config()).enabled) return "Bearer";
  } catch {
    return "Bearer";
  }
  const f = isFamilyName(famille) ? famille : "";
  const parties: string[] = [];
  if (erreur) parties.push(`error="${erreur}"`);
  parties.push(`resource_metadata="${resourceMetadataUrl(requete, f)}"`);
  if (f) parties.push(`scope="${SCOPE_PREFIX}${f}"`);
  return `Bearer ${parties.join(", ")}`;
}

function json(
  rep: FastifyReply,
  corps: unknown,
  statut = 200,
  extra: Readonly<Record<string, string>> = {},
): FastifyReply {
  return reponseJsonPy(rep.code(statut), corps, { ...CORS, ...SANS_STOCKAGE, ...extra });
}

function erreurOAuth(rep: FastifyReply, e: ErreurOAuth): FastifyReply {
  return json(rep, e.body(), e.status, e.status === 401 ? { "WWW-Authenticate": "Basic" } : {});
}

function echapperHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

function page(rep: FastifyReply, titre: string, corps: string, statut = 200): FastifyReply {
  const doc =
    '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${echapperHtml(titre)}</title><style>${CSS_PAGE}</style></head>` +
    `<body><main class="card">${corps}</main></body></html>`;
  if (!doc.isWellFormed()) throw new Error("'utf-8' codec can't encode character: surrogates not allowed");
  return rep.code(statut).headers(ENTETES_PAGE).type("text/html; charset=utf-8").send(doc);
}

function pageErreur(rep: FastifyReply, message: string, statut = 400): FastifyReply {
  return page(
    rep,
    "Autorisation impossible",
    "<h1>Autorisation impossible</h1>" +
      `<p>${echapperHtml(message)}</p>` +
      '<p class="muted">Fermez cette page et relancez la connexion depuis l\'application.</p>',
    statut,
  );
}

/** `RedirectResponse` de Starlette : adresse passée par `quote` (caractères d'URL gardés), corps vide. */
function rediriger(rep: FastifyReply, url: string): FastifyReply {
  return rep.redirect(quotePy(url, SURS_REDIRECTION), 302);
}

function quotePlusPy(s: string): string {
  return s.includes(" ") ? quotePy(s, " ").replaceAll(" ", "+") : quotePy(s, "");
}

function avecParametres(uri: string, params: readonly (readonly [string, string])[]): string {
  const requete = params.map(([k, v]) => `${quotePlusPy(k)}=${quotePlusPy(v)}`).join("&");
  return uri + (urlsplit(uri).query ? "&" : "?") + requete;
}

function redirectionErreur(
  requete: FastifyRequest,
  rep: FastifyReply,
  ruri: string,
  state: string,
  erreur: string,
  description: string,
): FastifyReply {
  const params: [string, string][] = [
    ["error", erreur],
    ["error_description", description],
    ["iss", urlApp(requete)],
  ];
  if (state) params.push(["state", state]);
  return rediriger(rep, avecParametres(ruri, params));
}

/** `parse_qs(corps.decode("utf-8"), keep_blank_values=True, max_num_fields=50)`, ou null si illisible. */
function analyserFormulaire(octets: Buffer): Map<string, string[]> | null {
  let texte: string;
  try {
    texte = decoderUtf8Py(octets);
  } catch {
    return null;
  }
  if (texte && texte.split("&").length > 50) return null;
  const champs = new Map<string, string[]>();
  for (const [nom, valeur] of analyserRequete(texte)) {
    const liste = champs.get(nom);
    if (liste) liste.push(valeur);
    else champs.set(nom, [valeur]);
  }
  return champs;
}

/** `_form` : première valeur de chaque champ ; un formulaire illisible vaut 400. */
function formulaire(requete: FastifyRequest): Map<string, string> {
  const champs = analyserFormulaire(corpsLu(requete));
  if (champs === null) throw new HttpError(400, "Formulaire illisible.");
  return new Map([...champs].map(([k, v]) => [k, v[0] ?? ""]));
}

/** `(client_id, secret)` : en-tête Basic (RFC 6749 § 2.3.1, décodé comme `b64decode`) ou corps. */
function identifiantsClient(requete: FastifyRequest, form: Map<string, string>): [string, string | null] {
  const auth = entete(requete, "authorization") ?? "";
  if (lowerPy(auth).startsWith("basic ")) {
    let brut: string;
    try {
      brut = decoderUtf8Py(urlsafeB64Decode(stripPy(auth.slice(6)).replace(/[-_]/gu, "")));
    } catch {
      throw new ErreurOAuth("invalid_client", "En-tête Basic illisible.", 401);
    }
    const i = brut.indexOf(":");
    return i < 0 ? [desechapper(brut), ""] : [desechapper(brut.slice(0, i)), desechapper(brut.slice(i + 1))];
  }
  return [form.get("client_id") ?? "", form.get("client_secret") || null];
}

interface Demande {
  client: ClientOAuth;
  ruri: string;
  state: string;
  challenge: string;
  resource: string;
  familles: string[];
  implicite: boolean;
}

export function creerFamilleOAuth(dep: DependancesFamilleOAuth): Famille {
  const base = dep.oauth.base;
  const instant = (): number => (dep.oauth.maintenant ? dep.oauth.maintenant() : Date.now() / 1000);
  const cleConsentement = (): string =>
    createHash("sha256").update(`${CONSENT_AUD}:${dep.auth.secret()}`, "utf8").digest("hex");
  const compteConnecte =
    dep.compteConnecte ??
    (async (requete: FastifyRequest): Promise<number | null> => {
      try {
        return await exigerUtilisateur(requete, dep.auth);
      } catch (e) {
        if (e instanceof HttpError) return null;
        throw e;
      }
    });

  function exigerActive(): PolitiqueOAuth {
    const pol = politiqueOauth(dep.oauth.config());
    if (!pol.enabled) throw new HttpError(404, "Autorisation OAuth désactivée.");
    return pol;
  }

  function prm(requete: FastifyRequest, rep: FastifyReply, famille = ""): FastifyReply {
    const pol = exigerActive();
    const url = urlApp(requete);
    let ressource = resourceBase(url);
    if (famille) {
      if (!pol.families.includes(famille)) throw new HttpError(404, "Famille inconnue.");
      ressource = `${ressource}/${famille}`;
    }
    return json(rep, {
      resource: ressource,
      authorization_servers: [url],
      scopes_supported: scopesSupported(pol),
      bearer_methods_supported: ["header"],
      resource_name: "Elpis — outils MCP",
    });
  }

  /** `_validate_authorize` : erreur affichée ici tant que la redirection n'est pas sûre (ou client jamais autorisé), renvoyée au client ensuite. */
  async function validerDemande(
    requete: FastifyRequest,
    rep: FastifyReply,
    q: Map<string, string>,
    pol: PolitiqueOAuth,
  ): Promise<Demande | { refus: FastifyReply }> {
    let client: ClientOAuth;
    try {
      client = await resolveClient(dep.oauth, q.get("client_id") ?? "");
    } catch (e) {
      if (e instanceof ErreurOAuth) return { refus: pageErreur(rep, e.description || "Client inconnu.") };
      throw e;
    }
    let ruri = q.get("redirect_uri") ?? "";
    const implicite = !ruri;
    if (!ruri && client.redirect_uris.length === 1) ruri = client.redirect_uris[0] ?? "";
    if (!ruri || !redirectionCorrespond(ruri, client.redirect_uris))
      return { refus: pageErreur(rep, "Adresse de retour non enregistrée pour ce client.") };
    const state = q.get("state") ?? "";
    const localSeulement =
      (client.kind === "dcr" || client.kind === "cimd") && !veritePy(client.last_used_at);
    const refus = (code: string, description: string): { refus: FastifyReply } => ({
      refus: localSeulement
        ? pageErreur(rep, description)
        : redirectionErreur(requete, rep, ruri, state, code, description),
    });
    if (q.get("response_type") !== "code")
      return refus("unsupported_response_type", "response_type=code attendu.");
    const challenge = q.get("code_challenge") ?? "";
    const n = longueurPy(challenge);
    if (!challenge || q.get("code_challenge_method") !== "S256" || n < 43 || n > 128)
      return refus("invalid_request", "PKCE S256 obligatoire.");
    let ressource: string;
    let famille: string | null;
    try {
      [ressource, famille] = checkResource(q.get("resource") ?? "", urlApp(requete), pol);
    } catch (e) {
      if (e instanceof ErreurOAuth) return refus(e.error, e.description);
      throw e;
    }
    let familles = famillesDePortee(q.get("scope") ?? null, pol);
    if (famille !== null) familles = familles.filter((f) => f === famille);
    if (familles.length === 0) return refus("invalid_scope", "Aucune famille d'outils permise.");
    return { client, ruri, state, challenge, resource: ressource, familles, implicite };
  }

  async function pageConsentement(rep: FastifyReply, uid: number, d: Demande): Promise<FastifyReply> {
    const jeton = signClaims(
      {
        uid,
        cid: d.client.client_id,
        ruri: d.ruri,
        imp: d.implicite,
        st: d.state,
        cc: d.challenge,
        res: d.resource,
        fams: d.familles,
      },
      cleConsentement(),
      { aud: CONSENT_AUD, now: instant() },
    );
    let qui: string;
    try {
      const u = await ligneUtilisateur(base, uid);
      qui = u ? strPy(veritePy(u.username) ? u.username : "") : "";
    } catch {
      qui = "";
    }
    const hote = urlsplit(d.ruri).netloc;
    const lignes = d.familles
      .map(
        (f) =>
          `<label><input type="checkbox" name="fam" value="${echapperHtml(f)}"` +
          `${PAS_COCHEES.has(f) ? "" : " checked"}>` +
          `<span>${echapperHtml(LIBELLES_FAMILLES[f] ?? f)} <span class="muted">(${echapperHtml(f)})</span></span></label>`,
      )
      .join("");
    let declare = "";
    if (d.client.kind === "dcr")
      declare = '<p class="warn">Nom déclaré par l\'application elle-même, non vérifié.</p>';
    else if (d.client.kind === "cimd")
      declare =
        '<p class="warn">Nom déclaré par un document publié sur ' +
        `<strong>${echapperHtml(urlsplit(d.client.client_id).netloc)}</strong>, non vérifié.</p>`;
    const corps =
      "<h1>Autoriser l'accès à vos outils</h1>" +
      `<p><strong>${echapperHtml(d.client.name || d.client.client_id)}</strong> demande à utiliser ` +
      `vos outils Elpis${qui ? ` en tant que <strong>${echapperHtml(qui)}</strong>` : ""}.</p>` +
      declare +
      `<p class="muted">Retour vers <code>${echapperHtml(hote)}</code></p>` +
      '<form method="post" action="/oauth/authorize">' +
      `<input type="hidden" name="req" value="${echapperHtml(jeton)}">` +
      `<fieldset><legend>Familles d'outils</legend>${lignes}</fieldset>` +
      '<p class="muted">Les appels s\'exécutent sous votre compte. Vous pourrez retirer cet accès dans ' +
      "Paramètres › Connexions.</p>" +
      '<div class="row"><button type="submit" name="decision" value="deny">Refuser</button>' +
      '<button class="primary" type="submit" name="decision" value="allow">Autoriser</button></div>' +
      "</form>";
    return page(rep, "Autoriser l'accès", corps);
  }

  const preflight = (_requete: FastifyRequest, rep: FastifyReply): FastifyReply =>
    rep.code(204).headers(CORS).send();

  return {
    nom: "oauth",
    contexte: (app) => {
      installerCorpsBorne(app, (req) => {
        if (req.method !== "POST") return null;
        const url = req.routeOptions.url;
        if (url === "/oauth/register") return { limite: CORPS_MAX, avant: () => exigerActive().dcr_enabled };
        if (url === "/oauth/authorize" || url === "/oauth/token" || url === "/oauth/revoke")
          return { limite: CORPS_MAX, avant: () => void exigerActive() };
        return null;
      });
    },
    routes: [
      {
        methode: "GET",
        chemin: "/.well-known/oauth-protected-resource",
        processus: ["main"],
        acces: "public",
        traiter: (req, rep) => prm(req, rep),
      },
      {
        methode: "GET",
        chemin: `/.well-known/oauth-protected-resource${RESOURCE_PATH}`,
        processus: ["main"],
        acces: "public",
        traiter: (req, rep) => prm(req, rep),
      },
      {
        methode: "GET",
        chemin: `/.well-known/oauth-protected-resource${RESOURCE_PATH}/:family`,
        processus: ["main"],
        acces: "public",
        traiter: (req, rep) => prm(req, rep, (req.params as { family: string }).family),
      },
      {
        methode: "GET",
        chemin: "/.well-known/oauth-authorization-server",
        processus: ["main"],
        acces: "public",
        traiter: (req, rep) => {
          const pol = exigerActive();
          const url = urlApp(req);
          const meta: Record<string, unknown> = {
            issuer: url,
            authorization_endpoint: `${url}/oauth/authorize`,
            token_endpoint: `${url}/oauth/token`,
            revocation_endpoint: `${url}/oauth/revoke`,
            scopes_supported: scopesSupported(pol),
            response_types_supported: ["code"],
            response_modes_supported: ["query"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
            revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
            code_challenge_methods_supported: ["S256"],
            client_id_metadata_document_supported: true,
            authorization_response_iss_parameter_supported: true,
          };
          if (pol.dcr_enabled) meta["registration_endpoint"] = `${url}/oauth/register`;
          return json(rep, meta);
        },
      },
      ...[
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-authorization-server",
        "/oauth/register",
        "/oauth/token",
        "/oauth/revoke",
      ].map((chemin) => ({
        methode: "OPTIONS" as const,
        chemin,
        processus: ["main" as const],
        acces: "public" as const,
        traiter: preflight,
      })),
      {
        methode: "POST",
        chemin: "/oauth/register",
        processus: ["main"],
        acces: "public",
        traiter: async (req, rep) => {
          const pol = exigerActive();
          if (!pol.dcr_enabled)
            return json(
              rep,
              {
                error: "access_denied",
                error_description: "Enregistrement dynamique désactivé par l'administrateur.",
              },
              403,
            );
          const brut = corpsLu(req);
          const octets = brut.length > 0 ? brut : Buffer.from("{}");
          let meta: unknown;
          try {
            pyJsonLoadsOctets(octets);
            meta = pyJsonLoads(texteJsonPy(octets), { mode: "valeurs" });
          } catch (e) {
            if (e instanceof ErreurJsonPy || (e instanceof ErreurLecturePy && e.nature !== "RecursionError"))
              return json(
                rep,
                { error: "invalid_client_metadata", error_description: "JSON invalide." },
                400,
              );
            throw e;
          }
          try {
            return json(rep, await registerClient(dep.oauth, meta), 201);
          } catch (e) {
            if (e instanceof ErreurOAuth) return erreurOAuth(rep, e);
            throw e;
          }
        },
      },
      {
        methode: "GET",
        chemin: "/oauth/authorize",
        processus: ["main"],
        acces: "public",
        traiter: async (req, rep) => {
          const pol = exigerActive();
          const brute = decouperCible(req.originalUrl).requete;
          const q = new Map(analyserRequete(brute));
          // Connexion d'abord : un document CIMD n'est récupéré que pour un compte connecté.
          const uid = await compteConnecte(req);
          if (uid === null) {
            const texte = decoderUtf8Py(Buffer.from(brute, "latin1"));
            const suivant = "/oauth/authorize" + (texte ? `?${texte}` : "");
            return rediriger(rep, "/?oauth_next=" + quotePy(suivant, ""));
          }
          const d = await validerDemande(req, rep, q, pol);
          if ("refus" in d) return d.refus;
          return pageConsentement(rep, uid, d);
        },
      },
      {
        methode: "POST",
        chemin: "/oauth/authorize",
        processus: ["main"],
        acces: "public",
        traiter: async (req, rep) => {
          const pol = exigerActive();
          const champs = analyserFormulaire(corpsLu(req));
          if (champs === null) return pageErreur(rep, "Formulaire illisible.");
          const claims = verifyClaims(champs.get("req")?.[0] ?? "", cleConsentement(), {
            aud: CONSENT_AUD,
            now: instant(),
            maxSkewS: CONSENT_TTL_S,
          });
          const uid = await compteConnecte(req);
          if (!claims || uid === null || intPy(veritePy(claims["uid"]) ? claims["uid"] : 0) !== uid)
            return pageErreur(
              rep,
              "Demande expirée ou session changée : relancez la connexion depuis l'application.",
            );
          const ruri = strPy(claims["ruri"]);
          const state = strPy(veritePy(claims["st"]) ? claims["st"] : "");
          if ((champs.get("decision") ?? [""])[0] !== "allow")
            return redirectionErreur(
              req,
              rep,
              ruri,
              state,
              "access_denied",
              "Accès refusé par l'utilisateur.",
            );
          const demandees = (veritePy(claims["fams"]) ? (claims["fams"] as unknown[]) : []).map((f) =>
            strPy(f),
          );
          const choisies = new Set(champs.get("fam") ?? []);
          const familles = demandees.filter((f) => choisies.has(f) && pol.families.includes(f));
          if (familles.length === 0)
            return redirectionErreur(req, rep, ruri, state, "access_denied", "Aucune famille autorisée.");
          const code = await issueCode(dep.oauth, {
            client_id: strPy(claims["cid"]),
            user_id: uid,
            redirect_uri: veritePy(claims["imp"]) ? "" : ruri,
            code_challenge: strPy(claims["cc"]),
            resource: strPy(claims["res"]),
            families: familles,
          });
          const params: [string, string][] = [
            ["code", code],
            ["iss", urlApp(req)],
          ];
          if (state) params.push(["state", state]);
          return rediriger(rep, avecParametres(ruri, params));
        },
      },
      {
        methode: "POST",
        chemin: "/oauth/token",
        processus: ["main"],
        acces: "public",
        traiter: async (req, rep) => {
          exigerActive();
          const form = formulaire(req);
          try {
            const [cid, secret] = identifiantsClient(req, form);
            const client = await authenticateClient(base, cid, secret);
            const grant = form.get("grant_type") ?? "";
            if (grant === "authorization_code")
              return json(
                rep,
                await exchangeCode(dep.oauth, {
                  code: form.get("code") ?? "",
                  client,
                  redirectUri: form.get("redirect_uri") ?? "",
                  codeVerifier: form.get("code_verifier") ?? "",
                  resource: form.get("resource") || null,
                  appUrl: urlApp(req),
                }),
              );
            if (grant === "refresh_token")
              return json(
                rep,
                await refresh(dep.oauth, {
                  refreshToken: form.get("refresh_token") ?? "",
                  client,
                  scope: form.get("scope") || null,
                  resource: form.get("resource") || null,
                  appUrl: urlApp(req),
                }),
              );
            throw new ErreurOAuth("unsupported_grant_type", "authorization_code ou refresh_token.");
          } catch (e) {
            if (e instanceof ErreurOAuth) return erreurOAuth(rep, e);
            throw e;
          }
        },
      },
      {
        methode: "POST",
        chemin: "/oauth/revoke",
        processus: ["main"],
        acces: "public",
        traiter: async (req, rep) => {
          exigerActive();
          const form = formulaire(req);
          let cid: string;
          try {
            let secret: string | null;
            [cid, secret] = identifiantsClient(req, form);
            if (cid) await authenticateClient(base, cid, secret);
          } catch (e) {
            if (e instanceof ErreurOAuth) return erreurOAuth(rep, e);
            throw e;
          }
          await revokeToken(dep.oauth, form.get("token") ?? "", cid || null);
          return json(rep, {});
        },
      },
      {
        methode: "GET",
        chemin: "/api/oauth/grants",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const items = await listGrants(base, uid, instant());
          return reponseJsonPy(
            rep,
            { items, enabled: politiqueOauth(dep.oauth.config()).enabled },
            { "Cache-Control": "no-store" },
          );
        },
      },
      {
        methode: "DELETE",
        chemin: "/api/oauth/grants/:grant_id",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const { grant_id } = req.params as { grant_id: string };
          if (!(await revokeGrant(base, uid, grant_id, instant())))
            throw new HttpError(404, "Autorisation introuvable.");
          return { ok: true };
        },
      },
    ],
  };
}
