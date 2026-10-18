// SPDX-License-Identifier: MIT
/** packages/navigateur/src/url.ts — destinations du navigateur (port de shared_infra/security/browser_url.py) : refus anticipé, avec un message clair, avant d'appeler le service navigateur. */
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { domainToASCII } from "node:url";

import {
  adresseIpOuNul,
  dansReseau,
  estBoucleIp,
  estLienLocalIp,
  estMulticastIp,
  estNonSpecifieeIp,
  estReserveeIp,
  hostname,
  ipv4Mappee,
  iterExige,
  lowerPy,
  port,
  prefixePy,
  reseauPy,
  splitPy,
  stripPy,
  strPy,
  texteIp,
  urlsplit,
  urlunsplit,
  veritePy,
} from "@elpis/commun";
import type { AdresseIp, Reseau, UrlDecoupee } from "@elpis/commun";
import { liveConfigValue } from "@elpis/config";
import { blockRemoteUrlReason, urlNonAmbigue } from "@elpis/securite";
import type { Resolveur } from "@elpis/securite";

// Mêmes réseaux « locaux » que url_guard.js (soumis à la liste blanche).
const RESEAUX_LOCAUX: readonly Reseau[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
]
  .map((n) => reseauPy(n))
  .filter((r): r is Reseau => r !== null);
const INTERFACES_CONTENEURS = /^(docker|br-|veth|virbr|cni|flannel|podman|lxc|lxd|incus|vnet|kube)/u;
const RESERVEE = "adresse réservée à l'hôte ou au réseau local de la machine";

/** Adresses de l'hôte et sous-réseaux de ses interfaces de conteneurs (ponts Docker…). */
export interface HoteNavigateur {
  adresses: readonly AdresseIp[];
  reseaux: readonly Reseau[];
}

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

async function lire(chemin: string): Promise<string> {
  try {
    return await readFile(chemin, "utf-8");
  } catch {
    return "";
  }
}

function interfaces(): ReturnType<typeof networkInterfaces> {
  try {
    return networkInterfaces();
  } catch {
    return {};
  }
}

/** IPv4 d'un champ hexadécimal de /proc/net/route (ordre des octets de la machine, petit-boutiste). */
function ipv4Proc(hex: string): string {
  const n = Number.parseInt(hex, 16);
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24].join(".");
}

/** `host_addresses` ; os.networkInterfaces() complété par /proc (libuv omet les interfaces sans porteuse, psutil non : pont Docker sans conteneur). */
export async function hostAddresses(): Promise<HoteNavigateur> {
  const adresses: AdresseIp[] = [];
  const reseaux: Reseau[] = [];
  const ajouter = (texte: string, nom: string, prefixe: string | null): void => {
    const ip = ipNav(texte);
    if (ip === null) return;
    adresses.push(ip);
    const r = INTERFACES_CONTENEURS.test(nom) && prefixe ? reseauPy(`${texteIp(ip)}/${prefixe}`) : null;
    if (r !== null) reseaux.push(r);
  };
  for (const [nom, liste] of Object.entries(interfaces()))
    for (const a of liste ?? []) ajouter(a.address, nom, a.cidr?.split("/")[1] ?? null);
  for (const ligne of (await lire("/proc/net/if_inet6")).split("\n")) {
    const [hex, , plen, , , nom] = ligne.trim().split(/\s+/u);
    if (hex?.length === 32 && plen && nom)
      ajouter(hex.match(/.{4}/gu)?.join(":") ?? "", nom, String(Number.parseInt(plen, 16)));
  }
  let derniere = "";
  for (const ligne of (await lire("/proc/net/fib_trie")).split("\n")) {
    const feuille = /^\s*\|-- (\S+)$/u.exec(ligne);
    if (feuille) derniere = feuille[1] ?? "";
    else if (/^\s*\/32 host LOCAL$/u.test(ligne) && derniere) ajouter(derniere, "", null);
  }
  for (const ligne of (await lire("/proc/net/route")).split("\n").slice(1)) {
    const [nom, dest, passerelle, , , , , masque] = ligne.trim().split(/\s+/u);
    if (!nom || !dest || !masque || masque === "00000000" || passerelle !== "00000000") continue;
    if (!INTERFACES_CONTENEURS.test(nom)) continue;
    const r = reseauPy(`${ipv4Proc(dest)}/${ipv4Proc(masque)}`);
    if (r !== null) reseaux.push(r);
  }
  return { adresses, reseaux };
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
    return `adresse de la machine qui héberge Elpis (${texteIp(ip)})`;
  if (hote.reseaux.some(meme)) return `réseau interne de la machine qui héberge Elpis (${texteIp(ip)})`;
  if (
    (liste.hotes.size > 0 || liste.suffixes.length > 0 || liste.reseaux.length > 0) &&
    RESEAUX_LOCAUX.some(meme)
  ) {
    const parNom = liste.hotes.has(nom) || liste.suffixes.some((s) => nom.endsWith(s));
    if (!parNom && !liste.reseaux.some(meme))
      return `hôte du réseau local absent de la liste autorisée (${nom || texteIp(ip)})`;
  }
  return null;
}

