// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/svg.ts — nettoyage SVG par DOMPurify (profil SVG, analyse HTML comme l'innerHTML qui suit) et retrait des médias distants ; sans import, chargeable tel quel par Node et le navigateur. */

export interface PurifySvg {
  sanitize(source: string, config: Readonly<Record<string, unknown>>): unknown;
}

const BALISES_HREF = new Set(["image", "use", "feimage"]);
const CSS_DISTANT = /@import|url\s*\(\s*(?!['"]?\s*(?:#|data:image\/))/i;

function hrefDistant(v: string): boolean {
  const s = v.trim();
  return !!s && s[0] !== "#" && !/^data:image\//i.test(s);
}

/** SVG purifié (balise racine `svg` exigée), ou null : l'appelant affiche alors le code, jamais du SVG non nettoyé. */
export function sanitizeSvg(rawText: unknown, purify: PurifySvg | null | undefined): string | null {
  if (!rawText || !purify || typeof purify.sanitize !== "function") return null;
  const src = String(rawText as string).replace(
    /^\s*(<\?xml[^>]*\?>\s*|<!DOCTYPE[^>]*>\s*|<!--[\s\S]*?-->\s*)*/i,
    "",
  );
  let frag: unknown;
  try {
    frag = purify.sanitize(src, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ["use"],
      RETURN_DOM_FRAGMENT: true,
    });
  } catch {
    return null;
  }
  const root = (frag as DocumentFragment | null)?.firstElementChild;
  if (!root || root.nodeName.toLowerCase() !== "svg") return null;
  root.querySelectorAll("*").forEach((el) => {
    const tag = el.nodeName.toLowerCase();
    if (BALISES_HREF.has(tag)) {
      for (const at of ["href", "xlink:href"]) {
        if (!el.hasAttribute(at)) continue;
        const v = String(el.getAttribute(at)).trim();
        if (tag === "use" ? v[0] !== "#" : hrefDistant(v)) el.removeAttribute(at);
      }
    }
    if (tag === "style" && CSS_DISTANT.test(el.textContent || "")) el.remove();
    else if (el.hasAttribute("style") && CSS_DISTANT.test(el.getAttribute("style") || ""))
      el.removeAttribute("style");
  });
  return root.outerHTML;
}

/** Un bloc sans étiquette `svg` dont le texte est pourtant un SVG (prologue XML ou DOCTYPE tolérés). */
export function ressembleASvg(rawText: unknown): boolean {
  if (!rawText) return false;
  const s = String(rawText as string).trim();
  if (s.startsWith("<svg") || s.startsWith("<SVG")) return true;
  if (s.startsWith("<?xml") || s.startsWith("<!DOCTYPE")) return /<svg[\s>]/i.test(s.slice(0, 2000));
  return false;
}
