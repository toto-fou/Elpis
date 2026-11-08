// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-audit.ts — console › journal de sécurité (admins seulement) : recherche, export, vérification d'intégrité ; conservation, gel et centralisation attendue. */
import { randomBytes } from "node:crypto";
import { finished, Readable } from "node:stream";

import { estInterSite } from "@elpis/auth";
import { estDict, FlottantPy, HttpError, poserCle } from "@elpis/commun";
import { sousVerrouConfigJson, writeConfigJson } from "@elpis/config";
import { corpsJsonValeurs, entrees, py } from "@elpis/http";
import { cleAuditCourante, etatEcritureAudit, JOUR_AUDIT, verifierJournalAudit } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import { lireConfigPourEcrire } from "../admin/aides";
import { sectionDict } from "../admin/securite";
import { auditerLecture, auditerRequete } from "../journal-securite/auditer";
import { etatJournalSecurite, oublierEtatJournal } from "../journal-securite/etat";
import { exporterJournal } from "../journal-securite/export";
import type { BilanExport, FormatExport } from "../journal-securite/export";
import { chercherJournal } from "../journal-securite/recherche";
import type { FiltresJournal, IssueFiltre } from "../journal-securite/recherche";
import {
  CHAMPS_REGLAGES,
  ecrireTemoinGel,
  ecrireTemoinReglages,
  lireReglagesJournal,
  reglagesAvecTemoin,
  RETENTION_DEFAUT,
  RETENTION_MAX,
  RETENTION_MIN,
  validerReglagesJournal,
  vueReglages,
} from "../journal-securite/reglages";
import type { ReglagesJournal, ReglagesJournalLus } from "../journal-securite/reglages";
import type { Journal } from "../journal";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { exigerLectureConsole } from "./garde-console";

export interface DependancesAdminAudit {
  readonly journal: Journal;
}

function route(methode: "GET" | "PUT" | "POST", chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode, chemin, processus: ["admin"], acces: "admin", traiter };
}

const PERIODE_MAX_JOURS = 1100;
const EXPORT_MAX_JOURS = 366;
const RECHERCHES_MAX = 2;
const EXPORTS_MAX = 2;
const LISTE_MAX = 100;
const ISSUES: readonly string[] = ["success", "failure", "unknown"];
const SANS_CACHE = { "cache-control": "no-store" };
const TEST_INTERVALLE_MS = 10_000;
/** Export sans un octet lu ni écrit pendant ce délai : connexion coupée, créneau rendu. */
const EXPORT_INACTIF_MS = 60_000;
let recherches = 0;
let exportsEnCours = 0;
let verification = false;
let dernierTest = 0;

const jourUtc = (t: number): string => new Date(t).toISOString().slice(0, 10);
/** Jour AAAA-MM-JJ réel (aller-retour par Date : ni 2026-13-01 ni 2026-02-31). */
const jourValide = (j: string): boolean =>
  JOUR_AUDIT.test(j) &&
  !Number.isNaN(Date.parse(j)) &&
  new Date(Date.parse(j)).toISOString().slice(0, 10) === j;
const lignesEnCause = (l: readonly { fichier: string; ligne: number }[]): { file: string; line: number }[] =>
  l.slice(0, LISTE_MAX).map((x) => ({ file: x.fichier, line: x.ligne }));
const ecartJours = (du: string, au: string): number => (Date.parse(au) - Date.parse(du)) / 86_400_000;

/** 400 sur une date invalide, une période inversée ou de `max` jours ou plus (les bornes absentes ne sont pas contrôlées). */
function controlerPeriode(du: string | null, au: string | null, max: number): void {
  if ((du !== null && !jourValide(du)) || (au !== null && !jourValide(au)))
    throw new HttpError(400, "Dates attendues au format AAAA-MM-JJ.");
  if (du === null || au === null) return;
  if (du > au) throw new HttpError(400, "La date de début suit la date de fin.");
  if (ecartJours(du, au) >= max) throw new HttpError(400, `Période de ${max} jours au plus.`);
}

