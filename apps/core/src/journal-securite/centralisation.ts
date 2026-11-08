// SPDX-License-Identifier: MIT
/** apps/core/src/journal-securite/centralisation.ts — agent syslog de l'hôte (rsyslog ou syslog-ng) et règle qui envoie le journal de sécurité, lus sans privilège, en une passe linéaire ; résultat gardé 60 s. */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

import { sansBarresFinales } from "../llm/client-http";

export type AgentSyslog = "rsyslog" | "syslog-ng";

export interface EtatCentralisation {
  agent: AgentSyslog | null;
  /** Service actif selon systemd ; `null` sans réponse de systemd. */
  actif: boolean | null;
  /** Fichier de configuration qui lit le journal de sécurité d'Elpis. */
  regle: string | null;
  /** Action d'envoi de cette règle (rsyslog seulement) : collecteur, transport, file. */
  envoi?: EnvoiCentralisation | null;
}

export interface EnvoiCentralisation {
  /** `hôte:port` du collecteur. */
  collecteur: string | null;
  /** Par exemple « TCP + TLS (x509/name) », « RELP + TLS », « UDP ». */
  transport: string;
  /** File de l'action : type rsyslog, nom du fichier de file et plafond disque, ou `null` si directe. */
  file: { type: string; fichier: string | null; max_disque: string | null } | null;
}

export interface OptionsCentralisation {
  /** Préfixe des chemins de /etc (tests). */
  racine?: string;
  /** Dossier du journal de sécurité : la règle doit lire ses fichiers (sinon toute règle `elpis-audit` compte). */
  dossierAudit?: string;
  estActif?: (unite: string) => Promise<boolean | null>;
}

const AGENTS: readonly { agent: AgentSyslog; fichier: string; dossier: string }[] = [
  { agent: "rsyslog", fichier: "/etc/rsyslog.conf", dossier: "/etc/rsyslog.d" },
  { agent: "syslog-ng", fichier: "/etc/syslog-ng/syslog-ng.conf", dossier: "/etc/syslog-ng/conf.d" },
];
const DUREE_CACHE_MS = 60_000;
const TAILLE_MAX = 256 * 1024;

let cache: { cle: string; valeur: EtatCentralisation; expire: number } | null = null;

/** `systemctl is-active` : vrai, faux, ou `null` si systemd ne répond pas en 2 s. */
function serviceActif(unite: string): Promise<boolean | null> {
  return new Promise((resoudre) => {
    execFile("systemctl", ["is-active", "--quiet", unite], { timeout: 2000 }, (e) => {
      if (!e) return resoudre(true);
      const code = (e as NodeJS.ErrnoException & { code?: unknown }).code;
      resoudre(typeof code === "number" ? false : null);
    });
  });
}

/** Début (256 Kio au plus) d'un fichier ordinaire, ouvert sans attendre (FIFO) ; `null` pour un autre type de fichier ou en cas d'erreur. */
export async function lireFichierBorne(chemin: string): Promise<string | null> {
  let fichier;
  try {
    fichier = await open(chemin, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!(await fichier.stat()).isFile()) return null;
    const tampon = Buffer.alloc(TAILLE_MAX);
    let lus = 0;
    while (lus < TAILLE_MAX) {
      const { bytesRead } = await fichier.read(tampon, lus, TAILLE_MAX - lus, lus);
      if (bytesRead === 0) break;
      lus += bytesRead;
    }
    return tampon.subarray(0, lus).toString("utf8");
  } catch {
    return null;
  } finally {
    await fichier?.close().catch(() => undefined);
  }
}

const CIBLE_EXEMPLE = "collector.example.lan";
/** Bornes d'un fichier : au-delà, il ne contient « pas de règle ». */
const MAX_OBJETS = 10_000;
const MAX_RULESETS = 1_000;
const MAX_APPELS = 10_000;
/** Niveaux de `call` suivis depuis le ruleset de l'entrée. */
const NIVEAUX_CALL = 3;

interface Lexeme {
  sorte: "mot" | "chaine" | "signe";
  v: string;
}
type Parametres = Map<string, string>;
interface Ruleset {
  /** Première action `omfwd` ou `omrelp` à cible non vide du corps. */
  envoi: Parametres | null;
  appels: string[];
  /** `stop` ou `~` non conditionnel au premier niveau : la suite du corps n'est pas lue. */
  arrete: boolean;
}

