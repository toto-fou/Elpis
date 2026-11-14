// SPDX-License-Identifier: MIT
/** frontend/test/auth/sse-onglets.test.ts — flux système partagé entre onglets : élection du meneur, relais, reprise (fermeture, gel, perte de session), comptes séparés, repli. */
import { ref } from "vue";
import type { Ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { ATTENTE_MS, AVANCE_MS, BATTEMENT_MS, SILENCE_MS } from "../../src/features/auth/meneur";
import type { CanalOnglets } from "../../src/features/auth/meneur";
import { GestionnaireSession } from "../../src/features/auth/session";
import type { Compte, Horloge } from "../../src/features/auth/session";
import { setupChatSystemSSE } from "../../src/features/auth/sse-systeme";
import type { SourceEvenements } from "../../src/features/auth/sse-systeme";
import { COMPTE_A, COMPTE_B, json } from "../aides";

class FausseSource implements SourceEvenements {
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  ferme = false;
  close(): void {
    this.ferme = true;
    this.readyState = 2;
  }
  ouvrir(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  envoyer(donnees: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(donnees) }));
  }
  tomber(): void {
    this.readyState = 2;
    this.onerror?.(new Event("error"));
  }
}

/** Navigateur simulé : cookie de session commun, canaux de diffusion livrés de façon asynchrone. */
class Navigateur {
  connecte = true;
  compte = COMPTE_A.id;
  motDePasse = false;
  readonly canaux = new Set<FauxCanal>();
  /** Réponse de `/api/me-lite` pour le cookie courant. */
  moi(): Record<string, unknown> {
    if (this.motDePasse) return { logged_in: false, must_change_password: true };
    return this.connecte ? { logged_in: true, id: this.compte } : { logged_in: false };
  }
}

/** Onglet simulé : gelé, ni messages ni minuteries ; ralenti (caché depuis longtemps), minuteries seules retardées. */
interface Onglet {
  fige: boolean;
  ralenti: boolean;
  differes: (() => void)[];
  session: GestionnaireSession;
  user: Ref<unknown>;
  doc: Document & { visibilityState: DocumentVisibilityState };
  sources: FausseSource[];
  ctx: { systemAlert: Ref<unknown>; handleSessionExpired: Mock; checkAuth: Mock };
  rappels: Record<"onReconnect" | "onModelChanged" | "onNotification" | "pollModels", Mock>;
  sse: ReturnType<typeof setupChatSystemSSE>;
}

class FauxCanal implements CanalOnglets {
  onmessage: ((e: MessageEvent) => void) | null = null;
  ferme = false;
  readonly nom: string;
  readonly nav: Navigateur;
  readonly onglet: Onglet;
  constructor(nom: string, nav: Navigateur, onglet: Onglet) {
    this.nom = nom;
    this.nav = nav;
    this.onglet = onglet;
    nav.canaux.add(this);
  }
  postMessage(message: unknown): void {
    if (this.ferme) throw new Error("canal fermé");
    const copie: unknown = structuredClone(message);
    for (const c of this.nav.canaux)
      if (c !== this && c.nom === this.nom) setTimeout(() => c.livrer(copie), 0);
  }
  livrer(message: unknown): void {
    if (this.ferme) return;
    if (this.onglet.fige) {
      this.onglet.differes.push(() => this.livrer(message));
      return;
    }
    this.onmessage?.(new MessageEvent("message", { data: message }));
  }
  close(): void {
    this.ferme = true;
    this.nav.canaux.delete(this);
  }
}

