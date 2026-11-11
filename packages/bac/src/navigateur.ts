// SPDX-License-Identifier: MIT
/** packages/bac/src/navigateur.ts — navigateur dans le bac : mode par compte (`browser.mode`, `browser.sandbox_users`), montages en lecture seule (service, runtime Node, headless shell), chemins dans le conteneur et script de démarrage. */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { config, liveConfigValue, pyJoin, racineDepot, realpathPy } from "@elpis/config";

/** Socket du service navigateur dans le conteneur (dossier de l'agent, `<P>/.elpis-agent` sur l'hôte). */
export const BROWSER_SOCKET = "/run/elpis/browser.sock";
/** Socket du relais des secrets de l'hôte, ouvert par l'hôte d'outils dans le même dossier. */
export const BROWSER_RELAY_SOCKET = "/run/elpis/browser-relay.sock";
/** Certificat (seul) de l'autorité du relais, posé par l'hôte d'outils. */
export const BROWSER_CA_CERT = "/run/elpis/browser-ca.crt";
/** Données du service dans le bac : captures, états, HAR, traces, vidéos, profil NSS, journal. */
export const BROWSER_DATA = "/work/.elpis-browser";
/** Téléchargements du navigateur, visibles de l'utilisateur. */
export const BROWSER_DOWNLOADS = "/work/downloads";
/** Noms, sur l'hôte, dans `<P>/.elpis-agent` (monté sur /run/elpis). */
export const NOMS_HOTE = {
  socket: "browser.sock",
  relais: "browser-relay.sock",
  ca: "browser-ca.crt",
} as const;

/** Destinations des montages (lecture seule). */
export const MONTAGES_NAVIGATEUR = {
  service: "/opt/elpis/browser-service",
  modules: "/opt/elpis/node_modules",
  node: "/opt/elpis/node",
  playwright: "/opt/elpis/ms-playwright",
} as const;

/** Surcharges de test des sources des montages (`null` : celles de l'installation). */
export const reglagesNavigateurBac: {
  service: string | null;
  node: string | null;
  playwright: string | null;
} = { service: null, node: null, playwright: null };

/** Mode du navigateur pour un compte : « sandbox » si `browser.mode` l'est et que `browser.sandbox_users` (vide = tous, « * ») le nomme. */
export function navigateurDansLeBac(username: string | null | undefined): boolean {
  const mode = String(liveConfigValue("browser.mode", "central") ?? "central")
    .trim()
    .toLowerCase();
  if (mode !== "sandbox") return false;
  const brut = liveConfigValue("browser.sandbox_users", []);
  const liste = Array.isArray(brut) ? brut.map((x) => String(x).trim()).filter(Boolean) : [];
  return liste.length === 0 || liste.includes("*") || liste.includes(String(username ?? ""));
}

function dossier(p: string): string | null {
  try {
    const r = realpathPy(p);
    return statSync(r).isDirectory() ? r : null;
  } catch {
    return null;
  }
}

/** Sources des montages : `browser-service/` du dépôt (et ses modules s'ils sont ailleurs), runtime Node de l'installation, cache Playwright. */
export function sourcesNavigateur(): {
  service: string | null;
  modules: string | null;
  node: string | null;
  playwright: string | null;
} {
  const service = dossier(reglagesNavigateurBac.service ?? pyJoin(racineDepot(), "browser-service"));
  const mods = service === null ? null : dossier(pyJoin(service, "node_modules"));
  const modules = mods !== null && service !== null && !mods.startsWith(service + path.sep) ? mods : null;
  const node =
    dossier(reglagesNavigateurBac.node ?? pyJoin(config.PROJECT_ROOT, "node")) ??
    dossier(path.dirname(path.dirname(realpathPy(process.execPath))));
  const playwright = dossier(
    reglagesNavigateurBac.playwright ??
      (process.env["PLAYWRIGHT_BROWSERS_PATH"] || path.join(homedir(), ".cache", "ms-playwright")),
  );
  return { service, modules, node, playwright };
}

/** `-v source:destination:ro` du navigateur ; `null` si une source manque (service, Node ou Playwright). */
export function montagesNavigateur(): string[] | null {
  const s = sourcesNavigateur();
  if (s.service === null || s.node === null || s.playwright === null) return null;
  if (!existsSync(pyJoin(s.node, "bin/node"))) return null;
  const v = [
    `${s.service}:${MONTAGES_NAVIGATEUR.service}:ro`,
    `${s.node}:${MONTAGES_NAVIGATEUR.node}:ro`,
    `${s.playwright}:${MONTAGES_NAVIGATEUR.playwright}:ro`,
  ];
  if (s.modules !== null) v.push(`${s.modules}:${MONTAGES_NAVIGATEUR.modules}:ro`);
  return v.flatMap((m) => ["-v", m]);
}

/** Étiquette `elpis.browser` : 12 hex du SHA-256 des montages ; un changement fait recréer les conteneurs en mode bac. */
export function empreinteNavigateur(): string {
  const m = montagesNavigateur();
  return m === null ? "" : createHash("sha256").update(m.join("\n"), "utf8").digest("hex").slice(0, 12);
}

/** Script de démarrage (sh) : dossiers de données, base NSS du profil avec le certificat du relais, journal borné, puis le service. */
export const SCRIPT_NAVIGATEUR = [
  `D=${BROWSER_DATA}; mkdir -p "$D/home" ${BROWSER_DOWNLOADS} || exit 1`,
  'export HOME="$D/home"; N="$HOME/.pki/nssdb"; mkdir -p "$N" || exit 1',
  '[ -f "$N/cert9.db" ] || certutil -N -d "sql:$N" --empty-password || exit 1',
  'certutil -D -d "sql:$N" -n elpis-relay-ca >/dev/null 2>&1',
  `certutil -A -d "sql:$N" -n elpis-relay-ca -t C,, -i ${BROWSER_CA_CERT} || exit 1`,
  'L="$D/service.log"; [ "$(stat -c %s "$L" 2>/dev/null || echo 0)" -lt 5242880 ] || mv -f "$L" "$L.1"',
  `cd "$D" && exec ${MONTAGES_NAVIGATEUR.node}/bin/node ${MONTAGES_NAVIGATEUR.service}/server.js >>"$L" 2>&1`,
].join("\n");
