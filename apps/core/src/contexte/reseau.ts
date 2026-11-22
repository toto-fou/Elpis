// SPDX-License-Identifier: MIT
/** apps/core/src/contexte/reseau.ts — capacité réseau réelle du bac du compte, dite au modèle sans le nom du profil : niveau, ce qui compte pour lui, règle du relais Git ; listes triées, texte stable tant que le profil appliqué ne change pas. */
import { profilFiltre, protectionsDe } from "@elpis/bac";
import { comparePointsDeCode } from "@elpis/commun";

import type { ProfilEffectif } from "./ports";

type Refus = ReturnType<typeof protectionsDe>[number];

/** Règle du relais Git : tous les dépôts, serveurs choisis (aucun : Git refusé), dépôts des comptes Git vérifiés du compte. */
export type RegleRelaisGit =
  { acces: "all" } | { acces: "servers"; serveurs: string[] } | { acces: "accounts" };

/** Ce que joignent le shell et le navigateur du bac (rien, la liste blanche, tout sauf les protections cochées), règle du relais Git, réseau filtré (jamais root). */
export type CapaciteReseau = { git: RegleRelaisGit; filtre: boolean } & (
  | { niveau: "none" }
  | { niveau: "limited"; domaines: string[]; adresses: string[]; ports: number[]; dns: string[] }
  | { niveau: "full"; refus: Refus[] }
);

const NOMS_REFUS: Readonly<Record<Refus, string>> = {
  metadata: "cloud metadata",
  lan: "the local network (private addresses)",
  host: "the host machine",
};

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
      adresses: tries(p.ips),
      ports: [...new Set(p.ports ?? [])].sort((a, b) => a - b),
      dns: tries(p.dns),
    };
  if (p.mode === "bridge") return { ...commun, niveau: "full", refus: protectionsDe(coches) };
  return { ...commun, niveau: "none" };
}

const nom = (l: readonly unknown[], un: string, plusieurs: string): string => (l.length > 1 ? plusieurs : un);

function phraseReseau(c: CapaciteReseau): string {
  if (c.niveau === "none")
    return "none. The shell and the browser reach nothing outside the sandbox (localhost only): every outbound connection fails (expected, not a bug).";
  if (c.niveau === "full") {
    const refus = c.refus.map((r) => NOMS_REFUS[r]);
    if (refus.length === 0) return "full. The shell and the browser have open network access.";
    const liste = refus.length > 1 ? `${refus.slice(0, -1).join(", ")} and ${refus.at(-1)!}` : refus[0]!;
    return `full. The shell and the browser have open network access, except to ${liste}: a connection there is refused (expected, not a bug).`;
  }
  const cibles = [
    c.domaines.length ? `the ${nom(c.domaines, "domain", "domains")} ${c.domaines.join(", ")}` : "",
    c.adresses.length ? `the ${nom(c.adresses, "address", "addresses")} ${c.adresses.join(", ")}` : "",
  ].filter((x) => x !== "");
  const ports = c.ports.length
    ? `on TCP ${nom(c.ports, "port", "ports")} ${c.ports.join(", ")}`
    : "on every port";
  const atteint = cibles.length
    ? `The shell and the browser reach only ${cibles.join(" and ")}, ${ports}.`
    : "No destination is listed.";
  const dns = c.dns.length
    ? `${nom(c.dns, "DNS resolver", "DNS resolvers")}: ${c.dns.join(", ")}.`
    : `No DNS resolver${c.domaines.length ? ": only the listed domains resolve" : ""}.`;
  return `limited. ${atteint} ${dns} A connection to anything else is refused (expected, not a bug).`;
}

function phraseGit(g: RegleRelaisGit): string {
  if (g.acces === "all") return "the relay allows every repository";
  if (g.acces === "accounts")
    return "the relay allows only the repositories covered by the user's own verified Git accounts";
  if (g.serveurs.length === 0) return "the relay refuses every repository (no Git server is allowed)";
  return `the relay allows only ${nom(g.serveurs, "this server", "these servers")}: ${g.serveurs.join(", ")}`;
}

/** Puces « Network » et « Git » du `<runtime_context>` (texte vu par le modèle, en anglais). */
export function texteReseau(c: CapaciteReseau): string {
  return (
    `  • Network: ${phraseReseau(c)}\n` +
    "  • Git: remote operations of the git_* tools go through the host's Git relay, not the sandbox network; " +
    `${phraseGit(c.git)}. A git command run in the shell has only the sandbox network.`
  );
}
