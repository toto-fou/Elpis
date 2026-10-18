// SPDX-License-Identifier: MIT
/** frontend/src/features/voix/micro.ts — micro, détection de parole et WAV : découpe ce qui est dit en énoncés (entre deux silences) rendus en WAV 16 kHz mono, le format attendu par whisper. */
import { voiceCompat } from "./compat.ts";

export type EtatMicro = "arrete" | "demarrage" | "calibrage" | "ecoute" | "parole" | "suspendu";

export interface OptionsMicro {
  sampleRate?: number;
  silenceMs?: number;
  minUtteranceMs?: number;
  maxUtteranceSec?: number;
  prerollMs?: number;
  onUtterance?: (wav: Blob, dureeMs: number, raison: string) => unknown;
  onLevel?: (rms01: number) => unknown;
  onState?: (etat: EtatMicro) => unknown;
  onError?: (message: string) => unknown;
}

export interface InfosMicro {
  etat: EtatMicro;
  bruit: number;
  pic: number;
  seuilEntree: number;
  seuilSortie: number;
  enoncesEnvoyes: number;
  enoncesJetes: number;
  tauxCapture: number;
  msParTrame: number;
  annulationEcho: boolean | null;
}

export interface MicroVocal {
  start(): Promise<void>;
  stop(emettreLeReste?: boolean): Promise<void>;
  suspend(): void;
  resume(): void;
  etat(): EtatMicro;
  infos(): InfosMicro;
  _reechantillonne: typeof reechantillonne;
  _wavDepuisPcm: typeof wavDepuisPcm;
  _trameRecue(pcm: Float32Array, rms: number): void;
}

type OptionsResolues = Required<OptionsMicro>;

let urlWorklet = "";

/** URL du worklet de capture, émise hachée par le build ; posée une fois par le pont. */
export function definirUrlWorklet(url: string): void {
  urlWorklet = url;
}

// Descente par filtre passe-bas à sinus cardinal fenêtré (Blackman), évalué à la position exacte de chaque échantillon de sortie.
const PHASES = 64;
const ZEROS = 8;
const noyaux = new Map<string, { demi: number; table: Float32Array[] }>();

function noyauPour(ratio: number): { demi: number; table: Float32Array[] } {
  const cle = ratio.toFixed(6);
  const existant = noyaux.get(cle);
  if (existant) return existant;
  const fc = 0.46 / ratio;
  const demi = Math.ceil(ZEROS * ratio);
  const largeur = 2 * demi + 1;
  const table: Float32Array[] = new Array<Float32Array>(PHASES + 1);
  for (let ph = 0; ph <= PHASES; ph++) {
    const decalage = ph / PHASES;
    const h = new Float32Array(largeur);
    let somme = 0;
    for (let k = 0; k < largeur; k++) {
      const x = k - demi - decalage;
      const arg = 2 * Math.PI * fc * x;
      const sinc = x === 0 ? 1 : Math.sin(arg) / arg;
      const w =
        Math.abs(x) >= demi
          ? 0
          : 0.42 + 0.5 * Math.cos((Math.PI * x) / demi) + 0.08 * Math.cos((2 * Math.PI * x) / demi);
      h[k] = sinc * w;
      somme += h[k] ?? 0;
    }
    for (let k = 0; k < largeur; k++) h[k] = (h[k] ?? 0) / (somme || 1);
    table[ph] = h;
  }
  const n = { demi, table };
  noyaux.set(cle, n);
  return n;
}

