// SPDX-License-Identifier: MIT
/** apps/core/src/rag/travailleur.ts — travailleur d'indexation (main, meneur unique) : file des travaux en base, concurrence globale et par compte, tourniquet, contrôle des suspensions et suppressions, battement, reprise, migrations de modèle. */
import { randomUUID } from "node:crypto";

import { configRag } from "@elpis/config";
import type { Base } from "@elpis/db";
import type { ClientEmbeddings } from "@elpis/rag";

import { journal } from "../journal";
import { pousserNotification } from "../notifications/envoi";
import { collectionGeleeRag } from "./acces";
import { diffuserSansEchec, messageTravailRag } from "./depot";
import type { PublierRag } from "./depot";
import { extraitPresentRag, nettoyerMagasinRag } from "./entretien";
import { extraireDocument } from "./extracteur";
import type { OptionsExtraction, ResultatExtraction } from "./extracteur";
import { clientEmbeddingsRag, echouerDocument, indexerDocument, libererDocument } from "./indexeur";
import type { ContexteIndexeur, IssueDocumentRag, ServiceRag } from "./indexeur";
import { nomQdrantRag } from "./magasin";
import { clientQdrantRag, effacerNomQdrant, traiterAncienRag, traiterPurgesQdrant } from "./qdrant";
import type { PortQdrantRag } from "./qdrant";
import {
  assurerMigration,
  documentAMigrer,
  documentPublic,
  documentsATraiter,
  documentsParIds,
  ecrireParamsTravail,
  ETATS_DOCUMENT_A_TRAITER,
  ETATS_TRAVAIL_ACTIFS,
  lireCollection,
  lireTravail,
  metaAvecGeneration,
  rafraichirCollection,
  rejoindreTravail,
  resteATraiter,
  travauxActifs,
} from "./travaux";
import type { DocumentRagPublic, LigneDocumentRag, LigneTravailRag } from "./travaux";

const log = journal("rag");

/** Ce que le travailleur attend du leader du process (`Meneur`). */
export interface LeaderRag {
  readonly tenu: boolean;
  essayer(): Promise<boolean>;
}

export interface ReglagesTravailleurRag {
  /** Attente entre deux tours avec des documents en cours, sans, et quand le RAG n'est pas configuré. */
  tickActifMs: number;
  tickInactifMs: number;
  tickDesactiveMs: number;
  battementMs: number;
  purgesMs: number;
  magasinMs: number;
  /** Attente d'un service injoignable : doublée à chaque échec, de `attenteMinMs` à `attenteMaxMs`. */
  attenteMinMs: number;
  attenteMaxMs: number;
  /** Intervalle minimal entre deux événements intermédiaires d'un même travail. */
  debitEvenementsMs: number;
  essaisDouteux: number;
  dimensionTtlMs: number;
  arretMs: number;
}

export const REGLAGES_TRAVAILLEUR_RAG: Readonly<ReglagesTravailleurRag> = {
  tickActifMs: 2_000,
  tickInactifMs: 10_000,
  tickDesactiveMs: 30_000,
  battementMs: 10_000,
  purgesMs: 5 * 60_000,
  magasinMs: 6 * 3600_000,
  attenteMinMs: 5_000,
  attenteMaxMs: 5 * 60_000,
  debitEvenementsMs: 500,
  essaisDouteux: 3,
  dimensionTtlMs: 10 * 60_000,
  arretMs: 8_000,
};

/** Notification de fin d'un travail (au propriétaire). */
export interface NotificationRag {
  readonly uid: number;
  readonly kind: "rag_ok" | "rag_error";
  readonly title: string;
  readonly body: string;
  readonly collectionId: string;
}

export interface DependancesTravailleurRag {
  readonly base: Base;
  readonly meneur: LeaderRag;
  readonly diffuser?: PublierRag | undefined;
  readonly notifier?: ((n: NotificationRag) => Promise<unknown>) | undefined;
  readonly qdrant?: (() => PortQdrantRag) | undefined;
  readonly extraire?: ((o: OptionsExtraction) => Promise<ResultatExtraction>) | undefined;
  readonly embeddings?: ((modele: string) => ClientEmbeddings) | undefined;
  readonly bootId?: string | undefined;
  readonly reglages?: Partial<ReglagesTravailleurRag> | undefined;
}

