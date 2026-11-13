// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/bloc-html.ts — HTML d'un bloc du flux posé dans le DOM (directive `v-bloc-html`) : un bloc de code qui ne fait que grandir, ou qui se ferme, et un texte qui grandit juste avant le curseur du flux reçoivent seulement leurs nouveaux caractères au bout de leur nœud texte (une sélection faite dedans survit) ; tout autre changement repose le HTML. */
import type { ObjectDirective } from "vue";

/** Curseur du flux tel que le moteur Markdown l'insère dans le bloc actif. */
export const CARET = '<span class="elpis-stream-caret" aria-hidden="true"></span>';
const ENTITE = /&(amp|lt|gt|quot|#39|#x27);/g;
const ENTITES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  "#x27": "'",
};

/** Bloc de code du dernier HTML posé : nœud texte de son `code`, sa longueur, début et fin de son texte échappé dans le HTML. */
interface Code {
  noeud: Text;
  longueur: number;
  debut: number;
  fin: number;
}

/** Dernier HTML posé dans un bloc, son bloc de code et son curseur (élément et position dans le HTML). */
interface Pose {
  html: string;
  code: Code | null;
  curseur: { el: Element; pos: number } | null;
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

/** Mémorise ce que le DOM du bloc contient pour `html` : le nœud texte du code et le curseur, s'ils sont toujours là. */
function retenir(
  el: Element,
  html: string,
  noeud: ChildNode | null | undefined,
  caret: Element | null,
): void {
  const debut = debutCode(html);
  const fin = debut === -1 ? -1 : html.indexOf("<", debut);
  const pos = html.indexOf(CARET);
  poses.set(el, {
    html,
    code: fin !== -1 && noeud instanceof Text ? { noeud, longueur: noeud.length, debut, fin } : null,
    curseur: caret && pos !== -1 && pos === html.lastIndexOf(CARET) ? { el: caret, pos } : null,
  });
}

function retenirDom(el: HTMLElement, html: string): void {
  const carets = el.getElementsByClassName("elpis-stream-caret");
  retenir(
    el,
    html,
    el.querySelector("pre > code")?.firstChild,
    carets.length === 1 ? (carets[0] ?? null) : null,
  );
}

/** Ajoute au nœud texte du code les caractères qui prolongent le dernier HTML posé ; faux si `html` n'en est pas la suite. */
function prolongerCode(el: Element, p: Pose, html: string): boolean {
  const c = p.code;
  // Nœud retiré ou modifié par un autre (coloration, pastilles) : repli.
  if (!c || c.noeud.length !== c.longueur || !el.contains(c.noeud)) return false;
  if (c.noeud.parentElement?.hasAttribute("data-hl")) return false;
  const { html: avant } = p;
  const { debut, fin } = c;
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
    ajout = a !== null && n !== null && n.startsWith(a) && c.longueur === a.length ? n.slice(a.length) : null;
  }
  if (ajout === null) return false;
  const queueAvant = avant.slice(fin);
  const queue = html.slice(finNeuf);
  let caret: ChildNode | null = null;
  let suite = "";
  if (queue !== queueAvant) {
    // Fence fermée : le curseur du flux part, le rendu final ajoute au plus un saut de ligne après le bloc.
    const reste = queueAvant.startsWith(CARET) ? queueAvant.slice(CARET.length) : null;
    caret = c.noeud.nextSibling;
    if (reste === null || !queue.startsWith(reste) || !(caret instanceof Element)) return false;
    if (!caret.classList.contains("elpis-stream-caret")) return false;
    suite = queue.slice(reste.length);
    if (suite.trim()) return false;
  }
  if (ajout) c.noeud.appendData(ajout);
  caret?.remove();
  if (suite) el.appendChild(el.ownerDocument.createTextNode(suite));
  retenir(el, html, c.noeud, caret ? null : (p.curseur?.el ?? null));
  return true;
}

/** Texte inséré juste avant le curseur, sans balise : ajouté au nœud texte qui le précède ; faux sinon. */
function insererAvantCurseur(el: Element, p: Pose, html: string): boolean {
  const cu = p.curseur;
  const n = html.length - p.html.length;
  if (!cu || n <= 0 || !el.contains(cu.el)) return false;
  const texte = cu.el.previousSibling;
  if (!(texte instanceof Text) || !html.startsWith(p.html.slice(0, cu.pos))) return false;
  if (html.slice(cu.pos + n) !== p.html.slice(cu.pos)) return false;
  const brut = html.slice(cu.pos, cu.pos + n);
  const ajout = brut.indexOf("<") === -1 && html.charCodeAt(cu.pos - 1) !== 62 ? decoder(brut) : null;
  if (ajout === null) return false;
  texte.appendData(ajout);
  retenir(el, html, p.code?.noeud, cu.el);
  return true;
}

function poser(el: HTMLElement, html: string): void {
  const p = poses.get(el);
  if (p && (prolongerCode(el, p, html) || insererAvantCurseur(el, p, html))) return;
  el.innerHTML = html;
  retenirDom(el, html);
}

/** `v-bloc-html` : comme `v-html` (HTML déjà purifié), avec l'ajout en fin de nœud texte pour un bloc de code ou un texte qui grandit. */
export const vBlocHtml: ObjectDirective<HTMLElement, string> = {
  beforeMount(el, b) {
    poser(el, b.value);
  },
  beforeUpdate(el, b) {
    if (b.value !== b.oldValue) poser(el, b.value);
  },
};
