// SPDX-License-Identifier: MIT
/** apps/core/src/llm/ordonnanceur/file.ts — `LLMQueue` : par serveur, le modèle (niveau 1), puis ses créneaux (niveau 2). */
import { AsyncLocalStorage } from "node:async_hooks";

import { Disjoncteur, reglagesDisjoncteur } from "./disjoncteur";
import type { ClasserErreur, Horloge, ReglagesDisjoncteur } from "./disjoncteur";
import { ajouterDuree, construireEtat, DEFAULT_ESTIMATE_MS, estimerDuree, resoudreMode } from "./etat";
import type { ModeOrdonnancement, QueueStatus } from "./etat";

export type ServerId = string;
export type Priorite = "high" | "low";
export type Politique = { maxModels: number; maxConcurrency: number };
/** Serveur visé ; `enFile` : ses appels passent par la file (llama.cpp, sd-server). */
export type Moteur = { id: ServerId; enFile: boolean };
/** Minuterie en secondes ; rend sa fonction d'annulation. */
export type Planifier = (delaiS: number, rappel: () => void) => () => void;

/** Anti-famine d'un `low` : 30 s après son premier blocage au portail du modèle, ou son arrivée parmi les créneaux. */
export const LOW_WAIT_CAP_S = 30;
/** Après le tour d'un `high`, son modèle reste réservé 8 s : un `low` n'en change pas. */
export const GRACE_S = 8;
/** Politique d'un serveur relue à sa source au plus toutes les 5 s. */
export const LIMITS_TTL_S = 5;

/** Réglages et état des moteurs, injectés (`@elpis/config` et les fournisseurs LLM viennent ensuite). */
export interface SourcesFile {
  politique(server: ServerId): Politique;
  totalSlots?(server: ServerId): number;
  modeConfigure?(): unknown;
  modeRecommande?(server: ServerId): ModeOrdonnancement;
  modeleParDefaut?(server: ServerId): string;
  statutsModeles?(server: ServerId): ReadonlyMap<string, string> | null;
  modeleChargeConnu?(server: ServerId): string | null;
  moteurCourant?(): Moteur;
  classerErreur?: ClasserErreur;
  horloge?: Horloge;
  planifier?: Planifier;
  disjoncteur?: ReglagesDisjoncteur;
}

export class LLMQueueAborted extends Error {
  override name = "LLMQueueAborted";
}

export interface Slot {
  readonly server: ServerId;
  readonly model: string;
  readonly priority: Priorite;
  readonly mode: ModeOrdonnancement;
  release(): void;
  yieldForTools(): void;
  reacquire(): Promise<void>;
  appelLLM<T>(fn: () => Promise<T>): Promise<T>;
  /** Null si le slot tient ou a tenu un créneau ; sinon résolue au premier (optimized, chemin outils : au premier appel LLM). */
  attenteCreneau(): Promise<void> | null;
}

/** `outils` (`use_mcp_path`) : en optimized, l'admission tient le modèle et chaque appel LLM prend son créneau ; `modeleSeul` : le niveau 1 seul (`MODEL_EXCLUSIVITY.acquire_for`), sans créneau ni disjoncteur. */
export type Appel = {
  model?: string | null;
  priority?: Priorite;
  signal?: AbortSignal;
  outils?: boolean;
  modeleSeul?: boolean;
};
export type OptionsAcquisition = Appel & { server: ServerId };
/** Clés de `LLMConcurrencyManager.get_stats()` (niveau 2), lues par `/api/llm/queue-status`. */
export type StatsFile = ReturnType<LLMQueue["stats"]>;

type Etat = "modele" | "creneau" | "actif" | "cede" | "rendu";
/** Attente au niveau 1 (`_locks.py`) : inscrite (`place`, revue quand une place se libère), endormie au portail tant qu'un `high` est inscrit, ou retenue par la grâce. */
type Attente = "place" | "hauts" | "grace";
type Demande = {
  seq: number;
  arrivee: number;
  portail?: number;
  attend?: Attente;
  liste: Demande[];
  slot: SlotFile;
} & Issue;
type Issue = { servir(): void; rejeter(e: Error): void };
/** Niveau 2 d'un modèle (`_active[model]` du Python) : ses créneaux pris, les demandes qui attendent le leur. */
type Pool = { creneaux: number; file: Demande[] };
type FileServeur = {
  id: ServerId;
  q: LLMQueue;
  lue?: { t: number; politique: Politique };
  tenus: Map<string, number>;
  attente: Demande[];
  pools: Map<string, Pool>;
  attentePool: Demande[];
  seq: number;
  disjoncteur: Disjoncteur;
  durees: Map<string, number[]>;
  grace?: { model: string; jusqua: number };
  annuler?: () => void;
};

