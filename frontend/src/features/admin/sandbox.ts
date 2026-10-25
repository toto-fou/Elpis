// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/sandbox.ts — console › Sandbox : limites et politique, profils réseau (cartes repliables, puces validées à la saisie), conteneurs des comptes et nettoyage. */
import {
  schemaReponseConteneurs,
  schemaReponseExecuteurs,
  schemaReponseExecuteursEcrits,
  schemaReponseNettoyageBacs,
  schemaReponseSanteDocker,
} from "@elpis/contracts";
import type { Ref } from "vue";

import { lireSchema } from "../../utils/lecture-json";
import { DISQUE_PAR_DEFAUT, JOBS_PAR_DEFAUT } from "./etat";
import type { BaseAdmin, ConfigExecEditee, ProfilReseauEdite } from "./etat";
import { chargementEchoue, chargementReussi } from "./suivi-chargement";

const ENTETES_JSON = { "Content-Type": "application/json" };

type ConteneurBac = (typeof schemaReponseConteneurs._output)["containers"][number];
export interface SanteDocker {
  daemon_ok: boolean;
  error?: string;
  hint?: string;
  server_version?: unknown;
  image?: string;
  image_loaded?: boolean;
  image_hint?: string;
  archive_available?: boolean;
  archive_path?: string | null;
  [cle: string]: unknown;
}
export interface ConteneurPerime {
  container?: string;
  username?: string;
  user_id?: number | string;
  [cle: string]: unknown;
}
type CleListe = "ips" | "domains" | "ports" | "dns";

export interface ChampReseau {
  key: CleListe;
  label: string;
  ph: string;
  hint: string;
  title: string;
  quick?: { label: string; values: number[] }[];
}

export const CHAMPS_RESEAU: readonly ChampReseau[] = Object.freeze([
  {
    key: "ips",
    label: "Réseaux & IP",
    ph: "10.0.0.0/24",
    hint: "IP ou CIDR",
    title:
      "Une IP (10.0.0.5) ou un réseau CIDR (10.0.0.0/24). Plusieurs valeurs acceptées, séparées par un espace ou une virgule.",
  },
  {
    key: "domains",
    label: "Domaines",
    ph: "github.com",
    hint: "résolu au démarrage",
    title:
      "Résolu côté hôte à la création du conteneur et épinglé dans /etc/hosts : pas besoin d'ouvrir le DNS, et le rebinding est neutralisé.",
  },
  {
    key: "ports",
    label: "Ports",
    ph: "443",
    hint: "TCP sortant",
    title:
      "Ports TCP sortants autorisés. Nécessite une image sandbox ≥ 1.6.0 ; en deçà, le filtrage par port est ignoré.",
    quick: [
      { label: "Web", values: [80, 443] },
      { label: "SSH", values: [22] },
    ],
  },
  {
    key: "dns",
    label: "Résolveurs DNS",
    ph: "10.0.0.1",
    hint: "IP du serveur",
    title:
      "Résolveurs joignables (--dns + port 53). Utile seulement si le conteneur doit résoudre en direct ; les domaines listés ci-dessus n'en ont pas besoin.",
  },
]);

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;
const DOMAINE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const estIp = (s: string): boolean => IPV4.test(s) || (s.indexOf(":") >= 0 && IPV6.test(s));

