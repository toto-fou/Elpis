// SPDX-License-Identifier: MIT
/** frontend/test/auth/session.test.ts — machine d'état de session, génération, nettoyage par propriétaire et multi-compte. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consequencesFin, GestionnaireSession } from "../../src/features/auth/session";
import { COMPTE_A, COMPTE_B } from "../aides";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("machine d'état", () => {
  it("inconnu → connecté → déconnecté, génération incrémentée à chaque frontière", () => {
    const s = new GestionnaireSession();
    expect(s.etat).toEqual({ statut: "inconnu", generation: 0 });
    s.ouvrir(COMPTE_A);
    expect(s.etat).toMatchObject({ statut: "connecte", generation: 1 });
    s.ouvrir({ ...COMPTE_A, avatar: "x.png" });
    expect(s.generation).toBe(1);
    expect(s.compte?.avatar).toBe("x.png");
    expect(s.fermer("deconnexion")).toBe(true);
    expect(s.etat).toEqual({ statut: "deconnecte", generation: 2, raison: "deconnexion" });
    expect(s.fermer("expiration")).toBe(false);
  });

  it("changement de compte sans déconnexion : nouvelle génération", () => {
    const s = new GestionnaireSession();
    s.ouvrir(COMPTE_A);
    s.ouvrir(COMPTE_B);
    expect(s.generation).toBe(2);
  });

  it("premier me-lite déconnecté : pas de fin à traiter, génération gardée", () => {
    const s = new GestionnaireSession();
    s.constaterDeconnecte();
    expect(s.etat).toEqual({ statut: "deconnecte", generation: 0, raison: null });
  });

  it("expiration signalée par une génération révolue : ignorée", () => {
    const s = new GestionnaireSession();
    s.ouvrir(COMPTE_A);
    const g = s.generation;
    s.fermer("deconnexion");
    s.ouvrir(COMPTE_B);
    expect(s.signalerExpiration(g)).toBe(false);
    expect(s.compte?.id).toBe(2);
  });

  it("mot de passe à changer puis fermeture", () => {
    const s = new GestionnaireSession();
    expect(s.motDePasseAChanger()).toBe(true);
    expect(s.motDePasseAChanger()).toBe(false);
    expect(s.fermer("mot_de_passe")).toBe(true);
  });

  it("déconnexion volontaire seule arrête le run serveur ; toute fin détache l'affichage", () => {
    expect(consequencesFin("deconnexion")).toEqual({ detacherAffichage: true, arreterRun: true });
    expect(consequencesFin("expiration")).toEqual({ detacherAffichage: true, arreterRun: false });
    expect(consequencesFin("mot_de_passe").arreterRun).toBe(false);
  });
});

describe("propriétaires", () => {
  it("timers, intervalles et écouteurs libérés à la fin de la session", () => {
    const s = new GestionnaireSession();
    s.ouvrir(COMPTE_A);
    const p = s.proprietaire("test");
    const t = vi.fn();
    const i = vi.fn();
    const ecoute = vi.fn();
    p.minuterie(t, 1000);
    p.intervalle(i, 100);
    p.ecouter(document, "visibilitychange", ecoute);
    vi.advanceTimersByTime(250);
    expect(i).toHaveBeenCalledTimes(2);
    s.fermer("expiration");
    expect(p.actif).toBe(false);
    vi.advanceTimersByTime(5000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(t).not.toHaveBeenCalled();
    expect(i).toHaveBeenCalledTimes(2);
    expect(ecoute).not.toHaveBeenCalled();
  });

  it("nettoyage multi-compte : les ressources de A ne survivent pas à l'ouverture de B", () => {
    const s = new GestionnaireSession();
    s.ouvrir(COMPTE_A);
    const fermeture = vi.fn();
    const pA = s.proprietaire("sse");
    pA.ajouter(fermeture);
    s.ouvrir(COMPTE_B);
    expect(fermeture).toHaveBeenCalledTimes(1);
    const pB = s.proprietaire("sse");
    expect(pB.actif).toBe(true);
    expect(pB.generation).toBe(2);
  });

  it("une minuterie échue se retire, un ajout après libération s'exécute tout de suite", () => {
    const s = new GestionnaireSession();
    const p = s.proprietaire("x");
    const t = vi.fn();
    p.minuterie(t, 10);
    vi.advanceTimersByTime(10);
    expect(t).toHaveBeenCalledTimes(1);
    p.liberer();
    const tard = vi.fn();
    p.ajouter(tard);
    expect(tard).toHaveBeenCalledTimes(1);
  });

  it("un nettoyage qui lève n'empêche pas les autres", () => {
    const s = new GestionnaireSession();
    const p = s.proprietaire("x");
    const ok = vi.fn();
    const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
    p.ajouter(() => {
      throw new Error("boum");
    });
    p.ajouter(ok);
    p.liberer();
    expect(ok).toHaveBeenCalled();
    expect(erreur).toHaveBeenCalled();
    erreur.mockRestore();
  });
});
