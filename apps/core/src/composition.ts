// SPDX-License-Identifier: MIT
/** apps/core/src/composition.ts — assemblage d'un process du core : authentification, gardes, ports posés au démarrage, bus d'événements, relais et familles de routes. */
import { mkdir } from "node:fs/promises";

import {
  convertirAnciensJetons,
  creerGardes,
  dependancesParDefaut,
  getUser,
  getUsernameById,
  installerAuth,
  mandatairesDuJournal,
} from "@elpis/auth";
import type { DependancesAuth, DependancesJetons, DependancesOAuth } from "@elpis/auth";
import {
  bootRaw,
  config,
  configView,
  HOT_RELOAD_PATHS,
  HOT_RELOAD_PREFIXES,
  pyJoin,
  racineDepot,
  realpathPy,
  safeSandboxName,
} from "@elpis/config";
import type { Base } from "@elpis/db";
import { brancherGardeUrl } from "@elpis/mcp";
import { blockRemoteUrlReason, configureAudit, defaultAuditDir, defaultAuditKeyPath } from "@elpis/securite";

import type { Extension } from "./app";
import { CycleDeVie } from "./cycle";
import {
  brancherEvenements,
  cheminJournalCommun,
  ecrivainJournalCommun,
  lireStatutMain,
  restartPaths,
} from "./evenements";
import type { Evenements, SourceRedemarrage } from "./evenements";
import { brancherBoucle } from "./boucle/branchements";
import { brancherContexte } from "./contexte/branchements";
import { brancherExecutions } from "./executions/branchements";
import { brancherTour } from "./tour/branchements";
import { isGenerationActive } from "./tour/etat";
import { famillesParDefaut } from "./familles";
import { creerFamilleAdminAgents } from "./familles/admin-agents";
import { creerFamilleAdminExecuteurs } from "./familles/admin-executeurs";
import { creerFamilleAdminIntegrations } from "./familles/admin-integrations";
import { creerFamilleAdminLlm } from "./familles/admin-llm";
import {
  ancresDeLaBase,
  fermerAgentsBureau,
  installerAncres,
  installerComptesBureau,
  installerPrimitivesBureau,
  PRIMITIVES_AGENT,
} from "./bureau";
import { creerFamilleAx } from "./familles/ax";
import { creerFamilleAdminComptes } from "./familles/admin-comptes";
import { creerFamilleAdminConfig } from "./familles/admin-config";
import { piloteBac } from "./admin/pilote-bac";
import { faitsParDefaut, sondesParDefaut } from "./admin/vue";
import { creerFamilleAdminVue } from "./familles/admin-vue";
import type { DependancesAdminVue } from "./familles/admin-vue";
import { creerFamilleAdminSecurite } from "./familles/admin-securite";
import { creerFamilleApparence } from "./familles/apparence";
import { creerFamilleBureau } from "./familles/bureau";
import { creerFamilleComptes } from "./familles/comptes";
import type { DependancesComptes } from "./familles/comptes";
import { creerFamilleChats } from "./familles/chats";
import { creerFamilleGraphiques } from "./familles/graphiques";
import { creerFamilleChat } from "./familles/chat";
import { creerFamilleChatCompression } from "./familles/chat-compression";
import { creerFamilleChatControle } from "./familles/chat-controle";
import { creerFamilleConfig } from "./familles/config";
import { creerFamilleExecutions } from "./familles/executions";
import { creerFamilleGit } from "./familles/git";
import { creerFamilleImages } from "./familles/images";
import { creerFamilleAdminImages } from "./familles/admin-images";
import { creerFamilleInterneJobs } from "./familles/interne-jobs";
import { creerFamilleInterneToolhost, jetonServiceDuManifeste } from "./familles/interne-toolhost";
import { creerFamilleJobs } from "./familles/jobs";
import { creerFamilleJetons } from "./familles/jetons";
import { creerFamilleMemoire } from "./familles/memoire";
import { creerFamilleOAuth } from "./familles/oauth";
import { creerFamilleOpenapi } from "./familles/openapi";
import { creerPontMcp } from "./familles/pont-mcp";
import { creerFamillePrompts } from "./familles/prompts";
import { creerFamilleRoutines } from "./familles/routines";
import { creerFamilleWebhooks } from "./familles/webhooks";
import { creerFamilleLlm } from "./familles/llm";
import { creerFamilleMcp } from "./familles/mcp";
import { familleOutils } from "./familles/outils";
import { creerFamilleSkills } from "./familles/skills";
import { creerFamilleMetriques } from "./familles/metriques";
import { creerFamilleUsage } from "./familles/usage";
import { creerFamilleNotifications } from "./familles/notifications";
import { creerFamilleCli } from "./familles/cli";
import { creerFamilleCode } from "./familles/code";
import { creerFamilleAdminRag } from "./familles/admin-rag";
import { creerFamilleRag } from "./familles/rag";
import { creerFamilleVoix } from "./familles/voix";
import { creerFamillesExploitation } from "./familles/exploitation";
import { brancherJobs } from "./jobs/branchements";
import { installerMaintenance } from "./ops/bascule";
import type { Journal } from "./journal";
import { brancherDiffusionLlm, brancherLlm } from "./llm/branchement";
import {
  arreterSondeModeles,
  peutVoirModeles,
  rafraichirModeles,
  surOuvertureFlux,
} from "./llm/cache-modeles";
import { comptesMemoire, installerComptesMemoire, installerIndexSessions } from "./memoire";
import { outilsMemoire } from "./memoire/mcp";
import { sessionIndexMessage } from "./memoire/sessions";
import type { ModeApp } from "./mode";
import { installerPublicationNotifications } from "./notifications/envoi";
import { brancherObservabilite } from "./observabilite/branchements";
import { brancherMoteurMetriques } from "./observabilite/demarrage";
import { brancherHistoriqueJournal, ecrivainDuProcess, journalAcces } from "./observabilite/journal-acces";
import { getCategories } from "./outils/categories";
import { brancherInvalidationOutils, brancherOutilsMcp, prechaufferOutilsMcp } from "./outils/mcp/clients";
import {
  creerServeurEnProcessus,
  enregistrerFamillesEnProcessus,
  oublierServeurEnProcessus,
  serveurEnProcessus,
  serviceEnProcessus,
} from "./outils/mcp/en-processus";
import { familleChart } from "./outils/mcp/famille-chart";
import { outilsSkill } from "./outils/mcp/famille-skill";
import { dependancesTodo } from "./outils/todo";
import { outilsTodo } from "./outils/todo/mcp";
import { creerRelais, familleJetonApercu } from "./relais";
import type { Relais } from "./relais";
import { ouvrirSessionHistorique } from "./relais/services";
import { brancherIndexationRag } from "./rag/service";
import { installerMeneur, Meneur, meneur } from "./routines/meneur";
import { installerPlanificateur, Planificateur } from "./routines/planificateur";
import type { Famille, Gardes } from "./routes";
import { installerComptesSkills } from "./skills/ports";
import { CLIENT_VOIX } from "./voix/client";
import { installerClientVoix } from "./voix/ports";