/** Le serveur revalide tout ; ici une faute de frappe ne se découvre pas qu'au 400 de la sauvegarde. */
function normaliserValeur(
  cle: CleListe,
  brut: unknown,
): { value: string | number | null } | { error: string } {
  const s = String(brut || "").trim();
  if (!s) return { value: null };
  if (cle === "ports") {
    if (!/^\d{1,5}$/.test(s)) return { error: `« ${s} » n'est pas un port` };
    const n = parseInt(s, 10);
    if (n < 1 || n > 65535) return { error: `Port hors plage : ${s}` };
    return { value: n };
  }
  if (cle === "dns") {
    if (!estIp(s)) return { error: `« ${s} » doit être l'IP d'un résolveur` };
    return { value: s };
  }
  if (cle === "domains") {
    let d = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0] ?? "";
    d = (d.split("?")[0] ?? "").split("@").pop() ?? "";
    d = d.replace(/:\d+$/, "").toLowerCase().replace(/\.$/, "");
    if (!DOMAINE.test(d)) return { error: `« ${s} » n'est pas un domaine valide` };
    return { value: d };
  }
  const [addr = "", prefixe, ...extra] = s.split("/");
  if (extra.length || !estIp(addr)) return { error: `« ${s} » n'est ni une IP ni un CIDR` };
  if (prefixe !== undefined) {
    const max = addr.indexOf(":") >= 0 ? 128 : 32;
    if (!/^\d{1,3}$/.test(prefixe) || parseInt(prefixe, 10) > max)
      return { error: `Préfixe invalide dans « ${s} » (0 à ${max})` };
  }
  return { value: s };
}

export function netModeKey(prof: Pick<ProfilReseauEdite, "mode">): string {
  return prof.mode === "bridge" ? "open" : prof.mode === "allowlist_ip" ? "filter" : "block";
}
export function netModeLabel(prof: Pick<ProfilReseauEdite, "mode">): string {
  return prof.mode === "bridge" ? "Ouvert" : prof.mode === "allowlist_ip" ? "Filtré" : "Bloqué";
}
export function netModeIcon(prof: Pick<ProfilReseauEdite, "mode">): string {
  return prof.mode === "bridge"
    ? "ph-globe-hemisphere-west"
    : prof.mode === "allowlist_ip"
      ? "ph-funnel"
      : "ph-prohibit";
}
export function netPortsMode(prof: ProfilReseauEdite): string {
  return prof._portsMode || ((prof.ports || []).length ? "list" : "all");
}

