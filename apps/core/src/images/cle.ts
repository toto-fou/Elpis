// SPDX-License-Identifier: MIT
/** apps/core/src/images/cle.ts — clé du moteur d'images dans le coffre : secret d'instance `image-engine` (`kind token`) dont la portée est l'origine exacte du moteur ; rendue seulement tant que l'adresse configurée garde cette origine. */
import { strPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { NOM_CLE_IMAGES, POLITIQUE_CLE_MOTEUR } from "@elpis/db";
import type { Base, Executeur } from "@elpis/db";

import { base as baseApp } from "../base";
import { journal } from "../journal";
import { ErreurSecret } from "../secrets/erreurs";
import { origineExacte, origines } from "../secrets/portee";
import {
  creerSecret,
  dechiffrerLigne,
  lireLigneParNom,
  modifierSecret,
  porteeDe,
  supprimerSecret,
} from "../secrets/stockage";
import type { Acteur, LigneSecret } from "../secrets/stockage";

const log = journal("image");

/** Secret `image-engine` de l'instance ; un autre genre sous ce nom ne compte pas. */
async function ligneCle(x: Executeur): Promise<LigneSecret | null> {
  const l = await lireLigneParNom(x, null, NOM_CLE_IMAGES);
  return l !== null && l.kind === "token" ? l : null;
}

/** Clé déchiffrée si la portée du secret couvre l'origine de `cfg.url`, sinon `""` ; secret présent ou non. */
async function lire(cfg: Readonly<Dict>, x: Executeur): Promise<{ cle: string; present: boolean }> {
  const l = await ligneCle(x);
  if (l === null) return { cle: "", present: false };
  const origine = origineExacte(strPy(cfg["url"] ?? ""));
  if (origine === null || !origines(porteeDe(l)).includes(origine)) return { cle: "", present: true };
  try {
    return { cle: dechiffrerLigne(l), present: true };
  } catch (e) {
    if (!(e instanceof ErreurSecret)) throw e;
    log.warn(`clé du moteur d'images illisible dans le coffre (${e.code}) : la ressaisir dans la console`);
    return { cle: "", present: true };
  }
}

/** Clé pour l'adresse de `cfg` (côté hôte seulement), lue du coffre à chaque appel ; `""` sans clé utilisable ou si le coffre est illisible. */
export async function cleImages(cfg: Readonly<Dict>, x?: Executeur): Promise<string> {
  try {
    return (await lire(cfg, x ?? baseApp())).cle;
  } catch (e) {
    log.warn(`clé du moteur d'images non lue : ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}

/** État pour la console : `has_key` (clé du coffre déchiffrable pour cette origine), `stale` (une clé existe, au coffre ou ancienne dans config.json, mais ne sert pas). */
export async function etatCleImages(
  cfg: Readonly<Dict>,
  x: Executeur,
): Promise<{ has_key: boolean; stale: boolean }> {
  const { cle, present } = await lire(cfg, x);
  return { has_key: cle !== "", stale: cle === "" && (present || Boolean(cfg["api_key_enc"])) };
}

/** Clé rangée pour l'origine exacte de `url` (création, ou nouvelle valeur et portée, journalisées) ; vide : secret supprimé ; nom pris par un autre genre : refus 409, rien de touché. */
export async function enregistrerCleImages(
  base: Base,
  cle: string,
  url: string,
  acteur: Acteur,
): Promise<void> {
  const origine = origineExacte(url);
  await base.ecriture(async () => {
    const l = await lireLigneParNom(base, null, NOM_CLE_IMAGES);
    if (l !== null && l.kind !== "token") {
      if (!cle) return;
      throw new ErreurSecret(
        409,
        "secret_name_taken",
        `The instance secret '${NOM_CLE_IMAGES}' already exists with another kind.`,
      );
    }
    if (!cle) {
      if (l !== null) await supprimerSecret(base, null, Number(l.id), acteur);
      return;
    }
    const portee = { origins: [origine] };
    if (l !== null) await modifierSecret(base, null, Number(l.id), { value: cle, scope: portee }, acteur);
    else
      await creerSecret(
        base,
        null,
        {
          name: NOM_CLE_IMAGES,
          kind: "token",
          scope: portee,
          value: cle,
          policy: { ...POLITIQUE_CLE_MOTEUR },
        },
        acteur,
      );
  });
}
