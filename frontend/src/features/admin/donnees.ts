// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/donnees.ts — console › Données et services : base de données (test, simulation, bascule, retour SQLite), moteur vocal (test, modèles chargés) et moteur d'images (test, modèles, clé scellée, groupes, tailles). */
import { schemaReponseBase } from "@elpis/contracts";
import type { ReponseBase } from "@elpis/contracts";
import type { Ref } from "vue";

import { corpsJson, detailErreur, listeObjets, objet, texte } from "../../utils/lecture-json";
import type { BaseAdmin } from "./etat";

const ENTETES_JSON = { "Content-Type": "application/json" };

type Noeud = Record<string, unknown>;

export interface FormulaireBase {
  backend: string;
  host: string;
  port: number | string;
  name: string;
  user: string;
  tls: string;
  password: string;
}
export interface DetailTestBase {
  version?: string;
  tables?: number | string;
  partial?: boolean;
  empty?: boolean;
  query_ms?: number;
  unaccent?: boolean;
  [cle: string]: unknown;
}
export interface DetailSimulation {
  tables: Record<string, { source?: number; [cle: string]: unknown }>;
  ignored?: Record<string, unknown>;
  [cle: string]: unknown;
}
/** Issue d'un test lancé depuis la page : repos, en cours, réussie avec détail ou en erreur avec message. */
export type EtatEssai<T> =
  { state: "idle" | "busy"; detail: null } | { state: "ok"; detail: T } | { state: "err"; detail: string };
export interface EtatTacheBase {
  state: string;
  step?: string;
  progress?: number[];
  error?: string;
  [cle: string]: unknown;
}
export interface EtatVoixEssai {
  state: string;
  parts: { id: string; ok: boolean; title: string; detail: string }[];
  voices: unknown[];
  allOk: boolean;
  error: string | null;
  warnings?: string[];
}
export interface ModelesVoix {
  state: string;
  models: { id: string; [cle: string]: unknown }[];
  current: unknown;
  detail: string;
  error: string;
}
export interface ResultatImage {
  ok?: boolean;
  error?: string;
  model?: string;
  latency_ms?: number;
  limits?: Record<string, unknown>;
  warnings?: string[];
  [cle: string]: unknown;
}
export interface EtatImageEssai {
  state: string;
  res: ResultatImage | null;
  error: string | null;
  adjusted: boolean;
}
export interface ModelesImages {
  state: string;
  models: { id: string; label: string; [cle: string]: unknown }[];
  error: string;
}
export interface CleImages {
  has: boolean;
  stale: boolean;
  draft: string;
  state: string;
  error: string;
}

const modelesVoixVide = (): ModelesVoix => ({
  state: "idle",
  models: [],
  current: null,
  detail: "",
  error: "",
});

