// SPDX-License-Identifier: MIT
/** packages/bac/src/navigateur.ts — navigateur dans le bac de chaque compte : montages en lecture seule (code du service fichier par fichier, ses modules, runtime Node, headless shell), chemins dans le conteneur et script de démarrage. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { config, pyJoin, racineDepot, realpathPy } from "@elpis/config";

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
  modules: "/opt/elpis/browser-service/node_modules",
  node: "/opt/elpis/node",
  playwright: "/opt/elpis/ms-playwright",
} as const;

/** Code du service monté dans le bac : modules `*.js` et `package.json` du dossier, jamais ses sous-dossiers ni ses autres fichiers (données d'anciennes installations, paquets hors ligne). */
const CODE_SERVICE = /^(?:[\w.-]+\.(?:js|mjs|cjs)|package\.json)$/u;

/** Surcharges de test des sources des montages (`null` : celles de l'installation). */
export const reglagesNavigateurBac: {
  service: string | null;
  node: string | null;
  playwright: string | null;
} = { service: null, node: null, playwright: null };

function dossier(p: string): string | null {
  try {
    const r = realpathPy(p);
    return statSync(r).isDirectory() ? r : null;
  } catch {
    return null;
  }
}

/** Sources des montages : `browser-service/` du dépôt et ses modules (résolus), runtime Node de l'installation, cache Playwright. */
export function sourcesNavigateur(): {
  service: string | null;
  modules: string | null;
  node: string | null;
  playwright: string | null;
} {
  const service = dossier(reglagesNavigateurBac.service ?? pyJoin(racineDepot(), "browser-service"));
  const modules = service === null ? null : dossier(pyJoin(service, "node_modules"));
  const node =
    dossier(reglagesNavigateurBac.node ?? pyJoin(config.PROJECT_ROOT, "node")) ??
    dossier(path.dirname(path.dirname(realpathPy(process.execPath))));
  const playwright = dossier(
    reglagesNavigateurBac.playwright ??
      (process.env["PLAYWRIGHT_BROWSERS_PATH"] || path.join(homedir(), ".cache", "ms-playwright")),
  );
  return { service, modules, node, playwright };
}

/** Fichiers de code du service (fichiers ordinaires, liens exclus), triés. */
export function fichiersCodeService(service: string): string[] {
  try {
    return readdirSync(service, { withFileTypes: true })
      .filter((d) => d.isFile() && CODE_SERVICE.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** `-v source:destination:ro` du navigateur, le code du service fichier par fichier ; `null` si une source manque (service, modules, Node ou Playwright). */
export function montagesNavigateur(): string[] | null {
  const s = sourcesNavigateur();
  if (s.service === null || s.modules === null || s.node === null || s.playwright === null) return null;
  if (!existsSync(pyJoin(s.node, "bin/node"))) return null;
  const service = s.service;
  const code = fichiersCodeService(service);
  if (!code.includes("server.js")) return null;
  const v = [
    ...code.map((f) => `${pyJoin(service, f)}:${MONTAGES_NAVIGATEUR.service}/${f}:ro`),
    `${s.modules}:${MONTAGES_NAVIGATEUR.modules}:ro`,
    `${s.node}:${MONTAGES_NAVIGATEUR.node}:ro`,
    `${s.playwright}:${MONTAGES_NAVIGATEUR.playwright}:ro`,
  ];
  return v.flatMap((m) => ["-v", m]);
}

/** Étiquette `elpis.browser` : 12 hex du SHA-256 des montages et des inodes de leurs sources (un fichier remplacé par une mise à jour reste monté à l'ancien inode), `""` sans montage ; un changement fait recréer le conteneur. */
export function empreinteNavigateur(): string {
  const m = montagesNavigateur();
  if (m === null) return "";
  const inodes = m
    .filter((x) => x !== "-v")
    .map((x) => {
      try {
        return String(statSync(x.slice(0, x.indexOf(":"))).ino);
      } catch {
        return "?";
      }
    });
  return createHash("sha256")
    .update([...m, ...inodes].join("\n"), "utf8")
    .digest("hex")
    .slice(0, 12);
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
