// SPDX-License-Identifier: MIT
/** apps/core/src/git/detection.ts — URL d'un dépôt distant : hébergeur détecté, hôte, propriétaire, dépôt ; hôte nu d'une saisie (shared_infra/git/detect.py). */
import { lowerPy, stripPy, urlsplit } from "@elpis/commun";

const DETECTE_VERS_TYPE: ReadonlyMap<string, string> = new Map([
  ["github", "github"],
  ["gitlab", "gitlab"],
  ["bitbucket", "bitbucket-cloud"],
]);

// `.` de Python sans DOTALL : tout sauf `\n` (le `.` de JS refuse aussi `\r`, U+2028 et U+2029).
const URL_HTTP = /^https?:\/\/(?:[^@]+@)?([^/]+)\/([^\n]+?)(?:\.git)?\/?$/u;
const URL_SSH = /^(?:[^@/]+@)?([^:/]+):([^\n]+?)(?:\.git)?$/u;

export interface DepotDetecte {
  provider: string;
  host: string;
  owner: string;
  repo: string;
}

/** `detect_provider` : `{provider, host, owner, repo}` (hôte dans sa casse, port compris) ou `null` si l'URL ne se lit pas. */
export function detectProvider(remoteUrl: string | null | undefined): DepotDetecte | null {
  if (!remoteUrl) return null;
  const url = stripPy(remoteUrl);
  const m = (url.includes("://") ? URL_HTTP : URL_SSH).exec(url);
  if (!m) return null;
  const host = m[1] ?? "";
  const parts = (m[2] ?? "").replace(/^\/+|\/+$/gu, "").split("/");
  if (parts.length < 2) return null;
  const hostLc = lowerPy(host);
  let provider = "unknown";
  if (hostLc === "github.com") provider = "github";
  else if (hostLc === "gitlab.com") provider = "gitlab";
  else if (hostLc === "bitbucket.org") provider = "bitbucket";
  else if (hostLc.includes("gitlab")) provider = "gitlab";
  return { provider, host, owner: parts[0] ?? "", repo: parts.slice(1).join("/") };
}

/** `default_provider_type` : type de connecteur d'un hébergeur détecté, `generic` à défaut. */
export function defaultProviderType(detecte: string | null | undefined): string {
  return DETECTE_VERS_TYPE.get(detecte || "") ?? "generic";
}

/** `normalize_host` : `hôte[:port]` en minuscules d'une URL, d'une forme SSH ou d'un `hôte/chemin` collés ; lève comme `urlsplit` sur des crochets invalides. */
export function normalizeHost(raw: string | null | undefined): string {
  const s = stripPy(raw || "");
  if (!s) return "";
  let netloc: string;
  const arobase = s.indexOf("@");
  const apres = arobase >= 0 ? s.slice(arobase + 1) : "";
  if (s.includes("://")) netloc = urlsplit(s).netloc || "";
  else if (arobase >= 0 && apres.includes(":") && !apres.slice(0, apres.indexOf(":")).includes("/"))
    netloc = apres.slice(0, apres.indexOf(":"));
  else {
    const barre = s.indexOf("/");
    netloc = barre >= 0 ? s.slice(0, barre) : s;
  }
  if (netloc.includes("@")) netloc = netloc.slice(netloc.lastIndexOf("@") + 1);
  return lowerPy(stripPy(netloc));
}
