// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/rag-documents.ts — page RAG, onglet Documents : liste complète (filtre, tri, virtualisation), travaux d'indexation en direct, dépôt de fichiers et actions par ligne. */
import { computed, ref } from "vue";
import { ETATS_TRAVAIL_RAG_ACTIFS } from "@elpis/contracts";
import type { DocumentRag, ResultatDepotRag, TravailRag } from "@elpis/contracts";

import { texteEchec } from "./base";
import type { BaseRag } from "./base";
import { bilanDepot, corpsDepot, decouperEnLots, phraseBilan, preparerDepot } from "./depot";
import type { FichierADeposer } from "./depot";
import { SEUIL_VIRTUALISATION, filtrerDocuments, inserer, trierDocuments } from "./filtres";
import type { CleTri, FiltreEtat } from "./filtres";
import { accorder, documentActif, estimerRestant, pourcentage } from "./format";

const PAGE = 500;
const PAGES_MAX = 20;

/** Message de l'événement `rag_job` relayé par le flux système. */
export interface EvenementTravail {
  collection_id: string;
  job: TravailRag;
  document?: DocumentRag | undefined;
}

export function travailActif(t: Pick<TravailRag, "status">): boolean {
  return (ETATS_TRAVAIL_RAG_ACTIFS as readonly string[]).includes(t.status);
}

