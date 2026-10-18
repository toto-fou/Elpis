// SPDX-License-Identifier: MIT
/** packages/auth/src/dict.ts — lecture des dict de configuration comme `cfg.get(clé, défaut)` et `(cfg.get(clé) or {})` de Python. */
import { getOu, veritePy } from "@elpis/commun";

export { getOu as lire };

export function sousObjet(objet: unknown, cle: string): Record<string, unknown> {
  const v = getOu(objet, cle, undefined);
  return v !== null && typeof v === "object" && !Array.isArray(v) && veritePy(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** `live_config_value("a.b.c", défaut)` sur un dict donné : défaut si un maillon manque ou si la valeur vaut None. */
export function valeur(config: unknown, chemin: string, defaut: unknown): unknown {
  let v: unknown = config;
  for (const cle of chemin.split(".")) {
    if (v === null || typeof v !== "object" || Array.isArray(v) || !Object.hasOwn(v, cle)) return defaut;
    v = (v as Record<string, unknown>)[cle];
  }
  return v === null || v === undefined ? defaut : v;
}
