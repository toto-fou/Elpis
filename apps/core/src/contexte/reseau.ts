// SPDX-License-Identifier: MIT
/** apps/core/src/contexte/reseau.ts — capacité réseau réelle du bac du compte, dite au modèle sans le nom du profil ni aucune adresse : niveau, domaines et ports permis, plages d'adresses et résolveurs comptés, refus des relais, règle du relais Git ; texte stable tant que le profil appliqué ne change pas. */
import { profilFiltre, protectionsDe } from "@elpis/bac";
import { comparePointsDeCode } from "@elpis/commun";

import type { ProfilEffectif } from "./ports";

type Refus = ReturnType<typeof protectionsDe>[number];

/** Règle du relais Git : tous les dépôts, serveurs choisis (aucun : Git refusé), dépôts des comptes Git vérifiés du compte. */
export type RegleRelaisGit =
  { acces: "all" } | { acces: "servers"; serveurs: string[] } | { acces: "accounts" };

/** Ce que joignent le shell et le navigateur du bac (rien, la liste blanche, tout sauf les protections cochées), règle du relais Git, réseau filtré (jamais root) ; adresses et résolveurs de la liste comptés, jamais nommés. */
export type CapaciteReseau = { git: RegleRelaisGit; filtre: boolean } & (
  | { niveau: "none" }
  | { niveau: "limited"; domaines: string[]; adresses: number; ports: number[]; dns: number }
  | { niveau: "full"; refus: Refus[] }
);

const NOMS_REFUS: Readonly<Record<Refus, string>> = {
  metadata: "cloud metadata",
  lan: "the local network (private addresses)",
  host: "the host machine",
};

/** Refus du profil auxquels échappent les serveurs Git choisis (jamais les métadonnées du cloud). */
const DISPENSES_GIT: Readonly<Partial<Record<Refus, string>>> = {
  lan: "on the local network",
  host: "on the host machine",
};

/** Refus propres au relais du navigateur, à chaque niveau qui a du réseau. */
const NAVIGATEUR =
  "The browser never reaches the host machine or its container networks, nor local-network hosts outside " +
  "the browser allowlist when the administrator set one.";

function tries(l: readonly unknown[] | undefined): string[] {
  return [...new Set((l ?? []).map(String))].sort(comparePointsDeCode);
}

/** Capacité du profil appliqué, celle que posent le conteneur et les relais ; mode inconnu : aucun réseau (comme à la lecture de config.json), champ absent : celui d'un profil vide. */
export function capaciteReseau(p: ProfilEffectif): CapaciteReseau {
  const coches = {
    mode: p.mode,
    block_metadata: p.block_metadata === true,
    block_lan: p.block_lan === true,
    block_host: p.block_host === true,
  };
  const git: RegleRelaisGit =
    p.git_access === "servers"
      ? { acces: "servers", serveurs: tries(p.git_servers) }
      : p.git_access === "accounts"
        ? { acces: "accounts" }
        : { acces: "all" };
  const commun = { git, filtre: profilFiltre(coches) };
  if (p.mode === "allowlist_ip")
    return {
      ...commun,
      niveau: "limited",
      domaines: tries(p.domains),
      adresses: tries(p.ips).length,
      ports: [...new Set(p.ports ?? [])].sort((a, b) => a - b),
      dns: tries(p.dns).length,
    };
  if (p.mode === "bridge") return { ...commun, niveau: "full", refus: protectionsDe(coches) };
  return { ...commun, niveau: "none" };
}

const nom = (n: number, un: string, plusieurs: string): string => (n > 1 ? plusieurs : un);

function phraseReseau(c: CapaciteReseau): string {
  if (c.niveau === "none")
    return "none. The shell and the browser reach nothing outside the sandbox (localhost only): every outbound connection fails (expected, not a bug).";
  if (c.niveau === "full") {
    const refus = c.refus.map((r) => NOMS_REFUS[r]);
    if (refus.length === 0)
      return `full. The shell and the browser have open network access; the shell has no IPv6. ${NAVIGATEUR}`;
    const liste = refus.length > 1 ? `${refus.slice(0, -1).join(", ")} and ${refus.at(-1)!}` : refus[0]!;
    return `full. The shell and the browser have open network access, except to ${liste}: a connection there, or over IPv6, is refused (expected, not a bug). ${NAVIGATEUR}`;
  }
  const cibles = [
    c.domaines.length ? `the ${nom(c.domaines.length, "domain", "domains")} ${c.domaines.join(", ")}` : "",
    c.adresses
      ? `${c.adresses} ${nom(c.adresses, "address range", "address ranges")} set by the administrator`
      : "",
  ].filter((x) => x !== "");
  const ports = c.ports.length
    ? `on TCP ${nom(c.ports.length, "port", "ports")} ${c.ports.join(", ")}`
    : "on every port";
  const atteint = cibles.length
    ? `The shell and the browser reach only ${cibles.join(" and ")}, ${ports}; the shell has no IPv6.`
    : "No destination is listed.";
  const dns = c.dns
    ? `DNS for the shell: ${c.dns} ${nom(c.dns, "resolver", "resolvers")} set by the administrator.`
    : `No DNS resolver for the shell${c.domaines.length ? ": only the listed domains resolve" : ""}.`;
  return `limited. ${atteint} ${dns} A connection to anything else is refused (expected, not a bug). ${NAVIGATEUR}`;
}

function phraseGit(g: RegleRelaisGit): string {
  if (g.acces === "all") return "the relay allows every repository";
  if (g.acces === "accounts")
    return "the relay allows only the repositories covered by the user's own verified Git accounts";
  if (g.serveurs.length === 0) return "the relay refuses every repository (no Git server is allowed)";
  return `the relay allows only ${nom(g.serveurs.length, "this server", "these servers")}: ${g.serveurs.join(", ")}`;
}

/** Refus du relais Git sur un profil ouvert protégé : ceux du réseau du bac, IPv6 compris ; les serveurs choisis échappent au réseau local et à la machine hôte, jamais aux métadonnées. */
function refusGit(c: CapaciteReseau): string {
  if (c.niveau !== "full" || c.refus.length === 0) return "";
  const g = c.git;
  if (g.acces === "servers" && g.serveurs.length === 0) return "";
  const dispenses = g.acces === "servers" ? c.refus.flatMap((r) => DISPENSES_GIT[r] ?? []) : [];
  const sauf =
    g.acces === "servers" && dispenses.length
      ? `, except that ${nom(g.serveurs.length, "this server", "these servers")} may be ${dispenses.join(" or ")}`
      : "";
  return ` The relay refuses what the sandbox network refuses${sauf}.`;
}

/** Puces « Network » et « Git » du `<runtime_context>` (texte vu par le modèle, en anglais). */
export function texteReseau(c: CapaciteReseau): string {
  return (
    `  • Network: ${phraseReseau(c)}\n` +
    "  • Git: remote operations of the git_* tools go through the host's Git relay, not the sandbox network; " +
    `${phraseGit(c.git)}.${refusGit(c)} A git command run in the shell has only the sandbox network.`
  );
}
