// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/login.ts — `pw_login` : connexion avec un secret attaché à la conversation, valeur jamais vue du modèle, dans une session ouverte pour un secret ; ordre fixe : pré-contrôle des champs sans valeur, secret choisi sans valeur et contrôlé contre le TLS de la session, résolution par le core sur l'origine du frame des champs, puis étape isolée du service (page rechargée, saisie, soumission, remplacement des documents) en une requête. */
import { estDict, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { buildLocatorPayload, errPw } from "@elpis/navigateur";
import type { ContexteAppel } from "@elpis/outils-mcp";

import type { SecretApplicable } from "../../rappel";
import { ouvrirAppel } from "./appel";
import type { ServicesBrowser } from "./appel";
import { liaison } from "./liaisons";
import type { LiaisonSession } from "./liaisons";
import { applicables, conseilSecret, HORS_APPLICATION, refusSecret, resoudre } from "./secrets";

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

/** Secret admis dans la session liée sauf s'il exige des certificats vérifiés et que la session a été ouverte sans. */
function refusTls(lien: LiaisonSession, s: Pick<SecretApplicable, "name" | "tls">): Dict | null {
  if (s.tls !== "strict" || lien.tls !== "insecure") return null;
  return refusSecret(
    "secret_scope_mismatch",
    `Secret '${s.name}' requires verified certificates, but this session was opened for secret '${lien.secret}' with certificate checks off.`,
    `Open the login page in a session of its own with pw_session(action="start", url=..., secret="${s.name}"), then call pw_login there.`,
  );
}

/** Secret web-login de la connexion, sans valeur : celui nommé, sinon le seul attaché qui couvre l'origine du frame (refus codés sinon). */
async function secretDeConnexion(
  s: ServicesBrowser,
  origine: string,
  nom: string | null,
): Promise<{ secret: SecretApplicable } | { refus: Dict }> {
  const m = await applicables(s.secrets ?? null, origine, nom);
  if (m === null) return { refus: HORS_APPLICATION };
  if ("refus" in m) return m;
  const web = m.valeur.filter((x) => x.kind === "web-login");
  const choisi = web[0];
  if (web.length > 1)
    return {
      refus: refusSecret(
        "secret_ambiguous",
        `Several attached secrets cover ${origine}: ${web.map((x) => x.name).join(", ")}.`,
        `Call pw_login again with secret="<name>", one of: ${web.map((x) => x.name).join(", ")}.`,
      ),
    };
  if (choisi !== undefined) return { secret: choisi };
  return {
    refus:
      nom !== null && m.valeur.length
        ? refusSecret(
            "secret_type_mismatch",
            `Secret '${nom}' is an http-auth secret: pw_login types web-login secrets only.`,
            "An http-auth secret is applied by pw_session(action='start', url=..., secret=...); pw_login needs a web-login secret.",
          )
        : refusSecret(
            "secret_not_attached",
            `No web-login secret attached to this conversation covers ${origine}.`,
          ),
  };
}

/** `pw_login` : pré-contrôle sans valeur, secret contrôlé contre le TLS de la session liée, résolution sur l'origine du frame des champs, puis connexion ; le modèle ne reprend la main qu'après le remplacement des onglets qui ont reçu le secret, la valeur n'est jamais rendue. */
export function pwLogin(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const sid = typeof a["session_id"] === "string" ? a["session_id"].trim() : "";
    if (!sid)
      return errPw("session_id_required", "", {
        message: "pw_login needs the session_id of a session opened for a secret.",
        fix: 'Open the login page with pw_session(action="start", url=...) on an origin of an attached secret.',
      });
    const o = await ouvrirAppel(ctx, s, sid);
    if (o.refus !== null) return o.refus;
    const { client } = o.appel;
    const lien = liaison(client.owner, sid);
    if (lien === undefined)
      return refusSecret(
        "secret_session_required",
        "This session was not opened for a vault secret by Elpis (no attached secret covered its start URL, or it was opened before a restart): pw_login needs the TLS policy of the secret's own session.",
        'Open the login page with pw_session(action="start", url=..., secret="<name>"), then call pw_login in that session.',
      );
    const demande = typeof a["secret"] === "string" && a["secret"].trim() ? a["secret"].trim() : null;
    const nom = demande ?? (lien.kind === "web-login" ? lien.secret : null);
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
        ? conseilSecret(pre)
        : errPw("secret_login_failed", "", { message: "The login fields could not be checked." });
    const champs = Array.isArray(pre["fields"]) ? pre["fields"] : [];
    const choix = await secretDeConnexion(s, pre["frame_origin"], nom);
    if ("refus" in choix) return choix.refus;
    const refus = refusTls(lien, choix.secret);
    if (refus !== null) return refus;
    const r = await resoudre(s.secrets ?? null, "web-login", pre["frame_origin"], choix.secret.name);
    if ("refus" in r) return r.refus;
    const tardif = refusTls(lien, { ...choix.secret, tls: r.valeur.tls });
    if (tardif !== null) return tardif;
    const brut = await client.req("POST", "/login", {
      json: {
        ...charge,
        secret_origin: pre["frame_origin"],
        username_value: champs.includes("username") ? (r.valeur.username ?? "") : "",
        password_value: champs.includes("password") ? r.valeur.secret : "",
      },
      timeout: DELAI_LOGIN_S,
    });
    const conseil = conseilSecret(brut);
    if (!estDict(conseil)) return conseil;
    return client.finishAct({ ...conseil, secret: r.valeur.name }, sid, true, 25);
  };
}
