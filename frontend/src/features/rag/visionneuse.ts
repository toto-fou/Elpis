// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/visionneuse.ts — visionneuse de source en volet : sources navigables, droit d'ouverture, mode Page (rendu réel, passage surligné par ses rectangles ou par la localisation) et mode Texte (passages voisins), erreurs dites en clair. */
import { computed, reactive, ref, shallowRef } from "vue";
import type { BoiteRag, CollectionVueRag, DocumentRag, SourceCiteeRag } from "@elpis/contracts";

import type { ApiRag, ResultatRag } from "./api";
import { droitSources, pagesDesBoites, rectanglesEnPourcent } from "./sources-affichage";
import type { DroitSources, RectanglePourcent } from "./sources-affichage";

export type ModeVisionneuse = "page" | "texte";
type FetchAuth = (url: string, init?: RequestInit, soft?: boolean) => Promise<Response | null>;

export interface ErreurVisionneuse {
  readonly code: string;
  readonly message: string;
}

const MESSAGES: Readonly<Record<string, string>> = {
  collection_introuvable:
    "Cette collection n’est plus accessible : elle a été supprimée, ou son auteur ne la partage plus avec vous.",
  document_introuvable: "Ce document a été retiré de la collection.",
  page_introuvable: "Cette page n’existe pas dans le document.",
  sources_fermees:
    "Le propriétaire de cette collection n’ouvre pas ses documents : seul le passage cité est visible.",
  rendu_impossible: "Cette page ne peut pas être affichée : format non pris en charge ou document illisible.",
  extracteur_indisponible: "Le service qui affiche les pages est indisponible pour le moment.",
  rag_interdit: "Le RAG n’est pas ouvert à votre compte.",
};

function erreur(code: string | null, message: string, parDefaut: string): ErreurVisionneuse {
  const c = code ?? "inconnue";
  return { code: c, message: MESSAGES[c] ?? (message !== "" ? message : parDefaut) };
}

/** Phrase dite à un lecteur dont la collection n'ouvre pas ses documents. */
export const PHRASE_SOURCES_FERMEES = MESSAGES["sources_fermees"] ?? "";

export interface Surlignage extends RectanglePourcent {
  /** Numéro de la pastille, porté par le premier rectangle de la source seulement ; 0 sinon. */
  readonly n: number;
  readonly courant: boolean;
}

export interface DepsVisionneuse {
  readonly api: ApiRag;
  readonly fetchAuth: FetchAuth;
  readonly collections: () => readonly CollectionVueRag[];
  /** Fermer l'éditeur de la sandbox qui occupe la même place. */
  readonly fermerEditeur?: () => void;
  readonly annoncer?: (message: string) => void;
}

const DPI_DEFAUT = 110;
const CACHE_PAGES = 8;
const VOISINS = 3;

interface PageEnCache {
  readonly url: string;
  readonly dpi: number;
  readonly pages: number | null;
}

/** Clé d'une page rendue d'un document. */
const clePage = (s: SourceCiteeRag, n: number): string =>
  `${s.passage.collection_id}/${s.passage.document_id}/${n}`;

