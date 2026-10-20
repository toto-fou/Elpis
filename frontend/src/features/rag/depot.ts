// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/depot.ts — page RAG, dépôt de fichiers : lecture des fichiers et dossiers glissés, refus avant envoi, lots de 1000 fichiers, corps multipart, bilan par fichier. */
import { EXTENSIONS_RAG, FICHIERS_PAR_DEPOT_RAG_MAX } from "@elpis/contracts";
import type { ResultatDepotRag } from "@elpis/contracts";

import { formaterQuotaMo } from "./format";

/** Un fichier à déposer et son chemin logique (`dossier/sous/a.pdf` pour un dossier). */
export interface FichierADeposer {
  file: File;
  chemin: string;
}

/** Plafond d'octets d'un envoi : au-delà, le dépôt part en plusieurs requêtes. */
export const OCTETS_PAR_LOT = 200 * 1024 * 1024;

const SYSTEME = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

export function extensionDe(nom: string): string {
  const i = nom.lastIndexOf(".");
  return i < 0 ? "" : nom.slice(i + 1).toLowerCase();
}

function nomDeFichier(chemin: string): string {
  return chemin.slice(chemin.lastIndexOf("/") + 1);
}

/** Fichier caché ou de bureau (`.DS_Store`, `Thumbs.db`), laissé de côté sans bruit. */
export function estFichierIgnore(chemin: string): boolean {
  return (
    chemin.split("/").some((segment) => segment.startsWith(".")) ||
    SYSTEME.has(nomDeFichier(chemin).toLowerCase())
  );
}

/** Entrées d'un sélecteur de fichiers ou de dossier : le chemin relatif du dossier choisi, sinon le nom. */
export function depuisSelecteur(fichiers: Iterable<File>): FichierADeposer[] {
  return [...fichiers].map((file) => ({ file, chemin: file.webkitRelativePath || file.name }));
}

export interface DepotPrepare {
  aEnvoyer: FichierADeposer[];
  refus: ResultatDepotRag[];
  ignores: number;
}

function refus(chemin: string, code: string, message: string): ResultatDepotRag {
  return { name: chemin, status: "refuse", code, message };
}

/** Écarte ce que le serveur refuserait de toute façon (extension, vide, trop gros) pour ne pas l'envoyer. */
export function preparerDepot(entrees: readonly FichierADeposer[], fileMb: number): DepotPrepare {
  const aEnvoyer: FichierADeposer[] = [];
  const refuses: ResultatDepotRag[] = [];
  let ignores = 0;
  const plafond = fileMb > 0 ? fileMb * 1024 * 1024 : Number.POSITIVE_INFINITY;
  for (const e of entrees) {
    if (estFichierIgnore(e.chemin)) {
      ignores++;
      continue;
    }
    const ext = extensionDe(e.chemin);
    if (!(EXTENSIONS_RAG as readonly string[]).includes(ext)) {
      refuses.push(
        refus(
          e.chemin,
          "extension_refusee",
          ext === "" ? "Type de fichier inconnu" : `Format .${ext} non pris en charge`,
        ),
      );
    } else if (e.file.size === 0) {
      refuses.push(refus(e.chemin, "fichier_vide", "Fichier vide"));
    } else if (e.file.size > plafond) {
      refuses.push(refus(e.chemin, "fichier_trop_gros", `Dépasse ${formaterQuotaMo(fileMb)} par fichier`));
    } else aEnvoyer.push(e);
  }
  return { aEnvoyer, refus: refuses, ignores };
}

/** Découpe en envois d'au plus 1000 fichiers et `maxOctets` octets (un fichier seul passe toujours). */
export function decouperEnLots(
  fichiers: readonly FichierADeposer[],
  maxFichiers: number = FICHIERS_PAR_DEPOT_RAG_MAX,
  maxOctets: number = OCTETS_PAR_LOT,
): FichierADeposer[][] {
  const lots: FichierADeposer[][] = [];
  let courant: FichierADeposer[] = [];
  let octets = 0;
  for (const f of fichiers) {
    if (courant.length > 0 && (courant.length >= maxFichiers || octets + f.file.size > maxOctets)) {
      lots.push(courant);
      courant = [];
      octets = 0;
    }
    courant.push(f);
    octets += f.file.size;
  }
  if (courant.length > 0) lots.push(courant);
  return lots;
}

/** Corps multipart d'un lot : le nom de fichier de chaque partie est son chemin logique. */
export function corpsDepot(lot: readonly FichierADeposer[]): FormData {
  const fd = new FormData();
  for (const { file, chemin } of lot) fd.append("files", file, chemin);
  return fd;
}

export interface BilanDepot {
  ajoutes: number;
  remplaces: number;
  dejaPresents: number;
  refuses: number;
}

export function bilanDepot(resultats: readonly ResultatDepotRag[]): BilanDepot {
  const b: BilanDepot = { ajoutes: 0, remplaces: 0, dejaPresents: 0, refuses: 0 };
  for (const r of resultats) {
    if (r.status === "ajoute") b.ajoutes++;
    else if (r.status === "remplace") b.remplaces++;
    else if (r.status === "deja_present") b.dejaPresents++;
    else b.refuses++;
  }
  return b;
}

