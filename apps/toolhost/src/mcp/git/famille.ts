// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/git/famille.ts — famille `git` servie par l'hôte (llm_core/tools/git_tools.py) : 11 outils, définitions figées par le golden Python, compte de l'appel, identifiants et PR par rappel au core. */
import type { PortProfilRappel } from "@elpis/bac";
import { strPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { SourceGit } from "@elpis/fichiers";
import { py } from "@elpis/http";
import { getUsername, outilDuGolden } from "@elpis/outils-mcp";
import type { ContexteAppel, DefinitionOutil, Golden } from "@elpis/outils-mcp";
import goldenGit from "@elpis/outils-mcp/goldens/git.json" with { type: "json" };
import { lireSousAgent } from "@elpis/securite";

import { refusEcritureResolue, sousAgentBorne } from "../ecriture-sous-agent";
import { brancherRappelProfil, Espace } from "../espace";
import { gitAction } from "./action";
import type { ArgsActionGit } from "./action";
import { gitClone, gitSetCredential } from "./clone";
import type { ArgsClone, EnregistrerIdentifiant } from "./clone";
import { CompteGit, depotSur, errGit, fichierDuDepot, strExc } from "./commun";
import { gitWrite } from "./ecriture";
import type { ArgsEcritureGit } from "./ecriture";
import { gitQuery } from "./requete";
import type { ArgsRequete } from "./requete";
import { gitRf } from "./rf";
import type { ArgsRf } from "./rf";
import { gitAbandon, gitCommit, gitInspect, gitStartWork, gitSubmit, refusSansRemote } from "./travail";
import type { PortPr } from "./travail";

type Signature = DefinitionOutil["signature"];

/** Ce que la famille demande au core : identifiants et hôtes des connecteurs, identité, profil réseau, PR, enregistrement d'un identifiant. */
export type RappelGit = SourceGit &
  PortProfilRappel &
  Partial<PortPr> & {
    identityForUsername(
      username: string,
    ): Promise<{ readonly user_id: number; readonly network_profile_id: string } | null>;
    enregistrerIdentifiantGitDetaille?: EnregistrerIdentifiant;
  };

const SANS_RAPPEL: SourceGit = { gitCredential: async () => null, connectorHosts: async () => [] };

const textes = (): ReturnType<typeof py.list> => py.list(py.str()).fabrique(() => []);

const REQUETE: Signature = {
  repo: py.str(),
  action: py.literal(
    "status",
    "log",
    "diff",
    "show",
    "blame",
    "branches",
    "tags",
    "remotes",
    "conflicts",
    "grep",
    "files",
    "find_text",
    "read",
    "repos",
  ),
  target: py.str().defaut(""),
  target2: py.str().defaut(""),
  pattern: py.str().defaut(""),
  max_count: py.int().defaut(200),
  ignore_case: py.bool().defaut(true),
  start_line: py.int().defaut(1),
  max_lines: py.int().defaut(200),
};

const ECRITURE: Signature = {
  repo: py.str(),
  action: py.literal("write", "replace"),
  path: py.str(),
  content: py.str().defaut(""),
  find: py.str().defaut(""),
  replace: py.str().defaut(""),
  regex: py.bool().defaut(false),
  mode: py.literal("overwrite", "append").defaut("overwrite"),
  dry_run: py.bool().defaut(false),
};

const ACTION: Signature = {
  repo: py.str(),
  action: py.literal(
    "init",
    "clone",
    "switch",
    "stage",
    "unstage",
    "restore",
    "fetch",
    "pull",
    "stash",
    "stash_pop",
    "stash_list",
    "merge",
    "cherry_check",
  ),
  branch: py.str().defaut(""),
  paths: textes(),
  create: py.bool().defaut(false),
  message: py.str().defaut(""),
  target: py.str().defaut(""),
  strategy: py.literal("ff-only", "merge", "rebase", "no-ff", "squash").defaut("ff-only"),
  dry_run: py.bool().defaut(false),
};

const RF: Signature = {
  repo: py.str(),
  action: py.literal("scan", "find", "settings"),
  subfolder: py.str().defaut(""),
  keyword_name: py.str().defaut(""),
  keywords_used: textes(),
  test_file_path: py.str().defaut(""),
  suite_doc: py.str().defaut(""),
  fuzzy: py.bool().defaut(true),
};

const INSPECTION: Signature = { repo: py.str() };
const DEBUT: Signature = { repo: py.str(), branch_intent: py.str(), base: py.str().defaut("") };
const COMMIT: Signature = {
  repo: py.str(),
  message: py.str(),
  scope: py.literal("auto", "staged", "paths").defaut("auto"),
  paths: textes(),
  allow_secrets: py.bool().defaut(false),
};
const SOUMISSION: Signature = {
  repo: py.str(),
  title: py.str(),
  body: py.str().defaut(""),
  base: py.str().defaut(""),
  draft: py.bool().defaut(true),
};
const ABANDON: Signature = { repo: py.str(), keep_branch: py.bool().defaut(false) };
const CLONE: Signature = {
  url: py.str(),
  into_path: py.str().defaut(""),
  branch: py.str().defaut(""),
  username: py.str().defaut(""),
  token: py.str().defaut(""),
};
const IDENTIFIANT: Signature = {
  target: py.str(),
  token: py.str(),
  username: py.str().defaut(""),
  provider_type: py.str().defaut(""),
};

/** `git_write` d'un sous-agent borné : fichier du dépôt tel que l'outil l'écrira (ancien rangement `git_repos/`, liens suivis) ; une faute d'argument est laissée à l'outil. */
async function refusGitWriteResolu(c: CompteGit, a: Dict, ctx: ContexteAppel): Promise<Dict | null> {
  const sa = sousAgentBorne(ctx);
  if (sa === null) return null;
  let rel: string;
  try {
    rel = fichierDuDepot(await depotSur(c.esp, strPy(a["repo"] ?? "")), strPy(a["path"] ?? ""));
  } catch {
    return null;
  }
  return refusEcritureResolue(c.esp, sa.writable_paths, [rel]);
}

/** Outils de la famille `git`, dans l'ordre de `register` (git_tools.py), chacun sur le bac du compte de l'appel (panne de l'espace → `unexpected: …`). */
export function outilsGit(rappel: RappelGit | null = null): DefinitionOutil[] {
  const g = goldenGit as Golden;
  const source: CompteGit["source"] = rappel ?? SANS_RAPPEL;
  const pr: PortPr | null = rappel?.ouvrirPr ? { ouvrirPr: rappel.ouvrirPr.bind(rappel) } : null;
  const enregistrer = rappel?.enregistrerIdentifiantGitDetaille?.bind(rappel) ?? null;
  const surCompte =
    (f: (c: CompteGit, a: Dict, ctx: ContexteAppel) => Promise<Dict>, remoteDAbord = false) =>
    async (v: Dict, ctx: ContexteAppel): Promise<Dict> => {
      const username = getUsername(ctx);
      let c: CompteGit;
      try {
        c = new CompteGit(username, await Espace.pour(username), source);
      } catch (e) {
        return errGit(`unexpected: ${strExc(e)}`);
      }
      if (remoteDAbord && lireSousAgent(ctx.meta?.["subagent"])?.type === "pr") {
        const refus = await refusSansRemote(c, strPy(v["repo"] ?? ""));
        if (refus !== null) return refus;
      }
      return f(c, v, ctx);
    };
  return [
    outilDuGolden(g, "git_query", {
      signature: REQUETE,
      traiter: surCompte((c, a) => gitQuery(c, a as unknown as ArgsRequete)),
    }),
    outilDuGolden(g, "git_write", {
      signature: ECRITURE,
      traiter: surCompte(
        async (c, a, ctx) =>
          (await refusGitWriteResolu(c, a, ctx)) ?? gitWrite(c, a as unknown as ArgsEcritureGit),
      ),
    }),
    outilDuGolden(g, "git_action", {
      signature: ACTION,
      traiter: surCompte((c, a) => gitAction(c, a as unknown as ArgsActionGit)),
    }),
    outilDuGolden(g, "git_rf", {
      signature: RF,
      traiter: surCompte((c, a) => gitRf(c, a as unknown as ArgsRf)),
    }),
    outilDuGolden(g, "git_inspect", {
      signature: INSPECTION,
      traiter: surCompte((c, a) => gitInspect(c, a as unknown as { repo: string })),
    }),
    outilDuGolden(g, "git_start_work", {
      signature: DEBUT,
      traiter: surCompte((c, a) => gitStartWork(c, a as unknown as Parameters<typeof gitStartWork>[1]), true),
    }),
    outilDuGolden(g, "git_commit", {
      signature: COMMIT,
      traiter: surCompte((c, a) => gitCommit(c, a as unknown as Parameters<typeof gitCommit>[1]), true),
    }),
    outilDuGolden(g, "git_submit", {
      signature: SOUMISSION,
      traiter: surCompte((c, a) => gitSubmit(c, pr, a as unknown as Parameters<typeof gitSubmit>[2])),
    }),
    outilDuGolden(g, "git_abandon", {
      signature: ABANDON,
      traiter: surCompte((c, a) => gitAbandon(c, a as unknown as Parameters<typeof gitAbandon>[1])),
    }),
    outilDuGolden(g, "git_clone", {
      signature: CLONE,
      traiter: surCompte((c, a) => gitClone(c, enregistrer, a as unknown as ArgsClone)),
    }),
    outilDuGolden(g, "git_set_credential", {
      signature: IDENTIFIANT,
      traiter: (v, ctx) =>
        gitSetCredential(
          CompteGit.sansEspace(getUsername(ctx), source),
          enregistrer,
          v as unknown as Parameters<typeof gitSetCredential>[2],
        ),
    }),
  ];
}

/** Famille `git` de l'hôte (forme `FabriqueNative`) : espace de chaque appel = bac du compte sous le profil effectif. */
export function familleGit(o: { readonly rappel?: RappelGit | null } = {}): {
  famille: string;
  outils: readonly DefinitionOutil[];
} {
  if (o.rappel) brancherRappelProfil(o.rappel);
  return { famille: "git", outils: outilsGit(o.rappel ?? null) };
}
