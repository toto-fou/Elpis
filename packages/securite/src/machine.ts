// SPDX-License-Identifier: MIT
/** packages/securite/src/machine.ts — adresses de la machine d'Elpis et réseaux de ses interfaces de conteneurs (ponts Docker…), relevés sans Docker : interfaces du système, puis /proc (une interface sans porteuse n'y figure que là). */
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";

import { adresseIpOuNul, dansReseau, ipv4Mappee, reseauPy, texteIp } from "@elpis/commun";
import type { AdresseIp, Reseau } from "@elpis/commun";

/** Interfaces de conteneurs et de machines virtuelles : leurs réseaux sont internes à la machine. */
export const INTERFACES_CONTENEURS = /^(docker|br-|veth|virbr|cni|flannel|podman|lxc|lxd|incus|vnet|kube)/u;

/** Adresses de la machine et sous-réseaux de ses interfaces de conteneurs. */
export interface HoteMachine {
  adresses: readonly AdresseIp[];
  reseaux: readonly Reseau[];
}

/** Crochets et zone retirés, IPv4 encapsulée rendue en IPv4. */
function ipLue(v: string): AdresseIp | null {
  const a = adresseIpOuNul((v || "").replace(/^[[\]]+|[[\]]+$/gu, "").split("%")[0] ?? "");
  return a === null ? null : (ipv4Mappee(a) ?? a);
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
export async function hostAddresses(): Promise<HoteMachine> {
  const adresses: AdresseIp[] = [];
  const reseaux: Reseau[] = [];
  const ajouter = (texte: string, nom: string, prefixe: string | null): void => {
    const ip = ipLue(texte);
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

/** Ce qu'est l'adresse pour la machine (une IPv4 encapsulée est jugée par son IPv4) : une de ses adresses, une adresse d'un réseau de ses conteneurs. */
export function surLaMachine(brute: AdresseIp, h: HoteMachine): { adresse: boolean; conteneurs: boolean } {
  const ip = ipv4Mappee(brute) ?? brute;
  return {
    adresse: h.adresses.some((a) => a.version === ip.version && a.valeur === ip.valeur),
    conteneurs: h.reseaux.some((r) => r.version === ip.version && dansReseau(ip, r)),
  };
}
