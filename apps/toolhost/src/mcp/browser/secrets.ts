// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/secrets.ts — secrets du coffre pour les outils pw_* : enveloppe de l'appel (compte, conversation, sous-agent) du seul client de confiance, recherche sans valeur et résolution par le core ; refus `secret_*` du coffre et de la connexion rendus en anglais dans le vocabulaire des outils, jamais une valeur. */
import { estDict } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { errPw } from "@elpis/navigateur";
import { getAccessToken } from "@elpis/outils-mcp";
import { current } from "@elpis/securite";

import type { AppelSigne, ReponseCoffre, SecretApplicable, SecretResolu } from "../../rappel";

/** Ce que les outils pw_* demandent au core (`ClientRappel`). */
export interface PortSecrets {
  readonly actif: boolean;
  resoudreSecret(
    appel: AppelSigne,
    demande: { usage: "web-login" | "http-auth"; origin: string; name?: string | null },
  ): Promise<ReponseCoffre<SecretResolu>>;
  secretsApplicables(
    appel: AppelSigne,
    demande: { origin: string; name?: string | null },
  ): Promise<ReponseCoffre<SecretApplicable[]>>;
  declencheur(appel: AppelSigne, name: string): Promise<ReponseCoffre<boolean>>;
}

/** Refus d'un secret `http-auth` sans nom d'utilisateur (aucune résolution, aucun usage compté). */
export const SANS_IDENTIFIANT = (nom: string): string =>
  `Secret '${nom}' has no user name: HTTP authentication needs one.`;

export const FIX_SECRET =
  "Ask the user to attach the secret to this conversation with /secret attach <name>; never ask for a password in the chat.";

/** Correctif d'un refus du coffre (message du core gardé), par code ; à défaut, `FIX_SECRET`. */
const FIX_COFFRE: Readonly<Record<string, string>> = {
  secret_unknown:
    "Use a name listed in the <secrets> block, or ask the user to attach the secret with /secret attach <name>; never ask for a password in the chat.",
  secret_type_mismatch:
    "pw_login uses a web-login secret; an http-auth secret is applied by pw_session(action='start', url=..., secret=...).",
  secret_unverified:
    "Ask the user to verify this imported secret in Settings › Secrets, then retry; never ask for the password in the chat.",
  secret_scope_mismatch:
    "This secret only applies to the origins listed in the <secrets> block: open a page of one of them, or ask the user to add this origin to the secret.",
  secret_ambiguous: 'Pass secret="<name>", one of the names listed.',
  secret_undecryptable:
    "The vault cannot use this secret: tell the user (they may need to enter it again in Settings › Secrets) and continue without logging in.",
  secret_key_unavailable:
    "The vault key is unavailable: tell the user that an administrator must check the vault, and continue without logging in.",
  secret_username_required:
    "Ask the user to add the user name of this secret in Settings › Secrets; never ask for it or for a password in the chat.",
};

/** Refus du service propres à `pw_login` (pré-contrôle et connexion), dans le vocabulaire des outils. */
const CONSEILS_CONNEXION: Readonly<Record<string, string>> = {
  secret_scope_mismatch:
    "Log in only on a page of the secret's own origin, not inside a frame embedded by another site, with a form that posts to that origin: open that login page itself with pw_session(action='start', url=..., secret=...), then call pw_login. If the site's form posts elsewhere, tell the user; do not retry on this page.",
  secret_target_required:
    "Let pw_login detect the fields, or pass username_target, password_target and submit_target as semantic targets (label=..., placeholder=..., role=...|name=...) or refs from pw_find, each matching one visible field; the password field must be an <input type=password> that keeps the focus while it is typed into.",
  secret_login_failed:
    "Look at the page (pw_page action='inspect'). If the site refused the login, tell the user: the secret may be wrong or expired (they can update it in Settings › Secrets). Do not retry in a loop.",
  secret_recording_active:
    "A trace stops with pw_session(action='trace_export', session_id=...): export it, then call pw_login again. A HAR records until its session is closed: open the login page in a session started without record_har (pw_session(action='start', url=..., secret=...)) and log in there.",
};

/** Refus `secret_*` rendu au modèle. */
export function refusSecret(code: string, message: string, fix: string = FIX_SECRET): Dict {
  return errPw(code, "", { message, fix });
}

