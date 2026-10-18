// SPDX-License-Identifier: MIT
/** apps/core/src/relais/identite.ts — enveloppe d'identité du compte et en-têtes vers l'hôte d'outils (`_identity_for`, `relay_headers`), choix du bac à sable enregistré par main. */
import { reglagesEnJson } from "@elpis/auth";
import { chargerConfigBac } from "@elpis/bac";
import {
  ErreurJsonPy,
  ErreurLecturePy,
  getPy,
  poserCle,
  pyJsonLoads,
  pyJsonLoadsOctets,
  reprPy,
  stripPy,
  texteNet,
  veritePy,
} from "@elpis/commun";
import { parseJsonPy } from "@elpis/config";
import { creerIdentite, IDENTITY_HEADER, sign } from "@elpis/securite";
import type { Identity } from "@elpis/securite";

import { base } from "../base";
import { journal } from "../journal";
import type { Journal } from "../journal";
import { estDict, lire, texteOu } from "./dict";
import type { Spec } from "./dict";
import type { SandboxHost } from "./hotes";

export { profilReseauDesReglages as resolveNetworkProfileId };

/** `resolve_network_profile_id` : profil forcé par l'admin, sinon choisi, sinon « isolated ». */
export function profilReseauDesReglages(reglages: Spec): string {
  const force = stripPy(texteOu(lire(reglages, "forced_network_profile_id"), ""));
  return force || stripPy(texteOu(lire(reglages, "network_profile_id"), "")) || "isolated";
}

/** `get_user_settings` sur la colonne lue : `{}` si absente, illisible ou pas un objet. */
function reglagesDe(uid: number, brut: unknown): Spec {
  if (typeof brut !== "string" || !brut) return {};
  try {
    const valeur = parseJsonPy(brut);
    return estDict(valeur) ? valeur : {};
  } catch {
    journal("users").error(
      `settings_json corrompu pour uid=${uid} — retour aux défauts ; la prochaine sauvegarde écrasera la ligne`,
    );
    return {};
  }
}

/** `_identity_for` : nom exact (`user_<id>` à défaut), admin plein seulement (`is_admin` = 1), profil réseau effectif et imposition de l'administrateur (`""` : aucune). */
export async function identiteRelais(uid: number): Promise<Identity> {
  const ligne = await base().get<{ username: unknown; is_admin: unknown; settings_json: unknown }>(
    "SELECT username, is_admin, settings_json FROM users WHERE id=?",
    [uid],
  );
  const nom = typeof ligne?.username === "string" && ligne.username ? ligne.username : `user_${uid}`;
  const reglages = reglagesDe(uid, ligne?.settings_json);
  return creerIdentite({
    user_id: uid,
    username: nom,
    is_admin: ligne?.is_admin === 1,
    network_profile_id: profilReseauDesReglages(reglages),
    forced_network_profile_id: texteNet(lire(reglages, "forced_network_profile_id")),
  });
}

/** `relay_headers` : jeton de service et enveloppe signée avec lui (`username` : nom gardé d'avant la suppression du compte) ; jamais l'en-tête d'identité venu du navigateur. */
export async function entetesRelais(
  hote: SandboxHost,
  uid: number,
  username?: string,
): Promise<Record<string, string>> {
  const identite = await identiteRelais(uid);
  return {
    authorization: `Bearer ${hote.token}`,
    [IDENTITY_HEADER]: sign(username === undefined ? identite : { ...identite, username }, hote.token),
  };
}

/** `repr(exc)` d'une exception, sous son nom Python, pour le journal. */
function reprErreur(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const nom =
    e instanceof ErreurJsonPy ? "JSONDecodeError" : e instanceof ErreurLecturePy ? e.nature : e.name;
  return `${nom}(${reprPy(e.message)})`;
}

/** Réglages relus pour être réécrits : JSON illisible → `{}` (ValueError de Python) ; trop imbriqué pour ce lecteur fidèle → l'erreur annule l'écriture au lieu de vider la ligne. */
function reglagesAEcrire(uid: number, brut: unknown): Record<string, unknown> {
  if (typeof brut !== "string" || !brut) return {};
  let valeur: unknown;
  try {
    valeur = pyJsonLoads(brut);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    journal("users").error(
      `settings_json corrompu pour uid=${uid} — retour aux défauts ; la prochaine sauvegarde écrasera la ligne`,
    );
    return {};
  }
  return estDict(valeur) ? valeur : {};
}

/** `_enregistrer_choix_sandbox` : après un POST /api/sandbox/me réussi sur l'hôte, main enregistre le mode et le profil appliqués (source de l'enveloppe), sauf profil inconnu ou autre que celui imposé, vérifié sous le verrou d'écriture. */
export async function enregistrerChoixBac(
  uid: number,
  corps: Uint8Array,
  j: Journal = journal("sandbox-relay"),
): Promise<void> {
  try {
    const d = pyJsonLoadsOctets(corps);
    const mode = getPy(d, "mode");
    const profil = getPy(d, "network_profile_id");
    if (!veritePy(getPy(d, "ok")) || mode !== "docker" || typeof profil !== "string") return;
    const profils = new Set(chargerConfigBac().network_profiles.map((p) => p.id));
    const refus = (): void => j.warn(`profil ${reprPy(profil)} de l'hôte non enregistré (uid=${uid})`);
    if (!profils.has(profil)) return refus();
    await base().ecriture(async (x) => {
      const ligne = await x.get<{ settings_json: unknown }>("SELECT settings_json FROM users WHERE id=?", [
        uid,
      ]);
      if (!ligne) return;
      const reglages = reglagesAEcrire(uid, ligne.settings_json);
      const impose = texteNet(lire(reglages, "forced_network_profile_id"));
      if (profils.has(impose) && impose !== profil) return refus();
      poserCle(reglages, "sandbox_mode", mode);
      poserCle(reglages, "network_profile_id", profil);
      await x.run("UPDATE users SET settings_json=? WHERE id=?", [reglagesEnJson(reglages), uid]);
    });
  } catch (e) {
    j.warn(`choix du bac à sable non enregistré (uid=${uid}) : ${reprErreur(e)}`);
  }
}
