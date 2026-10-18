// SPDX-License-Identifier: MIT
/** frontend/src/features/voix/lecture.ts — lecture des réponses en file : synthèses demandées au plus deux à la fois, jouées sans trou ni chevauchement, arrêt en fondu. */

export interface ReponseVocale {
  ok: boolean;
  status: number;
  blob(): Promise<Blob>;
  json(): Promise<unknown>;
}

export type FetchVocal = (
  url: string,
  init: RequestInit & { rethrowAbort?: boolean },
  soft?: boolean,
) => Promise<ReponseVocale | null>;

export interface ContexteLecteur {
  fetchAuth: FetchVocal;
  onState?: (actif: boolean) => unknown;
  onError?: (message: string) => unknown;
}

export interface LecteurVocal {
  enqueue(texte: string, auto?: boolean): void;
  stop(): void;
  nouvelleGeneration(): number;
  estActif(): boolean;
  dernierTexte(): string;
  textesRecents(): string[];
  finiDepuis(): number;
}

interface ElementFile {
  texte: string;
  auto: boolean;
  gen: number;
  promesse: Promise<Blob> | null;
  abandon: AbortController | null;
}

/** Une coupure nette fait un clic : 60 ms de fondu l'effacent. */
const FONDU_MS = 60;
const FONDU_PAS = 4;
/** Une synthèse qui ne revient pas figerait la file : 20 s, c'est une panne. */
const DELAI_SYNTHESE_MS = 20000;
/** Recouvrement borné : la requête d'une phrase part pendant que la précédente est lue, pas plus de deux en vol. */
const MAX_EN_VOL = 2;

function estAbandon(e: unknown): boolean {
  return !!(e && (e as { name?: string }).name === "AbortError");
}

class ErreurLecture extends Error {
  statut?: number;
}

