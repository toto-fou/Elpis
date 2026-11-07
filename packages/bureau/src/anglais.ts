// SPDX-License-Identifier: MIT
/** packages/bureau/src/anglais.ts — textes français des résultats desktop_* rendus en anglais au modèle (l'interface et les routes gardent le français). */
import type { Dict } from "@elpis/commun";

type Remplacement = string | ((...m: string[]) => string);

const REGLES: readonly (readonly [RegExp, Remplacement])[] = [
  [/^0 élément renvoyé$/u, "0 elements returned"],
  [/^annotation vision KO : /u, "vision annotation failed: "],
  [
    /^arbre a11y tronqué à (\d+) nœuds \(plafond atteint\) : des éléments profonds peuvent manquer$/u,
    "a11y tree truncated at $1 nodes (cap reached): deep elements may be missing",
  ],
  [/^lecture du texte KO : /u, "text read failed: "],
  [/^« (.*) » correspond à (\d+) éléments distincts$/su, '"$1" matches $2 distinct elements'],
  [
    /^l'écran a changé depuis la capture affichée — la cible a peut-être bougé ; le stage a été rafraîchi, vise à nouveau$/u,
    "the screen changed since the displayed capture - the target may have moved; the stage was refreshed, aim again",
  ],
  [
    /^ce contrôle n'expose peut-être pas ce pattern — réessaie en clic simple op="click" sur son element_id, ou desktop_observe puis cible par auto_id$/u,
    'this control may not expose that pattern - retry with a plain op="click" on its element_id, or desktop_observe then target by auto_id',
  ],
  [
    /^actionné en clic-coordonnées \(pas de control pattern a11y sur cette cible — p\.ex\. Linux\/AT-SPI ou élément vision\)$/u,
    "performed as a coordinate click (no a11y control pattern on this target - e.g. Linux/AT-SPI or vision element)",
  ],
  [
    /^le texte a été émis mais l'écran n'a pas changé — la frappe n'a probablement pas atterri \(zone de saisie non focalisée ou fenêtre en arrière-plan\)$/u,
    "the text was sent but the screen did not change - the keystrokes probably did not land (input field not focused or window in the background)",
  ],
  [
    /^clique d'abord dans la zone de saisie \(desktop_act op="click" sur son element_id\), ou cible le champ par op="set_value", puis réessaie$/u,
    'first click into the input field (desktop_act op="click" on its element_id), or target the field with op="set_value", then retry',
  ],
  [
    /^lancé mais aucune nouvelle fenêtre détectée dans (\d+) ms — l'appli est peut-être déjà ouverte ou son activation est lente ; confirme avec /u,
    "launched but no new window detected within $1 ms - the app may already be open or slow to activate; confirm with ",
  ],
  [
    /^window_id \(hwnd\) requis — lister via desktop_windows$/u,
    "window_id (hwnd) required - list via desktop_windows",
  ],
  [/endpoint LLM injoignable \(/u, "LLM endpoint unreachable ("],
  [/endpoint injoignable \(/u, "endpoint unreachable ("],
  [/endpoint LLM → HTTP /u, "LLM endpoint -> HTTP "],
  [
    /réponse LLM inattendue \(pas un chat\/completions \?\)$/u,
    "unexpected LLM response (not a chat/completions?)",
  ],
  [
    /^le modèle n'a renvoyé aucune box exploitable \(ni JSON, ni tags <box>\)$/u,
    "the model returned no usable box (neither JSON nor <box> tags)",
  ],
  [
    /^endpoint → HTTP (\d+) — un serveur llama\.cpp se configure avec le format « LLM multimodal », pas un format détecteur dédié$/u,
    "endpoint -> HTTP $1 - a llama.cpp server is configured with the 'multimodal LLM' format, not a dedicated detector format",
  ],
  [/réponse non-JSON de l'endpoint$/u, "non-JSON response from the endpoint"],
  [
    /^réponse 200 mais aucune box parsée \(format=(.*), clés=(.*)\) — voir vision\.response_map$/su,
    "200 response but no box parsed (format=$1, keys=$2) - see vision.response_map",
  ],
  [/endpoint vision non configuré$/u, "vision endpoint not configured"],
  [
    /^script vide : passe ``code`` ou enregistre (.*) dans la sandbox$/u,
    "empty script: pass ``code`` or save $1 in the sandbox",
  ],
  [
    /^budget par cible ramené de (\d+) s à (\d+) s \(plafond de l'outil (\d+) s pour (\d+) cible\(s\)\)$/u,
    "per-target budget reduced from $1 s to $2 s (tool cap $3 s for $4 target(s))",
  ],
  [/^cible inconnue : « (.*) »$/su, 'unknown target: "$1"'],
  [/^dépôt refusé$/u, "upload refused"],
  [/^plafond de la matrice atteint \((\d+) s\)$/u, "matrix cap reached ($1 s)"],
  [/^exécution interrompue après (\d+) s$/u, "execution interrupted after $1 s"],
  [/^suivi perdu \((.*)\) — exécution arrêtée$/su, "tracking lost ($1) - execution stopped"],
  [/^état inconnu$/u, "unknown state"],
  [/^(\d+)\/(\d+) cible\(s\) réussie\(s\)$/u, "$1/$2 target(s) succeeded"],
  [/^anchor_unresolved \(budget self-heal épuisé\)$/u, "anchor_unresolved (self-heal budget exhausted)"],
];

const CLES = new Set([
  "message",
  "note",
  "hint",
  "fix",
  "summary",
  "error",
  "erreur",
  "error_detail",
  "next_action",
]);
const REGIONS: Readonly<Record<string, string>> = {
  "plein écran": "full screen",
  "zone fournie": "provided region",
};

/** Texte français connu mis en anglais, sinon inchangé. */
export function texteBureauEnAnglais(t: string): string {
  return REGLES.reduce((x, [re, par]) => x.replace(re, par as string), t);
}

/** Copie du résultat d'outil dont les textes connus (message, note, fix, hint…) sont en anglais. */
export function resultatBureauEnAnglais<T>(v: T, cle = ""): T {
  if (typeof v === "string") {
    if (cle === "region") return (REGIONS[v] ?? v) as T;
    return (CLES.has(cle) ? texteBureauEnAnglais(v) : v) as T;
  }
  if (Array.isArray(v)) return v.map((x) => resultatBureauEnAnglais(x, cle)) as T;
  if (v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const sortie: Dict = {};
    for (const [k, x] of Object.entries(v as Dict)) sortie[k] = resultatBureauEnAnglais(x, k);
    return sortie as T;
  }
  return v;
}