const abandon = (signal?: AbortSignal): LLMQueueAborted =>
  new LLMQueueAborted("attente du modèle interrompue à votre demande", { cause: signal?.reason });
const auMoins1 = (n: number): number => (Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : 1);
const normaliser = (p: Politique): Politique => ({
  maxModels: auMoins1(p.maxModels),
  maxConcurrency: auMoins1(p.maxConcurrency),
});
/** Slot dont un appel au moteur est en cours dans ce contexte : un appel imbriqué y passe tel quel. */
const enAppel = new AsyncLocalStorage<SlotFile>();

/** Politique du serveur, relue à la source au plus toutes les `LIMITS_TTL_S` (comme `_engines._limits`). */
function politique(fs: FileServeur): Politique {
  const t = fs.q.horloge();
  if (!fs.lue || t - fs.lue.t >= LIMITS_TTL_S)
    fs.lue = { t, politique: normaliser(fs.q.sources.politique(fs.id)) };
  return fs.lue.politique;
}

/** Créneaux par modèle : `total_slots` de `/props` s'il est connu, sinon `max_concurrency`. */
const capacite = (fs: FileServeur, total = fs.q.sources.totalSlots?.(fs.id) ?? 0): number =>
  total > 0 ? auMoins1(total) : politique(fs).maxConcurrency;

/** Au portail du modèle : un `high`, ou un `low` dont le plafond (premier blocage + 30 s) est atteint. */
const prioritaire = (d: Demande, t: number): boolean =>
  d.slot.priority === "high" || (d.portail !== undefined && t >= d.portail + LOW_WAIT_CAP_S);

function retirer(d: Demande): void {
  d.liste.splice(d.liste.indexOf(d), 1);
  d.slot.demande = null;
  d.slot.signal?.removeEventListener("abort", d.slot.abandonner);
}

/** Change de file en gardant sa promesse ; rang et heure d'arrivée sont ceux de la nouvelle file. */
function deplacer(fs: FileServeur, d: Demande, liste: Demande[], t: number): void {
  d.liste.splice(d.liste.indexOf(d), 1);
  Object.assign(d, { liste, arrivee: t, seq: (fs.seq += 1) });
  liste.push(d);
}

function ouvrir(fs: FileServeur, model: string): Pool {
  const pool = { creneaux: 0, file: [] };
  fs.pools.set(model, pool);
  return pool;
}

/** Niveau 2 à l'arrivée (`_acquire_model_slot`) : le modèle ouvert accueille ; sinon il s'ouvre s'il reste une place, ou la demande attend la sienne. */
function fileCreneaux(fs: FileServeur, slot: SlotFile): Demande[] {
  const libre = fs.pools.size < politique(fs).maxModels;
  return (fs.pools.get(slot.model) ?? (libre ? ouvrir(fs, slot.model) : undefined))?.file ?? fs.attentePool;
}

/** La demande tient le modèle ; sauf créneau par appel, elle passe au niveau 2. */
function entrer(fs: FileServeur, d: Demande, t: number): void {
  fs.tenus.set(d.slot.model, (fs.tenus.get(d.slot.model) ?? 0) + 1);
  if (!d.slot.parAppel) {
    d.slot.etat = "creneau";
    deplacer(fs, d, fileCreneaux(fs, d.slot), t);
    return;
  }
  d.slot.etat = "cede";
  retirer(d);
  d.servir();
}

