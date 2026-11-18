// SPDX-License-Identifier: MIT
/** packages/navigateur/src/url.ts — destinations du navigateur, jugées par le relais du bac : profil réseau du bac, puis politique du navigateur (jamais la machine d'Elpis, ses réseaux de conteneurs, la boucle locale ni le lien-local ; liste blanche du réseau local). */
import { lookup } from "node:dns/promises";
import { domainToASCII } from "node:url";

import {
  adresseIpOuNul,
  dansReseau,
  estBoucleIp,
  estLienLocalIp,
  estMulticastIp,
  estNonSpecifieeIp,
  estReserveeIp,
  ipv4Mappee,
  iterExige,
  lowerPy,
  reseauPy,
  splitPy,
  stripPy,
  strPy,
  texteIp,
  veritePy,
} from "@elpis/commun";
import type { AdresseIp, Reseau } from "@elpis/commun";
import { liveConfigValue } from "@elpis/config";
import { hostAddresses } from "@elpis/securite";
import type { HoteMachine, Resolveur } from "@elpis/securite";

// Réseaux « locaux » : joignables, sauf liste blanche qui ne les nomme pas.
const RESEAUX_LOCAUX: readonly Reseau[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
]
  .map((n) => reseauPy(n))
  .filter((r): r is Reseau => r !== null);
const RESERVEE = "address reserved to the host or its local network";

/** Adresses de l'hôte et sous-réseaux de ses interfaces de conteneurs (relevé de `@elpis/securite`). */
export type HoteNavigateur = HoteMachine;
export { hostAddresses };

export interface OptionsGardeNavigateur {
  /** Liste blanche du réseau local ; `null`/absente : `browser.url_allowlist`, relue à chaud. */
  allowlist?: unknown;
  hote?: HoteNavigateur;
  resoudre?: Resolveur;
}

interface ListeBlanche {
  hotes: ReadonlySet<string>;
  suffixes: readonly string[];
  reseaux: readonly Reseau[];
}

/** `_ip` : crochets et zone retirés, IPv4 encapsulée rendue en IPv4. */
function ipNav(v: string): AdresseIp | null {
  const a = adresseIpOuNul((v || "").replace(/^[[\]]+|[[\]]+$/gu, "").split("%")[0] ?? "");
  return a === null ? null : (ipv4Mappee(a) ?? a);
}

const memeIp = (a: AdresseIp, b: AdresseIp): boolean => a.version === b.version && a.valeur === b.valeur;

/** Résolveur du système : le nom IDNA (comme `socket.getaddrinfo` sur un nom Unicode), adresses dans l'ordre du système. */
async function resoudreSysteme(nom: string): Promise<string[]> {
  return (await lookup(domainToASCII(nom) || nom, { all: true, order: "verbatim" })).map((r) => r.address);
}

/** `_liste_blanche` : texte séparé par blancs ou virgules, ou itérable ; réseaux, suffixes (`*.x`, `.x`) et noms exacts. */
function listeBlanche(entrees: unknown): ListeBlanche {
  const brut =
    typeof entrees === "string"
      ? splitPy(entrees.replaceAll(",", " "))
      : iterExige(veritePy(entrees) ? entrees : []);
  const hotes = new Set<string>();
  const suffixes: string[] = [];
  const reseaux: Reseau[] = [];
  for (const e0 of brut) {
    const e = lowerPy(stripPy(veritePy(e0) ? strPy(e0) : ""));
    if (!e) continue;
    const r = reseauPy(e);
    if (r !== null) reseaux.push(r);
    else if (e.startsWith("*.")) suffixes.push(e.slice(1));
    else if (e.startsWith(".")) suffixes.push(e);
    else hotes.add(e);
  }
  return { hotes, suffixes, reseaux };
}

function motifIp(ip: AdresseIp, nom: string, hote: HoteNavigateur, liste: ListeBlanche): string | null {
  const meme = (r: Reseau): boolean => r.version === ip.version && dansReseau(ip, r);
  if (
    estBoucleIp(ip) ||
    estLienLocalIp(ip) ||
    estNonSpecifieeIp(ip) ||
    estMulticastIp(ip) ||
    (ip.version === 4 && estReserveeIp(ip))
  )
    return `${RESERVEE} (${texteIp(ip)})`;
  if (hote.adresses.some((a) => memeIp(a, ip)))
    return `address of the machine hosting Elpis (${texteIp(ip)})`;
  if (hote.reseaux.some(meme)) return `internal network of the machine hosting Elpis (${texteIp(ip)})`;
  if (
    (liste.hotes.size > 0 || liste.suffixes.length > 0 || liste.reseaux.length > 0) &&
    RESEAUX_LOCAUX.some(meme)
  ) {
    const parNom = liste.hotes.has(nom) || liste.suffixes.some((s) => nom.endsWith(s));
    if (!parNom && !liste.reseaux.some(meme))
      return `local network host not in the allowlist (${nom || texteIp(ip)})`;
  }
  return null;
}

