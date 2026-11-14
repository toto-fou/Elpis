// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/rendu-flux.ts — rendu du flux : patchs du message en cours, rendu Markdown incrémental (corps `_md`, ligne vivante `_pp`), tampons de réflexion, de narration et de corps, sortie shell coalescée, battement unique (une image, une mise à jour, une écriture de défilement) ; le texte qui grandit passe par le porteur du message, qui n'est remplacé que pour un changement de structure. */
import { journal } from "../../../platform/journal";
import { getCurrentScope, markRaw, nextTick, onScopeDispose, toRaw } from "vue";

import { marquerBattement } from "../../../utils/battement";
import type { BlocFlux, EtatFlux } from "../rendu/flux-blocs.ts";
import type { ResultatFlux } from "../rendu/markdown.ts";
import { CARET } from "../rendu/bloc-html.ts";
import { creerPorteur, synchroniserPorteur } from "../rendu/porteur-flux.ts";
import { creerBudget, noterCout, sauterImage } from "./budget-battement.ts";
import type { CoeurChat, EntreeAffichee } from "./liens.ts";
import type { EtapeChat, MessageChat, Objet } from "./types.ts";
import { creerVersement, noterArrivee, reinitialiserVersement, tranche } from "./versement.ts";

type Prefixe = "_md" | "_pp";

/** Parties du flux qu'un abandon vide (tampon, état de versement, armement). */
export interface PartiesFlux {
  corps?: boolean;
  reflexion?: boolean;
  narration?: boolean;
  shell?: boolean;
}

const IMAGE_MS = 1000 / 60;
const SHELL_FLUSH_MS = 100;
const SHELL_MAX = 98304;
const TITRE_REFLEXION_MS = 250;
const ONGLET_CACHE_MS = 250;
const BAS_PX = 4;
const CARET_ATTENTE_MS = 400;
const TEXTE_COULE = "elpis-texte-coule";
// Glissé du suivi : constante de temps (95 % du chemin en 100 ms) et retard maximal (deux lignes de texte).
const GLISSE_MS = 100 / 3;
const ECART_MAX_PX = 48;

/** Champs d'affichage du rendu incrémental du corps (blocs, bloc actif, état de découpe), purgés à chaque remise à zéro du flux ; le porteur est lâché (le battement suivant en pose un neuf). */
export const STREAM_RENDER_CLEAR: Readonly<Objet> = Object.freeze({
  _mdBlocks: null,
  _mdActiveHtml: "",
  _mdActifTexte: "",
  _mdFlux: null,
  _modelLoad: null,
  _flux: null,
});

/** Idem pour la ligne vivante du conteneur « Travail de l'assistant ». */
export const PRE_RENDER_CLEAR: Readonly<Objet> = Object.freeze({
  _ppBlocks: null,
  _ppActiveHtml: "",
  _ppFlux: null,
  _flux: null,
});

const TEXTES = new Set(["content", "thinking", "_pendingPreContent"]);
const LEGERS = new Set([
  ...TEXTES,
  "_mdBlocks",
  "_mdActiveHtml",
  "_mdActifTexte",
  "_mdFlux",
  "_ppBlocks",
  "_ppActiveHtml",
  "_ppFlux",
  "isStreaming",
  "_statusLine",
]);

// 0 vide, 1 blancs seulement, 2 du texte : les gabarits testent la vacuité de ces champs (la narration, après `trim()`).
function vacuite(v: unknown): number {
  if (typeof v !== "string" || !v) return 0;
  return v.trim() ? 2 : 1;
}

/** Vrai si le patch ne fait que prolonger l'affichage d'un message en flux qui a son porteur : aucun gabarit du message ne change de branche. */
function leger(cur: MessageChat, p: Objet): boolean {
  if (!cur._flux || !cur.isStreaming || Object.isFrozen(toRaw(cur))) return false;
  for (const k in p) {
    if (!LEGERS.has(k)) return false;
    if (k === "isStreaming") {
      if (!p[k]) return false;
    } else if (k === "_statusLine") {
      if ((p[k] || "") !== (cur._statusLine || "")) return false;
    } else if (TEXTES.has(k) && vacuite(cur[k]) !== vacuite(p[k])) return false;
  }
  return true;
}

