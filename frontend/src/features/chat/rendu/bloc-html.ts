// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/bloc-html.ts — HTML d'un bloc du flux posé dans le DOM (directive `v-bloc-html`) : un bloc de code qui ne fait que grandir, ou qui se ferme, reçoit seulement ses nouveaux caractères au bout de son nœud texte (une sélection faite dedans survit) ; tout autre changement repose le HTML. */
import type { ObjectDirective } from "vue";

const CARET = '<span class="elpis-stream-caret" aria-hidden="true"></span>';
const ENTITE = /&(amp|lt|gt|quot|#39|#x27);/g;
const ENTITES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  "#x27": "'",
};

/** Dernier HTML posé dans un bloc de code : son nœud texte et sa longueur, et dans le HTML le début et la fin du texte échappé du `code`. */
interface Pose {
  noeud: Text;
  longueur: number;
  html: string;
  debut: number;
  fin: number;
}

const poses = new WeakMap<Element, Pose>();

/** Texte d'un HTML échappé ; `null` si une entité inconnue s'y trouve (le repli repose alors le HTML). */
function decoder(s: string): string | null {
  if (s.indexOf("&") === -1) return s;
  if (s.replace(ENTITE, "").indexOf("&") !== -1) return null;
  return s.replace(ENTITE, (_, e: string) => ENTITES[e] ?? "");
}

/** Début du texte du `code` d'un bloc de code (`<pre …><code …>`), ou -1. */
function debutCode(html: string): number {
  const k = html.indexOf("<code");
  if (k === -1) return -1;
  const p = html.lastIndexOf("<pre", k);
  if (p === -1 || html.indexOf(">", p) + 1 !== k) return -1;
  return html.indexOf(">", k) + 1 || -1;
}

function retenir(el: Element, html: string): void {
  const debut = debutCode(html);
  const fin = debut === -1 ? -1 : html.indexOf("<", debut);
  const noeud = el.querySelector("pre > code")?.firstChild;
  if (fin === -1 || !(noeud instanceof Text)) poses.delete(el);
  else poses.set(el, { noeud, longueur: noeud.length, html, debut, fin });
}

/** Ajoute au nœud texte du code les caractères qui prolongent le dernier HTML posé ; faux si `html` n'en est pas la suite. */
function prolonger(el: Element, html: string): boolean {
  const p = poses.get(el);
  // Nœud retiré ou modifié par un autre (coloration, pastilles) : repli.
  if (!p || p.noeud.length !== p.longueur || !el.contains(p.noeud)) return false;
  if (p.noeud.parentElement?.hasAttribute("data-hl")) return false;
  const { html: avant, debut, fin } = p;
  if (!html.startsWith(avant.slice(0, debut))) return false;
  let finNeuf: number;
  let ajout: string | null;
  if (html.startsWith(avant.slice(debut, fin), debut)) {
    finNeuf = html.indexOf("<", fin);
    ajout = finNeuf === -1 ? null : decoder(html.slice(fin, finNeuf));
  } else {
    // Bloc figé : l'échappement du rendu final diffère de celui du flux, les textes sont comparés.
    finNeuf = html.indexOf("<", debut);
    const a = decoder(avant.slice(debut, fin));
    const n = finNeuf === -1 ? null : decoder(html.slice(debut, finNeuf));
    ajout = a !== null && n !== null && n.startsWith(a) && p.longueur === a.length ? n.slice(a.length) : null;
  }
  if (ajout === null) return false;
  const queueAvant = avant.slice(fin);
  const queue = html.slice(finNeuf);
  let caret: ChildNode | null = null;
  let suite = "";
  if (queue !== queueAvant) {
    // Fence fermée : le curseur du flux part, le rendu final ajoute au plus un saut de ligne après le bloc.
    const reste = queueAvant.startsWith(CARET) ? queueAvant.slice(CARET.length) : null;
    caret = p.noeud.nextSibling;
    if (reste === null || !queue.startsWith(reste) || !(caret instanceof Element)) return false;
    if (!caret.classList.contains("elpis-stream-caret")) return false;
    suite = queue.slice(reste.length);
    if (suite.trim()) return false;
  }
  if (ajout) p.noeud.appendData(ajout);
  caret?.remove();
  if (suite) el.appendChild(document.createTextNode(suite));
  poses.set(el, { noeud: p.noeud, longueur: p.noeud.length, html, debut, fin: finNeuf });
  return true;
}

function poser(el: HTMLElement, html: string): void {
  if (prolonger(el, html)) return;
  el.innerHTML = html;
  retenir(el, html);
}

/** `v-bloc-html` : comme `v-html` (HTML déjà purifié), avec l'ajout en fin de nœud texte pour un bloc de code qui grandit. */
export const vBlocHtml: ObjectDirective<HTMLElement, string> = {
  beforeMount(el, b) {
    poser(el, b.value);
  },
  beforeUpdate(el, b) {
    if (b.value !== b.oldValue) poser(el, b.value);
  },
};