/** Niveau 1 : le modèle tenu accueille toute demande ; sinon un `low` non levé s'arrête au portail devant les `high` inscrits ou la grâce d'un autre modèle, et les autres attendent une place (revus quand il y en a une). */
function passerModeles(fs: FileServeur, t: number): boolean {
  const place = (): boolean => fs.tenus.size < politique(fs).maxModels;
  const reveil = place();
  let inscrits = fs.attente.filter((d) => d.attend === "place" && d.slot.priority === "high").length;
  let admis = false;
  const attendre = (d: Demande, attend: Attente): void => {
    if (d.attend !== attend) Object.assign(d, { attend, arrivee: t, seq: (fs.seq += 1) });
  };
  const passer = (d: Demande): void => {
    const tenu = fs.tenus.has(d.slot.model);
    const grace = fs.grace !== undefined && fs.grace.jusqua > t && fs.grace.model !== d.slot.model;
    if (!tenu && !prioritaire(d, t) && (inscrits > 0 || grace)) {
      d.portail ??= t;
      attendre(d, inscrits > 0 ? "hauts" : "grace");
    } else if (tenu || place()) {
      if (d.attend === "place" && d.slot.priority === "high") inscrits -= 1;
      if (!tenu) fs.grace = undefined;
      entrer(fs, d, t);
      admis = true;
    } else attendre(d, "place");
  };
  const ordre = (a: Demande, b: Demande): number => a.arrivee - b.arrivee || a.seq - b.seq;
  for (const d of fs.attente.filter((x) => !x.attend || (reveil && x.attend === "place")).sort(ordre))
    passer(d);
  for (const d of fs.attente.filter((x) => x.attend === "hauts" || x.attend === "grace").sort(ordre))
    if (d.attend === "grace" || inscrits === 0 || prioritaire(d, t)) passer(d);
  return admis;
}

/** Niveau 2 : les demandes en attente d'une place de modèle passent, `high` d'abord puis par arrivée, jusqu'à la première qui ne peut pas. */
function passerPools(fs: FileServeur, t: number): boolean {
  let admis = false;
  const haut = (d: Demande): number => Number(d.slot.priority === "high");
  for (const d of [...fs.attentePool].sort((a, b) => haut(b) - haut(a) || a.seq - b.seq)) {
    const libre = fs.pools.size < politique(fs).maxModels;
    const pool = fs.pools.get(d.slot.model) ?? (libre ? ouvrir(fs, d.slot.model) : undefined);
    if (!pool) break;
    deplacer(fs, d, pool.file, t);
    admis = true;
  }
  return admis;
}

/** Niveau 2 : `high` avant `low`, ordre d'arrivée dans chacune ; un `low` arrivé avant et qui attend depuis plus de 30 s passe. */
function passerCreneaux(fs: FileServeur, t: number): boolean {
  const cap = capacite(fs);
  let admis = false;
  for (const pool of fs.pools.values()) {
    while (pool.creneaux < cap) {
      const haut = pool.file.find((d) => d.slot.priority === "high");
      const bas = pool.file.find((d) => d.slot.priority === "low");
      const basPromu = bas && (!haut || (bas.arrivee < haut.arrivee && t - bas.arrivee > LOW_WAIT_CAP_S));
      const choisi = basPromu ? bas : (haut ?? bas);
      if (!choisi) break;
      pool.creneaux += 1;
      choisi.slot.etat = "actif";
      retirer(choisi);
      choisi.servir();
      admis = true;
    }
  }
  return admis;
}

/** Ferme les modèles sans créneau ni attente, rejoue les niveaux tant qu'une demande passe, puis arme le réveil du prochain plafond ou fin de grâce. */
function drainer(fs: FileServeur, echeance = -Infinity): void {
  const t = Math.max(fs.q.horloge(), echeance);
  for (const [model, pool] of fs.pools) if (pool.creneaux + pool.file.length === 0) fs.pools.delete(model);
  for (let encore = true; encore;)
    encore = [passerPools(fs, t), passerModeles(fs, t), passerCreneaux(fs, t)].includes(true);
  fs.annuler?.();
  fs.annuler = undefined;
  const retenus = fs.attente.filter(
    (d) => (d.attend === "hauts" || d.attend === "grace") && !prioritaire(d, t),
  );
  const reveils = retenus.map((d) => (d.portail ?? t) + LOW_WAIT_CAP_S);
  if (retenus.some((d) => d.attend === "grace") && fs.grace && fs.grace.jusqua > t)
    reveils.push(fs.grace.jusqua);
  const reveil = Math.min(...reveils);
  if (reveils.length > 0) fs.annuler = fs.q.planifier(reveil - t, () => drainer(fs, reveil));
}

/** Met en file puis passe ; une demande servie voit sa promesse résolue une microtâche plus tard, pour que chacune reparte dans l'ordre du passage. */
function enfiler(fs: FileServeur, slot: SlotFile, liste: Demande[]): Promise<void> {
  return new Promise<void>((tenir, rejeter) => {
    const servir = (): void => {
      slot.admis = true;
      queueMicrotask(tenir);
    };
    slot.demande = { seq: (fs.seq += 1), arrivee: fs.q.horloge(), liste, slot, servir, rejeter };
    slot.signal?.addEventListener("abort", slot.abandonner, { once: true });
    liste.push(slot.demande);
    drainer(fs);
  });
}

