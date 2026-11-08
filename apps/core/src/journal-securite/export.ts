// SPDX-License-Identifier: MIT
/** apps/core/src/journal-securite/export.ts — export du journal de sécurité dans l'ordre chronologique : JSONL brut (copie à l'octet sans filtre, lignes signées vérifiables) ou CSV sans formule, lu en flux et interrompu à la coupure. */
import { join } from "node:path";

import { sansFormule } from "@elpis/commun";
import { FICHIER_AUDIT } from "@elpis/securite";

import {
  entreeDepuis,
  fichiersDeLaPeriode,
  filtreJournal,
  LIGNE_MAX,
  ouvrirFichierJournal,
  prefiltreJournal,
} from "./recherche";
import type { EntreeJournal, FiltresJournal } from "./recherche";

export type FormatExport = "jsonl" | "csv";

const COLONNES = [
  "time",
  "host",
  "service",
  "boot",
  "seq",
  "action",
  "outcome",
  "user_id",
  "username",
  "ip",
  "details",
  "signed",
] as const;

function champ(v: unknown): string {
  const texte = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return `"${sansFormule(v, texte).replaceAll('"', '""')}"`;
}

function ligneCsv(e: EntreeJournal): string {
  return `${COLONNES.map((c) => champ(e[c])).join(",")}\r\n`;
}

const BLOC = 64 * 1024;

/** Lecture en flux d'un fichier du journal ouvert sans attendre ; lève si ce n'est pas un fichier ordinaire (FIFO, périphérique). */
async function fluxDuFichier(chemin: string, signal?: AbortSignal): Promise<AsyncIterable<unknown>> {
  const fh = await ouvrirFichierJournal(chemin);
  if (fh === null) throw new Error(`${chemin} : pas un fichier ordinaire`);
  return fh.createReadStream({ highWaterMark: BLOC, ...(signal ? { signal } : {}) });
}

/** Lignes non vides d'un fichier en octets bruts, lues en flux (une signature porte sur les octets écrits) ; `null` : ligne de plus de 64 Kio, jamais réassemblée. */
async function* lignes(
  chemin: string,
  signal?: AbortSignal,
): AsyncGenerator<{ debut: number; ligne: Buffer | null }> {
  let base = 0;
  let debutLigne = 0;
  let morceaux: Buffer[] = [];
  let longueur = 0;
  let trop = false;
  for await (const m of await fluxDuFichier(chemin, signal)) {
    const t = m as Buffer;
    let d = 0;
    for (let i = t.indexOf(0x0a); i !== -1; i = t.indexOf(0x0a, d)) {
      const tranche = t.subarray(d, i);
      const total = longueur + tranche.length;
      if (total > 0 || trop)
        yield {
          debut: debutLigne,
          ligne:
            trop || total > LIGNE_MAX
              ? null
              : morceaux.length
                ? Buffer.concat([...morceaux, tranche])
                : tranche,
        };
      morceaux = [];
      longueur = 0;
      trop = false;
      d = i + 1;
      debutLigne = base + d;
    }
    if (d < t.length && !trop) {
      morceaux.push(t.subarray(d));
      longueur += t.length - d;
      if (longueur > LIGNE_MAX) {
        trop = true;
        morceaux = [];
        longueur = 0;
      }
    }
    base += t.length;
  }
  if (longueur > 0 || trop) yield { debut: debutLigne, ligne: trop ? null : Buffer.concat(morceaux) };
}

export interface BilanExport {
  lignes: number;
  /** Fichiers illisibles ou lus en partie (purgés ou disparus pendant l'export). */
  sautes: string[];
}

const sansFiltre = (f: FiltresJournal): boolean =>
  [f.action, f.utilisateur, f.issue, f.ip, f.service, f.texte].every((v) => !v?.trim());

function sautsDeLigne(t: Buffer): number {
  let n = 0;
  for (let i = t.indexOf(0x0a); i !== -1; i = t.indexOf(0x0a, i + 1)) n += 1;
  return n;
}

