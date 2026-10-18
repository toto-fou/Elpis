// SPDX-License-Identifier: MIT
/** apps/core/src/llm/branchement.ts — ports du moteur posés au démarrage : connecteurs et accès en base, disjoncteur de l'ordonnanceur, réduction des captures de la vision, diffusion sur le bus d'événements. */
import type { Executeur } from "@elpis/db";

import { publierVersMain } from "../evenements/canal";
import type { AppelInterne } from "../evenements/canal";
import type { SystemEvents } from "../evenements/systeme";
import { traitementImages } from "../images/ports";
import { portAccesMoteurs } from "./acces-moteurs";
import { installerRelaisModeles } from "./cache-modeles";
import { portConnecteurs } from "./connecteurs";
import { portDisjoncteur } from "./ordonnanceur/process";
import {
  installerAccesMoteurs,
  installerConnecteurs,
  installerDiffusion,
  installerDisjoncteur,
  installerImages,
} from "./ports";

/** Connecteurs chiffrés et politiques d'accès lus dans `base`, pannes de transport comptées par l'ordonnanceur du process, captures de la vision réduites par @elpis/images. */
export function brancherLlm(base: Executeur): void {
  installerConnecteurs(portConnecteurs(base));
  installerAccesMoteurs(portAccesMoteurs(base));
  installerDisjoncteur(portDisjoncteur());
  installerImages(traitementImages);
}

/** Diffusions du moteur sur le bus du process ; dans l'admin (`versMain`), seul main émet les `model_status` (relayés par le canal) et le relais lui fait rafraîchir son état. */
export function brancherDiffusionLlm(options: { systemEvents: SystemEvents; versMain?: AppelInterne }): void {
  const { systemEvents, versMain } = options;
  installerDiffusion({
    diffuser: (message) => {
      if (versMain === undefined || message["type"] !== "model_status") systemEvents.broadcast(message);
    },
  });
  installerRelaisModeles(versMain ? () => publierVersMain({ type: "model_cache_refresh" }, versMain) : null);
}
