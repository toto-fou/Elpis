// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/bac.ts — navigateur dans le bac d'un compte (mode « sandbox ») : service démarré au premier outil pw_* (jeton du bac, certificat de l'autorité), relais des secrets du compte sur l'hôte, liaisons des secrets en usage ; le mode central passe tel quel. */
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
  MONTAGES_NAVIGATEUR,
} from "@elpis/bac";
import type { UserSandbox } from "@elpis/bac";
import { journalDe } from "@elpis/commun";
import { liveConfigValue } from "@elpis/config";
import {
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
};

/** Surcharges de test : juge des destinations du relais, autorité (sinon celle de l'instance). */
export const injectionsNavigateurBac: {
  juge: ((username: string) => JugeRelais) | null;
  autorite: Autorite | null;
  caAmont: readonly string[] | null;
} = { juge: null, autorite: null, caAmont: null };

interface EtatCompte {
  relais: RelaisNavigateur | null;
  /** Bac du compte au dernier appel : son profil réseau courant juge les destinations du relais. */
  bac: UserSandbox | null;
  demarrage: Promise<void> | null;
  activite: number;
  /** Instant de démarrage du service connu (uptime) : un autre signale une relance, les liaisons sont oubliées. */
  debut: number;
}

const etats = new Map<string, EtatCompte>();
let autorite: Autorite | null = null;

/** Panne du navigateur du bac, rendue au modèle par l'outil. */
export class ErreurNavigateurBac extends Error {
  override readonly name = "ErreurNavigateurBac";
}

function etatDe(username: string): EtatCompte {
  let e = etats.get(username);
  if (e === undefined) {
    e = { relais: null, bac: null, demarrage: null, activite: 0, debut: 0 };
    etats.set(username, e);
  }
  return e;
}

/** Autorité de l'instance (chargée ou créée une fois par processus). */
export function autoriteInstance(): Autorite {
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

/** Relais du compte à l'écoute (rouvert si le bac a retiré son socket). */
async function relaisDuCompte(e: EtatCompte, username: string, jeton: string): Promise<RelaisNavigateur> {
  const c = cheminsNavigateurBac(username);
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
  const sb = await bacDuCompteOutil(username);
  e.bac = sb;
  const st = await sb.ensureRunning();
  if (!st.running) throw new ErreurNavigateurBac(`the sandbox of ${username} is not running`);
  const c = cheminsNavigateurBac(username);
  const jetonRelais = jetonFichier(`${c.dossier}/.browser-relay.token`);
  await relaisDuCompte(e, username, jetonRelais);
  const rotation = poserCertificat(c.ca, autoriteInstance().certPem);
  const jeton = jetonFichier(c.jeton);
  const service: ServiceNavigateur = { mode: "sandbox", base: "http://browser", socket: c.socket, jeton };
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
    BROWSER_SANDBOX: "1",
    FIREFOX_SERVICE_SOCKET: BROWSER_SOCKET,
    BROWSER_SERVICE_TOKEN: jeton,
    BROWSER_RELAY_SOCKET,
    BROWSER_RELAY_TOKEN: jetonRelais,
    PLAYWRIGHT_BROWSERS_PATH: MONTAGES_NAVIGATEUR.playwright,
    BROWSER_DOWNLOAD_DIR: BROWSER_DOWNLOADS,
    BROWSER_IDLE_EXIT_S: String(inactiviteS()),
    NODE_EXTRA_CA_CERTS: BROWSER_CA_CERT,
    APP_CONFIG_PATH: `${MONTAGES_NAVIGATEUR.service}/.no-config.json`,
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
    `the browser service did not start in the sandbox of ${username} (log: /work/.elpis-browser/service.log)`,
  );
}

/** Service relancé (uptime inconnu ou revenu en arrière) : secrets liés oubliés, les sessions d'avant n'existent plus. */
function noterDebut(e: EtatCompte, uptimeS: number): void {
  const debut = Date.now() - uptimeS * 1000;
  if (e.debut !== 0 && Math.abs(debut - e.debut) > 5_000) e.relais?.oublierTout();
  e.debut = debut;
}

/** Service navigateur du compte pour un outil pw_* : central tel quel ; en mode bac, service et relais assurés, activité comptée au bac. */
export async function serviceDuCompte(username: string): Promise<ServiceNavigateur> {
  const s = serviceNavigateur(username);
  if (s.mode === "central") return s;
  const e = etatDe(username);
  e.demarrage ??= assurer(username, e).finally(() => {
    e.demarrage = null;
  });
  await e.demarrage;
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

/** Tests et arrêt : relais fermés, états oubliés. */
export async function arreterNavigateursBac(): Promise<void> {
  const tous = [...etats.values()];
  etats.clear();
  autorite = null;
  await Promise.all(tous.map((e) => e.relais?.fermer() ?? Promise.resolve()));
}