/** Profil réseau d'un bac, vu du relais : identifiant, mode (`none`, `bridge`, `allowlist_ip`), adresses ou réseaux, domaines, ports. */
export interface ProfilRelais {
  readonly id: string;
  readonly mode: unknown;
  readonly ips: readonly unknown[];
  readonly domains: readonly string[];
  readonly ports: readonly number[];
}

let hoteEnCache: { t: number; v: Promise<HoteNavigateur> } | null = null;

/** Adresses de l'hôte relues au plus toutes les 60 s (une page ouvre des dizaines de connexions). */
function hoteRecent(): Promise<HoteNavigateur> {
  if (hoteEnCache === null || Date.now() - hoteEnCache.t > 60_000)
    hoteEnCache = { t: Date.now(), v: hostAddresses() };
  return hoteEnCache.v;
}

/** Verdict du juge d'un bac (adresses jugées, la première d'abord, ou motif). */
type VerdictBac = { ok: true; adresse: string; adresses: string[] } | { ok: false; motif: string };

/** Cache des verdicts du juge d'un bac ; réglable par les tests. */
export const reglagesJugeBac = {
  /** Verdict favorable gardé (ms). */
  cacheMs: 10_000,
  /** Refus gardé (ms) : un nom introuvable ne repasse pas par le résolveur à chaque connexion. */
  cacheNegatifMs: 5_000,
  /** Noms gardés au plus. */
  max: 2000,
};

/**
 * Juge du relais d'un bac (`hôte`, `port`) → adresses à joindre ou motif en anglais : le profil réseau du bac
 * d'abord (`none` : rien hors du bac ; `allowlist_ip` : ses adresses, domaines et ports), puis la politique du
 * navigateur (jamais la machine d'Elpis, ses réseaux de conteneurs, la boucle locale ni le lien-local ; liste
 * blanche du réseau local). Verdict par nom et profil gardé 10 s (refus 5 s), une seule résolution à la fois par
 * nom : une page ouvre des dizaines de connexions vers les mêmes hôtes, chacune passait par le pool de threads.
 */
export function jugeRelaisBac(
  profil: () => ProfilRelais,
  options: OptionsGardeNavigateur = {},
): (hote: string, port: number) => Promise<VerdictBac> {
  const cache = new Map<string, { expire: number; v: Promise<VerdictBac> }>();
  const juger = async (p: ProfilRelais, nom: string): Promise<VerdictBac> => {
    const litterale = ipNav(nom);
    let adresses: string[];
    if (litterale !== null) adresses = [texteIp(litterale)];
    else
      try {
        adresses = await (options.resoudre ?? resoudreSysteme)(nom, null);
      } catch {
        return { ok: false, motif: `name not found (${nom})` };
      }
    if (adresses.length === 0) return { ok: false, motif: `name not found (${nom})` };
    let allowlist = options.allowlist;
    if (allowlist === undefined || allowlist === null) {
      try {
        allowlist = liveConfigValue("browser.url_allowlist", []) || [];
      } catch {
        allowlist = [];
      }
    }
    const liste = listeBlanche(allowlist);
    const h = options.hote ?? (await hoteRecent());
    const reseauxProfil = p.ips.map((x) => reseauPy(strPy(x))).filter((r): r is Reseau => r !== null);
    for (const a of adresses) {
      const ip = ipNav(a);
      if (ip === null) return { ok: false, motif: `invalid address (${a})` };
      const m = motifIp(ip, nom, h, liste);
      if (m) return { ok: false, motif: m };
      if (
        p.mode === "allowlist_ip" &&
        !p.domains.includes(nom) &&
        !reseauxProfil.some((r) => r.version === ip.version && dansReseau(ip, r))
      )
        return { ok: false, motif: `${nom} is not allowed by the sandbox network profile '${p.id}'` };
    }
    const jugees = adresses.map((a) => texteIp(ipNav(a) as AdresseIp));
    return { ok: true, adresse: jugees[0] ?? "", adresses: jugees };
  };
  return async (hote, portVoulu) => {
    const p = profil();
    if (p.mode === "none")
      return {
        ok: false,
        motif: `the sandbox network profile '${p.id}' has no network access: only sites served inside the sandbox (localhost) are reachable`,
      };
    if (p.mode === "allowlist_ip" && p.ports.length > 0 && !p.ports.includes(portVoulu))
      return {
        ok: false,
        motif: `port ${portVoulu} is not allowed by the sandbox network profile '${p.id}'`,
      };
    const nom = lowerPy(hote);
    const cle = `${strPy(p.id)}\u0000${strPy(p.mode)}\u0000${nom}`;
    const t = Date.now();
    const connu = cache.get(cle);
    if (connu !== undefined && t < connu.expire) return connu.v;
    const v = juger(p, nom);
    if (cache.size >= reglagesJugeBac.max) {
      const premiere = cache.keys().next();
      if (!premiere.done) cache.delete(premiere.value);
    }
    const entree = { expire: t + reglagesJugeBac.cacheMs, v };
    cache.set(cle, entree);
    void v.then(
      (r) => {
        if (!r.ok) entree.expire = t + reglagesJugeBac.cacheNegatifMs;
      },
      () => cache.delete(cle),
    );
    return v;
  };
}
