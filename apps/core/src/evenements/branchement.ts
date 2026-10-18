// SPDX-License-Identifier: MIT
/** apps/core/src/evenements/branchement.ts — bus, routes et tâches du cycle de vie d'un process (main ou admin). */
import type { DependancesAuth } from "@elpis/auth";
import { jetonInterne } from "@elpis/securite";

import type { CycleDeVie } from "../cycle";
import type { Journal } from "../journal";
import type { Famille } from "../routes";
import { AbonnementCanal, CanalInterne, publierVersMain } from "./canal";
import type { AppelInterne } from "./canal";
import { SuiviJournalStaff } from "./journal-staff";
import { PipelineEvents } from "./pipeline";
import { EmpreinteDemarrage } from "./redemarrage";
import type { SourceRedemarrage } from "./redemarrage";
import { applySessionRevocation } from "./revocation";
import type { BilanRevocation, CiblesRevocation } from "./revocation";
import { familleEvenements, identiteDeSession } from "./routes";
import { SystemEvents } from "./systeme";
import type { EcrireJournal, Message } from "./systeme";

/** URL de main vue de l'admin, sur la boucle locale (`MAIN_INTERNAL_URL` comme en Python). */
export function urlMainInterne(env: Record<string, string | undefined> = process.env): string {
  return (env["MAIN_INTERNAL_URL"] ?? "").trim() || "http://127.0.0.1:8001";
}

export const RECYCLAGE: Message = { type: "worker_recycling" };

interface OptionsCommunes {
  readonly cycle: CycleDeVie;
  /** Base, configuration et secret de session : identité des flux et jeton interne du canal. */
  readonly auth: DependancesAuth;
  readonly journal?: Journal;
  /** `user_db/logs/app.log.jsonl` : son suivi alimente les `log` du staff ; absent, rien n'est suivi. */
  readonly cheminJournal?: string;
  readonly ecrireJournal?: EcrireJournal;
  readonly peutVoirModeles?: (uid: number) => boolean;
  /** Ouverture d'un flux `/api/system-events` et, dans main, du canal lu par l'admin. */
  readonly surOuvertureFlux?: () => void;
  readonly pingMs?: number;
  readonly graceArretMs?: number;
  readonly attenteMs?: number;
  readonly revalidationMs?: number;
  readonly pollJournalMs?: number;
}

export interface OptionsMain extends OptionsCommunes {
  readonly mode: "main";
  readonly redemarrage: SourceRedemarrage;
  readonly fermerTerminaux?: CiblesRevocation["fermerTerminaux"];
  readonly rafraichirModeles?: () => void;
  readonly capaciteCanal?: number;
  readonly pingCanalMs?: number;
}

export interface OptionsAdmin extends OptionsCommunes {
  readonly mode: "admin";
  readonly canal?: {
    readonly url?: string;
    readonly types?: Iterable<string>;
    readonly delaiInitialMs?: number;
    readonly delaiMaxMs?: number;
    readonly inactiviteMs?: number;
    readonly seuilAlerteMs?: number;
    readonly rappelAlerteMs?: number;
    readonly fetch?: typeof fetch;
  };
}

export interface Evenements {
  readonly mode: "main" | "admin";
  readonly systemEvents: SystemEvents;
  readonly pipelineEvents: PipelineEvents;
  readonly famille: Famille;
  readonly suiviJournal: SuiviJournalStaff | undefined;
  readonly canal: CanalInterne | undefined;
  readonly empreinte: EmpreinteDemarrage | undefined;
  readonly abonnement: AbonnementCanal | undefined;
  /** Appel interne de l'admin vers main (révocation, bannière, rafraîchissement des modèles) ; absent dans main. */
  readonly versMain: AppelInterne | undefined;
  /** Révocation : flux de ce process fermés ; depuis l'admin, main est prévenu par un appel interne. */
  revoquer(uid: number | null): Promise<BilanRevocation | null>;
  /** Diffusion à tous les process : ici, et vers main quand on est l'admin (bannière de redémarrage…). */
  diffuserPartout(message: Message): Promise<boolean>;
}

