// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/purification.ts — purification DOMPurify de tout HTML rendu et neutralisation des médias distants. */
import type DOMPurify from "dompurify";

import { estUrlHttp } from "../../../utils/url-sure.ts";
import { escapeHtml } from "../../../utils/utils-purs.ts";

const BALISES_INTERDITES = ["script", "style", "iframe", "object", "embed", "link", "meta", "base", "form"];
const ATTRIBUTS_INTERDITS = ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"];
const MEDIAS = /<(img|video|audio|source|track|input)\b|style\s*=/i;
const POSITION_FLOTTANTE = /position\s*:\s*(fixed|sticky)/gi;
const crochets = new WeakSet<object>();
const PROPRIETES_STYLE_SURES = new Set([
  "color",
  "background",
  "background-color",
  "opacity",
  "text-align",
  "vertical-align",
  "text-decoration",
  "text-decoration-line",
  "text-decoration-color",
  "text-transform",
  "text-indent",
  "text-overflow",
  "white-space",
  "word-break",
  "overflow-wrap",
  "font-weight",
  "font-style",
  "font-size",
  "font-family",
  "line-height",
  "letter-spacing",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-style",
  "border-width",
  "border-radius",
  "border-collapse",
  "border-spacing",
  "width",
  "max-width",
  "min-width",
  "display",
  "gap",
  "list-style-type",
  "flex",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "align-items",
  "align-self",
  "justify-content",
  "grid-template-columns",
]);

export type Purify = typeof DOMPurify;
interface DonneeAttribut {
  attrName?: string;
  attrValue?: string;
}

/** Une URL qui déclencherait une requête vers un tiers (ou un protocole inconnu) au simple affichage. */
export function estMediaDistant(valeur: unknown): boolean {
  const s = (typeof valeur === "string" ? valeur : "").trim();
  if (!s) return false;
  if (/^data:image\//i.test(s) || /^blob:/i.test(s)) return false;
  if (/^data:/i.test(s)) return true;
  try {
    const u = new URL(s, window.location.href);
    if (u.protocol === "http:" || u.protocol === "https:") return u.origin !== window.location.origin;
    return true;
  } catch {
    return true;
  }
}

/** Image distante remplacée par un lien http(s) (retirée sinon), autres médias distants et `url(...)` inline retirés (anti-exfiltration). */
export function neutraliserMediasDistants(html: string): string {
  if (!html || !MEDIAS.test(html)) return html;
  try {
    const doc = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html");
    const racine = doc.body.firstElementChild;
    if (!racine) return html;
    for (const img of Array.from(racine.querySelectorAll("img"))) {
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
      const src = img.getAttribute("src") ?? "";
      if (!estMediaDistant(src)) continue;
      if (!estUrlHttp(src)) {
        img.replaceWith(doc.createTextNode((img.getAttribute("alt") ?? "").trim()));
        continue;
      }
      const a = doc.createElement("a");
      a.setAttribute("href", src);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer nofollow");
      a.className = "elpis-ext-img";
      a.title = "Image externe non chargée automatiquement — cliquer pour l'ouvrir";
      let hote = "";
      try {
        hote = new URL(src, window.location.href).hostname;
      } catch {
        hote = "";
      }
      const icone = doc.createElement("i");
      icone.className = "ph ph-image";
      a.appendChild(icone);
      const alt = (img.getAttribute("alt") ?? "").trim();
      a.appendChild(
        doc.createTextNode(" " + (alt ? alt + " — " : "") + "image externe (" + (hote || "lien") + ")"),
      );
      img.parentNode?.replaceChild(a, img);
    }
    for (const el of Array.from(racine.querySelectorAll("video, audio, source, track, input"))) {
      for (const at of ["src", "poster", "srcset"]) {
        if (el.hasAttribute(at) && estMediaDistant(el.getAttribute(at))) el.removeAttribute(at);
      }
    }
    for (const el of Array.from(racine.querySelectorAll("[style]"))) {
      if (/url\s*\(/i.test(el.getAttribute("style") ?? "")) el.removeAttribute("style");
    }
    return racine.innerHTML;
  } catch {
    return html;
  }
}

/** Ne garde du style en ligne que les déclarations de présentation sûres (liste blanche, sans `url(`, `expression` ni échappement). */
export function filtrerStyle(valeur: string): string {
  const sortie: string[] = [];
  let depth = 0;
  let debut = 0;
  const decls: string[] = [];
  for (let i = 0; i < valeur.length; i++) {
    const c = valeur[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      decls.push(valeur.slice(debut, i));
      debut = i + 1;
    }
  }
  decls.push(valeur.slice(debut));
  for (const d of decls) {
    const k = d.indexOf(":");
    if (k < 1) continue;
    const prop = d.slice(0, k).trim().toLowerCase();
    const val = d.slice(k + 1).trim();
    if (!PROPRIETES_STYLE_SURES.has(prop) || !val) continue;
    if (
      /url\s*\(|image-set|cross-fade|element\s*\(|expression|@import|javascript:|\\|\/\*|var\s*\(/i.test(val)
    )
      continue;
    sortie.push(prop + ":" + val);
  }
  return sortie.join(";");
}

/** Crochets de tous les passages DOMPurify : `style` hors SVG filtré par liste blanche (`position:fixed|sticky` ramené à `static` ailleurs), lien à `target` sans accès à `window.opener`. */
export function installerCrochets(purify: Purify): void {
  if (crochets.has(purify)) return;
  crochets.add(purify);
  purify.addHook("uponSanitizeAttribute", (noeud, brut) => {
    const data = brut as DonneeAttribut;
    if (data.attrName === "style" && data.attrValue) {
      data.attrValue = data.attrValue.replace(POSITION_FLOTTANTE, "position:static");
      const dansSvg = noeud instanceof Element && noeud.closest("svg") !== null;
      if (!dansSvg) data.attrValue = filtrerStyle(data.attrValue);
    }
  });
  purify.addHook("afterSanitizeAttributes", (noeud) => {
    if (noeud instanceof Element && noeud.hasAttribute("target"))
      noeud.setAttribute("rel", "noopener noreferrer");
  });
}

/** Purifie un HTML ; sans DOMPurify utilisable, le texte est échappé (jamais de HTML brut). */
export function creerPurificateur(purify: Purify | undefined): (html: unknown) => string {
  if (purify && typeof purify.sanitize === "function") installerCrochets(purify);
  return (html) => {
    if (html === null || html === undefined) return "";
    const brut = String(html as string);
    if (!brut) return "";
    if (purify && typeof purify.sanitize === "function") {
      try {
        return neutraliserMediasDistants(
          purify.sanitize(brut, {
            ADD_ATTR: ["target"],
            FORBID_TAGS: BALISES_INTERDITES,
            FORBID_ATTR: ATTRIBUTS_INTERDITS,
          }),
        );
      } catch {
        return escapeHtml(brut);
      }
    }
    return escapeHtml(brut);
  };
}