type Description = Pick<Slot, "model" | "priority" | "mode"> & {
  parAppel: boolean;
  tenant: boolean;
  signal?: AbortSignal;
};

class SlotFile implements Slot {
  etat: Etat = "modele";
  admis = false;
  demande: Demande | null = null;
  readonly fs: FileServeur;
  readonly server: ServerId;
  declare readonly model: string;
  declare readonly priority: Priorite;
  declare readonly mode: ModeOrdonnancement;
  declare readonly parAppel: boolean;
  declare readonly tenant: boolean;
  declare readonly signal: AbortSignal | undefined;
  private reprise: Promise<void> | null = null;
  private suite: Promise<unknown> = Promise.resolve();
  private aEuCreneau = false;
  private premierCreneau: { promesse: Promise<void>; resoudre: () => void } | null = null;

  constructor(fs: FileServeur, description: Description) {
    Object.assign(this, description);
    [this.fs, this.server] = [fs, fs.id];
  }

  /** Sort l'attente en cours de la file ; une reprise abandonnée garde le modèle jusqu'à `release`. */
  readonly abandonner = (): void => {
    const d = this.demande;
    if (!d) return;
    retirer(d);
    if (this.etat === "creneau" && this.admis) this.etat = "cede";
    else this.quitter();
    d.rejeter(abandon(this.signal));
    drainer(this.fs);
  };

  /** Rend créneau et modèle ; le dernier `high` à rendre un modèle ouvre sa grâce. */
  private quitter(): void {
    const pool = this.fs.pools.get(this.model);
    if (pool && this.etat === "actif") pool.creneaux -= 1;
    const [tenait, reste] = [
      this.tenant && this.etat !== "modele" && this.etat !== "rendu",
      this.fs.tenus.get(this.model) ?? 1,
    ];
    this.etat = "rendu";
    if (tenait && reste > 1) this.fs.tenus.set(this.model, reste - 1);
    if (!tenait || reste > 1) return;
    this.fs.tenus.delete(this.model);
    if (this.priority === "high")
      this.fs.grace = { model: this.model, jusqua: this.fs.q.horloge() + GRACE_S };
  }

  release(): void {
    if (this.etat === "rendu") return;
    this.abandonner();
    this.quitter();
    drainer(this.fs);
  }

  /** Optimized, chemin outils : rend le créneau après un appel LLM ; le modèle reste tenu. */
  yieldForTools(): void {
    const pool = this.fs.pools.get(this.model);
    if (this.etat !== "actif" || !this.parAppel || !pool) return;
    pool.creneaux -= 1;
    this.etat = "cede";
    drainer(this.fs);
  }

  /** Optimized, chemin outils : reprend un créneau ; un appel concurrent reçoit la même attente. */
  reacquire(): Promise<void> {
    if (this.reprise) return this.reprise;
    if (this.etat === "rendu") return Promise.reject(new LLMQueueAborted("créneau déjà rendu"));
    if (this.etat !== "cede") return Promise.resolve();
    if (this.signal?.aborted) return Promise.reject(abandon(this.signal));
    this.etat = "creneau";
    this.reprise = enfiler(this.fs, this, fileCreneaux(this.fs, this))
      .then(() => this.noterCreneau())
      .finally(() => {
        this.reprise = null;
      });
    return this.reprise;
  }

  attenteCreneau(): Promise<void> | null {
    if (this.aEuCreneau || this.etat === "actif") return null;
    if (!this.premierCreneau) {
      let resoudre = (): void => undefined;
      const promesse = new Promise<void>((r) => (resoudre = r));
      this.premierCreneau = { promesse, resoudre };
    }
    return this.premierCreneau.promesse;
  }

  private noterCreneau(): void {
    this.aEuCreneau = true;
    this.premierCreneau?.resoudre();
  }

  /** Un appel au moteur : en optimized (chemin outils), créneau repris puis rendu, un appel à la fois ; imbriqué dans un appel, il y passe. */
  appelLLM<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.parAppel || enAppel.getStore() === this) return fn();
    const appel = this.suite.then(async () => {
      const prise = this.etat === "cede";
      await this.reacquire();
      try {
        return await enAppel.run(this, fn);
      } finally {
        if (prise) this.yieldForTools();
      }
    });
    this.suite = appel.catch(() => undefined);
    return appel;
  }
}

