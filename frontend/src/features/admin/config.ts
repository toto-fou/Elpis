// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/config.ts — configuration de l'instance (config.json) dans la console : chargement avec défauts, enregistrement champ par champ (PATCH) et reprise des conflits, logos, machines de bureau, commandes d'installation, mascottes de l'écran d'accueil. */
import { schemaConflitConfig, schemaReponseFichierConfig } from "@elpis/contracts";
import { shallowRef } from "vue";
import type { Ref } from "vue";

import { corpsJson, estObjet, lireSchema, listeObjets, objet, texte } from "../../utils/lecture-json";
import type { BaseAdmin } from "./etat";
import { diffFeuilles, lireChemin, poserChemin } from "./etat";
import { journal } from "../../platform/journal";
import { suivreHotePort } from "../../utils/llama-url";
import type { ConfigAdmin } from "./types";
import { chargementEchoue, chargementReussi } from "./suivi-chargement";

type Noeud = Record<string, unknown>;

export interface MascotteAdmin {
  id: string;
  label: string;
  apercu?: boolean;
}

interface ScenePrevisualisee {
  detruire(): void;
}
interface ModuleAccueil {
  montrerAccueil(
    hote: HTMLElement,
    options: {
      base: string;
      perso: string;
      motif: string;
      scenario: string;
      intro: boolean;
      mouvement: string;
      echelleMot: number;
      echellePerso: number;
    },
  ): ScenePrevisualisee;
}

const BASE_MASCOTTE = "/static/assets/mascotte/";
const TOUTES_MASCOTTES = ["boite_or", "flamme", "flamme_bleue", "fantome", "elpis"];
const ENTETES_JSON = { "Content-Type": "application/json" };

/** Section objet de `parent[cle]`, créée au besoin. */
function section(parent: Noeud, cle: string): Noeud {
  const v = parent[cle];
  if (estObjet(v)) return v;
  const neuf: Noeud = {};
  parent[cle] = neuf;
  return neuf;
}
/** Complète les clés absentes (`undefined`) d'une section. */
function completer(cible: Noeud, defauts: Noeud): void {
  for (const [k, v] of Object.entries(defauts))
    if (cible[k] === undefined) cible[k] = Array.isArray(v) ? [...v] : v;
}
/** Remplit les valeurs vides (fausses) d'une section. */
function remplirVides(cible: Noeud, defauts: Noeud): void {
  for (const [k, v] of Object.entries(defauts)) if (!cible[k]) cible[k] = v;
}