/** Bilan en une phrase : « 12 ajoutés · 2 remplacés · 3 déjà présents · 1 refusé ». */
export function phraseBilan(b: BilanDepot): string {
  const parts: string[] = [];
  if (b.ajoutes > 0) parts.push(`${b.ajoutes} ${b.ajoutes > 1 ? "ajoutés" : "ajouté"}`);
  if (b.remplaces > 0) parts.push(`${b.remplaces} ${b.remplaces > 1 ? "remplacés" : "remplacé"}`);
  if (b.dejaPresents > 0)
    parts.push(`${b.dejaPresents} ${b.dejaPresents > 1 ? "déjà présents" : "déjà présent"}`);
  if (b.refuses > 0) parts.push(`${b.refuses} ${b.refuses > 1 ? "refusés" : "refusé"}`);
  return parts.join(" · ");
}

export function libelleResultat(r: ResultatDepotRag): string {
  switch (r.status) {
    case "ajoute":
      return "Ajouté";
    case "remplace":
      return "Remplacé";
    case "deja_present":
      return "Déjà présent";
    case "refuse":
      return "Refusé";
  }
}

/** Nom proposé pour une collection créée par un dépôt : le dossier déposé, sinon « Mes documents ». */
export function nomProposeCollection(entrees: readonly FichierADeposer[]): string {
  const dossiers = new Set<string>();
  let isoles = 0;
  for (const e of entrees) {
    const i = e.chemin.indexOf("/");
    if (i > 0) dossiers.add(e.chemin.slice(0, i));
    else isoles++;
  }
  const un = [...dossiers][0];
  return dossiers.size === 1 && isoles === 0 && un !== undefined ? un.slice(0, 80) : "Mes documents";
}

/* Lecture d'un glisser-déposer : les dossiers passent par l'API d'entrées (FileSystemEntry). */

interface EntreeSysteme {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
  file?: (ok: (f: File) => void, ko: (e: unknown) => void) => void;
  createReader?: () => { readEntries(ok: (e: EntreeSysteme[]) => void, ko: (e: unknown) => void): void };
}

/** Garde-fou contre un dossier monstrueux : au-delà, la lecture s'arrête et le reste est écarté. */
export const ENTREES_LUES_MAX = 20_000;

function lireFichier(e: EntreeSysteme): Promise<File | null> {
  return new Promise((ok) => {
    if (!e.file) return ok(null);
    e.file(ok, () => ok(null));
  });
}

async function lireDossier(e: EntreeSysteme): Promise<EntreeSysteme[]> {
  const lecteur = e.createReader?.();
  if (!lecteur) return [];
  const tout: EntreeSysteme[] = [];
  for (;;) {
    const lot = await new Promise<EntreeSysteme[]>((ok) => lecteur.readEntries(ok, () => ok([])));
    if (lot.length === 0) return tout;
    tout.push(...lot);
    if (tout.length >= ENTREES_LUES_MAX) return tout;
  }
}

async function parcourir(e: EntreeSysteme, parent: string, sortie: FichierADeposer[]): Promise<void> {
  if (sortie.length >= ENTREES_LUES_MAX) return;
  const chemin = parent === "" ? e.name : `${parent}/${e.name}`;
  if (e.isFile) {
    const file = await lireFichier(e);
    if (file) sortie.push({ file, chemin });
    return;
  }
  if (e.isDirectory) for (const enfant of await lireDossier(e)) await parcourir(enfant, chemin, sortie);
}

/** Fichiers d'un glisser-déposer, dossiers parcourus ; les entrées doivent être prises avant tout `await` (le navigateur les invalide). */
export async function lireEntreesGlissees(dt: DataTransfer): Promise<FichierADeposer[]> {
  const entrees: EntreeSysteme[] = [];
  const items = dt.items ? [...dt.items] : [];
  for (const it of items) {
    if (it.kind !== "file") continue;
    const e = (
      it as DataTransferItem & { webkitGetAsEntry?: () => EntreeSysteme | null }
    ).webkitGetAsEntry?.();
    if (e) entrees.push(e);
  }
  if (entrees.length === 0) return depuisSelecteur(dt.files ? [...dt.files] : []);
  const sortie: FichierADeposer[] = [];
  for (const e of entrees) await parcourir(e, "", sortie);
  return sortie;
}

/** Vrai si le glisser transporte des fichiers (et non du texte ou un lien). */
export function glissePorteDesFichiers(dt: DataTransfer | null): boolean {
  return !!dt && [...(dt.types ?? [])].includes("Files");
}

/** Ouvre le sélecteur du navigateur (fichiers, ou un dossier) ; rend les entrées choisies, aucune si l'utilisateur annule. */
export function choisirFichiers(dossier: boolean): Promise<FichierADeposer[]> {
  return new Promise((resolve) => {
    const champ = document.createElement("input");
    champ.type = "file";
    champ.multiple = true;
    if (dossier) champ.webkitdirectory = true;
    champ.addEventListener("change", () => resolve(depuisSelecteur(champ.files ?? [])), { once: true });
    champ.addEventListener("cancel", () => resolve([]), { once: true });
    champ.click();
  });
}