const rien = (): undefined => undefined;
const HORS_FILE = {
  release: rien,
  yieldForTools: rien,
  reacquire: () => Promise.resolve(),
  appelLLM: <T>(f: () => T) => f(),
  attenteCreneau: () => null,
};
const planifierParDefaut: Planifier = (delaiS, rappel) => {
  const minuterie = setTimeout(rappel, Math.max(1, Math.ceil(delaiS * 1000)));
  minuterie.unref();
  return () => clearTimeout(minuterie);
};

export class LLMQueue {
  readonly sources: SourcesFile;
  readonly horloge: Horloge;
  readonly planifier: Planifier;
  private readonly reglages: ReglagesDisjoncteur;
  private readonly files = new Map<ServerId, FileServeur>();
  private readonly courants = new AsyncLocalStorage<ReadonlyMap<ServerId, SlotFile>>();

  constructor(sources: SourcesFile) {
    this.sources = sources;
    this.horloge = sources.horloge ?? (() => performance.now() / 1000);
    this.planifier = sources.planifier ?? planifierParDefaut;
    this.reglages = sources.disjoncteur ?? reglagesDisjoncteur();
  }

  private file(server: ServerId): FileServeur {
    const fs = this.files.get(server) ?? {
      id: server,
      q: this,
      tenus: new Map(),
      attente: [],
      pools: new Map(),
      attentePool: [],
      seq: 0,
      disjoncteur: new Disjoncteur(this.reglages, this.horloge, this.sources.classerErreur),
      durees: new Map(),
    };
    this.files.set(server, fs);
    return fs;
  }

  /** Modèle effectivement servi : le nom donné, sinon celui de la cible (`LLAMA_MODEL`), sinon « default ». */
  modeleEffectif(server: ServerId, model?: string | null): string {
    return model || this.sources.modeleParDefaut?.(server) || "default";
  }

  mode(server: ServerId): ModeOrdonnancement {
    return resoudreMode(this.sources.modeConfigure?.(), this.sources.modeRecommande?.(server) ?? "classic");
  }

  disjoncteur(server: ServerId): Disjoncteur {
    return this.file(server).disjoncteur;
  }

  /** Circuit ouvert ⇒ `LLMCircuitOpen` sans entrer en file ; abandon pendant l'attente ⇒ `LLMQueueAborted`. */
  acquire(o: OptionsAcquisition): Promise<Slot> {
    return this.admettre(o);
  }

  /** Un tour tient son modèle (niveau 1) ; un enfant (`tenant` faux, comme `llm_slot`) ne prend que des créneaux. */
  private async admettre(o: OptionsAcquisition, tenant = true): Promise<SlotFile> {
    const fs = this.file(o.server);
    const model = this.modeleEffectif(o.server, o.model);
    const mode = this.mode(o.server);
    if (!o.modeleSeul) fs.disjoncteur.allow(model);
    if (o.signal?.aborted) throw abandon(o.signal);
    const priority = o.priority === "low" ? "low" : "high";
    const parAppel = !!o.modeleSeul || (mode === "optimized" && !!o.outils);
    const slot = new SlotFile(fs, { model, priority, mode, parAppel, tenant, signal: o.signal });
    if (tenant) await enfiler(fs, slot, fs.attente);
    else if (parAppel) Object.assign(slot, { etat: "cede", admis: true });
    else await enfiler(fs, Object.assign(slot, { etat: "creneau" }), fileCreneaux(fs, slot));
    return slot;
  }

  /** Réglage admin à chaud, pris tout de suite (la source reste relue toutes les 5 s) : la file en profite dans son ordre. */
  setPolicy(server: ServerId, p: Politique): void {
    const fs = this.file(server);
    fs.lue = { t: this.horloge(), politique: normaliser(p) };
    drainer(fs);
  }

  /** Connecteur modifié ou supprimé : politique relue au prochain passage, file oubliée si plus rien ne la tient. */
  forget(server: ServerId): void {
    const fs = this.files.get(server);
    if (fs) fs.lue = undefined;
    if (!fs || fs.tenus.size + fs.attente.length + fs.pools.size + fs.attentePool.length > 0) return;
    fs.annuler?.();
    this.files.delete(server);
  }

