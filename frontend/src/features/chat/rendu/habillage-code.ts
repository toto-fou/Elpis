// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/habillage-code.ts — habillage des blocs de code (enveloppe, en-tête, actions) ajouté après la purification, et actions Copier / Aperçu par délégation d'événements. */
import { restaurerMarqueursTour } from "@elpis/commun/marqueurs-tour";

import { escapeHtml } from "../../../utils/utils-purs.ts";
import { ouvrirApercu } from "./apercu.ts";
import { ressembleASvg } from "./svg.ts";

/** Attribut des commandes de l'habillage : hors liste blanche de DOMPurify, donc absent de tout HTML écrit par le modèle. */
export const ATTRIBUT_ACTION = "elpis-act";

const LANGUES_SPECIALES = new Set(["chart-ref", "elpis-skin", "mermaid", "svg"]);
const LANGUES_SVG = new Set(["", "xml", "html", "plaintext"]);
const BLOC_PUR = /<pre><code class="([^"]*)">([\s\S]*?)<\/code><\/pre>/g;
const ENTITES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  quot: '"',
  amp: "&",
  "#39": "'",
  "#x27": "'",
};
const ICONE_COPIER = '<i class="ph ph-copy"></i><span class="sr-only">Copier</span>';
const ICONE_COPIE = '<i class="ph ph-check text-green-400"></i><span class="sr-only">Copié</span>';
const ICONE_APERCU = '<i class="ph ph-eye"></i><span>Aperçu</span>';
const ICONE_CODE = '<i class="ph ph-code"></i><span>Code</span>';
const TITRE_APERCU = "Afficher le rendu de la page";
const TITRE_CODE = "Revenir au code";
const BOUTON_COPIER = `<button type="button" class="copy-btn" ${ATTRIBUT_ACTION}="copier" title="Copier" aria-label="Copier">${ICONE_COPIER}</button>`;
const BOUTON_APERCU = `<button type="button" ${ATTRIBUT_ACTION}="apercu" title="${TITRE_APERCU}">${ICONE_APERCU}</button>`;

interface ApercuOuvert {
  cadre: HTMLIFrameElement;
  annuler: () => void;
}

const apercus = new WeakMap<Element, ApercuOuvert>();
const traites = new WeakSet<Event>();
let installee = false;