/** Filtres lus dans la query : période (7 derniers jours par défaut), action, compte, résultat, IP, service, texte ; 400 sur une date invalide. */
function lireFiltres(req: FastifyRequest, maxJours: number): FiltresJournal {
  const { query } = entrees(req, {
    query: {
      from: py.str().defaut(""),
      to: py.str().defaut(""),
      action: py.str().defaut(""),
      user: py.str().defaut(""),
      outcome: py.str().defaut(""),
      ip: py.str().defaut(""),
      service: py.str().defaut(""),
      q: py.str().defaut(""),
    },
  });
  const au = query.to || jourUtc(Date.now());
  const du = query.from || (jourValide(au) ? jourUtc(Date.parse(au) - 6 * 86_400_000) : "");
  controlerPeriode(du, au, maxJours);
  if (query.outcome && !ISSUES.includes(query.outcome)) throw new HttpError(400, "Résultat inconnu.");
  return {
    du,
    au,
    action: query.action.slice(0, 120) || null,
    utilisateur: query.user.slice(0, 120) || null,
    issue: (query.outcome || null) as IssueFiltre | null,
    ip: query.ip.slice(0, 64) || null,
    service: query.service.slice(0, 40) || null,
    texte: query.q.slice(0, 200) || null,
  };
}

/** Filtres actifs, pour l'audit d'un export (sans la période, déjà portée à part). */
function filtresActifs(f: FiltresJournal): Record<string, string> {
  const actifs: Record<string, string> = {};
  for (const [cle, v] of Object.entries({
    action: f.action,
    user: f.utilisateur,
    outcome: f.issue,
    ip: f.ip,
    service: f.service,
    q: f.texte,
    exclude_markers: f.sansMarqueurs ? "1" : null,
  }))
    if (v) actifs[cle] = v;
  return actifs;
}

/** Lecture du journal sous le plafond de deux recherches à la fois (page Audit et `audit-recent`) : 429 au-delà. */
export async function rechercheSousPlafond<T>(lire: () => Promise<T>): Promise<T> {
  if (recherches >= RECHERCHES_MAX)
    throw new HttpError(429, "Deux recherches sont déjà en cours, réessayez dans un instant.", {
      "Retry-After": "1",
    });
  recherches += 1;
  try {
    return await lire();
  } finally {
    recherches -= 1;
  }
}

async function rechercher(req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
  exigerLectureConsole(req);
  const filtres = lireFiltres(req, PERIODE_MAX_JOURS);
  const { query } = entrees(req, {
    query: { limit: py.int().defaut(100), cursor: py.str().defaut(""), exclude_markers: py.str().defaut("") },
  });
  if (query.exclude_markers === "1") filtres.sansMarqueurs = true;
  const page = await rechercheSousPlafond(() =>
    chercherJournal({
      dossier: etatEcritureAudit().dossier,
      filtres,
      limite: query.limit,
      curseur: query.cursor || null,
    }),
  );
  // Chaque page tracée, après coup pour rester hors de ses résultats ; clé sans le curseur : les pages d'une même recherche sont comptées.
  const actifs = filtresActifs(filtres);
  auditerLecture(req, "admin.audit.search", `events|${filtres.du}|${filtres.au}|${JSON.stringify(actifs)}`, {
    from: filtres.du,
    to: filtres.au,
    filters: actifs,
  });
  void rep.headers(SANS_CACHE);
  return { ...page, from: filtres.du, to: filtres.au };
}

