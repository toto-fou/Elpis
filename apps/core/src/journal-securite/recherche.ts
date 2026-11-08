// SPDX-License-Identifier: MIT
/** apps/core/src/journal-securite/recherche.ts — recherche dans le journal de sécurité : fichiers du plus récent au plus ancien lus à rebours par blocs de 64 Kio, filtres, curseur opaque, budget par page. */
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";

import { HttpError } from "@elpis/commun";
import { FICHIER_AUDIT, issueParDefaut, JOUR_AUDIT } from "@elpis/securite";
import type { IssueAudit } from "@elpis/securite";
import type { EvenementJournal, PageJournal as PageJournalContrat } from "@elpis/contracts";

const BLOC = 64 * 1024;
/** Ligne plus longue (octets nuls d'une coupure, ligne forgée) : comptée illisible et sautée, jamais réassemblée. */
export const LIGNE_MAX = 64 * 1024;
export const LIMITE_MAX = 500;
/** Bornes de `Date` en secondes : au-delà, `toISOString` lève. */
const TS_MAX = 8.64e12;

export type IssueFiltre = IssueAudit;

export interface FiltresJournal {
  /** Jours UTC inclus (AAAA-MM-JJ). */
  du: string;
  au: string;
  /** Préfixe d'action (« auth. ») ou action exacte. */
  action?: string | null;
  /** Identifiant exact (chiffres) ou partie du nom, sans casse. */
  utilisateur?: string | null;
  issue?: IssueFiltre | null;
  /** Adresse complète (IPv4 ou IPv6, comparaison exacte) ou son début (« 10.0. »). */
  ip?: string | null;
  service?: string | null;
  /** Texte cherché dans la ligne entière, sans casse. */
  texte?: string | null;
  /** Écarte les marqueurs d'écriture (`audit.writer.*`) sauf si l'action cherchée en est un. */
  sansMarqueurs?: boolean;
}

export type EntreeJournal = EvenementJournal;
export type PageJournal = Omit<PageJournalContrat, "from" | "to">;

export interface OptionsRecherche {
  dossier: string;
  filtres: FiltresJournal;
  limite?: number;
  curseur?: string | null;
  budgetOctets?: number;
  budgetMs?: number;
  /** `false` : chaque ligne lue en entier, sans préfiltre (référence des tests). */
  prefiltre?: boolean;
}

const texteOuNul = (v: unknown): string | null => (typeof v === "string" ? v : null);
const nombreOuNul = (v: unknown): number | null => (typeof v === "number" ? v : null);
const entierOuNul = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);

function issueDe(rec: Record<string, unknown>): IssueFiltre {
  const o = rec["outcome"];
  if (o === "success" || o === "failure" || o === "unknown") return o;
  return issueParDefaut(String(rec["action"] ?? ""));
}

/** Ligne v1 ou v0 rendue sous une forme commune, sans sa signature ; `null` si ce n'est pas un objet. */
export function entreeDepuis(rec: unknown, ref: string): EntreeJournal | null {
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return null;
  const r = rec as Record<string, unknown>;
  const v1 = r["v"] === 1;
  const ts = nombreOuNul(r["ts"]);
  return {
    ref,
    v: v1 ? 1 : 0,
    time:
      texteOuNul(r["time"]) ??
      texteOuNul(r["iso"]) ??
      (ts !== null && Number.isFinite(ts) && Math.abs(ts) <= TS_MAX
        ? new Date(ts * 1000).toISOString()
        : null),
    ts,
    host: texteOuNul(r["host"]),
    service: texteOuNul(r["service"]),
    boot: texteOuNul(r["boot"]),
    seq: entierOuNul(r["seq"]),
    action: String(r["action"] ?? ""),
    outcome: issueDe(r),
    user_id: entierOuNul(r["user_id"]),
    username: texteOuNul(r["username"]),
    ip: texteOuNul(r["ip"]) ?? texteOuNul((r["details"] as Record<string, unknown> | null)?.["ip"]),
    details: r["details"] ?? {},
    signed: typeof r["hmac"] === "string",
    kid: texteOuNul(r["kid"]),
  };
}

