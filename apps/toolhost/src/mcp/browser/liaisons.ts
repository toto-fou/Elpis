// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/liaisons.ts — sessions sécurisées liées par l'hôte d'outils au secret qui les a ouvertes (nom, genre, origines, TLS, politique des sous-agents), par propriétaire du service et session ; oubliées à l'arrêt, au nettoyage, à l'expiration ou sur un déclencheur, bornées en mémoire. */

/** Secret pour lequel une session sécurisée a été ouverte. */
export interface LiaisonSession {
  readonly secret: string;
  readonly kind: "web-login" | "http-auth";
  readonly origines: readonly string[];
  readonly tls: "strict" | "insecure";
  readonly sousAgents: boolean;
}

/** Liaisons gardées au plus : la plus ancienne part d'abord (une session oubliée refuse pw_login, jamais l'inverse). */
const LIAISONS_MAX = 512;
const liaisons = new Map<string, LiaisonSession>();

const cle = (owner: string, sid: string): string => `${owner}\u0000${sid}`;

/** Lie la session `sid` du propriétaire `owner` au secret qui l'a ouverte. */
export function lier(owner: string, sid: string, l: LiaisonSession): void {
  const k = cle(owner, sid);
  liaisons.delete(k);
  liaisons.set(k, l);
  while (liaisons.size > LIAISONS_MAX) {
    const premiere = liaisons.keys().next();
    if (premiere.done) break;
    liaisons.delete(premiere.value);
  }
}

/** Liaison de la session, `undefined` si elle n'a pas été ouverte pour un secret par cet hôte. */
export function liaison(owner: string, sid: string): LiaisonSession | undefined {
  return liaisons.get(cle(owner, sid));
}

/** Oublie la liaison d'une session (arrêt, expiration, déclencheur). */
export function oublier(owner: string, sid: string): void {
  liaisons.delete(cle(owner, sid));
}

/** Oublie toutes les liaisons d'un propriétaire (nettoyage de ses sessions). */
export function oublierProprietaire(owner: string): void {
  const prefixe = `${owner}\u0000`;
  for (const k of [...liaisons.keys()]) if (k.startsWith(prefixe)) liaisons.delete(k);
}

/** Session déjà ouverte par `owner` pour le secret `nom` sur `origine`, avec le même TLS : à reprendre plutôt qu'en ouvrir une autre. */
export function sessionDuSecret(
  owner: string,
  nom: string,
  origine: string,
  tls: "strict" | "insecure",
): string | null {
  const prefixe = `${owner}\u0000`;
  for (const [k, l] of [...liaisons.entries()].reverse())
    if (k.startsWith(prefixe) && l.secret === nom && l.tls === tls && l.origines.includes(origine))
      return k.slice(prefixe.length);
  return null;
}

/** Pour les tests : aucune liaison. */
export function oublierTout(): void {
  liaisons.clear();
}