  /** Valeurs de `_queue.py` : tenants du modèle (niveau 1), ses créneaux et ses attentes de place (niveau 2) ; le demandeur ne se compte pas. */
  status(server: ServerId, model?: string | null): QueueStatus {
    const fs = this.file(server);
    const cible = this.modeleEffectif(server, model);
    const [tenants, pool] = [fs.tenus.get(cible) ?? 0, fs.pools.get(cible)];
    const [autre] = fs.tenus.entries();
    const sansPlace = !tenants && fs.tenus.size >= politique(fs).maxModels;
    const [exclModel, exclCount]: [string | null, number] = tenants
      ? [cible, tenants]
      : sansPlace && autre
        ? autre
        : [null, 0];
    return construireEtat({
      model: cible,
      exclModel,
      exclCount,
      statuts: this.sources.statutsModeles?.(server) ?? null,
      chargeConnu: this.sources.modeleChargeConnu?.(server) ?? null,
      actifs: pool ? pool.creneaux + pool.file.length : 0,
      enAttente: fs.attentePool.filter((d) => d.slot.model === cible).length,
      plein: pool ? pool.creneaux >= capacite(fs) : fs.pools.size >= politique(fs).maxModels,
      dureeUnitaire: estimerDuree(fs.durees.get(cible) ?? []),
      dureeChargement: DEFAULT_ESTIMATE_MS,
    });
  }

  /** `snapshot()` du niveau 1 : premier modèle tenu et nombre de tenants (déchargement refusé pendant une génération). */
  occupation(server: ServerId): { current_model: string | null; active_count: number } {
    const tenus = this.files.get(server)?.tenus ?? new Map<string, number>();
    const [premier] = tenus.keys();
    let total = 0;
    for (const n of tenus.values()) total += n;
    return { current_model: premier ?? null, active_count: total };
  }

  /** `get_stats()` du gestionnaire Python (niveau 2), pour `/api/llm/queue-status` et son flux. */
  stats(server: ServerId) {
    const fs = this.file(server);
    const [p, cap, total] = [politique(fs), capacite(fs), this.sources.totalSlots?.(server) ?? 0];
    return {
      max_models: p.maxModels,
      max_conversations_per_model_config_fallback: p.maxConcurrency,
      total_slots_from_props: total > 0 ? total : null,
      active_models: [...fs.pools].map(([model, pool]) => {
        const occupation = { holders: pool.creneaux + pool.file.length, sem_locked: pool.creneaux >= cap };
        return { model, ...occupation, effective_max_convs: cap, shared_busy: pool.creneaux };
      }),
      slot_waiters: fs.attentePool.map((d) => ({
        model: d.slot.model,
        priority: d.slot.priority,
        cancelled: false,
      })),
    };
  }

  recordLlmDuration(server: ServerId, model: string | null | undefined, durationMs: number): void {
    ajouterDuree(this.file(server).durees, this.modeleEffectif(server, model), durationMs);
  }

  /** Seul point d'entrée (remplace `llm_scheduling_guard`) ; imbriqué sur le même serveur : le slot du tour s'il tient son créneau, sinon une admission d'enfant tant que le tour vit. */
  async withLLM<T>(
    model: string | null | undefined,
    priority: Priorite,
    signal: AbortSignal | undefined,
    fn: (slot: Slot) => Promise<T>,
    options: { moteur?: Moteur; outils?: boolean } = {},
  ): Promise<T> {
    const moteur = options.moteur ?? this.sources.moteurCourant?.() ?? { id: "builtin", enFile: true };
    const cible = this.modeleEffectif(moteur.id, model);
    const courant = this.courants.getStore()?.get(moteur.id);
    if (courant?.etat === "actif") return fn(courant);
    if (!moteur.enFile)
      return fn({ server: moteur.id, model: cible, priority, mode: this.mode(moteur.id), ...HORS_FILE });
    const disjoncteur = this.disjoncteur(moteur.id);
    const generation = disjoncteur.generation(cible);
    const appel = { ...options, server: moteur.id, model: cible, priority, signal };
    const slot = await this.admettre(appel, !courant || courant.etat === "rendu");
    let reussi = false;
    try {
      if (signal?.aborted) throw abandon(signal);
      const courants = new Map(this.courants.getStore()).set(moteur.id, slot);
      const resultat = await this.courants.run(courants, () => fn(slot));
      reussi = true;
      return resultat;
    } catch (e) {
      if (!(e instanceof LLMQueueAborted)) disjoncteur.noteTransportFailure(cible, e);
      throw e;
    } finally {
      slot.release();
      if (reussi) disjoncteur.recordSuccess(cible, generation);
    }
  }
}