/** Motif d'une interruption de document : suspension, annulation, suppression, nouvelle version, arrêt, perte du leadership. */
export type RaisonInterruptionRag =
  "pause" | "annulation" | "suppression" | "remplacement" | "arret" | "meneur" | "desactive";

export class InterruptionRag extends Error {
  override name = "AbortError";
  readonly raison: RaisonInterruptionRag;
  constructor(raison: RaisonInterruptionRag) {
    super(`indexation interrompue (${raison})`);
    this.raison = raison;
  }
}

interface Tache {
  readonly cle: string;
  readonly jobId: string;
  readonly collectionId: string;
  readonly uid: number;
  readonly docId: string | null;
  readonly sha256: string | null;
  readonly migration: boolean;
  readonly controleur: AbortController;
}

interface PauseService {
  jusqua: number;
  delai: number;
  message: string;
}

interface Debit {
  dernier: number;
  attente: Record<string, unknown> | null;
  minuterie: NodeJS.Timeout | null;
}

/** Filtre des documents en cours à interrompre (au moins un critère). */
export interface FiltreInterruptionRag {
  readonly jobId?: string;
  readonly collectionId?: string;
  readonly docId?: string;
  readonly uid?: number;
}

const maintenant = (): number => Date.now() / 1000;

export class TravailleurRag {
  readonly bootId: string;
  private readonly base: Base;
  private readonly meneur: LeaderRag;
  private readonly diffuser: PublierRag | undefined;
  private readonly notifier: (n: NotificationRag) => Promise<unknown>;
  private readonly qdrant: () => PortQdrantRag;
  private readonly r: ReglagesTravailleurRag;
  private readonly ctx: ContexteIndexeur;
  private readonly taches = new Map<string, Tache>();
  private readonly promesses = new Map<string, Promise<void>>();
  private readonly pauses = new Map<ServiceRag, PauseService>();
  private readonly essais = new Map<string, number>();
  /** Documents à ne pas reprendre avant l'instant donné (essai douteux ou erreur inattendue). */
  private readonly retards = new Map<string, { jusqua: number; collectionId: string }>();
  private readonly servis = new Map<number, number>();
  private readonly dimensions = new Map<string, { dim: number; t: number }>();
  private readonly debits = new Map<string, Debit>();
  private compteur = 0;
  private leader = false;
  private dernierBattement = 0;
  private dernieresPurges = 0;
  private dernierMagasin = 0;
  private reveil: (() => void) | null = null;
  private reveilDemande = false;
  private arrete = false;
  private aEteLeader = false;

  constructor(dep: DependancesTravailleurRag) {
    this.base = dep.base;
    this.meneur = dep.meneur;
    this.diffuser = dep.diffuser;
    this.bootId = dep.bootId ?? randomUUID();
    this.r = { ...REGLAGES_TRAVAILLEUR_RAG, ...dep.reglages };
    this.qdrant = dep.qdrant ?? clientQdrantRag;
    this.notifier =
      dep.notifier ??
      ((n) =>
        pousserNotification(this.base, n.uid, n.kind, n.title, {
          body: n.body,
          refType: "rag_collection",
          refId: n.collectionId,
        }));
    const qdrant = this.qdrant;
    this.ctx = {
      base: this.base,
      get qdrant() {
        return qdrant();
      },
      extraire: dep.extraire ?? extraireDocument,
      embeddings: dep.embeddings ?? clientEmbeddingsRag,
      dimension: (modele, signal) => this.dimension(modele, dep.embeddings ?? clientEmbeddingsRag, signal),
      surEtat: (travail, doc) => this.emettre(travail, documentPublic(doc), false),
    };
  }

  /** Documents en cours de traitement dans ce process. */
  get enCours(): number {
    return this.taches.size;
  }

  /** Ce process tient-il le leadership de l'indexation ? */
  get estLeader(): boolean {
    return this.leader;
  }

  /** Services en attente (injoignables) : jusqu'à quand et pourquoi. */
  pausesServices(): { service: ServiceRag; jusqua: number; message: string }[] {
    return [...this.pauses].map(([service, p]) => ({ service, jusqua: p.jusqua / 1000, message: p.message }));
  }

  /** Relance la boucle sans attendre le prochain tour (dépôt, reprise d'un travail). */
  reveiller(): void {
    if (this.reveil !== null) this.reveil();
    else this.reveilDemande = true;
  }