export function creerVisionneuse(dep: DepsVisionneuse) {
  const ensemble = shallowRef<readonly SourceCiteeRag[]>([]);
  const numero = ref<number | null>(null);
  const modeChoisi = ref<ModeVisionneuse>("page");
  const droit = ref<DroitSources>("inconnu");
  const docInfo = ref<DocumentRag | null>(null);
  const introuvable = ref<ErreurVisionneuse | null>(null);

  const page = reactive({
    etat: "inactif" as "inactif" | "chargement" | "pret" | "erreur",
    num: null as number | null,
    url: "",
    dpi: DPI_DEFAUT,
    largeurPts: 0,
    hauteurPts: 0,
    /** Rectangles de la source courante ([page, x0, y0, x1, y1]) : stockés avec la source, ou rendus par la localisation. */
    boites: [] as readonly BoiteRag[],
    approximatif: false,
    /** Passage introuvable dans le rendu : la page est montrée sans surlignage. */
    sansSurlignage: false,
    erreur: null as ErreurVisionneuse | null,
  });
  const texte = reactive({
    etat: "inactif" as "inactif" | "chargement" | "pret" | "erreur",
    cle: "",
    passages: [] as {
      chunk_index: number;
      text: string;
      heading_path: string;
      page: number | null;
    }[],
    chunkCount: 0,
    erreur: null as ErreurVisionneuse | null,
  });

  const source = computed(() => ensemble.value.find((s) => s.n === numero.value) ?? null);
  const ouverte = computed(() => source.value !== null);
  const peutOuvrirOriginal = computed(() => droit.value === "ouvert");
  /** Collection connue et fermée, ou refus du serveur : seul le passage cité se lit. */
  const restreint = computed(() => droit.value === "ferme");
  const mode = computed<ModeVisionneuse>(() => (restreint.value ? "texte" : modeChoisi.value));
  /** Sources du même document que la courante (bande du document, surlignages voisins). */
  const duDocument = computed(() => {
    const c = source.value;
    if (c === null) return [];
    return ensemble.value.filter(
      (s) =>
        s.passage.document_id === c.passage.document_id &&
        s.passage.collection_id === c.passage.collection_id,
    );
  });
  /** Téléchargement de l'original : seulement pour qui peut l'ouvrir. */
  const urlOriginal = computed(() => {
    const c = source.value;
    return c === null || !peutOuvrirOriginal.value
      ? ""
      : dep.api.urlOriginal(c.passage.collection_id, c.passage.document_id);
  });
  const totalPages = computed(() => {
    const d = docInfo.value?.pages;
    return d === undefined || d === null || d === 0 ? null : d;
  });
  const surlignages = computed<Surlignage[]>(() => {
    const c = source.value;
    if (c === null || page.num === null || page.largeurPts <= 0) return [];
    const sortie: Surlignage[] = [];
    for (const s of duDocument.value) {
      const courant = s.n === c.n;
      const boites = courant ? page.boites : s.passage.boxes;
      rectanglesEnPourcent(boites, page.num, page.largeurPts, page.hauteurPts).forEach((r, i) =>
        sortie.push({ ...r, n: i === 0 ? s.n : 0, courant }),
      );
    }
    return sortie.sort((a, b) => Number(a.courant) - Number(b.courant));
  });

  let sequence = 0;
  const cache = new Map<string, PageEnCache>();
  const revoquer = (p: PageEnCache): void => {
    if (p.url.startsWith("blob:")) URL.revokeObjectURL(p.url);
  };
  function viderCache(): void {
    for (const p of cache.values()) revoquer(p);
    cache.clear();
  }

  function remiseAZero(): void {
    page.etat = "inactif";
    page.num = null;
    page.url = "";
    page.boites = [];
    page.approximatif = false;
    page.sansSurlignage = false;
    page.erreur = null;
    page.largeurPts = 0;
    page.hauteurPts = 0;
    texte.etat = "inactif";
    texte.cle = "";
    texte.passages = [];
    texte.chunkCount = 0;
    texte.erreur = null;
    docInfo.value = null;
    introuvable.value = null;
  }

  function signaler<T>(r: ResultatRag<T>): r is Extract<ResultatRag<T>, { ok: false }> {
    if (r.ok) return false;
    if (r.code === "sources_fermees") droit.value = "ferme";
    if (r.code === "collection_introuvable" || r.code === "document_introuvable")
      introuvable.value = erreur(r.code, r.message, "");
    return true;
  }

  async function chargerDocument(s: SourceCiteeRag, jeton: number): Promise<void> {
    const r = await dep.api.document(s.passage.collection_id, s.passage.document_id);
    if (jeton !== sequence) return;
    if (r.ok) docInfo.value = r.valeur;
    else signaler(r);
  }

  async function chargerTexte(s: SourceCiteeRag, jeton: number): Promise<void> {
    const cle = `${s.passage.collection_id}/${s.passage.document_id}/${s.passage.chunk_index}`;
    if (texte.cle === cle && texte.etat === "pret") return;
    texte.etat = "chargement";
    texte.erreur = null;
    const r = await dep.api.passages(
      s.passage.collection_id,
      s.passage.document_id,
      s.passage.chunk_index,
      VOISINS,
    );
    if (jeton !== sequence) return;
    if (!r.ok) {
      signaler(r);
      texte.etat = "erreur";
      texte.erreur = erreur(r.code, r.message, "Le texte du document n’a pas pu être chargé.");
      return;
    }
    if (r.valeur.restricted) droit.value = "ferme";
    texte.cle = cle;
    texte.passages = r.valeur.passages.map((p) => ({
      chunk_index: p.chunk_index,
      text: p.text,
      heading_path: p.heading_path,
      page: p.page,
    }));
    texte.chunkCount = r.valeur.chunk_count;
    texte.etat = "pret";
  }

  /** Octets d'une page rendue : adresse locale (blob), résolution du rendu et nombre de pages annoncé. */
  async function lirePage(
    s: SourceCiteeRag,
    n: number,
  ): Promise<{ ok: true; page: PageEnCache } | { ok: false; erreur: ErreurVisionneuse }> {
    const cle = clePage(s, n);
    const connue = cache.get(cle);
    if (connue !== undefined) return { ok: true, page: connue };
    const url = dep.api.urlPage(s.passage.collection_id, s.passage.document_id, n);
    let rep: Response | null;
    try {
      rep = await dep.fetchAuth(url, {}, true);
    } catch {
      rep = null;
    }
    if (rep === null) return { ok: false, erreur: erreur(null, "", "Le serveur est injoignable.") };
    if (!rep.ok) {
      let code: string | null = null;
      let message = "";
      try {
        const corps: unknown = await rep.json();
        if (corps !== null && typeof corps === "object") {
          const o = corps as { code?: unknown; detail?: unknown };
          code = typeof o.code === "string" ? o.code : null;
          message = typeof o.detail === "string" ? o.detail : "";
        }
      } catch {
        /* corps illisible : le statut seul parle */
      }
      return {
        ok: false,
        erreur: erreur(code, message, `La page n’a pas pu être affichée (erreur ${rep.status}).`),
      };
    }
    const dpi = Number(rep.headers.get("X-Rag-Dpi"));
    const pages = Number(rep.headers.get("X-Rag-Pages"));
    const blob = await rep.blob();
    const entree: PageEnCache = {
      url: URL.createObjectURL(blob),
      dpi: dpi > 0 ? dpi : DPI_DEFAUT,
      pages: pages > 0 ? pages : null,
    };
    cache.set(cle, entree);
    while (cache.size > CACHE_PAGES) {
      const plus = cache.keys().next().value;
      if (plus === undefined) break;
      const vieille = cache.get(plus);
      if (vieille !== undefined && vieille.url !== page.url) revoquer(vieille);
      cache.delete(plus);
    }
    return { ok: true, page: entree };
  }

  async function afficherPage(s: SourceCiteeRag, n: number, jeton: number): Promise<void> {
    page.etat = "chargement";
    page.erreur = null;
    const r = await lirePage(s, n);
    if (jeton !== sequence) return;
    if (!r.ok) {
      if (r.erreur.code === "sources_fermees") droit.value = "ferme";
      if (r.erreur.code === "collection_introuvable" || r.erreur.code === "document_introuvable")
        introuvable.value = r.erreur;
      page.etat = "erreur";
      page.erreur = r.erreur;
      return;
    }
    page.num = n;
    page.url = r.page.url;
    page.dpi = r.page.dpi;
    page.etat = "pret";
  }

  /** Page du passage : ses rectangles stockés, sinon la localisation de son texte dans le rendu. */
  async function chargerPage(s: SourceCiteeRag, jeton: number): Promise<void> {
    page.etat = "chargement";
    page.erreur = null;
    page.sansSurlignage = false;
    page.approximatif = false;
    let cible = s.passage.page;
    let boites = s.passage.boxes;
    const pageDesBoites = pagesDesBoites(boites);
    if (cible !== null && boites.length > 0 && pageDesBoites.includes(cible)) {
      page.boites = boites;
    } else {
      const loc = await dep.api.localiser(
        s.passage.collection_id,
        s.passage.document_id,
        s.passage.text,
        cible ?? undefined,
      );
      if (jeton !== sequence) return;
      if (!loc.ok) {
        signaler(loc);
        page.etat = "erreur";
        page.erreur = erreur(loc.code, loc.message, "Le passage n’a pas pu être situé dans le document.");
        return;
      }
      if (loc.valeur.page !== null) {
        cible = loc.valeur.page;
        boites = loc.valeur.boxes;
        page.approximatif = loc.valeur.score < 0.9;
        if (loc.valeur.page_width !== null && loc.valeur.page_height !== null) {
          page.largeurPts = loc.valeur.page_width;
          page.hauteurPts = loc.valeur.page_height;
        }
      } else {
        boites = [];
        page.sansSurlignage = true;
      }
      page.boites = boites;
    }
    if (cible === null) {
      page.etat = "erreur";
      page.erreur = {
        code: "passage_non_situe",
        message: "Ce passage n’a pas pu être situé dans une page : lisez-le dans l’onglet Texte.",
      };
      return;
    }
    await afficherPage(s, cible, jeton);
  }

  // Collection absente de la liste du chat (masquée, ou inconnue) : le serveur dit le rôle et l'ouverture des sources.
  async function resoudreDroit(s: SourceCiteeRag, jeton: number): Promise<void> {
    const r = await dep.api.collection(s.passage.collection_id);
    if (jeton !== sequence) return;
    if (r.ok)
      droit.value = r.valeur.role === "proprietaire" || r.valeur.allow_source_open ? "ouvert" : "ferme";
    else signaler(r);
  }

  async function charger(): Promise<void> {
    const s = source.value;
    if (s === null) return;
    const jeton = ++sequence;
    remiseAZero();
    droit.value = droitSources(s.passage.collection_id, dep.collections());
    if (droit.value === "inconnu") {
      await resoudreDroit(s, jeton);
      if (jeton !== sequence || introuvable.value !== null) return;
    }
    const travaux: Promise<void>[] = [chargerDocument(s, jeton)];
    if (mode.value === "page") travaux.push(chargerPage(s, jeton));
    else travaux.push(chargerTexte(s, jeton));
    await Promise.all(travaux);
    if (jeton !== sequence) return;
    // Le serveur vient de dire que les documents sont fermés : le texte du passage prend la place.
    if (droit.value === "ferme" && texte.etat === "inactif") await chargerTexte(s, jeton);
    dep.annoncer?.(`Source ${s.n} : ${s.passage.document_name}`);
  }

  /** Ouvre la visionneuse sur une source ; `autres` sont les sources entre lesquelles on navigue (‹ ① ② ③ ›). */
  async function ouvrir(s: SourceCiteeRag, autres: readonly SourceCiteeRag[] = []): Promise<void> {
    const liste = [...autres.filter((x) => x.n !== s.n), s].sort((a, b) => a.n - b.n);
    ensemble.value = liste;
    numero.value = s.n;
    dep.fermerEditeur?.();
    await charger();
  }

  function fermer(): void {
    sequence++;
    ensemble.value = [];
    numero.value = null;
    remiseAZero();
    viderCache();
  }

  async function aller(n: number): Promise<void> {
    if (n === numero.value || !ensemble.value.some((s) => s.n === n)) return;
    numero.value = n;
    await charger();
  }

  async function voisine(sens: 1 | -1): Promise<void> {
    const ns = ensemble.value.map((s) => s.n);
    const i = ns.indexOf(numero.value ?? -1);
    if (i < 0 || ns.length < 2) return;
    const suivant = ns[(i + sens + ns.length) % ns.length];
    if (suivant !== undefined) await aller(suivant);
  }

  async function basculer(m: ModeVisionneuse): Promise<void> {
    modeChoisi.value = m;
    const s = source.value;
    if (s === null) return;
    const jeton = sequence;
    if (mode.value === "texte") await chargerTexte(s, jeton);
    else if (page.etat === "inactif" || page.etat === "erreur") await chargerPage(s, jeton);
  }

  /** Page voisine ou saut direct ; les rectangles de la source se recalculent pour la page montrée. */
  async function allerPage(n: number): Promise<void> {
    const s = source.value;
    const total = totalPages.value;
    if (s === null || n < 1 || (total !== null && n > total) || n === page.num) return;
    await afficherPage(s, n, ++sequence);
  }

  /** Dimensions du rendu connues quand l'image est chargée : la page en points. */
  function imageChargee(largeur: number, hauteur: number): void {
    if (largeur <= 0 || hauteur <= 0) return;
    page.largeurPts = (largeur * 72) / page.dpi;
    page.hauteurPts = (hauteur * 72) / page.dpi;
  }

  /** Échap : ferme la visionneuse ; vrai si elle était ouverte. */
  function echap(): boolean {
    if (!ouverte.value) return false;
    fermer();
    return true;
  }

  return {
    ensemble,
    numero,
    source,
    ouverte,
    mode,
    modeChoisi,
    droit,
    restreint,
    peutOuvrirOriginal,
    urlOriginal,
    document: docInfo,
    introuvable,
    page,
    texte,
    totalPages,
    duDocument,
    surlignages,
    ouvrir,
    fermer,
    aller,
    voisine,
    basculer,
    allerPage,
    imageChargee,
    echap,
  };
}

export type SurfaceVisionneuse = ReturnType<typeof creerVisionneuse>;