export function creerSandboxAdmin(b: BaseAdmin) {
  const { vue, ctx, e, lien } = b;
  const { computed, ref } = vue;
  const { showToast, openConfirm, fetchAuth } = ctx;
  const { execConfig } = e;
  const execLoading = ref(false);
  const execCharge = ref(false);
  const execHealthcheck: Ref<SanteDocker | null> = ref(null);
  const sandboxContainers: Ref<ConteneurBac[]> = ref([]);
  const staleNetContainers: Ref<ConteneurPerime[]> = ref([]);
  const staleNetBusy = ref(false);
  let compteurProfils = 0;

  /** Textarea « un flag par ligne » ↔ liste `extra_run_args`. */
  const execExtraArgsText = computed({
    get: () => (execConfig.value.extra_run_args || []).join("\n"),
    set: (v: string) => {
      execConfig.value.extra_run_args = String(v || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    },
  });

  /** Champs d'UI d'un profil (brouillons, erreurs, clé stable) : préfixés « _ » et retirés de l'enregistrement. */
  function decorerProfil(
    p: Partial<ProfilReseauEdite> & { id: string; name: string; mode: string },
  ): ProfilReseauEdite {
    return {
      domains: [],
      ports: [],
      dns: [],
      ips: [],
      ...p,
      _uid: `np${++compteurProfils}`,
      _open: false,
      _portsMode: (p.ports || []).length ? "list" : "all",
      _draft: { ips: "", domains: "", ports: "", dns: "" },
      _err: { ips: "", domains: "", ports: "", dns: "" },
    };
  }

  /** Résumé lisible des règles, affiché sur la carte repliée. */
  function netProfileSummary(prof: ProfilReseauEdite): string {
    if (prof.mode === "none") return "Aucune sortie réseau";
    if (prof.mode === "bridge") return "Internet, LAN et métadonnées cloud";
    const n = (a: unknown[] | undefined): number => (a || []).length;
    const morceaux: string[] = [];
    if (n(prof.ips)) morceaux.push(n(prof.ips) + " réseau" + (n(prof.ips) > 1 ? "x" : ""));
    if (n(prof.domains)) morceaux.push(n(prof.domains) + " domaine" + (n(prof.domains) > 1 ? "s" : ""));
    morceaux.push(
      netPortsMode(prof) === "list" && n(prof.ports) ? "ports " + prof.ports.join(", ") : "tous ports",
    );
    if (n(prof.dns)) morceaux.push(n(prof.dns) + " DNS");
    return morceaux.join(" · ");
  }
  /** Motif de refus par le serveur, visible sur la carte repliée (sinon découvert au 400, après avoir tout replié). */
  function netProfileIssue(prof: ProfilReseauEdite): string {
    if (!prof.name || !String(prof.name).trim()) return "Donnez un nom à ce profil.";
    if (!/^[a-z0-9_-]+$/.test(String(prof.id || "")))
      return "Identifiant invalide : minuscules, chiffres, _ ou - uniquement.";
    if (prof.mode === "allowlist_ip" && !(prof.ips || []).length && !(prof.domains || []).length) {
      return "Ajoutez au moins une IP ou un domaine — sinon la sauvegarde est refusée.";
    }
    return "";
  }
  /** À la fermeture d'une carte, les brouillons encore en cours de frappe sont validés (ils seraient perdus). */
  function toggleProfile(prof: ProfilReseauEdite): void {
    if (prof._open) for (const f of CHAMPS_RESEAU) commitNetValue(prof, f.key);
    prof._open = !prof._open;
  }

  function execConfigPayload(): Record<string, unknown> {
    const c = execConfig.value;
    return {
      ...c,
      network_profiles: (c.network_profiles || []).map((p) => {
        const sortie: Record<string, unknown> = {};
        for (const k of Object.keys(p)) if (k.charAt(0) !== "_") sortie[k] = p[k];
        // « Tous » force la liste vide : une liste résiduelle masquée ne doit pas partir en douce.
        sortie["ports"] = netPortsMode(p) === "list" ? p.ports || [] : [];
        return sortie;
      }),
    };
  }
  function setPortsMode(prof: ProfilReseauEdite, mode: string): void {
    prof._portsMode = mode;
    if (mode === "all") {
      prof.ports = [];
      prof._err["ports"] = "";
      prof._draft["ports"] = "";
    }
  }
  function setProfileMode(prof: ProfilReseauEdite, mode: string): void {
    if (prof.id === "isolated") return;
    prof.mode = mode;
  }

  /** Ajoute le brouillon du champ à la liste, plusieurs valeurs d'un coup ; les valeurs refusées restent dans le champ avec le motif. */
  function commitNetValue(prof: ProfilReseauEdite, cle: CleListe): void {
    const brouillon = String(prof._draft[cle] || "").trim();
    prof._err[cle] = "";
    if (!brouillon) return;
    const liste = prof[cle];
    const refusees: string[] = [];
    let premiereErreur = "";
    for (const part of brouillon.split(/[\s,;]+/).filter(Boolean)) {
      const res = normaliserValeur(cle, part);
      if ("error" in res) {
        refusees.push(part);
        if (!premiereErreur) premiereErreur = res.error;
        continue;
      }
      if (res.value === null) continue;
      if (!liste.some((x) => String(x) === String(res.value))) liste.push(res.value);
    }
    prof._draft[cle] = refusees.join(" ");
    prof._err[cle] = refusees.length ? premiereErreur : "";
  }
  function removeNetValue(prof: ProfilReseauEdite, cle: CleListe, idx: number): void {
    prof[cle].splice(idx, 1);
    prof._err[cle] = "";
  }
  function addNetPreset(prof: ProfilReseauEdite, cle: CleListe, valeurs: readonly (string | number)[]): void {
    for (const v of valeurs) if (!prof[cle].some((x) => String(x) === String(v))) prof[cle].push(v);
    prof._err[cle] = "";
  }
  function addNetworkProfile(): void {
    const idx = execConfig.value.network_profiles.length;
    const p = decorerProfil({
      id: `profil_${idx}`,
      name: `Profil ${idx + 1}`,
      mode: "allowlist_ip",
      description: "",
    });
    p._open = true;
    execConfig.value.network_profiles.push(p);
  }
  async function removeNetworkProfile(idx: number): Promise<void> {
    const p = execConfig.value.network_profiles[idx];
    if (p && p.id === "isolated") {
      showToast("Le profil 'isolated' ne peut pas être supprimé.", "warn");
      return;
    }
    const ok = await openConfirm(
      "Supprimer le profil ?",
      `Le profil "${p?.name}" sera retiré. Les utilisateurs qui l'avaient sélectionné repasseront en "isolated".`,
      true,
      "Supprimer",
    );
    if (!ok) return;
    execConfig.value.network_profiles.splice(idx, 1);
  }

  async function recreateStaleNetContainers(): Promise<void> {
    if (!staleNetContainers.value.length || staleNetBusy.value) return;
    staleNetBusy.value = true;
    let reussis = 0;
    try {
      for (const c of staleNetContainers.value) {
        try {
          const r = await fetchAuth(`/api/admin/sandbox/containers/${c.user_id}`, { method: "DELETE" });
          if (r?.ok) reussis++;
        } catch {
          /* bilan global ci-dessous */
        }
      }
      showToast(
        reussis === staleNetContainers.value.length
          ? `${reussis} conteneur(s) recréé(s) au prochain accès`
          : `${reussis}/${staleNetContainers.value.length} conteneur(s) traités`,
        reussis ? "success" : "error",
      );
      staleNetContainers.value = [];
      await loadSandboxContainers();
    } finally {
      staleNetBusy.value = false;
    }
  }

  async function loadExecConfig(): Promise<void> {
    execLoading.value = true;
    try {
      const r = await fetchAuth("/api/admin/executors");
      const data = await lireSchema(r, schemaReponseExecuteurs);
      if (!data) throw new Error("HTTP " + (r ? r.status : "?"));
      const cfg = data.config;
      const limites = Object.keys(cfg.limits || {}).length
        ? cfg.limits
        : { memory_mb: 2048, cpu_quota_pct: 100, pids_max: 512, timeout_s: 600 };
      const nouvelle: ConfigExecEditee = {
        // L'image vit à la racine de la réponse ; elle est en lecture seule (config.json fait foi).
        image: data.image || "",
        limits: limites,
        force_user_docker: !!cfg.force_user_docker,
        idle_kill_hours: cfg.idle_kill_hours || 24,
        network_profiles: (cfg.network_profiles || []).map((p) =>
          decorerProfil({ ...p, ports: p.ports as (string | number)[] }),
        ),
        exec_user: cfg.exec_user || "10001:10001",
        runtime: cfg.runtime || "",
        extra_run_args: cfg.extra_run_args || [],
        jobs: { ...JOBS_PAR_DEFAUT, ...cfg.jobs },
        disk: { ...DISQUE_PAR_DEFAUT, ...cfg.disk },
      };
      execConfig.value = nouvelle;
      lien.markAdminStoreClean("exec");
      execCharge.value = true;
      chargementReussi("loadExecConfig");
      await loadExecHealthcheck();
      await loadSandboxContainers();
    } catch (err) {
      chargementEchoue("loadExecConfig", err instanceof Error ? err.message : String(err), () =>
        loadExecConfig(),
      );
    } finally {
      execLoading.value = false;
    }
  }
  async function loadExecHealthcheck(): Promise<void> {
    try {
      const r = await fetchAuth("/api/admin/executors/healthcheck");
      execHealthcheck.value = r ? await lireSchema(r, schemaReponseSanteDocker) : null;
    } catch (err) {
      execHealthcheck.value = { daemon_ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  /** Le détail d'un refus serveur (règles de validation des profils) garde son propre toast ; le bilan est celui de la page. */
  async function saveExecConfig(): Promise<boolean> {
    execLoading.value = true;
    try {
      // Un brouillon encore dans un champ serait perdu : validé d'abord, comme si l'opérateur avait appuyé sur Entrée.
      for (const p of execConfig.value.network_profiles || []) {
        if (p.mode !== "allowlist_ip" || !p._draft) continue;
        for (const f of CHAMPS_RESEAU) commitNetValue(p, f.key);
      }
      const r = await fetchAuth("/api/admin/executors", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ executors: execConfigPayload() }),
      });
      if (!r || !r.ok) throw new Error(r ? await r.text() : "no response");
      const d = await lireSchema(r, schemaReponseExecuteursEcrits);
      for (const w of d?.warnings ?? []) showToast(w, "warn");
      staleNetContainers.value = (d?.stale_containers ?? []) as typeof staleNetContainers.value;
      await loadExecHealthcheck();
      return true;
    } catch (err) {
      showToast("Sauvegarde refusée : " + (err instanceof Error ? err.message : String(err)), "error");
      return false;
    } finally {
      execLoading.value = false;
    }
  }

  async function loadSandboxContainers(): Promise<void> {
    try {
      const d = await lireSchema(await fetchAuth("/api/admin/sandbox/containers"), schemaReponseConteneurs);
      sandboxContainers.value = d ? d.containers : [];
    } catch {
      sandboxContainers.value = [];
    }
  }
  async function adminStopUserSandbox(userId: number | string | null): Promise<void> {
    const ok = await openConfirm(
      "Arrêter ce conteneur ?",
      `Le conteneur de l'utilisateur ${userId} sera arrêté. Les processus en cours seront tués.`,
      false,
      "Arrêter",
    );
    if (!ok) return;
    try {
      const r = await fetchAuth(`/api/admin/sandbox/containers/${userId}/stop`, { method: "POST" });
      if (!r || !r.ok) throw new Error(r ? await r.text() : "no response");
      showToast("Conteneur arrêté.", "success");
      await loadSandboxContainers();
    } catch (err) {
      showToast("Échec : " + (err instanceof Error ? err.message : String(err)), "error");
    }
  }
  async function adminDestroyUserSandbox(userId: number | string | null): Promise<void> {
    const ok = await openConfirm(
      "Détruire ce conteneur ?",
      `Le conteneur de l'utilisateur ${userId} sera supprimé. Son dossier de travail reste intact.`,
      true,
      "Détruire",
    );
    if (!ok) return;
    try {
      const r = await fetchAuth(`/api/admin/sandbox/containers/${userId}`, { method: "DELETE" });
      if (!r || !r.ok) throw new Error(r ? await r.text() : "no response");
      showToast("Conteneur détruit.", "success");
      await loadSandboxContainers();
    } catch (err) {
      showToast("Échec : " + (err instanceof Error ? err.message : String(err)), "error");
    }
  }
  async function triggerSandboxGc(): Promise<void> {
    const ok = await openConfirm(
      "Lancer le GC ?",
      "Les conteneurs Docker inactifs depuis plus de la durée configurée seront arrêtés.",
      false,
      "Lancer le GC",
    );
    if (!ok) return;
    try {
      const r = await fetchAuth("/api/admin/sandbox/gc", { method: "POST" });
      if (!r || !r.ok) throw new Error(r ? await r.text() : "no response");
      const d = await lireSchema(r, schemaReponseNettoyageBacs);
      showToast(`GC terminé — ${(d?.stopped ?? []).length} container(s) arrêté(s).`, "success");
      await loadSandboxContainers();
    } catch (err) {
      showToast("GC échec : " + (err instanceof Error ? err.message : String(err)), "error");
    }
  }

  return {
    execLoading,
    execCharge,
    execConfig,
    execHealthcheck,
    execExtraArgsText,
    sandboxContainers,
    staleNetContainers,
    staleNetBusy,
    recreateStaleNetContainers,
    addNetworkProfile,
    removeNetworkProfile,
    netFields: CHAMPS_RESEAU,
    netPortsMode,
    setPortsMode,
    setProfileMode,
    commitNetValue,
    removeNetValue,
    addNetPreset,
    toggleProfile,
    netModeKey,
    netModeLabel,
    netModeIcon,
    netProfileSummary,
    netProfileIssue,
    loadExecConfig,
    loadExecHealthcheck,
    saveExecConfig,
    loadSandboxContainers,
    adminStopUserSandbox,
    adminDestroyUserSandbox,
    triggerSandboxGc,
    execConfigPayload,
  };
}
