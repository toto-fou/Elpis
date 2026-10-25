// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/outils/sortie.ts — ce qu'une étape a produit, dit court : dernières lignes de sa sortie vivante, résumé de son résultat. */
import type { EtapeOutil } from "./types.ts";

const LONGUEUR = 90;
const court = (t: string): string => (t.length > LONGUEUR ? t.slice(0, LONGUEUR - 1) + "…" : t);
const lignes = (t: string): string[] =>
  t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** Dernières lignes de sortie d'une étape en cours (console sans séquences ANSI, journal, progression). */
export function dernieresLignes(s: EtapeOutil, n = 2): string[] {
  // eslint-disable-next-line no-control-regex -- séquences ANSI de la console retirées
  const console = lignes((s.shellOut ?? "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ""));
  if (console.length) return console.slice(-n);
  const journal = (s.logs ?? []).map((l) => l.message).filter(Boolean);
  if (journal.length) return journal.slice(-n);
  return s.progressInfo?.message ? [s.progressInfo.message] : [];
}

function enObjet(r: unknown): Record<string, unknown> | null {
  if (r && typeof r === "object") return r as Record<string, unknown>;
  if (typeof r !== "string") return null;
  try {
    const o: unknown = JSON.parse(r);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Une ligne sur le résultat d'une étape finie : erreur, code de sortie et dernière ligne, résumé, ou première ligne. */
export function resumeResultat(s: EtapeOutil): string {
  if (s.status === "running") return "";
  if (s.status === "stopped") return "arrêtée";
  const o = enObjet(s.result);
  if (o) {
    const erreur = o["error"] ?? o["message"];
    if (s._is_error && typeof erreur === "string" && erreur.trim()) return court(lignes(erreur)[0] ?? "");
    if (typeof o["exit_code"] === "number") {
      const fin = lignes(String(o["stdout"] || o["stderr"] || "")).at(-1);
      return court(`code ${o["exit_code"]}${fin ? " · " + fin : ""}`);
    }
    if (typeof o["summary"] === "string" && o["summary"].trim()) return court(o["summary"]);
  }
  const premiere = typeof s.result === "string" ? lignes(s.result)[0] : "";
  return premiere ? court(premiere) : s._is_error ? "échec" : "fait";
}
