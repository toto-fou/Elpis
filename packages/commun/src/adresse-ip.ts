// SPDX-License-Identifier: MIT
/** packages/commun/src/adresse-ip.ts — `ipaddress` de CPython 3.13 : analyse stricte, forme canonique, prédicats et réseaux. */
import { ErreurPython, reprPy } from "./python";

export interface AdresseIp {
  version: 4 | 6;
  valeur: bigint;
  zone: string | null;
}

export interface Reseau {
  version: 4 | 6;
  adresse: bigint;
  masque: bigint;
}

const CHIFFRES = /^[0-9]+$/u;
const HEXA = /^[0-9a-fA-F]*$/u;
const UNS = { 4: (1n << 32n) - 1n, 6: (1n << 128n) - 1n } as const;

/** `IPv4Address._ip_int_from_string` : quatre octets décimaux ASCII, sans zéro de tête. */
export function ipv4Py(s: string): bigint | null {
  const octets = s.split(".");
  if (!s || s.includes("/") || octets.length !== 4) return null;
  let n = 0n;
  for (const o of octets) {
    if (!CHIFFRES.test(o) || o.length > 3 || (o !== "0" && o.startsWith("0")) || Number(o) > 255) return null;
    n = (n << 8n) | BigInt(o);
  }
  return n;
}

/** `IPv6Address` : portée `%…` séparée, `::` unique, suffixe IPv4, hextets de 1 à 4 chiffres hexadécimaux. */
function ipv6AvecZone(brut: string): { valeur: bigint; zone: string | null } | null {
  if (brut.includes("/")) return null;
  const pourcent = brut.indexOf("%");
  const s = pourcent < 0 ? brut : brut.slice(0, pourcent);
  const zone = pourcent < 0 ? null : brut.slice(pourcent + 1);
  if (zone !== null && (!zone || zone.includes("%"))) return null;
  if (!s || Array.from(s).length > 45) return null;
  const parts = s.split(":");
  if (parts.length < 3) return null;
  if ((parts[parts.length - 1] ?? "").includes(".")) {
    const v4 = ipv4Py(parts.pop() ?? "");
    if (v4 === null) return null;
    parts.push((v4 >> 16n).toString(16), (v4 & 0xffffn).toString(16));
  }
  if (parts.length > 9) return null;
  let saut: number | null = null;
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i]) continue;
    if (saut !== null) return null;
    saut = i;
  }
  let hauts: number;
  let bas: number;
  let sautes: number;
  if (saut !== null) {
    hauts = saut;
    bas = parts.length - saut - 1;
    if (!parts[0] && --hauts) return null;
    if (!parts[parts.length - 1] && --bas) return null;
    sautes = 8 - (hauts + bas);
    if (sautes < 1) return null;
  } else {
    if (parts.length !== 8 || !parts[0] || !parts[parts.length - 1]) return null;
    [hauts, bas, sautes] = [parts.length, 0, 0];
  }
  let n = 0n;
  const hextet = (h: string): bigint | null => (h && HEXA.test(h) && h.length <= 4 ? BigInt(`0x${h}`) : null);
  for (const h of [
    ...parts.slice(0, hauts),
    ...Array<string>(sautes).fill("0"),
    ...parts.slice(parts.length - bas),
  ]) {
    const v = hextet(h);
    if (v === null) return null;
    n = (n << 16n) | v;
  }
  return { valeur: n, zone };
}

export function ipv6Py(brut: string): bigint | null {
  return ipv6AvecZone(brut)?.valeur ?? null;
}

/** `ip_address(texte)` sans lever : IPv4 d'abord, IPv6 ensuite. */
export function adresseIpOuNul(texte: string): AdresseIp | null {
  const v4 = ipv4Py(texte);
  if (v4 !== null) return { version: 4, valeur: v4, zone: null };
  const v6 = ipv6AvecZone(texte);
  return v6 === null ? null : { version: 6, valeur: v6.valeur, zone: v6.zone };
}