/** Prédicat des filtres sur une entrée (la ligne brute sert au filtre de texte). */
export function filtreJournal(f: FiltresJournal): (e: EntreeJournal, brute: string) => boolean {
  const action = f.action?.trim() || null;
  const prefixe = action === null ? "" : action.endsWith(".") ? action : `${action}.`;
  const qui = f.utilisateur?.trim() || null;
  const uid = qui !== null && /^\d+$/u.test(qui) ? Number(qui) : null;
  const nom = qui?.toLowerCase() ?? null;
  const ip = f.ip?.trim() || null;
  const texte = f.texte?.trim().toLowerCase() || null;
  const sansMarqueurs = f.sansMarqueurs === true && !(action ?? "").startsWith("audit.writer");
  return (e, brute) =>
    !(sansMarqueurs && e.action.startsWith("audit.writer.")) &&
    (action === null || e.action === action || e.action.startsWith(prefixe)) &&
    (qui === null ||
      (uid !== null ? e.user_id === uid : (e.username ?? "").toLowerCase().includes(nom ?? ""))) &&
    (!f.issue || e.outcome === f.issue) &&
    (ip === null || (isIP(ip) !== 0 ? e.ip === ip : (e.ip ?? "").startsWith(ip))) &&
    (!f.service || e.service === f.service) &&
    (texte === null || brute.toLowerCase().includes(texte));
}