export interface Composition {
  readonly extensions: readonly Extension[];
  readonly gardes: Gardes;
  readonly familles: readonly Famille[];
  /** Bus du process : flux `/api/system-events`, canal interne, révocation, diffusion à tous les process. */
  readonly evenements: Evenements;
}

export interface OptionsComposition {
  /** Cycle de vie du process : arrêt des flux, empreinte de main et abonnement de l'admin au démarrage, fermeture du relais ; absent, un cycle jamais démarré. */
  readonly cycle?: CycleDeVie;
}

/** Réglages lus au démarrage et vue courante de config.json : le « Redémarrage nécessaire » de main. */
const SOURCE_REDEMARRAGE: SourceRedemarrage = {
  get lectures() {
    return config.BOOT_READ_PATHS;
  },
  prefixesChauds: HOT_RELOAD_PREFIXES,
  cheminsChauds: HOT_RELOAD_PATHS,
  brutDemarrage: bootRaw,
  vueCourante: configView,
};

/** `APP_SERVICE` (posé par `elpis`) en minuscules, sinon le mode : étiquette du process dans l'audit et le journal commun. */
export function serviceDuProcess(mode: ModeApp, env: NodeJS.ProcessEnv = process.env): string {
  return (env["APP_SERVICE"] ?? mode).toLowerCase() || mode;
}