/** E40 (écart au Python) : une URL que le Python laisse passer est refusée si le navigateur (WHATWG) n'y lit pas le même hôte et le même port. */
function accord(u: string): string | null {
  return urlNonAmbigue(u)
    ? null
    : "adresse ambiguë : le navigateur n'y lirait pas le même hôte ou le même port";
}

/** `browser_url_block_reason` : motif de refus d'une URL pour le navigateur, ou `null` ; un nom qui ne résout pas n'est pas refusé ici. */
export async function browserUrlBlockReason(
  url: string | null | undefined,
  options: OptionsGardeNavigateur = {},
): Promise<string | null> {
  const u = stripPy(url || "");
  if (!u) return "adresse vide";
  if (lowerPy(u) === "about:blank") return null;
  let p: UrlDecoupee;
  try {
    p = urlsplit(u);
  } catch {
    return "adresse mal formée";
  }
  const schema = lowerPy(p.scheme || "");
  if (schema !== "http" && schema !== "https")
    return `schéma non autorisé (${schema || "aucun"}:) — seuls http et https le sont`;
  const nom = lowerPy(hostname(p) ?? "");
  if (!nom) return "adresse sans hôte";
  if (nom === "localhost" || nom.endsWith(".localhost")) return `${RESERVEE} (${nom})`;
  let portUrl: number | null;
  try {
    portUrl = port(p);
  } catch {
    return "adresse mal formée";
  }
  const hoteUrl = nom.includes(":") ? `[${nom}]` : nom;
  const sansId = urlunsplit({ ...p, netloc: hoteUrl + (portUrl ? `:${portUrl}` : ""), fragment: "" });
  const resoudre: Resolveur = options.resoudre ?? resoudreSysteme;
  const motif = await blockRemoteUrlReason(sansId, {
    allowSchemes: ["http", "https"],
    criticalOnly: true,
    resoudre,
  });
  if (motif && !motif.startsWith("unresolvable_host")) return `${RESERVEE} (${motif})`;
  let allowlist = options.allowlist;
  if (allowlist === undefined || allowlist === null) {
    try {
      allowlist = liveConfigValue("browser.url_allowlist", []) || [];
    } catch {
      allowlist = [];
    }
  }
  const liste = listeBlanche(allowlist);
  const hote = options.hote ?? (await hostAddresses());
  const ip = ipNav(nom);
  if (ip !== null) return motifIp(ip, nom, hote, liste) ?? accord(u);
  let adresses: string[];
  try {
    adresses = await resoudre(nom, null);
  } catch {
    return accord(u);
  }
  for (const a of adresses) {
    const rip = ipNav(String(a));
    const m = rip === null ? null : motifIp(rip, nom, hote, liste);
    if (m) return m;
  }
  return accord(u);
}

/** `refus_message` : même message que le service (url_guard.messageRefus). */
export function refusMessage(url: string | null | undefined, motif: string): string {
  return (
    `Adresse refusée par la politique du navigateur : ${motif}. ` +
    `URL : ${prefixePy(url || "", 200)}. Le navigateur ne peut joindre que des sites ` +
    `http/https hors de la machine qui héberge Elpis.`
  );
}