/** Défauts miroirs de ceux du serveur : un défaut divergent s'écrirait au premier « Enregistrer ». */
function completerConfig(brut: Noeud): ConfigAdmin {
  const c = brut;
  const w = c["welcome"];
  if (!estObjet(w)) {
    c["welcome"] = { type: "icon", icon: "ph-sparkle", width: 96, height: 96, image_b64: "" };
  } else {
    if (!w["width"]) w["width"] = 96;
    if (!w["height"]) w["height"] = 96;
    for (const k of ["gap_text", "gap_bottom", "bg_color", "icon_bg", "text_color"]) delete w[k];
    if (typeof w["icon"] === "string" && w["icon"].includes(" "))
      w["icon"] = w["icon"].split(" ")[0] || "ph-sparkle";
  }
  const welcome = section(c, "welcome");
  const sc = objet(welcome["scene"]);
  const actives = (Array.isArray(sc["mascottes_actives"]) ? sc["mascottes_actives"] : []).filter(
    (m): m is string => typeof m === "string" && TOUTES_MASCOTTES.includes(m),
  );
  welcome["scene"] = {
    mascottes_on: sc["mascottes_on"] !== false,
    motif: texte(sc["motif"]) || "or",
    word_scale: Number(sc["word_scale"]) || 1,
    mascot_scale: Number(sc["mascot_scale"]) || 0.78,
    mascottes_actives: actives.length ? actives : TOUTES_MASCOTTES,
    mascotte_defaut: texte(sc["mascotte_defaut"]) || "boite_or",
  };

  const maintenance = section(c, "maintenance");
  const defautsEntretien: Noeud = {
    hour: 6,
    metrics_retention_days: 90,
    usage_events_retention_days: 180,
    session_messages_retention_days: 180,
    tool_metrics_retention_days: 90,
    routine_runs_retention_days: 180,
    daily_report_retention_days: 400,
  };
  for (const [k, v] of Object.entries(defautsEntretien))
    if (maintenance[k] === undefined || maintenance[k] === null) maintenance[k] = v;

  const security = section(c, "security");
  if (!security["password_policy"]) {
    security["password_policy"] = {
      min_length: 0,
      require_uppercase: false,
      require_lowercase: false,
      require_numbers: false,
      require_special: false,
    };
  }

  if (!c["login_page"]) {
    c["login_page"] = {
      title: "Connexion",
      subtitle: "",
      icon_type: "phosphor",
      icon: "ph-robot",
      icon_color: "#ffffff",
      icon_bg: "#2563eb",
      logo_b64: "",
      bg_color: "#ffffff",
      card_color: "#ffffff",
      text_color: "#0f172a",
      btn_color: "#0f172a",
    };
  } else {
    remplirVides(section(c, "login_page"), {
      icon: "ph-robot",
      icon_color: "#ffffff",
      icon_bg: "#2563eb",
      bg_color: "#ffffff",
      card_color: "#ffffff",
      text_color: "#0f172a",
      btn_color: "#0f172a",
    });
  }

  if (!c["app_info"]) {
    c["app_info"] = {
      name: "Elpis",
      version: "0.1.1",
      team_name: "",
      engine: "llama.cpp",
      description: "",
      icon_type: "phosphor",
      icon: "ph-robot",
      icon_color: "#ffffff",
      icon_bg: "#0f172a",
      logo_b64: "",
      use_welcome_image: false,
    };
  } else {
    const ai = section(c, "app_info");
    remplirVides(ai, { icon: "ph-robot", icon_color: "#ffffff", icon_bg: "#0f172a", engine: "llama.cpp" });
    if (ai["description"] === undefined) ai["description"] = "";
  }

  if (c["llama"]) {
    completer(section(c, "llama"), {
      engine: "llamacpp",
      url: "",
      model: "local-model",
      retries: 1,
      retry_backoff_sec: 0.6,
      max_concurrency: 3,
      max_models: 1,
      n_ctx: 4096,
    });
  }

  const mcp = section(c, "mcp");
  completer(mcp, { servers_dir: "../mcp_custom_servers", tools_cache_ttl_sec: 0 });
  completer(section(mcp, "tokens"), {
    tools_enabled: true,
    tools_families: "fs,shell,git,desktop,browser,skill_run",
    max_days: 90,
    max_per_user: 20,
  });
  completer(section(mcp, "oauth"), {
    enabled: true,
    dcr_enabled: true,
    access_ttl_s: 3600,
    refresh_days: 30,
  });

  const rag = section(c, "rag");
  completer(rag, {
    service_url: "",
    service_token: "",
    service_timeout: 60,
    qdrant_url: "http://127.0.0.1:6333",
    groups: [],
  });
  completer(section(rag, "embed"), { url: "", model: "bge-m3", api_key: "", batch: 32, timeout_s: 60 });
  completer(section(rag, "reranker"), { enabled: false, url: "", model: "bge-reranker-v2-m3" });
  completer(section(rag, "ocr"), { url: "", model: "", api_key: "", timeout_s: 180 });
  completer(section(rag, "quotas"), {
    storage_mb: 2048,
    collections: 10,
    file_mb: 200,
    docs_per_collection: 2000,
  });
  completer(section(rag, "indexation"), { concurrence: 2, par_compte: 1 });

  if (c["app"])
    completer(section(c, "app"), { upload_dir: "user_db/uploads", sandbox_dir: "../user_sandboxes" });

  completer(section(c, "features"), { opencode: true, office_preview: true });

  const session = security["session"];
  if (!session) {
    security["session"] = {
      max_age_sec: 86400,
      idle_timeout_sec: 0,
      cookie_name: "mcpwebui_session",
      same_site: "lax",
      https_only: false,
      global_min_ts: 0,
    };
  } else {
    completer(section(security, "session"), {
      max_age_sec: 86400,
      idle_timeout_sec: 0,
      cookie_name: "mcpwebui_session",
      same_site: "lax",
      https_only: false,
      global_min_ts: 0,
    });
  }

  if (!c["vision"])
    c["vision"] = { endpoint_url: "", format: "omniparser", prompt: "", model: "", passes: 2 };
  else
    completer(section(c, "vision"), {
      endpoint_url: "",
      format: "omniparser",
      prompt: "",
      model: "",
      passes: 2,
    });

  const voice = section(c, "voice");
  if (voice["enabled"] === undefined) voice["enabled"] = false;
  const defautsVoix: Record<"stt" | "tts", Noeud> = {
    stt: {
      endpoint_url: "",
      format: "whisper.cpp",
      model: "",
      language: "fr",
      prompt: "",
      token: "",
      logprob_min: -1.0,
      timeout_sec: 30,
      max_upload_mb: 10,
      max_utterance_sec: 30,
      max_concurrent: 1,
      verify: true,
    },
    tts: {
      endpoint_url: "",
      format: "elpis-tts",
      token: "",
      model: "",
      voice: "fr_FR-siwis-medium",
      speed: 1.0,
      timeout_sec: 30,
      max_chars: 4000,
      max_concurrent: 2,
      verify: true,
    },
  };
  for (const sect of ["stt", "tts"] as const) completer(section(voice, sect), defautsVoix[sect]);

  const image = section(c, "image");
  completer(image, {
    enabled: false,
    provider: "sdcpp",
    url: "",
    model: "",
    verify: true,
    ca_pem: "",
    timeout_sec: 180,
    max_concurrent: 1,
    max_n: 4,
    max_side: 2048,
    default_side: 1024,
    size_policy: "free",
    sizes: [],
    edit_mode: "init",
    keep_per_user: 50,
    groups: [],
    tool_max_calls: 4,
    enhance_enabled: true,
  });

  const desktop = section(c, "desktop");
  if (!Array.isArray(desktop["targets"])) desktop["targets"] = [];
  completer(desktop, { screenshot_format: "png", screenshot_quality: 85 });
  return c as ConfigAdmin;
}

