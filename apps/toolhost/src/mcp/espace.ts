// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/espace.ts — le `/work` d'un compte par l'agent de son bac (llm_core/tools/_espace.py) : les familles fs, shell, git et desktop n'ouvrent jamais le dossier du bac sur l'hôte. */
import { bacDeLOutil } from "@elpis/bac";
import type { PortProfilRappel } from "@elpis/bac";
import type { Dict } from "@elpis/commun";
import {
  AgentError,
  findRepos,
  importLegacyCredentials,
  pull,
  remoteUrl,
  run,
  runNetwork,
} from "@elpis/fichiers";
import type { AgentClient, AgentListing, AgentRead, GitResult, OptionsReseau } from "@elpis/fichiers";
import { foldConfusable, twinMessage } from "@elpis/outils-mcp";
import { userIdFor } from "@elpis/securite";

type DonneesEcrites = Parameters<AgentClient["write"]>[1];

/** Espace d'un compte : bac du process (`get_user_sandbox`, profil de `profilDuBac`) et son agent ; remplaçable par les tests. */
export type FabriqueEspace = (username: string) => Promise<Espace>;

let rappelProfil: PortProfilRappel | null = null;

/** Rappel au core qui donne le profil réseau effectif de main (le `_meta` de /mcp n'en porte pas) ; posé par la composition. */
export function brancherRappelProfil(r: PortProfilRappel | null): void {
  rappelProfil = r;
}

async function espaceDuBac(username: string): Promise<Espace> {
  const uid = await userIdFor(username);
  const bac = await bacDeLOutil(uid, username, rappelProfil);
  return new Espace(bac.sandboxPath, uid, bac.agent as AgentClient);
}

let fabrique: FabriqueEspace = espaceDuBac;

/** Remplace la fabrique d'espaces (`null` : celle du bac du compte). */
export function installerFabriqueEspace(f: FabriqueEspace | null): void {
  fabrique = f ?? espaceDuBac;
}

export class Espace {
  /** `P/work` du compte : noms et chemins affichés seulement, jamais ouvert. */
  readonly racine: string;
  readonly uid: number;
  readonly agent: AgentClient;

  constructor(racine: string, uid: number, agent: AgentClient) {
    this.racine = racine;
    this.uid = uid;
    this.agent = agent;
  }

  /** `Espace(username, racine)` : bac du compte (id de l'enveloppe, sinon de la base ; profil effectif) et son agent. */
  static pour(username: string): Promise<Espace> {
    return fabrique(username);
  }

  /** Une entrée ; son refus (lien hors de /work, droits…) en `AgentError`. */
  async stat(rel: string, o: { hash?: boolean; hashMax?: number } = {}): Promise<Dict> {
    const e = (await this.stats([rel], o))[0] ?? {};
    if (e["kind"] === "error")
      throw new AgentError(String(e["error"] || "io_error"), String(e["message"] || ""));
    return e;
  }

  stats(rels: Iterable<string>, o: { hash?: boolean; hashMax?: number } = {}): Promise<Dict[]> {
    return this.agent.stat(rels, { hash: o.hash ?? false, hashMax: o.hashMax ?? 64 << 20 });
  }

  lire(rel: string, o: Parameters<AgentClient["read"]>[1] = {}): Promise<AgentRead> {
    return this.agent.read(rel, o);
  }

  lirePlusieurs(
    rels: Iterable<string>,
    o: Parameters<AgentClient["readMany"]>[1] = {},
  ): Promise<Map<string, Buffer | null>> {
    return this.agent.readMany(rels, o);
  }

  ecrire(rel: string, data: DonneesEcrites, o: Parameters<AgentClient["write"]>[2] = {}): Promise<Dict> {
    return this.agent.write(rel, data, o);
  }

  lister(rel = "", o: Parameters<AgentClient["list"]>[1] = {}): Promise<AgentListing> {
    return this.agent.list(rel, o);
  }

  grep(
    rels: Iterable<string>,
    aiguille: string,
    o: Parameters<AgentClient["grep"]>[2] = {},
  ): Promise<[Dict[], Dict]> {
    return this.agent.grep(rels, aiguille, o);
  }

  /** Relevé avant une commande (cf. `changements.ts`). */
  releveDebut(skip: Iterable<string>, o: Parameters<AgentClient["changesBegin"]>[1] = {}): Promise<Dict> {
    return this.agent.changesBegin(skip, o);
  }

  releveFin(ident: string, o: Parameters<AgentClient["changesEnd"]>[1] = {}): Promise<[Dict[], Dict]> {
    return this.agent.changesEnd(ident, o);
  }

  fsop(op: string, args: Dict = {}): Promise<Dict> {
    return this.agent.fsop(op, args);
  }

  /** git exécuté par l'agent (`git_ops.run`). */
  git(rel: string, args: Iterable<string>, o: Parameters<typeof run>[3] = {}): Promise<GitResult> {
    return run(this.agent, rel, args, o);
  }

  /** Commande réseau par le relais authentifiant (`git_ops.run_network`). */
  gitReseau(rel: string, args: Iterable<string>, o: OptionsReseau): Promise<GitResult> {
    return runNetwork(this.agent, rel, args, o);
  }

  /** `git pull <mode> <remote> [<branche>]` : fetch par le relais, fusion locale (`git_ops.pull`). */
  gitPull(
    rel: string,
    remote: string,
    branche: string,
    mode: string,
    o: Omit<OptionsReseau, "url" | "pushRefs">,
  ): Promise<GitResult> {
    return pull(this.agent, rel, remote, branche, mode, o);
  }

  gitRemoteUrl(rel: string, remote: string, o: { push?: boolean } = {}): Promise<string> {
    return remoteUrl(this.agent, rel, remote, o);
  }

  gitDepots(o: Parameters<typeof findRepos>[1] = {}): Promise<string[]> {
    return findRepos(this.agent, o);
  }

  /** Import unique de l'ancien `/work/.git-credentials.json` pour le compte `uid`/`username`. */
  gitAnciensIdentifiants(uid: number, username: string): Promise<void> {
    return importLegacyCredentials(this.agent, uid, username);
  }

  /** Avertissement si créer `rel` introduit un nom qui ne diffère d'un voisin que par les accents ou la casse ; jamais bloquant. */
  async jumeauUnicode(rel: string, maxScan = 500): Promise<string | null> {
    const parties = rel.split("/").filter((c) => c);
    let i: number;
    let voisins: Dict[];
    try {
      const entrees = await this.stats(parties.map((_, k) => parties.slice(0, k + 1).join("/")));
      i = entrees.findIndex((e) => e["kind"] === "missing");
      if (i < 0) return null;
      voisins = (await this.lister(parties.slice(0, i).join("/"), { maxEntries: maxScan })).entries;
    } catch (e) {
      if (e instanceof AgentError) return null;
      throw e;
    }
    const nom = parties[i] as string;
    const plie = foldConfusable(nom);
    return twinMessage(
      voisins
        .map((v) => String(v["path"]).split("/").pop() ?? "")
        .filter((n) => n !== nom && foldConfusable(n) === plie)
        .map((n) => [n, nom] as const),
    );
  }
}
