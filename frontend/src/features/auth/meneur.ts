// SPDX-License-Identifier: MIT
/** frontend/src/features/auth/meneur.ts — un flux système par navigateur et par compte : élection d'un onglet meneur sur un `BroadcastChannel`, relais de ses événements aux autres onglets. */

/** Ce que l'élection lit d'un `BroadcastChannel` (injectable dans les tests). */
export interface CanalOnglets {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export interface OptionsMeneur {
  readonly canal: CanalOnglets;
  /** Identifiant de l'onglet ; à époque égale, le plus petit l'emporte. */
  readonly id: string;
  /** L'onglet revient d'une absence (page mise en cache) : resynchroniser dès qu'il suit un flux. */
  readonly rattrapage: boolean;
  minuterie(fn: () => void, ms: number): () => void;
  intervalle(fn: () => void, ms: number): () => void;
  maintenant(): number;
  /** Première candidature : ouvrir le flux sans attendre l'élection (aucun événement manqué), ses événements appliqués ici sans relais. */
  devancer(): void;
  /** Devenu meneur : garder le flux ouvert d'avance, sinon l'ouvrir ; `rattrapage` : le rouvrir et resynchroniser (un autre flux était suivi). */
  prendre(rattrapage: boolean): void;
  lacher(): void;
  recevoir(texte: string): void;
  resynchroniser(): void;
  /** Un onglet du compte a perdu sa session : la vérifier. */
  verifierSession(): void;
}

/** Attente d'une réponse d'un meneur avant de prendre le rôle. */
export const ATTENTE_MS = 250;
/** Battement du meneur ; un suiveur sans signe depuis `SILENCE_MS` se porte candidat (un meneur vivant lui répond). */
export const BATTEMENT_MS = 5000;
export const SILENCE_MS = 15000;

/** Canal d'un compte ; la version change avec le protocole (onglets de deux versions de l'application). */
export const nomCanal = (uid: number): string => `elpis-systeme-1:${uid}`;

interface Signe {
  readonly e: number;
  readonly de: string;
}
type Message =
  | (Signe & { readonly t: "candidat" | "depart" | "fin" })
  | (Signe & { readonly t: "meneur"; readonly o: number })
  | (Signe & { readonly t: "ev"; readonly o: number; readonly r: number; readonly data: string });

function lire(x: unknown): Message | null {
  if (!x || typeof x !== "object") return null;
  const m = x as Record<string, unknown>;
  if (typeof m["e"] !== "number" || typeof m["de"] !== "string") return null;
  const t = m["t"];
  if (t === "candidat" || t === "depart" || t === "fin") return m as unknown as Message;
  if (typeof m["o"] !== "number") return null;
  if (t === "meneur" || (t === "ev" && typeof m["r"] === "number" && typeof m["data"] === "string"))
    return m as unknown as Message;
  return null;
}

const meilleur = (a: Signe, b: Signe): boolean => a.e > b.e || (a.e === b.e && a.de < b.de);

/** Élection : candidature, rôle pris faute de réponse ; époque la plus haute puis plus petit identifiant en cas de conflit. */
export function creerMeneur(o: OptionsMeneur) {
  let role: "candidat" | "meneur" | "suiveur" | "parti" = "candidat";
  let epoque = 0;
  let mien: Signe = { e: 0, de: o.id };
  let ouvertures = 0;
  let chef: Signe | null = null;
  let dernierSigne = 0;
  // Flux suivi (`meneur:ouvertures`) : quand il change, des événements ont pu manquer.
  let fluxVu: string | null = null;
  let aRattraper = o.rattrapage;
  // Instant où l'onglet a cédé le rôle : un relais antérieur est couvert par son propre flux ou par la resynchronisation.
  let cede = 0;
  // Flux ouvert d'avance par la première candidature, et déjà ouvert côté serveur.
  let avance = false;
  let avanceOuverte = false;
  let annulerAttente: (() => void) | null = null;

  const poster = (t: "candidat" | "meneur" | "depart" | "fin"): void =>
    o.canal.postMessage(
      t === "meneur" ? { t, e: mien.e, de: o.id, o: ouvertures } : { t, e: mien.e, de: o.id },
    );

  function attendre(fn: (() => void) | null, ms = 0): void {
    annulerAttente?.();
    annulerAttente = fn
      ? o.minuterie(() => {
          annulerAttente = null;
          fn();
        }, ms)
      : null;
  }

  function candidater(): void {
    role = "candidat";
    dernierSigne = o.maintenant();
    mien = { e: epoque + 1, de: o.id };
    poster("candidat");
    attendre(prendreRole, ATTENTE_MS);
  }

  function prendreRole(): void {
    role = "meneur";
    epoque = Math.max(epoque, mien.e);
    chef = null;
    const rattrapage = aRattraper || fluxVu !== null;
    aRattraper = false;
    // Flux d'avance déjà ouvert et gardé : annoncé avec le rôle.
    ouvertures = avanceOuverte && !rattrapage ? 1 : 0;
    if (ouvertures) fluxVu = `${o.id}:1`;
    avance = avanceOuverte = false;
    poster("meneur");
    o.prendre(rattrapage);
  }

  /** Suit le meneur `m` ; resynchronise si le flux suivi a changé. */
  function suivre(m: Signe & { readonly o: number }): void {
    attendre(null);
    if (avance) {
      // Flux d'avance fermé : ce qu'il a lu (retard d'un meneur occupé, relayé d'un bloc) ne se rejoue pas par le relais ; meneur sans flux encore : resynchroniser au sien.
      if (avanceOuverte) {
        cede = o.maintenant() + 1;
        aRattraper ||= m.o === 0;
      }
      avance = avanceOuverte = false;
      o.lacher();
    }
    role = "suiveur";
    chef = { e: m.e, de: m.de };
    dernierSigne = o.maintenant();
    if (m.o === 0) return;
    const flux = `${m.de}:${m.o}`;
    const change = aRattraper || (fluxVu !== null && fluxVu !== flux);
    fluxVu = flux;
    aRattraper = false;
    if (change) o.resynchroniser();
  }

  /** Signe d'un meneur : vrai si l'onglet le suit et applique l'événement porté ; meneur supplanté (dégel) : il ferme son flux et suit. */
  function signe(m: Signe & { readonly o: number }): boolean {
    if (role === "meneur") {
      if (!meilleur(m, mien)) {
        poster("meneur");
        return false;
      }
      cede = o.maintenant();
      o.lacher();
      suivre(m);
      return false;
    }
    if (role === "suiveur" && chef && chef.de !== m.de && !meilleur(m, chef)) return false;
    suivre(m);
    return true;
  }

  function surMessage(ev: MessageEvent): void {
    const m = lire(ev.data);
    if (!m || role === "parti") return;
    epoque = Math.max(epoque, m.e);
    switch (m.t) {
      case "candidat":
        if (role === "meneur") poster("meneur");
        else if (role !== "candidat") return;
        else if (!meilleur(m, mien)) poster("candidat");
        else {
          // Candidature meilleure : attendre son annonce, se représenter si elle ne vient pas.
          role = "suiveur";
          attendre(candidater, ATTENTE_MS * 4);
        }
        return;
      case "fin":
        o.verifierSession();
        if (chef?.de === m.de) quitterChef();
        return;
      case "depart":
        if (chef?.de === m.de) quitterChef();
        return;
      case "meneur":
        signe(m);
        return;
      case "ev":
        if (signe(m) && m.r >= cede) o.recevoir(m.data);
    }
  }

  function quitterChef(): void {
    chef = null;
    if (role === "suiveur") candidater();
  }

  /** Battement du meneur ; suiveur sans nouvelles : candidature (le meneur vivant répond, sinon le rôle est repris). */
  function veiller(): void {
    if (role === "meneur") poster("meneur");
    else if (role === "suiveur" && o.maintenant() - dernierSigne > SILENCE_MS) candidater();
  }

  const arreterVeille = o.intervalle(veiller, BATTEMENT_MS);
  o.canal.onmessage = surMessage;
  candidater();
  if (!o.rattrapage) {
    avance = true;
    o.devancer();
  }

  return {
    get estMeneur(): boolean {
      return role === "meneur";
    },
    /** Flux du meneur ouvert (ou rouvert) : annoncé, les suiveurs comparent au flux qu'ils suivaient. */
    fluxOuvert(): void {
      if (role !== "meneur") {
        avanceOuverte = avance;
        return;
      }
      ouvertures += 1;
      fluxVu = `${o.id}:${ouvertures}`;
      poster("meneur");
    },
    relayer(texte: string): void {
      if (role === "meneur")
        o.canal.postMessage({ t: "ev", e: mien.e, de: o.id, o: ouvertures, r: o.maintenant(), data: texte });
    },
    veiller,
    /** Départ de l'onglet ; `fin` : sa session est terminée, les autres la vérifient. */
    quitter(fin: boolean): void {
      if (role === "parti") return;
      if (role === "meneur") poster("depart");
      if (fin) poster("fin");
      role = "parti";
      attendre(null);
      arreterVeille();
      o.canal.onmessage = null;
      o.canal.close();
    },
  };
}

export type Meneur = ReturnType<typeof creerMeneur>;
