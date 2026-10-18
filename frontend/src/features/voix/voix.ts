// SPDX-License-Identifier: MIT
/** frontend/src/features/voix/voix.ts — dictée et lecture dans le chat : énoncés transcrits à la suite du brouillon, lecture phrase par phrase des réponses, garde anti-écho. */
import { computed, ref, watch } from "vue";
import type { Ref } from "vue";

import { voiceCompat } from "./compat.ts";
import type { DiagnosticVoix } from "./compat.ts";
import { createVoicePlayer } from "./lecture.ts";
import type { FetchVocal, LecteurVocal } from "./lecture.ts";
import { createVoiceMic } from "./micro.ts";
import type { EtatMicro, MicroVocal, OptionsMicro } from "./micro.ts";
import { creeSegmenteur } from "./segmenteur.ts";
import type { Segmenteur } from "./segmenteur.ts";

export interface MessageVocal {
  role?: string;
  content?: unknown;
}

export interface ReglagesVocaux {
  voice_input_enabled?: boolean;
  voice_reply_enabled?: boolean;
  voice_reply_tools_enabled?: boolean;
  [cle: string]: unknown;
}

export interface FonctionnalitesVocales {
  voice_stt?: boolean;
  voice_tts?: boolean;
  [cle: string]: unknown;
}

export interface RefsVoix {
  settings?: Ref<ReglagesVocaux | null | undefined>;
  features?: Ref<FonctionnalitesVocales | null | undefined>;
  inputMessage: Ref<string>;
  inputRef?: Ref<{ focus?: () => void } | null | undefined>;
  messages?: Ref<MessageVocal[]>;
}

export interface CtxVoix {
  fetchAuth: FetchVocal;
  showToast(message: string, type?: string): void;
  announce?: (message: string) => void;
  autoResize?: () => void;
  nextTick?: (fn: () => void) => unknown;
  /** Substitutions des tests : micro, diagnostic du navigateur. */
  dependances?: {
    creerMicro?: (options: OptionsMicro) => MicroVocal;
    diagnostic?: () => DiagnosticVoix;
  };
}

interface ContexteEcho {
  suspect: boolean;
  recents: string[];
}