/** `convert_legacy` de `_prepare`, une fois par process au démarrage : un échec est journalisé, jamais bloquant. */
export async function convertirJetonsAuDemarrage(
  base: Base,
  journal: Journal,
  maintenant = Date.now() / 1000,
): Promise<void> {
  try {
    const n = await convertirAnciensJetons(base, maintenant);
    if (n) journal.info(`[tokens] ${n} ancien(s) jeton(s) opencode converti(s) en empreinte`);
  } catch (e) {
    journal.warn({ err: e }, "[tokens] conversion des anciens jetons impossible");
  }
}

/** Journal d'audit du process : service `APP_SERVICE` (posé par `elpis`) ou le mode, dossier de repli sous la racine du dépôt. */
export function configurerAuditDuCore(
  mode: ModeApp,
  journal: Journal,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    configureAudit({
      service: serviceDuProcess(mode, env),
      auditDir: defaultAuditDir(env, racineDepot()),
      hmacKeyPath: defaultAuditKeyPath(env),
    });
  } catch (e) {
    journal.warn({ err: e }, "[audit] configuration impossible : audit sans signature HMAC");
  }
}

/** Ports de la mémoire lus dans la base du process : id du compte (gestionnaire), index plein texte des sessions. */
export function installerPortsMemoire(base: Base): void {
  installerComptesMemoire({ idUtilisateur: async (nom) => (await getUser(base, nom))?.id ?? null });
  installerIndexSessions({
    indexerMessage: async (m) => {
      await sessionIndexMessage(base, m);
    },
  });
}

/** Ports des skills : nom du compte et racine de sa sandbox (`_get_sandbox_path` : `<SANDBOX_DIR>/<nom sûr>`, créée au besoin). */
export function installerPortsSkills(base: Base): void {
  installerComptesSkills({
    nomUtilisateur: (uid) => getUsernameById(base, uid),
    racineSandbox: async (uid) => {
      const nom = (await getUsernameById(base, uid)) || `user_${uid}`;
      const racine = realpathPy(pyJoin(config.SANDBOX_DIR, safeSandboxName(nom)));
      await mkdir(racine, { recursive: true });
      return racine;
    },
  });
}

/** Familles du compte portées en TS (chart, memory, skill, todo) : enregistrées sur le serveur MCP en processus, qui sert les entrées `inprocess` du manifeste (défaut) ; une entrée à URL est servie par ce serveur distant. */
export function brancherFamillesDuCompte(base: Base): void {
  const comptes = { idUtilisateur: (nom: string) => comptesMemoire().idUtilisateur(nom) };
  enregistrerFamillesEnProcessus([
    familleChart(),
    ["memory", outilsMemoire({ base, comptes })],
    ["skill", outilsSkill()],
    ["todo", outilsTodo(dependancesTodo(base, comptes))],
  ]);
}

/** Ports du bureau : primitives branchées sur l'agent des postes, mémoire des ancres et comptes administrateurs lus dans la base. */
export function installerPortsBureau(base: Base): void {
  installerPrimitivesBureau(PRIMITIVES_AGENT);
  installerAncres(ancresDeLaBase(base));
  installerComptesBureau({ estAdmin: async (nom) => (await getUser(base, nom))?.is_admin === 1 });
}

