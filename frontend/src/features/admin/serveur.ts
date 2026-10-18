// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/serveur.ts — redémarrage du serveur depuis la console : confirmation, bandeau d'alerte et rechargement dès que `/api/health` répond. */
import type { BaseAdmin } from "./etat";

export function creerServeur(b: BaseAdmin) {
  const { ctx, e } = b;

  async function restartServer(): Promise<void> {
    const n = e.restartPending.value.length;
    const confirme = await ctx.openConfirm(
      "Redémarrer le serveur ?",
      (n ? `Applique ${n} réglage${n > 1 ? "s" : ""} en attente. ` : "") +
        "Les conversations en cours se terminent avant l’arrêt ; les sessions se reconnectent seules.",
      true,
      "Redémarrer",
    );
    if (!confirme) return;
    try {
      await ctx.fetchAuth("/api/admin/restart", { method: "POST" });
    } catch {
      /* le serveur coupe la connexion en redémarrant */
    }
    // La modale s'affiche tout de suite, sans attendre le flux d'événements.
    ctx.systemAlert.value = "Redémarrage du serveur. Reconnexion automatique…";
    const essayer = async (tentative: number): Promise<void> => {
      if (tentative > 20) {
        window.location.reload();
        return;
      }
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        if (r.ok) {
          window.location.reload();
          return;
        }
      } catch {
        /* serveur encore arrêté */
      }
      setTimeout(() => void essayer(tentative + 1), 1000);
    };
    setTimeout(() => void essayer(0), 6000);
  }

  return { restartServer };
}
