// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/login.ts — `pw_login` : connexion avec un secret attaché à la conversation, valeur jamais vue du modèle ; ordre fixe : pré-contrôle des champs sans valeur, résolution par le core sur l'origine du frame des champs, puis saisie, soumission et remplacement des documents par le service en une requête. */
import { estDict, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { buildLocatorPayload, errPw } from "@elpis/navigateur";
import type { ContexteAppel } from "@elpis/outils-mcp";

import { ouvrirAppel } from "./appel";
import type { ServicesBrowser } from "./appel";
import { AVIS_SECRET_DANS_PAGE, conseilSecret, refusSecret, resoudre } from "./secrets";

/** Clés de cible que le service accepte pour une connexion (jamais xpath). */
const CLES_CIBLE = [
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
  "nth",
] as const;
const CIBLES = ["username_target", "password_target", "submit_target", "wait_for"] as const;
/** Budget de la connexion au service (40 s), remplacement des documents et plafond (62 s), plus une marge. */
const DELAI_LOGIN_S = 75;
const FIX_CIBLE =
  "Pass a semantic target (label=..., placeholder=..., role=...|name=..., text=..., test_id=..., alt=..., title=..., css=...) or a ref from pw_find, or leave it out to let the fields be detected.";

/** Cible DSL → clés du service ; `null` si elle ne désigne rien d'utilisable pour une connexion. */
function cible(dsl: string): Dict | null {
  const [charge] = buildLocatorPayload({ target: dsl });
  const sortie: Dict = {};
  for (const k of CLES_CIBLE) if (veritePy(charge[k]) || charge[k] === 0) sortie[k] = charge[k];
  return Object.keys(sortie).length > 0 && !(Object.keys(sortie).length === 1 && "nth" in sortie)
    ? sortie
    : null;
}

/** Refus du service ramené aux outils : session ordinaire (la session sécurisée s'ouvre par `pw_session` avec le secret), champs, origine, échec. */
function avecConseilOutil(r: unknown): unknown {
  if (!estDict(r) || r["error"] !== "secret_route_refused") return conseilSecret(r, true);
  return {
    ...r,
    fix: 'Open the login page with pw_session(action="start", url=..., secret="<name>"): a session started for an attached secret is a secure session; call pw_login there.',
  };
}

/** `pw_login` : pré-contrôle sans valeur, résolution sur l'origine du frame des champs, puis connexion ; le modèle ne reprend la main qu'après le remplacement des onglets qui ont reçu le secret (page qui le montrait : avertissement), la valeur n'est jamais rendue. */
export function pwLogin(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const sid = typeof a["session_id"] === "string" ? a["session_id"].trim() : "";
    if (!sid)
      return errPw("session_id_required", "", {
        message: "pw_login needs the session_id of a secure session.",
        fix: 'Open the login page with pw_session(action="start", url=...) on an origin of an attached secret.',
      });
    const o = await ouvrirAppel(ctx, s, sid);
    if (o.refus !== null) return o.refus;
    const { client } = o.appel;
    const nom = typeof a["secret"] === "string" && a["secret"].trim() ? a["secret"].trim() : null;
    const charge: Dict = { session_id: sid };
    for (const k of CIBLES) {
      const brut = a[k];
      if (typeof brut !== "string" || !brut.trim()) continue;
      const c = cible(brut);
      if (c === null)
        return refusSecret(
          "secret_target_required",
          `${k} does not designate an element a login can use.`,
          FIX_CIBLE,
        );
      charge[k] = c;
    }
    const pre = await client.req("POST", "/login_precheck", { json: charge });
    if (!estDict(pre) || pre["ok"] !== true || typeof pre["frame_origin"] !== "string")
      return estDict(pre)
        ? avecConseilOutil(pre)
        : errPw("secret_login_failed", "", { message: "The login fields could not be checked." });
    const champs = Array.isArray(pre["fields"]) ? pre["fields"] : [];
    const r = await resoudre(s.secrets ?? null, "web-login", pre["frame_origin"], nom);
    if ("refus" in r) return r.refus;
    const brut = await client.req("POST", "/login", {
      json: {
        ...charge,
        secret_origin: pre["frame_origin"],
        username_value: champs.includes("username") ? (r.valeur.username ?? "") : "",
        password_value: champs.includes("password") ? r.valeur.secret : "",
      },
      timeout: DELAI_LOGIN_S,
    });
    const conseil = avecConseilOutil(brut);
    if (!estDict(conseil)) return conseil;
    const resultat: Dict = { ...conseil, secret: r.valeur.name };
    if (resultat["secret_in_page"] === true) resultat["warning"] = AVIS_SECRET_DANS_PAGE;
    return client.finishAct(resultat, sid, true, 25);
  };
}