/** Bus du process : journal commun écrit et suivi pour le staff, accès aux `model_status` ; dans main seul, sonde des modèles (flux et canal de l'admin) et révocation jusqu'aux terminaux relayés. */
function brancherBus(
  mode: ModeApp,
  cycle: CycleDeVie,
  auth: DependancesAuth,
  journal: Journal,
  racine: string,
  relais: Relais | undefined,
): Evenements {
  const cheminJournal = cheminJournalCommun(racine);
  let ecrireJournal = ecrivainDuProcess(cheminJournal);
  if (ecrireJournal === null) {
    const propre = ecrivainJournalCommun(cheminJournal, serviceDuProcess(mode));
    cycle.alArret("journal commun", () => propre.fermer());
    ecrireJournal = propre;
  }
  const commun = {
    cycle,
    auth,
    journal: journal.child({ domaine: "evenements" }),
    cheminJournal,
    ecrireJournal,
    peutVoirModeles,
  };
  if (mode === "admin") return brancherEvenements({ ...commun, mode });
  return brancherEvenements({
    ...commun,
    mode,
    surOuvertureFlux,
    redemarrage: SOURCE_REDEMARRAGE,
    fermerTerminaux: (uid) => relais?.fermerTerminauxDuCompte(uid) ?? 0,
    rafraichirModeles,
  });
}

/** Vue d'ensemble de la console : sondes et faits réels, réglages en attente lus auprès de main. */
function vueAdmin(
  base: Base,
  journal: Journal,
  racine: string,
  evenements: Evenements,
  auth: DependancesAuth,
): DependancesAdminVue {
  const maintenant = (): number => (auth.maintenant ? auth.maintenant() : Date.now() / 1000);
  const enAttente = async (): Promise<string[]> =>
    evenements.empreinte
      ? evenements.empreinte.pending()
      : evenements.versMain
        ? ((await lireStatutMain(evenements.versMain))?.pending ?? [])
        : [];
  return {
    base,
    journal,
    racine,
    sondes: sondesParDefaut({ base, journal }),
    faits: faitsParDefaut({ base, journal, maintenant, enAttente }),
    cheminsRedemarrage: () =>
      restartPaths(
        SOURCE_REDEMARRAGE.lectures,
        SOURCE_REDEMARRAGE.prefixesChauds,
        SOURCE_REDEMARRAGE.cheminsChauds,
      ),
    journalRecent: () => evenements.systemEvents.getRecentLogs(),
    maintenant,
  };
}

/** Planificateur des routines : dans main seul, leader unique entre process (verrou rendu dès l'annonce de l'arrêt), démarré au cycle, runs drainés à l'arrêt. */
export function brancherPlanificateur(mode: ModeApp, base: Base, cycle: CycleDeVie): Planificateur {
  const meneur = new Meneur({ arret: cycle.signalArret });
  const planificateur = new Planificateur({ base, meneur });
  if (mode !== "main") return planificateur;
  installerMeneur(meneur);
  installerPlanificateur(planificateur);
  cycle.auDemarrage("planificateur des routines", () => planificateur.demarrer(cycle.signalArret), {
    modes: ["main"],
    arrierePlan: true,
  });
  cycle.alArret("planificateur des routines", () => planificateur.arreter());
  return planificateur;
}

/** Pré-chauffage des outils MCP au démarrage de main seul, en arrière-plan (`prewarm_mcp_pool`) ; `MCP_PREWARM=0` le coupe. */
export function brancherPrechauffageMcp(
  mode: ModeApp,
  cycle: CycleDeVie,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (mode !== "main" || ["0", "false", "no", ""].includes((env["MCP_PREWARM"] ?? "1").trim().toLowerCase()))
    return;
  cycle.auDemarrage(
    "pré-chauffage des outils MCP",
    async () => {
      try {
        await prechaufferOutilsMcp({ signal: cycle.signalArret });
      } catch (e) {
        if (!cycle.signalArret.aborted) throw e;
      }
    },
    { modes: ["main"], arrierePlan: true },
  );
}

