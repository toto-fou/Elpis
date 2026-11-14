// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/session.ts — `pw_session` : ouverture (garde de l'adresse ; quand un secret attaché couvre l'origine, session ordinaire ouverte pour lui avec le TLS de sa politique et un `http-auth` appliqué, liée à ce secret et reprise pour lui ensuite ; propriété posée par l'outil), arrêt, état, liste, nettoyage ; aucun identifiant n'est accepté ni retenu. */
import { estDict, intPy, lowerPy, nomTypePy, reprPy, stripPy, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { randomBytes } from "node:crypto";

import { errPw, origineExacte, pwOwner, recordPwSessionOwner } from "@elpis/navigateur";
import type { ContexteAppel } from "@elpis/outils-mcp";

import type { SecretApplicable } from "../../rappel";
import { minusculesPy, ouvrirAppel, refusUrlAppel } from "./appel";
import type { Appel, ServicesBrowser } from "./appel";
import { lier, oublier, oublierProprietaire, sessionDuSecret } from "./liaisons";
import { dureeLiaisonMs, lierAuRelais, oublierAuRelais } from "./bac";
import { applicables, HORS_APPLICATION, refusSecret, resolutionDifferee, SANS_IDENTIFIANT } from "./secrets";

/** Secret qui ouvre la session : désigné (`secret=`), sinon le seul attaché qui couvre l'origine (sans valeur). */
interface SecretDeSession {
  readonly secret: SecretApplicable;
  readonly origine: string;
}

/** Erreurs du service pour une session qui n'existe plus. */
export const SESSION_DISPARUE = new Set(["session_not_found", "session_expired"]);

/** `viewport="LxH"` → `{width, height}`, `null` si illisible. */
function fenetre(viewport: string): Dict | null {
  const v = lowerPy(viewport);
  const i = v.indexOf("x");
  if (i < 0) return null;
  try {
    return { width: intPy(v.slice(0, i)), height: intPy(v.slice(i + 1)) };
  } catch {
    return null;
  }
}

/** Secret de la session à ouvrir sur `url` : `secret=` contrôlé par le core, sinon le seul secret attaché qui couvre l'origine (plusieurs : `secret_ambiguous`) ; `null` : session ordinaire ; un `http-auth` sans nom d'utilisateur est refusé avant toute résolution. */
async function secretDeSession(
  s: ServicesBrowser,
  url: string,
  demande: unknown,
): Promise<{ refus: Dict } | { choix: SecretDeSession | null; avis?: string }> {
  const nom = typeof demande === "string" && demande.trim() ? demande.trim() : null;
  const origine = origineExacte(url);
  if (!origine)
    return nom === null
      ? { choix: null }
      : { refus: refusSecret("secret_scope_mismatch", "Secrets apply to http(s) origins only.") };
  const port = s.secrets ?? null;
  const r = await applicables(port, origine, nom);
  if (r === null) return { choix: null };
  if ("refus" in r) {
    if (nom !== null || r.refus["error"] !== "secret_unavailable") return r;
    return {
      choix: null,
      avis: "The vault did not answer: this session was not opened for a secret, pw_login cannot be used in it.",
    };
  }
  if (r.valeur.length > 1)
    return {
      refus: refusSecret(
        "secret_ambiguous",
        `Several attached secrets apply to ${origine}: ${r.valeur.map((x) => x.name).join(", ")}.`,
        `Start again with secret="<name>", one of: ${r.valeur.map((x) => x.name).join(", ")}.`,
      ),
    };
  const choisi = r.valeur[0];
  if (choisi === undefined) return { choix: null };
  if (choisi.kind === "http-auth" && !choisi.username)
    return {
      refus: refusSecret("secret_username_required", SANS_IDENTIFIANT(choisi.name), FIX_IDENTIFIANT),
    };
  return { choix: { secret: choisi, origine } };
}

const FIX_IDENTIFIANT =
  "Ask the user to add the user name of this secret in Settings › Secrets, then start again; never ask for it or for a password in the chat.";

/** Note jointe à une session ouverte pour un secret `web-login`. */
const noteConnexion = (nom: string): string =>
  `Session opened for secret '${nom}' (TLS of its policy): call pw_login(session_id, secret="${nom}") on its login page; every other tool works as usual.`;

/** Options fixées à la création du contexte : sans effet sur une session reprise. */
function optionsDeCreation(a: Dict): string[] {
  const noms = [
    "record_har",
    "trace",
    "record_video",
    "device",
    "viewport",
    "locale",
    "timezone",
    "color_scheme",
  ];
  return [...noms.filter((k) => veritePy(a[k])), ...(typeof a["touch"] === "boolean" ? ["touch"] : [])];
}

/** Session déjà ouverte par ce propriétaire pour le même secret, la même origine et le même TLS : l'adresse s'y ouvre (ni nouvelle session, ni usage du secret) ; `null` s'il n'y en a pas ou si elle n'existe plus. */
async function reprendreSession(
  client: Appel["client"],
  choix: SecretDeSession,
  url: string,
  sansEffet: string[],
): Promise<Dict | null> {
  const sid = sessionDuSecret(client.owner, choix.secret.name, choix.origine, choix.secret.tls);
  if (sid === null) return null;
  if (sansEffet.length) {
    const vivantes = await client.req("GET", "/sessions");
    const ouverte =
      estDict(vivantes) &&
      Array.isArray(vivantes["sessions"]) &&
      vivantes["sessions"].some((x) => estDict(x) && x["session_id"] === sid);
    if (ouverte)
      return errPw("session_options_need_new_session", "", {
        message: `The session already open for secret '${choix.secret.name}' is reused (one per secret): ${sansEffet.join(", ")} can only be set when a session is created, so they were NOT applied and nothing was opened.`,
        fix: `Close that session first (pw_session action='stop', session_id='${sid}') and start again with these options, or drop ${sansEffet.join(", ")} to open the url in a new tab of the existing session.`,
      });
  }
  const r = await client.req("POST", "/action", { json: { session_id: sid, type: "goto", url } });
  if (estDict(r) && SESSION_DISPARUE.has(strPy(r["error"] ?? ""))) {
    oublier(client.owner, sid);
    return null;
  }
  return {
    ...(estDict(r) ? r : {}),
    status: estDict(r) && r["ok"] === false ? r["status"] : "reused",
    session_id: sid,
    reused: true,
    tls: choix.secret.tls,
    secret: choix.secret.name,
    reuse_note: `The session already open for secret '${choix.secret.name}' was reused (one session per secret).`,
    ...(choix.secret.kind === "web-login" ? { secret_note: noteConnexion(choix.secret.name) } : {}),
  };
}

/** `start` : url exigée et autorisée, session ouverte pour le secret attaché qui couvre l'origine (TLS de sa politique ; `http-auth` appliqué au contexte, sans HAR ni trace), groupe du compte joint pour le quota d'un enfant isolé, propriété de la session posée. */
async function demarrer(
  a: Dict,
  s: ServicesBrowser,
  appel: Awaited<ReturnType<typeof ouvrirAppel>>,
): Promise<unknown> {
  if (appel.refus !== null) return appel.refus;
  const { client, username, portee } = appel.appel;
  const url = a["url"] as string;
  if (!stripPy(url || ""))
    return errPw("url_required", "", {
      message: "pw_session(action='start') requires url= — starting IS the navigation.",
      fix: "call pw_session(action='start', url='https://…'). An already-open session is reused and the url opens in a NEW TAB (pw_page action='tabs'/'tab_switch'). On a session you already have, pw_act(action='goto', url='https://…') navigates the current tab.",
    });
  const bloque = await refusUrlAppel(appel.appel, url);
  if (bloque !== null) return bloque;
  const coffre = await secretDeSession(s, url, a["secret"]);
  if ("refus" in coffre) return coffre.refus;
  const choix = coffre.choix;
  if (choix?.secret.kind === "http-auth" && (veritePy(a["record_har"]) || veritePy(a["trace"])))
    return errPw("recording_with_credentials", "", {
      message: `Secret '${choix.secret.name}' applies HTTP authentication to this session: a HAR or a trace would keep it in clear.`,
      fix: "Start again without record_har and trace.",
    });
  if (choix !== null) {
    const reprise = await reprendreSession(client, choix, url, optionsDeCreation(a));
    if (reprise !== null) return reprise;
  }
  const tls = choix?.secret.tls ?? "strict";
  // Le secret est lié au relais de l'hôte (origines déchiffrées, défis 401 résolus par lui) ; la valeur n'entre jamais dans le bac.
  // http-auth : la liaison ne sert que la session ouverte ici (clé posée par le service sur ses seules requêtes), le temps de son activité.
  let relais: { compte: string; ids: string[] } | undefined;
  let liaisonService: { key: string; origins: string[] } | null = null;
  if (choix !== null) {
    const origines = choix.secret.origins.length ? choix.secret.origins : [choix.origine];
    const differee =
      choix.secret.kind === "http-auth"
        ? resolutionDifferee(s.secrets ?? null, "http-auth", choix.origine, choix.secret.name)
        : async () => null;
    if (differee === null) return HORS_APPLICATION;
    const id = `${choix.secret.kind}-${randomBytes(8).toString("hex")}`;
    const cle = choix.secret.kind === "http-auth" ? randomBytes(24).toString("hex") : null;
    if (
      !lierAuRelais(username, {
        id,
        nom: choix.secret.name,
        kind: choix.secret.kind,
        origines,
        tls,
        substitut: null,
        cle,
        dureeMs: dureeLiaisonMs(),
        resoudre: differee,
      })
    )
      return errPw("browser_sandbox_unavailable", "", {
        message: "The secret relay of your sandbox browser is not running.",
        fix: "Retry pw_session(action='start', ...).",
      });
    relais = { compte: username, ids: [id] };
    if (cle !== null) liaisonService = { key: cle, origins: [...origines] };
  }
  const corps: Dict = {
    url,
    load_state_id: a["load_state_id"],
    record_har: a["record_har"],
    owner: client.owner,
  };
  if (choix !== null) {
    corps["tls"] = tls;
    if (liaisonService !== null) corps["relay_binding"] = liaisonService;
  }
  if (a["device"]) corps["device"] = a["device"];
  if (a["viewport"]) {
    const f = fenetre(a["viewport"] as string);
    if (f !== null) corps["viewport"] = f;
  }
  for (const k of ["locale", "timezone", "color_scheme"]) if (a[k]) corps[k] = a[k];
  if (portee === "isolee") corps["group"] = pwOwner(username);
  if (a["touch"] !== null) corps["touch"] = a["touch"];
  for (const k of ["isolated", "trace", "record_video"])
    if (a[k] && !(k === "isolated" && portee === "compte-delegue")) corps[k] = true;
  const resultat = await client.req("POST", "/start", { json: corps });
  if (estDict(resultat)) {
    const sid = veritePy(resultat["session_id"]) ? resultat["session_id"] : resultat["sid"];
    const ouverte = !veritePy(resultat["error"]) && resultat["ok"] !== false;
    if (veritePy(sid) && username && ouverte)
      await recordPwSessionOwner(strPy(sid), username).catch(() => undefined);
    if (choix !== null && ouverte && veritePy(sid)) {
      lier(client.owner, strPy(sid), {
        secret: choix.secret.name,
        kind: choix.secret.kind,
        origines: choix.secret.origins.length ? choix.secret.origins : [choix.origine],
        tls,
        sousAgents: choix.secret.subagents,
        ...(relais ? { relais } : {}),
      });
      resultat["secret"] = choix.secret.name;
      if (choix.secret.kind === "web-login") resultat["secret_note"] = noteConnexion(choix.secret.name);
    }
    if (coffre.avis && ouverte) resultat["secret_warning"] = coffre.avis;
    if (relais && !(choix !== null && ouverte && veritePy(sid))) oublierAuRelais(relais.compte, relais.ids);
  } else if (relais) oublierAuRelais(relais.compte, relais.ids);
  return resultat;
}

/** Un enfant sur la session du compte ne la ferme pas : `stop` et `cleanup` fermeraient le navigateur de l'utilisateur. */
function refusFermetureCompte(action: string): Dict {
  return errPw("user_session_protected", "", {
    message: `pw_session(action='${action}') is not available to a sub-agent working in the user's own browser session: it would close the user's browser.`,
    fix: "Leave the session open: the harness does not close it either. Return your report.",
  });
}

/** `pw_session` : `start` ne vérifie pas `session_id` (il retrouve l'instance du propriétaire), les autres actions si. */
export function pwSession(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const action = a["action"] as string;
    const appel = await ouvrirAppel(ctx, s, action === "start" ? null : a["session_id"]);
    if (action === "start") return demarrer(a, s, appel);
    if (appel.refus !== null) return appel.refus;
    const { client } = appel.appel;
    if (
      appel.appel.portee === "compte-delegue" &&
      (action === "stop" || action === "cleanup" || action === "cleanup_own")
    )
      return refusFermetureCompte(action);
    const sid = a["session_id"];
    if (action === "stop") oublier(client.owner, strPy(sid ?? ""));
    if (action === "stop" || action === "trace_export" || action === "save_state")
      return client.req("POST", `/${action}`, { json: { session_id: sid } });
    if (action === "list") {
      const r = await client.req("GET", "/sessions");
      const filtre = a["url_filter"] as string;
      if (estDict(r) && filtre && Array.isArray(r["sessions"])) {
        const f = lowerPy(filtre);
        const retenues = (r["sessions"] as unknown[]).filter((x) => {
          if (!estDict(x)) throw new TypeError(`'${nomTypePy(x)}' object has no attribute 'get'`);
          return minusculesPy(x["url"] ?? "").includes(f) || minusculesPy(x["origin"] ?? "").includes(f);
        });
        return { ...r, sessions: retenues, filtered_count: retenues.length };
      }
      return r;
    }
    if (action === "cleanup" || (action === "cleanup_own" && appel.appel.portee === "isolee"))
      oublierProprietaire(client.owner);
    if (action === "cleanup") return client.req("POST", "/cleanup");
    if (action === "cleanup_own")
      return appel.appel.portee === "isolee"
        ? client.req("POST", "/cleanup")
        : errPw("not_a_subagent", "", {
            message:
              "pw_session(action='cleanup_own') closes the private sessions of a sub-agent: it is reserved to the harness.",
            fix: "use action='cleanup' to close your own sessions.",
          });
    if (action === "health") return client.req("GET", "/health");
    return errPw(`unknown action ${reprPy(action)}`, "use: start|stop|save_state|list|cleanup|health");
  };
}
