// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/secrets.ts — secrets du coffre pour les outils pw_* : enveloppe de l'appel (compte, conversation, sous-agent) du seul client de confiance, recherche sans valeur et résolution par le core ; refus `secret_*` en anglais, jamais une valeur. */
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
}

export const FIX_SECRET =
  "Ask the user to attach the secret to this conversation with /secret attach <name>; never ask for a password in the chat.";

/** Refus `secret_*` rendu au modèle. */
export function refusSecret(code: string, message: string, fix: string = FIX_SECRET): Dict {
  return errPw(code, "", { message, fix });
}

const HORS_APPLICATION = refusSecret(
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
  return r.ok ? { valeur: r.valeur } : { refus: refusSecret(r.code, r.message) };
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
