// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/securite.ts — console › Sessions et accès HTTPS : révocation globale ou par compte, bascule HTTPS (Caddy) et mode d'écoute. */
import { schemaReponseEtatHttps, schemaReponseSessionsConsole } from "@elpis/contracts";
import type { ReponseEtatHttps } from "@elpis/contracts";
import type { Ref } from "vue";

import { corpsJson, detailErreur, lireSchema, objet } from "../../utils/lecture-json";
import { estUrlHttp } from "../../utils/url-sure";
import type { BaseAdmin } from "./etat";
import { poserChemin } from "./etat";

type VueSessions = typeof schemaReponseSessionsConsole._output;
const ENTETES_JSON = { "Content-Type": "application/json" };
export const REDEMARRAGE_MANUEL =
  "Réglage enregistré, mais le redémarrage automatique a échoué : redémarrez Elpis (./elpis restart)";

export function creerSecurite(b: BaseAdmin) {
  const { vue, ctx, e, lien } = b;
  const { ref } = vue;
  const { showToast, openConfirm, fetchAuth } = ctx;
  const securityOverview: Ref<VueSessions | null> = ref(null);
  const securityBusy = ref(false);
  const httpsStatus: Ref<ReponseEtatHttps | null> = ref(null);
  const httpsBusy = ref(false);
  const httpsRedirectUrl = ref("");

  async function loadSecurityOverview(): Promise<void> {
    try {
      const d = await lireSchema(
        await fetchAuth("/api/admin/security/sessions", {}, true),
        schemaReponseSessionsConsole,
      );
      if (d) securityOverview.value = d;
    } catch {
      /* la barre montre « — » */
    }
  }

  /** Confirmation globale : tous les utilisateurs connectés (sauf l'opérateur) seront déconnectés à leur prochaine requête. */
  async function revokeAllSessions(): Promise<void> {
    const confirme = await openConfirm(
      "Révoquer toutes les sessions ?",
      "Tous les utilisateurs connectés (sauf vous) seront déconnectés " +
        "à leur prochaine requête. Action immédiate, irréversible — les " +
        "utilisateurs devront se reconnecter.",
      true,
      "Révoquer",
    );
    if (!confirme) return;
    securityBusy.value = true;
    try {
      const res = await fetchAuth("/api/admin/security/sessions/revoke-all", { method: "POST" });
      if (res?.ok) {
        showToast("Toutes les sessions ont été révoquées", "success");
        await loadSecurityOverview();
      } else {
        showToast("Échec de la révocation", "error");
      }
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      securityBusy.value = false;
    }
  }

  async function loadHttpsStatus(): Promise<void> {
    try {
      const d = await lireSchema(
        await fetchAuth("/api/admin/security/https", {}, true),
        schemaReponseEtatHttps,
      );
      if (d) httpsStatus.value = d;
    } catch {
      /* le panneau reste sur « Chargement… » */
    }
  }

  /** Réaligne la copie locale du formulaire sur ce que la bascule vient d'écrire côté serveur. */
  function realignerFormulaireHttps(actif: boolean): void {
    const form = e.configForm.value;
    if (!form) return;
    const etaitPropre =
      e.adminPristine.value.config === null || e.adminPristine.value.config === lien.storeSnapshot("config");
    const s = form.security;
    s.https = { ...(s.https ?? {}), enabled: actif };
    s.session.https_only = actif;
    if (!actif && String(s.session.same_site || "").toLowerCase() === "none") s.session.same_site = "lax";
    poserChemin(e.configRaw, "security.https.enabled", actif);
    poserChemin(e.configRaw, "security.session.https_only", actif);
    if (etaitPropre) lien.markAdminStoreClean("config");
  }

  async function toggleHttps(): Promise<void> {
    if (!httpsStatus.value || httpsBusy.value) return;
    const activation = !httpsStatus.value.enabled;
    const confirme = await openConfirm(
      activation ? "Activer le HTTPS ?" : "Repasser en HTTP direct ?",
      activation
        ? "L'application redémarre : elle n'écoutera plus qu'en loopback " +
            "(Caddy devient le seul point d'entrée) et le cookie de session " +
            "devient Secure. Vous serez redirigé vers la nouvelle URL en https."
        : "L'application redémarre : l'accès direct http (ports 8001/8002) " +
            "est rétabli. Le cookie Secure n'étant plus envoyé en clair, " +
            "une reconnexion sera nécessaire.",
      true,
      activation ? "Activer" : "Repasser en HTTP",
    );
    if (!confirme) return;
    httpsBusy.value = true;
    try {
      const res = await fetchAuth("/api/admin/security/https", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ enabled: activation }),
      });
      if (res?.ok) {
        const data = objet(await corpsJson(res));
        realignerFormulaireHttps(activation);
        if (data["ok"] === false) {
          showToast(REDEMARRAGE_MANUEL, "error");
          return;
        }
        showToast(
          activation ? "HTTPS activé — redémarrage en cours" : "Retour en HTTP direct — redémarrage en cours",
          "success",
        );
        const cible = objet(data["urls"])["admin"];
        if (typeof cible === "string" && estUrlHttp(cible)) {
          httpsRedirectUrl.value = cible;
          setTimeout(() => {
            window.location.href = cible;
          }, 8000);
        }
      } else if (res && res.status === 409) {
        showToast(detailErreur(await corpsJson(res)) || "Caddy non détecté — HTTPS non activé", "error");
        await loadHttpsStatus();
      } else {
        showToast("Échec de la bascule HTTPS", "error");
      }
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      httpsBusy.value = false;
    }
  }

  /** Écoute hors HTTPS (`security.listen`) : écrite côté serveur puis redémarrage ; le serveur refuse « local » depuis le réseau. */
  async function setListen(listen: string, ev?: Event): Promise<void> {
    const status = httpsStatus.value;
    if (!status || httpsBusy.value || listen === status.listen) return;
    const cible =
      ev?.target instanceof HTMLSelectElement || ev?.target instanceof HTMLInputElement ? ev.target : null;
    const local = listen === "local";
    const confirme = await openConfirm(
      local ? "Écouter sur ce serveur seulement ?" : "Ouvrir au réseau local ?",
      local
        ? "L'application redémarre et n'écoute plus qu'en 127.0.0.1 : " +
            "les autres machines perdent l'accès aux ports 8001/8002."
        : "L'application redémarre et écoute sur 0.0.0.0 : les ports " +
            "8001/8002 deviennent joignables en clair depuis le réseau.",
      true,
      local ? "Restreindre" : "Ouvrir",
    );
    if (!confirme) {
      if (cible) cible.value = status.listen;
      return;
    }
    httpsBusy.value = true;
    try {
      const res = await fetchAuth("/api/admin/security/listen", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ listen }),
      });
      if (res?.ok && httpsStatus.value) {
        httpsStatus.value = { ...httpsStatus.value, listen };
        if (objet(await corpsJson(res))["ok"] === false) showToast(REDEMARRAGE_MANUEL, "error");
        else showToast("Écoute modifiée — redémarrage en cours", "success");
      } else {
        showToast(detailErreur(await corpsJson(res)) || "Échec du changement d'écoute", "error");
        await loadHttpsStatus();
      }
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      httpsBusy.value = false;
      if (cible && httpsStatus.value) cible.value = httpsStatus.value.listen;
    }
  }

  async function clearUserRevocation(userId: number, username?: string): Promise<void> {
    securityBusy.value = true;
    try {
      const res = await fetchAuth("/api/admin/security/sessions/clear-user-revocation/" + userId, {
        method: "POST",
      });
      if (res?.ok) {
        showToast("Révocation levée pour " + (username || "uid=" + userId), "success");
        await loadSecurityOverview();
      } else {
        showToast("Échec", "error");
      }
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      securityBusy.value = false;
    }
  }

  return {
    securityOverview,
    securityBusy,
    loadSecurityOverview,
    revokeAllSessions,
    clearUserRevocation,
    httpsStatus,
    httpsBusy,
    httpsRedirectUrl,
    loadHttpsStatus,
    toggleHttps,
    setListen,
  };
}
