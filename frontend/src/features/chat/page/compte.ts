// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/page/compte.ts — menu du compte du volet : rôle lisible et position fixe au-dessus (ou à droite) du bouton, hors du volet qui coupe ses débordements. */

export function libelleRole(u: { is_admin?: unknown; role?: string }): string {
  if (Number(u.is_admin) === 1) return "Administrateur";
  if (u.role === "moderator" || Number(u.is_admin) === 2) return "Modérateur";
  return "Utilisateur";
}

/** Ouvert vers le haut, aligné sur le bouton (volet déployé) ou à sa droite (rail réduit). */
export function positionCompte(
  bouton: DOMRect,
  compact: boolean,
  hauteurFenetre = window.innerHeight,
): Record<string, string> {
  const gauche = compact ? bouton.right + 8 : bouton.left;
  const bas = compact ? hauteurFenetre - bouton.bottom : hauteurFenetre - bouton.top + 6;
  return { left: `${Math.max(8, Math.round(gauche))}px`, bottom: `${Math.max(8, Math.round(bas))}px` };
}