export function reechantillonne(pcm: Float32Array, de: number, vers: number): Float32Array {
  if (de === vers || pcm.length === 0) return pcm;
  const ratio = de / vers;
  const n = Math.floor(pcm.length / ratio);
  const sortie = new Float32Array(n);
  if (ratio > 1) {
    const k = noyauPour(ratio);
    const demi = k.demi;
    const largeur = 2 * demi + 1;
    const dernier = pcm.length - 1;
    for (let i = 0; i < n; i++) {
      const centre = i * ratio;
      const base = Math.floor(centre);
      const h = k.table[Math.round((centre - base) * PHASES)] as Float32Array;
      const debut = base - demi;
      let acc = 0;
      if (debut >= 0 && debut + largeur - 1 <= dernier) {
        for (let j = 0; j < largeur; j++) acc += (pcm[debut + j] ?? 0) * (h[j] ?? 0);
      } else {
        for (let j = 0; j < largeur; j++) {
          const idx = debut + j;
          if (idx >= 0 && idx <= dernier) acc += (pcm[idx] ?? 0) * (h[j] ?? 0);
        }
      }
      sortie[i] = acc;
    }
  } else {
    // Montée par interpolation linéaire : cas rare (micro en 8 kHz).
    for (let i = 0; i < n; i++) {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const f = pos - j;
      const a = pcm[j] || 0;
      const b = j + 1 < pcm.length ? (pcm[j + 1] ?? 0) : a;
      sortie[i] = a + (b - a) * f;
    }
  }
  return sortie;
}

function concatene(trames: Float32Array[]): Float32Array {
  let total = 0;
  for (const t of trames) total += t.length;
  const tout = new Float32Array(total);
  let pos = 0;
  for (const t of trames) {
    tout.set(t, pos);
    pos += t.length;
  }
  return tout;
}

export function wavDepuisPcm(pcm: Float32Array, taux: number): Blob {
  const octets = new ArrayBuffer(44 + pcm.length * 2);
  const vue = new DataView(octets);
  const texte = (pos: number, s: string): void => {
    for (let i = 0; i < s.length; i++) vue.setUint8(pos + i, s.charCodeAt(i));
  };
  texte(0, "RIFF");
  vue.setUint32(4, 36 + pcm.length * 2, true);
  texte(8, "WAVE");
  texte(12, "fmt ");
  vue.setUint32(16, 16, true);
  vue.setUint16(20, 1, true);
  vue.setUint16(22, 1, true);
  vue.setUint32(24, taux, true);
  vue.setUint32(28, taux * 2, true);
  vue.setUint16(32, 2, true);
  vue.setUint16(34, 16, true);
  texte(36, "data");
  vue.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    // Écrêtage avant conversion : un dépassement repasserait par zéro et s'entendrait comme un craquement.
    const v = Math.max(-1, Math.min(1, pcm[i] ?? 0));
    vue.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([octets], { type: "audio/wav" });
}

// Les seuils suivent le bruit ambiant : le gain automatique du micro déplace le plancher de bruit et le niveau de la voix.
const ENTREE_MULT = 3.0;
const SORTIE_MULT = 1.8;
const ENTREE_MIN = 0.012;
const SORTIE_MIN = 0.006;
const PIC_PART = 0.35;
const PIC_SIGNIFICATIF = 0.018;
const ENTREE_PLANCHER = 0.004;
const PIC_DECROISSANCE = 0.999;
const BRUIT_REMONTEE = 1.01;
const BRUIT_PART_PIC = 0.3;
const BRUIT_MAX = 0.15;
const CALIBRAGE_PAROLE = 0.05;