export function creerDocuments(base: BaseRag) {
  const { api } = base;
  const documents = ref<DocumentRag[]>([]);
  const total = ref(0);
  const chargement = ref(false);
  const erreur = ref("");
  const filtreTexte = ref("");
  const filtreEtat = ref<FiltreEtat>("tous");
  const tri = ref<CleTri>("chemin");
  const travaux = ref<TravailRag[]>([]);
  let sequence = 0;
  const termines = new Set<string>();

  const lignes = computed(() =>
    trierDocuments(filtrerDocuments(documents.value, filtreTexte.value, filtreEtat.value), tri.value),
  );
  const virtualise = computed(() => lignes.value.length > SEUIL_VIRTUALISATION);
  const filtrees = computed(() => filtreTexte.value.trim() !== "" || filtreEtat.value !== "tous");

  /** Travail d'indexation actif de la collection affichée. */
  const travail = computed(
    () => travaux.value.find((t) => t.collection_id === base.selection.value && travailActif(t)) ?? null,
  );

  const bandeau = computed(() => {
    const t = travail.value;
    if (t === null) return null;
    const enCours = documents.value.filter(
      (d) => d.status === "extracting" || d.status === "indexing",
    ).length;
    const nature = t.kind === "ingest" ? "ajoutés" : "à indexer";
    const titre =
      t.status === "paused"
        ? "Indexation suspendue"
        : t.status === "queued"
          ? `Indexation en attente : ${accorder(t.total, "document")} ${nature}`
          : `${t.kind === "ingest" ? "Indexation" : "Réindexation"} de ${accorder(t.total, "document")} ${nature}`;
    const morceaux = [accorder(t.done, "terminé")];
    if (t.failed > 0) morceaux.push(`${t.failed} en échec`);
    if (enCours > 0 && t.status === "running") morceaux.push(`${enCours} en cours`);
    const reste = t.status === "running" ? estimerRestant(t, base.maintenant()) : null;
    if (reste !== null) morceaux.push(reste);
    return {
      travail: t,
      titre,
      detail: morceaux.join(" · "),
      pourcent: pourcentage(t.done, t.failed, t.total),
      enPause: t.status === "paused",
    };
  });

  /** Part d'indexation d'une collection de la colonne de gauche, ou `null` si aucun travail n'est actif. */
  function progression(id: string): number | null {
    const t = travaux.value.find((x) => x.collection_id === id && travailActif(x));
    return t === undefined ? null : pourcentage(t.done, t.failed, t.total);
  }

  function remiseAZero(): void {
    sequence++;
    documents.value = [];
    total.value = 0;
    erreur.value = "";
    chargement.value = false;
    filtreTexte.value = "";
    filtreEtat.value = "tous";
    depot.visible.value = false;
  }

  async function charger(id: string): Promise<void> {
    const mien = ++sequence;
    chargement.value = true;
    erreur.value = "";
    const tous: DocumentRag[] = [];
    let attendus = 0;
    for (let page = 0; page < PAGES_MAX; page++) {
      const r = await api.documents(id, tous.length, PAGE);
      if (mien !== sequence) return;
      if (!r.ok) {
        erreur.value = texteEchec(r, "Les documents n’ont pas pu être chargés.");
        chargement.value = false;
        return;
      }
      attendus = r.valeur.total;
      tous.push(...r.valeur.documents);
      if (r.valeur.documents.length === 0 || tous.length >= attendus) break;
    }
    documents.value = tous;
    total.value = attendus;
    chargement.value = false;
  }

  /** Relit les travaux actifs ; un travail connu qui n'y figure plus est fini (événement manqué) : les écrans se relisent. */
  async function chargerTravaux(): Promise<void> {
    const r = await api.travaux(true);
    if (!r.ok) return;
    const actifs = r.valeur.filter((t) => travailActif(t) && !termines.has(t.id));
    const disparus = travaux.value.filter((t) => !actifs.some((a) => a.id === t.id));
    travaux.value = actifs;
    for (const t of disparus) terminer({ ...t, status: "done" });
  }

  /** Premier regard sur la fin d'un travail : il quitte la liste et les écrans se relisent ; les regards suivants sont ignorés. */
  function terminer(t: TravailRag): void {
    travaux.value = travaux.value.filter((x) => x.id !== t.id);
    if (termines.has(t.id)) return;
    termines.add(t.id);
    if (termines.size > 200) termines.delete(termines.values().next().value as string);
    void apresTravail(t);
  }

  /** Applique un travail vu (événement ou réponse) : actif, il rejoint la liste, sauf s'il est déjà fini (la réponse HTTP peut suivre l'événement) ; terminé, il la quitte. */
  function appliquerTravail(t: TravailRag): void {
    if (!travailActif(t)) return terminer(t);
    if (termines.has(t.id)) return;
    const connu = travaux.value.some((x) => x.id === t.id);
    travaux.value = connu ? travaux.value.map((x) => (x.id === t.id ? t : x)) : [...travaux.value, t];
  }

  async function apresTravail(t: TravailRag): Promise<void> {
    const existe = await base.rafraichirCollection(t.collection_id);
    void base.rafraichirEtat();
    if (existe && base.selection.value === t.collection_id) await charger(t.collection_id);
    const phrase =
      t.status === "cancelled"
        ? "Indexation annulée."
        : t.failed > 0
          ? `Indexation terminée, ${t.failed} en échec.`
          : "Indexation terminée.";
    base.ctx.announce?.(phrase);
  }

  function surTravail(e: EvenementTravail): void {
    // Un événement qui arrive après la fin de son travail est périmé (la relecture de fin a déjà fait foi).
    if (termines.has(e.job.id)) return;
    appliquerTravail(e.job);
    if (e.document !== undefined && e.collection_id === base.selection.value)
      documents.value = inserer(documents.value, e.document);
  }

  async function agir(action: "suspendre" | "reprendre" | "annuler"): Promise<void> {
    const t = travail.value;
    if (t === null) return;
    if (action === "annuler") {
      const ok = await base.ctx.openConfirm(
        "Annuler l’indexation ?",
        "Les documents déjà indexés sont conservés. Les autres sont marqués « annulés » et pourront être relancés.",
        true,
        "Annuler l’indexation",
      );
      if (!ok) return;
    }
    const r = await api.agirTravail(t.id, action);
    if (!r.ok) {
      base.erreur(texteEchec(r, "L’action sur l’indexation a échoué."));
      return;
    }
    appliquerTravail(r.valeur);
  }

  /* Dépôt de fichiers */

  const depot = {
    enCours: ref(false),
    envoyes: ref(0),
    total: ref(0),
    visible: ref(false),
    collectionId: ref<string | null>(null),
    resultats: ref<ResultatDepotRag[]>([]),
    ignores: ref(0),
    erreur: ref(""),
    survol: ref(false),
  };
  const depotBilan = computed(() => phraseBilan(bilanDepot(depot.resultats.value)));

  async function deposer(entrees: readonly FichierADeposer[], cible?: string): Promise<boolean> {
    const id = cible ?? base.selection.value;
    if (id === null || entrees.length === 0) return false;
    if (cible === undefined && !base.estProprietaire.value) return false;
    if (depot.enCours.value) {
      base.erreur("Un dépôt est déjà en cours.");
      return false;
    }
    const mb = base.etat.value?.quotas.file_mb ?? 0;
    const prep = preparerDepot(entrees, mb);
    depot.collectionId.value = id;
    depot.resultats.value = [...prep.refus];
    depot.ignores.value = prep.ignores;
    depot.erreur.value = "";
    depot.visible.value = true;
    depot.total.value = prep.aEnvoyer.length;
    depot.envoyes.value = 0;
    depot.enCours.value = true;
    let interrompu = false;
    for (const lot of decouperEnLots(prep.aEnvoyer)) {
      const r = await api.deposer(id, corpsDepot(lot));
      if (!r.ok) {
        depot.erreur.value = texteEchec(r, "Le dépôt a échoué.");
        interrompu = true;
        break;
      }
      depot.resultats.value = [...depot.resultats.value, ...r.valeur.results];
      if (r.valeur.job !== null) appliquerTravail(r.valeur.job);
      depot.envoyes.value += lot.length;
    }
    depot.enCours.value = false;
    await base.rafraichirCollection(id);
    void base.rafraichirEtat();
    if (base.selection.value === id) await charger(id);
    const b = bilanDepot(depot.resultats.value);
    base.ctx.announce?.(interrompu ? "Le dépôt a échoué." : `Dépôt terminé : ${phraseBilan(b)}`);
    return !interrompu;
  }

  /** Résultats d'un import du bac, présentés comme ceux d'un dépôt. */
  function accueillirImport(
    id: string,
    resultats: ResultatDepotRag[],
    job: TravailRag | null,
    erreurMessage: string,
  ): void {
    depot.collectionId.value = id;
    depot.resultats.value = resultats;
    depot.ignores.value = 0;
    depot.erreur.value = erreurMessage;
    depot.visible.value = true;
    if (job !== null) appliquerTravail(job);
  }

  const depotSurCollection = computed(
    () => depot.visible.value && depot.collectionId.value === base.selection.value,
  );

  async function reindexerDocument(d: DocumentRag): Promise<void> {
    const id = base.selection.value;
    if (id === null) return;
    // La ligne passe en attente avant l'appel : les événements du travail, plus rapides que la réponse, la dépassent.
    documents.value = inserer(documents.value, { ...d, status: "pending", error: null });
    const r = await api.reindexer(id, [d.id], true);
    if (!r.ok) {
      documents.value = inserer(documents.value, d);
      base.erreur(texteEchec(r, "La réindexation a échoué."));
      return;
    }
    if (r.valeur.job !== null) appliquerTravail(r.valeur.job);
  }

  async function reindexerTout(): Promise<void> {
    const id = base.selection.value;
    if (id === null) return;
    const ok = await base.ctx.openConfirm(
      "Réindexer tous les documents ?",
      "Chaque document est relu et réindexé. La recherche reste disponible pendant l’opération.",
      false,
      "Réindexer",
    );
    if (!ok) return;
    const r = await api.reindexer(id, undefined, true);
    if (!r.ok) {
      base.erreur(texteEchec(r, "La réindexation a échoué."));
      return;
    }
    if (r.valeur.job !== null) appliquerTravail(r.valeur.job);
    base.info(r.valeur.job === null ? "Rien à réindexer." : "Réindexation lancée.");
  }

  async function retirerDocument(d: DocumentRag): Promise<void> {
    const id = base.selection.value;
    if (id === null) return;
    const ok = await base.ctx.openConfirm(
      "Retirer ce document ?",
      `« ${d.rel_path} » ne sera plus consultable par l’assistant.`,
      true,
      "Retirer",
    );
    if (!ok) return;
    const r = await api.supprimerDocument(id, d.id);
    if (!r.ok) {
      base.erreur(texteEchec(r, "Le document n’a pas pu être retiré."));
      return;
    }
    documents.value = documents.value.filter((x) => x.id !== d.id);
    total.value = Math.max(0, total.value - 1);
    await base.rafraichirCollection(id);
    void base.rafraichirEtat();
  }

  const enCoursDeTraitement = computed(() => documents.value.some(documentActif));

  return {
    documents,
    total,
    chargement,
    erreur,
    filtreTexte,
    filtreEtat,
    tri,
    lignes,
    virtualise,
    filtrees,
    travaux,
    travail,
    bandeau,
    depot,
    depotBilan,
    depotSurCollection,
    enCoursDeTraitement,
    progression,
    remiseAZero,
    charger,
    chargerTravaux,
    appliquerTravail,
    surTravail,
    agir,
    deposer,
    accueillirImport,
    reindexerDocument,
    reindexerTout,
    retirerDocument,
    urlOriginal: (d: DocumentRag): string =>
      base.selection.value === null ? "" : api.urlOriginal(base.selection.value, d.id),
  };
}

export type SurfaceDocuments = ReturnType<typeof creerDocuments>;