/** Export en flux (POST, sous la garde CSRF ; deux à la fois) : refusé sans trace écrite ; arrêté à la coupure du client ou après 60 s d'inactivité. */
async function exporter(req: FastifyRequest, rep: FastifyReply, journal: Journal): Promise<FastifyReply> {
  if (estInterSite(req.headers)) throw new HttpError(403, "Export refusé : requête venue d'un autre site.");
  const filtres = lireFiltres(req, EXPORT_MAX_JOURS);
  const { query } = entrees(req, { query: { format: py.str().defaut("csv") } });
  if (query.format !== "csv" && query.format !== "jsonl") throw new HttpError(400, "Format csv ou jsonl.");
  const format: FormatExport = query.format;
  if (exportsEnCours >= EXPORTS_MAX)
    throw new HttpError(429, "Deux exports sont déjà en cours, réessayez dans un instant.", {
      "Retry-After": "5",
    });
  const echecsAvant = etatEcritureAudit().echecs;
  auditerRequete(req, "admin.audit.export", {
    from: filtres.du,
    to: filtres.au,
    format,
    filters: filtresActifs(filtres),
  });
  if (etatEcritureAudit().echecs > echecsAvant)
    throw new HttpError(503, "Trace de l'export non écrite dans le journal de sécurité : export refusé.");
  exportsEnCours += 1;
  let libre = false;
  const liberer = (): void => {
    if (!libre) {
      libre = true;
      exportsEnCours -= 1;
    }
  };
  const arret = new AbortController();
  // `finished` rappelle aussi une réponse déjà fermée (client parti pendant les gardes) : le créneau ne fuit pas.
  finished(rep.raw, () => {
    if (!rep.raw.writableEnded) arret.abort();
    liberer();
  });
  try {
    rep.raw.setTimeout(EXPORT_INACTIF_MS, () => rep.raw.destroy());
  } catch {
    /* réponse sans socket (tests par injection) */
  }
  const dossier = etatEcritureAudit().dossier;
  const bilan: BilanExport = { lignes: 0, sautes: [] };
  async function* flux(): AsyncGenerator<Buffer> {
    try {
      yield* exporterJournal(dossier, filtres, format, bilan, arret.signal);
      if (bilan.sautes.length)
        journal.warn(
          `[audit] export du journal de sécurité incomplet : ${bilan.sautes.length} fichier(s) illisible(s) (${bilan.sautes.slice(0, 5).join(", ")})`,
        );
    } finally {
      liberer();
    }
  }
  const nom = `elpis-audit_${filtres.du}_${filtres.au}.${format}`;
  return rep
    .headers({ ...SANS_CACHE, "content-disposition": `attachment; filename="${nom}"` })
    .type(format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson")
    .send(Readable.from(flux()));
}

/** Vérification des signatures et de la continuité sur la période (une à la fois), listes d'anomalies bornées à 100. */
async function verifier(req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
  let corps: unknown;
  try {
    corps = corpsJsonValeurs(req);
  } catch {
    corps = null;
  }
  const lu = estDict(corps) ? corps : {};
  const du = typeof lu["from"] === "string" && lu["from"] ? lu["from"] : null;
  const au = typeof lu["to"] === "string" && lu["to"] ? lu["to"] : null;
  controlerPeriode(du, au, PERIODE_MAX_JOURS);
  if (verification) throw new HttpError(429, "Une vérification est déjà en cours.", { "Retry-After": "2" });
  verification = true;
  // Client parti : la vérification s'arrête au fichier suivant au lieu de relire tout le journal.
  const arret = new AbortController();
  const cesser = finished(rep.raw, () => {
    if (!rep.raw.writableEnded) arret.abort();
  });
  try {
    const cle = cleAuditCourante();
    const r = await verifierJournalAudit({
      dossier: etatEcritureAudit().dossier,
      du,
      au,
      cles: cle ? [cle] : [],
      signal: arret.signal,
    });
    auditerRequete(req, "admin.audit.verify", {
      from: du,
      to: au,
      status: r.statut,
      intact: r.integre,
      lines: r.lignes,
    });
    const t = r.totaux;
    return {
      from: du,
      to: au,
      status: r.statut,
      intact: r.integre,
      key_available: cle !== null,
      files: r.fichiers.length,
      first_file: r.fichiers[0] ?? null,
      last_file: r.fichiers.at(-1) ?? null,
      lines: r.lignes,
      v0_lines: r.v0,
      signed: r.signees,
      valid: r.valides,
      unsigned: r.sansSignature,
      unknown_key: r.cleInconnue,
      invalid_signatures: lignesEnCause(r.signaturesInvalides),
      unreadable: lignesEnCause(r.illisibles),
      gaps: r.trous.slice(0, LISTE_MAX).map((x) => ({
        file: x.fichier,
        line: x.ligne,
        host: x.hote,
        service: x.service,
        boot: x.boot,
        from: x.de,
        to: x.a,
        kind: x.nature,
      })),
      out_of_order: lignesEnCause(r.desordres),
      unverified: lignesEnCause(r.nonVerifiees),
      inconsistent: lignesEnCause(r.incoherences),
      misplaced: lignesEnCause(r.horsFichier),
      duplicates: lignesEnCause(r.doublons),
      writers: r.ecrivains.length,
      writers_without_stop: r.ecrivains.filter((e) => !e.arretPropre).length,
      uncertain_ends: r.finsIncertaines.slice(0, LISTE_MAX).map((f) => ({
        host: f.hote,
        service: f.service,
        boot: f.boot,
        last_ts: f.dernierTs,
        reason: f.raison,
      })),
      reasons: r.motifs.slice(0, LISTE_MAX).map((m) => ({
        kind: m.nature,
        host: m.hote,
        service: m.service,
        last_ts: m.dernierTs,
        text: m.texte,
      })),
      totals: {
        invalid_signatures: t.signaturesInvalides,
        unreadable: t.illisibles,
        gaps: t.trous,
        out_of_order: t.desordres,
        unverified: t.nonVerifiees,
        inconsistent: t.incoherences,
        misplaced: t.horsFichier,
        late_v0: t.v0Tardives,
        duplicates: t.doublons,
      },
    };
  } catch (e) {
    if (arret.signal.aborted) throw new HttpError(499, "Vérification interrompue.");
    throw e;
  } finally {
    cesser();
    verification = false;
  }
}

function vue(r: ReglagesJournalLus): Record<string, unknown> {
  return { ...vueReglages(r), bounds: { min: RETENTION_MIN, max: RETENTION_MAX, default: RETENTION_DEFAUT } };
}

/** Événement de test (nonce aléatoire) à retrouver dans le collecteur ; un toutes les 10 s au plus. */
async function ecrireTest(req: FastifyRequest): Promise<unknown> {
  const t = Date.now();
  if (t - dernierTest < TEST_INTERVALLE_MS)
    throw new HttpError(429, "Un événement de test vient d'être écrit, réessayez dans quelques secondes.", {
      "Retry-After": "10",
    });
  dernierTest = t;
  const nonce = randomBytes(8).toString("hex");
  auditerRequete(req, "audit.test", { nonce });
  return { ok: true, nonce, ts: t / 1000 };
}

export function creerFamilleAdminAudit(dep: DependancesAdminAudit): Famille {
  /** Réglages relus et réécrits sous le verrou de config.json ; chaque changement est audité (avant, après). */
  async function ecrire(req: FastifyRequest): Promise<Record<string, unknown>> {
    const corps = corpsJsonValeurs(req);
    const dossier = etatEcritureAudit().dossier;
    const [avant, apres, brut] = await sousVerrouConfigJson(
      (): [ReglagesJournal, ReglagesJournal, unknown] => {
        const cfg = lireConfigPourEcrire();
        const securite = sectionDict(cfg, "security");
        const section = securite["audit"];
        const lus = reglagesAvecTemoin(section, dossier);
        // Durée illisible sur disque : un PUT d'un autre champ ne la remplace pas en silence par la valeur par défaut.
        if (lus.invalide && !(estDict(corps) && Object.hasOwn(corps, "retention_days")))
          throw new HttpError(
            400,
            "La durée de conservation écrite dans config.json est illisible : fixez-la dans ce même enregistrement.",
          );
        const nouveaux = validerReglagesJournal(corps, lus);
        poserCle(securite, "audit", { ...nouveaux });
        writeConfigJson(cfg);
        const valeur = estDict(section) ? section["retention_days"] : undefined;
        return [lus, nouveaux, valeur instanceof FlottantPy ? valeur.valeur : valeur];
      },
    );
    if (!ecrireTemoinGel(dossier, apres.hold ? apres.hold_reason : null))
      dep.journal.warn(`[audit] témoin de gel non ${apres.hold ? "posé" : "retiré"} dans ${dossier}`);
    if (!ecrireTemoinReglages(dossier, apres))
      dep.journal.warn(`[audit] témoin des réglages non écrit dans ${dossier}`);
    // Valeur écrite à la main (texte, flottant…) normalisée par ce PUT : sa forme d'origine est gardée dans la trace.
    const normalisee = brut !== undefined && brut !== avant.retention_days;
    const changes = CHAMPS_REGLAGES.filter(
      (k) => avant[k] !== apres[k] || (k === "retention_days" && normalisee),
    ).map((k) => ({
      field: k,
      before: k === "retention_days" && normalisee ? brut : avant[k],
      after: apres[k],
    }));
    if (changes.length) {
      auditerRequete(req, "admin.audit.settings", { changes });
      dep.journal.info(
        `[audit] réglages du journal de sécurité modifiés par uid=${String(req.utilisateur?.id)} : ${changes.map((c) => c.field).join(", ")}`,
      );
    }
    oublierEtatJournal();
    return vue(lireReglagesJournal(dossier));
  }

  return {
    nom: "admin-audit",
    routes: [
      route("GET", "/api/admin/audit/status", async (_req, rep) => {
        void rep.headers(SANS_CACHE);
        // Réglages relus à chaque appel : s'ils ont changé sur disque (édition de config.json), l'état gardé est recalculé.
        const gardes = await etatJournalSecurite();
        const r = lireReglagesJournal(etatEcritureAudit().dossier);
        const vu: Record<string, unknown> = vueReglages(r);
        const perime = Object.entries(vu).some(
          ([k, v]) => (gardes.retention as Record<string, unknown>)[k] !== v,
        );
        if (!perime) return gardes;
        oublierEtatJournal();
        return etatJournalSecurite();
      }),
      route("POST", "/api/admin/audit/test", ecrireTest),
      route("GET", "/api/admin/audit/events", rechercher),
      route("POST", "/api/admin/audit/export", (req, rep) => exporter(req, rep, dep.journal)),
      route("POST", "/api/admin/audit/verify", verifier),
      route("GET", "/api/admin/audit/settings", async () =>
        vue(lireReglagesJournal(etatEcritureAudit().dossier)),
      ),
      route("PUT", "/api/admin/audit/settings", ecrire),
    ],
  };
}