/** Évacuation à l'arrêt (`worker_recycling` puis fin), empreinte au démarrage de main, abonnement de l'admin. */
export function brancherEvenements(options: OptionsMain | OptionsAdmin): Evenements {
  const { cycle, journal } = options;
  const systemEvents = new SystemEvents({
    journal,
    peutVoirModeles: options.peutVoirModeles,
    ecrireJournal: options.ecrireJournal,
    surAbonneStaff: () => suiviJournal?.assurer(),
    attenteMs: options.attenteMs,
    revalidationMs: options.revalidationMs,
  });
  const suiviJournal =
    options.cheminJournal === undefined
      ? undefined
      : new SuiviJournalStaff(() => systemEvents, options.cheminJournal, {
          arret: cycle.signalArret,
          pollMs: options.pollJournalMs,
          journal,
          suivre: (tache) => cycle.suivre("suivi du journal staff", tache),
        });
  const pipelineEvents = new PipelineEvents({ revalidationMs: options.revalidationMs });
  const evacuer = (): void => {
    const n = systemEvents.fermer(RECYCLAGE) + pipelineEvents.fermer(RECYCLAGE);
    if (n > 0) journal?.info(`[SHUTDOWN] évacuation : ${n} flux renvoyés vers une reconnexion`);
  };
  if (cycle.signalArret.aborted) evacuer();
  else cycle.signalArret.addEventListener("abort", evacuer, { once: true });

  const cibles = (fermerTerminaux?: CiblesRevocation["fermerTerminaux"]): CiblesRevocation => ({
    systemEvents,
    pipelineEvents,
    fermerTerminaux,
    journal,
  });
  const commun = {
    systemEvents,
    pipelineEvents,
    identite: identiteDeSession(options.auth),
    arret: cycle.signalArret,
    journal,
    surOuvertureFlux: options.surOuvertureFlux,
    pingMs: options.pingMs,
    graceArretMs: options.graceArretMs,
  };

  if (options.mode === "main") {
    const canal = new CanalInterne({ capacite: options.capaciteCanal });
    systemEvents.surDiffusion((_message, donnees) => canal.publier(donnees));
    const empreinte = new EmpreinteDemarrage(options.redemarrage, canal.generation);
    cycle.auDemarrage("empreinte de démarrage", () => empreinte.enregistrer(), { modes: ["main"] });
    const ciblesMain = cibles(options.fermerTerminaux);
    return {
      mode: "main",
      systemEvents,
      pipelineEvents,
      famille: familleEvenements({
        ...commun,
        main: {
          canal,
          empreinte,
          cibles: ciblesMain,
          rafraichirModeles: options.rafraichirModeles,
          pingCanalMs: options.pingCanalMs,
        },
      }),
      suiviJournal,
      canal,
      empreinte,
      abonnement: undefined,
      versMain: undefined,
      revoquer: (uid) => applySessionRevocation({ type: "session_revoked", uid }, ciblesMain),
      diffuserPartout: (message) => {
        systemEvents.broadcast(message);
        return Promise.resolve(true);
      },
    };
  }

  const canalAdmin = options.canal ?? {};
  const { auth } = options;
  const jeton = (): string => jetonInterne(auth.secret());
  const versMain: AppelInterne = {
    url: canalAdmin.url ?? urlMainInterne(),
    jeton,
    journal,
    fetch: canalAdmin.fetch,
  };
  const abonnement = new AbonnementCanal({
    url: versMain.url,
    jeton,
    bus: systemEvents,
    journal,
    types: canalAdmin.types,
    delaiInitialMs: canalAdmin.delaiInitialMs,
    delaiMaxMs: canalAdmin.delaiMaxMs,
    inactiviteMs: canalAdmin.inactiviteMs,
    seuilAlerteMs: canalAdmin.seuilAlerteMs,
    rappelAlerteMs: canalAdmin.rappelAlerteMs,
    fetch: canalAdmin.fetch,
    surPerte: () => void systemEvents.disconnectUser(null, RECYCLAGE),
  });
  cycle.auDemarrage("canal interne main → admin", () => abonnement.executer(cycle.signalArret), {
    modes: ["admin"],
    arrierePlan: true,
  });
  const ciblesAdmin = cibles();
  return {
    mode: "admin",
    systemEvents,
    pipelineEvents,
    famille: familleEvenements(commun),
    suiviJournal,
    canal: undefined,
    empreinte: undefined,
    abonnement,
    versMain,
    revoquer: async (uid) => {
      const evenement: Message = { type: "session_revoked", uid, ts: Date.now() / 1000 };
      const bilan = await applySessionRevocation(evenement, ciblesAdmin);
      await publierVersMain(evenement, versMain);
      return bilan;
    },
    diffuserPartout: (message) => {
      systemEvents.broadcast(message, { relais: false });
      return publierVersMain(message, versMain);
    },
  };
}
