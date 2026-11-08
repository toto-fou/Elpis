// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/journaux.ts — console › Supervision › Journaux : historique serveur, flux en direct ouvert sur la page seulement, filtres persistés, défilement automatique. */
import { decoderEvenementSysteme } from "@elpis/contracts";
import type { Ref } from "vue";

import type { SourceEvenements } from "../auth/sse-systeme";
import { corpsJson, estObjet, objet } from "../../utils/lecture-json";
import type { BaseAdmin } from "./etat";
import type { EntreeJournal } from "./types";
import { chargementEchoue, chargementReussi } from "./suivi-chargement";

const CLE_FILTRES = "elpis_admin_log_filters";
const TAMPON = 800;
const URL_FLUX = "/api/system-events?logs=1";
const REPRISE_MIN_MS = 5000;
const REPRISE_MAX_MS = 60000;

export interface FiltresJournaux {
  services: string[];
  levels: string[];
  categories: string[];
  query: string;
}

function filtresInitiaux(): FiltresJournaux {
  const vide: FiltresJournaux = { services: [], levels: [], categories: [], query: "" };
  try {
    const brut: unknown = JSON.parse(localStorage.getItem(CLE_FILTRES) ?? "null");
    if (!estObjet(brut)) return vide;
    const texteListe = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return {
      services: texteListe(brut["services"]),
      levels: texteListe(brut["levels"]),
      categories: texteListe(brut["categories"]),
      query: typeof brut["query"] === "string" ? brut["query"] : "",
    };
  } catch {
    return vide;
  }
}

const texte = (v: unknown, defaut: string): string =>
  typeof v === "string" ? v : v == null ? defaut : String(v);
const listeTextes = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Ligne du journal commun mise en forme comme le flux en direct (`logRecordToEvent` du serveur) ; `null` si elle reste hors console. */
export function entreeDuJournal(rec: Record<string, unknown>, id: string): EntreeJournal | null {
  if (rec["live"] === false) return null;
  const service = texte(rec["service"], "?");
  const categorie = texte(rec["category"], "?");
  const ts = typeof rec["ts"] === "number" ? rec["ts"] : undefined;
  const entree: EntreeJournal = {
    id,
    message: `[${service}/${categorie}] ${texte(rec["message"], "")}`,
    level: texte(rec["level"], "INFO"),
    service,
    category: categorie,
  };
  if (ts !== undefined) entree.ts = ts;
  return entree;
}

