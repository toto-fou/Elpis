// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/mcp.ts — secrets des serveurs MCP au coffre : un secret JSON par serveur (`kind mcp`, portée `{server}`, nom `mcp-<serveur>`), déchiffré à chaque lecture ; port `CoffreMcp` de @elpis/mcp et refus rendus en erreurs HTTP. */
import { HttpError } from "@elpis/commun";
import { VALEUR_SECRET_MAX } from "@elpis/contracts";
import type { Base, Executeur } from "@elpis/db";
import { brancherCoffreMcp, SecretMcpIndisponible, secretsDeJson, secretsEnJson } from "@elpis/mcp";
import type { ActeurMcp, CoffreMcp, ContexteSecretMcp, MotifSecretMcp, SecretsServeur } from "@elpis/mcp";

import { ErreurSecret } from "./erreurs";
import { lirePolitique } from "./portee";
import {
  creerSecret,
  dechiffrerLigne,
  lireLigne,
  lireLigneParNom,
  modifierSecret,
  porteeDe,
  supprimerSecret,
} from "./stockage";
import type { LigneSecret, Proprietaire } from "./stockage";

/** Politique d'un secret MCP : les routines et les sous-agents s'en servaient déjà avant le coffre. */
const POLITIQUE_MCP = { subagents: true, routines: true };
const NOM_MAX = 48;

/** `mcp-<serveur>` en slug du coffre (`shared:3` → `mcp-shared-3`). */
export function nomSecretMcp(serveur: string): string {
  const s = serveur
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[._-]+/u, "");
  return `mcp-${s || "server"}`.slice(0, NOM_MAX);
}

/** Nom libre chez ce propriétaire : `mcp-<serveur>`, sinon suffixé `-2`, `-3`… */
async function nomLibre(x: Executeur, p: Proprietaire, serveur: string): Promise<string> {
  const base = nomSecretMcp(serveur);
  for (let n = 1; n <= 1000; n++) {
    const suffixe = n === 1 ? "" : `-${n}`;
    const nom = `${base.slice(0, NOM_MAX - suffixe.length)}${suffixe}`;
    if ((await lireLigneParNom(x, p, nom)) === null) return nom;
  }
  throw new ErreurSecret(409, "secret_name_taken", `No free name for the secret of MCP server '${serveur}'.`);
}

/** La ligne est le secret MCP de ce serveur (genre et portée). */
function duServeur(l: LigneSecret | null, serveur: string): l is LigneSecret {
  return l !== null && l.kind === "mcp" && (porteeDe(l) as Record<string, unknown>)["server"] === serveur;
}

function motifDe(e: ErreurSecret): MotifSecretMcp {
  if (e.code === "secret_key_unavailable") return "key_unavailable";
  return e.code === "secret_undecryptable" ? "undecryptable" : "missing";
}

/** Secret du serveur, de ce propriétaire, actif et permis à l'appelant (routine, sous-agent), déchiffré à chaque appel. */
export async function lireSecretMcp(
  base: Base,
  p: Proprietaire,
  id: number,
  serveur: string,
  contexte: ContexteSecretMcp = {},
): Promise<SecretsServeur> {
  const l = await lireLigne(base, p, id);
  if (!duServeur(l, serveur) || l.state !== "active")
    throw new SecretMcpIndisponible("missing", `secret ${id} absent du coffre ou d'un autre serveur`);
  const politique = lirePolitique(l.policy_json);
  if (
    (contexte.routine === true && !politique.routines) ||
    (contexte.sousAgent === true && !politique.subagents)
  )
    throw new SecretMcpIndisponible("refused", `secret ${l.name} refusé par sa politique`);
  try {
    return secretsDeJson(dechiffrerLigne(l));
  } catch (e) {
    if (e instanceof ErreurSecret) throw new SecretMcpIndisponible(motifDe(e), e.message);
    throw e;
  }
}

/** Nouvelle valeur du secret `id` s'il est bien celui du serveur, sinon un secret créé ; rend son id. */
export async function ecrireSecretMcp(
  base: Base,
  p: Proprietaire,
  serveur: string,
  valeur: SecretsServeur,
  id: number | null,
  acteur: ActeurMcp,
): Promise<number> {
  const texte = secretsEnJson(valeur);
  return base.ecriture(async (x) => {
    if (id !== null && duServeur(await lireLigne(x, p, id), serveur)) {
      await modifierSecret(base, p, id, { value: texte }, acteur);
      return id;
    }
    const cree = await creerSecret(
      base,
      p,
      {
        name: await nomLibre(x, p, serveur),
        kind: "mcp",
        scope: { server: serveur },
        value: texte,
        policy: POLITIQUE_MCP,
      },
      acteur,
    );
    return cree.id;
  });
}

/** Retire le secret `id` s'il est celui du serveur ; déjà retiré : rien. */
export async function supprimerSecretMcp(
  base: Base,
  p: Proprietaire,
  id: number,
  serveur: string,
  acteur: ActeurMcp,
): Promise<void> {
  if (duServeur(await lireLigne(base, p, id), serveur)) await supprimerSecret(base, p, id, acteur);
}

export const coffreMcpDuCore: CoffreMcp = {
  lire: lireSecretMcp,
  ecrire: ecrireSecretMcp,
  supprimer: supprimerSecretMcp,
};

/** Branche ce coffre sous les serveurs MCP (composition du core, essais). */
export function brancherCoffreMcpDuCore(): void {
  brancherCoffreMcp(coffreMcpDuCore);
}

/** Refus du coffre à l'enregistrement d'un serveur MCP, en erreur HTTP lisible dans l'interface ; `null` pour toute autre erreur. */
export function refusMcpEnHttp(e: unknown): HttpError | null {
  if (e instanceof SecretMcpIndisponible)
    return e.motif === "key_unavailable"
      ? new HttpError(503, "Clé du coffre indisponible : secrets MCP inaccessibles (voir ./elpis doctor).")
      : null;
  if (!(e instanceof ErreurSecret)) return null;
  if (e.code === "secret_key_unavailable")
    return new HttpError(
      503,
      "Clé du coffre indisponible : secret MCP non enregistré (voir ./elpis doctor).",
    );
  if (e.code === "secret_limit")
    return new HttpError(409, "Trop de secrets dans le coffre : supprimez-en dans Paramètres › Secrets.");
  if (e.code === "secret_value_invalid")
    return new HttpError(
      422,
      `Secrets du serveur MCP trop longs : ${VALEUR_SECRET_MAX} caractères au plus pour le jeton, les en-têtes et les variables réunis.`,
    );
  return new HttpError(e.statut, `Coffre : ${e.message}`);
}