const SIGNES = new Set(["(", ")", "{", "}", "[", "]", "=", ",", ";"]);
const FIN_MOT = new Set([...SIGNES, '"', "'", "#"]);
const DEBUT_EXPRESSION = new Set(["if", "set", "unset", "reset", "foreach", "call_indirect"]);
const FIN_EXPRESSION = new Set(["then", "do"]);

/** Lexèmes et texte sans commentaires (`#`, `/* … *\/`) d'une configuration, en une passe ; `null` si une chaîne, un commentaire, une parenthèse ou une accolade n'est pas fermé. */
function analyser(texte: string): { lexemes: Lexeme[]; propre: string } | null {
  const lexemes: Lexeme[] = [];
  const morceaux: string[] = [];
  const n = texte.length;
  let garde = 0;
  let debutLigne = true;
  let expression = false;
  let parentheses = 0;
  let accolades = 0;
  let i = 0;
  while (i < n) {
    const c = texte.charAt(i);
    if (c <= " " || c === "\uFEFF") {
      if (c === "\n") debutLigne = true;
      i++;
      continue;
    }
    const enTete = debutLigne;
    const apostrophe = expression || parentheses > 0;
    debutLigne = false;
    if (c === "#" || (c === "/" && texte.charAt(i + 1) === "*")) {
      const fin = c === "#" ? texte.indexOf("\n", i) : texte.indexOf("*/", i + 2);
      if (fin < 0 && c === "/") return null;
      morceaux.push(texte.slice(garde, i), " ");
      i = fin < 0 ? n : c === "#" ? fin : fin + 2;
      garde = i;
    } else if (c === '"' || (c === "'" && apostrophe)) {
      let j = i + 1;
      while (j < n && texte.charAt(j) !== c) j += texte.charAt(j) === "\\" ? 2 : 1;
      if (j >= n) return null;
      lexemes.push({ sorte: "chaine", v: texte.slice(i + 1, j) });
      i = j + 1;
    } else if (
      c === "$" &&
      enTete &&
      parentheses === 0 &&
      !expression &&
      /[a-z]/iu.test(texte.charAt(i + 1))
    ) {
      const fin = texte.indexOf("\n", i);
      i = fin < 0 ? n : fin;
    } else if (SIGNES.has(c)) {
      if (c === "(") parentheses++;
      else if (c === ")" && --parentheses < 0) return null;
      else if (c === "{") accolades++;
      else if (c === "}" && --accolades < 0) return null;
      else if (c === ";") expression = false;
      lexemes.push({ sorte: "signe", v: c });
      i++;
    } else {
      let j = i + 1;
      while (j < n) {
        const d = texte.charAt(j);
        if (d <= " " || (FIN_MOT.has(d) && (d !== "'" || apostrophe))) break;
        if (d === "/" && texte.charAt(j + 1) === "*") break;
        j++;
      }
      const mot = texte.slice(i, j);
      const motCle = mot.toLowerCase();
      if (DEBUT_EXPRESSION.has(motCle)) expression = true;
      else if (FIN_EXPRESSION.has(motCle)) expression = false;
      lexemes.push({ sorte: "mot", v: mot });
      i = j;
    }
  }
  if (parentheses !== 0 || accolades !== 0) return null;
  morceaux.push(texte.slice(garde));
  return { lexemes, propre: morceaux.join("") };
}

const estSigne = (x: Lexeme | undefined, v: string): boolean => x?.sorte === "signe" && x.v === v;

/** Paramètres `clé="valeur"` ou `clé=["a", "b"]` (valeurs jointes par « , », clé sans casse) de l'objet ouvert au lexème `k` et indice de sa parenthèse fermante ; `null` si elle manque. */
function parametres(lx: readonly Lexeme[], k: number): { params: Parametres; fin: number } | null {
  const params: Parametres = new Map();
  let profondeur = 0;
  for (let j = k; j < lx.length; j++) {
    const x = lx[j];
    const valeur = lx[j + 2];
    if (estSigne(x, "(")) profondeur++;
    else if (estSigne(x, ")")) {
      if (--profondeur === 0) return { params, fin: j };
    } else if (profondeur === 1 && x?.sorte === "mot" && estSigne(lx[j + 1], "=") && valeur !== undefined) {
      if (valeur.sorte !== "signe") params.set(x.v.toLowerCase(), valeur.v);
      else if (valeur.v === "[") {
        const liste: string[] = [];
        let m = j + 3;
        for (; m < lx.length && lx[m]?.sorte !== "signe"; m += estSigne(lx[m + 1], ",") ? 2 : 1)
          liste.push(lx[m]?.v ?? "");
        params.set(x.v.toLowerCase(), liste.join(", "));
        j = m - 1;
        continue;
      }
      j += 1;
    }
  }
  return null;
}

