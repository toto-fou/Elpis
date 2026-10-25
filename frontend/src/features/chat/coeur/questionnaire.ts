// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/questionnaire.ts — questionnaire de l'outil `ask_user` (porté d'`app-chat.js`) : questions normalisées au `tool_call`, panneau ouvert à la fin du tour, réponses envoyées en un message. */
import { computed } from "vue";

import type { QuestionAsk } from "./etat.ts";
import { focaliserSaisie } from "./envoi.ts";
import type { CoeurChat } from "./liens.ts";

/** Questions de l'outil (8 au plus, 12 options chacune), ou null. */
export function normaliserQuestions(raw: unknown): QuestionAsk[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const items = (raw as unknown[]).slice(0, 8).map((x): QuestionAsk => {
    const o = (x && typeof x === "object" ? x : {}) as {
      q?: unknown;
      question?: unknown;
      options?: unknown;
      multi?: unknown;
    };
    return {
      q: String(o.q || o.question || "")
        .trim()
        .slice(0, 300),
      options: Array.isArray(o.options)
        ? (o.options as unknown[]).slice(0, 12).map((v) => String(v).slice(0, 120))
        : [],
      multi: !!o.multi,
      _sel: [],
      _free: "",
    };
  });
  const retenues = items.filter((x) => x.q);
  return retenues.length ? retenues : null;
}