// Caractères sans rôle Markdown en milieu de ligne ; début de ligne permis (retrait, citation, puce, numéro) ; amorces de lien automatique.
const SIMPLE = /^[\p{L}\p{M}\p{N} ,.;:!?'"’«»()%+=/-]*$/u;
const DEBUT_LIGNE = /^[ \t]*(?:>[ \t]?)*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?/;
const LETTRE = /\p{L}/u;
const AMORCE_LIEN = /www|https?:|ftp:|:\/\//i;

/** HTML du bloc actif quand `texte` prolonge `base` (le texte dont `html` est le rendu) par des caractères simples sur une ligne déjà visible : l'ajout est inséré avant le curseur, sans analyse ni purification ; `null` s'il faut un rendu. */
export function prolongerActif(html: string, base: string, texte: string): string | null {
  if (!base || texte.length <= base.length || !texte.startsWith(base)) return null;
  const ajout = texte.slice(base.length);
  if (!SIMPLE.test(ajout)) return null;
  const ligne = base.slice(base.lastIndexOf("\n") + 1);
  const corps = ligne.slice(DEBUT_LIGNE.exec(ligne)?.[0].length ?? 0);
  if (!LETTRE.test(corps) || !SIMPLE.test(corps) || AMORCE_LIEN.test(ligne + ajout)) return null;
  const k = html.indexOf(CARET);
  if (k <= 0 || k !== html.lastIndexOf(CARET) || html.charCodeAt(k - 1) === 62 || html.includes("<pre"))
    return null;
  return html.slice(0, k) + ajout + html.slice(k);
}

/** Le porteur suit le message remplacé : recopié tant que le message est en flux, lâché quand il en sort. */
function suivrePorteur(m: MessageChat, creer: boolean): MessageChat {
  if (!m.isStreaming) {
    if (m._flux) m._flux = null;
    return m;
  }
  if (!m._flux && creer) m._flux = creerPorteur();
  if (m._flux) synchroniserPorteur(m._flux, m);
  return m;
}

export function creerRenduFlux(c: CoeurChat) {
  const { r, ctx, e, f, md, l } = c;

  function getStreamMsgs(): MessageChat[] {
    return r.messages.value;
  }

  // Cible des patchs : le dernier assistant en cours (un notice poussé pendant le tour ne la vole pas).
  function streamIdx(msgs: readonly MessageChat[]): number {
    for (let i = msgs.length - 1, n = 0; i >= 0 && n < 4; i--, n++) {
      const m = msgs[i];
      if (m && m.role === "assistant" && m.isStreaming) return i;
    }
    return msgs.length - 1;
  }

  function patch(idx: number, p: Objet): void {
    const msgs = getStreamMsgs();
    const cur = msgs[idx];
    if (idx >= 0 && cur) msgs[idx] = suivrePorteur(Object.assign({}, cur, p), false);
  }

  // Texte qui grandit : écrit sur l'objet brut (lecteurs à jour, aucun gabarit prévenu) et passé au porteur ; sinon le message est remplacé.
  function appliquer(msgs: MessageChat[], idx: number, cur: MessageChat, p: Objet): void {
    if (leger(cur, p)) {
      const brut = toRaw(cur);
      Object.assign(brut, p);
      if (brut._flux) synchroniserPorteur(brut._flux, brut);
      return;
    }
    msgs[idx] = suivrePorteur(Object.assign({}, cur, p), true);
  }

  // Les messages chargés sont gelés : on remplace l'objet à son index (relocalisé par identité).
  function setMsgUi(entry: EntreeAffichee | null | undefined, p: Objet): void {
    const arr = r.messages.value;
    if (!entry || !Array.isArray(arr)) return;
    let i = typeof entry.idx === "number" ? entry.idx : -1;
    if (!(i >= 0 && i < arr.length && arr[i] === entry.msg)) i = arr.indexOf(entry.msg);
    const cur = arr[i];
    if (i >= 0 && cur) arr[i] = suivrePorteur(Object.assign({}, cur, p), false);
  }

  function scrollToBottom(force?: boolean): void {
    if (!e.chatContainer.value || (!force && r.isUserScrolling.value)) return;
    if (force) r.isUserScrolling.value = false;
    l.vsEnsureTail();
    void nextTick(() => {
      const el = e.chatContainer.value;
      if (!el) return;
      ctx._lockAutoScroll?.();
      el.scrollTop = el.scrollHeight;
    });
  }

  // Après un chargement, recolle le bas en plusieurs passes tant que l'utilisateur n'a pas repris la main.
  function settleScrollBottom(): void {
    const chatAuDepart = r.currentChatId.value;
    for (const delai of [80, 250, 600, 1200])
      setTimeout(() => {
        if (r.currentChatId.value !== chatAuDepart) return;
        const el = e.chatContainer.value;
        if (!el || r.isUserScrolling.value) return;
        if (el.scrollHeight - el.scrollTop - el.clientHeight > BAS_PX) {
          ctx._lockAutoScroll?.();
          el.scrollTop = el.scrollHeight;
        }
      }, delai);
  }

  // Champs d'affichage d'un résultat de découpe : listes et état hors de la réactivité (remplacés, jamais modifiés).
  function champsRendu(r: ResultatFlux, P: Prefixe, caret: boolean): Objet {
    const blocs = r.etat.blocs.length ? markRaw(r.etat.blocs as BlocFlux[]) : null;
    return {
      [P + "Blocks"]: blocs,
      [P + "Flux"]: markRaw(r.etat),
      [P + "ActiveHtml"]: caret ? md.injecterCaret(r.actifHtml) : r.actifHtml,
    };
  }

  // Blocs figés une fois par le lexer, bloc actif re-rendu à chaque battement où son texte a changé.
  function applyIncrementalRender(cur: MessageChat, text: string, P: Prefixe, caret = true): Objet {
    const etat = (cur[P + "Flux"] as EtatFlux | null | undefined) ?? null;
    return champsRendu(md.avancerFlux(text, etat), P, caret);
  }

  // Le texte dont le bloc actif est le rendu exact : un rendu de texte fini par un blanc ne le montre pas, le chemin rapide attend le suivant.
  function applyStreamRender(cur: MessageChat, content: string): Objet {
    return Object.assign(
      { content, isStreaming: true, _mdActifTexte: /\s$/.test(content) ? "" : content },
      applyIncrementalRender(cur, content, "_md"),
    );
  }

  function applyPreRender(cur: MessageChat, text: string): Objet {
    return Object.assign({ _pendingPreContent: text }, applyIncrementalRender(cur, text, "_pp", false));
  }

  // Fin du corps (final, Stop) : le bloc actif est figé avec les autres, le message garde ses blocs et lâche son porteur.
  function figerCorps(cur: MessageChat, contenu: string): Objet {
    const r = md.terminerFlux(contenu, (cur._mdFlux as EtatFlux | null | undefined) ?? null);
    return r
      ? Object.assign(champsRendu(r, "_md", false), { _mdActifTexte: "", _modelLoad: null, _flux: null })
      : { ...STREAM_RENDER_CLEAR };
  }

  // ── Battement : une boucle d'images pour les trois tampons et la sortie shell ──
  let image: number | null = null;
  let minuterie: ReturnType<typeof setTimeout> | null = null;
  let actif = false;
  let enCours = false;
  let corpsArme = false;
  let derniereImage = 0;
  let dernierShell = -Infinity;
  let dernierTitre = -Infinity;
  let filCoule: HTMLElement | null = null;
  let dernierTexte = 0;
  let minuterieCaret: ReturnType<typeof setTimeout> | null = null;
  let glisse = false;
  let dernierPas = 0;
  let mqReduit: MediaQueryList | null = null;
  const budget = creerBudget();
  const vCorps = creerVersement();
  const vReflexion = creerVersement();
  const vNarration = creerVersement();

  const maintenant = (): number => performance.now();
  if (getCurrentScope())
    onScopeDispose(() => {
      eteindre();
      finCaret();
    });
  const ongletCache = (): boolean => document.visibilityState === "hidden";

  function besoin(): boolean {
    return (
      !!f.thinkBuf || !!f.preContentBuf || (corpsArme && !!f.streamBuf) || f.shellPend.size > 0 || glisse
    );
  }

  // Liste de requête créée une fois : lue à chaque image du glissé.
  function mouvementReduit(): boolean {
    mqReduit ??=
      typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    return !!mqReduit?.matches;
  }

  // Seule écriture du défilement pendant une réponse : glissé vers le nouveau bas (l'observateur de taille du fil le laisse faire), jamais plus de deux lignes de retard ; immédiat en mouvement réduit et onglet caché.
  function suivreBas(t: number, immediat: boolean): void {
    const dt = glisse ? Math.min(100, Math.max(4, t - dernierPas)) : IMAGE_MS;
    dernierPas = t;
    glisse = false;
    const el = e.chatContainer.value;
    if (el && !r.isUserScrolling.value) {
      ctx._lockAutoScroll?.();
      const haut = el.scrollTop;
      const ecart = el.scrollHeight - el.clientHeight - haut;
      if (immediat || ecart <= 1 || mouvementReduit()) el.scrollTop = el.scrollHeight;
      else {
        const pas = Math.max(1, ecart * (1 - Math.exp(-dt / GLISSE_MS)), ecart - ECART_MAX_PX);
        el.scrollTop = haut + pas;
        glisse = pas < ecart;
      }
    }
    marquerBattement(glisse);
  }

  // Caret plein tant que le corps s'écrit : le fil porte la classe jusqu'à 400 ms après le dernier caractère versé, le CSS fait pulser le caret ensuite.
  function texteVerse(el: HTMLElement | null, t: number): void {
    dernierTexte = t;
    if (el !== filCoule) {
      filCoule?.classList.remove(TEXTE_COULE);
      el?.classList.add(TEXTE_COULE);
      filCoule = el;
    }
    if (filCoule && minuterieCaret === null) minuterieCaret = setTimeout(attenteCaret, CARET_ATTENTE_MS);
  }

  function attenteCaret(): void {
    const reste = dernierTexte + CARET_ATTENTE_MS - maintenant();
    minuterieCaret = null;
    if (reste > 0) minuterieCaret = setTimeout(attenteCaret, reste);
    else finCaret();
  }

  function finCaret(): void {
    if (minuterieCaret !== null) clearTimeout(minuterieCaret);
    minuterieCaret = null;
    filCoule?.classList.remove(TEXTE_COULE);
    filCoule = null;
  }

  function annulerPlanification(): void {
    if (image !== null) cancelAnimationFrame(image);
    if (minuterie !== null) clearTimeout(minuterie);
    image = null;
    minuterie = null;
  }

  // Onglet caché : pas d'images ; une minuterie verse tout d'un coup (la voix continue de lire).
  function planifier(): void {
    if (image !== null || minuterie !== null) return;
    if (ongletCache())
      minuterie = setTimeout(() => {
        minuterie = null;
        void battement(true);
      }, ONGLET_CACHE_MS);
    else
      image = requestAnimationFrame(() => {
        image = null;
        void battement(false);
      });
  }

  function surVisibilite(): void {
    if (image === null && minuterie === null) return;
    annulerPlanification();
    planifier();
  }

  function armer(): void {
    if (!actif) {
      actif = true;
      derniereImage = 0;
      document.addEventListener("visibilitychange", surVisibilite);
    }
    planifier();
  }

  function eteindre(): void {
    annulerPlanification();
    if (actif) document.removeEventListener("visibilitychange", surVisibilite);
    actif = false;
    derniereImage = 0;
    glisse = false;
    marquerBattement(false);
  }

  function eteindreSiInutile(): void {
    if (actif && !enCours && !besoin()) eteindre();
  }

  // Les messages chargés sont gelés : le patch remplace l'objet ; la sortie shell coalesce par étape.
  function construireShell(msgs: readonly MessageChat[]): Map<number, EtapeChat[]> {
    const out = new Map<number, EtapeChat[]>();
    for (const [k, pend] of f.shellPend) {
      const sep = k.lastIndexOf(":");
      const idx = Number(k.slice(0, sep));
      const si = Number(k.slice(sep + 1));
      const base = out.get(idx) ?? msgs[idx]?.toolSteps;
      const st = base?.[si];
      if (!base || !st) continue;
      const steps = [...base];
      steps[si] = {
        ...st,
        shellOut: shellFoldPend(st, pend),
        shellSeq: Math.max(st.shellSeq || 0, pend.seq || 0),
      };
      out.set(idx, steps);
    }
    f.shellPend.clear();
    return out;
  }

  // Réflexion : `force` (arrêt, fin de phase) verse tout le tampon ; le titre d'état est recalculé au plus toutes les 250 ms.
  function verserReflexion(cur: MessageChat, force: boolean, t: number, dt: number): Objet | null {
    if (!f.thinkBuf) return null;
    const take = force ? f.thinkBuf.length : tranche(vReflexion, f.thinkBuf, t, dt);
    if (take <= 0) return null;
    // Réflexion d'un appel précédent déjà posée sur son étape : celle-ci ne s'y ajoute pas.
    const neuve = !!cur._reflexionPosee;
    const fusion = (neuve ? "" : cur.thinking || "") + f.thinkBuf.slice(0, take);
    f.thinkBuf = f.thinkBuf.slice(take);
    if (force || t - dernierTitre >= TITRE_REFLEXION_MS) {
      e.statusText.value = l.thinkingTitle(fusion);
      dernierTitre = t;
    }
    return Object.assign(
      { thinking: fusion },
      cur._thinkingStartedAt && !neuve
        ? {}
        : {
            _thinkingStartedAt: Date.now(),
            _thinkingEndedAt: undefined,
            _thinkingMs: undefined,
            _reflexionPosee: false,
          },
    );
  }

  // Narration d'outils : même versement que le corps ; `force` (fin de phase, Stop) draine tout.
  function verserNarration(cur: MessageChat, force: boolean, t: number, dt: number): Objet | null {
    if (!f.preContentBuf) return null;
    const take = force ? f.preContentBuf.length : tranche(vNarration, f.preContentBuf, t, dt);
    if (take <= 0) return null;
    const complet = (cur._pendingPreContent || "") + f.preContentBuf.slice(0, take);
    f.preContentBuf = f.preContentBuf.slice(take);
    try {
      l.voix().onAssistantToolStream(complet);
    } catch (err) {
      journal.erreur("[voix]", err);
    }
    return Object.assign(applyPreRender(cur, complet), { _statusLine: cur._statusLine || "" });
  }

  function verserCorps(cur: MessageChat, force: boolean, t: number, dt: number): Objet | null {
    if (!f.streamBuf) return null;
    const take = force ? f.streamBuf.length : tranche(vCorps, f.streamBuf, t, dt);
    if (take <= 0) return null;
    const content = (cur.content || "") + f.streamBuf.slice(0, take);
    f.streamBuf = f.streamBuf.slice(take);
    try {
      l.voix().onAssistantStream(content);
    } catch (err) {
      journal.erreur("[voix]", err);
    }
    const html = prolongerActif(cur._mdActiveHtml ?? "", cur._mdActifTexte ?? "", content);
    return html === null
      ? applyStreamRender(cur, content)
      : { content, isStreaming: true, _mdActiveHtml: html, _mdActifTexte: content };
  }

  // Le <pre> de la réflexion en cours : le dernier du fil.
  function preReflexion(): HTMLElement | null {
    const pres = e.chatContainer.value?.querySelectorAll<HTMLElement>(
      "[data-think] pre, [data-reflexion] pre",
    );
    return pres && pres.length ? (pres[pres.length - 1] ?? null) : null;
  }

  // Un battement : réflexion, narration, corps, sortie shell, UNE mise à jour du message (porteur ou remplacement), puis l'écriture de défilement.
  async function executer(force: boolean): Promise<void> {
    const t0 = maintenant();
    const dt = derniereImage ? t0 - derniereImage : IMAGE_MS;
    derniereImage = t0;
    const msgs = getStreamMsgs();
    const idx = streamIdx(msgs);
    const cur = msgs[idx];
    if (idx < 0 || !cur) {
      f.thinkBuf = "";
      f.preContentBuf = "";
      f.streamBuf = "";
      f.shellPend.clear();
      glisse = false;
      return;
    }
    const p: Objet = {};
    const reflexion = verserReflexion(cur, force, t0, dt);
    const narration = verserNarration(cur, force, t0, dt);
    const corps = corpsArme ? verserCorps(cur, force, t0, dt) : null;
    if (reflexion) Object.assign(p, reflexion);
    if (narration) Object.assign(p, narration);
    if (corps) Object.assign(p, corps);
    let shell: Map<number, EtapeChat[]> | null = null;
    if (f.shellPend.size && (force || t0 - dernierShell >= SHELL_FLUSH_MS)) {
      shell = construireShell(msgs);
      dernierShell = t0;
    }
    const steps = shell?.get(idx);
    if (steps) p["toolSteps"] = steps;
    if (!reflexion && !narration && !corps && !shell?.size) {
      if (glisse) suivreBas(t0, force);
      return;
    }
    const pre = reflexion ? preReflexion() : null;
    const colle = !pre || pre.scrollHeight - pre.scrollTop - pre.clientHeight <= BAS_PX;
    if (shell)
      for (const [i, st] of shell) {
        const autre = msgs[i];
        if (i !== idx && autre) msgs[i] = Object.assign({}, autre, { toolSteps: st });
      }
    appliquer(msgs, idx, cur, p);
    if (corps) texteVerse(e.chatContainer.value, t0);
    const suit = !r.isUserScrolling.value && !!e.chatContainer.value;
    if ((narration || corps) && suit) l.vsEnsureTail();
    await nextTick();
    if (reflexion) {
      const apres = preReflexion();
      if (apres && (colle || apres !== pre)) apres.scrollTop = apres.scrollHeight;
    }
    suivreBas(t0, force);
    noterCout(budget, maintenant() - t0);
  }

  async function battement(onglet: boolean): Promise<void> {
    if (enCours) return;
    enCours = true;
    let echec = false;
    try {
      if (!besoin()) return;
      // Image sautée par le budget : rien n'est rendu, le glissé en cours avance quand même.
      const t = maintenant();
      if (!onglet && sauterImage(budget, t)) {
        if (glisse) suivreBas(t, false);
        return;
      }
      await executer(onglet);
    } catch (err) {
      echec = true;
      journal.erreur("[flux] battement", err);
    } finally {
      enCours = false;
      if (!echec && besoin()) planifier();
      else eteindre();
    }
  }

  function flushThinkBuf(): void {
    if (!f.thinkBuf) return;
    const msgs = getStreamMsgs();
    const idx = streamIdx(msgs);
    const cur = msgs[idx];
    const p = idx >= 0 && cur ? verserReflexion(cur, true, maintenant(), IMAGE_MS) : null;
    if (idx < 0 || !cur) f.thinkBuf = "";
    else if (p) appliquer(msgs, idx, cur, p);
  }

  function stopThinkFlush(): void {
    const vide = !f.thinkBuf;
    flushThinkBuf();
    reinitialiserVersement(vReflexion);
    if (!vide) eteindreSiInutile();
  }

  function flushPreContentBuf(force?: boolean): void {
    const msgs = getStreamMsgs();
    const idx = streamIdx(msgs);
    const cur = msgs[idx];
    if (idx < 0 || !cur) {
      f.preContentBuf = "";
      return;
    }
    const p = verserNarration(cur, !!force, maintenant(), IMAGE_MS);
    if (!p) return;
    appliquer(msgs, idx, cur, p);
    if (!r.isUserScrolling.value && e.chatContainer.value) l.vsEnsureTail();
  }

  function stopPreContentFlush(): void {
    const vide = !f.preContentBuf;
    flushPreContentBuf(true);
    reinitialiserVersement(vNarration);
    if (!vide) eteindreSiInutile();
  }

  // Le corps est versé par le battement tant qu'il est armé ; l'arrêt ne vide pas le tampon (l'appelant le lit).
  function armStreamFlush(): void {
    corpsArme = true;
    armer();
  }

  function stopStreamFlush(): void {
    const arme = corpsArme;
    corpsArme = false;
    reinitialiserVersement(vCorps);
    if (arme) eteindreSiInutile();
  }

  function recevoirCorps(texte: string): void {
    f.streamBuf += texte;
    noterArrivee(vCorps, maintenant(), texte.length);
    armStreamFlush();
  }

  function recevoirReflexion(texte: string): void {
    if (!texte) return;
    f.thinkBuf += texte;
    noterArrivee(vReflexion, maintenant(), texte.length);
    armer();
  }

  function recevoirNarration(texte: string): void {
    if (!texte) return;
    f.preContentBuf += texte;
    noterArrivee(vNarration, maintenant(), texte.length);
    armer();
  }

  // Abandon (nouveau tour, remplacement, détachement) : les parties demandées perdent leur tampon et leur armement.
  function abandonnerFlux(parties: PartiesFlux): void {
    if (parties.corps) {
      corpsArme = false;
      f.streamBuf = "";
      reinitialiserVersement(vCorps);
    }
    if (parties.reflexion) {
      f.thinkBuf = "";
      reinitialiserVersement(vReflexion);
    }
    if (parties.narration) {
      f.preContentBuf = "";
      reinitialiserVersement(vNarration);
    }
    if (parties.shell) f.shellPend.clear();
    eteindreSiInutile();
  }

  function shellFoldPend(st: { shellOut?: string | null }, pend: { chunk: string }): string {
    const acc = (st.shellOut || "") + pend.chunk;
    return acc.length > SHELL_MAX ? acc.slice(-SHELL_MAX) : acc;
  }

  // Sortie shell coalescée : un patch par étape et par cadence, jamais un par morceau.
  function flushShellPend(): void {
    const msgs = getStreamMsgs();
    for (const [idx, steps] of construireShell(msgs)) patch(idx, { toolSteps: steps });
    dernierShell = maintenant();
    eteindreSiInutile();
  }

  function armerShell(): void {
    armer();
  }

  return {
    getStreamMsgs,
    streamIdx,
    patch,
    setMsgUi,
    scrollToBottom,
    settleScrollBottom,
    applyStreamRender,
    applyPreRender,
    figerCorps,
    flushThinkBuf,
    stopThinkFlush,
    flushPreContentBuf,
    stopPreContentFlush,
    armStreamFlush,
    stopStreamFlush,
    recevoirCorps,
    recevoirReflexion,
    recevoirNarration,
    abandonnerFlux,
    shellFoldPend,
    flushShellPend,
    armerShell,
  };
}