  /** Interrompt les documents en cours de ce process qui répondent au filtre ; rend leur nombre. */
  interrompre(filtre: FiltreInterruptionRag, raison: RaisonInterruptionRag): number {
    let n = 0;
    for (const t of this.taches.values()) {
      if (filtre.jobId !== undefined && t.jobId !== filtre.jobId) continue;
      if (filtre.collectionId !== undefined && t.collectionId !== filtre.collectionId) continue;
      if (filtre.docId !== undefined && t.docId !== filtre.docId) continue;
      if (filtre.uid !== undefined && t.uid !== filtre.uid) continue;
      if (!t.controleur.signal.aborted) {
        t.controleur.abort(new InterruptionRag(raison));
        n++;
      }
    }
    return n;
  }

  /** La boucle jusqu'à l'arrêt du process ; rien ne touche la base tant que le RAG n'est pas configuré. */
  async demarrer(signal: AbortSignal): Promise<void> {
    log.info(`travailleur d'indexation prêt (boot ${this.bootId})`);
    while (!signal.aborted && !this.arrete) {
      try {
        await this.tour(signal);
      } catch (e) {
        if (signal.aborted) break;
        log.warn({ err: e }, "tour du travailleur en échec");
        await this.attendre(this.r.tickInactifMs, signal);
      }
    }
  }

  /** Un tour : leadership, reprise, contrôle, battement, entretien, planification, puis attente. */
  async tour(signal: AbortSignal): Promise<void> {
    if (configRag().embed.url === "") {
      if (this.taches.size) this.interrompre({}, "desactive");
      this.leader = false;
      await this.attendre(this.r.tickDesactiveMs, signal);
      return;
    }
    if (!(await this.meneur.essayer())) {
      if (this.taches.size) this.interrompre({}, "meneur");
      this.leader = false;
      await this.attendre(this.r.tickInactifMs, signal);
      return;
    }
    if (!this.leader) {
      this.leader = true;
      this.aEteLeader = true;
      await this.reprendre();
    }
    await this.controler();
    await this.battre();
    await this.entretenir();
    await this.planifier();
    await this.attendre(this.taches.size ? this.r.tickActifMs : this.r.tickInactifMs, signal);
  }

  /** Arrêt du process : documents interrompus (remis en attente), travaux rendus à la file pour le prochain leader. */
  async arreter(): Promise<void> {
    this.arrete = true;
    this.interrompre({}, "arret");
    this.reveiller();
    const fin = Promise.allSettled([...this.promesses.values()]);
    let minuterie: NodeJS.Timeout | undefined;
    await Promise.race([fin, new Promise((r) => (minuterie = setTimeout(r, this.r.arretMs)))]);
    clearTimeout(minuterie);
    for (const d of this.debits.values()) if (d.minuterie) clearTimeout(d.minuterie);
    if (!this.aEteLeader) return;
    try {
      await this.base.run(
        "UPDATE rag_jobs SET status='queued', worker_boot_id=NULL WHERE worker_boot_id=? AND status='running'",
        [this.bootId],
      );
    } catch (e) {
      log.warn({ err: e }, "travaux en cours non rendus à la file");
    }
    this.leader = false;
  }