/** Entrées et rulesets (action d'envoi, `call`, arrêt par `stop` ou `~`) d'un fichier rsyslog lexé, en une passe ; `null` au-delà des bornes. */
function lireRsyslog(
  lx: readonly Lexeme[],
): { entrees: Parametres[]; rulesets: Map<string, Ruleset> } | null {
  const entrees: Parametres[] = [];
  const rulesets = new Map<string, Ruleset>();
  const blocs: { ruleset: Ruleset | null; corps: boolean }[] = [];
  let objets = 0;
  let appels = 0;
  let debutInstruction = false;
  let libre = false;
  for (let k = 0; k < lx.length; k++) {
    const x = lx[k];
    const bloc = blocs.at(-1);
    const courant = bloc?.ruleset?.arrete === false ? bloc.ruleset : null;
    const mot = x?.sorte === "mot" ? x.v.toLowerCase() : null;
    if (debutInstruction && mot !== "&") libre = true;
    let finInstruction: boolean;
    if (mot !== null && estSigne(lx[k + 1], "(")) {
      const objet = parametres(lx, k + 1);
      if (objet === null || ++objets > MAX_OBJETS) return null;
      k = objet.fin;
      const type = (objet.params.get("type") ?? "").toLowerCase();
      const cible = objet.params.get("target") ?? "";
      if (mot === "input") entrees.push(objet.params);
      else if (mot === "action" && (type === "omfwd" || type === "omrelp") && cible !== "") {
        if (courant !== null && courant.envoi === null) courant.envoi = objet.params;
      } else if (mot === "ruleset" && estSigne(lx[k + 1], "{")) {
        const nom = objet.params.get("name");
        const ruleset: Ruleset | null =
          nom === undefined || rulesets.has(nom) ? null : { envoi: null, appels: [], arrete: false };
        if (nom !== undefined && ruleset !== null) rulesets.set(nom, ruleset);
        if (rulesets.size > MAX_RULESETS) return null;
        blocs.push({ ruleset, corps: true });
        k++;
      }
      finInstruction = true;
    } else if (mot === "call" && lx[k + 1]?.sorte === "mot") {
      if (++appels > MAX_APPELS) return null;
      courant?.appels.push(lx[k + 1]?.v ?? "");
      k++;
      finInstruction = true;
    } else if (mot === "stop" || mot === "~") {
      if (courant !== null && bloc?.corps === true && debutInstruction) courant.arrete = true;
      finInstruction = true;
    } else if (mot === "*.*") finInstruction = debutInstruction;
    else if (mot === "&") finInstruction = libre;
    else {
      if (estSigne(x, "{")) blocs.push({ ruleset: bloc?.ruleset ?? null, corps: false });
      else if (estSigne(x, "}")) blocs.pop();
      finInstruction = estSigne(x, "}") || estSigne(x, ";");
      if (!finInstruction) libre = false;
    }
    debutInstruction = finInstruction;
  }
  return { entrees, rulesets };
}

/** Action d'envoi de chaque ruleset : la sienne, sinon celle du premier ruleset appelé qui en a une, sur `NIVEAUX_CALL` niveaux (un niveau par tour : cycles sans effet). */
function envoisParRuleset(rulesets: ReadonlyMap<string, Ruleset>): Map<string, Parametres> {
  let atteints = new Map<string, Parametres>();
  for (let niveau = 0; niveau <= NIVEAUX_CALL; niveau++) {
    const suivants = new Map<string, Parametres>();
    for (const [nom, r] of rulesets) {
      let envoi = r.envoi;
      for (const appel of r.appels) {
        if (envoi !== null) break;
        envoi = atteints.get(appel) ?? null;
      }
      if (envoi !== null) suivants.set(nom, envoi);
    }
    atteints = suivants;
  }
  return atteints;
}

