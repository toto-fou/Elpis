// SPDX-License-Identifier: MIT
/** packages/securite/src/audit-agregat.ts — rafales d'un même événement (refus répétés) résumées par fenêtre et bornées par source ; lectures d'un admin dédupliquées à part. */
import { adresseIpOuNul } from "@elpis/commun";

import { auditEvent, avantArretAudit, texteBorne } from "./audit";
import type { EvenementAudit } from "./audit";

export interface OptionsAgregat {
  /** Durée d'une fenêtre, depuis la première occurrence d'une rafale (60 s). */
  fenetreMs?: number;
  /** Clés suivies à la fois, toutes origines confondues (1024). */
  maxCles?: number;
  /** Clés sans compte au plus (la moitié de `maxCles`) : le bruit anonyme laisse la place aux refus des comptes connectés. */
  maxClesAnonymes?: number;
  /** Nouvelles clés qu'une source (groupe d'adresses, et compte s'il y en a un) peut ouvrir par fenêtre (8) : au-delà, ses occurrences sont seulement comptées. */
  maxClesParSource?: number;
  /** Dont au plus 4 pour une même action : le bruit d'un refus ne cache pas les autres refus de la même source. */
  maxClesParSourceEtAction?: number;
  /** Clés d'un même compte, tous groupes d'adresses confondus (32). */
  maxClesParCompte?: number;
  /** Clés sans compte d'une même action (128) : le bruit d'un refus n'évince pas les autres. */
  maxClesParAction?: number;
  ecrire?: (e: EvenementAudit) => void;
  maintenant?: () => number;
}

export interface AgregatAudit {
  signaler(cle: string, e: EvenementAudit): void;
  /** Résumés des rafales en cours écrits, clés oubliées. */
  vider(): void;
}

interface Rafale {
  e: EvenementAudit;
  n: number;
  premier: number;
  dernier: number;
}

interface Echantillon {
  action: string;
  user_id: number | null;
  ip: string | null;
  method: string | null;
  route: string | null;
}

interface Debordement {
  ip: string | null;
  /** IPv6 /64 du groupe, null pour une IPv4 ou le reste. */
  reseau: string | null;
  n: number;
  actions: Map<string, number>;
  comptes: Set<number>;
  echantillon: Echantillon[];
}

const MAX_ACTIONS_DEBORDEMENT = 20;
const MAX_GROUPES_DEBORDEMENT = 256;
const MAX_COMPTES_DEBORDEMENT = 16;
const ECHANTILLON_MAX = 6;
const ECHANTILLON_PAR_ACTION = 2;
const ROUTE_ECHANTILLON_MAX = 100;
const AUTRES = "_other";

function detailsObjet(d: unknown): Record<string, unknown> {
  return d !== null && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
}

/** Groupe d'adresses d'une IP : IPv6 ramenée à son /64 (un poste y choisit librement ses adresses), IPv4 et IPv4 transposée entières, autre texte tel quel. */
function groupeAdresses(ip: string | null): string {
  const s = ip ?? "?";
  const a = adresseIpOuNul(s);
  if (a === null || a.version === 4 || a.valeur >> 32n === 0xffffn) return s;
  const p = a.valeur >> 64n;
  return `${[48n, 32n, 16n, 0n].map((d) => ((p >> d) & 0xffffn).toString(16)).join(":")}::/64`;
}

const textePropre = (v: unknown, max: number): string | null =>
  typeof v === "string" ? texteBorne(v, max) : null;

/** Résumé d'une rafale répétée : champs de la première occurrence, nombre et bornes de la fenêtre. */
function resume(r: Rafale, fenetreS: number): EvenementAudit {
  return {
    ...r.e,
    details: {
      ...detailsObjet(r.e.details),
      repeated: r.n,
      first_ts: r.premier,
      last_ts: r.dernier,
      window_s: fenetreS,
    },
  };
}

