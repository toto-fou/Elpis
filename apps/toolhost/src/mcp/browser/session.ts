// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/session.ts — `pw_session` : ouverture (garde de l'adresse, identifiants de la mémoire AX, propriété posée par l'outil), arrêt, état, liste, nettoyage. */
import { estDict, intPy, lowerPy, nomTypePy, reprPy, stripPy, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import {
  errPw,
  getCredentials,
  pwOwner,
  recordPwSessionOwner,
  refusUrl,
  saveCredentials,
} from "@elpis/navigateur";
import type { ContexteAppel } from "@elpis/outils-mcp";

import { headless, minusculesPy, ouvrirAppel } from "./appel";
import type { ServicesBrowser } from "./appel";

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

/** `start` : url exigée et autorisée, identifiants de la mémoire AX si absents (jamais pour un enfant à session isolée : ni lus ni écrits), groupe du compte joint pour le quota d'un enfant isolé, propriété de la session posée, identifiants retenus après succès. */
async function demarrer(
  a: Dict,
  s: ServicesBrowser,
  appel: Awaited<ReturnType<typeof ouvrirAppel>>,
): Promise<unknown> {
  if (appel.refus !== null) return appel.refus;
  const { client, username, portee } = appel.appel;
  const ax = portee === "isolee" ? null : appel.appel.ax;
  const url = a["url"] as string;
  if (!stripPy(url || ""))
    return errPw("url_required", "", {
      message: "pw_session(action='start') requires url= — starting IS the navigation.",
      fix: "call pw_session(action='start', url='https://…'). An already-open session is reused and the url opens in a NEW TAB (pw_page action='tabs'/'tab_switch'). On a session you already have, pw_act(action='goto', url='https://…') navigates the current tab.",
    });
  const bloque = await refusUrl(url);
  if (bloque !== null) return bloque;
  let identifiant = a["username"];
  let motDePasse = a["password"];
  if (ax !== null && url && (!veritePy(identifiant) || !veritePy(motDePasse))) {
    const connu = await getCredentials(ax, url, username || "").catch(() => null);
    if (connu !== null) {
      if (!veritePy(identifiant)) identifiant = connu["username"];
      if (!veritePy(motDePasse)) motDePasse = connu["password"];
      s.journal.info(
        `[ax-creds] auto-injected creds for ${url} (user=${strPy(connu["username"])}, use_count=${strPy(connu["use_count"] ?? 0)})`,
      );
    }
  }
  const corps: Dict = {
    url,
    username: identifiant,
    password: motDePasse,
    headless: headless(),
    load_state_id: a["load_state_id"],
    record_har: a["record_har"],
    owner: client.owner,
  };
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
    if (veritePy(sid) && username && !veritePy(resultat["error"]))
      await recordPwSessionOwner(strPy(sid), username).catch(() => undefined);
    if (ax !== null && veritePy(identifiant) && veritePy(motDePasse) && !veritePy(resultat["error"]))
      await saveCredentials(ax, url, identifiant as string, motDePasse as string, username || "").catch(
        () => false,
      );
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
