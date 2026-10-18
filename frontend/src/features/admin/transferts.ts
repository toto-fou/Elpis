// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/transferts.ts — modale de transfert de la console (sauvegarde, restauration, exports) avec progression réelle, et sauvegarde distante (SFTP, dossier monté, rsync). */
import {
  schemaReponseCleSauvegarde,
  schemaReponseMotDePasseSauvegarde,
  schemaReponseSauvegardeDistante,
} from "@elpis/contracts";
import type { Ref } from "vue";

import { corpsJson, detailErreur, lireSchema, nombre, objet, texte } from "../../utils/lecture-json";
import type { BaseAdmin } from "./etat";

const ENTETES_JSON = { "Content-Type": "application/json" };

export interface EtatTransfert {
  active: boolean;
  mode: string;
  title: string;
  filename: string;
  loaded: number;
  total: number;
  percent: number;
  indeterminate: boolean;
  error: string | null;
  done: boolean;
  waiting: boolean;
  waitLabel: string;
  elapsed: number;
}

export interface ConfigSauvegardeDistante {
  enabled: boolean;
  connector: string;
  scope: string;
  host: string;
  port: number;
  user: string;
  remote_path: string;
  dest_path: string;
  strict_host_key_checking: boolean;
  key_present: boolean;
  last_send: { at?: number; filename?: string; [cle: string]: unknown } | null;
  password_present: boolean;
  schedule_enabled: boolean;
  schedule_every: number;
  schedule_unit: string;
  next_run_at: number | null;
  [cle: string]: unknown;
}

const LIBELLES_PORTEE: Readonly<Record<string, string>> = Object.freeze({
  full: "complète",
  db: "de la base",
  sandboxes: "des sandboxes",
  mcp: "des serveurs MCP",
});

const transfertVide = (): EtatTransfert => ({
  active: false,
  mode: "download",
  title: "",
  filename: "",
  loaded: 0,
  total: 0,
  percent: 0,
  indeterminate: false,
  error: null,
  done: false,
  waiting: false,
  waitLabel: "",
  elapsed: 0,
});

export interface ReponseEnvoi {
  status: number;
  data: Record<string, unknown>;
}

/** Durée d'attente lisible : « 8 s », « 1 min 05 s ». */
export function fmtElapsed(sec: unknown): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return s + " s";
  return Math.floor(s / 60) + " min " + String(s % 60).padStart(2, "0") + " s";
}