/** Ce que `creerApp` monte pour ce mode ; les familles et extensions des autres lots s'ajoutent ici. */
export async function composer(
  mode: ModeApp,
  base: Base,
  journal: Journal,
  dep: DependancesAuth & DependancesJetons = dependancesParDefaut(base, jetonServiceDuManifeste),
  racine: string = racineDepot(),
  options: OptionsComposition = {},
): Promise<Composition> {
  configurerAuditDuCore(mode, journal);
  brancherGardeUrl((url, schemas) => blockRemoteUrlReason(url, { allowSchemes: schemas }));
  await convertirJetonsAuDemarrage(base, journal);
  installerPortsMemoire(base);
  installerPortsSkills(base);
  installerPortsBureau(base);
  const jc = journal.child({ domaine: "comptes" });
  const auth: DependancesAuth & DependancesJetons = {
    avertir: (message, erreur) => jc.warn({ err: erreur }, message),
    informer: (message) => jc.info(message),
    ...dep,
  };
  const jr = journal.child({ domaine: "sandbox-relay" });
  const comptes: DependancesComptes = {
    auth,
    racine,
    mandataires: mandatairesDuJournal(),
    journal: jc,
    mode,
    libellesCategories: () => Object.fromEntries(getCategories(true).map((c) => [c.name, c.label || c.name])),
    demarrerHistoriqueFichiers: async (uid) => void (await ouvrirSessionHistorique(uid, { journal: jr })),
  };
  const cycle = options.cycle ?? new CycleDeVie(journal.child({ domaine: "cycle" }));
  const planificateur = brancherPlanificateur(mode, base, cycle);
  brancherPrechauffageMcp(mode, cycle);
  const relais = mode === "main" ? creerRelais({ journal: jr, arret: cycle.signalArret, auth }) : undefined;
  if (relais !== undefined) cycle.alArret("relais vers l'hôte d'outils", () => relais.fermer());
  cycle.alArret("connexions aux agents bureau", () => fermerAgentsBureau());
  cycle.signalArret.addEventListener("abort", () => arreterSondeModeles(), { once: true });
  const evenements = brancherBus(mode, cycle, auth, journal, racine, relais);
  const metriques = brancherMoteurMetriques({
    mode,
    base,
    cycle,
    evenements,
    journal: journal.child({ domaine: "metrics" }),
  });
  installerPublicationNotifications(async (message) => void (await evenements.diffuserPartout(message)));
  brancherIndexationRag(mode, base, cycle, {
    diffuser: (message) => evenements.diffuserPartout(message),
    meneur: mode === "main" ? meneur() : null,
  });
  const jobs = mode === "main" ? brancherJobs(base, cycle, (m) => evenements.diffuserPartout(m)) : null;
  brancherHistoriqueJournal((niveau, message, date) =>
    evenements.systemEvents.noterLigneJournal(niveau, message, date),
  );
  brancherLlm(base);
  brancherDiffusionLlm({ systemEvents: evenements.systemEvents, versMain: evenements.versMain });
  brancherBoucle(base);
  brancherContexte(base);
  brancherExecutions(base);
  brancherTour();
  brancherObservabilite(base);
  brancherOutilsMcp();
  brancherInvalidationOutils();
  installerClientVoix(CLIENT_VOIX);
  const llm = { base, auth, journal: journal.child({ domaine: "llm" }), arret: cycle.signalArret };
  const oauth: DependancesOAuth = {
    base,
    config: () => auth.config(),
    avertir: (message, erreur) => jc.warn({ err: erreur }, message),
    maintenant: () => (auth.maintenant ? auth.maintenant() : Date.now() / 1000),
  };
  if (mode !== "admin" && serveurEnProcessus() === null) {
    creerServeurEnProcessus();
    brancherFamillesDuCompte(base);
    cycle.alArret("serveur MCP en processus", async () => {
      await serviceEnProcessus()?.fermer();
      oublierServeurEnProcessus();
    });
  }
  const pont = creerPontMcp({
    jetons: auth,
    oauth,
    journal: journal.child({ domaine: "mcp-proxy" }),
    arret: cycle.signalArret,
    enProcessus: () => serviceEnProcessus(),
  });
  const code = {
    base,
    auth,
    bus: evenements.pipelineEvents,
    journal: journal.child({ domaine: "code" }),
    arret: cycle.signalArret,
  };
  return {
    extensions: [
      ...(ecrivainDuProcess() === null
        ? []
        : [journalAcces({ service: serviceDuProcess(mode), mandataires: comptes.mandataires })]),
      (app) => installerMaintenance(app),
      (app) => installerAuth(app, auth),
      pont.extension,
    ],
    gardes: creerGardes(auth),
    familles: [
      ...famillesParDefaut(mode),
      creerFamilleComptes(comptes),
      creerFamilleJetons(comptes),
      creerFamilleOAuth({ auth, oauth }),
      pont.famille,
      creerFamilleOpenapi({ jetons: auth, journal: journal.child({ domaine: "openapi" }) }),
      creerFamilleChats({
        base,
        generationEnCours: (uid, chatId) => isGenerationActive(uid, chatId),
        ...(jobs
          ? { reveilCoupe: (uid: number, chatId: string) => jobs.reveilPoseSurLeChat(uid, chatId) }
          : {}),
      }),
      creerFamillePrompts({ base }),
      creerFamilleLlm(llm),
      creerFamilleMcp({ base }),
      creerFamilleMemoire({ base }),
      creerFamilleAx({ base }),
      creerFamilleSkills({ base }),
      evenements.famille,
      ...(relais === undefined ? [] : [relais.famille, familleJetonApercu]),
      creerFamilleNotifications({ base }),
      creerFamilleApparence({ base }),
      creerFamilleGraphiques({ base }),
      creerFamilleExecutions({ base }),
      creerFamilleChatControle({ base, auth, arret: cycle.signalArret }),
      creerFamilleImages({ base }),
      creerFamilleAdminImages(),
      creerFamilleChat({ base, auth, arret: cycle.signalArret }),
      creerFamilleChatCompression({ base }),
      ...(mode === "main"
        ? [
            creerFamilleCode(code),
            creerFamilleCli({ base, auth, journal: code.journal }),
            creerFamilleVoix({ base }),
            creerFamilleRag({ base }),
            creerFamilleBureau({ base, auth }),
          ]
        : []),
      familleOutils,
      creerFamilleConfig({ auth, racine }),
      creerFamilleInterneToolhost({ auth, journal: journal.child({ domaine: "interne" }) }),
      ...(jobs
        ? [creerFamilleInterneJobs({ auth, service: jobs }), creerFamilleJobs({ service: jobs })]
        : []),
      creerFamilleGit({ base }),
      creerFamilleAdminComptes({
        base,
        auth,
        journal: journal.child({ domaine: "admin" }),
        revoquer: (uid) => evenements.revoquer(uid),
        bac: piloteBac(),
      }),
      creerFamilleAdminSecurite({
        base,
        auth,
        journal: journal.child({ domaine: "admin" }),
        revoquer: (uid) => evenements.revoquer(uid),
        diffuser: (message) => evenements.diffuserPartout(message),
      }),
      creerFamilleAdminConfig({ journal: journal.child({ domaine: "admin" }) }),
      creerFamilleAdminVue(vueAdmin(base, journal.child({ domaine: "admin" }), racine, evenements, auth)),
      creerFamilleRoutines({ base, planificateur }),
      creerFamilleWebhooks({ base, planificateur }),
      creerFamilleAdminLlm({ base, journal: journal.child({ domaine: "admin" }) }),
      creerFamilleAdminExecuteurs({ base, journal: journal.child({ domaine: "admin" }) }),
      creerFamilleAdminAgents({ journal: journal.child({ domaine: "admin" }) }),
      creerFamilleAdminIntegrations({ journal: journal.child({ domaine: "admin" }) }),
      creerFamilleAdminRag({ base }),
      creerFamilleUsage({ base }),
      creerFamilleMetriques({ base, auth, contexte: metriques.contexte }),
      ...creerFamillesExploitation({
        base,
        cycle,
        journal,
        evenements,
        contexteMetriques: metriques.contexte,
      }),
    ],
    evenements,
  };
}
