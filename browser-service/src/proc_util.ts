// SPDX-License-Identifier: MIT
// ============================================================================
//  browser-service/src/proc_util.ts — choix des processus navigateur ORPHELINS (module pur).
// ============================================================================
//  Avant : tout renderer Chromium de plus de 20 min était tué, y compris ceux
//  d'un onglet actif — une session longue
//  (formulaire, suivi d'une page) perdait sa page au bout de 20 min. On ne tue
//  plus que les processus de contenu dont le parent n'est PLUS un processus
//  navigateur principal (le navigateur qui les a lancés est mort).
//  Entrée : la sortie de ``ps -o pid=,ppid=,etimes=,args=`` ; aucune E/S ici.
// ============================================================================

// Processus « enfants » de Chromium (renderers, gpu-process, utilitaires, zygotes) : jamais des principaux.
const _CONTENU = /chrom(?:e|ium)[^ ]*.*--type=(?:renderer|gpu-process|utility|zygote)/i;
const _PRINCIPAL_CHROME = /chrom(?:e|ium)/i;

/** Processus lu dans ``ps`` : PID, PID du parent, âge en secondes, ligne de commande. */
export interface Processus {
  pid: number;
  ppid: number;
  age: number;
  args: string;
}

/** Lignes ``ps`` → ``[{pid, ppid, age, args}]`` (lignes illisibles ignorées). */
export function lirePs(texte: unknown): Processus[] {
  const out: Processus[] = [];
  for (const ligne of String(texte || "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(ligne);
    if (!m) continue;
    out.push({ pid: +m[1]!, ppid: +m[2]!, age: +m[3]!, args: m[4]! });
  }
  return out;
}

function _estPrincipal(p: Processus): boolean {
  if (_CONTENU.test(p.args)) return false;
  if (_PRINCIPAL_CHROME.test(p.args)) return !/--type=/.test(p.args);
  return false;
}

/** Vrai si ``p`` remonte, à travers zygotes et autres processus de contenu (renderer/gpu → zygote → principal), à un navigateur principal vivant ou à un PID épargné. */
function _rattache(
  p: Processus,
  parPid: ReadonlyMap<number, Processus>,
  garde: ReadonlySet<number>,
): boolean {
  const vus = new Set<number>();
  let cur: Processus | undefined = p;
  while (cur && !vus.has(cur.pid)) {
    vus.add(cur.pid);
    const parent = parPid.get(cur.ppid);
    if (!parent) return false; // parent mort
    if (garde.has(parent.pid) || _estPrincipal(parent)) return true;
    if (!_CONTENU.test(parent.args)) return false; // init, systemd, autre
    cur = parent;
  }
  return false;
}

/**
 * PID des processus de contenu orphelins de plus de ``ageMinS`` secondes :
 * aucun navigateur principal vivant au bout de leur chaîne de parents.
 * ``epargner`` : PID à ne jamais tuer (le service lui-même…).
 */
export function orphelins(
  procs: readonly Processus[],
  { ageMinS = 1200, epargner = [] }: { ageMinS?: number; epargner?: readonly number[] } = {},
): number[] {
  const parPid = new Map(procs.map((p) => [p.pid, p]));
  const garde = new Set(epargner.filter(Boolean));
  const res: number[] = [];
  for (const p of procs) {
    if (!_CONTENU.test(p.args) || p.age < ageMinS || garde.has(p.pid)) continue;
    if (_rattache(p, parPid, garde)) continue;
    res.push(p.pid);
  }
  return res;
}
