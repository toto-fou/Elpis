// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/bac.ts — navigateur dans le bac d'un compte : service démarré au premier outil pw_* (jeton du bac, certificat de l'autorité), relais des secrets du compte sur l'hôte, liaisons des secrets en usage ; bac indisponible dit au modèle avec le correctif. */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";

import {
  BROWSER_CA_CERT,
  BROWSER_DOWNLOADS,
  BROWSER_RELAY_SOCKET,
  BROWSER_SOCKET,
  ErreurLancement,
  MONTAGES_NAVIGATEUR,
  montagesNavigateur,
} from "@elpis/bac";
import type { EtatBac, UserSandbox } from "@elpis/bac";
import { journalDe } from "@elpis/commun";
import { liveConfigValue } from "@elpis/config";
import {
  autoriteARenouveler,
  chargerAutorite,
  cheminsNavigateurBac,
  jetonDuBac,
  jugeRelaisBac,
  RelaisNavigateur,
  requeteService,
  serviceNavigateur,
} from "@elpis/navigateur";
import type { Autorite, JugeRelais, LiaisonRelais, ServiceNavigateur } from "@elpis/navigateur";

import { bacDuCompteOutil } from "../espace";

const log = (): ReturnType<typeof journalDe> => journalDe("browser");

/** Délais du démarrage ; réglables par les tests. */
export const reglagesNavigateurBac = {
  /** Attente du service après son lancement (ms). */
  demarrageMs: 45_000,
  /** Intervalle des sondes pendant cette attente (ms). */
  sondeMs: 200,
  /** Activité du compte poussée au bac au plus une fois par période (ms). */
  activiteMs: 60_000,
  /** Relais d'un compte sans appel rendu après l'arrêt de son service pour inactivité, plus cette marge (ms). */
  margeInactiviteMs: 60_000,
  /** Période du balayage des relais inactifs (ms). */
  balayageMs: 60_000,
};

/** Surcharges de test : juge des destinations du relais, autorité (sinon celle de l'instance), service déjà joignable d'un compte (ni bac ni relais démarrés). */
export const injectionsNavigateurBac: {
  juge: ((username: string) => JugeRelais) | null;
  autorite: Autorite | null;
  caAmont: readonly string[] | null;
  service: ((username: string) => ServiceNavigateur) | null;
} = { juge: null, autorite: null, caAmont: null, service: null };

interface EtatCompte {
  relais: RelaisNavigateur | null;
  /** Bac du compte au dernier appel : son profil réseau courant juge les destinations du relais. */
  bac: UserSandbox | null;
  demarrage: Promise<void> | null;
  activite: number;
  /** Instant de démarrage du service connu (uptime) : un autre signale une relance, les liaisons sont oubliées. */
  debut: number;
  /** Dernier outil pw_* du compte (ms). */
  dernierAppel: number;
}

const etats = new Map<string, EtatCompte>();
let autorite: Autorite | null = null;

const FIX_RELANCE =
  "Retry once; if it fails again, tell the user (an administrator can read /work/.elpis-browser/service.log and run ./elpis doctor).";

/** Panne du navigateur du bac, rendue au modèle par l'outil avec son correctif. */
export class ErreurNavigateurBac extends Error {
  override readonly name = "ErreurNavigateurBac";
  readonly fix: string;

  constructor(message: string, fix = FIX_RELANCE) {
    super(message);
    this.fix = fix;
  }
}

/** Message d'un démarrage du navigateur en échec, avec le détail de la panne. */
export function demarrageImpossible(panne: unknown): string {
  return `The browser of your sandbox could not be started: ${panne instanceof Error ? panne.message : String(panne)}.`;
}