export function createVoicePlayer(ctx: ContexteLecteur): LecteurVocal {
  const fetchAuth = ctx.fetchAuth;
  const onState = ctx.onState || (() => undefined);
  const onError = ctx.onError || (() => undefined);

  let file: ElementFile[] = [];
  let generation = 0;
  let actif = false;
  let pompeEnCours = false;
  let audio: HTMLAudioElement | null = null;
  let urlCourante: string | null = null;
  let minuteurFondu: ReturnType<typeof setInterval> | null = null;
  let dernierTexte = "";
  let finAt = 0;
  // Résolution du clip en cours : `pause()` ne déclenche pas `ended`, sans cette poignée un Stop laissait la file suspendue.
  let finJeu: (() => void) | null = null;
  const recents: string[] = [];

  function termineJeu(): void {
    const f = finJeu;
    finJeu = null;
    if (f) f();
  }

  function pose(nouvel: boolean): void {
    if (actif === nouvel) return;
    actif = nouvel;
    if (!nouvel) finAt = Date.now();
    try {
      void onState(actif);
    } catch {
      /* l'appelant ne doit pas nous casser */
    }
  }

  function abandonneTout(): void {
    for (const e of file) {
      if (e.abandon) {
        try {
          e.abandon.abort();
        } catch {
          /* déjà abandonnée */
        }
      }
    }
    file = [];
  }

  function libere(): void {
    if (urlCourante) {
      try {
        URL.revokeObjectURL(urlCourante);
      } catch {
        /* URL déjà libérée */
      }
      urlCourante = null;
    }
  }

  function alimente(): void {
    let enVol = 0;
    for (let i = 0; i < file.length && enVol < MAX_EN_VOL; i++) {
      const e = file[i];
      if (e && !e.promesse) demande(e);
      enVol++;
    }
  }

  function demande(element: ElementFile): void {
    const abandon = new AbortController();
    element.abandon = abandon;
    let expire = false;
    const minuteur = setTimeout(() => {
      expire = true;
      abandon.abort();
    }, DELAI_SYNTHESE_MS);
    element.promesse = (async (): Promise<Blob> => {
      let r: ReponseVocale | null;
      try {
        // `rethrowAbort` : sinon fetchAuth avale l'abandon en « Erreur réseau » (deux toasts à chaque Échap).
        r = await fetchAuth(
          "/api/voice/speak",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: element.texte, auto: !!element.auto }),
            signal: abandon.signal,
            rethrowAbort: true,
          },
          true,
        );
      } catch (e) {
        if (expire) throw new Error("Le moteur de lecture ne répond pas.", { cause: e });
        throw e;
      } finally {
        clearTimeout(minuteur);
      }
      if (!r) throw new Error("Lecture impossible : réseau indisponible ou session expirée.");
      if (!r.ok) {
        let message = "Lecture impossible.";
        try {
          const j = (await r.json()) as { detail?: unknown } | null;
          if (j && j.detail) message = String(j.detail);
        } catch {
          /* corps non JSON */
        }
        const err = new ErreurLecture(message);
        err.statut = r.status;
        throw err;
      }
      try {
        return await r.blob();
      } catch (e) {
        if (expire) throw new Error("Le moteur de lecture ne répond pas.", { cause: e });
        throw e;
      }
    })();
    // Sans ce puits, une requête abandonnée remonte en « unhandled rejection » à chaque Échap.
    element.promesse.catch(() => undefined);
  }

  function joue(blob: Blob): Promise<void> {
    return new Promise<void>((resolve) => {
      libere();
      finJeu = resolve;
      urlCourante = URL.createObjectURL(blob);
      if (!audio) audio = new Audio();
      audio.onended = termineJeu;
      audio.onerror = termineJeu;
      audio.volume = 1;
      audio.src = urlCourante;
      const p = audio.play() as Promise<void> | undefined;
      void p?.catch((e: unknown) => {
        // Lecture refusée faute de geste utilisateur (réponse vocale activée avant toute interaction).
        if (!estAbandon(e)) {
          void onError("Lecture bloquée par le navigateur : cliquez dans la page, puis réessayez.");
        }
        termineJeu();
      });
    });
  }

  async function pompe(): Promise<void> {
    if (pompeEnCours) return;
    pompeEnCours = true;
    try {
      while (file.length) {
        alimente();
        const element = file[0];
        if (!element) break;
        if (element.gen !== generation) {
          file.shift();
          continue;
        }
        let blob: Blob;
        try {
          blob = await (element.promesse as Promise<Blob>);
        } catch (e) {
          // La file a pu être remplacée pendant l'attente : on ne touche qu'à notre élément.
          if (file[0] === element) file.shift();
          if (element.gen === generation && !estAbandon(e)) {
            void onError((e instanceof Error && e.message) || "Lecture impossible.");
            // Une panne du service vaut pour toute la réponse : pas un toast par phrase.
            abandonneTout();
          }
          continue;
        }
        if (file[0] !== element) continue;
        file.shift();
        if (element.gen !== generation) continue;
        pose(true);
        dernierTexte = element.texte;
        recents.push(element.texte);
        if (recents.length > 3) recents.shift();
        await joue(blob);
      }
    } finally {
      pompeEnCours = false;
      libere();
      pose(false);
    }
  }

  return {
    /** Met un morceau en file ; `auto` distingue la lecture automatique du clic sur « lire ». */
    enqueue(texte, auto) {
      const t = (texte || "").trim();
      if (!t) return;
      file.push({ texte: t, auto: !!auto, gen: generation, promesse: null, abandon: null });
      alimente();
      void pompe();
    },
    /** Coupe tout : file vidée, requêtes abandonnées, fondu de sortie. */
    stop() {
      generation++;
      abandonneTout();
      if (!audio || audio.paused) {
        // `play()` peut être encore en attente : le clip n'a pas démarré mais `pompe()` l'attend déjà.
        try {
          if (audio) audio.pause();
        } catch {
          /* élément déjà libéré */
        }
        termineJeu();
        pose(false);
        return;
      }
      if (minuteurFondu) {
        clearInterval(minuteurFondu);
        minuteurFondu = null;
      }
      const pas = audio.volume / FONDU_PAS;
      const minuteur = setInterval(
        () => {
          if (!audio) {
            clearInterval(minuteur);
            minuteurFondu = null;
            return;
          }
          audio.volume = Math.max(0, audio.volume - pas);
          if (audio.volume <= 0.001) {
            clearInterval(minuteur);
            minuteurFondu = null;
            try {
              audio.pause();
            } catch {
              /* élément déjà libéré */
            }
            audio.volume = 1;
            termineJeu();
            libere();
            pose(false);
          }
        },
        Math.round(FONDU_MS / FONDU_PAS),
      );
      minuteurFondu = minuteur;
    },
    /** Invalide ce qui est en file sans couper la lecture en cours (réponse régénérée). */
    nouvelleGeneration() {
      generation++;
      abandonneTout();
      return generation;
    },
    estActif: () => actif || file.length > 0,
    dernierTexte: () => dernierTexte,
    textesRecents: () => recents.slice(),
    finiDepuis: () => (actif ? 0 : Date.now() - finAt),
  };
}