export function creerDonnees(b: BaseAdmin) {
  const { vue, ctx, e, lien } = b;
  const { computed, ref, watch } = vue;
  const { showToast, openConfirm, fetchAuth } = ctx;
  const confirmerSaisie = (
    titre: string,
    texteConfirm: string,
    mot: string,
    libelle: string,
  ): Promise<boolean> =>
    ctx.openTypedConfirm
      ? ctx.openTypedConfirm(titre, texteConfirm, mot, libelle)
      : openConfirm(titre, texteConfirm, true, libelle);

  // ── Base de données ──────────────────────────────────────────────────────
  const dbState: Ref<ReponseBase | null> = ref(null);
  const dbForm: Ref<FormulaireBase> = ref({
    backend: "postgres",
    host: "127.0.0.1",
    port: 5432,
    name: "elpis",
    user: "elpis",
    tls: "off",
    password: "",
  });
  const dbTest: Ref<EtatEssai<DetailTestBase>> = ref({ state: "idle", detail: null });
  const dbSim: Ref<EtatEssai<DetailSimulation>> = ref({ state: "idle", detail: null });
  const dbJob: Ref<EtatTacheBase> = ref({ state: "idle" });
  const dbBusy = ref(false);
  let minuterieJob: ReturnType<typeof setTimeout> | null = null;

  function corpsBase(): Noeud {
    const f = dbForm.value;
    return {
      backend: f.backend,
      host: (f.host || "").trim(),
      port: Number(f.port) || null,
      name: (f.name || "").trim(),
      user: (f.user || "").trim(),
      tls: f.tls,
      password: f.password || "",
    };
  }
  async function posterBase(chemin: string, corps?: Noeud): Promise<Noeud> {
    const r = await fetchAuth("/api/admin/database" + chemin, {
      method: "POST",
      headers: ENTETES_JSON,
      body: JSON.stringify(corps ?? {}),
    });
    if (!r) return { ok: false, error: "Session expirée ou réseau indisponible" };
    const data = await corpsJson(r);
    if (!r.ok) return { ok: false, error: detailErreur(data) || "HTTP " + r.status };
    return data ? objet(data) : { ok: false, error: "Réponse vide" };
  }
  async function loadDatabase(): Promise<void> {
    const r = await fetchAuth("/api/admin/database");
    if (!r || !r.ok) return;
    const brut = await corpsJson(r);
    const lu = schemaReponseBase.safeParse(brut);
    if (!lu.success) return;
    dbState.value = lu.data;
    const s = lu.data.saved;
    Object.assign(dbForm.value, {
      host: s.host || dbForm.value.host,
      name: s.name || dbForm.value.name,
      user: s.user || dbForm.value.user,
      tls: s.tls || "off",
      password: "",
    });
    dbForm.value.port = s.port || 5432;
    dbJob.value = lu.data.job as EtatTacheBase;
    if (dbJob.value["state"] === "running") sonderTache();
  }
  const issueEssai = <T>(d: Noeud): EtatEssai<T> =>
    d["ok"]
      ? { state: "ok", detail: d as T }
      : { state: "err", detail: texte(d["error"]) || "Erreur inconnue" };
  async function testDatabase(): Promise<void> {
    dbTest.value = { state: "busy", detail: null };
    dbTest.value = issueEssai<DetailTestBase>(await posterBase("/test", corpsBase()));
  }
  async function saveDatabase(): Promise<void> {
    dbBusy.value = true;
    try {
      const d = await posterBase("/save", corpsBase());
      if (d["ok"]) {
        showToast("Réglages de base enregistrés", "success");
        dbForm.value.password = "";
        await loadDatabase();
      } else showToast(texte(d["error"]) || "Échec", "error");
    } finally {
      dbBusy.value = false;
    }
  }
  async function simulateDatabase(): Promise<void> {
    dbSim.value = { state: "busy", detail: null };
    dbSim.value = issueEssai<DetailSimulation>(await posterBase("/simulate", corpsBase()));
  }
  function sonderTache(): void {
    if (minuterieJob) clearTimeout(minuterieJob);
    minuterieJob = setTimeout(() => {
      void (async () => {
        const r = await fetchAuth("/api/admin/database/job");
        if (r?.ok) dbJob.value = objet(await corpsJson(r)) as EtatTacheBase;
        if (dbJob.value["state"] === "running") sonderTache();
      })();
    }, 1500);
  }
  async function migrateDatabase(): Promise<void> {
    const ok = await confirmerSaisie(
      "Migrer et basculer",
      "Écritures suspendues pendant la copie, puis redémarrage sur la nouvelle base.",
      "MIGRER",
      "Migrer",
    );
    if (!ok) return;
    const d = await posterBase("/migrate", corpsBase());
    if (!d["ok"]) {
      showToast(texte(d["error"]) || "Échec", "error");
      return;
    }
    dbJob.value = { state: "running", step: "préparation" };
    sonderTache();
  }
  async function revertDatabaseToSqlite(): Promise<void> {
    const ok = await openConfirm(
      "Revenir à SQLite ?",
      "Copie vers un fichier neuf (l’ancien est gardé en .bak), puis redémarrage.",
      true,
      "Revenir",
    );
    if (!ok) return;
    const d = await posterBase("/sqlite", {});
    if (!d["ok"]) {
      showToast(texte(d["error"]) || "Échec", "error");
      return;
    }
    dbJob.value = { state: "running", step: "préparation" };
    sonderTache();
  }

  // ── Moteur vocal ─────────────────────────────────────────────────────────
  const voiceTest: Ref<EtatVoixEssai> = ref({
    state: "idle",
    parts: [],
    voices: [],
    allOk: false,
    error: null,
  });

  async function testVoiceConnection(): Promise<void> {
    const cfg = e.configForm.value?.voice;
    const stt = cfg?.stt;
    const tts = cfg?.tts;
    voiceTest.value = { state: "busy", parts: [], voices: voiceTest.value.voices, allOk: false, error: null };
    try {
      const r = await fetchAuth("/api/admin/voice/test", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({
          enabled: !!cfg?.enabled,
          stt: {
            endpoint_url: stt?.endpoint_url || "",
            format: stt?.format || "whisper.cpp",
            model: stt?.model || "",
            language: stt?.language || "fr",
            prompt: stt?.prompt || "",
            token: stt?.token || "",
            verify: stt?.verify !== false,
          },
          tts: {
            endpoint_url: tts?.endpoint_url || "",
            format: tts?.format || "elpis-tts",
            model: tts?.model || "",
            voice: tts?.voice || "",
            token: tts?.token || "",
            verify: tts?.verify !== false,
          },
        }),
      });
      if (!r) {
        voiceTest.value = {
          state: "err",
          parts: [],
          voices: [],
          allOk: false,
          error: "Session expirée ou réseau indisponible",
        };
        return;
      }
      const data = objet(await corpsJson(r));
      const sttR = objet(data["stt"]);
      const ttsR = objet(data["tts"]);
      const voix = Array.isArray(ttsR["voices"]) ? ttsR["voices"] : [];
      const detailErr = (x: Noeud): string =>
        (texte(x["error"]) || "Erreur inconnue") + (x["detail"] ? " — " + texte(x["detail"]) : "");
      voiceTest.value = {
        state: "done",
        allOk: !!data["ok"],
        error: null,
        warnings: (Array.isArray(data["warnings"]) ? data["warnings"] : []).filter(
          (w): w is string => typeof w === "string",
        ),
        voices: voix,
        parts: [
          {
            id: "stt",
            ok: !!sttR["ok"],
            title: "Reconnaissance",
            detail: sttR["ok"]
              ? "Service joignable (" + (texte(sttR["format"]) || "—") + ")."
              : detailErr(sttR),
          },
          {
            id: "tts",
            ok: !!ttsR["ok"],
            title: "Synthèse",
            detail: ttsR["ok"]
              ? (Number(ttsR["bytes"]) || 0) +
                " octets rendus" +
                (voix.length ? ", " + voix.length + " voix installée(s)." : ".")
              : detailErr(ttsR),
          },
        ],
      };
    } catch (err) {
      voiceTest.value = {
        state: "err",
        parts: [],
        voices: [],
        allOk: false,
        error: String(err instanceof Error ? err.message : err),
      };
    }
  }

  const voiceModels: Ref<Record<"stt" | "tts", ModelesVoix>> = ref({
    stt: modelesVoixVide(),
    tts: modelesVoixVide(),
  });
  const sequenceVoix = { stt: 0, tts: 0 };
  const minuteriesVoix: Record<"stt" | "tts", ReturnType<typeof setTimeout> | null> = {
    stt: null,
    tts: null,
  };
  const champVoix = (section: "stt" | "tts", format: string): "model" | "voice" | null =>
    section === "stt" ? (format === "whisper.cpp" ? null : "model") : format === "openai" ? "model" : "voice";

  /** Modèles et voix chargés par les serveurs : l'administrateur choisit dans une liste. */
  async function loadVoiceModels(section: "stt" | "tts"): Promise<void> {
    const sect = e.configForm.value?.voice?.[section];
    if (!sect) return;
    const seq = ++sequenceVoix[section];
    if (!(sect.endpoint_url || "").trim()) {
      voiceModels.value[section] = modelesVoixVide();
      return;
    }
    voiceModels.value[section] = { ...modelesVoixVide(), state: "busy" };
    let res: Noeud | null;
    try {
      const r = await fetchAuth(
        "/api/admin/voice/models",
        {
          method: "POST",
          headers: ENTETES_JSON,
          body: JSON.stringify({
            section,
            endpoint_url: sect.endpoint_url || "",
            format: sect.format || "",
            token: sect.token || "",
            verify: sect.verify !== false,
          }),
        },
        true,
      );
      res = r?.ok ? objet(await corpsJson(r)) : null;
    } catch {
      res = null;
    }
    if (seq !== sequenceVoix[section]) return;
    if (!res || !res["ok"]) {
      voiceModels.value[section] = {
        ...modelesVoixVide(),
        state: "err",
        error: texte(res?.["error"]) || "Serveur injoignable.",
        detail: texte(res?.["detail"]),
      };
      return;
    }
    const modeles = listeObjets(res["models"]) as ModelesVoix["models"];
    voiceModels.value[section] = {
      state: "ok",
      models: modeles,
      current: res["current"],
      detail: texte(res["detail"]),
      error: "",
    };
    // Pré-remplissage : le champ vide (ou inconnu du serveur) prend ce que le serveur a chargé, sans salir la page.
    const champ = champVoix(section, sect.format);
    const courant = res["current"];
    if (!champ || courant === null || courant === undefined || courant === "") return;
    const ids = modeles.map((m) => m.id);
    const valeurs: Record<string, string> = sect as unknown as Record<string, string>;
    const actuelle = valeurs[champ];
    if (!actuelle || !ids.includes(actuelle)) {
      const propre = e.adminPristine.value.config === lien.storeSnapshot("config");
      valeurs[champ] = String(courant);
      if (propre) lien.markAdminStoreClean("config");
    }
  }
  // Adresse, format ou jeton changés : la liste est relue après une pause de frappe.
  for (const sec of ["stt", "tts"] as const) {
    watch(
      () => {
        const v = e.configForm.value?.voice?.[sec];
        return v ? [v.endpoint_url, v.format, v.token, v.verify].join("|") : "";
      },
      (nouveau, ancien) => {
        if (!ancien || nouveau === ancien) return;
        const t = minuteriesVoix[sec];
        if (t) clearTimeout(t);
        minuteriesVoix[sec] = setTimeout(() => void loadVoiceModels(sec), 700);
      },
    );
  }

  // ── Moteur d'images ──────────────────────────────────────────────────────
  const imageTest: Ref<EtatImageEssai> = ref({ state: "idle", res: null, error: null, adjusted: false });
  const imageModels: Ref<ModelesImages> = ref({ state: "idle", models: [], error: "" });
  const imageKey: Ref<CleImages> = ref({ has: false, stale: false, draft: "", state: "idle", error: "" });
  let sequenceImages = 0;
  let minuterieImages: ReturnType<typeof setTimeout> | null = null;
  const formImage = ():
    | NonNullable<typeof e.configForm.value>["image"]
    | Partial<NonNullable<typeof e.configForm.value>["image"]> => e.configForm.value?.image ?? {};

  function corpsImage(): Noeud {
    const c = formImage();
    const corps: Noeud = {
      provider: c.provider || "sdcpp",
      url: c.url || "",
      model: c.model || "",
      verify: c.verify !== false,
      ca_pem: c.ca_pem || "",
    };
    if (imageKey.value.draft) corps["api_key"] = imageKey.value.draft;
    return corps;
  }
  async function loadImageAdmin(): Promise<void> {
    try {
      const r = await fetchAuth("/api/admin/image/key", {}, true);
      if (r?.ok) {
        const d = objet(await corpsJson(r));
        imageKey.value = { ...imageKey.value, has: !!d["has_key"], stale: !!d["stale"] };
      }
    } catch {
      /* état inconnu : champ vide */
    }
  }
  /** Ligne d'état du test : « ✓ Qwen-Image · 42 ms · max 2048 · 8/lot ». */
  function imageTestLine(res: ResultatImage | null): string {
    if (!res) return "";
    if (!res["ok"]) return "✗ " + (texte(res["error"]) || "Moteur injoignable");
    const lim = objet(res["limits"]);
    const parts = [texte(res["model"]) || "modèle non annoncé"];
    if (res["latency_ms"] !== undefined) parts.push(String(res["latency_ms"]) + " ms");
    const mx = Math.min(
      Number(lim["max_width"]) || 0,
      Number(lim["max_height"]) || Number(lim["max_width"]) || 0,
    );
    if (mx) parts.push("max " + mx);
    if (Number(lim["max_batch_count"])) parts.push(String(lim["max_batch_count"]) + "/lot");
    return "✓ " + parts.join(" · ");
  }
  async function testImageEngine(): Promise<void> {
    imageTest.value = { state: "busy", res: null, error: null, adjusted: false };
    try {
      const r = await fetchAuth("/api/admin/image/test", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify(corpsImage()),
      });
      if (!r) {
        imageTest.value = {
          state: "err",
          res: null,
          error: "Session expirée ou réseau indisponible",
          adjusted: false,
        };
        return;
      }
      const res = objet(await r.json());
      if (res["stale"] !== undefined) imageKey.value = { ...imageKey.value, stale: !!res["stale"] };
      // Limites annoncées par le moteur : le formulaire s'y ajuste (modification à enregistrer, visible dans la barre).
      let ajuste = false;
      const form = e.configForm.value?.image;
      const lim = res["ok"] ? objet(res["limits"]) : {};
      const mx = Math.min(
        Number(lim["max_width"]) || 0,
        Number(lim["max_height"]) || Number(lim["max_width"]) || 0,
      );
      if (form) {
        if (mx && Number(form.max_side) > mx) {
          form.max_side = Math.floor(mx / 64) * 64;
          ajuste = true;
        }
        if (Number(lim["max_batch_count"]) && Number(form.max_n) > Number(lim["max_batch_count"])) {
          form.max_n = Number(lim["max_batch_count"]);
          ajuste = true;
        }
        if (Number(form.default_side) > Number(form.max_side)) {
          form.default_side = form.max_side;
          ajuste = true;
        }
      }
      imageTest.value = { state: "done", res: res as ResultatImage, error: null, adjusted: ajuste };
    } catch (err) {
      imageTest.value = {
        state: "err",
        res: null,
        error: String(err instanceof Error ? err.message : err),
        adjusted: false,
      };
    }
  }
  async function loadImageModels(): Promise<void> {
    const c = formImage();
    const seq = ++sequenceImages;
    if (!c.url) {
      imageModels.value = { state: "idle", models: [], error: "" };
      return;
    }
    imageModels.value = { state: "busy", models: imageModels.value.models, error: "" };
    let res: Noeud | null;
    try {
      const r = await fetchAuth(
        "/api/admin/image/models",
        { method: "POST", headers: ENTETES_JSON, body: JSON.stringify(corpsImage()) },
        true,
      );
      res = r ? objet(await r.json()) : null;
    } catch {
      res = null;
    }
    if (seq !== sequenceImages) return;
    if (!res || !res["ok"]) {
      imageModels.value = { state: "err", models: [], error: texte(res?.["error"]) || "Liste indisponible" };
      return;
    }
    // Lecture seule : rien n'est recopié dans le formulaire (ce serait une modification non demandée).
    const modeles = (Array.isArray(res["models"]) ? res["models"] : []).map((m) =>
      typeof m === "string" ? { id: m, label: m } : objet(m),
    );
    imageModels.value = { state: "ok", models: modeles as ModelesImages["models"], error: "" };
  }
  watch(
    () => {
      const c = e.configForm.value?.image;
      return c ? [c.url, c.provider, c.verify, c.ca_pem].join("|") : "";
    },
    (nouveau, ancien) => {
      if (!ancien || nouveau === ancien) return;
      if (minuterieImages) clearTimeout(minuterieImages);
      minuterieImages = setTimeout(() => void loadImageModels(), 700);
    },
  );

  async function saveImageKey(effacer?: unknown): Promise<void> {
    const cle = effacer ? "" : String(imageKey.value.draft || "").trim();
    if (!effacer && !cle) return;
    imageKey.value = { ...imageKey.value, state: "busy", error: "" };
    try {
      const r = await fetchAuth("/api/admin/image/key", {
        method: "PUT",
        headers: ENTETES_JSON,
        body: JSON.stringify({ api_key: cle, url: String(formImage().url || "").trim() }),
      });
      const d = r ? objet(await r.json().catch(() => ({}))) : {};
      if (!r || !r.ok) {
        const det = d["detail"];
        throw new Error(
          (typeof det === "string" && det) || texte(objet(det)["message"]) || "Enregistrement impossible",
        );
      }
      imageKey.value = { has: !!d["has_key"], stale: !!d["stale"], draft: "", state: "idle", error: "" };
      showToast(d["has_key"] ? "Clé enregistrée." : "Clé effacée.", "success");
    } catch (err) {
      imageKey.value = {
        ...imageKey.value,
        state: "err",
        error: String(err instanceof Error ? err.message : err),
      };
    }
  }
  /** Un nouveau tableau à chaque geste (la barre d'enregistrement compare les valeurs) ; liste vide = tous les comptes. */
  function setImageGroups(ids: unknown): void {
    const form = e.configForm.value?.image;
    if (!form) return;
    form.groups = Array.from(new Set((Array.isArray(ids) ? ids : []).map(Number))).sort((a, c) => a - c);
  }
  function toggleImageGroup(id: unknown): void {
    const cur = (formImage().groups || []).map(Number);
    const n = Number(id);
    setImageGroups(cur.includes(n) ? cur.filter((x) => x !== n) : cur.concat([n]));
  }
  /** Id d'un groupe supprimé encore listé : affiché, il ne donne accès à personne (jamais vidé en silence). */
  const imageGroupsMissing = computed(() => {
    const ids = (formImage().groups || []).map(Number);
    const connus = new Set((e.groupsList.value || []).map((g) => Number(g.id)));
    return (e.groupsList.value || []).length ? ids.filter((id) => !connus.has(id)) : [];
  });
  function setImageSizesText(texteTailles: unknown): void {
    const form = e.configForm.value?.image;
    if (!form) return;
    form.sizes = String(texteTailles || "")
      .split(/[\s,;]+/)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => /^\d{2,5}x\d{2,5}$/.test(t));
  }
  const imageSideChoices = computed(() => {
    const mx = Number(formImage().max_side) || 2048;
    const liste = [512, 768, 1024, 1280, 1536, 2048, 3072, 4096].filter((v) => v <= mx);
    const cur = Number(formImage().default_side);
    if (cur && !liste.includes(cur)) liste.push(cur);
    return liste.sort((a, c) => a - c);
  });

  return {
    dbState,
    dbForm,
    dbTest,
    dbSim,
    dbJob,
    dbBusy,
    loadDatabase,
    testDatabase,
    saveDatabase,
    simulateDatabase,
    migrateDatabase,
    revertDatabaseToSqlite,
    voiceTest,
    testVoiceConnection,
    voiceModels,
    loadVoiceModels,
    imageTest,
    imageModels,
    imageKey,
    loadImageAdmin,
    testImageEngine,
    imageTestLine,
    loadImageModels,
    saveImageKey,
    setImageGroups,
    toggleImageGroup,
    imageGroupsMissing,
    setImageSizesText,
    imageSideChoices,
  };
}
