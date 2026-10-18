// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/demarrage.ts — moteur des métriques dans le cycle de vie : échantillonneur du process, moniteur de fond de l'admin, compteurs applicatifs. */
import type { Base } from "@elpis/db";

import type { CycleDeVie } from "../cycle";
import type { Evenements } from "../evenements";
import type { Journal } from "../journal";
import type { ModeApp } from "../mode";
import { planificateurDuProcess } from "../routines/planificateur";
import { nombreTachesChat } from "../tour/etat";
import { Echantillonneur, installerCompteurProcessus } from "./echantillonneur";
import type { ContexteMetriques } from "./fournisseurs/base";
import { MoniteurFond } from "./moniteur";
import { contexteMetriques } from "./registre";

export interface MoteurMetriques {
  readonly moniteur: MoniteurFond | null;
  readonly echantillonneur: Echantillonneur;
  readonly contexte: ContexteMetriques;
}

/** Branche le moteur sur le cycle : minuteries démarrées au démarrage, arrêtées dès l'annonce de l'arrêt (aucune ne retient le process). */
export function brancherMoteurMetriques(o: {
  mode: ModeApp;
  base: Base;
  cycle: CycleDeVie;
  evenements: Evenements;
  journal: Journal;
}): MoteurMetriques {
  const { cycle, evenements } = o;
  installerCompteurProcessus(
    "clientsSse",
    () => evenements.systemEvents.nombreClients + evenements.pipelineEvents.nombreClients,
  );
  installerCompteurProcessus("tachesFond", () => cycle.nombreTachesFond);
  installerCompteurProcessus("tachesChat", nombreTachesChat);
  installerCompteurProcessus("terminaux", () => 0);
  installerCompteurProcessus("routines", () => planificateurDuProcess()?.nombreRunsActifs() ?? 0);
  installerCompteurProcessus(
    "planificateurVivant",
    () => planificateurDuProcess()?.schedulerAlive() ?? false,
  );
  const moniteur = o.mode === "admin" ? new MoniteurFond({ journal: o.journal }) : null;
  const echantillonneur = new Echantillonneur(o.base, undefined, (tache) =>
    cycle.suivre("échantillon du process", tache),
  );
  const arreter = (): void => {
    moniteur?.arreter();
    echantillonneur.arreter();
  };
  if (moniteur !== null)
    cycle.auDemarrage(
      "moniteur système",
      () => {
        if (!cycle.arretEnCours) moniteur.demarrer();
      },
      { modes: ["admin"] },
    );
  cycle.auDemarrage("échantillonneur du process", () => {
    if (!cycle.arretEnCours) echantillonneur.demarrer();
  });
  cycle.signalArret.addEventListener("abort", arreter, { once: true });
  cycle.alArret("moteur des métriques", arreter);
  return { moniteur, echantillonneur, contexte: contexteMetriques(o.base, moniteur) };
}