/** Horloge d'un onglet : gelé ou ralenti, ses minuteries attendent le dégel (une fois chacune). */
function horloge(o: Onglet): Horloge {
  const envelopper = (fn: () => void) => () => {
    if (!o.fige && !o.ralenti) fn();
    else if (!o.differes.includes(fn)) o.differes.push(fn);
  };
  return {
    setTimeout: (fn, ms) => setTimeout(envelopper(fn), ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(envelopper(fn), ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  };
}

function onglet(nav: Navigateur, compte: Compte = COMPTE_A, canal = true): Onglet {
  const o = { fige: false, ralenti: false, differes: [], sources: [] } as unknown as Onglet;
  o.session = new GestionnaireSession(horloge(o));
  o.session.ouvrir(compte);
  o.user = ref<unknown>(compte);
  o.doc = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
    defaultView: new EventTarget(),
  }) as unknown as Onglet["doc"];
  o.ctx = {
    systemAlert: ref<unknown>(null),
    handleSessionExpired: vi.fn(() => {
      o.session.fermer("expiration");
      o.user.value = null;
    }),
    checkAuth: vi.fn(() => Promise.resolve()),
  };
  o.rappels = { onReconnect: vi.fn(), onModelChanged: vi.fn(), onNotification: vi.fn(), pollModels: vi.fn() };
  o.sse = setupChatSystemSSE(
    { user: o.user, isLoadingModel: ref(false), isStreaming: ref(false) },
    o.ctx,
    o.rappels,
    {
      session: o.session,
      document: o.doc,
      creerSource: () => {
        const s = new FausseSource();
        o.sources.push(s);
        return s;
      },
      creerCanal: canal ? (nom) => new FauxCanal(nom, nav, o) : null,
      fetch: () => Promise.resolve(json(nav.moi())),
      recharger: vi.fn(),
    },
  );
  return o;
}

const ouvertes = (ongs: readonly Onglet[]): FausseSource[] =>
  ongs.flatMap((o) => o.sources).filter((s) => !s.ferme);
