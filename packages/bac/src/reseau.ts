// SPDX-License-Identifier: MIT
/** packages/bac/src/reseau.ts — réseau Docker des bacs en mode ouvert ou liste blanche : pont dédié, trafic entre conteneurs coupé ; les relais de l'hôte reconnaissent son pont à son nom (`br-`). */

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