export function creerConfig(b: BaseAdmin) {
  const { vue, ctx, e, lien } = b;
  const { computed, ref, watch } = vue;
  const { showToast, fetchAuth } = ctx;
  const configForm = e.configForm;

  // Moteur local : l'URL complète suit l'hôte et le port quand elle visait exactement l'ancien hôte:port.
  watch(
    () => {
      const l = configForm.value?.llama;
      return l ? [l.ip, l.port] : null;
    },
    (nv, ov) => {
      const l = configForm.value?.llama;
      if (!l || !nv || !ov) return;
      const url = suivreHotePort(l.url, ov[0], ov[1], nv[0], nv[1]);
      if (url !== l.url) l.url = url;
    },
  );

  async function loadAdminConfig(type: string): Promise<void> {
    if (type !== "main") return;
    // Anti-clobber : des modifications en cours (formulaire différent du dernier état chargé) sont préservées.
    if (
      configForm.value &&
      e.adminPristine.value.config !== null &&
      JSON.stringify(configForm.value) !== e.adminPristine.value.config
    ) {
      return;
    }
    try {
      const res = await fetchAuth(`/api/admin/config-file?type=${type}`);
      const d = await lireSchema(res, schemaReponseFichierConfig);
      if (!d)
        chargementEchoue("loadAdminConfig", "Réponse du serveur inattendue ou en échec.", () =>
          loadAdminConfig(type),
        );
      else chargementReussi("loadAdminConfig");
      if (d) {
        try {
          // Copie de ce qui est sur disque, avant tout défaut rempli : c'est la valeur « from » du PATCH.
          try {
            e.configRaw = objet(JSON.parse(d.content));
          } catch {
            e.configRaw = {};
          }
          configForm.value = completerConfig(objet(JSON.parse(d.content)));
          const vx = configForm.value;
          setTimeout(() => {
            void lien.loadVoiceModels("stt");
            void lien.loadVoiceModels("tts");
          }, 0);
          if (vx.image.url) setTimeout(() => void lien.loadImageModels(), 0);
        } catch {
          configForm.value = {} as ConfigAdmin;
        }
        // Référence « propre » après remplissage des défauts : toute divergence ultérieure est une modification.
        lien.markAdminStoreClean("config");
      }
    } catch {
      chargementEchoue("loadAdminConfig", "Erreur réseau.", () => loadAdminConfig(type));
    }
    void lien.loadSecurityOverview();
    void lien.loadHttpsStatus();
  }

  const patchRaw = (chemin: string, valeur: unknown): void => poserChemin(e.configRaw, chemin, valeur);

  /** Écriture champ par champ : seuls les champs modifiés partent, chacun avec sa valeur d'origine ; 409 propose reprise ou écrasement. */
  async function saveConfigStore(force?: boolean): Promise<boolean> {
    if (e.isSavingAdminConfig.value) return false;
    if (!configForm.value || e.adminPristine.value.config == null) return false;
    const diff = diffFeuilles(JSON.parse(e.adminPristine.value.config), configForm.value);
    if (!diff.length) return true;
    const changements = diff.map((d) => {
      const c: Record<string, unknown> = { path: d.path };
      if (d.removed) c["delete"] = true;
      else c["to"] = d.after;
      const r = lireChemin(e.configRaw, d.path);
      if (r.found) c["from"] = r.value;
      else c["from_absent"] = true;
      return c;
    });
    e.isSavingAdminConfig.value = true;
    let res: Response | null;
    try {
      res = await fetchAuth("/api/admin/config", {
        method: "PATCH",
        headers: ENTETES_JSON,
        body: JSON.stringify(
          force === true ? { changes: changements, force: true } : { changes: changements },
        ),
      });
    } catch {
      res = null;
    } finally {
      e.isSavingAdminConfig.value = false;
    }
    if (!res) return false;
    if (res.ok) {
      for (const c of changements) patchRaw(String(c["path"]), c["delete"] ? undefined : c["to"]);
      void ctx.loadPublicConfig();
      void lien.loadRestartStatus();
      return true;
    }
    const corps: unknown = await corpsJson(res);
    const conflit = schemaConflitConfig.safeParse(corps);
    if (res.status === 409 && conflit.success && conflit.data.conflicts.length) {
      const noms = conflit.data.conflicts
        .map((c) => lien.adminChangeLabel({ store: "config", path: c.path }))
        .join(", ");
      const choix = await ctx.openChoice(
        "Modifié ailleurs entre-temps",
        noms + " : la valeur a changé sur le serveur depuis l’ouverture de la page.",
        [
          { id: "force", label: "Écraser", tone: "danger" },
          { id: "reload", label: "Reprendre la valeur du serveur", tone: "primary" },
        ],
        "Annuler",
      );
      if (choix === "force") return saveConfigStore(true);
      if (choix === "reload") {
        // On adopte la valeur du serveur pour les champs en conflit ; le diff recalculé n'envoie plus que les autres.
        const propre: unknown = JSON.parse(e.adminPristine.value.config);
        for (const c of conflit.data.conflicts) {
          const v = c.absent ? undefined : c.current;
          poserChemin(configForm.value, c.path, v);
          poserChemin(propre, c.path, v);
          patchRaw(c.path, v);
        }
        e.adminPristine.value.config = JSON.stringify(propre);
        // Les observateurs de la page (URL qui suit l'hôte) passent avant le diff.
        await ctx.nextTick();
        return saveConfigStore();
      }
      return false;
    }
    const detail = objet(corps)["detail"];
    if (detail) showToast(typeof detail === "string" ? detail : "Enregistrement refusé", "error");
    return false;
  }

  // ── Logos et image d'accueil ─────────────────────────────────────────────
  const fichierChoisi = (event: Event): File | null =>
    (event.target instanceof HTMLInputElement ? event.target.files?.[0] : undefined) ?? null;
  function lireEnDonnees(fichier: File, suite: (donnees: string) => void): void {
    const lecteur = new FileReader();
    lecteur.onload = () => {
      if (typeof lecteur.result === "string") suite(lecteur.result);
    };
    lecteur.readAsDataURL(fichier);
  }
  function handleLoginLogoUpload(event: Event): void {
    const f = fichierChoisi(event);
    if (!f) return;
    lireEnDonnees(f, (data) => {
      const lp = configForm.value?.login_page;
      if (!lp) return;
      lp.logo_b64 = data;
      lp.icon_type = "image";
    });
  }
  const logoARecadrer: Ref<File | null> = shallowRef(null);
  /** Le logo choisi passe d'abord par la fenêtre de recadrage ; le champ est vidé pour pouvoir reprendre le même fichier. */
  function handleAppInfoLogoUpload(event: Event): void {
    const f = fichierChoisi(event);
    if (event.target instanceof HTMLInputElement) event.target.value = "";
    if (f) logoARecadrer.value = f;
  }
  /** Logo recadré (carré, redimensionné par le navigateur) posé dans le formulaire, enregistré avec lui. */
  function appliquerLogoRecadre(f: File): void {
    logoARecadrer.value = null;
    lireEnDonnees(f, (data) => {
      const ai = configForm.value?.app_info;
      if (!ai) return;
      ai.logo_b64 = data;
      ai.use_welcome_image = false;
    });
  }
  function annulerRecadrageLogo(): void {
    logoARecadrer.value = null;
  }
  function erreurRecadrageLogo(message: string): void {
    logoARecadrer.value = null;
    showToast(message, "error");
  }
  function handleAdminWelcomeUpload(event: Event): void {
    const f = fichierChoisi(event);
    if (!f) return;
    if (f.size > 1024 * 1024) showToast("L'image est un peu lourde (>1Mo).", "warning");
    lireEnDonnees(f, (data) => {
      const form = configForm.value;
      if (!form) return;
      if (!form.welcome) {
        form.welcome = {
          type: "image",
          icon: "ph-sparkle text-blue-500",
          width: 96,
          height: 96,
          image_b64: "",
        } as ConfigAdmin["welcome"];
      }
      form.welcome.image_b64 = data;
      form.welcome.type = "image";
    });
  }

  // ── Machines pilotables ──────────────────────────────────────────────────
  function addDesktopTarget(): void {
    const form = configForm.value;
    if (!form) return;
    if (!form.desktop) form.desktop = { targets: [], screenshot_format: "png", screenshot_quality: 85 };
    if (!Array.isArray(form.desktop.targets)) form.desktop.targets = [];
    form.desktop.targets.push({
      name: "",
      os: "win",
      agent_url: "",
      agent_token: "",
      default: false,
      access: "all",
      allowed_users: [],
    });
  }
  function removeDesktopTarget(i: number): void {
    const cibles = configForm.value?.desktop?.targets;
    if (Array.isArray(cibles)) cibles.splice(i, 1);
  }
  function setDefaultTarget(i: number): void {
    configForm.value?.desktop?.targets?.forEach((t, j) => {
      t.default = j === i;
    });
  }

  // ── Installation de l'agent de bureau ────────────────────────────────────
  // Les routes /api/desktop/* ne vivent que sur le process principal : en mode scindé on préfère l'URL publique du process main.
  const baseInstallation = computed(() => {
    const main = ctx.mainAppUrl?.value;
    return typeof main === "string" && main ? main.replace(/\/+$/, "") : window.location.origin;
  });
  const baseAmorcage = computed(() => {
    const base = baseInstallation.value;
    try {
      return base.startsWith("https:") ? "http://" + new URL(base).hostname : base;
    } catch {
      return base;
    }
  });
  const installShCmd = computed(() => "curl -fsSL " + baseAmorcage.value + "/agent | bash");
  const installPs1Cmd = computed(() => "iex(irm " + baseAmorcage.value + "/agent.ps1)");
  /** Endpoint public potentiellement inter-origines : la navigation passe là où un fetch serait bloqué par CORS. */
  function downloadAgentBundle(): void {
    window.open(baseInstallation.value + "/api/desktop/agent-bundle", "_blank");
  }
  function copyInstallCmd(cmd: string): void {
    try {
      void navigator.clipboard.writeText(cmd);
      showToast("Commande copiée");
    } catch {
      showToast("Copie impossible", "error");
    }
  }

  // ── Mascottes de l'écran d'accueil ───────────────────────────────────────
  const MASCOTTES_ADMIN: Ref<MascotteAdmin[]> = ref([
    { id: "boite_or", label: "Coffre" },
    { id: "flamme", label: "Flamme" },
    { id: "flamme_bleue", label: "Flamme bleue", apercu: false },
    { id: "fantome", label: "Fantôme" },
    { id: "elpis", label: "Elpis" },
  ]);
  void (async () => {
    try {
      const r = await fetchAuth(BASE_MASCOTTE + "mascottes.json", {}, true);
      const d = r?.ok ? objet(await r.json()) : null;
      const l = d ? listeObjets(d["mascottes"]).filter((m) => m["id"]) : [];
      if (l.length) MASCOTTES_ADMIN.value = l as unknown as MascotteAdmin[];
    } catch {
      /* repli sur la liste d'origine */
    }
  })();

  const mascotteActive = (id: string): boolean =>
    !!configForm.value?.welcome?.scene?.mascottes_actives?.includes(id);
  /** Décocher la dernière est refusé ; décocher le défaut le déplace (un défaut désactivé serait un réglage qui ment). */
  function basculerMascotte(id: string): void {
    const sc = configForm.value?.welcome.scene;
    if (!sc) return;
    const actives = new Set(sc.mascottes_actives || []);
    if (actives.has(id)) {
      if (actives.size <= 1) {
        showToast("Il faut en garder au moins une active.", "warning");
        return;
      }
      actives.delete(id);
    } else {
      actives.add(id);
    }
    sc.mascottes_actives = MASCOTTES_ADMIN.value.map((m) => m.id).filter((x) => actives.has(x));
    if (!actives.has(sc.mascotte_defaut)) sc.mascotte_defaut = sc.mascottes_actives[0] ?? sc.mascotte_defaut;
  }
  const MASCOTTES_APERCU = computed(() => MASCOTTES_ADMIN.value.filter((m) => m.apercu !== false));
  const apercuAccueil: Ref<HTMLElement | null> = ref(null);
  const apercuPerso = ref("boite_or");
  let scene: ScenePrevisualisee | null = null;
  let montage = 0;

  /** Aperçu vivant du mot animé, monté à la demande : la console ne télécharge pas le moteur d'accueil avant cet onglet. */
  async function monterApercuAccueil(): Promise<void> {
    const hote = apercuAccueil.value;
    const sc = configForm.value?.welcome?.scene;
    if (!hote || !sc) return;
    const jeton = ++montage;
    let mod: ModuleAccueil;
    try {
      mod = await import("../mascotte/accueil");
    } catch (err) {
      journal.erreur("[admin] accueil.js illisible :", err);
      return;
    }
    if (jeton !== montage) return;
    scene?.detruire();
    scene = mod.montrerAccueil(hote, {
      base: BASE_MASCOTTE,
      perso: apercuPerso.value,
      motif: sc.motif || "or",
      scenario: "vol",
      intro: false,
      mouvement: "toujours",
      echelleMot: Number(sc.word_scale) || 1,
      echellePerso: Number(sc.mascot_scale) || 0.78,
    });
  }
  watch(apercuAccueil, (h) => {
    if (h) void monterApercuAccueil();
    else {
      scene?.detruire();
      scene = null;
    }
  });
  watch(
    () => {
      const sc = configForm.value?.welcome?.scene;
      return sc ? `${sc.motif}|${sc.word_scale}|${sc.mascot_scale}|${apercuPerso.value}` : "";
    },
    () => {
      if (apercuAccueil.value) void monterApercuAccueil();
    },
  );

  return {
    configForm,
    isSavingAdminConfig: e.isSavingAdminConfig,
    loadAdminConfig,
    saveConfigStore,
    handleLoginLogoUpload,
    handleAppInfoLogoUpload,
    logoARecadrer,
    appliquerLogoRecadre,
    annulerRecadrageLogo,
    erreurRecadrageLogo,
    handleAdminWelcomeUpload,
    addDesktopTarget,
    removeDesktopTarget,
    setDefaultTarget,
    downloadAgentBundle,
    installShCmd,
    installPs1Cmd,
    copyInstallCmd,
    apercuAccueil,
    apercuPerso,
    MASCOTTES_APERCU,
    MASCOTTES_ADMIN,
    mascotteActive,
    basculerMascotte,
  };
}
