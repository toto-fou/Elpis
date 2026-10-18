// SPDX-License-Identifier: MIT
/** apps/core/src/jobs/branchements.ts — tâches de fond posées dans main : ports du tour, de la boucle et des conversations, réveilleur démarré et arrêté avec le process. */
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";

import { installerJobsBoucle } from "../boucle/ports";
import { installerCrochetsConversations } from "../chats/stockage";
import { installerJobsActifs } from "../contexte/ports";
import type { CycleDeVie } from "../cycle";
import { installerJobsTour } from "../tour/ports-jobs";
import { hoteJobsParDefaut } from "./hote";
import type { PortHoteJobs } from "./hote";
import { chatsAvecJobActif } from "./magasin";
import { ServiceJobs } from "./service";
import type { DependancesJobs } from "./service";

/** Service installé dans les ports ; `null` les retire. */
export function installerServiceJobs(service: ServiceJobs | null): void {
  installerJobsTour(service);
  installerJobsBoucle(service);
  installerJobsActifs(service === null ? null : (u, c) => service.ligneAncre(u, c));
  installerCrochetsConversations(
    service === null
      ? null
      : {
          epargnees: (x, uid) => chatsAvecJobActif(x, uid),
          apresSuppression: (uid, ids) => service.apresSuppression(uid, ids),
        },
  );
}

export function brancherJobs(
  base: Base,
  cycle: CycleDeVie,
  publier: (message: Dict) => unknown,
  o: Partial<Pick<DependancesJobs, "horloge">> & { hote?: PortHoteJobs } = {},
): ServiceJobs {
  const service = new ServiceJobs({
    base,
    hote: o.hote ?? hoteJobsParDefaut(base),
    publier,
    arret: cycle.signalArret,
    ...(o.horloge ? { horloge: o.horloge } : {}),
  });
  installerServiceJobs(service);
  cycle.auDemarrage("réveilleur des tâches de fond", () => service.demarrer(), { modes: ["main"] });
  cycle.alArret("réveilleur des tâches de fond", () => {
    service.arreter();
    installerServiceJobs(null);
  });
  return service;
}
