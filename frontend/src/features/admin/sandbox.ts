// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/sandbox.ts — console › Sandbox : limites et politique, profils réseau (cartes repliables, puces validées à la saisie, ce que voient leurs sandboxes), conteneurs des comptes et nettoyage. */
import { rstripPy } from "@elpis/commun/python";
import {
  schemaReponseConteneurs,
  schemaReponseEtatExecuteurs,
  schemaReponseExecuteurs,
  schemaReponseExecuteursEcrits,
  schemaReponseNettoyageBacs,
  schemaReponseSanteDocker,
} from "@elpis/contracts";
import type { CompteProfilReseau, MachineReseau } from "@elpis/contracts";
import type { Ref } from "vue";

import { copierTexte } from "../../utils/dom";
import { lireSchema } from "../../utils/lecture-json";
import { DISQUE_PAR_DEFAUT, JOBS_PAR_DEFAUT } from "./etat";
import type { BaseAdmin, ConfigExecEditee, ProfilReseauEdite } from "./etat";
import { pluriel } from "./formats";
import { domainesSansAdresse, IPV4, profilDurci, reglesPosees, texteRegles } from "./reseau-vue";
import type { ContexteVue, EtatServeur } from "./reseau-vue";
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
type CleProtection = "block_metadata" | "block_lan" | "block_host";

/** Protections d'un profil ouvert : cochées, elles font tourner ses sandboxes sans sudo. */
export const PROTECTIONS_RESEAU: readonly { key: CleProtection; label: string; title: string }[] =
  Object.freeze([
    {
      key: "block_metadata",
      label: "Métadonnées du cloud",
      title:
        "Refuse 169.254.0.0/16 et les autres adresses de métadonnées des principaux clouds (jetons de la machine).",
    },
    {
      key: "block_lan",
      label: "Réseau local",
      title:
        "Refuse les adresses privées (10/8, 172.16/12, 192.168/16, 100.64/10), le lien local, la multidiffusion et les adresses réservées.",
    },
    {
      key: "block_host",
      label: "Machine hôte",
      title:
        "Refuse les adresses de la machine qui héberge Elpis, la diffusion et la multidiffusion ; relues avant chaque usage, la sandbox est recréée si elles changent.",
    },
  ]);

export interface ChampReseau {
  key: CleListe;
  label: string;
  ph: string;
  /** Aide visible sous le champ ; `title` garde le détail. */
  aide: string;
  title: string;
  quick?: { label: string; values: number[] }[];
}

export const CHAMPS_RESEAU: readonly ChampReseau[] = Object.freeze([
  {
    key: "ips",
    label: "Adresses et réseaux",
    ph: "203.0.113.10 ou 10.20.0.0/16",
    aide: "IPv4 ou réseau IPv4 ; l'IPv6 est refusée.",
    title:
      "Une IP (10.0.0.5) ou un réseau CIDR (10.0.0.0/24). Plusieurs valeurs acceptées, séparées par un espace ou une virgule.",
  },
  {
    key: "domains",
    label: "Domaines",
    ph: "api.exemple.com",
    aide: "Résolus à la création de la sandbox : la première adresse est épinglée, toutes sont autorisées.",
    title:
      "Résolu côté hôte à la création du conteneur : sa première adresse est épinglée dans /etc/hosts, toutes sont autorisées ; pas besoin d'ouvrir le DNS, et le rebinding est neutralisé.",
  },
  {
    key: "ports",
    label: "Ports",
    ph: "443",
    aide: "Liste : TCP sur ces ports ; Tous : tous ports et protocoles.",
    title: "Ports TCP sortants autorisés, pour toutes les destinations du profil.",
    quick: [
      { label: "Web", values: [80, 443] },
      { label: "SSH", values: [22] },
    ],
  },
  {
    key: "dns",
    label: "Résolveurs DNS",
    ph: "10.0.0.53",
    aide: "Joignables sur le port 53 seulement ; sans résolveur, seuls les domaines listés ont une adresse.",
    title:
      "Résolveurs joignables (--dns + port 53). Utile seulement si le conteneur doit résoudre en direct ; les domaines listés ci-dessus n'en ont pas besoin.",
  },
]);