  private attendre(ms: number, signal: AbortSignal): Promise<void> {
    if (this.reveilDemande || signal.aborted) {
      this.reveilDemande = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const fin = (): void => {
        clearTimeout(minuterie);
        signal.removeEventListener("abort", fin);
        if (this.reveil === fin) this.reveil = null;
        resolve();
      };
      const minuterie = setTimeout(fin, ms);
      minuterie.unref();
      signal.addEventListener("abort", fin, { once: true });
      this.reveil = fin;
    });
  }

  /** Nouveau leader : documents restés « en cours » remis en attente, travaux repris, documents en attente sans travail rattachés. */
  async reprendre(): Promise<void> {
    const orphelins = await this.base.ecriture(async (x) => {
      await x.run(`UPDATE rag_documents SET status='pending' WHERE status IN ('extracting', 'indexing')`);
      await x.run(
        "UPDATE rag_jobs SET worker_boot_id=NULL WHERE status='running' AND (worker_boot_id IS NULL OR worker_boot_id <> ?)",
        [this.bootId],
      );
      const lignes = await x.valeurs<[unknown, unknown, unknown]>(
        "SELECT d.collection_id, c.owner_user_id, COUNT(*) FROM rag_documents d JOIN rag_collections c ON c.id = d.collection_id " +
          `WHERE d.status IN ${ETATS_DOCUMENT_A_TRAITER} AND NOT EXISTS (SELECT 1 FROM rag_jobs j WHERE j.collection_id = d.collection_id ` +
          `AND j.status IN ${ETATS_TRAVAIL_ACTIFS} AND j.kind <> 'migrate') GROUP BY d.collection_id, c.owner_user_id`,
      );
      for (const [c, uid, n] of lignes)
        await rejoindreTravail(x, {
          collectionId: String(c),
          uid: Number(uid),
          genre: "ingest",
          n: Number(n),
          t: maintenant(),
        });
      return lignes.length;
    });
    if (orphelins)
      log.info(`${orphelins} collection(s) avec des documents en attente sans travail : remises en file`);
    log.info(`leadership de l'indexation pris (boot ${this.bootId})`);
  }

  /** Interrompt les documents dont le travail est suspendu ou fini, ou dont le document a disparu ou changé de version. */
  async controler(): Promise<void> {
    if (!this.taches.size) return;
    const taches = [...this.taches.values()];
    const ids = [...new Set(taches.map((t) => t.jobId))];
    const etats = new Map(
      (
        await this.base.valeurs<[unknown, unknown]>(
          `SELECT id, status FROM rag_jobs WHERE id IN (${ids.map(() => "?").join(",")})`,
          ids,
        )
      ).map(([id, s]) => [String(id), String(s)]),
    );
    const docs = new Map(
      (
        await documentsParIds(
          this.base,
          taches.flatMap((t) => (t.docId === null ? [] : [t.docId])),
        )
      ).map((d) => [d.id, d]),
    );
    for (const t of taches) {
      if (t.controleur.signal.aborted) continue;
      const s = etats.get(t.jobId);
      if (s === "paused") t.controleur.abort(new InterruptionRag("pause"));
      else if (s !== "queued" && s !== "running") t.controleur.abort(new InterruptionRag("annulation"));
      else if (t.docId !== null) {
        const d = docs.get(t.docId);
        if (d === undefined) t.controleur.abort(new InterruptionRag("suppression"));
        else if (!t.migration && d.sha256 !== t.sha256)
          t.controleur.abort(new InterruptionRag("remplacement"));
      }
    }
  }

  private async battre(): Promise<void> {
    const t = Date.now();
    if (t - this.dernierBattement < this.r.battementMs) return;
    this.dernierBattement = t;
    await this.base.run("UPDATE rag_jobs SET heartbeat_at=? WHERE worker_boot_id=? AND status='running'", [
      t / 1000,
      this.bootId,
    ]);
  }

  /** Effacements Qdrant reportés, puis fichiers orphelins du magasin, à leur rythme. */
  private async entretenir(): Promise<void> {
    const t = Date.now();
    if (t - this.dernieresPurges >= this.r.purgesMs && !this.enPause("qdrant")) {
      this.dernieresPurges = t;
      try {
        const { faites } = await traiterPurgesQdrant(this.qdrant());
        if (faites) log.info(`${faites} effacement(s) Qdrant reporté(s) rejoué(s)`);
        await traiterAncienRag(this.qdrant());
      } catch (e) {
        log.warn({ err: e }, "effacements Qdrant reportés non rejoués");
      }
    }
    if (t - this.dernierMagasin >= this.r.magasinMs) {
      this.dernierMagasin = t;
      try {
        const n = await nettoyerMagasinRag(this.base);
        if (n) log.info(`${n} fichier(s) orphelin(s) retiré(s) du magasin`);
      } catch (e) {
        log.warn({ err: e }, "entretien du magasin en échec");
      }
    }
  }

  private enPause(service: ServiceRag): boolean {
    const p = this.pauses.get(service);
    return p !== undefined && p.jusqua > Date.now();
  }

  private poserPause(service: ServiceRag, message: string): void {
    const avant = this.pauses.get(service);
    const delai = avant ? Math.min(this.r.attenteMaxMs, avant.delai * 2) : this.r.attenteMinMs;
    this.pauses.set(service, { jusqua: Date.now() + delai, delai, message });
    log.warn(`${service} en attente ${Math.round(delai / 1000)} s : ${message}`);
  }

  private async dimension(
    modele: string,
    fabrique: (modele: string) => ClientEmbeddings,
    signal: AbortSignal,
  ): Promise<number> {
    const cle = `${configRag().embed.url}\u0000${modele}`;
    const connue = this.dimensions.get(cle);
    if (connue !== undefined && Date.now() - connue.t < this.r.dimensionTtlMs) return connue.dim;
    const dim = await fabrique(modele).sonderDimension({ signal });
    this.dimensions.set(cle, { dim, t: Date.now() });
    return dim;
  }

  private tachesDu(jobId: string): number {
    let n = 0;
    for (const t of this.taches.values()) if (t.jobId === jobId) n++;
    return n;
  }

  private enCoursDuCompte(uid: number): number {
    let n = 0;
    for (const t of this.taches.values()) if (t.uid === uid) n++;
    return n;
  }

  /** Lance des documents tant qu'il reste des places : un par compte et par passe, comptes les moins récemment servis d'abord. */
  async planifier(): Promise<void> {
    const { concurrence, par_compte } = configRag().indexation;
    if (this.taches.size >= concurrence) return;
    const parCollection = new Map<string, LigneTravailRag[]>();
    const actifs = await travauxActifs(this.base);
    const ids = new Set(actifs.map((t) => t.id));
    for (const [id, d] of this.debits) if (!ids.has(id) && d.minuterie === null) this.debits.delete(id);
    for (const t of actifs) {
      if (t.kind === "purge") continue;
      parCollection.set(t.collection_id, [...(parCollection.get(t.collection_id) ?? []), t]);
    }
    const candidats: LigneTravailRag[] = [];
    for (const [collectionId, liste] of parCollection) {
      const courant = liste.find((t) => t.kind === "migrate") ?? liste[0];
      if (courant === undefined || courant.status === "paused") continue;
      const autres = [...this.taches.values()].some(
        (k) => k.collectionId === collectionId && k.jobId !== courant.id,
      );
      if (!autres) candidats.push(courant);
    }
    const ordre = (t: LigneTravailRag): number => this.servis.get(t.owner_user_id) ?? -1;
    const exclus = new Set<string>();
    const marques = new Set<string>();
    for (let lance = true; lance && this.taches.size < concurrence;) {
      lance = false;
      candidats.sort((a, b) => ordre(a) - ordre(b) || a.created_at - b.created_at);
      const comptes = new Set<number>();
      for (const t of candidats) {
        if (this.taches.size >= concurrence) break;
        if (
          exclus.has(t.id) ||
          comptes.has(t.owner_user_id) ||
          this.enCoursDuCompte(t.owner_user_id) >= par_compte
        )
          continue;
        if (await this.gelee(t)) {
          exclus.add(t.id);
          continue;
        }
        const suivant = t.kind === "migrate" ? await this.prochainAMigrer(t) : await this.prochainDocument(t);
        if (suivant === "fini") {
          exclus.add(t.id);
          await this.terminer(t);
          continue;
        }
        if (suivant === null) {
          exclus.add(t.id);
          continue;
        }
        if (this.arrete) return;
        if (!marques.has(t.id) && !(await this.marquerEnCours(t))) {
          exclus.add(t.id);
          continue;
        }
        marques.add(t.id);
        this.lancer(t, suivant);
        this.servis.set(t.owner_user_id, ++this.compteur);
        comptes.add(t.owner_user_id);
        lance = true;
      }
    }
  }

  /** Travail d'une collection privée dont l'auteur a perdu le droit RAG : laissé en file, son texte ne part pas au serveur d'embeddings. */
  private async gelee(t: LigneTravailRag): Promise<boolean> {
    const [ligne] = await this.base.valeurs<[unknown, unknown]>(
      "SELECT owner_user_id, visibility FROM rag_collections WHERE id=?",
      [t.collection_id],
    );
    return ligne !== undefined && (await collectionGeleeRag(this.base, Number(ligne[0]), String(ligne[1])));
  }

  /** Prochain document d'un travail d'ajout ou de réindexation ; « fini » s'il ne reste rien et que rien n'est en cours. */
  private async prochainDocument(t: LigneTravailRag): Promise<LigneDocumentRag | "fini" | null> {
    if (this.enPause("embeddings") || this.enPause("qdrant")) return null;
    const enCours = new Set([...this.taches.values()].flatMap((k) => (k.docId === null ? [] : [k.docId])));
    const maintenantMs = Date.now();
    let retardes = false;
    for (const [id, r] of this.retards)
      if (r.jusqua <= maintenantMs) this.retards.delete(id);
      else {
        enCours.add(id);
        retardes ||= r.collectionId === t.collection_id;
      }
    const doc = await documentsATraiter(this.base, t.collection_id, enCours);
    if (doc === null) return this.tachesDu(t.id) || retardes ? null : "fini";
    if (this.enPause("extracteur") && (t.params.reextraire || !(await this.extraitDispo(doc)))) return null;
    return doc;
  }

  private retarder(doc: LigneDocumentRag, essais: number): void {
    const delai = Math.min(this.r.attenteMaxMs, this.r.attenteMinMs * 2 ** (essais - 1));
    this.retards.set(doc.id, { jusqua: Date.now() + delai, collectionId: doc.collection_id });
  }

  private async extraitDispo(doc: LigneDocumentRag): Promise<boolean> {
    const coll = await lireCollection(this.base, doc.collection_id);
    return coll !== null && extraitPresentRag(coll.owner_user_id, coll.id, doc.id);
  }

  /** Prochain document d'une migration (un à la fois, curseur) ; modèle changé en route : la migration repart de zéro vers le nouveau. */
  private async prochainAMigrer(t: LigneTravailRag): Promise<LigneDocumentRag | "fini" | null> {
    if (this.tachesDu(t.id) || this.enPause("embeddings") || this.enPause("qdrant")) return null;
    const modele = configRag().embed.model;
    if (t.params.modele !== modele) {
      await this.repartirMigration(t, modele);
      return null;
    }
    const doc = await documentAMigrer(this.base, t.collection_id, t.params.curseur ?? null);
    if (doc === null) return "fini";
    if ((this.retards.get(doc.id)?.jusqua ?? 0) > Date.now()) return null;
    if (this.enPause("extracteur") && !(await this.extraitDispo(doc))) return null;
    return doc;
  }

  private async repartirMigration(t: LigneTravailRag, modele: string): Promise<void> {
    const coll = await lireCollection(this.base, t.collection_id);
    if (coll === null) return;
    const generation = t.params.generation ?? coll.meta.generation + 1;
    await effacerNomQdrant(this.qdrant(), nomQdrantRag(coll.id, generation));
    await this.base.ecriture(async (x) => {
      await ecrireParamsTravail(x, t.id, { generation, modele, curseur: null, debut: maintenant() });
      await x.run(
        "UPDATE rag_jobs SET done=0, failed=0, total=(SELECT COUNT(*) FROM rag_documents WHERE collection_id=? AND status='ready') WHERE id=?",
        [t.collection_id, t.id],
      );
    });
    log.info(`migration de ${t.collection_id} repartie vers le modèle ${modele}`);
  }

  /** Le travail passe « en cours » pour ce process ; faux s'il a été suspendu ou arrêté entre-temps. */
  private async marquerEnCours(t: LigneTravailRag): Promise<boolean> {
    if (t.status === "running" && t.worker_boot_id === this.bootId) return true;
    const debut = t.kind === "migrate" && t.params.curseur == null && t.done === 0;
    const r = await this.base.run(
      "UPDATE rag_jobs SET status='running', worker_boot_id=?, heartbeat_at=?" +
        (debut
          ? ", total=(SELECT COUNT(*) FROM rag_documents WHERE collection_id=? AND status='ready')"
          : "") +
        " WHERE id=? AND status IN ('queued', 'running')",
      debut ? [this.bootId, maintenant(), t.collection_id, t.id] : [this.bootId, maintenant(), t.id],
    );
    if (r.changes === 0) return false;
    const apres = await lireTravail(this.base, t.id);
    if (apres !== null && t.status !== "running") this.emettre(apres, undefined, true);
    return true;
  }

  private lancer(t: LigneTravailRag, doc: LigneDocumentRag): void {
    const tache: Tache = {
      cle: doc.id,
      jobId: t.id,
      collectionId: t.collection_id,
      uid: t.owner_user_id,
      docId: doc.id,
      sha256: doc.sha256,
      migration: t.kind === "migrate",
      controleur: new AbortController(),
    };
    this.taches.set(tache.cle, tache);
    const promesse = this.executer(tache, t, doc)
      .catch((e: unknown) => log.warn({ err: e }, `document ${doc.id} : traitement en échec`))
      .finally(() => {
        this.taches.delete(tache.cle);
        this.promesses.delete(tache.cle);
        this.reveiller();
      });
    this.promesses.set(tache.cle, promesse);
  }

  private async executer(tache: Tache, t: LigneTravailRag, doc: LigneDocumentRag): Promise<void> {
    const essais = this.essais.get(doc.id) ?? 0;
    let issue: IssueDocumentRag;
    try {
      issue = await indexerDocument(this.ctx, t, doc, tache.controleur.signal, {
        douteuxFatal: essais + 1 >= this.r.essaisDouteux,
      });
    } catch (e) {
      log.warn({ err: e }, `document ${doc.id} : erreur inattendue (essai ${essais + 1})`);
      this.essais.set(doc.id, essais + 1);
      this.retarder(doc, essais + 1);
      if (essais + 1 >= this.r.essaisDouteux) {
        this.essais.delete(doc.id);
        await echouerDocument(this.ctx, t, doc, "internal");
      } else if (t.kind !== "migrate") await libererDocument(this.base, doc, null, null);
      return;
    }
    switch (issue.genre) {
      case "pret":
        this.pauses.clear();
        this.essais.delete(doc.id);
        this.retards.delete(doc.id);
        break;
      case "echec":
        this.essais.delete(doc.id);
        this.retards.delete(doc.id);
        break;
      case "attente":
        this.poserPause(issue.service, issue.message);
        await this.noterAttente(t, issue.message);
        break;
      case "douteux":
        this.essais.set(doc.id, essais + 1);
        this.retarder(doc, essais + 1);
        if (issue.code === "qdrant_unavailable") this.poserPause("qdrant", issue.message);
        break;
      case "modele":
        this.dimensions.clear();
        if (t.kind === "migrate") await this.repartirMigration(t, configRag().embed.model);
        else await this.creerMigration(t.collection_id);
        break;
      default:
        break;
    }
  }

  private async noterAttente(t: LigneTravailRag, message: string): Promise<void> {
    await this.base.run("UPDATE rag_jobs SET error=? WHERE id=? AND status IN ('queued', 'running')", [
      message.slice(0, 500),
      t.id,
    ]);
    const apres = await lireTravail(this.base, t.id);
    if (apres !== null) this.emettre(apres, undefined, true);
  }

  /** Le modèle d'embedding de la configuration n'est plus celui de la collection : une migration passe avant ses autres travaux. */
  async creerMigration(collectionId: string): Promise<LigneTravailRag | null> {
    const issue = await this.base.ecriture(async (x) => {
      const coll = await lireCollection(x, collectionId);
      if (coll === null) return null;
      const m = await assurerMigration(x, {
        collection: coll,
        modele: configRag().embed.model,
        t: maintenant(),
      });
      await rafraichirCollection(x, collectionId);
      return m;
    });
    if (issue?.cree) {
      log.info(`migration de modèle créée pour la collection ${collectionId}`);
      this.emettre(issue.travail, undefined, true);
    }
    return issue?.travail ?? null;
  }

  /** Fin d'un travail sans document restant : bascule pour une migration, sinon état final, événement et notification. */
  private async terminer(t: LigneTravailRag): Promise<void> {
    if (t.kind === "migrate") return this.basculer(t);
    const fini = await this.base.ecriture(async (x) => {
      if ((await resteATraiter(x, t.collection_id)) > 0) return null;
      const r = await x.run(
        "UPDATE rag_jobs SET status='done', finished_at=?, total = done + failed, error=NULL WHERE id=? AND status IN ('queued', 'running')",
        [maintenant(), t.id],
      );
      if (r.changes === 0) return null;
      await rafraichirCollection(x, t.collection_id);
      return lireTravail(x, t.id);
    });
    if (fini) await this.annoncerFin(fini);
  }

  /** Bascule d'une migration : la collection sert la nouvelle génération, l'ancienne est supprimée ; aucun document migré et des échecs : pas de bascule, la nouvelle est supprimée. */
  private async basculer(t: LigneTravailRag): Promise<void> {
    const modele = t.params.modele ?? "";
    if (modele !== configRag().embed.model) return;
    let dimension: number;
    try {
      dimension = await this.ctx.dimension(modele, AbortSignal.timeout(30_000));
    } catch (e) {
      this.poserPause("embeddings", e instanceof Error ? e.message : String(e));
      return;
    }
    const issue = await this.base.ecriture(async (x) => {
      const j = await lireTravail(x, t.id);
      const coll = await lireCollection(x, t.collection_id);
      if (j === null || coll === null || (j.status !== "queued" && j.status !== "running")) return null;
      if ((await documentAMigrer(x, t.collection_id, j.params.curseur ?? null)) !== null) return null;
      const generation = j.params.generation ?? coll.meta.generation + 1;
      const abandon = j.done === 0 && j.failed > 0;
      if (!abandon)
        await x.run("UPDATE rag_collections SET embed_model=?, embed_dim=?, meta_json=? WHERE id=?", [
          modele,
          dimension,
          metaAvecGeneration(coll.meta_json, generation),
          coll.id,
        ]);
      await x.run("UPDATE rag_jobs SET status=?, finished_at=?, total = done + failed, error=? WHERE id=?", [
        abandon ? "failed" : "done",
        maintenant(),
        abandon ? "aucun document migré : l'ancienne génération reste servie" : null,
        t.id,
      ]);
      await rafraichirCollection(x, t.collection_id);
      const aEffacer = nomQdrantRag(coll.id, abandon ? generation : coll.meta.generation);
      return { aEffacer, abandon, travail: await lireTravail(x, t.id) };
    });
    if (issue === null) return;
    await effacerNomQdrant(this.qdrant(), issue.aEffacer);
    if (issue.abandon)
      log.warn(`migration de ${t.collection_id} abandonnée : aucun document migré, modèle inchangé`);
    else log.info(`migration de ${t.collection_id} terminée : modèle ${modele}, dimension ${dimension}`);
    if (issue.travail) await this.annoncerFin(issue.travail);
  }

  private async annoncerFin(travail: LigneTravailRag): Promise<void> {
    this.emettre(travail, undefined, true);
    this.debits.delete(travail.id);
    const coll = await lireCollection(this.base, travail.collection_id);
    if (coll === null || travail.done + travail.failed === 0) return;
    const nom = coll.name;
    const migration = travail.kind === "migrate";
    const titre = migration
      ? `Migration du modèle terminée : ${nom}`
      : travail.failed
        ? `Indexation terminée avec ${travail.failed} échec(s) : ${nom}`
        : `Indexation terminée : ${nom}`;
    const corps = `${travail.done} document(s) indexé(s)${travail.failed ? `, ${travail.failed} en échec` : ""}.`;
    try {
      await this.notifier({
        uid: travail.owner_user_id,
        kind: travail.failed ? "rag_error" : "rag_ok",
        title: titre,
        body: corps,
        collectionId: travail.collection_id,
      });
    } catch (e) {
      log.debug({ err: e }, "notification de fin non émise");
    }
  }

  /** Événement `rag_job` au propriétaire : un changement d'état de travail ou un document fini part tout de suite, le reste au plus toutes les `debitEvenementsMs`. */
  emettre(travail: LigneTravailRag, document: DocumentRagPublic | undefined, immediat: boolean): void {
    const message = messageTravailRag(travail.owner_user_id, travail, document);
    const final = immediat || document?.status === "ready" || document?.status === "error";
    let d = this.debits.get(travail.id);
    if (d === undefined) {
      d = { dernier: 0, attente: null, minuterie: null };
      this.debits.set(travail.id, d);
    }
    const t = Date.now();
    if (final || t - d.dernier >= this.r.debitEvenementsMs) {
      if (d.minuterie) clearTimeout(d.minuterie);
      d.minuterie = null;
      d.attente = null;
      d.dernier = t;
      void diffuserSansEchec(this.diffuser, message);
      return;
    }
    d.attente = message;
    if (d.minuterie !== null) return;
    const debit = d;
    debit.minuterie = setTimeout(
      () => {
        debit.minuterie = null;
        const m = debit.attente;
        debit.attente = null;
        debit.dernier = Date.now();
        if (m !== null) void diffuserSansEchec(this.diffuser, m);
      },
      this.r.debitEvenementsMs - (t - d.dernier),
    );
    debit.minuterie.unref();
  }
}