/** `ipaddress.ip_address(texte)` : ValueError comme CPython. */
export function adresseIpPy(texte: string): AdresseIp {
  const a = adresseIpOuNul(texte);
  if (a === null)
    throw new ErreurPython("ValueError", `${reprPy(texte)} does not appear to be an IPv4 or IPv6 address`);
  return a;
}

export function masqueIp(version: 4 | 6, prefixe: number): bigint {
  const bits = BigInt(version === 4 ? 32 : 128);
  return UNS[version] ^ ((1n << (bits - BigInt(prefixe))) - 1n);
}

/** Longueur de préfixe d'un masque `1*0*`, ou null. */
function prefixeDeMasque(v: bigint, version: 4 | 6): number | null {
  const bits = version === 4 ? 32 : 128;
  for (let p = 0; p <= bits; p++) if (masqueIp(version, p) === v) return p;
  return null;
}

/** `ip_network(s, strict=False)` : préfixe décimal ASCII, ou (IPv4) masque ou masque inverse pointé ; bits d'hôte effacés. */
export function reseauPy(s: string): Reseau | null {
  const morceaux = s.split("/");
  if (morceaux.length > 2) return null;
  const [texte = "", suffixe] = morceaux;
  for (const version of [4, 6] as const) {
    const adresse = version === 4 ? ipv4Py(texte) : ipv6Py(texte);
    if (adresse === null) continue;
    const bits = version === 4 ? 32 : 128;
    let prefixe: number | null = suffixe === undefined ? bits : null;
    if (suffixe !== undefined && CHIFFRES.test(suffixe) && suffixe.length <= 4300 && Number(suffixe) <= bits)
      prefixe = Number(suffixe);
    else if (suffixe !== undefined && version === 4 && !CHIFFRES.test(suffixe)) {
      const m = ipv4Py(suffixe);
      if (m !== null) prefixe = prefixeDeMasque(m, 4) ?? prefixeDeMasque(m ^ UNS[4], 4);
    }
    if (prefixe === null) continue;
    const mq = masqueIp(version, prefixe);
    return { version, adresse: adresse & mq, masque: mq };
  }
  return null;
}

export function dansReseau(a: AdresseIp, r: Reseau): boolean {
  return a.version === r.version && (a.valeur & r.masque) === r.adresse;
}

function reseaux(...specs: string[]): Reseau[] {
  return specs.map((s) => reseauPy(s) as Reseau);
}

const V4 = {
  privees: reseaux(
    "0.0.0.0/8",
    "10.0.0.0/8",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.0.170/31",
    "192.0.2.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "240.0.0.0/4",
    "255.255.255.255/32",
  ),
  exceptions: reseaux("192.0.0.9/32", "192.0.0.10/32"),
  partagee: reseaux("100.64.0.0/10"),
  boucle: reseaux("127.0.0.0/8"),
  lienLocal: reseaux("169.254.0.0/16"),
  multicast: reseaux("224.0.0.0/4"),
  reservees: reseaux("240.0.0.0/4"),
};

const V6 = {
  privees: reseaux(
    "::1/128",
    "::/128",
    "::ffff:0.0.0.0/96",
    "64:ff9b:1::/48",
    "100::/64",
    "2001::/23",
    "2001:db8::/32",
    "2002::/16",
    "3fff::/20",
    "fc00::/7",
    "fe80::/10",
  ),
  exceptions: reseaux(
    "2001:1::1/128",
    "2001:1::2/128",
    "2001:3::/32",
    "2001:4:112::/48",
    "2001:20::/28",
    "2001:30::/28",
  ),
  lienLocal: reseaux("fe80::/10"),
  multicast: reseaux("ff00::/8"),
  reservees: reseaux(
    "::/8",
    "100::/8",
    "200::/7",
    "400::/6",
    "800::/5",
    "1000::/4",
    "4000::/3",
    "6000::/3",
    "8000::/3",
    "a000::/3",
    "c000::/3",
    "e000::/4",
    "f000::/5",
    "f800::/6",
    "fe00::/9",
  ),
};

