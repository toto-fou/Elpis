// SPDX-License-Identifier: MIT
/** packages/bac/src/reseau.ts — réseau Docker des bacs en mode ouvert ou liste blanche : pont dédié, trafic entre conteneurs coupé ; les relais de l'hôte reconnaissent son pont à son nom (`br-`) ; plages refusées par les protections d'un profil ouvert. */
import { adresseIpOuNul, comparePointsDeCode, dansReseau, reseauPy, texteIp } from "@elpis/commun";
import type { AdresseIp, Reseau } from "@elpis/commun";
import { adresseCritique, hostAddresses, surLaMachine } from "@elpis/securite";
import type { HoteMachine } from "@elpis/securite";

/** Réseau Docker des bacs : un pont à part, sans trafic entre conteneurs (ICC). */
export const RESEAU_BACS = "elpis-sandbox";
/** Interface du pont sur l'hôte ; le préfixe `br-` la range parmi les ponts de conteneurs que le relais du navigateur exclut. */
export const PONT_BACS = "br-elpis-sb";
/** Option du pont lue à l'inspection : `false` attendu. */
export const OPTION_ICC = "com.docker.network.bridge.enable_icc";
/** Gabarit d'inspection du réseau : pilote, IPv6, coupure entre conteneurs, nom du pont. */
export const FORMAT_RESEAU = `{{.Driver}}|{{.EnableIPv6}}|{{index .Options "${OPTION_ICC}"}}|{{index .Options "com.docker.network.bridge.name"}}`;
/** Seule inspection acceptée : un pont, sans IPv6, sans trafic entre conteneurs, à son nom. */
export const RESEAU_CONFORME = `bridge|false|false|${PONT_BACS}`;
/** Résolveur de garde d'un bac filtré sans résolveur : adresse de documentation, jamais joignable, pour que le DNS interne de Docker ne relaie rien. */
export const DNS_DE_GARDE = "192.0.2.1";

/** argv de `docker network create` du réseau des bacs. */
export function argvCreationReseau(): string[] {
  return [
    "network",
    "create",
    "--driver",
    "bridge",
    "--ipv6=false",
    "--label",
    "elpis.role=sandbox",
    "-o",
    `${OPTION_ICC}=false`,
    "-o",
    `com.docker.network.bridge.name=${PONT_BACS}`,
    RESEAU_BACS,
  ];
}

/** Plages refusées par la protection « métadonnées » : lien local (services de métadonnées des clouds), ceux d'Alibaba Cloud et d'Azure (WireServer). */
export const PLAGES_METADONNEES: readonly string[] = [
  "169.254.0.0/16",
  "100.100.100.200/32",
  "168.63.129.16/32",
];
/** Plages refusées par la protection « réseau local » : adresses privées, partagées, lien local, multidiffusion et réservées. */
export const PLAGES_LOCALES: readonly string[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
];
const RESEAUX_METADONNEES: readonly Reseau[] = PLAGES_METADONNEES.map((p) => reseauPy(p)).filter(
  (r): r is Reseau => r !== null,
);

/** Sûre à épingler sans être listée : ni boucle, lien local, non spécifiée, multidiffusion ou métadonnées du cloud, ni la machine ou ses réseaux de conteneurs. */
function epinglableSansListe(a: AdresseIp, h: HoteMachine): boolean {
  const m = surLaMachine(a, h);
  return (
    !adresseCritique(a) && !RESEAUX_METADONNEES.some((r) => dansReseau(a, r)) && !m.adresse && !m.conteneurs
  );
}

/** Adresses d'un domaine de liste blanche que la sandbox épingle : celles que les adresses listées du profil couvrent déjà, et les autres si elles sont sûres (relevé de la machine `null` : écartées). */
export function adressesEpinglables(
  ips: readonly string[],
  listees: readonly unknown[],
  h: HoteMachine | null,
): { gardees: string[]; ecartees: string[] } {
  const couvertes = listees
    .map((x) => (typeof x === "string" ? reseauPy(x) : null))
    .filter((r): r is Reseau => r !== null);
  const gardees: string[] = [];
  const ecartees: string[] = [];
  for (const texte of ips) {
    const ip = adresseIpOuNul(texte);
    const gardee =
      ip !== null && (couvertes.some((r) => dansReseau(ip, r)) || (h !== null && epinglableSansListe(ip, h)));
    (gardee ? gardees : ecartees).push(texte);
  }
  return { gardees, ecartees };
}

/** Ce que la protection « hôte » refuse en plus des adresses de la machine : diffusion générale et multidiffusion. */
const DIFFUSIONS: readonly string[] = ["255.255.255.255/32", "224.0.0.0/4"];

/** Réseaux IPv4 que refusent les protections cochées d'un profil ouvert ; « hôte » : adresses IPv4 de la machine et diffusions de ses sous-réseaux, hors boucle, relevées à l'appel (aucune trouvée : erreur) ; vide sans protection. */
export async function plagesRefusees(
  protections: readonly string[],
  machine: () => Promise<HoteMachine> = hostAddresses,
): Promise<string[]> {
  const plages = new Set<string>();
  if (protections.includes("metadata")) for (const p of PLAGES_METADONNEES) plages.add(p);
  if (protections.includes("lan")) for (const p of PLAGES_LOCALES) plages.add(p);
  if (protections.includes("host")) {
    const h = await machine();
    const hote = h.adresses
      .filter((a) => a.version === 4)
      .map((a) => texteIp(a))
      .filter((t) => !t.startsWith("127."));
    if (hote.length === 0) throw new Error("aucune adresse IPv4 de la machine relevée");
    const diffusions = (h.diffusions ?? [])
      .filter((a) => a.version === 4)
      .map((a) => texteIp(a))
      .filter((t) => !t.startsWith("127."));
    for (const ip of [...hote, ...diffusions]) plages.add(`${ip}/32`);
    for (const p of DIFFUSIONS) plages.add(p);
  }
  return [...plages].sort(comparePointsDeCode);
}
