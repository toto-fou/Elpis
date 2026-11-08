// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/journalisation.ts — console › Système › Journalisation : état du journal de sécurité, conservation (barre d'enregistrement), gel de la purge et événement de test. */
import { schemaEtatJournal, schemaReglagesJournal, schemaTestJournal } from "@elpis/contracts";
import type { EtatJournal, ReglagesJournal } from "@elpis/contracts";
import type { Ref } from "vue";

import { copierTexte } from "../../utils/dom";
import { corpsJson, detailErreur, lireSchema } from "../../utils/lecture-json";
import { declarerBrouillon } from "./brouillons";
import { confirmerParMot } from "./confirmation";
import type { BaseAdmin } from "./etat";
import { suivreChargement } from "./suivi-chargement";

const ENTETES_JSON = { "Content-Type": "application/json" };
const NOM_CHARGEUR = "loadAuditStatus";
const DUREE_MIN = 180;
const DUREE_MAX = 1095;
const MOTIF_MIN = 5;
const TEST_PAUSE_MS = 10_000;

export interface TestEcrit {
  nonce: string;
  ts: number;
}

/** Durée en jours dite en ans ou en mois (365 jours = 1 an). */
export function enMois(jours: number): string {
  if (jours % 365 === 0) return `${jours / 365} an${jours > 365 ? "s" : ""}`;
  return `≈ ${Math.round(jours / 30.4)} mois`;
}

export const dureeValide = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= DUREE_MIN && v <= DUREE_MAX;

/** Pastille d'un certificat : inconnu, expiré, proche de l'expiration (moins de 30 jours) ou valide. */
export function etatCertificat(joursRestants: number | null): "unknown" | "down" | "warn" | "ok" {
  if (joursRestants === null) return "unknown";
  return joursRestants < 0 ? "down" : joursRestants < 30 ? "warn" : "ok";
}