export function creerJournaux(b: BaseAdmin) {
  const { vue, ctx } = b;
  const { computed, ref, watch } = vue;
  const logFilters: Ref<FiltresJournaux> = ref(filtresInitiaux());
  /** Tampon de la console (celui de la racine quand il existe), 800 entrées au plus. */
  const liveLogs: Ref<EntreeJournal[]> = ctx.liveLogs ?? ref([]);
  const logAutoScroll = ref(true);
  const logsConsoleRef: Ref<HTMLElement | null> = ref(null);
  const logsLoading = ref(false);
  const logsDerniereMaj: Ref<number | null> = ref(null);
  const logsEchec = ref(false);
  const fluxOuvert = ref(false);
  const fluxIndisponible = ref(false);
  const servicesDisponibles: Ref<string[]> = ref([]);
  const niveauxDisponibles: Ref<string[]> = ref([]);
  const categoriesDisponibles: Ref<string[]> = ref([]);
  let formateur: Intl.DateTimeFormat | null = null;

  watch(
    logFilters,
    (v) => {
      try {
        localStorage.setItem(CLE_FILTRES, JSON.stringify(v));
      } catch {
        /* stockage indisponible */
      }
    },
    { deep: true },
  );

  /** Choix unique par liste (Tous = vide), lié aux filtres persistés. */
  const filtreUnique = (cle: "levels" | "services" | "categories") =>
    computed<string>({
      get: () => logFilters.value[cle][0] ?? "",
      set: (v) => (logFilters.value[cle] = v ? [v] : []),
    });
  const filtreNiveau = filtreUnique("levels");
  const filtreService = filtreUnique("services");
  const filtreCategorie = filtreUnique("categories");

  /** Services, niveaux et catégories choisis (vide = tous). */
  const passeFiltres = (l: EntreeJournal, f: typeof logFilters.value): boolean =>
    (!f.services.length || (!!l.service && f.services.includes(l.service))) &&
    (!f.levels.length || (!!l.level && f.levels.includes(l.level))) &&
    (!f.categories.length || (!!l.category && f.categories.includes(l.category)));

  /** Filtre côté client sur le tampon, sans aller-retour, pour que le flux en direct reste fluide. */
  const filteredLogs = computed<EntreeJournal[]>(() => {
    const f = logFilters.value;
    const q = (f.query || "").toLowerCase().trim();
    return liveLogs.value.filter(
      (l) => passeFiltres(l, f) && (!q || (l.message || "").toLowerCase().includes(q)),
    );
  });

  /** Date et heure (JJ/MM HH:MM:SS) avec un formateur Intl partagé : en recréer un par ligne coûte 800 créations par rendu. */
  function fmtLogTs(ts: number | null | undefined): string {
    if (!ts) return "";
    try {
      formateur ??= new Intl.DateTimeFormat("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      return formateur.format(new Date(ts * 1000)).replace(",", "");
    } catch {
      return "";
    }
  }

  /** `base` complétée des entrées pas encore vues, triée par date, 800 plus récentes ; `null` si rien de neuf. */
  function fusion(base: readonly EntreeJournal[], entrees: readonly EntreeJournal[]): EntreeJournal[] | null {
    const vus = new Set(base.map((l) => `${l.ts}|${l.message}`));
    const neufs = entrees.filter((l) => !vus.has(`${l.ts}|${l.message}`));
    if (!neufs.length) return null;
    return [...base, ...neufs].sort((a, c) => (a.ts || 0) - (c.ts || 0)).slice(-TAMPON);
  }
  function ajouter(entrees: readonly EntreeJournal[]): void {
    const r = fusion(liveLogs.value, entrees);
    if (r) liveLogs.value = r;
  }

  /** Le résultat du serveur (déjà filtré) prend la place du tampon ; seules les lignes directes plus récentes qui passent les filtres restent. */
  function remplacer(entrees: readonly EntreeJournal[], depart: number): void {
    const limite = entrees.reduce((m, l) => Math.max(m, l.ts || 0), 0) || depart;
    const f = logFilters.value;
    const recentes = liveLogs.value.filter((l) => (l.ts || 0) > limite && passeFiltres(l, f));
    liveLogs.value = fusion(recentes, entrees) ?? recentes;
  }

  let sequenceHistorique = 0;
  let sequenceRattrapage = 0;
  let rechargementEnVol = false;
  /** Amorce la console depuis le journal commun, ou rattrape une coupure (`depuis`) ; la dernière demande de chaque sorte écrit. */
  async function charger(depuis: number | null): Promise<void> {
    const rattrapage = depuis !== null;
    if (rattrapage && rechargementEnVol) return;
    const moi = rattrapage ? ++sequenceRattrapage : ++sequenceHistorique;
    if (!rattrapage) sequenceRattrapage += 1;
    const actuelle = (): boolean => moi === (rattrapage ? sequenceRattrapage : sequenceHistorique);
    const depart = Date.now() / 1000;
    if (!rattrapage) {
      logsLoading.value = true;
      rechargementEnVol = true;
    }
    try {
      const f = logFilters.value;
      const qs = new URLSearchParams({ limit: rattrapage ? String(TAMPON) : "300" });
      if (f.services.length) qs.set("services", f.services.join(","));
      if (f.levels.length) qs.set("levels", f.levels.join(","));
      if (f.categories.length) qs.set("categories", f.categories.join(","));
      if (depuis !== null) qs.set("since_ts", String(depuis));
      const res = await ctx.fetchAuth("/api/admin/logs/recent?" + qs.toString(), {}, true);
      if (!actuelle()) return;
      if (!res || !res.ok) {
        logsEchec.value = true;
        chargementEchoue("loadRecentLogs", "Réponse du serveur inattendue ou en échec.", loadRecentLogs);
        return;
      }
      const corps = objet(await corpsJson(res));
      if (!actuelle()) return;
      chargementReussi("loadRecentLogs");
      servicesDisponibles.value = listeTextes(corps["available_services"]);
      niveauxDisponibles.value = listeTextes(corps["available_levels"]);
      categoriesDisponibles.value = listeTextes(corps["available_categories"]);
      const evenements = Array.isArray(corps["events"]) ? corps["events"] : [];
      const entrees = evenements
        .map((rec, i) => (estObjet(rec) ? entreeDuJournal(rec, `h-${i}-${String(rec["ts"])}`) : null))
        .filter((e): e is EntreeJournal => e !== null);
      logsEchec.value = false;
      logsDerniereMaj.value = Date.now();
      // Réponse pleine : des lignes ont pu manquer entre les deux, le tampon est remplacé plutôt que fusionné.
      if (rattrapage && evenements.length >= TAMPON) void charger(null);
      else if (rattrapage) ajouter(entrees);
      else remplacer(entrees, depart);
    } catch {
      if (!actuelle()) return;
      logsEchec.value = true;
      chargementEchoue("loadRecentLogs", "Erreur réseau.", loadRecentLogs);
    } finally {
      if (!rattrapage && actuelle()) {
        logsLoading.value = false;
        rechargementEnVol = false;
      }
    }
  }
  const loadRecentLogs = (): Promise<void> => charger(null);

  // ── Flux en direct : ouvert tant que la page Journaux est affichée ─────────
  let voulu = false;
  let source: SourceEvenements | null = null;
  let relance: ReturnType<typeof setTimeout> | null = null;
  let attente: EntreeJournal[] = [];
  let vidage: ReturnType<typeof setTimeout> | null = null;
  let numero = 0;
  let dejaOuvert = false;
  let essaisRefus = 0;
  let confirmation: ReturnType<typeof setTimeout> | null = null;

  function vider(): void {
    vidage = null;
    const lot = attente;
    attente = [];
    ajouter(lot);
  }
  const visible = (): boolean => typeof document === "undefined" || !document.hidden;
  function fermerSource(): void {
    if (source) source.close();
    source = null;
    fluxOuvert.value = false;
    if (confirmation) clearTimeout(confirmation);
    confirmation = null;
  }
  function planifierOuverture(delaiMs: number): void {
    if (relance) clearTimeout(relance);
    relance = setTimeout(() => {
      relance = null;
      if (voulu && visible()) ouvrirFlux();
    }, delaiMs);
  }
  function recevoir(donnees: string): void {
    const d = decoderEvenementSysteme(donnees);
    if (d.statut !== "ok") return;
    const ev = d.evenement;
    if (ev.type === "worker_recycling") {
      fermerSource();
      planifierOuverture(750);
      return;
    }
    if (ev.type === "log_unavailable") {
      fermerSource();
      fluxIndisponible.value = true;
      planifierOuverture(Math.min(REPRISE_MIN_MS * 2 ** essaisRefus, REPRISE_MAX_MS));
      essaisRefus += 1;
      return;
    }
    if (ev.type === "log_replaced") {
      fermerSource();
      return;
    }
    if (ev.type !== "log") return;
    const ts = typeof ev.ts === "number" ? ev.ts : Date.now() / 1000;
    const entree: EntreeJournal = {
      id: `${ts}-${++numero}`,
      ts,
      message: ev.message,
      level: texte(ev.level, ""),
    };
    if (ev.category) entree.category = texte(ev.category, "");
    if (ev.service) entree.service = texte(ev.service, "");
    attente.push(entree);
    vidage ??= setTimeout(vider, 200);
  }
  function ouvrirFlux(): void {
    if (source) return;
    const creer =
      ctx.creerSourceJournal ??
      ((url: string) => new EventSource(url, { withCredentials: true }) as unknown as SourceEvenements);
    let s: SourceEvenements;
    try {
      s = creer(URL_FLUX);
    } catch {
      planifierOuverture(3000);
      return;
    }
    source = s;
    s.onopen = () => {
      if (source !== s) return;
      fluxOuvert.value = true;
      const reconnexion = dejaOuvert;
      dejaOuvert = true;
      confirmation = setTimeout(() => {
        confirmation = null;
        fluxIndisponible.value = false;
        essaisRefus = 0;
        if (reconnexion) void charger(liveLogs.value.at(-1)?.ts ?? null);
      }, 1500);
    };
    s.onerror = () => {
      if (source !== s) return;
      fluxOuvert.value = false;
      if (s.readyState === 2) {
        fermerSource();
        planifierOuverture(3000);
      }
    };
    s.onmessage = (e) => {
      if (source === s) recevoir(typeof e.data === "string" ? e.data : "");
    };
  }

  /** Page Journaux affichée ou quittée : le flux du journal n'existe que pendant sa consultation. */
  function suivreJournal(oui: boolean): void {
    voulu = oui;
    if (oui) {
      if (typeof document !== "undefined")
        document.addEventListener("visibilitychange", auChangementDeVisibilite);
      if (visible()) ouvrirFlux();
      return;
    }
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", auChangementDeVisibilite);
    if (relance) clearTimeout(relance);
    relance = null;
    fermerSource();
    fluxIndisponible.value = false;
    essaisRefus = 0;
    dejaOuvert = false;
  }

  /** Onglet masqué : le flux est fermé (il tient une place d'abonné et une connexion) ; au retour il rouvre et rattrape l'historique. */
  function auChangementDeVisibilite(): void {
    if (!voulu) return;
    if (!visible()) {
      if (relance) clearTimeout(relance);
      relance = null;
      fermerSource();
      return;
    }
    essaisRefus = 0;
    ouvrirFlux();
  }

  // Un changement de niveau, de service ou de catégorie recharge l'historique filtré par le serveur.
  watch(
    () => [logFilters.value.services, logFilters.value.levels, logFilters.value.categories],
    () => {
      if (voulu) void loadRecentLogs();
    },
    { deep: true },
  );

  // Surveille le tampon (réaffecté une fois par lot) plutôt que le filtre : le défilement ne se fait que console montée.
  watch(
    () => liveLogs.value,
    () => {
      if (!logAutoScroll.value || !logsConsoleRef.value) return;
      void ctx.nextTick().then(() => {
        const el = logsConsoleRef.value;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
  );

  function liberer(): void {
    suivreJournal(false);
    if (vidage) clearTimeout(vidage);
    vidage = null;
    attente = [];
  }

  return {
    logFilters,
    logAutoScroll,
    logsConsoleRef,
    filteredLogs,
    logsLoading,
    logsDerniereMaj,
    logsEchec,
    fluxOuvert,
    fluxIndisponible,
    servicesDisponibles,
    niveauxDisponibles,
    categoriesDisponibles,
    filtreNiveau,
    filtreService,
    filtreCategorie,
    loadRecentLogs,
    suivreJournal,
    fmtLogTs,
    liveLogs,
    liberer,
  };
}
