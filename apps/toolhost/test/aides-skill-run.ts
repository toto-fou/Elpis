// SPDX-License-Identifier: MIT
/** apps/toolhost/test/aides-skill-run.ts — aides des tests skill_run : contexte d'appel qui note les notifications, membres d'une archive tar comme `tarfile` les relit. */
import { createHash } from "node:crypto";

import type { Dict } from "@elpis/commun";
import type { ContexteAppel } from "@elpis/outils-mcp";

/** Contexte d'appel de test : `ctx.info` noté dans l'ordre, comme la doublure Python. */
export function ctxTest(meta: Dict | null, appels: unknown[] = []): ContexteAppel {
  const noter = async (...x: unknown[]): Promise<void> => void appels.push(x);
  return {
    nomOutil: "skill_run_script",
    meta,
    famille: "skill_run",
    signal: new AbortController().signal,
    log: async (m) => noter("log", m),
    debug: async (m) => noter("debug", m),
    info: async (m) => noter("info", m),
    warning: async (m) => noter("warning", m),
    error: async (m) => noter("error", m),
    reportProgress: async (p, t, m) => noter("progress", p, t ?? null, m ?? null),
  };
}

/** Membres d'une archive tar (ustar + pax `path`/`linkpath`) comme `tarfile` les relit : nom sans `/` final, nature, mode, empreinte. */
export function membresTar(archive: Buffer): Dict[] {
  const sortie: Dict[] = [];
  let pos = 0;
  let pax: Record<string, string> = {};
  const texte = (b: Buffer): string =>
    b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)).toString("utf8");
  while (pos + 512 <= archive.length) {
    const h = archive.subarray(pos, pos + 512);
    if (h.every((x) => x === 0)) break;
    const taille = parseInt(texte(h.subarray(124, 136)) || "0", 8);
    const type = String.fromCharCode(h[156] ?? 0x30);
    const donnees = archive.subarray(pos + 512, pos + 512 + taille);
    pos += 512 + Math.ceil(taille / 512) * 512;
    if (type === "x") {
      pax = {};
      for (let i = 0; i < donnees.length;) {
        const espace = donnees.indexOf(0x20, i);
        const longueur = parseInt(donnees.subarray(i, espace).toString("latin1"), 10);
        const record = donnees.subarray(espace + 1, i + longueur - 1).toString("utf8");
        const egal = record.indexOf("=");
        pax[record.slice(0, egal)] = record.slice(egal + 1);
        i += longueur;
      }
      continue;
    }
    const nom = (pax["path"] ?? texte(h.subarray(0, 100))).replace(/\/+$/u, "");
    const e: Dict = {
      nom,
      nature: type === "5" ? "d" : type === "2" ? "l" : type === "0" ? "f" : type,
      mode: parseInt(texte(h.subarray(100, 108)), 8),
    };
    if (type === "0") {
      e["sha256"] = createHash("sha256").update(donnees).digest("hex");
      e["taille"] = taille;
    }
    if (type === "2") e["cible"] = pax["linkpath"] ?? texte(h.subarray(157, 257));
    sortie.push(e);
    pax = {};
  }
  return sortie;
}
