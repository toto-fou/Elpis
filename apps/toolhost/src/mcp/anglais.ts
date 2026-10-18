// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/anglais.ts — textes de l'agent du bac, du bac et du relais Git rendus en anglais au modèle par les familles shell et git (harnais B-13) ; l'interface garde les textes français. */
import { estErreurAgent } from "@elpis/bac";
import { AgentError, RelayRefused } from "@elpis/fichiers";

/** Texte anglais d'un code de refus de l'agent du bac. */
const CODES_AGENT: Readonly<Record<string, string>> = {
  not_found: "not found",
  outside_root: "a link leads outside /work",
  denied: "permission denied",
  is_dir: "is a directory",
  not_dir: "not a directory",
  not_file: "not a regular file",
  exists: "already exists",
  changed: "changed in the meantime",
  too_large: "too large",
  bad_path: "invalid path",
  bad_request: "invalid request to the sandbox agent",
  bad_regex: "invalid regular expression",
  timeout: "timed out",
  agent_unavailable: "sandbox agent unavailable",
  container_down: "sandbox container is not running",
  exec_failed: "the program could not be started",
  io_error: "I/O error",
  bad_response: "malformed response from the sandbox agent",
  internal: "internal error of the sandbox agent",
  inside: "one path is inside the other",
};

/** Messages français du bac et du relais Git (forme exacte), leur version anglaise. */
const MESSAGES: readonly (readonly [RegExp, string | ((...m: string[]) => string)])[] = [
  [/^Container (\S+) n'a pas pu démarrer$/mu, "container $1 could not start"],
  [/^docker run a échoué : /mu, "docker run failed: "],
  [/^Dossier de l'agent (.*?) : /mu, "sandbox agent folder $1: "],
  [/^Dossier du relais Git (.*?) : /mu, "Git relay folder $1: "],
  [/^Image '([^']*)' indisponible\. /mu, "image '$1' unavailable. "],
  [
    /^Le chargement de l'image '([^']*)' est toujours en cours \((.*)\)\. Réessayez dans quelques instants\.$/mu,
    "image '$1' is still loading ($2); retry in a moment.",
  ],
  [/^Container a crashé au démarrage \(état=(.*)\)\.$/mu, "container crashed at startup (state=$1)."],
  [/^(\S+) : conteneur arrêté, \/work non vidé$/mu, "$1: container stopped, /work not emptied"],
  [/^(\S+) : \/work non vidé : /mu, "$1: /work not emptied: "],
  [/^Agent non démarré dans (\S+) : /mu, "sandbox agent not started in $1: "],
  [
    /^image (\S+) absente : le conteneur de la sandbox date d'une version précédente.*$/mu,
    "image $1 missing: the sandbox container comes from a previous version and cannot be recreated yet (files, editor and git unavailable); the administrator must build or load the sandbox image.",
  ],
  [/^Remote « (.*) » introuvable$/mu, "remote '$1' not found"],
  [
    /^Remote « (.*) » : plusieurs URL, non prises en charge par le relais$/mu,
    "remote '$1' has several URLs, which the relay does not support",
  ],
  [/^Dépôt refusé \(anti-SSRF\) : /mu, "repository refused (SSRF protection): "],
  [/^URL de dépôt mal formée$/mu, "malformed repository URL"],
  [
    /^URL de dépôt invalide \(identifiants, requête ou hôte\)$/mu,
    "invalid repository URL (credentials, query or host)",
  ],
  [/^Chemin de dépôt invalide$/mu, "invalid repository path"],
  [
    /^Schéma « (.*) » : seul Git sur HTTP\(S\) passe par le relais\.$/mu,
    "scheme '$1': only Git over HTTP(S) goes through the relay.",
  ],
  [/Relais Git : corps de push tronqué/gu, "Git relay: truncated push body"],
  [/Relais Git : push signé ou mal formé, non relayé/gu, "Git relay: signed or malformed push, not relayed"],
  [/Relais Git : push mal formé/gu, "Git relay: malformed push"],
  [/Relais Git : suppression de (\S+) refusée/gu, "Git relay: deletion of $1 refused"],
  [
    /Relais Git : push vers (\S+) hors de l'opération autorisée/gu,
    "Git relay: push to $1 is outside the authorized operation",
  ],
  [
    /Relais Git : requête hors de l'opération autorisée/gu,
    "Git relay: request outside the authorized operation",
  ],
  [/Relais Git : dépôt refusé \(/gu, "Git relay: repository refused ("],
  [/Relais Git : push compressé non relayé/gu, "Git relay: compressed push not relayed"],
  [/Relais Git : amont injoignable \(/gu, "Git relay: upstream unreachable ("],
  [/Relais Git : autorité de certification illisible \(/gu, "Git relay: unreadable certificate authority ("],
  [
    /Relais Git : l'amont redirige \((\d+)(?: vers ([^)]*))?\) ; corrigez l'URL du remote/gu,
    (_m, statut: string, cible?: string) =>
      `Git relay: the upstream redirects (${statut}${cible ? ` to ${cible}` : ""}); fix the remote URL`,
  ],
];

/** Message système (`strerror`) gardé tel quel : phrase anglaise à majuscule initiale, sans mot français. */
const STRERROR = /^[A-Z][A-Za-z ,'-]*$/u;
const FRANCAIS = /\b(?:invalide|requis|introuvable|refusée?|attendue?|trop|absent|inconnue?)\b/iu;

/** Texte du bac ou du relais mis en anglais (messages connus, ailleurs inchangé). */
export function enAnglais(texte: string): string {
  return MESSAGES.reduce((x, [re, par]) => x.replace(re, par as string), texte);
}

/** Message anglais d'un refus de l'agent : `strerror` du système, sinon texte du code, sinon vide. */
export function agentEnAnglais(code: string, message = ""): string {
  if (STRERROR.test(message) && !FRANCAIS.test(message)) return message;
  return CODES_AGENT[code] ?? "";
}

/** `str(e)` pour le modèle : `code: texte` anglais d'une panne de l'agent, refus du relais ou panne du bac en anglais. */
export function strErreurAnglais(e: unknown): string {
  if (e instanceof RelayRefused) return `${e.code}: ${enAnglais(e.message)}`;
  if (e instanceof AgentError || estErreurAgent(e)) {
    const t = agentEnAnglais(e.code, e.message);
    return t ? `${e.code}: ${t}` : e.code;
  }
  return enAnglais(e instanceof Error ? e.message : String(e));
}