/** Bac qui ne démarre pas : Docker absent ou arrêté, image absente (sondés), sinon le détail de la panne. */
export async function bacIndisponible(sb: UserSandbox, panne: unknown): Promise<ErreurNavigateurBac> {
  const code = (args: string[]): Promise<number> =>
    sb.cli.call(args, { timeoutS: 10 }).then(
      ([rc]) => rc,
      () => -1,
    );
  if (panne instanceof ErreurLancement || (await code(["version", "--format", "{{.Server.Version}}"])) !== 0)
    return new ErreurNavigateurBac(
      "Docker is not available on the Elpis server (not installed or not running), and the browser only runs inside your sandbox.",
      "Tell the user: an administrator installs or starts Docker, then checks ./elpis doctor.",
    );
  if ((await code(["image", "inspect", sb.cfg.image])) !== 0)
    return new ErreurNavigateurBac(
      `The sandbox image ${sb.cfg.image} is not available on the Elpis server, and the browser only runs inside your sandbox.`,
      "Tell the user: an administrator builds or loads it (./install.sh --sandbox build, or deploy/docker/sandbox/load_image.sh), then checks ./elpis doctor.",
    );
  return new ErreurNavigateurBac(
    demarrageImpossible(panne ?? `the sandbox of ${sb.username} is not running`),
  );
}

function etatDe(username: string): EtatCompte {
  let e = etats.get(username);
  if (e === undefined) {
    e = { relais: null, bac: null, demarrage: null, activite: 0, debut: 0, dernierAppel: Date.now() };
    etats.set(username, e);
  }
  return e;
}

/** Autorité de l'instance (chargée ou créée une fois par processus, renouvelée quand son terme approche). */
export function autoriteInstance(): Autorite {
  if (autorite !== null && injectionsNavigateurBac.autorite === null && autoriteARenouveler(autorite))
    autorite = null;
  autorite ??= injectionsNavigateurBac.autorite ?? chargerAutorite();
  return autorite;
}

/** Jeton d'un fichier de l'hôte (0600), créé s'il manque. */
function jetonFichier(chemin: string): string {
  const lu = jetonDuBac(chemin);
  if (lu) return lu;
  const j = randomBytes(32).toString("hex");
  writeFileSync(chemin, j + "\n", { mode: 0o600 });
  return j;
}