/** Collecteur, transport et file d'une action d'envoi rsyslog. */
function decrireEnvoi(p: Parametres): EnvoiCentralisation {
  const relp = (p.get("type") ?? "").toLowerCase() === "omrelp";
  const cible = p.get("target") ?? null;
  const port = p.get("port") ?? (relp ? "2514" : "514");
  let transport: string;
  if (relp) {
    const tls = (p.get("tls") ?? "").toLowerCase() === "on";
    const mode = p.get("tls.authmode");
    transport = tls ? `RELP + TLS${mode ? ` (${mode})` : ""}` : "RELP";
  } else {
    const proto = (p.get("protocol") ?? "udp").toLowerCase() === "tcp" ? "TCP" : "UDP";
    const tls = p.get("streamdrivermode") === "1";
    const mode = p.get("streamdriverauthmode");
    transport = tls ? `${proto} + TLS${mode ? ` (${mode})` : ""}` : proto;
  }
  const type = p.get("queue.type");
  const file =
    type === undefined || type.toLowerCase() === "direct"
      ? null
      : { type, fichier: p.get("queue.filename") ?? null, max_disque: p.get("queue.maxdiskspace") ?? null };
  return { collecteur: cible === null ? null : `${cible}:${port}`, transport, file };
}

/** Règle rsyslog : un `input(type="imfile")` dont `File=` est dans le dossier du journal, `Tag=` vaut `elpis-audit` et dont le `ruleset` envoie (omfwd ou omrelp) ; rend l'action d'envoi. */
function regleRsyslog(lexemes: readonly Lexeme[], dossier: string | null): EnvoiCentralisation | null {
  const lu = lireRsyslog(lexemes);
  if (lu === null) return null;
  const envois = envoisParRuleset(lu.rulesets);
  for (const p of lu.entrees) {
    const tag = (p.get("tag") ?? "").toLowerCase();
    const fichier = p.get("file");
    const ruleset = p.get("ruleset");
    if ((p.get("type") ?? "").toLowerCase() !== "imfile" || (tag !== "elpis-audit" && tag !== "elpis-audit:"))
      continue;
    if (fichier === undefined || fichier === "" || ruleset === undefined) continue;
    if (dossier !== null && fichier.slice(0, fichier.lastIndexOf("/")) !== dossier) continue;
    const envoi = envois.get(ruleset);
    if (envoi !== undefined) return decrireEnvoi(envoi);
  }
  return null;
}

/** Règle active du fichier (cible d'exemple non remplacée refusée ; syslog-ng : dossier et étiquette `elpis-audit` cités hors commentaires) : `false`, ou l'action d'envoi lue (rsyslog). */
function contientRegle(
  agent: AgentSyslog,
  texte: string,
  dossier: string | null,
): { envoi: EnvoiCentralisation | null } | false {
  const lu = analyser(texte);
  if (lu === null || lu.propre.includes(CIBLE_EXEMPLE)) return false;
  if (agent === "syslog-ng")
    return lu.propre.includes("elpis-audit") && (dossier === null || lu.propre.includes(dossier))
      ? { envoi: null }
      : false;
  const envoi = regleRsyslog(lu.lexemes, dossier);
  return envoi === null ? false : { envoi };
}

async function detecter(o: OptionsCentralisation): Promise<EtatCentralisation> {
  const racine = o.racine ?? "";
  const dossier = o.dossierAudit === undefined ? null : sansBarresFinales(o.dossierAudit);
  for (const a of AGENTS) {
    const principal = await lireFichierBorne(join(racine, a.fichier));
    if (principal === null) continue;
    const ici = contientRegle(a.agent, principal, dossier);
    let regle: string | null = ici ? a.fichier : null;
    let envoi = ici ? ici.envoi : null;
    if (regle === null) {
      const noms = (await readdir(join(racine, a.dossier)).catch(() => [] as string[])).filter((n) =>
        n.endsWith(".conf"),
      );
      for (const n of noms.sort()) {
        const texte = await lireFichierBorne(join(racine, a.dossier, n));
        const trouve = texte === null ? false : contientRegle(a.agent, texte, dossier);
        if (trouve) {
          regle = join(a.dossier, n);
          envoi = trouve.envoi;
          break;
        }
      }
    }
    return { agent: a.agent, actif: await (o.estActif ?? serviceActif)(a.agent), regle, envoi };
  }
  return { agent: null, actif: null, regle: null, envoi: null };
}

/** État de la centralisation ; sans racine ni sonde injectées, gardé 60 s par dossier, comme l'état du journal (une lecture de /etc et un appel à systemd au plus). */
export async function detecterCentralisation(o: OptionsCentralisation = {}): Promise<EtatCentralisation> {
  const partage = o.racine === undefined && o.estActif === undefined;
  const cle = o.dossierAudit ?? "";
  if (partage && cache && cache.cle === cle && cache.expire > Date.now()) return cache.valeur;
  const valeur = await detecter(o);
  if (partage) cache = { cle, valeur, expire: Date.now() + DUREE_CACHE_MS };
  return valeur;
}