export function creerJournalisation(b: BaseAdmin) {
  const { vue, ctx, e, lien } = b;
  const { computed, ref } = vue;
  const { fetchAuth, showToast } = ctx;

  const auditEtat: Ref<EtatJournal | null> = ref(null);
  const auditReglages: Ref<ReglagesJournal | null> = ref(null);
  /** Erreur du serveur à l'enregistrement de la conservation, affichée sous le champ. */
  const auditSaveErreur = ref("");
  const auditMotif = ref("");
  const auditGelEnCours = ref(false);
  const auditGelErreur = ref("");
  const auditTest: Ref<TestEcrit | null> = ref(null);
  const auditTestEnCours = ref(false);
  const auditTestAttente = ref(false);
  const auditTestErreur = ref("");
  let sequence = 0;
  let minuteur: ReturnType<typeof setTimeout> | null = null;

  const auditDureeValide = computed(() => dureeValide(e.auditForm.value?.retention_days));
  /** Fichiers qu'une durée plus courte que celle enregistrée ferait supprimer (le serveur garde durée + 1 jours), 0 sinon. */
  const auditSupprimes = computed(() => {
    const f = e.auditForm.value;
    const s = auditEtat.value;
    const actuelle = auditReglages.value?.retention_days;
    if (!f || !s || actuelle === undefined || !dureeValide(f.retention_days)) return 0;
    return f.retention_days < actuelle ? Math.max(0, s.files - (f.retention_days + 1)) : 0;
  });

  vue.watch(
    e.auditForm,
    () => {
      auditSaveErreur.value = "";
    },
    { deep: true },
  );

  /** Formulaire modifié et pas encore enregistré : un rechargement ne doit pas l'écraser. */
  const formulaireModifie = (): boolean =>
    e.auditForm.value !== null &&
    e.adminPristine.value.audit !== null &&
    JSON.stringify(e.auditForm.value) !== e.adminPristine.value.audit;

  /** Réponse d'un PUT recopiée dans la carte de l'état, sans attendre une nouvelle lecture. */
  function appliquerRetention(r: ReglagesJournal): void {
    const etat = auditEtat.value;
    if (!etat) return;
    const { bounds: _bornes, ...champs } = r;
    auditEtat.value = {
      ...etat,
      forwarding: { ...etat.forwarding, expected: r.forwarding_expected },
      retention: { ...etat.retention, ...champs },
    };
  }

  function appliquerReglages(r: ReglagesJournal): void {
    auditReglages.value = r;
    // Durée écrite hors bornes : le formulaire propose la valeur bornée, que « Réécrire » enregistre.
    const duree = Math.min(DUREE_MAX, Math.max(DUREE_MIN, r.retention_days));
    e.auditForm.value = { retention_days: duree, forwarding_expected: r.forwarding_expected };
    lien.markAdminStoreClean("audit");
  }

  /** Réglages lus dans l'état du journal (`retention` porte les mêmes champs ; les bornes sont des constantes). */
  const reglagesDeEtat = (r: EtatJournal["retention"]): ReglagesJournal => {
    const { eligible_files: _eligibles, ...champs } = r;
    return { ...champs, bounds: { min: DUREE_MIN, max: DUREE_MAX, default: 365 } };
  };

  /** État du journal et réglages, lus en une seule requête ; le dernier appel l'emporte. */
  async function loadAuditStatus(): Promise<void> {
    const moi = ++sequence;
    await suivreChargement(
      NOM_CHARGEUR,
      async () => {
        const etat = await fetchAuth("/api/admin/audit/status").then((r) => lireSchema(r, schemaEtatJournal));
        if (moi !== sequence) return true;
        if (!etat) return false;
        const reglages = reglagesDeEtat(etat.retention);
        auditEtat.value = etat;
        auditReglages.value = reglages;
        if (!formulaireModifie()) {
          appliquerReglages(reglages);
          auditSaveErreur.value = "";
        }
        return true;
      },
      loadAuditStatus,
    );
  }

  /** Relit l'état seul (après un gel ou une levée) sans toucher au formulaire ; la conservation de la réponse du PUT prime sur un état relu plus ancien. */
  async function rafraichirEtat(apresPut?: ReglagesJournal): Promise<void> {
    try {
      const etat = await lireSchema(await fetchAuth("/api/admin/audit/status"), schemaEtatJournal);
      if (etat) {
        auditEtat.value = etat;
        if (apresPut) appliquerRetention(apresPut);
      }
    } catch {
      /* l'état se relira au prochain chargement */
    }
  }

  async function ecrireReglages(
    corps: Record<string, unknown>,
  ): Promise<{ r?: ReglagesJournal; erreur?: string }> {
    try {
      const res = await fetchAuth("/api/admin/audit/settings", {
        method: "PUT",
        headers: ENTETES_JSON,
        body: JSON.stringify(corps),
      });
      if (!res) return { erreur: "Erreur réseau." };
      if (!res.ok)
        return { erreur: detailErreur(await corpsJson(res), "Enregistrement refusé par le serveur.") };
      const r = await lireSchema(res, schemaReglagesJournal);
      return r ? { r } : { erreur: "Réponse du serveur inattendue." };
    } catch {
      return { erreur: "Erreur réseau." };
    }
  }

  /** Enregistre la durée et la centralisation attendue (barre) ; l'erreur du serveur reste affichée en ligne. */
  async function saveAuditSettings(tout = false): Promise<boolean> {
    const f = e.auditForm.value;
    if (!f) return false;
    auditSaveErreur.value = "";
    if (!dureeValide(f.retention_days)) {
      auditSaveErreur.value = `Entre ${DUREE_MIN} et ${DUREE_MAX.toLocaleString("fr-FR")} jours.`;
      return false;
    }
    const actuels = auditReglages.value;
    const corps: Record<string, unknown> = {};
    if (tout || !actuels || actuels.invalid || f.retention_days !== actuels.retention_days)
      corps["retention_days"] = f.retention_days;
    if (tout || !actuels || f.forwarding_expected !== actuels.forwarding_expected)
      corps["forwarding_expected"] = f.forwarding_expected;
    const { r, erreur } = await ecrireReglages(corps);
    if (!r) {
      auditSaveErreur.value = erreur ?? "";
      return false;
    }
    auditReglages.value = r;
    appliquerRetention(r);
    void rafraichirEtat(r);
    return true;
  }

  /** « Réécrire dans config.json » : enregistre les valeurs affichées (durée illisible, reprise du témoin) hors barre. */
  async function reecrireAudit(): Promise<boolean> {
    const ok = await saveAuditSettings(true);
    if (ok) {
      lien.markAdminStoreClean("audit");
      showToast("Réglages réécrits dans config.json", "success");
    }
    return ok;
  }

  /** Focus sur le contrôle qui remplace celui qu'on vient d'utiliser. */
  function focaliser(id: string): void {
    void ctx.nextTick().then(() => document.getElementById(id)?.focus());
  }

  /** Gel ou levée : écriture immédiate, hors de la barre. */
  async function basculerGel(corps: Record<string, unknown>, succes: string): Promise<boolean> {
    auditGelEnCours.value = true;
    auditGelErreur.value = "";
    try {
      const { r, erreur } = await ecrireReglages(corps);
      if (!r) {
        auditGelErreur.value = erreur ?? "";
        return false;
      }
      auditReglages.value = r;
      appliquerRetention(r);
      auditMotif.value = "";
      showToast(succes, "success");
      focaliser(r.hold ? "jnl-lever" : "jnl-motif");
      await rafraichirEtat(r);
      return true;
    } finally {
      auditGelEnCours.value = false;
    }
  }

  /** Gèle la purge : motif obligatoire, puis mot « GELER » à taper. */
  async function geler(): Promise<boolean> {
    const motif = auditMotif.value.trim();
    if (auditGelEnCours.value) return false;
    if (motif.length < MOTIF_MIN) {
      auditGelErreur.value = `Motif obligatoire (${MOTIF_MIN} caractères au moins).`;
      return false;
    }
    auditGelErreur.value = "";
    const ok = await confirmerParMot(
      ctx,
      "Geler la purge du journal",
      `Plus aucun fichier ne sera supprimé tant que le gel dure. Motif noté dans le journal : « ${motif} ».`,
      "GELER",
      "Geler la purge",
    );
    if (!ok) return false;
    return basculerGel({ hold: true, hold_reason: motif }, "Purge gelée");
  }

  /** Lève le gel après le mot « LEVER ». */
  async function leverGel(): Promise<boolean> {
    if (auditGelEnCours.value) return false;
    const ok = await confirmerParMot(
      ctx,
      "Lever le gel",
      "La purge reprendra cette nuit : les fichiers au-delà de la durée de conservation seront supprimés.",
      "LEVER",
      "Lever le gel",
    );
    if (!ok) return false;
    return basculerGel({ hold: false }, "Gel levé");
  }

  declarerBrouillon({
    id: "audit-gel",
    page: "audit-logging",
    label: "Motif du gel de la purge",
    enCours: () => auditMotif.value.trim() !== "",
    enregistrer: geler,
    abandonner: () => {
      auditMotif.value = "";
    },
  });

  /** Écrit `audit.test` ; le serveur en accepte un toutes les 10 s (429 sinon). */
  async function ecrireTestAudit(): Promise<void> {
    if (auditTestEnCours.value || auditTestAttente.value) return;
    auditTestEnCours.value = true;
    auditTestErreur.value = "";
    try {
      const res = await fetchAuth("/api/admin/audit/test", { method: "POST" });
      if (!res) {
        auditTestErreur.value = "Erreur réseau.";
        return;
      }
      if (res.ok) {
        const d = await lireSchema(res, schemaTestJournal);
        if (d) auditTest.value = { nonce: d.nonce, ts: d.ts };
        else auditTestErreur.value = "Réponse du serveur inattendue.";
      } else {
        auditTestErreur.value = detailErreur(await corpsJson(res), "Événement de test refusé.");
      }
      if (res.ok || res.status === 429) {
        auditTestAttente.value = true;
        if (minuteur) clearTimeout(minuteur);
        minuteur = setTimeout(() => {
          auditTestAttente.value = false;
          auditTestErreur.value = "";
        }, TEST_PAUSE_MS);
      }
    } catch {
      auditTestErreur.value = "Erreur réseau.";
    } finally {
      auditTestEnCours.value = false;
    }
  }

  async function copierNonce(): Promise<void> {
    const n = auditTest.value?.nonce;
    if (!n) return;
    try {
      await copierTexte(n);
      showToast("Code copié", "success");
    } catch {
      showToast("Copie impossible : sélectionnez le code", "error");
    }
  }

  vue.onUnmounted(() => {
    if (minuteur) clearTimeout(minuteur);
  });

  return {
    auditForm: e.auditForm,
    auditEtat,
    auditReglages,
    auditSaveErreur,
    auditMotif,
    auditGelEnCours,
    auditGelErreur,
    auditTest,
    auditTestEnCours,
    auditTestAttente,
    auditTestErreur,
    auditDureeValide,
    auditSupprimes,
    reecrireAudit,
    loadAuditStatus,
    saveAuditSettings,
    geler,
    leverGel,
    ecrireTestAudit,
    copierNonce,
  };
}