/** JSONL sans filtre : fichiers copiés à l'octet, lignes vides ou illisibles comprises (une ligne altérée reste visible à la vérification) ; dans le fichier du jour, la ligne en cours d'écriture n'est pas copiée. */
async function* copieBrute(
  dossier: string,
  noms: string[],
  bilan: BilanExport,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const aujourdhui = new Date().toISOString().slice(0, 10);
  for (const nom of noms) {
    if (signal?.aborted) return;
    let dernier = 0x0a;
    const enCours = FICHIER_AUDIT.exec(nom)?.[1] === aujourdhui;
    let retenu: Buffer = Buffer.alloc(0);
    try {
      for await (const m of await fluxDuFichier(join(dossier, nom), signal)) {
        let t = m as Buffer;
        if (enCours) {
          // Fin sans saut de ligne retenue jusqu'au morceau suivant ; au-delà de 64 Kio ce n'est pas une ligne en cours.
          if (retenu.length) t = Buffer.concat([retenu, t]);
          const nl = t.lastIndexOf(0x0a);
          retenu = t.subarray(nl + 1);
          t = t.subarray(0, nl + 1);
          if (retenu.length > LIGNE_MAX) {
            t = Buffer.concat([t, retenu]);
            retenu = Buffer.alloc(0);
          }
          if (!t.length) continue;
        }
        bilan.lignes += sautsDeLigne(t);
        dernier = t[t.length - 1] ?? dernier;
        yield t;
      }
    } catch {
      if (signal?.aborted) return;
      bilan.sautes.push(nom);
    }
    // Fichier sans saut de ligne final (écriture coupée) : sa dernière ligne ne se colle pas à la suivante.
    if (dernier !== 0x0a) {
      bilan.lignes += 1;
      yield Buffer.from("\n");
    }
  }
}

/** Morceaux de l'export (au plus 64 Kio à la fois), dans l'ordre chronologique ; s'arrête dès que `signal` est levé ; `bilan` compte les lignes rendues et les fichiers sautés. */
export async function* exporterJournal(
  dossier: string,
  filtres: FiltresJournal,
  format: FormatExport,
  bilan: BilanExport = { lignes: 0, sautes: [] },
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  // Premier morceau tout de suite : les en-têtes partent avant la première ligne trouvée.
  yield Buffer.from(format === "csv" ? `${COLONNES.join(",")}\r\n` : "");
  const noms = (await fichiersDeLaPeriode(dossier, filtres.du, filtres.au)).reverse();
  if (format === "jsonl" && sansFiltre(filtres)) {
    yield* copieBrute(dossier, noms, bilan, signal);
    return;
  }
  const garde = filtreJournal(filtres);
  const avant = prefiltreJournal(filtres, true);
  for (const nom of noms) {
    if (signal?.aborted) return;
    const jour = FICHIER_AUDIT.exec(nom)?.[1] ?? "";
    let lot: Buffer[] = [];
    let taille = 0;
    const it = lignes(join(dossier, nom), signal);
    try {
      for (;;) {
        let r: IteratorResult<{ debut: number; ligne: Buffer | null }>;
        // Seules l'ouverture et la lecture peuvent échouer : le fichier est alors signalé, la suite continue.
        try {
          r = await it.next();
        } catch {
          if (signal?.aborted) return;
          bilan.sautes.push(nom);
          break;
        }
        if (r.done) break;
        if (signal?.aborted) return;
        const { debut, ligne } = r.value;
        if (ligne === null || (avant !== null && !avant(ligne))) continue;
        const texte = ligne.toString("utf8");
        let rec: unknown = null;
        try {
          rec = JSON.parse(texte);
        } catch {
          continue;
        }
        const e = entreeDepuis(rec, `${jour}:${debut}`);
        if (e === null || !garde(e, texte)) continue;
        const sortie =
          format === "jsonl" ? Buffer.concat([ligne, Buffer.from("\n")]) : Buffer.from(ligneCsv(e));
        lot.push(sortie);
        taille += sortie.length;
        bilan.lignes += 1;
        if (taille >= BLOC) {
          yield Buffer.concat(lot);
          lot = [];
          taille = 0;
        }
      }
    } finally {
      await it.return(undefined);
    }
    if (lot.length) yield Buffer.concat(lot);
  }
}