/** Occurrence gardée dans l'échantillon d'un débordement : deux par action et six en tout, un compte connecté remplace une occurrence anonyme. */
function echantillonner(d: Debordement, x: Echantillon): void {
  const meme = (y: Echantillon): boolean =>
    y.action === x.action && y.user_id === x.user_id && y.ip === x.ip && y.route === x.route;
  if (d.echantillon.some(meme)) return;
  const memeAction = d.echantillon.filter((y) => y.action === x.action).length;
  if (memeAction < ECHANTILLON_PAR_ACTION && d.echantillon.length < ECHANTILLON_MAX) {
    d.echantillon.push(x);
    return;
  }
  if (x.user_id === null) return;
  const i = d.echantillon.findIndex(
    (y) => y.user_id === null && (memeAction < ECHANTILLON_PAR_ACTION || y.action === x.action),
  );
  if (i >= 0) d.echantillon[i] = x;
}

export function creerAgregatAudit(o: OptionsAgregat = {}): AgregatAudit {
  const fenetre = o.fenetreMs ?? 60_000;
  const max = o.maxCles ?? 1024;
  const maxAnonymes = o.maxClesAnonymes ?? Math.floor(max / 2);
  const maxParSource = o.maxClesParSource ?? 8;
  const maxParSourceEtAction = o.maxClesParSourceEtAction ?? 4;
  const maxParCompte = o.maxClesParCompte ?? 32;
  const maxParAction = o.maxClesParAction ?? 128;
  const ecrire = o.ecrire ?? auditEvent;
  const maintenant = o.maintenant ?? (() => Date.now() / 1000);
  const rafales = new Map<string, Rafale>();
  const compteurs = new Map<string, number>();
  let anonymes = 0;
  const debordements = new Map<string, Debordement>();
  let minuterie: ReturnType<typeof setTimeout> | null = null;

  const armer = (): void => {
    if (minuterie) return;
    minuterie = setTimeout(() => {
      minuterie = null;
      vider();
    }, fenetre);
    minuterie.unref?.();
  };
  const compte = (c: string): number => compteurs.get(c) ?? 0;
  const plus = (c: string): void => {
    compteurs.set(c, compte(c) + 1);
  };

  /** Occurrence non suivie : comptée sous son groupe d'adresses (256 au plus, puis « _other »), par action (20 au plus), compte et échantillon gardés. */
  const deborder = (groupe: string, e: EvenementAudit): void => {
    const cle = debordements.has(groupe) || debordements.size < MAX_GROUPES_DEBORDEMENT ? groupe : AUTRES;
    let d = debordements.get(cle);
    if (d === undefined) {
      d = {
        ip: cle === AUTRES ? null : (e.ip ?? null),
        reseau: cle !== AUTRES && cle !== (e.ip ?? "?") ? cle : null,
        n: 0,
        actions: new Map(),
        comptes: new Set(),
        echantillon: [],
      };
      debordements.set(cle, d);
    }
    d.n += 1;
    const a = d.actions.has(e.action) || d.actions.size < MAX_ACTIONS_DEBORDEMENT ? e.action : AUTRES;
    d.actions.set(a, (d.actions.get(a) ?? 0) + 1);
    const uid = e.userId ?? null;
    if (uid !== null && d.comptes.size < MAX_COMPTES_DEBORDEMENT) d.comptes.add(uid);
    const details = detailsObjet(e.details);
    echantillonner(d, {
      action: e.action,
      user_id: uid,
      ip: e.ip ?? null,
      method: textePropre(details["method"], 16),
      route: textePropre(details["route"], ROUTE_ECHANTILLON_MAX),
    });
  };

  function vider(): void {
    if (minuterie) clearTimeout(minuterie);
    minuterie = null;
    const fenetreS = fenetre / 1000;
    for (const r of rafales.values()) if (r.n) ecrire(resume(r, fenetreS));
    for (const d of debordements.values())
      ecrire({
        userId: null,
        username: null,
        action: "audit.aggregate.overflow",
        outcome: "unknown",
        ip: d.ip,
        details: {
          dropped: d.n,
          actions: Object.fromEntries(d.actions),
          user_ids: [...d.comptes].sort((x, y) => x - y),
          sample: d.echantillon,
          window_s: fenetreS,
          ...(d.reseau === null ? {} : { network: d.reseau }),
        },
      });
    rafales.clear();
    compteurs.clear();
    anonymes = 0;
    debordements.clear();
  }

  return {
    signaler(cle, e) {
      const t = maintenant();
      const r = rafales.get(cle);
      if (r) {
        r.n += 1;
        r.dernier = t;
        armer();
        return;
      }
      const groupe = groupeAdresses(e.ip ?? null);
      const uid = e.userId ?? null;
      const source = `s|${groupe}|${uid ?? "-"}`;
      const sourceAction = `${source}|${e.action}`;
      const parCompte = uid === null ? "" : `u|${uid}`;
      const parAction = `a|${e.action}`;
      const libre =
        rafales.size < max &&
        compte(source) < maxParSource &&
        compte(sourceAction) < maxParSourceEtAction &&
        (uid === null
          ? anonymes < maxAnonymes && compte(parAction) < maxParAction
          : compte(parCompte) < maxParCompte);
      if (libre) {
        rafales.set(cle, { e, n: 0, premier: t, dernier: t });
        plus(source);
        plus(sourceAction);
        if (uid === null) {
          anonymes += 1;
          plus(parAction);
        } else plus(parCompte);
        ecrire(e);
      } else deborder(groupe, e);
      armer();
    },
    vider,
  };
}