/** ASCII imprimable sans guillemet ni antislash : tel quel dans la ligne brute quand elle n'a aucun échappement JSON. */
const ASCII_LITTERAL = /^[\x20\x21\x23-\x5b\x5d-\x7e]+$/u;
/** Début possible de `String(x)` d'un nombre, d'un objet ou d'un tableau JSON, absent de la ligne brute. */
const DEBUT_NON_TEXTE = /^[-+.0-9eE]*$|[,[]/u;

/** Valeur de filtre comparée telle quelle à un texte JSON (ASCII littéral), `null` sinon. */
function litteral(v: string | null | undefined): string | null {
  const t = v?.trim() || null;
  return t !== null && ASCII_LITTERAL.test(t) ? t : null;
}

/** Préfiltre de la ligne brute avant JSON.parse : `false` seulement pour une ligne que `filtreJournal` refuserait ; `null` sans préfiltre sûr ; `champs` ajoute action, IP et nom de compte (export). */
export function prefiltreJournal(f: FiltresJournal, champs = false): ((ligne: Buffer) => boolean) | null {
  const texte = f.texte?.trim().toLowerCase() || null;
  const action = champs ? litteral(f.action) : null;
  const sure = action !== null && !DEBUT_NON_TEXTE.test(action) && !"-Infinity".includes(action);
  const exacts = [sure ? action : null, champs ? litteral(f.ip) : null]
    .filter((v) => v !== null)
    .map((v) => Buffer.from(v, "latin1"));
  const qui = champs ? litteral(f.utilisateur) : null;
  const nom = qui !== null && !/^\d+$/u.test(qui) ? qui.toLowerCase() : null;
  if (texte === null && exacts.length === 0 && nom === null) return null;
  return (ligne) => {
    const sansEchappement = (exacts.length > 0 || nom !== null) && !ligne.includes(0x5c);
    if (sansEchappement && exacts.some((o) => !ligne.includes(o))) return false;
    const compte = sansEchappement ? nom : null;
    if (texte === null && compte === null) return true;
    const bas = ligne.toString("utf8").toLowerCase();
    return (texte === null || bas.includes(texte)) && (compte === null || bas.includes(compte));
  };
}

/** Curseur : jour du fichier et position du début de la dernière ligne lue (-1 : fichier entier) ; `saut` : position au milieu d'une ligne trop longue, sautée jusqu'au saut de ligne précédent. */
export function encoderCurseur(jour: string, offset: number, saut = false): string {
  return Buffer.from(JSON.stringify({ j: jour, o: offset, ...(saut ? { s: 1 } : {}) })).toString("base64url");
}

/** Curseur relu et contrôlé ; 400 s'il n'a pas la forme attendue ou sort de la période. */
export function decoderCurseur(
  c: string,
  f: FiltresJournal,
): { jour: string; offset: number; saut: boolean } {
  try {
    const d = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as {
      j?: unknown;
      o?: unknown;
      s?: unknown;
    };
    if (
      typeof d.j === "string" &&
      JOUR_AUDIT.test(d.j) &&
      d.j >= f.du &&
      d.j <= f.au &&
      typeof d.o === "number" &&
      Number.isSafeInteger(d.o) &&
      (d.s === undefined ? d.o >= -1 : d.s === 1 && d.o > 0)
    )
      return { jour: d.j, offset: d.o, saut: d.s === 1 };
  } catch {
    /* rejeté plus bas */
  }
  throw new HttpError(400, "Curseur invalide.");
}

/** Fichiers de la période, du plus récent au plus ancien. */
export async function fichiersDeLaPeriode(dossier: string, du: string, au: string): Promise<string[]> {
  return (await readdir(dossier).catch(() => [] as string[]))
    .filter((n) => {
      const j = FICHIER_AUDIT.exec(n)?.[1];
      return j !== undefined && j >= du && j <= au;
    })
    .sort()
    .reverse();
}

/** Fichier du journal ouvert sans attendre (un FIFO posé à sa place ne bloque pas) ; `null` si ce n'est pas un fichier ordinaire ; lève si l'ouverture échoue. */
export async function ouvrirFichierJournal(chemin: string): Promise<FileHandle | null> {
  const fh = await open(chemin, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if ((await fh.stat()).isFile()) return fh;
  } catch {
    /* fermé plus bas */
  }
  await fh.close();
  return null;
}

async function octetAvant(fh: FileHandle, position: number): Promise<number> {
  const b = Buffer.alloc(1);
  await fh.read(b, 0, 1, position - 1);
  return b[0] ?? 0;
}

const jourDuFichier = (nom: string): string => FICHIER_AUDIT.exec(nom)?.[1] ?? "";

/** Lignes écartées par le préfiltre gardées avant d'être relues (la plus récente lisible d'abord) : `last_ts` reste exact. */
const ECARTEES_MAX = 64;

/** `ts` que la recherche retiendrait de cette ligne (lisible, objet, nombre fini), `null` sinon. */
function tsLisible(ligne: Buffer): number | null {
  try {
    const ts = entreeDepuis(JSON.parse(ligne.toString("utf8")), "")?.ts ?? null;
    return ts !== null && Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

/** Ligne lue (`null` : plus de 64 Kio) ou avancée dans une ligne trop longue (`saut`). */
type Lu = { offset: number; ligne: Buffer | null } | { offset: number; saut: true };

/** Lignes non vides d'un fichier lues à rebours depuis `fin` par blocs de 64 Kio ; une ligne coupée garde ses morceaux en liste, au plus 64 Kio. */
async function* aRebours(
  fh: FileHandle,
  fin: number,
  sauter: boolean,
  compter: (n: number) => void,
): AsyncGenerator<Lu> {
  let pos = fin;
  let morceaux: Buffer[] = [];
  let longueur = 0;
  let enSaut = sauter;
  while (pos > 0) {
    const debut = Math.max(0, pos - BLOC);
    const bloc = Buffer.alloc(pos - debut);
    await fh.read(bloc, 0, bloc.length, debut);
    compter(bloc.length);
    let finL = bloc.length;
    for (;;) {
      const nl = finL > 0 ? bloc.lastIndexOf(0x0a, finL - 1) : -1;
      // Sans saut de ligne avant le début du bloc : la ligne commence dans le bloc précédent.
      if (nl < 0 && debut > 0) break;
      const tranche = bloc.subarray(nl + 1, finL);
      if (enSaut) {
        enSaut = false;
        yield { offset: debut + nl + 1, ligne: null };
      } else if (tranche.length + longueur > 0)
        yield {
          offset: debut + nl + 1,
          ligne:
            tranche.length + longueur > LIGNE_MAX
              ? null
              : morceaux.length
                ? Buffer.concat([tranche, ...morceaux])
                : tranche,
        };
      morceaux = [];
      longueur = 0;
      if (nl < 0) break;
      finL = nl;
    }
    if (debut > 0) {
      if (!enSaut) {
        morceaux.unshift(bloc.subarray(0, finL));
        longueur += finL;
        if (longueur > LIGNE_MAX) {
          enSaut = true;
          morceaux = [];
          longueur = 0;
        }
      }
      if (enSaut) yield { offset: debut, saut: true };
    }
    pos = debut;
  }
}

/** Une page de résultats (les plus récents d'abord) ; reprend au curseur, s'arrête à `limite` lignes ou au budget de lecture ; chaque curseur rendu précède strictement celui reçu. */
export async function chercherJournal(o: OptionsRecherche): Promise<PageJournal> {
  const limite = Math.max(1, Math.min(LIMITE_MAX, o.limite ?? 100));
  const budgetOctets = o.budgetOctets ?? 16 * 1024 * 1024;
  const echeance = Date.now() + (o.budgetMs ?? 250);
  const garde = filtreJournal(o.filtres);
  const avant = o.prefiltre === false ? null : prefiltreJournal(o.filtres);
  const depart = o.curseur ? decoderCurseur(o.curseur, o.filtres) : null;
  const page: PageJournal = {
    events: [],
    cursor: null,
    scanned_bytes: 0,
    budget_reached: false,
    unreadable: 0,
    last_ts: null,
  };
  let ecartees: Buffer[] = [];
  const relire = (): void => {
    for (let i = ecartees.length - 1; i >= 0; i--) {
      const ts = tsLisible(ecartees[i] as Buffer);
      if (ts !== null) {
        page.last_ts = ts;
        break;
      }
    }
    ecartees = [];
  };
  const rendre = (): PageJournal => {
    relire();
    return page;
  };
  const epuise = (): boolean => page.scanned_bytes >= budgetOctets || Date.now() >= echeance;
  const compter = (n: number): void => {
    page.scanned_bytes += n;
  };
  const noms = (await fichiersDeLaPeriode(o.dossier, o.filtres.du, o.filtres.au)).filter(
    (n) => depart === null || jourDuFichier(n) <= depart.jour,
  );
  for (const [i, nom] of noms.entries()) {
    const jour = jourDuFichier(nom);
    let fh: FileHandle | null;
    try {
      fh = await ouvrirFichierJournal(join(o.dossier, nom));
    } catch {
      continue;
    }
    if (fh === null) continue;
    try {
      const taille = (await fh.stat()).size;
      let pos = taille;
      let sauter = false;
      if (depart && jour === depart.jour && depart.offset >= 0) {
        if (
          depart.offset > taille ||
          (!depart.saut && depart.offset > 0 && (await octetAvant(fh, depart.offset)) !== 0x0a)
        )
          throw new HttpError(400, "Curseur invalide.");
        pos = depart.offset;
        sauter = depart.saut;
      }
      for await (const lu of aRebours(fh, pos, sauter, compter)) {
        if ("saut" in lu) {
          if (epuise()) {
            page.budget_reached = true;
            page.cursor = encoderCurseur(jour, lu.offset, true);
            return rendre();
          }
          continue;
        }
        if (lu.ligne !== null && avant !== null && !avant(lu.ligne)) {
          ecartees.push(lu.ligne);
          if (ecartees.length >= ECARTEES_MAX) relire();
        } else {
          let e: EntreeJournal | null = null;
          let brute = "";
          if (lu.ligne !== null) {
            brute = lu.ligne.toString("utf8");
            try {
              e = entreeDepuis(JSON.parse(brute), `${jour}:${lu.offset}`);
            } catch {
              /* ligne illisible : ignorée par la recherche, signalée par la vérification */
            }
          }
          if (e !== null && e.ts !== null && Number.isFinite(e.ts)) {
            page.last_ts = e.ts;
            ecartees = [];
          }
          if (e === null) page.unreadable += 1;
          else if (garde(e, brute)) {
            page.events.push(e);
            if (page.events.length >= limite) {
              page.cursor = encoderCurseur(jour, lu.offset);
              return rendre();
            }
          }
        }
        if (lu.offset > 0 && epuise()) {
          page.budget_reached = true;
          page.cursor = encoderCurseur(jour, lu.offset);
          return rendre();
        }
      }
    } finally {
      await fh.close();
    }
    const suivant = noms[i + 1];
    if (suivant !== undefined && epuise()) {
      page.budget_reached = true;
      page.cursor = encoderCurseur(jourDuFichier(suivant), -1);
      return rendre();
    }
  }
  return rendre();
}
