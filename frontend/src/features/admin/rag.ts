// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/rag.ts — console › RAG : état et essais des services, groupes autorisés, collections (métadonnées seulement), suppression, quotas par compte, réindexation globale et travaux d'indexation. */
import {
  CLES_QUOTAS_RAG,
  schemaReponseCollectionsAdminRag,
  schemaReponseComptesRag,
  schemaReponseEssaiRag,
  schemaReponseEssaiServiceRag,
  schemaReponseEtatAdminRag,
  schemaReponseQuotaCompteRag,
  schemaReponseReindexationGlobaleRag,
  schemaReponseReindexerToutRag,
  schemaReponseSuppressionAdminRag,
  schemaReponseTravailAdminRag,
  schemaReponseTravauxAdminRag,
} from "@elpis/contracts";
import type {
  CollectionAdminRag,
  CompteQuotaRag,
  EtatAdminRag,
  ReindexationAdminRag,
  TravailAdminRag,
} from "@elpis/contracts";
import type { Ref } from "vue";
import type { ZodType } from "zod";

import type { ClientHttp } from "../../platform/http/client";
import { journal } from "../../platform/journal";
import { messageErreur } from "../../platform/http/resultat";
import type { ApiResult } from "../../platform/http/resultat";
import type { BaseAdmin } from "./etat";

const ENTETES_JSON = { "Content-Type": "application/json" };
const PAGE = 25;
const PAUSE_RECHERCHE_MS = 300;
const SONDAGE_ACTIF_MS = 3_000;
const SONDAGE_REPOS_MS = 20_000;

export type CleQuotaRag = (typeof CLES_QUOTAS_RAG)[number];
export type ServiceRagConsole = "extracteur" | "qdrant" | "embeddings" | "reranker" | "ocr";
export interface EssaiRagConsole {
  state: "idle" | "busy" | "ok" | "err";
  detail: string;
}
export interface FiltresCollectionsRag {
  q: string;
  visibility: string;
  status: string;
  tri: string;
  offset: number;
}
export interface EditionQuotaRag {
  id: number;
  valeurs: Record<CleQuotaRag, string>;
  busy: boolean;
  erreur: string;
}

export const LIBELLES_QUOTAS_RAG: Readonly<Record<CleQuotaRag, { label: string; unite: string }>> = {
  storage_mb: { label: "Stockage", unite: "Mo" },
  collections: { label: "Collections", unite: "" },
  file_mb: { label: "Taille d'un fichier", unite: "Mo" },
  docs_per_collection: { label: "Documents par collection", unite: "" },
};