interface FenetreAudio {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

function aucun(): void {
  return undefined;
}

export function createVoiceMic(options?: OptionsMicro): MicroVocal {
  const o: OptionsResolues = Object.assign(
    {
      sampleRate: 16000,
      silenceMs: 600,
      minUtteranceMs: 250,
      maxUtteranceSec: 30,
      prerollMs: 300,
      onUtterance: aucun,
      onLevel: aucun,
      onState: aucun,
      onError: aucun,
    },
    options || {},
  );

  let ctx: AudioContext | null = null;
  let flux: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let noeud: AudioWorkletNode | null = null;
  // Chaque stop() change de session : un start() dont un await finit après un arrêt relâche tout.
  let session = 0;
  let surFinPiste: (() => void) | null = null;
  let etat: EtatMicro = "arrete";
  let suspendu = false;
  let msParTrame = 20;

  let bruit = 0;
  let pic = 0;
  let seuilEntree = ENTREE_MIN;
  let seuilSortie = SORTIE_MIN;
  let commits = 0;
  let rejets = 0;
  let calibrage: number[] = [];
  let msCalibrage = 0;
  let parle = false;
  let msDepuisSilence = 0;
  let msEnonce = 0;
  let msParole = 0;
  let trames: Float32Array[] = [];
  let preroll: Float32Array[] = [];
  let maxPreroll = 16;

  function recalculeSeuils(): void {
    let entree = Math.max(ENTREE_MIN, bruit * ENTREE_MULT);
    if (pic > PIC_SIGNIFICATIF) entree = Math.min(entree, Math.max(ENTREE_PLANCHER, pic * PIC_PART));
    let sortie = Math.max(SORTIE_MIN, bruit * SORTIE_MULT);
    if (sortie >= entree) sortie = entree * 0.6;
    seuilEntree = entree;
    seuilSortie = sortie;
  }

  function pose(nouvel: EtatMicro): void {
    if (etat === nouvel) return;
    etat = nouvel;
    try {
      o.onState(etat);
    } catch {
      /* l'appelant ne doit pas nous casser */
    }
  }

  function reinitialise(): void {
    parle = false;
    msDepuisSilence = 0;
    msEnonce = 0;
    msParole = 0;
    trames = [];
    preroll = [];
  }

  function commit(raison: string): void {
    const morceaux = trames;
    trames = [];
    parle = false;
    msDepuisSilence = 0;
    const duree = msEnonce;
    // Le plancher porte sur le son, pas sur la durée totale : le pré-roll est du silence.
    const sonore = msParole;
    msEnonce = 0;
    msParole = 0;
    if (etat !== "suspendu") pose("ecoute");
    if (sonore < o.minUtteranceMs || morceaux.length === 0) {
      rejets++;
      return;
    }
    commits++;
    try {
      const brut = concatene(morceaux);
      // `ctx` est absent en test unitaire : le taux cible court-circuite le ré-échantillonnage.
      const tauxSource = ctx ? ctx.sampleRate : o.sampleRate;
      const pcm = reechantillonne(brut, tauxSource, o.sampleRate);
      void o.onUtterance(wavDepuisPcm(pcm, o.sampleRate), duree, raison);
    } catch (e) {
      o.onError(`Découpage audio impossible : ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function trameRecue(pcm: Float32Array, rms: number): void {
    if (suspendu) return;
    try {
      o.onLevel(Math.min(1, rms * 8));
    } catch {
      /* idem */
    }

    if (msCalibrage < 500) {
      // Le pré-roll tourne dès maintenant : qui parle dès le clic ne perd pas son premier mot.
      preroll.push(pcm);
      if (preroll.length > maxPreroll) preroll.shift();
      if (!(rms > CALIBRAGE_PAROLE && calibrage.length >= 3)) {
        calibrage.push(rms);
        msCalibrage += msParTrame;
        if (msCalibrage >= 500) {
          calibrage.sort((a, b) => a - b);
          bruit = calibrage[Math.floor(calibrage.length / 2)] || 0;
          recalculeSeuils();
          calibrage = [];
          pose("ecoute");
        }
        return;
      }
      calibrage.sort((a, b) => a - b);
      bruit = Math.min(BRUIT_MAX, calibrage[0] || 0);
      recalculeSeuils();
      calibrage = [];
      msCalibrage = 500;
      preroll.pop();
      pose("ecoute");
    }

    // Suivi permanent, parole comprise : le pic décroît lentement, le plancher suit le minimum récent.
    pic = Math.max(rms, pic * PIC_DECROISSANCE);
    bruit = Math.min(BRUIT_MAX, Math.min(rms, bruit * BRUIT_REMONTEE));
    if (pic > PIC_SIGNIFICATIF) bruit = Math.min(bruit, pic * BRUIT_PART_PIC);
    recalculeSeuils();

    if (!parle) {
      preroll.push(pcm);
      if (preroll.length > maxPreroll) preroll.shift();
      if (rms > seuilEntree) {
        parle = true;
        msDepuisSilence = 0;
        msEnonce = preroll.length * msParTrame;
        msParole = msParTrame;
        trames = preroll.slice();
        preroll = [];
        pose("parole");
      }
      return;
    }

    trames.push(pcm);
    msEnonce += msParTrame;
    // Hystérésis : on entre au-dessus de `seuilEntree`, on ne sort que sous `seuilSortie`.
    if (rms < seuilSortie) {
      msDepuisSilence += msParTrame;
    } else {
      msDepuisSilence = 0;
      msParole += msParTrame;
    }
    if (msDepuisSilence >= o.silenceMs) {
      commit("silence");
      return;
    }
    if (msEnonce >= o.maxUtteranceSec * 1000) {
      commit("plafond");
      // La personne parle encore : on enchaîne sur un nouvel énoncé au lieu d'attendre la prochaine attaque.
      if (!suspendu) {
        parle = true;
        pose("parole");
      }
    }
  }

  /** Ouvre le contexte audio au taux cible (Chromium ré-échantillonne), puis au taux natif si le navigateur refuse (Firefox, Safari). */
  async function ouvreContexte(f: MediaStream): Promise<{ c: AudioContext; s: MediaStreamAudioSourceNode }> {
    const w = window as unknown as FenetreAudio;
    const AC = (w.AudioContext || w.webkitAudioContext) as typeof AudioContext;
    const module = urlWorklet;
    let c: AudioContext | null = null;
    const compat = voiceCompat();
    if (!compat.tauxNatifDirect) {
      try {
        c = new AC({ sampleRate: o.sampleRate });
        await c.audioWorklet.addModule(module);
        return { c, s: c.createMediaStreamSource(f) };
      } catch {
        try {
          if (c && c.state !== "closed") await c.close();
        } catch {
          /* contexte déjà fermé */
        }
      }
    }
    c = new AC();
    try {
      await c.audioWorklet.addModule(module);
      return { c, s: c.createMediaStreamSource(f) };
    } catch (e) {
      try {
        await c.close();
      } catch {
        /* contexte déjà fermé */
      }
      throw e;
    }
  }

  function messageErreur(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  async function start(): Promise<void> {
    if (etat !== "arrete") return;
    const compat = voiceCompat();
    if (!compat.dictee.ok) {
      o.onError(compat.dictee.raison);
      return;
    }
    const maSession = ++session;
    pose("demarrage");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      pose("arrete");
      o.onError("Le micro n'est pas accessible : la page doit être servie en HTTPS.");
      return;
    }
    let f: MediaStream;
    try {
      f = await navigator.mediaDevices.getUserMedia({
        audio: {
          // L'annulation d'écho empêche le micro de réentendre la réponse lue ; le semi-duplex reste la garde principale.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (e) {
      if (maSession !== session) return;
      pose("arrete");
      const nom = (e as { name?: string } | null)?.name || "";
      o.onError(
        nom === "NotAllowedError"
          ? "Accès au micro refusé. Pour le réautoriser : icône à gauche de l'adresse, puis Micro."
          : nom === "NotFoundError"
            ? "Aucun micro détecté."
            : nom === "NotReadableError"
              ? "Micro occupé par une autre application."
              : `Micro indisponible : ${messageErreur(e)}`,
      );
      return;
    }
    if (maSession !== session) {
      f.getTracks().forEach((p) => p.stop());
      return;
    }
    flux = f;

    try {
      const ouvert = await ouvreContexte(f);
      if (maSession !== session) {
        try {
          await ouvert.c.close();
        } catch {
          /* contexte déjà fermé */
        }
        f.getTracks().forEach((p) => p.stop());
        return;
      }
      ctx = ouvert.c;
      source = ouvert.s;
      noeud = new AudioWorkletNode(ctx, "capture-vocale");
      msParTrame = Math.round((Math.max(128, Math.round(ctx.sampleRate * 0.02)) / ctx.sampleRate) * 1000);
      maxPreroll = Math.max(1, Math.round(o.prerollMs / msParTrame));
      noeud.port.onmessage = (e: MessageEvent<{ pcm?: Float32Array; rms?: number } | null>) => {
        if (e.data && e.data.pcm) trameRecue(e.data.pcm, e.data.rms || 0);
      };
      source.connect(noeud);
      // Pas de connexion vers la destination : router le micro vers les haut-parleurs créerait un larsen.
      if (ctx.state === "suspended") await ctx.resume();
    } catch (e) {
      if (maSession !== session) return;
      await stop();
      o.onError(`Capture audio impossible : ${messageErreur(e)}`);
      return;
    }
    if (maSession !== session) return;

    // Micro débranché ou partage révoqué : sans cet écouteur l'état restait « écoute » avec un vumètre à zéro.
    const piste = f.getAudioTracks()[0];
    if (piste && piste.addEventListener) {
      surFinPiste = () => {
        if (maSession !== session) return;
        void stop();
        o.onError("Micro déconnecté.");
      };
      piste.addEventListener("ended", surFinPiste);
    }

    suspendu = false;
    calibrage = [];
    msCalibrage = 0;
    reinitialise();
    pose("calibrage");
  }

  async function stop(emettreLeReste?: boolean): Promise<void> {
    session++;
    if (emettreLeReste && parle) commit("arret");
    try {
      const piste = flux?.getAudioTracks()[0];
      if (piste && surFinPiste) piste.removeEventListener("ended", surFinPiste);
    } catch {
      /* piste déjà libérée */
    }
    surFinPiste = null;
    suspendu = false;
    try {
      if (noeud) {
        noeud.port.postMessage({ op: "stop" });
        noeud.disconnect();
      }
    } catch {
      /* nœud déjà détaché */
    }
    try {
      source?.disconnect();
    } catch {
      /* source déjà détachée */
    }
    // Pistes arrêtées une par une : fermer le contexte ne les libère pas et l'indicateur micro de l'OS resterait allumé.
    try {
      flux?.getTracks().forEach((p) => p.stop());
    } catch {
      /* pistes déjà arrêtées */
    }
    try {
      if (ctx && ctx.state !== "closed") await ctx.close();
    } catch {
      /* contexte déjà fermé */
    }
    noeud = null;
    source = null;
    flux = null;
    ctx = null;
    reinitialise();
    pose("arrete");
  }

  return {
    start,
    stop,
    /** Semi-duplex : coupe l'écoute pendant qu'une réponse est lue (garde anti-écho de base). */
    suspend() {
      if (etat === "arrete") return;
      if (parle) commit("suspension");
      suspendu = true;
      reinitialise();
      pose("suspendu");
    },
    resume() {
      if (etat === "arrete" || !suspendu) return;
      suspendu = false;
      reinitialise();
      pose("ecoute");
    },
    etat: () => etat,
    infos() {
      let aec: boolean | null = null;
      try {
        const piste = flux?.getAudioTracks()[0];
        const r = piste && piste.getSettings ? piste.getSettings() : null;
        if (r && r.echoCancellation !== undefined) aec = !!r.echoCancellation;
      } catch {
        /* getSettings absent sur d'anciens navigateurs */
      }
      return {
        etat,
        bruit: Number(bruit.toFixed(5)),
        pic: Number(pic.toFixed(5)),
        seuilEntree: Number(seuilEntree.toFixed(5)),
        seuilSortie: Number(seuilSortie.toFixed(5)),
        enoncesEnvoyes: commits,
        enoncesJetes: rejets,
        tauxCapture: ctx ? ctx.sampleRate : 0,
        msParTrame,
        annulationEcho: aec,
      };
    },
    _reechantillonne: reechantillonne,
    _wavDepuisPcm: wavDepuisPcm,
    _trameRecue: trameRecue,
  };
}
