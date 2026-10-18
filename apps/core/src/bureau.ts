// SPDX-License-Identifier: MIT
/** apps/core/src/bureau.ts — @elpis/bureau branché sur les images, le catalogue d'erreurs d'outil et le `User-Agent` du core. */
import { installerSocleBureau } from "@elpis/bureau";
import { dimensionsImage, recadrerCapture, reduireLargeur, signatureCapture } from "@elpis/images";

import { AGENT_UTILISATEUR } from "./llm/client-http";
import { err } from "./outils/erreur-outil";

installerSocleBureau({
  images: {
    dimensions: dimensionsImage,
    signature: signatureCapture,
    recadrer: recadrerCapture,
    reduireLargeur,
  },
  err,
  agentUtilisateur: AGENT_UTILISATEUR,
});

export * from "@elpis/bureau";