/** Comparaison souple pour la garde d'écho : ponctuation et casse sautent. */
function normalise(t: string | null | undefined): string {
  return (t || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Délai d'une transcription : couvre celui du serveur (10 s + 3 x la durée, jusqu'à 180 s) avec une marge. */
function delaiTranscription(dureeMs: unknown): number {
  const s = (Number(dureeMs) || 0) / 1000;
  return Math.min(210000, Math.max(45000, (30 + 3 * s) * 1000));
}

export function creerVoix(refs: RefsVoix, ctx: CtxVoix) {
  const { settings, features, inputMessage, inputRef, messages } = refs;
  const { fetchAuth, showToast } = ctx;

  const voiceState = ref<EtatMicro>("arrete");
  const voiceLevel = ref(0);
  const voiceBusy = ref(false);
  const voiceReading = ref(false);
  const voiceReadingIdx = ref(-1);

  let micro: MicroVocal | null = null;
  let lecteur: LecteurVocal | null = null;
  let segmenteur: Segmenteur | null = null;
  let segmenteurOutils: Segmenteur | null = null;
  let repriseMicro: ReturnType<typeof setTimeout> | null = null;
  let ancre = -1;
  let dernierInsere = "";
  let luPrincipal = "";
  let luOutils = "";
  let aDitCeTour = false;
  let muetCeTour = false;

  // Verrou synchrone posé avant tout await : un double-clic créerait deux micros dont le premier ne pourrait plus être arrêté.
  let demarrageEnCours = false;
  let demarrageAnnule = false;
  let seance = 0;
  let prochainNumero = 0;
  let prochainAInserer = 0;
  let resultats = new Map<number, string | null>();
  let enVol = 0;

  const compat = (ctx.dependances?.diagnostic ?? voiceCompat)();
  const microDisponible = compat.dictee.ok;
  const lectureDisponible = compat.lecture.ok;

  const voiceCanDictate = computed(
    () => !!(microDisponible && features?.value?.voice_stt && settings?.value?.voice_input_enabled),
  );
  const voiceCanRead = computed(() => !!(lectureDisponible && features?.value?.voice_tts));
  const voiceAutoRead = computed(() => !!(voiceCanRead.value && settings?.value?.voice_reply_enabled));
  const voiceAutoReadTools = computed(
    () => !!(voiceAutoRead.value && settings?.value?.voice_reply_tools_enabled),
  );

  function joueur(): LecteurVocal {
    if (lecteur) return lecteur;
    const p = createVoicePlayer({
      fetchAuth,
      onState: (actif) => {
        voiceReading.value = actif;
        if (!actif && !(lecteur && lecteur.estActif())) voiceReadingIdx.value = -1;
        if (!micro) return;
        if (actif) {
          if (repriseMicro) {
            clearTimeout(repriseMicro);
            repriseMicro = null;
          }
          micro.suspend();
        } else {
          // 400 ms : le temps que la queue de réverbération retombe.
          repriseMicro = setTimeout(() => {
            repriseMicro = null;
            if (micro && voiceState.value !== "arrete") micro.resume();
          }, 400);
        }
      },
      onError: (message) => showToast(message, "error"),
    });
    lecteur = p;
    return p;
  }

  function speakMessage(idx: number, texte: unknown): void {
    if (!voiceCanRead.value) return;
    if (voiceReadingIdx.value === idx) {
      stopSpeaking();
      return;
    }
    const p = joueur();
    p.stop();
    const seg = creeSegmenteur({ premier: 60, suivant: 200 });
    const morceaux = seg.push(String(texte || "")).concat(seg.flush());
    if (!morceaux.length) {
      showToast("Rien à lire dans ce message.");
      return;
    }
    voiceReadingIdx.value = idx;
    for (const m of morceaux) p.enqueue(m, false);
  }

  function stopSpeaking(): void {
    if (lecteur) lecteur.stop();
    voiceReadingIdx.value = -1;
  }

  /** Met des morceaux en file et retient qu'on a parlé ce tour. */
  function dis(morceaux: string[] | null | undefined): void {
    if (muetCeTour || !morceaux || !morceaux.length) return;
    const p = joueur();
    for (const m of morceaux) p.enqueue(m, true);
    aDitCeTour = true;
  }

  /** Dernier message assistant affiché : une reprise prolonge son texte, déjà lu. */
  function texteAssistantAffiche(): string {
    const liste = messages?.value;
    if (!Array.isArray(liste)) return "";
    for (let i = liste.length - 1; i >= 0; i--) {
      const m = liste[i];
      if (m && m.role === "assistant") return String(m.content || "");
      if (m && m.role === "user") return "";
    }
    return "";
  }

  function onAssistantStart(reprise?: boolean): void {
    segmenteur = null;
    segmenteurOutils = null;
    luPrincipal = "";
    luOutils = "";
    aDitCeTour = false;
    muetCeTour = false;
    if (!voiceAutoRead.value) return;
    segmenteur = creeSegmenteur({ premier: 40, suivant: 160 });
    if (reprise) luPrincipal = texteAssistantAffiche();
    joueur().nouvelleGeneration();
  }

  /** Le corps de la réponse, au rythme du rendu. */
  function onAssistantStream(texteAccumule: unknown): void {
    if (!voiceAutoRead.value || !segmenteur) return;
    const tout = String(texteAccumule || "");
    if (tout.indexOf(luPrincipal) !== 0) {
      // Corps réécrit (reprise, régénération) : on se recale sans relire ce qui a déjà été prononcé.
      luPrincipal = tout;
      return;
    }
    const delta = tout.slice(luPrincipal.length);
    if (!delta) return;
    luPrincipal = tout;
    dis(segmenteur.push(delta));
  }

  /** Ce que l'assistant annonce avant un appel d'outil : tampon distinct, remis à zéro à chaque tour d'outil. */
  function onAssistantToolStream(texteAccumule: unknown): void {
    if (!voiceAutoReadTools.value || muetCeTour) return;
    const tout = String(texteAccumule || "");
    if (!segmenteurOutils) segmenteurOutils = creeSegmenteur({ premier: 40, suivant: 160 });
    if (tout.indexOf(luOutils) !== 0) {
      // Nouveau tour d'outil : on vide le reste du précédent avant d'enchaîner.
      dis(segmenteurOutils.flush());
      luOutils = "";
    }
    const delta = tout.slice(luOutils.length);
    if (!delta) return;
    luOutils = tout;
    dis(segmenteurOutils.push(delta));
  }

  function onAssistantFinal(texteComplet: unknown, annule?: boolean): void {
    const finOutils = segmenteurOutils;
    segmenteurOutils = null;
    // Une génération interrompue ne se lit pas : l'utilisateur vient de demander le silence.
    if (annule) {
      segmenteur = null;
      luPrincipal = "";
      luOutils = "";
      stopSpeaking();
      return;
    }
    if (finOutils) dis(finOutils.flush());
    if (!voiceAutoRead.value || !segmenteur) {
      segmenteur = null;
      return;
    }
    const tout = String(texteComplet || "");
    if (luPrincipal && tout.indexOf(luPrincipal) === 0) {
      dis(segmenteur.push(tout.slice(luPrincipal.length)));
    } else if (!aDitCeTour) {
      // Rien n'a été prononcé du tour : réponse courte arrivée d'un bloc.
      dis(segmenteur.push(tout));
    }
    // Sinon rien : le texte du serveur ne s'aligne pas sur ce qui a été dit, une fin muette vaut mieux qu'une réponse répétée.
    dis(segmenteur.flush());
    segmenteur = null;
    luPrincipal = "";
    luOutils = "";
  }

  function insere(texte: string): void {
    const courant = String(inputMessage.value || "");
    if (ancre < 0 || ancre > courant.length) ancre = courant.length;
    // Si la dernière insertion n'est plus à l'endroit attendu, on se ré-ancre à la fin plutôt que d'écraser la frappe.
    if (dernierInsere && courant.slice(ancre - dernierInsere.length, ancre) !== dernierInsere) {
      ancre = courant.length;
    }
    const avant = courant.slice(0, ancre);
    const apres = courant.slice(ancre);
    const separateur = avant && !/\s$/.test(avant) ? " " : "";
    const ajout = separateur + texte;
    inputMessage.value = avant + ajout + apres;
    ancre += ajout.length;
    dernierInsere = ajout;
    // Une écriture programmatique ne déclenche pas `autoResize` : la zone resterait sur une ligne.
    if (ctx.nextTick) {
      ctx.nextTick(() => {
        if (ctx.autoResize) ctx.autoResize();
      });
    } else if (ctx.autoResize) {
      ctx.autoResize();
    }
  }

  /** Insère, dans l'ordre de parole, tout ce qui est arrivé ; un énoncé jeté occupe son rang avec `null`. */
  function vide(): void {
    while (resultats.has(prochainAInserer)) {
      const texte = resultats.get(prochainAInserer);
      resultats.delete(prochainAInserer);
      prochainAInserer++;
      if (texte) insere(texte);
    }
  }

  function nouvelleSeance(): void {
    seance++;
    prochainNumero = 0;
    prochainAInserer = 0;
    resultats = new Map();
  }

  /** Garde d'écho textuelle : un énoncé commencé moins de 800 ms après une lecture et contenu dans ce qui a été dit n'est pas de l'utilisateur. */
  function estEcho(texte: string, contexte: ContexteEcho | null): boolean {
    if (!contexte || !contexte.suspect) return false;
    const entendu = normalise(texte);
    if (!entendu) return false;
    return normalise(contexte.recents.join(" ")).indexOf(entendu) >= 0;
  }

  /** Coupe la dictée sur une panne du service : un seul message, le micro n'envoie pas dans le vide. */
  function panneDictee(message: string, maSeance: number): void {
    if (maSeance !== seance) return;
    showToast(message, "error");
    nouvelleSeance();
    void arrete(false);
  }

  async function surEnonce(blob: Blob, dureeMs: number): Promise<void> {
    const maSeance = seance;
    const numero = prochainNumero++;
    // Contexte d'écho figé à la fin de l'énoncé, pas au retour.
    let echo: ContexteEcho | null = null;
    if (lecteur) {
      const fin = lecteur.finiDepuis();
      echo = {
        suspect: fin < (Number(dureeMs) || 0) + 800,
        recents: lecteur.textesRecents ? lecteur.textesRecents() : [lecteur.dernierTexte()],
      };
    }
    const formulaire = new FormData();
    formulaire.append("file", blob, "dictee.wav");
    enVol++;
    voiceBusy.value = true;
    const abandon = new AbortController();
    let expire = false;
    const minuteur = setTimeout(() => {
      expire = true;
      abandon.abort();
    }, delaiTranscription(dureeMs));
    let texte: string | null = null;
    try {
      let r;
      try {
        r = await fetchAuth(
          "/api/voice/transcribe",
          { method: "POST", body: formulaire, signal: abandon.signal, rethrowAbort: true },
          true,
        );
      } catch {
        panneDictee(
          expire ? "Le moteur de dictée ne répond pas. Dictée arrêtée." : "Dictée interrompue.",
          maSeance,
        );
        return;
      }
      if (!r) {
        panneDictee("Moteur de dictée injoignable. Dictée arrêtée.", maSeance);
        return;
      }
      if (!r.ok) {
        let message = "Transcription impossible.";
        try {
          const j = (await r.json()) as { detail?: unknown } | null;
          if (j && j.detail) message = String(j.detail);
        } catch {
          /* corps non JSON */
        }
        // Un énoncé refusé pour lui-même (trop long, format) n'est pas une panne ; tout le reste arrête la dictée.
        if (r.status === 400 || r.status === 413 || r.status === 415) {
          if (maSeance === seance) showToast(message, "error");
        } else {
          panneDictee(`${message} Dictée arrêtée.`, maSeance);
        }
        return;
      }
      const j = (await r.json()) as { text?: unknown; duration_ms?: unknown; rejected?: unknown } | null;
      const t = String((j && j.text) || "").trim();
      if (!t) {
        // Le serveur répond 200 avec un texte vide pour un énoncé inexploitable : on le dit seulement sur une phrase d'une seconde ou plus.
        const ms = Number(j && j.duration_ms) || 0;
        const raison = j && j.rejected;
        if (maSeance === seance && raison && raison !== "trop court" && ms >= 1000) {
          showToast("Phrase non reconnue. Parlez un peu plus près du micro.");
        }
        return;
      }
      if (estEcho(t, echo)) return;
      texte = t;
    } catch (e) {
      panneDictee(`Transcription impossible : ${e instanceof Error ? e.message : String(e)}`, maSeance);
    } finally {
      clearTimeout(minuteur);
      enVol = Math.max(0, enVol - 1);
      voiceBusy.value = enVol > 0;
      if (maSeance === seance) {
        resultats.set(numero, texte);
        vide();
      }
    }
  }

  /** Plafonds du serveur, relus à chaque démarrage : un changement dans la console vaut sans recharger. */
  async function chargePlafonds(): Promise<{ maxUtteranceSec: number; sampleRate: number }> {
    try {
      const r = await fetchAuth("/api/voice/status", {}, true);
      if (r && r.ok) {
        const j = (await r.json()) as { max_utterance_sec?: unknown; sample_rate?: unknown };
        return {
          maxUtteranceSec: Number(j.max_utterance_sec) || 30,
          sampleRate: Number(j.sample_rate) || 16000,
        };
      }
    } catch {
      /* le défaut du module reste valable */
    }
    return { maxUtteranceSec: 30, sampleRate: 16000 };
  }

  let vu: HTMLElement | null = null;
  function poseNiveau(v: number): void {
    if (!vu || !vu.isConnected) vu = document.getElementById("voice-vu");
    if (vu) vu.style.width = `${(2 + v * 14).toFixed(1)}px`;
  }

  function creeMicro(reglages: { maxUtteranceSec: number; sampleRate: number }): MicroVocal {
    return (ctx.dependances?.creerMicro ?? createVoiceMic)({
      sampleRate: reglages.sampleRate,
      maxUtteranceSec: reglages.maxUtteranceSec,
      onUtterance: surEnonce,
      onLevel: poseNiveau,
      onState: (e) => {
        voiceState.value = e;
        if (e === "arrete") poseNiveau(0);
      },
      onError: (message) => {
        showToast(message, "error");
        // Une erreur du micro n'arrête que la dictée : la lecture en cours n'y est pour rien.
        nouvelleSeance();
        void arrete(false);
      },
    });
  }

  async function toggleDictation(): Promise<void> {
    if (!voiceCanDictate.value || demarrageEnCours) return;
    if (voiceState.value !== "arrete") {
      await arrete(true);
      return;
    }
    demarrageEnCours = true;
    demarrageAnnule = false;
    try {
      // Une dictée qui démarre pendant une lecture coupe la voix : c'est un « laisse-moi parler ».
      if (lecteur && lecteur.estActif()) stopSpeaking();
      const reglages = await chargePlafonds();
      if (demarrageAnnule) return;
      micro = creeMicro(reglages);
      ancre = String(inputMessage.value || "").length;
      dernierInsere = "";
      await micro.start();
    } finally {
      demarrageEnCours = false;
    }
    if (voiceState.value !== "arrete" && ctx.announce) ctx.announce("Dictée activée");
    if (inputRef?.value?.focus) {
      try {
        inputRef.value.focus();
      } catch {
        /* champ retiré du DOM */
      }
    }
  }

  async function arrete(emettreLeReste: boolean): Promise<void> {
    if (repriseMicro) {
      clearTimeout(repriseMicro);
      repriseMicro = null;
    }
    if (micro) await micro.stop(!!emettreLeReste);
    poseNiveau(0);
  }

  /** Coupe la dictée seule, à l'envoi du message ; ce qui est encore en transcription est abandonné. */
  function stopDictation(): void {
    if (voiceState.value === "arrete" && !demarrageEnCours) return;
    if (demarrageEnCours) demarrageAnnule = true;
    nouvelleSeance();
    void arrete(false);
  }

  /** Coupe tout, dictée et lecture (déconnexion, changement de conversation). */
  function cancelVoice(): void {
    nouvelleSeance();
    void arrete(false);
    stopSpeaking();
    segmenteur = null;
    segmenteurOutils = null;
    muetCeTour = true;
  }

  /** Échap : d'abord la voix qui parle, puis au second Échap le micro ; vrai si quelque chose a été interrompu. */
  function voiceEscape(): boolean {
    if (voiceReading.value || voiceReadingIdx.value >= 0 || (lecteur && lecteur.estActif())) {
      stopSpeaking();
      segmenteur = null;
      segmenteurOutils = null;
      muetCeTour = true;
      return true;
    }
    if (voiceState.value !== "arrete") {
      void arrete(true);
      return true;
    }
    return false;
  }

  // Décocher « Dictée » pendant une dictée : le bouton disparaît, le micro doit s'arrêter avec lui.
  watch(voiceCanDictate, (possible) => {
    if (!possible && voiceState.value !== "arrete") void arrete(false);
  });

  let arreteeCache = false;
  const surVisibilite = (): void => {
    if (document.hidden && voiceState.value !== "arrete") {
      arreteeCache = true;
      void arrete(true);
    } else if (!document.hidden && arreteeCache) {
      arreteeCache = false;
      showToast("Dictée arrêtée : l’onglet était masqué.");
    }
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", surVisibilite);

  return {
    voiceState,
    voiceLevel,
    voiceBusy,
    voiceReading,
    voiceReadingIdx,
    voiceCanDictate,
    voiceCanRead,
    voiceAutoRead,
    voiceMicAvailable: microDisponible,
    toggleDictation,
    stopDictation,
    cancelVoice,
    voiceEscape,
    speakMessage,
    stopSpeaking,
    onAssistantStart,
    onAssistantStream,
    onAssistantToolStream,
    onAssistantFinal,
    _creeSegmenteur: creeSegmenteur,
    _liberer: (): void => {
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", surVisibilite);
    },
  };
}

export type SurfaceVoix = ReturnType<typeof creerVoix>;