export function creerTransferts(b: BaseAdmin) {
  const { vue, ctx } = b;
  const { computed, ref } = vue;
  const { showToast, openConfirm, fetchAuth } = ctx;
  const transferModal: Ref<EtatTransfert> = ref(transfertVide());
  let annulation: (() => void) | null = null;
  let minuterie: ReturnType<typeof setInterval> | null = null;

  /** Le serveur travaille et aucun octet ne circule : roue, libellé et temps écoulé plutôt qu'un « 0 o » figé. */
  function attendre(libelle: string): void {
    const t = transferModal.value;
    t.waiting = true;
    t.waitLabel = libelle;
    t.indeterminate = true;
    t.elapsed = 0;
    const t0 = Date.now();
    if (minuterie) clearInterval(minuterie);
    minuterie = setInterval(() => {
      transferModal.value.elapsed = Math.floor((Date.now() - t0) / 1000);
    }, 1000);
  }
  function finirAttente(): void {
    if (minuterie) {
      clearInterval(minuterie);
      minuterie = null;
    }
    transferModal.value.waiting = false;
  }
  function closeTransferModal(): void {
    if (annulation) {
      try {
        annulation();
      } catch {
        /* déjà annulé */
      }
      annulation = null;
    }
    finirAttente();
    transferModal.value.active = false;
  }
  function ouvrirTransfert(mode: string, titre: string, fichier: string): void {
    finirAttente();
    transferModal.value = { ...transfertVide(), active: true, mode, title: titre, filename: fichier || "" };
  }
  function progression(charge: number, total: number): void {
    const t = transferModal.value;
    t.loaded = charge;
    if (total > 0) {
      t.total = total;
      t.indeterminate = false;
      t.percent = Math.min(100, (charge / total) * 100);
    } else t.indeterminate = true;
  }
  function echec(err: unknown): void {
    finirAttente();
    if (!transferModal.value.active) return;
    const abandon = err instanceof Error && err.name === "AbortError";
    transferModal.value.error = abandon
      ? "Annulé."
      : "Échec : " + (err instanceof Error ? err.message : String(err));
  }

  /** Téléchargement en flux avec progression (fetch brut : le 401 route vers la fin de session globale). */
  async function downloadWithModal(
    url: string,
    titre: string,
    repli: string,
    libelleAttente = "Préparation…",
  ): Promise<void> {
    ouvrirTransfert("download", titre, repli);
    attendre(libelleAttente);
    const ac = new AbortController();
    annulation = () => ac.abort();
    try {
      const res = await fetch(url, { credentials: "same-origin", signal: ac.signal });
      finirAttente();
      if (res.status === 401) {
        transferModal.value.active = false;
        ctx.handleSessionExpired?.();
        return;
      }
      if (!res.ok) {
        const detail = detailErreur(await res.json().catch(() => null));
        throw new Error(detail || "HTTP " + res.status);
      }
      const m = /filename="?([^";]+)"?/i.exec(res.headers.get("content-disposition") || "");
      if (m?.[1]) transferModal.value.filename = m[1];
      const total = Number(res.headers.get("content-length") || 0);
      let blob: Blob;
      if (res.body?.getReader) {
        const lecteur = res.body.getReader();
        const morceaux: BlobPart[] = [];
        let charge = 0;
        for (;;) {
          const { done, value } = await lecteur.read();
          if (done) break;
          morceaux.push(value);
          charge += value.byteLength;
          progression(charge, total);
        }
        blob = new Blob(morceaux);
      } else {
        transferModal.value.indeterminate = true;
        blob = await res.blob();
      }
      progression(blob.size, blob.size);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = transferModal.value.filename || repli || "export.bin";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      transferModal.value.done = true;
    } catch (err) {
      echec(err);
    } finally {
      annulation = null;
      finirAttente();
    }
  }

  /** Envoi par XMLHttpRequest (fetch ne rapporte pas la progression d'envoi) ; `null` si annulé ou en erreur réseau. */
  function uploadWithModal(
    url: string,
    formData: FormData,
    titre: string,
    fichier: string,
    libelleAttente = "Traitement côté serveur…",
  ): Promise<ReponseEnvoi | null> {
    ouvrirTransfert("upload", titre, fichier);
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      annulation = () => xhr.abort();
      xhr.open("POST", url);
      xhr.responseType = "json";
      xhr.upload.onprogress = (ev) => progression(ev.loaded, ev.lengthComputable ? ev.total : 0);
      xhr.upload.onload = () => {
        if (transferModal.value.active) attendre(libelleAttente);
      };
      xhr.onload = () => {
        annulation = null;
        finirAttente();
        if (xhr.status === 401) {
          transferModal.value.active = false;
          ctx.handleSessionExpired?.();
          resolve(null);
          return;
        }
        resolve({ status: xhr.status, data: objet(xhr.response) });
      };
      xhr.onerror = () => {
        annulation = null;
        echec(new Error("Erreur réseau"));
        resolve(null);
      };
      xhr.onabort = () => {
        annulation = null;
        finirAttente();
        resolve(null);
      };
      xhr.send(formData);
    });
  }

  const exportMetrics = (jours = 7): Promise<void> =>
    downloadWithModal(
      `/api/admin/export-metrics?days=${jours}`,
      "Export des métriques",
      `metrics-${jours}j.csv`,
    );

  const downloadBackup = (portee = "full"): Promise<void> =>
    downloadWithModal(
      `/api/admin/backup?scope=${portee}`,
      `Sauvegarde ${LIBELLES_PORTEE[portee] || portee}`,
      `backup-${portee}.zip`,
      "Compression en cours…",
    );

  // ── Restauration ─────────────────────────────────────────────────────────
  const restoreScope = ref("full");
  async function triggerRestore(portee: string): Promise<void> {
    const entree = document.getElementById("restore-file-input");
    if (!(entree instanceof HTMLInputElement)) return;
    entree.value = "";
    const libelle = LIBELLES_PORTEE[portee] || portee;
    const confirme = ctx.openTypedConfirm
      ? await ctx.openTypedConfirm(
          `Restauration ${libelle}`,
          "Les données existantes seront remplacées par celles de l'archive. Sans retour arrière.",
          "RESTAURER",
          "Choisir l'archive",
        )
      : await openConfirm(
          `Restauration ${libelle}`,
          "Les données existantes seront remplacées par celles de l'archive. Sans retour arrière.",
          true,
          "Choisir l'archive",
        );
    if (!confirme) return;
    entree.onchange = async (ev: Event) => {
      const fichier = ev.target instanceof HTMLInputElement ? ev.target.files?.[0] : undefined;
      if (!fichier) return;
      entree.onchange = null;
      const formData = new FormData();
      formData.append("file", fichier);
      formData.append("scope", portee);
      const r = await uploadWithModal(
        "/api/admin/restore",
        formData,
        `Restauration ${libelle}`,
        fichier.name,
        "Restauration en cours…",
      );
      if (!r) return;
      if (r.status >= 200 && r.status < 300) {
        const data = r.data;
        transferModal.value.done = true;
        const erreurs = Array.isArray(data["errors"]) ? data["errors"].length : 0;
        if (erreurs > 0) {
          showToast(`${nombre(data["restored"])} fichiers restaurés, ${erreurs} erreur(s)`, "error");
        } else {
          showToast(
            data["restart_required"]
              ? `${nombre(data["restored"])} fichiers restaurés. Redémarrage conseillé.`
              : `${nombre(data["restored"])} fichiers restaurés avec succès`,
          );
          if (portee === "db" || portee === "full") setTimeout(() => window.location.reload(), 1500);
        }
      } else {
        transferModal.value.error = texte(r.data["detail"]) || "Erreur lors de la restauration";
      }
    };
    entree.click();
  }

  // ── Sauvegarde distante ──────────────────────────────────────────────────
  const remoteBackup: Ref<ConfigSauvegardeDistante> = ref({
    enabled: false,
    connector: "sftp",
    scope: "full",
    host: "",
    port: 22,
    user: "",
    remote_path: "",
    dest_path: "",
    strict_host_key_checking: true,
    key_present: false,
    last_send: null,
    password_present: false,
    schedule_enabled: false,
    schedule_every: 1,
    schedule_unit: "days",
    next_run_at: null,
  });
  const remoteKeyFp = ref("");
  const remoteBackupBusy = ref(false);
  const remoteRsyncPassword = ref("");

  function remoteDateLabel(ts: unknown): string {
    if (!ts) return "";
    try {
      return new Date(Number(ts) * 1000).toLocaleString("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }
  const remoteNextRunLabel = computed(() => {
    const r = remoteBackup.value;
    if (!r.schedule_enabled) return "Envoi automatique désactivé.";
    if (!r.enabled) return "Activez la sauvegarde distante pour planifier.";
    if (!r.next_run_at) return "Enregistrez pour planifier.";
    if (r.next_run_at * 1000 <= Date.now() + 60000) return "Prochain envoi : dans la minute.";
    return "Prochain envoi : " + remoteDateLabel(r.next_run_at) + ".";
  });

  async function loadRemoteBackup(): Promise<void> {
    try {
      const d = await lireSchema(
        await fetchAuth("/api/admin/backup/remote", {}, true),
        schemaReponseSauvegardeDistante,
      );
      if (d) {
        remoteBackup.value = d as unknown as ConfigSauvegardeDistante;
        remoteKeyFp.value = remoteBackup.value.key_present ? "Clé installée" : "";
      }
    } catch {
      /* configuration inchangée */
    }
  }
  async function stockerMotDePasseRsync(motDePasse: string): Promise<boolean> {
    const res = await fetchAuth("/api/admin/backup/remote/password", {
      method: "POST",
      headers: ENTETES_JSON,
      body: JSON.stringify({ password: motDePasse }),
    });
    const d = await lireSchema(res, schemaReponseMotDePasseSauvegarde);
    if (d) {
      remoteBackup.value.password_present = !!d.password_present;
      return true;
    }
    showToast(
      (res ? detailErreur(await res.json().catch(() => null)) : "") || "Mot de passe refusé",
      "error",
    );
    return false;
  }
  async function saveRemoteBackup(): Promise<void> {
    remoteBackupBusy.value = true;
    try {
      const res = await fetchAuth("/api/admin/backup/remote", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify(remoteBackup.value),
      });
      if (res?.ok) {
        if (remoteBackup.value.connector === "rsync" && remoteRsyncPassword.value) {
          if (!(await stockerMotDePasseRsync(remoteRsyncPassword.value))) return;
          remoteRsyncPassword.value = "";
        }
        showToast("Configuration enregistrée", "success");
        await loadRemoteBackup();
      } else showToast(detailErreur(await corpsJson(res)) || "Échec de l'enregistrement", "error");
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      remoteBackupBusy.value = false;
    }
  }
  async function clearRsyncPassword(): Promise<void> {
    remoteBackupBusy.value = true;
    try {
      if (await stockerMotDePasseRsync("")) showToast("Mot de passe retiré", "success");
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      remoteBackupBusy.value = false;
    }
  }
  async function uploadBackupKey(ev: Event): Promise<void> {
    const cible = ev.target instanceof HTMLInputElement ? ev.target : null;
    const fichier = cible?.files?.[0];
    if (!cible || !fichier) return;
    cible.value = "";
    const cle = await fichier.text();
    remoteBackupBusy.value = true;
    try {
      const res = await fetchAuth("/api/admin/backup/remote/key", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ key: cle }),
      });
      const d = await lireSchema(res, schemaReponseCleSauvegarde);
      if (d) {
        remoteKeyFp.value =
          typeof d.fingerprint === "string" && d.fingerprint ? d.fingerprint : "Clé installée";
        remoteBackup.value.key_present = true;
        showToast("Clé SSH installée", "success");
      } else showToast(detailErreur(await corpsJson(res)) || "Clé invalide", "error");
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      remoteBackupBusy.value = false;
    }
  }
  async function testRemoteBackup(): Promise<void> {
    remoteBackupBusy.value = true;
    try {
      await saveRemoteBackup();
      const res = await fetchAuth("/api/admin/backup/remote/test", { method: "POST" });
      const d = res?.ok ? objet(await corpsJson(res)) : { ok: false, error: "Erreur serveur" };
      showToast(d["ok"] ? "Connexion OK" : "Échec : " + texte(d["error"]), d["ok"] ? "success" : "error");
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      remoteBackupBusy.value = false;
    }
  }
  async function sendRemoteBackup(): Promise<void> {
    remoteBackupBusy.value = true;
    try {
      await saveRemoteBackup();
      showToast("Envoi en cours…", "info");
      const res = await fetchAuth("/api/admin/backup/remote/send", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ scope: remoteBackup.value.scope }),
      });
      const d = res?.ok ? objet(await corpsJson(res)) : { ok: false, error: "Erreur serveur" };
      showToast(
        d["ok"] ? "Sauvegarde envoyée : " + texte(d["filename"]) : "Échec : " + texte(d["error"]),
        d["ok"] ? "success" : "error",
      );
      await loadRemoteBackup();
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      remoteBackupBusy.value = false;
    }
  }

  return {
    transferModal,
    closeTransferModal,
    fmtElapsed,
    downloadWithModal,
    uploadWithModal,
    exportMetrics,
    downloadBackup,
    restoreScope,
    triggerRestore,
    remoteBackup,
    remoteKeyFp,
    remoteBackupBusy,
    remoteRsyncPassword,
    clearRsyncPassword,
    remoteNextRunLabel,
    remoteDateLabel,
    loadRemoteBackup,
    saveRemoteBackup,
    uploadBackupKey,
    testRemoteBackup,
    sendRemoteBackup,
  };
}
