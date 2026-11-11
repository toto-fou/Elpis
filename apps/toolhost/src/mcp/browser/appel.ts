// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/appel.ts — appel d'un outil pw_* : compte, refus d'une session d'autrui ou, pour un sous-agent, d'une session ouverte pour un secret qui exclut les sous-agents, client du service au propriétaire du compte, mémoire AX de la base de l'hôte. */
import { estDict, intPy, lowerPy, nomTypePy, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";
import {
  ClientNavigateur,
  pwOwner,
  pwOwnerEnfant,
  rappelOnglet,
  refusSessionDAutrui,
} from "@elpis/navigateur";
import { getUsername } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { current, lireSousAgent } from "@elpis/securite";
import type { SousAgentHote } from "@elpis/securite";

import type { Journal } from "../../journal";
import { liaison } from "./liaisons";
import { refusSecret } from "./secrets";
import type { PortSecrets } from "./secrets";

/** Services d'un outil pw_* : base AX de l'hôte (`null` = mémoire AX éteinte, `_AX_ENABLED` faux), journal, coffre du core (absent : sessions ordinaires seulement). */
export interface ServicesBrowser {
  readonly ax: () => Base | null;
  readonly journal: Journal;
  readonly secrets?: PortSecrets | null;
}

/** Rôle de l'appelant vis-à-vis du navigateur : le chat (session du compte), un sous-agent à session isolée (la sienne seule), un sous-agent sur la session du compte. */
export type PorteeNavigateur = "compte" | "isolee" | "compte-delegue";

export interface Appel {
  readonly username: string;
  readonly client: ClientNavigateur;
  readonly ax: Base | null;
  readonly portee: PorteeNavigateur;
}

/** Sous-agent de l'appel (identité vérifiée, sinon `_meta`) ; `null` pour le chat. */
export function sousAgentDe(ctx: ContexteAppel): SousAgentHote | null {
  return current()?.subagent ?? lireSousAgent(ctx.meta?.["subagent"]);
}

/** Propriétaire que le service voit : le compte, ou l'empreinte de l'enfant à session isolée (ses sessions, son quota et son nettoyage ne touchent jamais ceux du compte ni d'un frère). */
export function proprietaireDe(
  username: string,
  sa: SousAgentHote | null,
): { owner: string; portee: PorteeNavigateur } {
  if (sa === null) return { owner: pwOwner(username), portee: "compte" };
  if (sa.browser_session === "user") return { owner: pwOwner(username), portee: "compte-delegue" };
  return { owner: pwOwnerEnfant(username, sa.id), portee: "isolee" };
}

/** `_refus_session_d_autrui` en tête de chaque outil : refus (session inconnue ou d'un autre compte ; session ouverte pour un secret dont la politique exclut les sous-agents, pour un sous-agent), ou l'appel au propriétaire du compte, ou de l'enfant isolé. */
export async function ouvrirAppel(
  ctx: ContexteAppel,
  s: ServicesBrowser,
  sessionId: unknown,
): Promise<{ refus: Dict } | { refus: null; appel: Appel }> {
  const username = getUsername(ctx);
  const refus = await refusSessionDAutrui(sessionId, username);
  if (refus !== null) return { refus };
  const sa = sousAgentDe(ctx);
  const { owner, portee } = proprietaireDe(username, sa);
  const lien = sa !== null && typeof sessionId === "string" ? liaison(owner, sessionId) : undefined;
  if (lien !== undefined && !lien.sousAgents)
    return {
      refus: refusSecret(
        "secret_not_attached",
        `This browser session was opened for secret '${lien.secret}', which sub-agents may not use.`,
        "Leave this session to the main conversation and return your report; the user can allow sub-agents in the secret's policy (Settings › Secrets).",
      ),
    };
  return {
    refus: null,
    appel: {
      username,
      client: new ClientNavigateur({ owner }),
      ax: s.ax(),
      portee,
    },
  };
}

/** Réglage entier de l'environnement lu à l'appel (`int(os.environ.get(nom, défaut))`). */
export function entierEnv(nom: string, defaut: string): number {
  return intPy(process.env[nom] ?? defaut);
}

/** Entier validé borné à [bas, haut] (`max(bas, min(int(v), haut))`). */
export function borne(v: unknown, bas: number, haut: number): number {
  return Math.max(bas, Math.min(Number(v), haut));
}

/** `d.get(k) or d.get(k2) or …` sur un dictionnaire, `""` à défaut. */
export function ouChamps(d: Dict, ...cles: string[]): unknown {
  for (const k of cles) if (veritePy(d[k])) return d[k];
  return "";
}

/** `(v or "").lower()` de Python : une valeur non textuelle lève comme l'AttributeError. */
export function minusculesPy(v: unknown): string {
  if (!veritePy(v)) return "";
  if (typeof v !== "string") throw new TypeError(`'${nomTypePy(v)}' object has no attribute 'lower'`);
  return lowerPy(v);
}

/** URL de la page après l'action : `url` ou `current_url` du résultat, sinon celle du service. */
export async function urlApres(
  client: ClientNavigateur,
  resultat: unknown,
  sessionId: string,
): Promise<unknown> {
  const u = estDict(resultat) ? ouChamps(resultat, "url", "current_url") : "";
  return veritePy(u) ? u : client.axGetCurrentUrl(sessionId);
}

/** Délai dépassé sur une session à plusieurs onglets : l'onglet actif rappelé (lu sur `/sessions`, qui ne prend pas le verrou de la session occupée). */
export async function rappelOngletActif(
  client: ClientNavigateur,
  sessionId: string,
  resultat: unknown,
): Promise<unknown> {
  if (!estDict(resultat) || resultat["ok"] !== false) return resultat;
  const message = strPy(resultat["message"] ?? "");
  if (
    !/timeout/iu.test(`${strPy(resultat["error"] ?? "")} ${message}`) ||
    message.includes("Actions run on tab")
  )
    return resultat;
  const liste = await client.req("GET", "/sessions");
  const sessions = estDict(liste) && Array.isArray(liste["sessions"]) ? (liste["sessions"] as unknown[]) : [];
  const s = sessions.find((x) => estDict(x) && x["session_id"] === sessionId);
  if (!estDict(s) || !(Number(s["tabs"]) > 1)) return resultat;
  const indice = `Actions run on tab index ${strPy(s["active_tab"])} of ${strPy(s["tabs"])} tabs (${strPy(s["url"])}): pw_page(action="tabs") lists them, pw_page(action="tab_switch", index=N) switches.`;
  return {
    ...resultat,
    ...rappelOnglet({ tab_hint: indice, active_tab: s["active_tab"], total_tabs: s["tabs"] }, message),
  };
}