/** Session sécurisée fermée par le service sur un déclencheur (`secret_session_closed`) : le core détache le secret de la conversation et journalise le refus ; erreur rendue au modèle. */
export async function declencheurSecret(port: PortSecrets | null, nom: string | null): Promise<Dict> {
  const appel = appelSigne();
  const r =
    nom !== null && port !== null && port.actif && appel !== null ? await port.declencheur(appel, nom) : null;
  const qui = nom === null ? "The secret" : `Secret '${nom}'`;
  const suite =
    r !== null && r.ok
      ? r.valeur
        ? `${qui} was detached from this conversation for safety.`
        : `${qui} is not attached to this conversation.`
      : `The vault could not be told: ask the user to detach ${nom === null ? "the secret" : `'${nom}'`} (/secret detach <name>).`;
  return errPw("secret_session_closed", "", {
    message: `The browser service closed this secure session (tripwire): the secret was about to be exposed. ${suite}`,
    fix: "Do not retry the login. Tell the user what happened: they can check the site, then attach the secret again with /secret attach <name>.",
    session_closed: true,
  });
}

/** Refus `secret_*` du service navigateur pour `pw_login`, dans le vocabulaire des outils ; tout autre résultat est rendu tel quel. */
export function conseilSecret(r: unknown): unknown {
  if (!estDict(r) || r["ok"] !== false || typeof r["error"] !== "string") return r;
  const fix = Object.hasOwn(CONSEILS_CONNEXION, r["error"]) ? CONSEILS_CONNEXION[r["error"]] : undefined;
  return fix === undefined ? r : { ...r, fix };
}

/** Refus hors d'une conversation de l'application (client externe, stdio, sans conversation signée). */
export const HORS_APPLICATION = refusSecret(
  "secret_not_attached",
  "Secrets are only usable from an Elpis conversation they are attached to.",
);

/** Enveloppe de l'appel en cours : compte et conversation de l'identité vérifiée ; `null` hors de l'application (client externe, stdio) ou sans conversation. */
export function appelSigne(): AppelSigne | null {
  if (getAccessToken()?.claims["trusted_meta"] !== true) return null;
  const id = current();
  if (id === null || id.user_id <= 0 || !id.username || !id.chat_id) return null;
  return { user_id: id.user_id, username: id.username, chat_id: id.chat_id, subagent: id.subagent ?? null };
}

/** Réponse du coffre en valeur, ou son refus rendu au modèle. */
function lue<T>(r: ReponseCoffre<T>): { valeur: T } | { refus: Dict } {
  if (r === null)
    return {
      refus: refusSecret(
        "secret_unavailable",
        "The vault did not answer: no secret can be used right now.",
        "Retry in a moment, or continue without logging in.",
      ),
    };
  return r.ok
    ? { valeur: r.valeur }
    : {
        refus: refusSecret(
          r.code,
          r.message,
          Object.hasOwn(FIX_COFFRE, r.code) ? FIX_COFFRE[r.code] : FIX_SECRET,
        ),
      };
}

/** Secrets attachés à la conversation qui couvrent `origine` (ou le secret `nom`, contrôlé), sans valeur ; `null` hors de l'application. */
export async function applicables(
  port: PortSecrets | null,
  origine: string,
  nom: string | null,
): Promise<{ valeur: SecretApplicable[] } | { refus: Dict } | null> {
  const appel = appelSigne();
  if (port === null || !port.actif || appel === null)
    return nom === null ? null : { refus: HORS_APPLICATION };
  return lue(await port.secretsApplicables(appel, { origin: origine, name: nom }));
}

/** Valeur d'un secret pour `origine` (par son nom, sinon le seul qui la couvre) : SECRET, passé au service navigateur et oublié. */
export async function resoudre(
  port: PortSecrets | null,
  usage: "web-login" | "http-auth",
  origine: string,
  nom: string | null,
): Promise<{ valeur: SecretResolu } | { refus: Dict }> {
  const appel = appelSigne();
  if (port === null || !port.actif || appel === null) return { refus: HORS_APPLICATION };
  return lue(await port.resoudreSecret(appel, { usage, origin: origine, name: nom }));
}