/** Lectures d'un admin qui peuvent se répéter (pages d'une recherche) : hors des quotas des refus ; même clé dans la fenêtre comptée, 256 clés suivies, au-delà chaque lecture écrite. */
export function creerLecturesAudit(
  o: Pick<OptionsAgregat, "fenetreMs" | "maxCles" | "ecrire" | "maintenant"> = {},
): AgregatAudit {
  const fenetre = o.fenetreMs ?? 60_000;
  const max = o.maxCles ?? 256;
  const ecrire = o.ecrire ?? auditEvent;
  const maintenant = o.maintenant ?? (() => Date.now() / 1000);
  const lectures = new Map<string, Rafale>();
  let minuterie: ReturnType<typeof setTimeout> | null = null;

  function vider(): void {
    if (minuterie) clearTimeout(minuterie);
    minuterie = null;
    for (const r of lectures.values()) if (r.n) ecrire(resume(r, fenetre / 1000));
    lectures.clear();
  }

  return {
    signaler(cle, e) {
      const t = maintenant();
      const r = lectures.get(cle);
      if (r) {
        r.n += 1;
        r.dernier = t;
        return;
      }
      if (lectures.size < max) lectures.set(cle, { e, n: 0, premier: t, dernier: t });
      ecrire(e);
      if (!minuterie) {
        minuterie = setTimeout(vider, fenetre);
        minuterie.unref?.();
      }
    },
    vider,
  };
}

let commun: AgregatAudit | null = null;
let lectures: AgregatAudit | null = null;

/** Événement d'une rafale possible (refus répétés), agrégé par action et `cle` dans l'agrégat du process ; résumés écrits avant `audit.writer.stop`. */
export function auditRafale(cle: string, e: EvenementAudit): void {
  if (!commun) {
    commun = creerAgregatAudit();
    avantArretAudit(() => commun?.vider());
  }
  commun.signaler(`${e.action}|${cle}`, e);
}

/** Lecture d'un admin (recherche dans le journal) dédupliquée par action et `cle` dans la minute, hors des quotas des refus ; résumés écrits avant `audit.writer.stop`. */
export function auditLecture(cle: string, e: EvenementAudit): void {
  if (!lectures) {
    lectures = creerLecturesAudit();
    avantArretAudit(() => lectures?.vider());
  }
  lectures.signaler(`${e.action}|${cle}`, e);
}

/** Résumés en attente de l'agrégat et des lectures du process écrits tout de suite. */
export function viderRafalesAudit(): void {
  commun?.vider();
  lectures?.vider();
}