function decoder(s: string): string {
  return s.replace(/&(lt|gt|quot|amp|#39|#x27);/g, (_, e: string) => ENTITES[e] ?? "");
}

/** Langue (en minuscules) lue dans l'attribut `class` d'un `code` : première classe `language-…`. */
export function langueDeClasses(classes: string): string {
  for (const c of decoder(classes).split(/\s+/))
    if (c.startsWith("language-")) return c.slice(9).toLowerCase();
  return "";
}

/** Vrai pour un bloc de code ordinaire ; faux pour les langues remplacées par une carte, un graphique ou un diagramme, et pour du code qui est un SVG. */
export function estBlocOrdinaire(lang: string, texte: () => string): boolean {
  if (LANGUES_SPECIALES.has(lang)) return false;
  return !(LANGUES_SVG.has(lang) && ressembleASvg(texte()));
}

/** Enveloppe, en-tête et actions autour d'un bloc ; `classes` et `corps` sont déjà du HTML sûr. */
export function habillerBloc(lang: string, classes: string, corps: string): string {
  const langue = lang.toLowerCase();
  return (
    '<div class="code-wrapper relative group mb-4"><div class="copy-sticky"><div class="code-actions">' +
    (langue === "html" ? BOUTON_APERCU : "") +
    BOUTON_COPIER +
    '</div></div><div class="code-header flex justify-between items-center px-3 py-1.5"><span class="text-xs font-bold text-gray-400 font-mono">' +
    escapeHtml((langue || "code").toUpperCase()) +
    '</span></div><pre class="custom-style-applied" data-cb-done="1"><code class="' +
    classes +
    '">' +
    corps +
    "</code></pre></div>"
  );
}

/** Habille les blocs `<pre><code>` ordinaires d'un HTML déjà purifié ; les autres restent tels quels. */
export function habillerBlocsCode(html: string): string {
  if (!html.includes("<pre>")) return html;
  return html.replace(BLOC_PUR, (tout, classes: string, corps: string) => {
    const lang = langueDeClasses(classes);
    if (!estBlocOrdinaire(lang, () => decoder(corps.replace(/<[^>]*>/g, "")))) return tout;
    return habillerBloc(lang, classes, corps);
  });
}

function preDe(enveloppe: Element): HTMLElement | null {
  return (Array.from(enveloppe.children).find((c) => c.tagName === "PRE") as HTMLElement | undefined) ?? null;
}

function texteDuCode(enveloppe: Element): string {
  const pre = preDe(enveloppe);
  return (pre?.querySelector("code") ?? pre)?.textContent ?? "";
}

/** Copie `brut` (marqueurs de tour restaurés) dans le presse-papiers et signale « Copié » sur le bouton pendant deux secondes. */
export async function copierTexte(brut: string, bouton: HTMLElement): Promise<void> {
  const texte = restaurerMarqueursTour(brut);
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(texte);
    else {
      const ta = Object.assign(document.createElement("textarea"), { value: texte });
      ta.style.cssText = "position:fixed;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    bouton.innerHTML = ICONE_COPIE;
    setTimeout(() => {
      bouton.innerHTML = ICONE_COPIER;
    }, 2000);
  } catch {
    /* presse-papiers refusé */
  }
}

/** Bouton Copier construit au DOM, pour les blocs de repli qui n'ont pas l'habillage du moteur. */
export function creerBoutonCopier(brut: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "copy-btn";
  btn.title = "Copier";
  btn.setAttribute("aria-label", "Copier");
  btn.innerHTML = ICONE_COPIER;
  btn.onclick = () => void copierTexte(brut, btn);
  return btn;
}

function basculerApercu(bouton: HTMLElement, enveloppe: Element): void {
  const pre = preDe(enveloppe);
  const ouvert = apercus.get(enveloppe);
  ouvert?.annuler();
  if (ouvert) {
    ouvert.cadre.remove();
    apercus.delete(enveloppe);
    if (pre) pre.style.display = "";
    bouton.innerHTML = ICONE_APERCU;
    bouton.title = TITRE_APERCU;
    return;
  }
  const cadre = document.createElement("iframe");
  cadre.className = "code-preview-frame";
  apercus.set(enveloppe, { cadre, annuler: ouvrirApercu(cadre, texteDuCode(enveloppe)) });
  enveloppe.appendChild(cadre);
  if (pre) pre.style.display = "none";
  bouton.innerHTML = ICONE_CODE;
  bouton.title = TITRE_CODE;
}

/** Exécute l'action d'une commande d'habillage touchée par l'événement ; le texte est lu au moment du clic. Faux si l'événement n'en concerne aucune. */
export function agirSurHabillage(event: Event): boolean {
  if (traites.has(event)) return true;
  const cible = event.target as Element | null;
  const bouton =
    cible && typeof cible.closest === "function"
      ? cible.closest<HTMLElement>("button[" + ATTRIBUT_ACTION + "]")
      : null;
  const enveloppe = bouton?.closest(".code-wrapper");
  if (!bouton || !enveloppe) return false;
  traites.add(event);
  const action = bouton.getAttribute(ATTRIBUT_ACTION);
  if (action === "copier") void copierTexte(texteDuCode(enveloppe), bouton);
  else if (action === "apercu") basculerApercu(bouton, enveloppe);
  return true;
}

/** Écoute unique des clics sur l'habillage dans toute la page, pour les corps Markdown qui ne transmettent pas leurs clics. */
export function installerDelegationCode(): void {
  if (installee || typeof document === "undefined") return;
  installee = true;
  document.addEventListener("click", agirSurHabillage);
}