const seule = (ongs: readonly Onglet[]): FausseSource => {
  const s = ouvertes(ongs);
  expect(s).toHaveLength(1);
  return s[0]!;
};
const meneurDe = (ongs: readonly Onglet[]): Onglet => {
  const m = ongs.filter((o) => o.sources.some((s) => !s.ferme));
  expect(m).toHaveLength(1);
  return m[0]!;
};
function connecter(...ongs: Onglet[]): void {
  for (const o of ongs) o.sse.connectSystemEvents();
}
function cacher(o: Onglet): void {
  o.doc.visibilityState = "hidden";
  o.doc.dispatchEvent(new Event("visibilitychange"));
}
function degeler(o: Onglet): void {
  o.fige = false;
  for (const fn of o.differes.splice(0)) fn();
}
const CHANGEMENT = { type: "model_changed" };
const NOTIF = { user_id: 1, id: 3, kind: "k", title: "t", body: "b", ref_type: "", ref_id: null, unread: 1 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("élection", () => {
  it("onglet seul : flux ouvert sans attendre la fin de l'élection et gardé à la prise du rôle, un événement d'avant est appliqué", () => {
    const nav = new Navigateur();
    const a = onglet(nav);
    connecter(a);
    expect(a.sources).toHaveLength(0);
    vi.advanceTimersByTime(AVANCE_MS);
    const s = seule([a]);
    s.ouvrir();
    s.envoyer(CHANGEMENT);
    expect(a.rappels.onModelChanged).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(ATTENTE_MS);
    connecter(a);
    vi.advanceTimersByTime(60_000);
    expect(a.sources).toEqual([s]);
    expect(s.ferme).toBe(false);
    expect(a.rappels.onReconnect).not.toHaveBeenCalled();
    // Un onglet ouvert ensuite suit ce flux, déjà annoncé : ni flux à lui, ni resynchronisation.
    const b = onglet(nav);
    connecter(b);
    vi.advanceTimersByTime(ATTENTE_MS);
    s.envoyer(CHANGEMENT);
    vi.advanceTimersByTime(1);
    expect(b.rappels.onModelChanged).toHaveBeenCalledTimes(1);
    expect(b.rappels.onReconnect).not.toHaveBeenCalled();
    expect(b.sources).toHaveLength(0);
  });

  it("meneur occupé à l'arrivée d'un onglet : le flux d'avance sert en attendant ; à sa réponse il est fermé, rien n'est appliqué deux fois, une resynchronisation", () => {
    const nav = new Navigateur();
    const a = onglet(nav);
    connecter(a);
    vi.advanceTimersByTime(ATTENTE_MS);
    const sa = seule([a]);
    sa.ouvrir();
    a.fige = true;
    const b = onglet(nav);
    connecter(b);
    vi.advanceTimersByTime(AVANCE_MS);
    const sb = seule([b]);
    sb.ouvrir();
    sb.envoyer(CHANGEMENT);
    expect(b.rappels.onModelChanged).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60);
    // Le meneur reprend la main : il répond à la candidature et relaie son retard d'un bloc.
    degeler(a);
    sa.envoyer(CHANGEMENT);
    vi.advanceTimersByTime(1);
    expect(sb.ferme).toBe(true);
    expect(b.rappels.onModelChanged).toHaveBeenCalledTimes(1);
    expect(b.rappels.onReconnect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5);
    sa.envoyer(CHANGEMENT);
    vi.advanceTimersByTime(1);
    expect(b.rappels.onModelChanged).toHaveBeenCalledTimes(2);
    expect(a.rappels.onModelChanged).toHaveBeenCalledTimes(2);
    expect(b.rappels.onReconnect).toHaveBeenCalledTimes(1);
    expect(ouvertes([a, b])).toEqual([sa]);
  });

  it("flux d'avance tombé avant la réponse du meneur : sa reconnexion est abandonnée, l'onglet se resynchronise en suivant", () => {
    const nav = new Navigateur();
    const a = onglet(nav);
    connecter(a);
    vi.advanceTimersByTime(ATTENTE_MS);
    const sa = seule([a]);
    sa.ouvrir();
    a.fige = true;
    const b = onglet(nav);
    connecter(b);
    vi.advanceTimersByTime(AVANCE_MS);
    b.sources[0]!.ouvrir();
    b.sources[0]!.tomber();
    degeler(a);
    vi.advanceTimersByTime(1);
    expect(b.rappels.onReconnect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(b.sources).toHaveLength(1);
    expect(ouvertes([a, b])).toEqual([sa]);
  });

  it("page quittée avant l'ouverture du flux d'avance : aucun flux n'est ouvert ensuite", () => {
    const nav = new Navigateur();
    const a = onglet(nav);
    connecter(a);
    a.doc.defaultView!.dispatchEvent(new Event("pagehide"));
    vi.advanceTimersByTime(60_000);
    expect(a.sources).toHaveLength(0);
  });

  it("huit onglets ouverts ensemble : un seul flux ; tous cachés, chaque événement arrive une fois dans chacun", () => {
    const nav = new Navigateur();
    const ongs = Array.from({ length: 8 }, () => onglet(nav));
    connecter(...ongs);
    vi.advanceTimersByTime(ATTENTE_MS * 8);
    const s = seule(ongs);
    s.ouvrir();
    vi.advanceTimersByTime(1);
    ongs.forEach(cacher);
    s.envoyer({ type: "notification", data: NOTIF });
    s.envoyer(CHANGEMENT);
    vi.advanceTimersByTime(1);
    for (const o of ongs) {
      expect(o.rappels.onNotification).toHaveBeenCalledTimes(1);
      expect(o.rappels.onModelChanged).toHaveBeenCalledTimes(1);
      expect(o.rappels.onReconnect).not.toHaveBeenCalled();
    }
    vi.advanceTimersByTime(5 * 60_000);
    expect(ongs.flatMap((o) => o.sources)).toHaveLength(1);
  });

  it("onglets ouverts l'un après l'autre : suiveurs du meneur en place, sans flux ni resynchronisation", () => {
    const nav = new Navigateur();
    const a = onglet(nav);
    connecter(a);
    vi.advanceTimersByTime(ATTENTE_MS);
    seule([a]).ouvrir();
    const b = onglet(nav);
    const c = onglet(nav);
    connecter(b, c);
    vi.advanceTimersByTime(ATTENTE_MS * 4);
    expect(b.sources.length + c.sources.length).toBe(0);
    seule([a, b, c]).envoyer(CHANGEMENT);
    vi.advanceTimersByTime(1);
    for (const o of [a, b, c]) {
      expect(o.rappels.onModelChanged).toHaveBeenCalledTimes(1);
      expect(o.rappels.onReconnect).not.toHaveBeenCalled();
    }
  });
});

describe("reprise du rôle", () => {
  function trois(nav = new Navigateur()) {
    const ongs = [onglet(nav), onglet(nav), onglet(nav)];
    connecter(ongs[0]!);
    vi.advanceTimersByTime(ATTENTE_MS);
    seule(ongs).ouvrir();
    connecter(ongs[1]!, ongs[2]!);
    vi.advanceTimersByTime(ATTENTE_MS);
    return { nav, ongs, a: ongs[0]!, suiveurs: [ongs[1]!, ongs[2]!] };
  }

  it("fermeture du meneur : un suiveur reprend aussitôt, chaque onglet resynchronisé une fois, aucun doublon", () => {
    const { a, suiveurs } = trois();
    a.doc.defaultView!.dispatchEvent(new Event("pagehide"));
    expect(a.sources[0]!.ferme).toBe(true);
    vi.advanceTimersByTime(ATTENTE_MS * 2);
    const s = seule(suiveurs);
    s.ouvrir();
    vi.advanceTimersByTime(1);
    s.envoyer(CHANGEMENT);
    vi.advanceTimersByTime(1);
    for (const o of suiveurs) {
      expect(o.rappels.onReconnect).toHaveBeenCalledTimes(1);
      expect(o.rappels.onModelChanged).toHaveBeenCalledTimes(1);
    }
    expect(a.rappels.onModelChanged).not.toHaveBeenCalled();
  });

  it("retour d'une page masquée (cache) : l'onglet rejoint en suiveur et se resynchronise", () => {
    const { a, suiveurs } = trois();
    a.doc.defaultView!.dispatchEvent(new Event("pagehide"));
    vi.advanceTimersByTime(ATTENTE_MS * 2);
    seule(suiveurs).ouvrir();
    vi.advanceTimersByTime(1);
    a.doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(ATTENTE_MS);
    expect(a.sources).toHaveLength(1);
    expect(a.rappels.onReconnect).toHaveBeenCalledTimes(1);
    seule([a, ...suiveurs]).envoyer(CHANGEMENT);
    vi.advanceTimersByTime(1);
    expect(a.rappels.onModelChanged).toHaveBeenCalledTimes(1);
  });

  it("meneur gelé : repris après le silence ; à son dégel il cède, aucun événement appliqué deux fois", () => {
    const { a, suiveurs } = trois();
    a.fige = true;
    vi.advanceTimersByTime(SILENCE_MS + BATTEMENT_MS * 2 + ATTENTE_MS * 4);
    const neuve = seule(suiveurs);
    expect(a.sources[0]!.ferme).toBe(false);
    neuve.ouvrir();
    vi.advanceTimersByTime(1);
    neuve.envoyer(CHANGEMENT);
    vi.advanceTimersByTime(1);
    for (const o of suiveurs) {
      expect(o.rappels.onReconnect).toHaveBeenCalledTimes(1);
      expect(o.rappels.onModelChanged).toHaveBeenCalledTimes(1);
    }
    // Pendant le gel, le flux du meneur gelé a lu le même événement.
    a.sources[0]!.envoyer(CHANGEMENT);
    expect(a.rappels.onModelChanged).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    degeler(a);
    vi.advanceTimersByTime(BATTEMENT_MS);
    expect(a.sources[0]!.ferme).toBe(true);
    expect(seule([a, ...suiveurs])).toBe(neuve);
    expect(a.rappels.onReconnect).toHaveBeenCalledTimes(1);
    expect(a.rappels.onModelChanged).toHaveBeenCalledTimes(1);
    for (const o of suiveurs) expect(o.rappels.onModelChanged).toHaveBeenCalledTimes(1);
    neuve.envoyer(CHANGEMENT);
    vi.advanceTimersByTime(1);
    for (const o of [a, ...suiveurs]) expect(o.rappels.onModelChanged).toHaveBeenCalledTimes(2);
  });

  it("vraie coupure du flux du meneur, même caché : il se reconnecte et chaque onglet se resynchronise une fois", () => {
    const { a, suiveurs } = trois();
    cacher(a);
    a.sources[0]!.tomber();
    vi.advanceTimersByTime(1000);
    expect(a.sources).toHaveLength(2);
    a.sources[1]!.ouvrir();
    vi.advanceTimersByTime(1);
    for (const o of [a, ...suiveurs]) expect(o.rappels.onReconnect).toHaveBeenCalledTimes(1);
  });

  it("battements du meneur caché retardés : le suiveur inquiet reçoit une réponse, aucun second flux", () => {
    const { a, suiveurs } = trois();
    // Seules les minuteries d'un onglet caché sont retardées : il répond à la candidature.
    a.ralenti = true;
    vi.advanceTimersByTime(SILENCE_MS * 3);
    expect(ouvertes([a, ...suiveurs])).toHaveLength(1);
    expect(a.sources).toHaveLength(1);
    expect(a.sources[0]!.ferme).toBe(false);
    for (const o of suiveurs) expect(o.rappels.onReconnect).not.toHaveBeenCalled();
  });
});

describe("session et comptes", () => {
  it("déconnexion dans l'onglet meneur : les autres la constatent, aucun flux rouvert sans session", async () => {
    const nav = new Navigateur();
    const ongs = [onglet(nav), onglet(nav), onglet(nav)];
    connecter(ongs[0]!);
    vi.advanceTimersByTime(ATTENTE_MS);
    seule(ongs).ouvrir();
    connecter(ongs[1]!, ongs[2]!);
    vi.advanceTimersByTime(ATTENTE_MS);
    nav.connecte = false;
    ongs[0]!.session.fermer("deconnexion");
    await vi.advanceTimersByTimeAsync(ATTENTE_MS * 8);
    for (const o of ongs.slice(1)) expect(o.ctx.handleSessionExpired).toHaveBeenCalledTimes(1);
    expect(ongs.flatMap((o) => o.sources)).toHaveLength(1);
    expect(ouvertes(ongs)).toHaveLength(0);
  });

  it("le meneur seul perd sa session (cookie toujours valable) : un autre onglet reprend le flux", async () => {
    const nav = new Navigateur();
    const ongs = [onglet(nav), onglet(nav)];
    connecter(ongs[0]!);
    vi.advanceTimersByTime(ATTENTE_MS);
    seule(ongs).ouvrir();
    connecter(ongs[1]!);
    vi.advanceTimersByTime(ATTENTE_MS);
    ongs[0]!.session.fermer("expiration");
    await vi.advanceTimersByTimeAsync(ATTENTE_MS * 2);
    expect(ongs[1]!.ctx.handleSessionExpired).not.toHaveBeenCalled();
    seule(ongs).ouvrir();
    await vi.advanceTimersByTimeAsync(1);
    expect(ongs[1]!.rappels.onReconnect).toHaveBeenCalledTimes(1);
  });

  it("mot de passe à changer dans un onglet : les autres passent au changement, pas à l'expiration", async () => {
    const nav = new Navigateur();
    const ongs = [onglet(nav), onglet(nav)];
    connecter(ongs[0]!);
    vi.advanceTimersByTime(ATTENTE_MS);
    seule(ongs).ouvrir();
    connecter(ongs[1]!);
    vi.advanceTimersByTime(ATTENTE_MS);
    nav.motDePasse = true;
    ongs[0]!.session.motDePasseAChanger();
    await vi.advanceTimersByTimeAsync(ATTENTE_MS * 8);
    expect(ongs[1]!.session.etat.statut).toBe("mot_de_passe_a_changer");
    expect(ongs[1]!.ctx.handleSessionExpired).not.toHaveBeenCalled();
    expect(ouvertes(ongs)).toHaveLength(0);
  });

  it("onglet A reconnecté en B : les autres onglets de A purgent puis relisent la session (B), rien de B relayé à A", async () => {
    const nav = new Navigateur();
    const ongs = [onglet(nav), onglet(nav)];
    connecter(ongs[0]!);
    vi.advanceTimersByTime(ATTENTE_MS);
    seule(ongs).ouvrir();
    connecter(ongs[1]!);
    vi.advanceTimersByTime(ATTENTE_MS);
    const [a1, a2] = ongs as [Onglet, Onglet];
    a1.session.fermer("deconnexion");
    a1.user.value = null;
    nav.compte = COMPTE_B.id;
    a1.session.ouvrir(COMPTE_B);
    a1.user.value = COMPTE_B;
    a1.sse.connectSystemEvents();
    await vi.advanceTimersByTimeAsync(ATTENTE_MS * 8);
    expect(a2.ctx.handleSessionExpired).toHaveBeenCalledTimes(1);
    expect(a2.ctx.checkAuth).toHaveBeenCalledTimes(1);
    expect(a2.sources.filter((s) => !s.ferme)).toHaveLength(0);
    seule(ongs).ouvrir();
    seule(ongs).envoyer(CHANGEMENT);
    vi.advanceTimersByTime(1);
    expect(a2.rappels.onModelChanged).not.toHaveBeenCalled();
  });

  it("session_expired relayé : tous les onglets expirent, aucun flux rouvert", () => {
    const nav = new Navigateur();
    const ongs = [onglet(nav), onglet(nav), onglet(nav)];
    connecter(...ongs);
    vi.advanceTimersByTime(ATTENTE_MS * 4);
    seule(ongs).ouvrir();
    seule(ongs).envoyer({ type: "session_expired" });
    vi.advanceTimersByTime(60_000);
    for (const o of ongs) expect(o.ctx.handleSessionExpired).toHaveBeenCalledTimes(1);
    expect(ouvertes(ongs)).toHaveLength(0);
    expect(ongs.flatMap((o) => o.sources)).toHaveLength(1);
  });

  it("worker_recycling : non relayé ; le meneur se rebranche, chaque onglet resynchronisé une fois", () => {
    const nav = new Navigateur();
    const ongs = [onglet(nav), onglet(nav)];
    connecter(...ongs);
    vi.advanceTimersByTime(ATTENTE_MS * 4);
    const m = meneurDe(ongs);
    seule(ongs).ouvrir();
    seule(ongs).envoyer({ type: "worker_recycling" });
    vi.advanceTimersByTime(750);
    expect(m.sources).toHaveLength(2);
    m.sources[1]!.ouvrir();
    vi.advanceTimersByTime(1);
    for (const o of ongs) expect(o.rappels.onReconnect).toHaveBeenCalledTimes(1);
    expect(ongs.flatMap((o) => o.sources)).toHaveLength(2);
  });

  it("deux comptes : un flux chacun, rien de relayé d'un compte à l'autre", () => {
    const nav = new Navigateur();
    const a1 = onglet(nav, COMPTE_A);
    const a2 = onglet(nav, COMPTE_A);
    const b1 = onglet(nav, COMPTE_B);
    connecter(a1, a2, b1);
    vi.advanceTimersByTime(ATTENTE_MS * 4);
    expect(ouvertes([a1, a2, b1])).toHaveLength(2);
    expect(b1.sources).toHaveLength(1);
    const sa = seule([a1, a2]);
    sa.ouvrir();
    b1.sources[0]!.ouvrir();
    sa.envoyer(CHANGEMENT);
    vi.advanceTimersByTime(1);
    expect(a1.rappels.onModelChanged).toHaveBeenCalledTimes(1);
    expect(a2.rappels.onModelChanged).toHaveBeenCalledTimes(1);
    expect(b1.rappels.onModelChanged).not.toHaveBeenCalled();
  });

  it("sans BroadcastChannel : un flux par onglet, ouvert tout de suite (comportement d'avant)", () => {
    const nav = new Navigateur();
    const ongs = [onglet(nav, COMPTE_A, false), onglet(nav, COMPTE_A, false)];
    connecter(...ongs);
    expect(ouvertes(ongs)).toHaveLength(2);
  });
});
