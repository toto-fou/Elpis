// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/session.ts — `pw_session` : ouverture (garde de l'adresse, session sécurisée quand un secret attaché couvre l'origine, propriété posée par l'outil), arrêt, état, liste, nettoyage ; aucun identifiant n'est accepté ni retenu. */
import { estDict, intPy, lowerPy, nomTypePy, reprPy, stripPy, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { errPw, origineExacte, pwOwner, recordPwSessionOwner, refusUrl } from "@elpis/navigateur";
import type { ContexteAppel } from "@elpis/outils-mcp";

import type { SecretApplicable } from "../../rappel";
import { minusculesPy, ouvrirAppel } from "./appel";
import type { ServicesBrowser } from "./appel";
import { applicables, refusSecret, resoudre } from "./secrets";

/** Secret qui ouvre la session : désigné (`secret=`), sinon le seul attaché qui couvre l'origine ; `http-auth` résolu pour le contexte du navigateur. */
interface SecretDeSession {
  readonly secret: SecretApplicable;
  readonly origine: string;
  readonly identifiants: { username: string; password: string } | null;
}

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

/** Secret de la session à ouvrir sur `url` : `secret=` contrôlé par le core, sinon le seul secret attaché qui couvre l'origine (plusieurs : `secret_ambiguous`) ; `null` : session ordinaire ; un `http-auth` est résolu ici (valeur passée au service, jamais rendue). */
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
      avis: "The vault did not answer: this is not a secure session, pw_login cannot be used in it.",
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
  if (choisi.kind !== "http-auth") return { choix: { secret: choisi, origine, identifiants: null } };
  const v = await resoudre(port, "http-auth", origine, choisi.name);
  if ("refus" in v) return v;
  return {
    choix: {
      secret: { ...choisi, tls: v.valeur.tls },
      origine,
      identifiants: { username: v.valeur.username ?? "", password: v.valeur.secret },
    },
  };
}

/** `start` : url exigée et autorisée, session sécurisée quand un secret attaché couvre l'origine (`http-auth` appliqué au contexte, TLS de sa politique), groupe du compte joint pour le quota d'un enfant isolé, propriété de la session posée. */
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
  const bloque = await refusUrl(url);
  if (bloque !== null) return bloque;
  const coffre = await secretDeSession(s, url, a["secret"]);
  if ("refus" in coffre) return coffre.refus;
  const choix = coffre.choix;
  const corps: Dict = {
    url,
    load_state_id: a["load_state_id"],
    record_har: a["record_har"],
    owner: client.owner,
  };
  if (choix !== null) {
    corps["secure"] = true;
    corps["tls"] = choix.secret.tls;
    if (choix.identifiants !== null)
      Object.assign(corps, { credentials_origin: choix.origine, ...choix.identifiants });
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
    if (choix !== null && ouverte) {
      resultat["secret"] = choix.secret.name;
      if (choix.secret.kind === "web-login")
        resultat["secret_note"] =
          `Secure session for secret '${choix.secret.name}': call pw_login(session_id, secret="${choix.secret.name}") on its login page.`;
    }
    if (coffre.avis && ouverte) resultat["secret_warning"] = coffre.avis;
  }
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