/** Octets en o, Ko, Mo ou Go (base 1024). */
export function ragAdmOctets(n: unknown): string {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} o`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} Ko`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} Mo`;
  return `${(v / 1024 ** 3).toFixed(2)} Go`;
}

/** Date locale courte d'un horodatage en secondes ; vide sans date. */
export function ragAdmDate(ts: unknown): string {
  const v = Number(ts);
  if (!Number.isFinite(v) || v <= 0) return "";
  return new Date(v * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

/** Code stable et message d'une réponse en échec (les routes de la console répondent `{detail, code}`). */
function echec(r: ApiResult<unknown>): { code: string; message: string } {
  const brut =
    r.type === "requete" || r.type === "conflit" || r.type === "refus" || r.type === "serveur"
      ? r.erreur.brut
      : null;
  const code = brut !== null && typeof brut === "object" ? (brut as { code?: unknown }).code : undefined;
  return { code: typeof code === "string" ? code : "", message: messageErreur(r) || "Opération impossible" };
}

const silencieux = (r: ApiResult<unknown>): boolean =>
  r.type === "perime" || r.type === "annulation" || r.type === "expiration";

export function setupAdminRag(b: BaseAdmin, http: ClientHttp) {
  const { vue, ctx, e } = b;
  const { computed, onUnmounted, ref, watch } = vue;
  const toast = (m: string, type?: string): void => ctx.showToast(m, type);

  const ragAdmEtat: Ref<EtatAdminRag | null> = ref(null);
  const ragAdmErreur = ref("");
  const ragAdmCollections: Ref<CollectionAdminRag[]> = ref([]);
  const ragAdmCollectionsTotal = ref(0);
  const ragAdmCollectionsCharge = ref(false);
  const ragAdmFiltres: Ref<FiltresCollectionsRag> = ref({
    q: "",
    visibility: "",
    status: "",
    tri: "nom",
    offset: 0,
  });
  const ragAdmComptes: Ref<CompteQuotaRag[]> = ref([]);
  const ragAdmComptesTotal = ref(0);
  const ragAdmComptesFiltre = ref({ q: "", surcharges: false, offset: 0 });
  const ragAdmReindexation: Ref<ReindexationAdminRag | null> = ref(null);
  const ragAdmTravaux: Ref<TravailAdminRag[]> = ref([]);
  const ragAdmEssais: Ref<Record<ServiceRagConsole, EssaiRagConsole>> = ref({
    extracteur: { state: "idle", detail: "" },
    qdrant: { state: "idle", detail: "" },
    embeddings: { state: "idle", detail: "" },
    reranker: { state: "idle", detail: "" },
    ocr: { state: "idle", detail: "" },
  });
  const ragAdmQuotaEdition: Ref<EditionQuotaRag | null> = ref(null);
  const ragAdmForcer = ref(false);
  const ragAdmReindexEnCours = ref(false);

  async function lire<T>(url: string, schema: ZodType<T>): Promise<T | null> {
    const r = await http.requete(url, {}, { schema });
    if (r.type === "ok") return r.valeur;
    if (r.type === "invalide")
      journal.avertir(`[console › RAG] réponse hors contrat : ${url} : ${r.raison.slice(0, 400)}`);
    if (!silencieux(r)) ragAdmErreur.value = echec(r).message;
    return null;
  }

  const requeteListe = (base: string, params: Record<string, string | number>): string => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (String(v) !== "") q.set(k, String(v));
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  };

  async function ragAdmChargerEtat(): Promise<void> {
    const d = await lire("/api/admin/rag/etat", schemaReponseEtatAdminRag);
    if (d) {
      ragAdmEtat.value = d;
      ragAdmErreur.value = "";
    }
  }

  async function ragAdmChargerCollections(): Promise<void> {
    const f = ragAdmFiltres.value;
    ragAdmCollectionsCharge.value = true;
    try {
      const d = await lire(
        requeteListe("/api/admin/rag/collections", {
          q: f.q.trim(),
          visibility: f.visibility,
          status: f.status,
          tri: f.tri,
          offset: f.offset,
          limit: PAGE,
        }),
        schemaReponseCollectionsAdminRag,
      );
      if (d) {
        ragAdmCollections.value = d.collections;
        ragAdmCollectionsTotal.value = d.total;
      }
    } finally {
      ragAdmCollectionsCharge.value = false;
    }
  }

  async function ragAdmChargerComptes(): Promise<void> {
    const f = ragAdmComptesFiltre.value;
    const d = await lire(
      requeteListe("/api/admin/rag/comptes", {
        q: f.q.trim(),
        seulement_surcharges: f.surcharges ? "1" : "",
        offset: f.offset,
        limit: PAGE,
      }),
      schemaReponseComptesRag,
    );
    if (d) {
      ragAdmComptes.value = d.accounts;
      ragAdmComptesTotal.value = d.total;
    }
  }

  async function ragAdmChargerReindexation(): Promise<void> {
    const d = await lire("/api/admin/rag/reindexation", schemaReponseReindexationGlobaleRag);
    if (d) ragAdmReindexation.value = d;
  }

  async function ragAdmChargerTravaux(): Promise<void> {
    const d = await lire("/api/admin/rag/travaux?actifs=1&limite=100", schemaReponseTravauxAdminRag);
    if (d) ragAdmTravaux.value = d.jobs;
  }

  // ── Sondage : seulement pendant que la page RAG est affichée ─────────────
  let minuterie: ReturnType<typeof setTimeout> | null = null;
  let arrete = false;
  const signature = (): string => ragAdmTravaux.value.map((j) => `${j.id}:${j.status}`).join(",");

  async function tour(): Promise<void> {
    minuterie = null;
    if (arrete || e.adminTab.value !== "rag") return;
    const avant = signature();
    await Promise.all([ragAdmChargerTravaux(), ragAdmChargerReindexation()]);
    if (signature() !== avant)
      void Promise.all([ragAdmChargerCollections(), ragAdmChargerEtat(), ragAdmChargerComptes()]);
    programmer();
  }
  function programmer(): void {
    if (minuterie !== null || arrete || e.adminTab.value !== "rag") return;
    const actif = ragAdmTravaux.value.length > 0 || (ragAdmReindexation.value?.jobs.length ?? 0) > 0;
    minuterie = setTimeout(() => void tour(), actif ? SONDAGE_ACTIF_MS : SONDAGE_REPOS_MS);
  }
  function arreterSondage(): void {
    if (minuterie !== null) clearTimeout(minuterie);
    minuterie = null;
  }

  /** Chargeur de la page : tout ce qu'elle montre, puis le sondage des travaux. */
  async function loadRagAdmin(): Promise<void> {
    if (!b.estAdmin()) return;
    arrete = false;
    arreterSondage();
    await Promise.all([
      ragAdmChargerEtat(),
      ragAdmChargerCollections(),
      ragAdmChargerComptes(),
      ragAdmChargerReindexation(),
      ragAdmChargerTravaux(),
    ]);
    programmer();
  }

  watch(e.adminTab, (t) => {
    if (t !== "rag") arreterSondage();
  });
  // Un enregistrement de la configuration (modèle, quotas, groupes…) change l'état relu par la page.
  watch(e.isSavingAdminConfig, (en) => {
    if (!en && e.adminTab.value === "rag")
      void Promise.all([ragAdmChargerEtat(), ragAdmChargerReindexation(), ragAdmChargerComptes()]);
  });
  let pause: ReturnType<typeof setTimeout> | null = null;
  const apresPause = (f: () => void): void => {
    if (pause !== null) clearTimeout(pause);
    pause = setTimeout(f, PAUSE_RECHERCHE_MS);
  };
  watch(
    () => [
      ragAdmFiltres.value.q,
      ragAdmFiltres.value.visibility,
      ragAdmFiltres.value.status,
      ragAdmFiltres.value.tri,
    ],
    () => {
      ragAdmFiltres.value.offset = 0;
      apresPause(() => void ragAdmChargerCollections());
    },
  );
  watch(
    () => [ragAdmComptesFiltre.value.q, ragAdmComptesFiltre.value.surcharges],
    () => {
      ragAdmComptesFiltre.value.offset = 0;
      apresPause(() => void ragAdmChargerComptes());
    },
  );
  onUnmounted(() => {
    arrete = true;
    arreterSondage();
    if (pause !== null) clearTimeout(pause);
  });

  // ── Essais des services (valeurs du formulaire, sans les enregistrer) ───
  async function ragAdmEssayer(service: ServiceRagConsole): Promise<void> {
    const cfg = e.configForm.value?.rag;
    if (!cfg) return;
    ragAdmEssais.value[service] = { state: "busy", detail: "" };
    let r: ApiResult<unknown>;
    let detail = "";
    if (service === "extracteur") {
      const corps = {
        url: (cfg.service_url || "").trim(),
        token: cfg.service_token || "",
        timeout: cfg.service_timeout || 5,
      };
      const rep = await http.requete(
        "/api/admin/rag-service/test",
        { method: "POST", headers: ENTETES_JSON, body: JSON.stringify(corps) },
        { schema: schemaReponseEssaiRag },
      );
      r = rep;
      if (rep.type === "ok") {
        if (!rep.valeur.ok) {
          ragAdmEssais.value[service] = { state: "err", detail: rep.valeur.error };
          return;
        }
        const s = (rep.valeur.status ?? {}) as Record<string, unknown>;
        detail = [
          "Extracteur joignable",
          typeof s["version"] === "string" ? `version ${s["version"]}` : "",
          s["soffice"] === true ? "LibreOffice présent" : s["soffice"] === false ? "LibreOffice absent" : "",
          s["ocr"] === false ? "OCR non pris en charge" : "",
        ]
          .filter(Boolean)
          .join(" · ");
      }
    } else {
      const corps =
        service === "embeddings"
          ? { url: cfg.embed.url.trim(), model: cfg.embed.model.trim(), api_key: cfg.embed.api_key }
          : service === "reranker"
            ? { url: cfg.reranker.url.trim(), model: cfg.reranker.model.trim() }
            : service === "ocr"
              ? { url: cfg.ocr.url.trim(), model: cfg.ocr.model.trim(), api_key: cfg.ocr.api_key }
              : { url: cfg.qdrant_url.trim() };
      const rep = await http.requete(
        `/api/admin/rag/essai/${service}`,
        { method: "POST", headers: ENTETES_JSON, body: JSON.stringify(corps) },
        { schema: schemaReponseEssaiServiceRag },
      );
      r = rep;
      if (rep.type === "ok") {
        if (!rep.valeur.ok) {
          ragAdmEssais.value[service] = { state: "err", detail: rep.valeur.error };
          return;
        }
        detail = `${rep.valeur.detail} (${rep.valeur.duration_ms} ms)`;
      }
    }
    if (r.type === "ok") ragAdmEssais.value[service] = { state: "ok", detail };
    else ragAdmEssais.value[service] = { state: "err", detail: silencieux(r) ? "" : echec(r).message };
  }

  // ── Groupes qui ont accès au RAG (rag.groups) ─────────────────────────────
  /** Un nouveau tableau à chaque geste (la barre d'enregistrement compare les valeurs) ; liste vide = tous les comptes. */
  function ragAdmFixerGroupes(ids: unknown): void {
    const form = e.configForm.value?.rag;
    if (!form) return;
    form.groups = Array.from(new Set((Array.isArray(ids) ? ids : []).map(Number))).sort((a, c) => a - c);
  }
  function ragAdmBasculerGroupe(id: unknown): void {
    const cur = (e.configForm.value?.rag?.groups || []).map(Number);
    const n = Number(id);
    ragAdmFixerGroupes(cur.includes(n) ? cur.filter((x) => x !== n) : cur.concat([n]));
  }
  /** Groupes supprimés encore listés : affichés, ils ne donnent accès à personne. */
  const ragAdmGroupesAbsents = computed(() => {
    const ids = (e.configForm.value?.rag?.groups || []).map(Number);
    const connus = new Set((e.groupsList.value || []).map((g) => Number(g.id)));
    return (e.groupsList.value || []).length ? ids.filter((id) => !connus.has(id)) : [];
  });

  /** Le modèle d'embedding saisi diffère de celui que le serveur utilise : une réindexation sera nécessaire après l'enregistrement. */
  const ragAdmModeleModifie = computed(() => {
    const saisi = e.configForm.value?.rag?.embed?.model;
    const actuel = ragAdmEtat.value?.embed.model;
    return (
      typeof saisi === "string" && saisi.trim() !== "" && actuel !== undefined && saisi.trim() !== actuel
    );
  });

  // ── Collections : pages, suppression ──────────────────────────────────────
  function ragAdmPageCollections(delta: number): void {
    const max = Math.max(0, Math.ceil(ragAdmCollectionsTotal.value / PAGE) - 1);
    const page = Math.min(max, Math.max(0, ragAdmFiltres.value.offset / PAGE + delta));
    ragAdmFiltres.value.offset = page * PAGE;
    void ragAdmChargerCollections();
  }
  function ragAdmPageComptes(delta: number): void {
    const max = Math.max(0, Math.ceil(ragAdmComptesTotal.value / PAGE) - 1);
    const page = Math.min(max, Math.max(0, ragAdmComptesFiltre.value.offset / PAGE + delta));
    ragAdmComptesFiltre.value.offset = page * PAGE;
    void ragAdmChargerComptes();
  }

  async function ragAdmSupprimerCollection(c: CollectionAdminRag): Promise<void> {
    const ok = await (
      ctx.openTypedConfirm ?? ((titre, texte, _mot, libelle) => ctx.openConfirm(titre, texte, true, libelle))
    )(
      "Supprimer la collection",
      `Supprimer « ${c.name} » (${c.owner.username}, ${c.doc_count} document${c.doc_count > 1 ? "s" : ""}, ${ragAdmOctets(c.bytes)}) ? ` +
        "Ses documents et son index sont effacés pour tout le monde ; son propriétaire est prévenu. Action irréversible. " +
        "Saisissez le nom de la collection pour confirmer.",
      c.name,
      "Supprimer",
    );
    if (!ok) return;
    const r = await http.requete(
      `/api/admin/rag/collections/${c.id}`,
      { method: "DELETE", headers: ENTETES_JSON, body: JSON.stringify({ name: c.name }) },
      { schema: schemaReponseSuppressionAdminRag },
    );
    if (r.type === "ok") toast(`Collection « ${c.name} » supprimée.`, "success");
    else if (!silencieux(r)) toast(echec(r).message, "error");
    void Promise.all([
      ragAdmChargerCollections(),
      ragAdmChargerEtat(),
      ragAdmChargerComptes(),
      ragAdmChargerTravaux(),
    ]);
  }

  // ── Quotas par compte ────────────────────────────────────────────────────
  function ragAdmOuvrirQuota(c: CompteQuotaRag): void {
    const valeurs = {} as Record<CleQuotaRag, string>;
    for (const k of CLES_QUOTAS_RAG) valeurs[k] = c.override?.[k] === undefined ? "" : String(c.override[k]);
    ragAdmQuotaEdition.value = { id: c.id, valeurs, busy: false, erreur: "" };
  }
  function ragAdmFermerQuota(): void {
    ragAdmQuotaEdition.value = null;
  }
  function remplacerCompte(c: CompteQuotaRag): void {
    ragAdmComptes.value = ragAdmComptes.value.map((x) => (x.id === c.id ? c : x));
  }
  async function envoyerQuota(id: number, corps: Record<string, unknown>): Promise<CompteQuotaRag | null> {
    const edition = ragAdmQuotaEdition.value?.id === id ? ragAdmQuotaEdition.value : null;
    if (edition) {
      edition.busy = true;
      edition.erreur = "";
    }
    const r = await http.requete(
      `/api/admin/rag/comptes/${id}/quota`,
      { method: "PUT", headers: ENTETES_JSON, body: JSON.stringify(corps) },
      { schema: schemaReponseQuotaCompteRag },
    );
    if (edition) edition.busy = false;
    if (r.type === "ok") {
      remplacerCompte(r.valeur.account);
      return r.valeur.account;
    }
    if (!silencieux(r)) {
      const message = echec(r).message;
      if (edition) edition.erreur = message;
      else toast(message, "error");
    }
    return null;
  }
  async function ragAdmEnregistrerQuota(): Promise<void> {
    const ed = ragAdmQuotaEdition.value;
    if (ed === null || ed.busy) return;
    const corps: Record<string, number | null> = {};
    for (const k of CLES_QUOTAS_RAG) {
      const brut = ed.valeurs[k].trim();
      if (brut === "") corps[k] = null;
      else if (/^[0-9]{1,9}$/u.test(brut)) corps[k] = Number(brut);
      else {
        ed.erreur = `${LIBELLES_QUOTAS_RAG[k].label} : entier positif attendu (ou vide pour la valeur de l'instance).`;
        return;
      }
    }
    const compte = await envoyerQuota(ed.id, corps);
    if (compte) {
      toast(`Quotas de ${compte.username} enregistrés.`, "success");
      ragAdmQuotaEdition.value = null;
    }
  }
  async function ragAdmRetablirQuota(c: CompteQuotaRag): Promise<void> {
    const compte = await envoyerQuota(c.id, { reset: true });
    if (compte) {
      toast(`Quotas de ${compte.username} remis aux valeurs de l'instance.`, "success");
      if (ragAdmQuotaEdition.value?.id === c.id) ragAdmQuotaEdition.value = null;
      if (ragAdmComptesFiltre.value.surcharges) void ragAdmChargerComptes();
    }
  }

  // ── Réindexation globale et travaux ──────────────────────────────────────
  async function ragAdmReindexerTout(): Promise<void> {
    if (ragAdmReindexEnCours.value) return;
    const n = ragAdmReindexation.value?.to_migrate ?? 0;
    const ok = await ctx.openConfirm(
      "Réindexer toutes les collections",
      ragAdmForcer.value
        ? "Toutes les collections indexées seront reconstruites avec le modèle d'embedding configuré, même celles qui l'utilisent déjà. Les recherches continuent de servir l'ancien index pendant le travail."
        : `${n} collection${n > 1 ? "s" : ""} indexée${n > 1 ? "s" : ""} avec un autre modèle seront reconstruites avec le modèle configuré. Les recherches continuent de servir l'ancien index pendant le travail.`,
      false,
      "Lancer",
    );
    if (!ok) return;
    ragAdmReindexEnCours.value = true;
    try {
      const r = await http.requete(
        "/api/admin/rag/reindexer",
        {
          method: "POST",
          headers: ENTETES_JSON,
          body: JSON.stringify(ragAdmForcer.value ? { force: true } : {}),
        },
        { schema: schemaReponseReindexerToutRag },
      );
      if (r.type === "ok")
        toast(
          r.valeur.started
            ? `Réindexation lancée pour ${r.valeur.started} collection${r.valeur.started > 1 ? "s" : ""}.`
            : "Rien à réindexer : toutes les collections sont à jour.",
          r.valeur.started ? "success" : "info",
        );
      else if (!silencieux(r)) toast(echec(r).message, "error");
    } finally {
      ragAdmReindexEnCours.value = false;
      await Promise.all([ragAdmChargerReindexation(), ragAdmChargerTravaux(), ragAdmChargerCollections()]);
      programmer();
    }
  }

  async function ragAdmActionTravail(
    j: TravailAdminRag,
    action: "suspendre" | "reprendre" | "annuler",
  ): Promise<void> {
    if (action === "annuler") {
      const ok = await ctx.openConfirm(
        "Annuler le travail",
        `Annuler le travail d'indexation de « ${j.collection_name} » (${j.owner.username}) ? Les documents non terminés restent en échec « annulé » jusqu'à une nouvelle indexation.`,
        true,
        "Annuler le travail",
        "Garder",
      );
      if (!ok) return;
    }
    const r = await http.requete(
      `/api/admin/rag/travaux/${j.id}/${action}`,
      { method: "POST" },
      { schema: schemaReponseTravailAdminRag },
    );
    if (r.type !== "ok" && !silencieux(r)) toast(echec(r).message, "error");
    await Promise.all([ragAdmChargerTravaux(), ragAdmChargerReindexation(), ragAdmChargerCollections()]);
    programmer();
  }

  /** Avancement d'un travail en pourcentage entier ; 0 tant que son total n'est pas connu. */
  function ragAdmPourcent(j: { total: number; done: number; failed: number }): number {
    return j.total > 0 ? Math.min(100, Math.round(((j.done + j.failed) / j.total) * 100)) : 0;
  }
  const ragAdmProgressionGlobale = computed(() => {
    const p = ragAdmReindexation.value?.progress;
    return p ? ragAdmPourcent(p) : 0;
  });

  return {
    ragAdmEtat,
    ragAdmErreur,
    ragAdmCollections,
    ragAdmCollectionsTotal,
    ragAdmCollectionsCharge,
    ragAdmFiltres,
    ragAdmComptes,
    ragAdmComptesTotal,
    ragAdmComptesFiltre,
    ragAdmReindexation,
    ragAdmTravaux,
    ragAdmEssais,
    ragAdmQuotaEdition,
    ragAdmForcer,
    ragAdmReindexEnCours,
    ragAdmGroupesAbsents,
    ragAdmModeleModifie,
    ragAdmProgressionGlobale,
    ragAdmPageTaille: PAGE,
    loadRagAdmin,
    ragAdmEssayer,
    ragAdmFixerGroupes,
    ragAdmBasculerGroupe,
    ragAdmPageCollections,
    ragAdmPageComptes,
    ragAdmSupprimerCollection,
    ragAdmOuvrirQuota,
    ragAdmFermerQuota,
    ragAdmEnregistrerQuota,
    ragAdmRetablirQuota,
    ragAdmReindexerTout,
    ragAdmActionTravail,
    ragAdmPourcent,
    ragAdmOctets,
    ragAdmDate,
    ragAdmLibellesQuotas: LIBELLES_QUOTAS_RAG,
    ragAdmClesQuotas: CLES_QUOTAS_RAG,
  };
}