const dansUn = (a: AdresseIp, liste: readonly Reseau[]): boolean => liste.some((r) => dansReseau(a, r));

/** `IPv6Address.ipv4_mapped` : l'IPv4 de `::ffff:a.b.c.d`, sinon null. */
export function ipv4Mappee(a: AdresseIp): AdresseIp | null {
  if (a.version !== 6 || a.valeur >> 32n !== 0xffffn) return null;
  return { version: 4, valeur: a.valeur & 0xffffffffn, zone: null };
}

/** Prédicat IPv6 rendu par l'IPv4 encapsulée quand il y en a une (CPython 3.13). */
function selonMappee(a: AdresseIp, f: (x: AdresseIp) => boolean, v6: () => boolean): boolean {
  const m = ipv4Mappee(a);
  return m !== null ? f(m) : v6();
}

export function estPriveeIp(a: AdresseIp): boolean {
  const t = a.version === 4 ? V4 : V6;
  return selonMappee(a, estPriveeIp, () => dansUn(a, t.privees) && !dansUn(a, t.exceptions));
}

export function estGlobaleIp(a: AdresseIp): boolean {
  if (a.version === 4) return !dansUn(a, V4.partagee) && !estPriveeIp(a);
  return selonMappee(a, estGlobaleIp, () => !estPriveeIp(a));
}

export function estBoucleIp(a: AdresseIp): boolean {
  if (a.version === 4) return dansUn(a, V4.boucle);
  return selonMappee(a, estBoucleIp, () => a.valeur === 1n);
}

export function estLienLocalIp(a: AdresseIp): boolean {
  if (a.version === 4) return dansUn(a, V4.lienLocal);
  return selonMappee(a, estLienLocalIp, () => dansUn(a, V6.lienLocal));
}

export function estNonSpecifieeIp(a: AdresseIp): boolean {
  if (a.version === 4) return a.valeur === 0n;
  return selonMappee(a, estNonSpecifieeIp, () => a.valeur === 0n);
}

export function estMulticastIp(a: AdresseIp): boolean {
  if (a.version === 4) return dansUn(a, V4.multicast);
  return selonMappee(a, estMulticastIp, () => dansUn(a, V6.multicast));
}

export function estReserveeIp(a: AdresseIp): boolean {
  if (a.version === 4) return dansUn(a, V4.reservees);
  return selonMappee(a, estReserveeIp, () => dansUn(a, V6.reservees));
}

/** `str(adresse)` : IPv4 pointée ; IPv6 compressée (plus longue suite de zéros, au moins deux), IPv4 encapsulée en clair, zone. */
export function texteIp(a: AdresseIp): string {
  if (a.version === 4) return [24n, 16n, 8n, 0n].map((d) => String((a.valeur >> d) & 0xffn)).join(".");
  const zone = a.zone ? `%${a.zone}` : "";
  const m = ipv4Mappee(a);
  if (m !== null) return `::ffff:${texteIp(m)}${zone}`;
  const hextets = Array.from({ length: 8 }, (_, i) =>
    ((a.valeur >> BigInt(112 - 16 * i)) & 0xffffn).toString(16),
  );
  let [meilleurDebut, meilleureLongueur, debut, longueur] = [-1, 0, -1, 0];
  hextets.forEach((h, i) => {
    if (h === "0") {
      longueur++;
      if (debut === -1) debut = i;
      if (longueur > meilleureLongueur) [meilleurDebut, meilleureLongueur] = [debut, longueur];
    } else [debut, longueur] = [-1, 0];
  });
  if (meilleureLongueur > 1) {
    const fin = meilleurDebut + meilleureLongueur;
    const tete = hextets.slice(0, meilleurDebut).join(":");
    const queue = hextets.slice(fin).join(":");
    return `${tete}::${queue}${zone}`;
  }
  return hextets.join(":") + zone;
}