/** Règle Git d'un profil : ce que le relais Git joint pour ses sandboxes, quel que soit le mode réseau. */
export const ACCES_GIT: readonly { key: string; label: string; title: string; aide: string }[] =
  Object.freeze([
    {
      key: "all",
      label: "Tous",
      title: "Tous les dépôts que le relais Git peut joindre (par défaut).",
      aide: "Le relais Git joint tous les dépôts (par défaut).",
    },
    {
      key: "servers",
      label: "Serveurs choisis",
      title:
        "Seuls les serveurs listés, entiers (git.exemple.lan) ou limités à une organisation (github.com/acme).",
      aide: "Seuls les serveurs listés, entiers (git.exemple.lan) ou limités à une organisation (github.com/acme).",
    },
    {
      key: "accounts",
      label: "Comptes Git",
      title:
        "Seuls les dépôts que couvrent les comptes Git de chaque utilisateur (Paramètres › Secrets › Comptes Git).",
      aide: "Seuls les dépôts que couvrent les comptes Git vérifiés de chaque utilisateur.",
    },
  ]);

/** Aide visible du mode réseau d'un profil. */
const AIDES_MODE: Readonly<Record<string, string>> = {
  none: "Le conteneur n'a aucune interface réseau ; seuls les relais de l'hôte (Git, navigateur) répondent.",
  allowlist_ip:
    "Tout est refusé, sauf les destinations listées ci-dessous ; les sandboxes tournent sans sudo.",
  bridge: "Internet ouvert ; cochez ce qu'il faut refuser en plus.",
};
/** Onglets du panneau « Ce que voient les sandboxes ». */
export const VUES_RESEAU = ["graphe", "tableau", "regles"] as const;
export type VueReseau = (typeof VUES_RESEAU)[number];
const SERVEUR_GIT =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[1-9][0-9]{0,4})?(?:\/[A-Za-z0-9._~-]+)*$/;