/** `menuOuvert` : un menu « / » ou « @ » est ouvert sous la saisie, il reçoit les touches avant le questionnaire. */
export function creerQuestionnaire(c: CoeurChat, menuOuvert: () => boolean = () => false) {
  const { r, ctx, e, f, l } = c;
  const askUserCurrent = computed(() => {
    const p = e.askUserPanel.value;
    return p ? (p.items[p.idx] ?? null) : null;
  });

  // Un questionnaire en attente meurt avec le tour ; le brouillon mis de côté revient dans la zone, ouvert ou non.
  function resetAskUser(): void {
    f.pendingAskUser = null;
    const p = e.askUserPanel.value;
    e.askUserPanel.value = null;
    if (!p) return;
    if (p.ouvert) {
      r.inputMessage.value = p.brouillon;
      return;
    }
    const brouillon = p.brouillon.trim() ? p.brouillon : (f.composeRestoreDraft ?? "");
    f.composeRestoreDraft = null;
    if (!brouillon.trim()) return;
    r.inputMessage.value = r.inputMessage.value.trim() ? `${brouillon}\n${r.inputMessage.value}` : brouillon;
  }

  // Le texte de la zone devient le champ libre de la question courante.
  function noterZone(): void {
    const qq = askUserCurrent.value;
    if (qq) qq._free = r.inputMessage.value;
  }

  // Ouvre (ou rouvre) le questionnaire : le texte du composeur est mis de côté (ajouté à un brouillon existant), la zone reçoit le champ libre.
  function ouvrirPanneau(seulSiLibre: boolean): void {
    const p = e.askUserPanel.value;
    if (!p || p.ouvert) return;
    if (f.composeRestoreDraft !== null && !p.brouillon.trim()) p.brouillon = f.composeRestoreDraft;
    f.composeRestoreDraft = null;
    const zone = r.inputMessage.value;
    if (zone.trim() && zone !== p.items[p.idx]?._free)
      p.brouillon = p.brouillon.trim() ? `${p.brouillon}\n${zone}` : zone;
    p.ouvert = true;
    r.inputMessage.value = p.items[p.idx]?._free ?? "";
    focaliserSaisie(c, seulSiLibre);
  }

  function rouvrirAskUser(): void {
    ouvrirPanneau(false);
  }

  // Ouverture en fin de tour : le focus n'est pris que s'il n'est pas ailleurs dans la page.
  function ouvrirAskUser(items: QuestionAsk[]): void {
    e.askUserPanel.value = { items, idx: 0, ouvert: false, brouillon: "" };
    ouvrirPanneau(true);
  }

  // Nombre de questions déjà répondues (option ou texte libre).
  const askUserRepondues = computed(() => {
    const p = e.askUserPanel.value;
    if (!p) return 0;
    return p.items.filter(
      (qq, i) => qq._sel.length || (i === p.idx && p.ouvert ? r.inputMessage.value : qq._free).trim(),
    ).length;
  });

  function isAskOptionOn(opt: string): boolean {
    const qq = askUserCurrent.value;
    return !!qq && qq._sel.includes(opt);
  }

  function toggleAskOption(opt: string): void {
    const qq = askUserCurrent.value;
    if (!qq) return;
    const i = qq._sel.indexOf(opt);
    if (i >= 0) qq._sel.splice(i, 1);
    else {
      if (!qq.multi) qq._sel.length = 0;
      qq._sel.push(opt);
    }
  }

  // Change de question : la zone passe dans le champ libre quitté, et reçoit celui de la question atteinte.
  function aller(delta: number): void {
    const p = e.askUserPanel.value;
    const cible = p?.items[p.idx + delta];
    if (!p || !cible) return;
    noterZone();
    p.idx += delta;
    r.inputMessage.value = cible._free;
    focaliserSaisie(c);
  }

  function askUserPrev(): void {
    aller(-1);
  }

  // Suivant, ou envoi groupé sur la dernière question.
  function askUserNext(): void {
    const p = e.askUserPanel.value;
    if (!p) return;
    if (p.idx < p.items.length - 1) aller(1);
    else submitAskUser();
  }

  // Ferme le questionnaire en gardant les réponses ; la zone garde le texte tapé (le brouillon revient après son envoi), sinon reprend le brouillon.
  function dismissAskUser(): void {
    const p = e.askUserPanel.value;
    if (!p || !p.ouvert) return;
    noterZone();
    p.ouvert = false;
    if (!r.inputMessage.value.trim()) r.inputMessage.value = p.brouillon;
    else if (p.brouillon.trim()) f.composeRestoreDraft = p.brouillon;
    p.brouillon = "";
    focaliserSaisie(c);
  }

  // Chiffres, Entrée, Échap du questionnaire ouvert ; vrai si la touche est prise (composition IME et Échap déjà consommé compris).
  function askUserKeydown(ev: KeyboardEvent): boolean {
    const p = e.askUserPanel.value;
    if (!p?.ouvert || ev.defaultPrevented) return false;
    if (ev.isComposing || ev.keyCode === 229) return true;
    if (ev.key === "Escape" && (ev as KeyboardEvent & { _elpisEchapPris?: boolean })._elpisEchapPris)
      return true;
    const cible = ev.target as HTMLElement | null;
    const zone = cible?.tagName === "TEXTAREA";
    if (!zone && !cible?.closest?.("[data-ask-bloc]")) return false;
    if (menuOuvert()) return false;
    if (/^[1-9]$/.test(ev.key) && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const opt = askUserCurrent.value?.options?.[Number(ev.key) - 1];
      if (opt === undefined || (zone && r.inputMessage.value !== "")) return false;
      ev.preventDefault();
      toggleAskOption(opt);
      return true;
    }
    if (ev.key === "Enter") {
      if (!zone || ev.ctrlKey || ev.metaKey) return false;
      if (ev.shiftKey) return true;
      ev.preventDefault();
      askUserNext();
      return true;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      dismissAskUser();
      return true;
    }
    return false;
  }

  // Le message est composé des réponses ; le brouillon mis de côté revient après l'envoi.
  function submitAskUser(): void {
    const p = e.askUserPanel.value;
    if (!p) return;
    if (r.isStreaming.value) {
      ctx.showToast("Réponse en cours : envoi possible une fois terminée", "info");
      return;
    }
    noterZone();
    const lignes: string[] = [];
    for (const qq of p.items) {
      const parts = [...(qq._sel || [])];
      if ((qq._free || "").trim()) parts.push(qq._free.trim());
      if (parts.length) lignes.push(`**${qq.q}**  \n${parts.join(" ; ")}`);
    }
    if (!lignes.length) {
      ctx.showToast("Réponds à au moins une question", "info");
      return;
    }
    f.composeRestoreDraft = p.brouillon.trim() ? p.brouillon : null;
    f.envoiQuestionnaire = true;
    r.inputMessage.value = lignes.join("\n\n");
    // Ni le mode Images ni un brouillon resté en route ne passent à l'envoi suivant.
    void Promise.resolve(l.sendMessage()).finally(() => {
      f.envoiQuestionnaire = false;
      f.composeRestoreDraft = null;
    });
  }

  return {
    askUserCurrent,
    resetAskUser,
    ouvrirAskUser,
    rouvrirAskUser,
    askUserKeydown,
    askUserRepondues,
    isAskOptionOn,
    toggleAskOption,
    askUserPrev,
    askUserNext,
    dismissAskUser,
    submitAskUser,
  };
}
