// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/aides-oidc.ts — aides communes des tests de conformité OIDC : code d'un refus de retour, ouverture d'un banc sur un profil de produit, claims de jeton. */
import { CODES_ERREUR_CONNEXION } from "@elpis/contracts";
import { expect } from "vitest";
import type { LightMyRequestResponse } from "fastify";

import { lignesAuditRecentes } from "../aides";
import { ouvrirBancOidc } from "../identite/banc-oidc";
import type { ProfilProduit } from "./profils-oidc";
import type { BancOidc } from "../identite/banc-oidc";
import type { OptionsFactice, Utilisateur } from "../identite/oidc-factice";

/** Code fermé d'un refus de retour (`/?auth_error=<code>&ref=<ref>`), sans session ouverte. */
export function codeRefus(r: LightMyRequestResponse): string {
  expect(r.statusCode, r.body).toBe(302);
  const l = String(r.headers.location);
  const m = /^\/\?auth_error=([a-z_]+)&ref=([A-Za-z0-9_-]{8})$/u.exec(l);
  expect(m, l).not.toBeNull();
  expect(String(r.headers["set-cookie"] ?? "")).not.toContain("mcpwebui_session");
  expect(CODES_ERREUR_CONNEXION as readonly string[]).toContain(m?.[1]);
  return m?.[1] ?? "";
}

/** Cause réelle (journal serveur) du dernier refus de connexion. */
export function causeDuDernierRefus(): string {
  const e = lignesAuditRecentes({ actionPrefix: "auth.login.denied" })[0];
  return String((e?.["details"] as Record<string, unknown> | undefined)?.["reason"] ?? "");
}

/** Départ refusé : aucune adresse d'autorisation rendue, et le code HTTP. */
export async function departRefuse(b: BancOidc): Promise<number> {
  const d = await b.demarrer();
  expect(d.url).toBeNull();
  return d.reponse.statusCode;
}

export type Moteur = "sqlite" | "postgres";

export interface OptionsOuverture {
  idp?: OptionsFactice;
  extra?: Record<string, unknown>;
  decouverte?: (b: BancOidc) => Record<string, unknown>;
}

/** Banc ouvert avec ses réglages ; le document de découverte est posé avant tout appel. */
export async function ouvrir(moteur: Moteur, o: OptionsOuverture = {}): Promise<BancOidc> {
  const b = await ouvrirBancOidc(moteur, {
    ...(o.idp === undefined ? {} : { idp: o.idp }),
    ...(o.extra === undefined ? {} : { extra: o.extra }),
  });
  if (o.decouverte !== undefined) b.idp.decouverte = { ...b.idp.decouverte, ...o.decouverte(b) };
  return b;
}

export const maintenant = (): number => Math.floor(Date.now() / 1000);

/** Banc ouvert sur le profil d'un produit (réglages, document de découverte, UserInfo du produit). */
export async function ouvrirProfil(
  moteur: Moteur,
  p: ProfilProduit,
  o: {
    surOrigine?: boolean;
    extra?: Record<string, unknown>;
    decouverte?: Record<string, unknown>;
    idp?: OptionsFactice;
  } = {},
): Promise<BancOidc> {
  const b = await ouvrir(moteur, {
    idp: { ...p.idp, ...o.idp },
    extra: { ...p.reglages, required_groups: [p.groupeRequis], ...o.extra },
    decouverte: (x) => ({ ...p.decouverte(x.idp, o.surOrigine), ...o.decouverte }),
  });
  const rendre = p.userinfo ?? ((u: Utilisateur) => ({ sub: u.sub }));
  b.idp.userinfo = (u) => rendre(u);
  return b;
}

/** Parcours en deux temps : l'adresse de retour du fournisseur peut être modifiée avant d'être rejouée. */
export async function parcours(
  b: BancOidc,
  u: Utilisateur,
  modifier?: (retour: URL) => void,
): Promise<{ depart: Awaited<ReturnType<BancOidc["demarrer"]>>; rep: LightMyRequestResponse; url: string }> {
  const depart = await b.demarrer();
  if (depart.url === null) throw new Error(`départ refusé : ${depart.reponse.statusCode}`);
  const { retour } = b.idp.autoriser(depart.url, u);
  const adresse = new URL(retour);
  modifier?.(adresse);
  const rep = await b.retourner(adresse.href, { cookie: depart.cookie });
  return { depart, rep, url: depart.url };
}