/** Serveur Git saisi, en forme (`https://` et `.git` retirés, hôte sans la casse, chemin tel quel) ; `null` s'il ne se lit pas. */
function serveurGitSaisi(brut: string): string | null {
  let s = rstripPy(brut.trim().replace(/^https?:\/\//i, ""), "/");
  if (s.toLowerCase().endsWith(".git")) s = s.slice(0, -4);
  const barre = s.indexOf("/");
  s = barre < 0 ? s.toLowerCase() : s.slice(0, barre).toLowerCase() + s.slice(barre);
  const port = /^[^/]*:([0-9]+)(?:\/|$)/.exec(s)?.[1];
  if (port !== undefined && Number(port) > 65535) return null;
  return SERVEUR_GIT.test(s) && !s.split("/").some((x) => x === "." || x === "..") ? s : null;
}

const DOMAINE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

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
    if (!IPV4.test(s)) return { error: `« ${s} » doit être l'adresse IPv4 d'un résolveur` };
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
  if (extra.length || !IPV4.test(addr))
    return { error: `« ${s} » n'est ni une adresse IPv4 ni un réseau IPv4` };
  if (prefixe !== undefined && (!/^\d{1,2}$/.test(prefixe) || parseInt(prefixe, 10) > 32))
    return { error: `Préfixe invalide dans « ${s} » (0 à 32)` };
  return { value: s };
}

export function netModeKey(prof: Pick<ProfilReseauEdite, "mode">): string {
  return prof.mode === "bridge" ? "open" : prof.mode === "allowlist_ip" ? "filter" : "block";
}
export function netModeLabel(prof: Pick<ProfilReseauEdite, "mode">): string {
  return prof.mode === "bridge" ? "Ouvert" : prof.mode === "allowlist_ip" ? "Liste" : "Bloqué";
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
  /** Résolution du moment des domaines des profils filtrés : par profil puis par domaine (`[]` irrésoluble, `null` sans réponse). */
  const etatDomaines: Ref<Record<string, Record<string, string[] | null>>> = ref({});
  /** Comptes et profil effectif de leur sandbox ; `null` tant que l'état n'est pas lu. */
  const comptesReseau: Ref<CompteProfilReseau[] | null> = ref(null);
  /** Relevé de la machine, ce que refuse la protection « hôte » ; `null` s'il manque. */
  const machineReseau: Ref<MachineReseau | null> = ref(null);
  /** État de `/api/admin/executors/status` : attendu, en échec ou reçu. */
  const etatReseau: Ref<EtatServeur> = ref("attente");
  /** Hôtes d'outils distants déclarés : leurs sandboxes reçoivent les adresses de leur hôte, pas celles relevées ici. */
  const hotesDistants = ref(false);
  /** Ce que la vue d'un profil sait en plus du profil édité : sudo, machine, adresses des domaines par nom, état du serveur. */
  const contexteReseau = computed<ContexteVue>(() => ({
    sudo: execConfig.value.allow_sudo,
    machine: machineReseau.value,
    domaines: Object.assign({}, ...Object.values(etatDomaines.value)) as Record<string, string[] | null>,
    etat: etatReseau.value,
  }));
  let compteurProfils = 0;
  /** Sauvegardes lancées depuis le chargement : un état demandé avant la dernière est ignoré. */
  let generationEtat = 0;

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
      _idCharge: p.id,
      _open: false,
      _onglet: "graphe",
      _portsMode: (p.ports || []).length ? "list" : "all",
      _draft: { ips: "", domains: "", ports: "", dns: "", git_servers: (p.git_servers || []).join("\n") },
      _err: { ips: "", domains: "", ports: "", dns: "", git_servers: "" },
    };
  }

  /** Résumé lisible des règles, affiché sur la carte repliée. */
  function netProfileSummary(prof: ProfilReseauEdite): string {
    if (prof.mode === "none") return "Aucune sortie réseau";
    if (prof.mode === "bridge") {
      const refus = PROTECTIONS_RESEAU.filter((x) => prof[x.key] === true).map((x) => x.label.toLowerCase());
      return refus.length
        ? `Internet ; refusés : ${refus.join(", ")}`
        : "Internet, réseau local, machine hôte et métadonnées du cloud";
    }
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
    if (prof._open) {
      for (const f of CHAMPS_RESEAU) commitNetValue(prof, f.key);
      if (prof.git_access === "servers") commitGitServers(prof);
    }
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
  /** Serveurs Git du brouillon, un par ligne : les illisibles restent dans le champ avec le motif. */
  function commitGitServers(prof: ProfilReseauEdite): void {
    const gardes: string[] = [];
    const refus: string[] = [];
    for (const part of String(prof._draft["git_servers"] || "")
      .split(/[\s,;]+/)
      .filter(Boolean)) {
      const v = serveurGitSaisi(part);
      if (v === null) refus.push(part);
      else if (!gardes.includes(v)) gardes.push(v);
    }
    prof.git_servers = gardes;
    prof._draft["git_servers"] = [...gardes, ...refus].join("\n");
    prof._err["git_servers"] = refus.length
      ? `Serveur illisible : ${refus.join(", ")} (hôte[:port] ou hôte/organisation)`
      : "";
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
      block_metadata: true,
      block_lan: false,
      block_host: true,
    });
    p._open = true;
    execConfig.value.network_profiles.push(p);
  }
  /** Règle Git du profil de repli, telle qu'éditée : le message de suppression la nomme. */
  function regleGitIsole(): string {
    const iso = execConfig.value.network_profiles.find((q) => q.id === "isolated");
    const acces = ACCES_GIT.find((x) => x.key === (iso?.git_access || "all"));
    return (acces?.label ?? "Tous").toLowerCase();
  }

  async function removeNetworkProfile(idx: number): Promise<void> {
    const p = execConfig.value.network_profiles[idx];
    if (p && p.id === "isolated") {
      showToast("Le profil 'isolated' ne peut pas être supprimé.", "warn");
      return;
    }
    const ok = await openConfirm(
      "Supprimer le profil ?",
      `Le profil "${p?.name}" sera retiré. Les utilisateurs qui l'avaient sélectionné repasseront en "isolated" : aucune sortie réseau, et la règle Git de ce profil (${regleGitIsole()}).`,
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
        allow_sudo: cfg.allow_sudo !== false,
        jobs: { ...JOBS_PAR_DEFAUT, ...cfg.jobs },
        disk: { ...DISQUE_PAR_DEFAUT, ...cfg.disk },
      };
      execConfig.value = nouvelle;
      lien.markAdminStoreClean("exec");
      execCharge.value = true;
      chargementReussi("loadExecConfig");
      await loadExecHealthcheck();
      await loadSandboxContainers();
      void loadExecStatus();
    } catch (err) {
      chargementEchoue("loadExecConfig", err instanceof Error ? err.message : String(err), () =>
        loadExecConfig(),
      );
    } finally {
      execLoading.value = false;
    }
  }
  /** Domaines résolus, conteneurs à recréer, comptes et relevé de la machine, en arrière-plan : une résolution lente ne retient pas la page, un échec est dit par la vue. */
  async function loadExecStatus(): Promise<void> {
    const generation = generationEtat;
    try {
      const d = await lireSchema(await fetchAuth("/api/admin/executors/status"), schemaReponseEtatExecuteurs);
      if (generation !== generationEtat) return;
      if (!d) {
        etatReseau.value = "echec";
        return;
      }
      etatDomaines.value = d.domains_status;
      comptesReseau.value = d.accounts;
      machineReseau.value = d.machine;
      hotesDistants.value = d.remote_toolhosts;
      etatReseau.value = "charge";
      if (d.stale_containers.length) staleNetContainers.value = d.stale_containers as ConteneurPerime[];
    } catch {
      if (generation === generationEtat) etatReseau.value = "echec";
    }
  }
  /** Domaines d'un profil sans adresse à l'instant (irrésolus, ou sans réponse à temps). */
  function domainesNonResolus(prof: ProfilReseauEdite): string[] {
    return domainesSansAdresse(prof, contexteReseau.value);
  }
  /** Comptes dont la sandbox suit ce profil, rattachés par son identifiant enregistré. */
  function comptesDuProfil(prof: ProfilReseauEdite): CompteProfilReseau[] {
    return (comptesReseau.value ?? []).filter((c) => c.profile_id === prof._idCharge);
  }
  /** Identifiant changé alors que des comptes suivent le profil : à l'enregistrement, ils repassent sur le profil isolé ; `""` sinon. */
  function avertissementIdentifiant(prof: ProfilReseauEdite): string {
    const n = prof.id === prof._idCharge ? 0 : comptesDuProfil(prof).length;
    if (n === 0) return "";
    const [verbe, leur] = n > 1 ? ["repasseront", "leur"] : ["repassera", "son"];
    return `Identifiant changé : à l'enregistrement, ${pluriel(n, "compte")} ${verbe} sur le profil isolé, car ${leur} réglage vise « ${prof._idCharge} ».`;
  }
  /** Sandboxes du profil durcies : sans sudo, système en lecture seule. */
  function sansSudo(prof: ProfilReseauEdite): boolean {
    return profilDurci(prof, execConfig.value.allow_sudo);
  }
  function aideMode(prof: ProfilReseauEdite): string {
    return (
      (prof.id === "isolated" ? "Profil de repli : toujours sans réseau. " : "") +
      (AIDES_MODE[prof.mode] ?? "")
    );
  }
  function aideAccesGit(prof: ProfilReseauEdite): string {
    return ACCES_GIT.find((g) => g.key === (prof.git_access || "all"))?.aide ?? "";
  }
  function choisirVueReseau(prof: ProfilReseauEdite, vue: VueReseau): void {
    prof._onglet = vue;
  }
  /** Copie les règles qu'une sandbox du profil recevrait maintenant. */
  async function copierReglesReseau(prof: ProfilReseauEdite): Promise<void> {
    const r = reglesPosees(prof, contexteReseau.value);
    if (r.genre !== "regles") return;
    try {
      await copierTexte(texteRegles(r));
      showToast("Règles copiées", "success");
    } catch {
      showToast("Copie impossible : sélectionnez le texte", "error");
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
    generationEtat++;
    try {
      // Un brouillon encore dans un champ serait perdu : validé d'abord, comme si l'opérateur avait appuyé sur Entrée.
      for (const p of execConfig.value.network_profiles || []) {
        if (p._draft && p.git_access === "servers") commitGitServers(p);
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
      for (const p of execConfig.value.network_profiles) p._idCharge = p.id;
      for (const w of d?.warnings ?? []) showToast(w, "warn");
      staleNetContainers.value = (d?.stale_containers ?? []) as typeof staleNetContainers.value;
      await loadExecHealthcheck();
      void loadExecStatus();
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
    etatDomaines,
    domainesNonResolus,
    comptesReseau,
    contexteReseau,
    hotesDistants,
    comptesDuProfil,
    avertissementIdentifiant,
    sansSudo,
    aideMode,
    aideAccesGit,
    choisirVueReseau,
    copierReglesReseau,
    netProtections: PROTECTIONS_RESEAU,
    accesGit: ACCES_GIT,
    commitGitServers,
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
