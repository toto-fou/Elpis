// SPDX-License-Identifier: MIT
/** apps/core/src/relais/chemins.ts — préfixes relayés, URL amont depuis le chemin brut, en-têtes retenus et codes de fermeture (port de relay.py). */

export const RELAY_PREFIXES = [
  "/api/sandbox/",
  "/api/terminal/",
  "/ws/terminal",
  "/api/playwright/screenshot/",
  "/api/desktop/frame/",
] as const;

export const PREVIEW_PREFIXES = ["/api/sandbox/pv/", "/api/sandbox/pvs/"] as const;

export const CHEMIN_JETON_APERCU = "/api/sandbox/preview-token";

/** Chemins exacts servis par main sous un préfixe relayé. */
export const SERVIS_PAR_MAIN: readonly string[] = [CHEMIN_JETON_APERCU];

/** Chemins exacts dont la réponse réussie (POST) est enregistrée par main dans sa base. */
export const ENREGISTRES_PAR_MAIN: readonly string[] = ["/api/sandbox/me"];

/** En-têtes de réponse de l'hôte jamais retransmis (`_HOP_BY_HOP`). */
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** En-têtes du navigateur retransmis à l'hôte (`_FWD_REQ_HEADERS`) ; tout le reste est retiré, identité comprise. */
export const FWD_REQ_HEADERS: readonly string[] = [
  "accept",
  "content-type",
  "content-length",
  "range",
  "if-none-match",
  "if-modified-since",
  "last-event-id",
  "x-requested-with",
  "cache-control",
];

/** Chemin relayé vers l'hôte ; le jeton d'aperçu reste signé par main, qui le vérifie. */
export function isRelayedPath(chemin: string): boolean {
  return !SERVIS_PAR_MAIN.includes(chemin) && RELAY_PREFIXES.some((p) => chemin.startsWith(p));
}

export function isPreviewPath(chemin: string): boolean {
  return PREVIEW_PREFIXES.some((p) => chemin.startsWith(p));
}

const HEX2 = /^[0-9A-Fa-f]{2}$/u;
const DECODEUR_UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

export function estAscii(texte: string): boolean {
  for (let i = 0; i < texte.length; i++) if (texte.charCodeAt(i) > 0x7f) return false;
  return true;
}

/** `_unquote_impl` sur une suite ASCII : `%XX` en octet, tout `%` mal formé gardé tel quel. */
function octetsDeSuite(suite: string): Uint8Array {
  const morceaux = suite.split("%");
  const sortie: number[] = [...Buffer.from(morceaux[0] ?? "", "latin1")];
  for (const morceau of morceaux.slice(1)) {
    const deux = morceau.slice(0, 2);
    if (HEX2.test(deux)) {
      sortie.push(Number.parseInt(deux, 16), ...Buffer.from(morceau.slice(2), "latin1"));
    } else {
      sortie.push(0x25, ...Buffer.from(morceau, "latin1"));
    }
  }
  return Uint8Array.from(sortie);
}

/** `urllib.parse.unquote` (UTF-8, `errors="replace"`) : suites ASCII décodées une à une, le reste recopié. */
export function unquotePy(texte: string): string {
  if (!texte.includes("%")) return texte;
  let sortie = "";
  let debut = 0;
  while (debut < texte.length) {
    const ascii = texte.charCodeAt(debut) <= 0x7f;
    let fin = debut;
    while (fin < texte.length && texte.charCodeAt(fin) <= 0x7f === ascii) fin++;
    const suite = texte.slice(debut, fin);
    sortie += ascii && suite.includes("%") ? DECODEUR_UTF8.decode(octetsDeSuite(suite)) : suite;
    debut = fin;
  }
  return sortie;
}

/** `upstream_path` : chemin brut à relayer (sans requête), ou `null` s'il pourrait sortir des préfixes (`.`/`..` décodés, séparateur encodé). */
export function upstreamPath(entree: string): string | null {
  const brut = entree.split("?")[0] ?? "";
  const bas = brut.toLowerCase();
  if (bas.includes("%2f") || bas.includes("%5c") || brut.includes("\\")) return null;
  const decode = unquotePy(brut);
  if (decode.split("/").some((s) => s === "." || s === "..") || !isRelayedPath(decode)) return null;
  return brut;
}

/** Préfixe d'aperçu suivi du jeton d'un chemin décodé (`/api/sandbox/pv/<jeton>`), ou `null`. */
function racineApercu(chemin: string): string | null {
  const prefixe = PREVIEW_PREFIXES.find((p) => chemin.startsWith(p));
  return prefixe === undefined ? null : prefixe + (chemin.slice(prefixe.length).split("/")[0] ?? "");
}

/** `_upstream_url` : URL depuis le chemin BRUT, préfixe revérifié sur le chemin normalisé par `URL` ; un aperçu garde en plus son préfixe et son jeton. */
export function urlAmont(base: string, brut: string, requete: string, apercu = false): URL | null {
  const chemin = upstreamPath(brut);
  if (chemin === null) return null;
  const url = new URL(base + chemin + (requete ? `?${requete}` : ""));
  const final = unquotePy(url.pathname);
  if (!isRelayedPath(final)) return null;
  const racine = apercu ? racineApercu(unquotePy(chemin)) : null;
  return !apercu || (racine !== null && racineApercu(final) === racine) ? url : null;
}

export function wsUrl(url: string): string {
  if (url.startsWith("https://")) return "wss://" + url.slice("https://".length);
  if (url.startsWith("http://")) return "ws://" + url.slice("http://".length);
  return url;
}

/** Code de fermeture de l'hôte rendu au navigateur ; les codes réservés (1005, 1006…) ne passent pas dans une trame : 1011. */
export function codeFermeture(code: number): number {
  const valide =
    (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
  return valide ? code : 1011;
}

/** `reason[:120]` (points de code), puis borné aux 123 octets qu'une trame de fermeture peut porter. */
export function raisonFermeture(raison: string): string {
  let points = Array.from(raison).slice(0, 120);
  while (Buffer.byteLength(points.join(""), "utf8") > 123) points = points.slice(0, -1);
  return points.join("");
}

/** En-têtes du navigateur retenus pour l'hôte, depuis `rawHeaders` : le dernier l'emporte, comme le dict de Python. */
export function entetesRequete(rawHeaders: readonly string[]): Record<string, string> {
  const retenus: Record<string, string> = {};
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const nom = (rawHeaders[i] ?? "").toLowerCase();
    if (FWD_REQ_HEADERS.includes(nom)) retenus[nom] = rawHeaders[i + 1] ?? "";
  }
  return retenus;
}

/** En-têtes de réponse de l'hôte sans les hop-by-hop, dans l'ordre et doublons compris, plus `x-accel-buffering: no`. */
export function entetesReponse(rawHeaders: readonly string[]): Map<string, string[]> {
  const garde = new Map<string, string[]>();
  const ajouter = (nom: string, valeur: string): void => {
    const deja = garde.get(nom);
    if (deja) deja.push(valeur);
    else garde.set(nom, [valeur]);
  };
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const nom = (rawHeaders[i] ?? "").toLowerCase();
    if (!HOP_BY_HOP.has(nom)) ajouter(nom, rawHeaders[i + 1] ?? "");
  }
  ajouter("x-accel-buffering", "no");
  return garde;
}
