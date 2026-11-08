// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/journal-securite.ts — console › Journaux › Sécurité : état, filtres, pages par curseur, tiroir de détail, export et vérification d'intégrité du journal signé (admins seulement). */
import {
  schemaEtatJournal,
  schemaPageJournal,
  schemaVerificationJournal,
  type EtatJournal,
  type EvenementJournal,
  type VerificationJournal,
} from "@elpis/contracts";
import type { Ref } from "vue";

import { corpsJson, detailErreur, lireSchema } from "../../utils/lecture-json";
import type { BaseAdmin } from "./etat";
import { ecrirePeriode, lirePeriode, periodeValide } from "./periode";
import { chargementEchoue, chargementReussi } from "./suivi-chargement";

/** Lignes affichées par page (au plus dans le DOM) et requêtes de suite par chargement. */
const LIGNES_PAR_PAGE = 50;
export const PAGES_MAX = 8;
const EXPORT_MAX_JOURS = 366;
const PERIODE_MAX_JOURS = 1100;
const JOUR = /^\d{4}-\d{2}-\d{2}$/u;

/** Catégories à préfixe d'action unique : le serveur filtre par un seul préfixe. */
export const CATEGORIES_JOURNAL: readonly { prefixe: string; libelle: string }[] = [
  { prefixe: "", libelle: "Toutes les catégories" },
  { prefixe: "auth.", libelle: "Connexions et refus" },
  { prefixe: "token.", libelle: "Jetons personnels" },
  { prefixe: "oauth.", libelle: "OAuth" },
  { prefixe: "admin.", libelle: "Administration" },
  { prefixe: "admin.user.", libelle: "Comptes" },
  { prefixe: "admin.config.", libelle: "Réglages" },
  { prefixe: "admin.audit.", libelle: "Consultation du journal" },
  { prefixe: "audit.", libelle: "Journal (purge, écrivains)" },
  { prefixe: "llm.", libelle: "Connecteurs LLM" },
  { prefixe: "git.", libelle: "Connecteurs Git" },
  { prefixe: "code.exec.", libelle: "Exécution de code" },
  { prefixe: "user.sandbox.", libelle: "Sandbox" },
  { prefixe: "cli.", libelle: "Ligne de commande" },
];

export const SERVICES_JOURNAL: readonly string[] = ["main", "admin", "toolhost", "cli"];

export interface FiltresJournalUi {
  cat: string;
  action: string;
  compte: string;
  /** `""`, `success` ou `failure`. */
  resultat: string;
  ip: string;
  service: string;
  texte: string;
}

export const filtresVides = (): FiltresJournalUi => ({
  cat: "",
  action: "",
  compte: "",
  resultat: "",
  ip: "",
  service: "",
  texte: "",
});

export interface PeriodeJournal {
  plage: "periode" | "dates";
  heures: number;
  du: string;
  au: string;
}

/** Verification en cours, terminée (résultat du serveur) ou refusée (message). */
export type EtatVerification =
  | { statut: "en_cours" }
  | { statut: "resultat"; resultat: VerificationJournal; du: string; au: string }
  | { statut: "erreur"; message: string };

const jourUtc = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);
const ecartJours = (du: string, au: string): number => (Date.parse(au) - Date.parse(du)) / 86_400_000;
const jourValide = (j: string): boolean =>
  JOUR.test(j) && !Number.isNaN(Date.parse(j)) && new Date(Date.parse(j)).toISOString().slice(0, 10) === j;

/** Jours UTC (début, fin) de la période, ou le message de ce qui ne va pas dans les dates saisies. */
export function joursDeLaPeriode(
  p: PeriodeJournal,
  maintenant: number,
  maxJours = PERIODE_MAX_JOURS,
): { du: string; au: string } | { erreur: string } {
  if (p.plage === "periode") return { du: jourUtc(maintenant - p.heures * 3600), au: jourUtc(maintenant) };
  if (!jourValide(p.du) || !jourValide(p.au)) return { erreur: "Dates attendues au format AAAA-MM-JJ." };
  if (p.du > p.au) return { erreur: "La date de début suit la date de fin." };
  if (ecartJours(p.du, p.au) >= maxJours) return { erreur: `Période de ${maxJours} jours au plus.` };
  return { du: p.du, au: p.au };
}

/** Action transmise au serveur : l'action saisie l'emporte sur la catégorie. */
export const actionEffective = (f: FiltresJournalUi): string => f.action.trim() || f.cat;

