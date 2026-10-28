// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/session.ts — `pw_session` : ouverture (garde de l'adresse, identifiants HTTP d'un jeton du coffre liés à l'origine, propriété posée par l'outil), arrêt, état, liste, nettoyage. */
import { estDict, intPy, lowerPy, nomTypePy, reprPy, stripPy, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { errPw, recordPwSessionOwner, refusUrl } from "@elpis/navigateur";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { origineExacte } from "@elpis/securite";

import { headless, minusculesPy, ouvrirAppel } from "./appel";
import type { ServicesBrowser } from "./appel";
import { jetonDeReference, nettoyerResultat, normaliserReference, resoudreSecrets } from "./creds";
import type { SecretResolu } from "./creds";

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

/** `start` : url exigée et autorisée, identifiants HTTP d'un jeton `creds` (origine exacte de l'url), propriété de la session posée. */
async function demarrer(
  a: Dict,
  s: ServicesBrowser,
  ctx: ContexteAppel,
  appel: Awaited<ReturnType<typeof ouvrirAppel>>,
): Promise<unknown> {
  if (appel.refus !== null) return appel.refus;
  const { client, username } = appel.appel;
  const url = a["url"] as string;
  if (!stripPy(url || ""))
    return errPw("url_required", "", {
      message: "pw_session(action='start') requires url= — starting IS the navigation.",
      fix: "call pw_session(action='start', url='https://…'). An already-open session is reused and the url opens in a NEW TAB (pw_page action='tabs'/'tab_switch'). On a session you already have, pw_act(action='goto', url='https://…') navigates the current tab.",
    });
  const bloque = await refusUrl(url);
  if (bloque !== null) return bloque;
  const creds = normaliserReference(a["creds"] ?? "");
  let secrets: SecretResolu[] = [];
  let identifiants: Dict = {};
  if (creds) {
    const jeton = jetonDeReference(`${creds}.password`);
    if (jeton === null)
      return errPw("creds_invalid", "", {
        message: "creds= takes the TOKEN of a ⟦creds:TOKEN⟧ supplied by the user",
        fix: "ask the user to supply a login with the /creds command",
      });
    const origineUrl = origineExacte(url);
    const r = await resoudreSecrets(s, ctx, [`${jeton}.username`, `${jeton}.password`]);
    if ("refus" in r) return r.refus;
    secrets = r.secrets;
    const [identifiant, motDePasse] = secrets;
    if (origineUrl === null || origineUrl !== identifiant?.origine)
      return errPw("creds_origin_mismatch", "", {
        message: "url= is not on the exact origin these credentials are bound to",
        fix: "start the session on the credentials' origin, or ask the user for /creds for this origin",
      });
    identifiants = {
      username: identifiant.valeur,
      password: motDePasse?.valeur,
      credentials_origin: identifiant.origine,
    };
  }
  const corps: Dict = {
    url,
    ...identifiants,
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
  if (a["touch"] !== null) corps["touch"] = a["touch"];
  for (const k of ["isolated", "trace", "record_video"]) if (a[k]) corps[k] = true;
  const resultat = await client.req("POST", "/start", { json: corps });
  if (estDict(resultat)) {
    const sid = veritePy(resultat["session_id"]) ? resultat["session_id"] : resultat["sid"];
    if (veritePy(sid) && username && !veritePy(resultat["error"]))
      await recordPwSessionOwner(strPy(sid), username).catch(() => undefined);
  }
  return nettoyerResultat(resultat, secrets);
}

/** `pw_session` : `start` ne vérifie pas `session_id` (il retrouve l'instance du compte), les autres actions si. */
export function pwSession(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const action = a["action"] as string;
    const appel = await ouvrirAppel(ctx, s, action === "start" ? null : a["session_id"]);
    if (action === "start") return demarrer(a, s, ctx, appel);
    if (appel.refus !== null) return appel.refus;
    const { client } = appel.appel;
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
    if (action === "health") return client.req("GET", "/health");
    return errPw(`unknown action ${reprPy(action)}`, "use: start|stop|save_state|list|cleanup|health");
  };
}
