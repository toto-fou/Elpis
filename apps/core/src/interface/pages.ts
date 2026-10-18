// SPDX-License-Identifier: MIT
/** apps/core/src/interface/pages.ts — pages HTML de l'application (coquilles) : entrées Vite `@entree` développées depuis le manifeste, `?v=` au BUILD_ID, vendor à son empreinte, en cache tant que le disque ne bouge pas ; politique de sécurité du contenu (CSP) des pages. */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { reprPy } from "@elpis/commun";
import { buildIdDepuis, configView } from "@elpis/config";

/** Manifeste du build Vite (`npm run build -w @elpis/web`), relatif à `frontend/`. */
export const MANIFESTE_WEB = "dist/.vite/manifest.json";

const VERSION = /\?v=[\p{L}\p{N}_.-]+/gu;
const VENDOR = /((?:src|href)=")(static\/vendor\/[^"?]+)(")/g;
const ENTREE = /<!--\s*@entree\s+(\S+)\s*-->/g;
const NOM_ENTREE = /^[a-z][a-z0-9-]*$/;
const FICHIER_CONSTRUIT = /^assets\/[\w.-]+\.(?:js|css)$/;

/** Mode de la CSP des pages (`security.csp` de config.json) : appliquée, signalée seulement, ou absente. */
export type ModeCsp = "enforce" | "report-only" | "off";

/** Politique des pages : tout vient de l'origine, aucun script en ligne ni évalué ; styles en ligne, images data:/blob: et audio blob: prouvés par le relevé L10. */
export const POLITIQUE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join("; ");

/** Chemin du document d'aperçu HTML des blocs de code (iframe du chat). */
export const CHEMIN_APERCU_CODE = "/apercu-code";

/** Politique propre de l'aperçu : bac à sable même ouvert seul, scripts et styles du contenu en ligne, aucun accès réseau. */
export const POLITIQUE_APERCU_CODE = [
  "sandbox allow-scripts allow-modals allow-popups",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** Amorce de l'aperçu : annonce qu'elle est prête, puis écrit le seul HTML reçu de la fenêtre parente. */
export const PAGE_APERCU_CODE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Aperçu</title></head><body><script>
addEventListener("message", function recevoir(e) {
  if (e.source !== parent || typeof e.data !== "string") return;
  removeEventListener("message", recevoir);
  document.open();
  document.write(e.data);
  document.close();
});
parent.postMessage("elpis-apercu-pret", "*");
</script></body></html>
`;

interface Morceau {
  file: string;
  css?: string[];
  imports?: string[];
}

const ENTITES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};

/** Texte sûr dans un attribut HTML. */
function echapperHtml(texte: string): string {
  return texte.replace(/[&<>"']/g, (c) => ENTITES[c] ?? c);
}

/** Valeur de `security.csp` ramenée à un mode connu ; toute autre valeur applique la politique. */
export function modeCsp(valeur: unknown): ModeCsp {
  return valeur === "report-only" || valeur === "off" ? valeur : "enforce";
}

/** Mode lu dans la configuration vivante (relue quand config.json change). */
export function modeCspConfigure(): ModeCsp {
  const securite = configView()["security"];
  const valeur =
    securite !== null && typeof securite === "object"
      ? (securite as Record<string, unknown>)["csp"]
      : undefined;
  return modeCsp(valeur);
}

/** En-tête de la politique selon le mode : appliquée, signalée seulement (Report-Only), ou aucun. */
export function enteteCsp(mode: ModeCsp): Record<string, string> {
  if (mode === "off") return {};
  const nom = mode === "enforce" ? "content-security-policy" : "content-security-policy-report-only";
  return { [nom]: POLITIQUE_CSP };
}

interface PageEnCache {
  sources: string[];
  cle: string;
  html: string;
}

function cleSources(chemins: readonly string[]): string {
  return chemins
    .map((p) => {
      try {
        const st = statSync(p, { bigint: true });
        return `${p}:${st.mtimeNs}:${st.size}`;
      } catch {
        return `${p}:0:-1`;
      }
    })
    .join("|");
}

/** Balises d'une entrée du manifeste : feuilles de style et préchargements de tout son graphe statique, puis le module. */
export function balisesEntree(manifeste: Readonly<Record<string, Morceau>>, nom: string): string | null {
  const entree = manifeste[`src/entries/${nom}.ts`];
  if (!entree) return null;
  const css = new Set<string>();
  const precharges = new Set<string>();
  const vus = new Set<string>();
  const visiter = (m: Morceau): void => {
    for (const f of m.css ?? []) css.add(f);
    for (const cle of m.imports ?? []) {
      const dep = manifeste[cle];
      if (!dep || vus.has(cle)) continue;
      vus.add(cle);
      precharges.add(dep.file);
      visiter(dep);
    }
  };
  visiter(entree);
  const fichiers = [entree.file, ...css, ...precharges];
  if (!fichiers.every((f) => FICHIER_CONSTRUIT.test(f))) return null;
  const url = (f: string): string => `static/dist/${echapperHtml(f)}`;
  return [
    ...[...css].map((f) => `<link rel="stylesheet" href="${url(f)}">`),
    ...[...precharges].map((f) => `<link rel="modulepreload" href="${url(f)}">`),
    `<script type="module" src="${url(entree.file)}"></script>`,
  ].join("\n");
}

/** Manifeste lu tel quel ; `null` s'il est absent ou illisible (frontend non construit). */
function lireManifeste(chemin: string): Record<string, Morceau> | null {
  try {
    const brut: unknown = JSON.parse(readFileSync(chemin, "utf-8"));
    return brut !== null && typeof brut === "object" && !Array.isArray(brut)
      ? (brut as Record<string, Morceau>)
      : null;
  } catch {
    return null;
  }
}

/** Lecture en mode texte de Python : `\r\n` et `\r` deviennent `\n`. */
function lireTexte(chemin: string): string {
  return readFileSync(chemin, "utf-8").replace(/\r\n?/g, "\n");
}

export class Pages {
  private readonly empreintes = new Map<string, string>();
  private readonly cache = new Map<string, PageEnCache>();

  private readonly frontend: string;
  private readonly buildId: string;

  /** Un BUILD_ID hors de la forme sûre est remplacé par un identifiant neuf avant toute injection. */
  constructor(frontend: string, buildId: string) {
    this.frontend = frontend;
    this.buildId = buildIdDepuis(buildId);
  }

  /** Empreinte (mtime, taille) d'un fichier vendor, mémorisée pour la vie du process ; le BUILD_ID s'il manque. */
  empreinteVendor(cheminStatique: string): string {
    const deja = this.empreintes.get(cheminStatique);
    if (deja) return deja;
    const rel = cheminStatique.startsWith("static/")
      ? cheminStatique.slice("static/".length)
      : cheminStatique;
    let empreinte: string;
    try {
      const st = statSync(join(this.frontend, rel), { bigint: true });
      empreinte = createHash("sha256").update(`${st.mtimeNs}:${st.size}`).digest("hex").slice(0, 10);
    } catch {
      empreinte = this.buildId;
    }
    this.empreintes.set(cheminStatique, empreinte);
    return empreinte;
  }

  rendre(page: string): string {
    const chemin = join(this.frontend, page);
    const enCache = this.cache.get(page);
    if (enCache && cleSources(enCache.sources) === enCache.cle) return enCache.html;
    const lus = [chemin];
    const html = this.assembler(lireTexte(chemin), lus);
    this.cache.set(page, { sources: lus, cle: cleSources(lus), html });
    return html;
  }

  /** `?v=` au BUILD_ID, vendor à son empreinte, puis les entrées Vite ; un build absent laisse un commentaire (jamais de script en ligne). */
  assembler(contenu: string, lus: string[] = []): string {
    let texte = contenu.replace(VERSION, () => `?v=${echapperHtml(this.buildId)}`);
    texte = texte.replace(
      VENDOR,
      (_m, a: string, chemin: string, b: string) =>
        `${a}${chemin}?v=${echapperHtml(this.empreinteVendor(chemin))}${b}`,
    );
    if (!/<!--\s*@entree\s/.test(texte)) return texte;
    const chemin = join(this.frontend, MANIFESTE_WEB);
    lus.push(chemin);
    const manifeste = lireManifeste(chemin);
    return texte.replace(ENTREE, (_m, nom: string) => {
      if (!NOM_ENTREE.test(nom)) return `<!-- @entree: invalid name ${reprPy(nom)} -->`;
      const balises = manifeste ? balisesEntree(manifeste, nom) : null;
      return balises ?? `<!-- @entree: ${nom} absente du build -->`;
    });
  }
}