export interface ParametresRecherche {
  du: string;
  au: string;
  filtres: FiltresJournalUi;
  marqueurs: boolean;
  limite?: number;
  curseur?: string | null;
  /** Export : pas de filtre de marqueurs ni de pagination. */
  export?: boolean;
}

/** Paramètres de requête de la recherche (ou de l'export) : filtres appliqués côté serveur. */
export function parametresRecherche(o: ParametresRecherche): URLSearchParams {
  const qs = new URLSearchParams({ from: o.du, to: o.au });
  const f = o.filtres;
  const action = actionEffective(f);
  if (action) qs.set("action", action);
  if (f.compte.trim()) qs.set("user", f.compte.trim());
  if (f.resultat) qs.set("outcome", f.resultat);
  if (f.ip.trim()) qs.set("ip", f.ip.trim());
  if (f.service) qs.set("service", f.service);
  if (f.texte.trim()) qs.set("q", f.texte.trim());
  if (!o.export) {
    qs.set("limit", String(o.limite ?? LIGNES_PAR_PAGE));
    if (!o.marqueurs) qs.set("exclude_markers", "1");
    if (o.curseur) qs.set("cursor", o.curseur);
  }
  return qs;
}

export function creerJournalSecurite(b: BaseAdmin) {
  const { vue, ctx, lien, estAdmin } = b;
  const { ref } = vue;
  const { fetchAuth } = ctx;

  const plage: Ref<"periode" | "dates"> = ref("periode");
  const heures = ref(lirePeriode());
  const dateDu = ref("");
  const dateAu = ref("");
  const filtres: Ref<FiltresJournalUi> = ref(filtresVides());
  const marqueurs = ref(false);

  const lignes: Ref<EvenementJournal[]> = ref([]);
  const partiel = ref(false);
  const illisibles = ref(0);
  const lus = ref(0);
  /** Instant de la dernière ligne examinée quand la lecture s'arrête avant la fin de la période. */
  const arretTs: Ref<number | null> = ref(null);
  /** Curseurs de début des pages déjà parcourues (la première commence sans curseur) et suite de la page affichée. */
  const curseursPages: Ref<(string | null)[]> = ref([null]);
  /** Rang (0 = première) de la première ligne de chaque page parcourue : les pages partielles ne comptent que leurs lignes. */
  const rangsPages: Ref<number[]> = ref([0]);
  const suivant: Ref<string | null> = ref(null);
  const numeroPage = ref(0);
  const chargement = ref(false);
  const derniereMaj: Ref<number | null> = ref(null);
  const echec = ref(false);
  const erreurDates = ref("");

  const etat: Ref<EtatJournal | null> = ref(null);
  const etatEchec = ref(false);

  const selection: Ref<EvenementJournal | null> = ref(null);
  const verification: Ref<EtatVerification | null> = ref(null);
  const exportOuvert = ref(false);
  const exportFormat: Ref<"jsonl" | "csv"> = ref("jsonl");
  const exportDu = ref("");
  const exportAu = ref("");
  const exportErreur = ref("");

  let sequence = 0;
  let sequenceEtat = 0;

  const periode = (): PeriodeJournal => ({
    plage: plage.value,
    heures: heures.value,
    du: dateDu.value,
    au: dateAu.value,
  });
  const maintenant = (): number => Date.now() / 1000;

  /** État du journal (bandeau) : lecture seule, une seule demande à la fois écrit. */
  async function loadJournalEtat(): Promise<void> {
    if (!estAdmin()) return;
    const moi = ++sequenceEtat;
    try {
      const lu = await lireSchema(await fetchAuth("/api/admin/audit/status", {}, true), schemaEtatJournal);
      if (moi !== sequenceEtat) return;
      etatEchec.value = lu === null;
      if (lu !== null) etat.value = lu;
    } catch {
      if (moi === sequenceEtat) etatEchec.value = true;
    }
  }

  /** Relance la page affichée (bouton « Réessayer »). */
  function relancer(): Promise<void> {
    return chargerPage(curseursPages.value[numeroPage.value] ?? null);
  }

  /** Requête de recherche ; un seul nouvel essai après un 429 (Retry-After, 2 s au plus) si la demande est toujours la plus récente. */
  async function demander(url: string, moi: number): Promise<Response | null> {
    const entetes = { "X-Elpis-Console": "1" };
    const r = await fetchAuth(url, { headers: entetes }, true);
    if (r?.status !== 429 || moi !== sequence) return r;
    const entete = r.headers.get("Retry-After");
    const secondes = entete === null || entete === "" ? 1 : Number(entete);
    const attente = Math.min(2000, Math.max(0, Number.isFinite(secondes) ? secondes * 1000 : 1000));
    await new Promise<void>((fin) => setTimeout(fin, attente));
    return moi === sequence ? fetchAuth(url, { headers: entetes }, true) : r;
  }

  /** Une page d'affichage : suit le curseur tant que le budget coupe la lecture (8 requêtes), filtres figés, jours UTC ; seule la dernière demande écrit ; `cible` adoptée au succès. */
  async function chargerPage(
    depart: string | null,
    cible?: { curseurs: (string | null)[]; rangs: number[]; numero: number; nouvelle?: boolean },
  ): Promise<void> {
    if (!estAdmin()) return;
    heures.value = lirePeriode();
    const jours = joursDeLaPeriode(periode(), maintenant());
    if ("erreur" in jours) {
      sequence += 1;
      chargement.value = false;
      suivant.value = null;
      erreurDates.value = jours.erreur;
      return;
    }
    erreurDates.value = "";
    const moi = ++sequence;
    chargement.value = true;
    const filtresPage = { ...filtres.value };
    const avecMarqueurs = marqueurs.value;
    const depuis = plage.value === "periode" ? maintenant() - heures.value * 3600 : null;
    try {
      const recus: EvenementJournal[] = [];
      let curseur = depart;
      let coupe = false;
      let echoue = false;
      let reste: string | null = null;
      let sautees = 0;
      let octets = 0;
      let dernier: number | null = null;
      for (let n = 0; n < PAGES_MAX; n++) {
        const qs = parametresRecherche({
          du: jours.du,
          au: jours.au,
          filtres: filtresPage,
          marqueurs: avecMarqueurs,
          limite: LIGNES_PAR_PAGE - recus.length,
          curseur,
        });
        const r = await demander(`/api/admin/audit/events?${qs.toString()}`, moi);
        if (moi !== sequence) return;
        const page = await lireSchema(r, schemaPageJournal);
        if (moi !== sequence) return;
        if (page === null) {
          echoue = true;
          break;
        }
        const dans = depuis === null ? page.events : page.events.filter((l) => (l.ts ?? 0) >= depuis);
        recus.push(...dans);
        sautees += page.unreadable;
        octets += page.scanned_bytes;
        dernier = page.last_ts;
        const fini =
          depuis !== null && (dans.length < page.events.length || (page.last_ts ?? Infinity) < depuis);
        reste = fini ? null : page.cursor;
        coupe = page.budget_reached && reste !== null;
        if (!coupe || recus.length >= LIGNES_PAR_PAGE || reste === null) break;
        curseur = reste;
      }
      if (recus.length > 0 || !echoue) {
        lignes.value = recus;
        illisibles.value = sautees;
        lus.value = octets;
        suivant.value = reste;
        partiel.value = (coupe || echoue) && recus.length < LIGNES_PAR_PAGE;
        arretTs.value = partiel.value ? dernier : null;
        if (cible) {
          curseursPages.value = cible.curseurs;
          rangsPages.value = cible.rangs;
          numeroPage.value = cible.numero;
        }
      } else if (cible?.nouvelle) {
        lignes.value = [];
        illisibles.value = 0;
        lus.value = 0;
        suivant.value = null;
        partiel.value = false;
        arretTs.value = null;
        curseursPages.value = cible.curseurs;
        rangsPages.value = cible.rangs;
        numeroPage.value = cible.numero;
      }
      echec.value = echoue;
      if (echoue)
        chargementEchoue("loadJournalSecurite", "Réponse du serveur inattendue ou en échec.", relancer);
      else {
        chargementReussi("loadJournalSecurite");
        derniereMaj.value = Date.now();
      }
    } catch {
      if (moi === sequence) {
        echec.value = true;
        chargementEchoue("loadJournalSecurite", "Erreur réseau.", relancer);
      }
    } finally {
      if (moi === sequence) chargement.value = false;
    }
  }

  /** Chargeur de l'onglet : bandeau d'état et première page. */
  async function loadJournalSecurite(): Promise<void> {
    if (!estAdmin()) return;
    await Promise.all([
      loadJournalEtat(),
      chargerPage(null, { curseurs: [null], rangs: [0], numero: 0, nouvelle: true }),
    ]);
  }
  function actualiser(): Promise<void> {
    return loadJournalSecurite();
  }

  /** Changement de filtre ou de période : retour à la première page. */
  function appliquer(): Promise<void> {
    return chargerPage(null, { curseurs: [null], rangs: [0], numero: 0, nouvelle: true });
  }
  function secuChoisirPeriode(h: number): Promise<void> {
    plage.value = "periode";
    heures.value = periodeValide(h);
    ecrirePeriode(heures.value);
    return appliquer();
  }
  function secuChoisirDates(): Promise<void> {
    if (plage.value !== "dates") {
      plage.value = "dates";
      if (!dateDu.value || !dateAu.value) {
        dateAu.value = jourUtc(maintenant());
        dateDu.value = jourUtc(maintenant() - 13 * 86_400);
      }
    }
    return appliquer();
  }
  function secuFiltrer(): Promise<void> {
    return appliquer();
  }
  /** Catégorie choisie : elle remplace l'action saisie. */
  function secuChoisirCategorie(prefixe: string): Promise<void> {
    filtres.value.cat = prefixe;
    filtres.value.action = "";
    return appliquer();
  }
  /** Action saisie : elle remplace la catégorie. */
  function secuSaisirAction(valeur: string): Promise<void> {
    filtres.value.action = valeur;
    if (valeur.trim()) filtres.value.cat = "";
    return appliquer();
  }
  function secuChoisirResultat(valeur: string): Promise<void> {
    filtres.value.resultat = valeur;
    return appliquer();
  }
  function secuBasculerMarqueurs(afficher: boolean): Promise<void> {
    marqueurs.value = afficher;
    return appliquer();
  }
  function secuEffacer(): Promise<void> {
    Object.assign(filtres.value, filtresVides());
    return appliquer();
  }
  /** Filtre ajouté depuis le tiroir (compte, IP ou action de la ligne ouverte). */
  function secuFiltrerSur(cle: "compte" | "ip" | "action", valeur: string): Promise<void> {
    selection.value = null;
    if (cle === "action") return secuSaisirAction(valeur);
    filtres.value[cle] = valeur;
    return appliquer();
  }
  function secuPlusAncien(): Promise<void> {
    if (suivant.value === null || chargement.value) return Promise.resolve();
    const prochain = numeroPage.value + 1;
    const curseurs = [...curseursPages.value.slice(0, prochain), suivant.value];
    const rangs = [
      ...rangsPages.value.slice(0, prochain),
      (rangsPages.value[numeroPage.value] ?? 0) + lignes.value.length,
    ];
    return chargerPage(suivant.value, { curseurs, rangs, numero: prochain });
  }
  function secuPlusRecent(): Promise<void> {
    if (numeroPage.value === 0 || chargement.value) return Promise.resolve();
    const numero = numeroPage.value - 1;
    return chargerPage(curseursPages.value[numero] ?? null, {
      curseurs: curseursPages.value,
      rangs: rangsPages.value,
      numero,
    });
  }
  /** « Réessayer » : la page affichée, pas la première. */
  function secuReessayer(): Promise<void> {
    return relancer();
  }

  function ouvrirEvenement(ligne: EvenementJournal): void {
    selection.value = ligne;
  }
  function fermerEvenement(): void {
    selection.value = null;
  }
  /** Ligne voisine dans la liste affichée (+1 plus ancienne, -1 plus récente). */
  function evenementVoisin(sens: 1 | -1): void {
    const i = lignes.value.findIndex((l) => l.ref === selection.value?.ref);
    const voisin = i < 0 ? undefined : lignes.value[i + sens];
    if (voisin) selection.value = voisin;
  }

  /** Vérification de la période affichée : une à la fois côté serveur (429), résultat selon les quatre statuts. */
  async function verifierIntegrite(): Promise<void> {
    if (!estAdmin() || verification.value?.statut === "en_cours") return;
    const jours = joursDeLaPeriode(periode(), maintenant());
    if ("erreur" in jours) {
      verification.value = { statut: "erreur", message: jours.erreur };
      return;
    }
    verification.value = { statut: "en_cours" };
    try {
      const r = await fetchAuth(
        "/api/admin/audit/verify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: jours.du, to: jours.au }),
        },
        true,
      );
      if (!r) {
        verification.value = { statut: "erreur", message: "Erreur réseau : la vérification n'a pas abouti." };
        return;
      }
      if (r.status === 429) {
        verification.value = {
          statut: "erreur",
          message: "Une vérification est déjà en cours. Réessayez dans quelques secondes.",
        };
        return;
      }
      const lu = r.ok ? schemaVerificationJournal.safeParse(await corpsJson(r)) : null;
      if (lu?.success) verification.value = { statut: "resultat", resultat: lu.data, ...jours };
      else
        verification.value = {
          statut: "erreur",
          message:
            detailErreur(await corpsJson(r), "") || `Réponse inattendue du serveur (HTTP ${r.status}).`,
        };
    } catch {
      verification.value = { statut: "erreur", message: "Erreur réseau : la vérification n'a pas abouti." };
    }
  }
  function fermerVerification(): void {
    if (verification.value?.statut !== "en_cours") verification.value = null;
  }

  /** Formulaire d'export : période de la liste (jours UTC) reprise comme valeur de départ. */
  function ouvrirExport(): void {
    const jours = joursDeLaPeriode(periode(), maintenant(), 100_000);
    const base =
      "erreur" in jours ? { du: jourUtc(maintenant() - 6 * 86_400), au: jourUtc(maintenant()) } : jours;
    exportDu.value = base.du;
    exportAu.value = base.au;
    exportErreur.value = "";
    exportOuvert.value = true;
  }
  function fermerExport(): void {
    exportOuvert.value = false;
  }
  /** Export en POST par la modale de transfert : mêmes filtres que la liste, marqueurs d'écriture toujours inclus. */
  async function lancerExport(): Promise<void> {
    if (!estAdmin()) return;
    const jours = joursDeLaPeriode(
      { plage: "dates", heures: heures.value, du: exportDu.value, au: exportAu.value },
      maintenant(),
      EXPORT_MAX_JOURS,
    );
    if ("erreur" in jours) {
      exportErreur.value = jours.erreur;
      return;
    }
    exportErreur.value = "";
    exportOuvert.value = false;
    const qs = parametresRecherche({
      du: jours.du,
      au: jours.au,
      filtres: filtres.value,
      marqueurs: true,
      export: true,
    });
    qs.set("format", exportFormat.value);
    await lien.downloadWithModal(
      `/api/admin/audit/export?${qs.toString()}`,
      "Export du journal de sécurité",
      `elpis-audit_${jours.du}_${jours.au}.${exportFormat.value}`,
      "Lecture du journal…",
      {
        methode: "POST",
        erreurs: {
          429: "Deux exports sont déjà en cours. Réessayez dans quelques secondes.",
          503: "Export refusé : sa trace n'a pas pu être écrite dans le journal de sécurité. Vérifiez l'état de l'écriture (bandeau d'état) avant de réessayer.",
        },
      },
    );
  }

  return {
    secuPlage: plage,
    secuHeures: heures,
    secuDu: dateDu,
    secuAu: dateAu,
    secuFiltres: filtres,
    secuMarqueurs: marqueurs,
    secuLignes: lignes,
    secuPartiel: partiel,
    secuIllisibles: illisibles,
    secuLus: lus,
    secuArretTs: arretTs,
    secuSuivant: suivant,
    secuNumeroPage: numeroPage,
    secuRangsPages: rangsPages,
    secuChargement: chargement,
    secuDerniereMaj: derniereMaj,
    secuEchec: echec,
    secuErreurDates: erreurDates,
    secuEtat: etat,
    secuEtatEchec: etatEchec,
    secuSelection: selection,
    secuVerification: verification,
    secuExportOuvert: exportOuvert,
    secuExportFormat: exportFormat,
    secuExportDu: exportDu,
    secuExportAu: exportAu,
    secuExportErreur: exportErreur,
    loadJournalSecurite,
    loadJournalEtat,
    secuActualiser: actualiser,
    secuChoisirPeriode,
    secuChoisirDates,
    secuFiltrer,
    secuChoisirCategorie,
    secuSaisirAction,
    secuChoisirResultat,
    secuBasculerMarqueurs,
    secuEffacer,
    secuFiltrerSur,
    secuPlusAncien,
    secuPlusRecent,
    secuReessayer,
    ouvrirEvenement,
    fermerEvenement,
    evenementVoisin,
    verifierIntegrite,
    fermerVerification,
    ouvrirExport,
    fermerExport,
    lancerExport,
  };
}
