// SPDX-License-Identifier: MIT
/** apps/core/src/git/regle.ts — règle Git du profil réseau d'un compte, lue par le core : serveurs choisis par l'administrateur, portées des comptes Git du compte. */
import { getUserSettings } from "@elpis/auth";
import { chargerConfigBac, profilParId } from "@elpis/bac";
import type { ProfilReseau } from "@elpis/bac";
import type { Base } from "@elpis/db";
import { cleServeurGit, regleDuProfil } from "@elpis/fichiers";
import type { RegleGit } from "@elpis/fichiers";

import { resolveNetworkProfileId } from "../relais/identite";
import { listConnectorScopes } from "./connecteurs";

async function profilDuCompte(base: Base, uid: number): Promise<ProfilReseau> {
  return profilParId(chargerConfigBac(), resolveNetworkProfileId(await getUserSettings(base, uid)));
}

/** Règle Git du compte, comme l'applique le relais. */
export async function regleGitDuCompte(base: Base, uid: number): Promise<RegleGit> {
  return regleDuProfil(await profilDuCompte(base, uid), () => listConnectorScopes(base, uid));
}

/** Serveurs Git que le profil réseau du compte autorise (règle « serveurs choisis », hôte et chemin) ; `null` : la règle ne borne pas les serveurs. */
export async function serveursDuProfil(
  base: Base,
  uid: number,
): Promise<{ host: string; path: string }[] | null> {
  const profil = await profilDuCompte(base, uid);
  if (profil.git_access !== "servers") return null;
  return profil.git_servers.map((s) => {
    const barre = s.indexOf("/");
    return barre < 0 ? { host: s, path: "" } : { host: s.slice(0, barre), path: s.slice(barre + 1) };
  });
}

/** Un compte Git sur `hote` serait utilisable par le relais : la règle ne borne pas les serveurs, ou l'un d'eux est cet hôte (port par défaut écrit ou non). */
export async function serveurPermis(base: Base, uid: number, hote: string): Promise<boolean> {
  const serveurs = await serveursDuProfil(base, uid);
  return serveurs === null || serveurs.some((s) => cleServeurGit(s.host) === cleServeurGit(hote));
}
