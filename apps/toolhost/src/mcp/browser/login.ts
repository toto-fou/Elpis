// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/login.ts — `pw_login` : connexion atomique avec un jeton `⟦creds:…⟧` (pré-contrôle sans valeur, résolution du jeton, saisie, soumission et vidage de la page en une requête au service). */
import { estDict, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { buildLocatorPayload, errPw } from "@elpis/navigateur";
import type { ContexteAppel } from "@elpis/outils-mcp";

import { ouvrirAppel } from "./appel";
import type { ServicesBrowser } from "./appel";
import { jetonSeul, nettoyerResultat, resoudreSecrets } from "./creds";

const CLES_CIBLE = [
  "ref",
  "by_role",
  "by_name",
  "by_text",
  "by_label",
  "by_placeholder",
  "by_test_id",
  "by_css",
  "by_xpath",
  "by_alt",
  "by_title",
  "nth",
] as const;

/** Cible DSL → clés du service (`by_*`, `ref`, `nth`) ; `null` si la cible est vide. */
function cible(dsl: unknown): Dict | null {
  if (typeof dsl !== "string" || !dsl.trim()) return null;
  const [charge] = buildLocatorPayload({ target: dsl });
  const sortie: Dict = {};
  for (const k of CLES_CIBLE) if (veritePy(charge[k]) || charge[k] === 0) sortie[k] = charge[k];
  return Object.keys(sortie).length > 0 ? sortie : null;
}

const FIX_CREDS = "ask the user to supply a login with the /creds command; never ask for a password in clear";

/** `pw_login` : l'ordre est fixe (pré-contrôle sans valeur, résolution du jeton sur l'origine du frame, saisie) ; le modèle ne reprend la main qu'après le vidage de la page. */
export function pwLogin(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const o = await ouvrirAppel(ctx, s, a["session_id"]);
    if (o.refus !== null) return o.refus;
    const { client } = o.appel;
    const sid = a["session_id"] as string;
    const jeton = jetonSeul(a["creds"]);
    if (jeton === null)
      return errPw("creds_invalid", "", {
        message: "creds= takes the TOKEN of a ⟦creds:TOKEN@ORIGIN⟧ supplied by the user",
        fix: FIX_CREDS,
      });
    const motDePasse = cible(a["password_target"]);
    const identifiant = cible(a["username_target"]);
    if (motDePasse === null && identifiant === null)
      return errPw("login_target_required", "", {
        message: "pw_login needs password_target and/or username_target",
        fix: "pw_login(session_id, creds='TOKEN', username_target='label=Email', password_target='label=Password', submit_target='role=button|name=Sign in')",
      });
    const charge: Dict = { session_id: sid, timeout: 8000 };
    if (identifiant !== null) charge["username_target"] = identifiant;
    if (motDePasse !== null) charge["password_target"] = motDePasse;
    const envoi = cible(a["submit_target"]);
    if (envoi !== null) charge["submit_target"] = envoi;
    const attente = cible(a["wait_for"]);
    if (attente !== null) charge["wait_for"] = attente;
    // 1. Pré-contrôle SANS valeur : session sécurisée, champs visibles uniques, types réels, formulaire, origine du frame.
    const pre = await client.req("POST", "/login_precheck", { json: charge });
    if (!estDict(pre) || pre["ok"] !== true || typeof pre["frame_origin"] !== "string")
      return estDict(pre)
        ? pre
        : errPw("login_precheck_failed", "", { message: "the fields could not be checked" });
    // 2. Seulement si tout passe : résolution du jeton (un usage), sur l'origine du frame.
    const refs = [
      ...(identifiant !== null ? [`${jeton}.username`] : []),
      ...(motDePasse !== null ? [`${jeton}.password`] : []),
    ];
    const r = await resoudreSecrets(s, ctx, refs, { expectOrigin: pre["frame_origin"] });
    if ("refus" in r) return r.refus;
    const valeur = (champ: string) => r.secrets.find((x) => x.champ === champ);
    const iden = valeur("username");
    const mdp = valeur("password");
    const origine = (iden ?? mdp)?.origine ?? pre["frame_origin"];
    // 3. Saisie, soumission, attente, vidage : une seule requête au service.
    const brut = await client.req("POST", "/login", {
      json: {
        ...charge,
        username_value: iden?.valeur ?? "",
        password_value: mdp?.valeur ?? "",
        secret_origin: origine,
        timeout: 8000,
      },
      // Budget de la saisie (40 s) + remplacement des documents (15 s) + marge.
      timeout: Math.max(client.delaiS, 75),
    });
    const resultat = nettoyerResultat(brut, r.secrets);
    return nettoyerResultat(
      await client.finishAct(resultat, sid, a["observe"] as boolean, a["max_items"]),
      r.secrets,
    );
  };
}