/** Certificat de l'autorité posé dans le dossier de l'agent du bac (où le bac écrit) s'il manque ou diffère, sans jamais suivre de lien : lu en O_NOFOLLOW|O_NONBLOCK (fichier ordinaire seul), écrit dans un temporaire O_EXCL|O_NOFOLLOW renommé sur la cible (rename remplace un lien sans le suivre) ; vrai s'il a changé (rotation). */
export function poserCertificat(chemin: string, pem: string): boolean {
  let present = false;
  try {
    const fd = openSync(chemin, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      present = st.isFile();
      if (present && st.size === Buffer.byteLength(pem) && readFileSync(fd, "utf8") === pem) return false;
    } finally {
      closeSync(fd);
    }
  } catch {
    // absent, lien ou autre type : remplacé
  }
  const tmp = `${chemin}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    writeSync(fd, pem);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, chemin);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return present;
}

/** Minutes sans appel avant l'arrêt du service du bac (`browser.sandbox_idle_minutes`, 15 par défaut). */
function inactiviteS(): number {
  const n = Number(liveConfigValue("browser.sandbox_idle_minutes", 15));
  return Math.max(1, Number.isFinite(n) ? Math.round(n * 60) : 900);
}

/** Durée de vie d'une liaison au relais sans appel du compte : celle du service du bac (il s'arrête au même terme), prolongée à chaque outil pw_*. */
export function dureeLiaisonMs(): number {
  return inactiviteS() * 1000;
}

/** Relais du compte à l'écoute (rouvert si le bac a retiré son socket). */
async function relaisDuCompte(e: EtatCompte, username: string, jeton: string): Promise<RelaisNavigateur> {
  const c = cheminsNavigateurBac(username);
  // Autorité renouvelée : relais recréé (ses certificats viennent de l'ancienne) ; le service, relancé par la rotation du certificat, s'y raccroche.
  if (e.relais !== null && e.relais.empreinteAutorite !== autoriteInstance().empreinte) {
    await e.relais.fermer();
    e.relais = null;
  }
  if (e.relais === null) {
    const profil = (): ReturnType<Parameters<typeof jugeRelaisBac>[0]> =>
      e.bac?.networkProfile ?? { id: "isolated", mode: "none", ips: [], domains: [], ports: [] };
    e.relais = new RelaisNavigateur({
      socket: c.relais,
      jeton,
      juger: injectionsNavigateurBac.juge?.(username) ?? jugeRelaisBac(profil),
      autorite: autoriteInstance(),
      journal: (m) => log().warn(`[relay ${username}] ${m}`),
      ...(injectionsNavigateurBac.caAmont ? { caAmont: injectionsNavigateurBac.caAmont } : {}),
    });
    await e.relais.ouvrir();
  } else if (!e.relais.ecoute()) await e.relais.rouvrir();
  return e.relais;
}

async function sante(s: ServiceNavigateur): Promise<{ ok: boolean; refus: boolean; uptime: number }> {
  try {
    const r = await requeteService(s, "/health", { delaiMs: 3_000 });
    if (r.statut === 401 || r.statut === 503) return { ok: false, refus: true, uptime: 0 };
    const d = JSON.parse(r.corps.toString("utf8")) as { ok?: unknown; uptime_sec?: unknown };
    return { ok: r.statut === 200 && d.ok === true, refus: false, uptime: Number(d.uptime_sec) || 0 };
  } catch {
    return { ok: false, refus: false, uptime: 0 };
  }
}

/** Service du bac du compte en marche : conteneur, relais, certificat, jetons, puis service lancé et attendu s'il ne répond pas. */
async function assurer(username: string, e: EtatCompte): Promise<void> {
  if (montagesNavigateur() === null)
    throw new ErreurNavigateurBac(
      "The browser is not installed on the Elpis server (browser-service, its Node modules, the Node runtime or the Chromium headless shell is missing).",
      "Tell the user: an administrator installs it (./install.sh --with-browser), then checks ./elpis doctor.",
    );
  const sb = await bacDuCompteOutil(username);
  e.bac = sb;
  let st: EtatBac;
  try {
    st = await sb.ensureRunning();
  } catch (x) {
    throw await bacIndisponible(sb, x);
  }
  if (!st.running) throw await bacIndisponible(sb, null);
  const c = cheminsNavigateurBac(username);
  const jetonRelais = jetonFichier(`${c.dossier}/.browser-relay.token`);
  await relaisDuCompte(e, username, jetonRelais);
  const rotation = poserCertificat(c.ca, autoriteInstance().certPem);
  const jeton = jetonFichier(c.jeton);
  const service: ServiceNavigateur = { socket: c.socket, jeton };
  const avant = await sante(service);
  if (avant.ok && !rotation) {
    noterDebut(e, avant.uptime);
    return;
  }
  // Jeton refusé, ou autorité renouvelée (le service n'importe le certificat qu'au démarrage) : service relancé.
  if (avant.refus || avant.ok) {
    await sb.stopNavigateur().catch(() => undefined);
    for (let i = 0; i < 50 && (await sante(service)).ok; i++) await new Promise((ok) => setTimeout(ok, 100));
  }
  const t0 = performance.now();
  await sb.startNavigateur({
    FIREFOX_SERVICE_SOCKET: BROWSER_SOCKET,
    BROWSER_SERVICE_TOKEN: jeton,
    BROWSER_RELAY_SOCKET,
    BROWSER_RELAY_TOKEN: jetonRelais,
    PLAYWRIGHT_BROWSERS_PATH: MONTAGES_NAVIGATEUR.playwright,
    BROWSER_DOWNLOAD_DIR: BROWSER_DOWNLOADS,
    BROWSER_IDLE_EXIT_S: String(inactiviteS()),
    NODE_EXTRA_CA_CERTS: BROWSER_CA_CERT,
  });
  for (const fin = Date.now() + reglagesNavigateurBac.demarrageMs; Date.now() < fin;) {
    await new Promise((ok) => setTimeout(ok, reglagesNavigateurBac.sondeMs));
    const s = await sante(service);
    if (s.ok) {
      log().info(
        `[browser] ${username}: service started in its sandbox (${Math.round(performance.now() - t0)} ms)`,
      );
      noterDebut(e, s.uptime);
      return;
    }
  }
  throw new ErreurNavigateurBac(
    demarrageImpossible(
      `the browser service did not start in the sandbox of ${username} (log: /work/.elpis-browser/service.log)`,
    ),
  );
}

/** Service relancé (uptime inconnu ou revenu en arrière) : secrets liés oubliés, les sessions d'avant n'existent plus. */
function noterDebut(e: EtatCompte, uptimeS: number): void {
  const debut = Date.now() - uptimeS * 1000;
  if (e.debut !== 0 && Math.abs(debut - e.debut) > 5_000) e.relais?.oublierTout();
  e.debut = debut;
}

/** Service navigateur du bac du compte, sans le démarrer (captures) ; celui des tests s'il est injecté. */
export function serviceLu(username: string): ServiceNavigateur {
  return injectionsNavigateurBac.service?.(username) ?? serviceNavigateur(username);
}

/** Service navigateur du compte pour un outil pw_* : bac, service et relais assurés, activité comptée au bac ; `ErreurNavigateurBac` si le bac ne peut pas servir. */
export async function serviceDuCompte(username: string): Promise<ServiceNavigateur> {
  const injecte = injectionsNavigateurBac.service?.(username);
  if (injecte !== undefined) return injecte;
  const e = etatDe(username);
  e.dernierAppel = Date.now();
  veiller();
  e.demarrage ??= assurer(username, e).finally(() => {
    e.demarrage = null;
  });
  await e.demarrage;
  e.relais?.prolonger(dureeLiaisonMs());
  if (Date.now() - e.activite > reglagesNavigateurBac.activiteMs) {
    e.activite = Date.now();
    void bacDuCompteOutil(username)
      .then((sb) => sb.marquerActivite())
      .catch(() => undefined);
  }
  return serviceNavigateur(username);
}

/** Lie un secret en usage au relais du compte (ses origines y sont déchiffrées) ; faux sans relais. */
export function lierAuRelais(username: string, l: LiaisonRelais): boolean {
  const r = etats.get(username)?.relais ?? null;
  if (r === null) return false;
  r.lier(l);
  return true;
}

/** Relais du compte (armement d'une connexion, bilan), `null` sans relais. */
export function relaisDe(username: string): RelaisNavigateur | null {
  return etats.get(username)?.relais ?? null;
}

/** Oublie des liaisons du relais d'un compte. */
export function oublierAuRelais(username: string, ids: readonly string[]): void {
  const r = etats.get(username)?.relais ?? null;
  for (const id of ids) r?.oublier(id);
}

let veille: NodeJS.Timeout | null = null;

/** Balayage périodique des relais inactifs, tant qu'un compte a un état. */
function veiller(): void {
  veille ??= setInterval(() => void balayerNavigateursBac(), reglagesNavigateurBac.balayageMs);
  veille.unref();
}

/** Rend les relais des comptes sans outil pw_* depuis l'arrêt de leur service pour inactivité (plus une marge) : liaisons oubliées, socket fermé ; comptes rendus. */
export async function balayerNavigateursBac(maintenant = Date.now()): Promise<string[]> {
  const rendus: string[] = [];
  for (const [u, e] of [...etats]) {
    if (e.demarrage !== null) continue;
    if (maintenant - e.dernierAppel <= dureeLiaisonMs() + reglagesNavigateurBac.margeInactiviteMs) continue;
    etats.delete(u);
    rendus.push(u);
    await e.relais?.fermer().catch(() => undefined);
    log().info(`[browser] ${u}: idle, secret relay released`);
  }
  if (etats.size === 0 && veille !== null) {
    clearInterval(veille);
    veille = null;
  }
  return rendus;
}

/** Tests : relais posé pour un compte comme après un démarrage, dernier appel à `dernierAppel`. */
export function poserRelaisPourTests(username: string, relais: RelaisNavigateur, dernierAppel: number): void {
  const e = etatDe(username);
  e.relais = relais;
  e.dernierAppel = dernierAppel;
}

/** Tests et arrêt : relais fermés, états oubliés. */
export async function arreterNavigateursBac(): Promise<void> {
  const tous = [...etats.values()];
  etats.clear();
  autorite = null;
  if (veille !== null) clearInterval(veille);
  veille = null;
  await Promise.all(tous.map((e) => e.relais?.fermer() ?? Promise.resolve()));
}
