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

/** Crochets de tous les passages DOMPurify : `position:fixed|sticky` ramené à `static`, lien à `target` sans accès à `window.opener`. */
export function installerCrochets(purify: Purify): void {
  if (crochets.has(purify)) return;
  crochets.add(purify);
  purify.addHook("uponSanitizeAttribute", (_noeud, brut) => {
    const data = brut as DonneeAttribut;
    if (data.attrName === "style" && data.attrValue) {
      data.attrValue = data.attrValue.replace(POSITION_FLOTTANTE, "position:static");
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
