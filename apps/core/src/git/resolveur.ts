// SPDX-License-Identifier: MIT
/** apps/core/src/git/resolveur.ts — identifiants git saisis dans l'éditeur, enregistrés dans le coffre pour l'hôte du dépôt, et import de l'ancien `.git-credentials.json` (shared_infra/git/resolver.py). */
import {
  clesOrdonnees,
  estDict,
  getPy,
  hostname,
  lowerPy,
  ouPy,
  pyJsonLoads,
  stripPy,
  strPy,
  urlsplit,
} from "@elpis/commun";
import type { Base } from "@elpis/db";

import { cheminCouvre, cheminDepot, hoteExact } from "../secrets/portee";
import type { Acteur } from "../secrets/stockage";
import {
  cheminDeLUrl,
  cheminPourType,
  compteCouvrant,
  createConnector,
  findForHost,
  hoteJoint,
  PROVIDER_TYPES,
  updateConnector,
} from "./connecteurs";
import type { LigneConnecteur } from "./connecteurs";
import { defaultProviderType, detectProvider, normalizeHost } from "./detection";

const HOTE_CANONIQUE: Readonly<Record<string, string>> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};

/** `_host_and_provider` : hôte (minuscules) et hébergeur détecté d'une URL de dépôt ou d'un `hôte[:port]` nu ; pour une URL, l'hôte que joint git, sinon `""` (écart : le Python peut lire l'hôte après un `@` du chemin). */
export function hoteEtFournisseur(cible: string): [string, string] {
  const info = detectProvider(cible || "");
  if (info?.host) return [hoteJoint(cible, lowerPy(info.host)), info.provider];
  return [lowerPy(normalizeHost(cible) || ""), "unknown"];
}

/** Portée où ranger des identifiants saisis au clone, dans la casse de l'URL : celle demandée si elle couvre le dépôt ; sinon celle du compte à chemin qui le couvre, tout l'hôte si aucun compte ne l'a, ou le parent du dépôt quand un compte tient déjà tout l'hôte ; `null` (rien n'est enregistré) quand le dépôt est illisible et que tout l'hôte a déjà son compte, jamais remplacé d'office. */
export function porteeDesSaisis(
  comptes: readonly LigneConnecteur[],
  chemin: string | null,
  demandee?: string | null,
): string | null {
  const prefixe = (segments: number): string => (chemin ?? "").split("/").slice(0, segments).join("/");
  const d = typeof demandee === "string" ? cheminDepot(demandee) : null;
  if (d === "") return "";
  if (d !== null && cheminCouvre(d.toLowerCase(), chemin === null ? null : chemin.toLowerCase()))
    return prefixe(d.split("/").length);
  if (chemin === null) return comptes.some((c) => c.path === "") ? null : "";
  const couvrant = compteCouvrant(comptes, chemin);
  if (couvrant === undefined) return "";
  return prefixe(couvrant.path ? couvrant.path.split("/").length : chemin.split("/").length - 1);
}

/** `save_git_credential` (clone de l'éditeur) : compte git de la portée retenue (`porteeDesSaisis`) rafraîchi (jeton dans le coffre, identifiant fourni), sinon créé (type donné, détecté, ou gitea) ; son id, `null` sans jeton ni hôte, ou quand rien n'est à enregistrer. */
export async function saveGitCredential(
  base: Base,
  uid: number,
  cible: string,
  utilisateur: string,
  jeton: string,
  typeFournisseur: string,
  acteur: Acteur,
  portee?: string | null,
): Promise<number | null> {
  if (!(uid && jeton && stripPy(jeton))) return null;
  const [hote, detecte] = hoteEtFournisseur(cible);
  if (!hote) return null;
  const net = stripPy(jeton);
  const comptes = await findForHost(base, uid, hote);
  const chemin = porteeDesSaisis(comptes, cheminDeLUrl(cible), portee);
  if (chemin === null) return null;
  const existant = comptes.find((c) => c.path === cheminPourType(chemin, c.provider_type));
  if (existant !== undefined) {
    await updateConnector(base, uid, existant.id, { token: net, username: utilisateur || null }, acteur);
    return existant.id;
  }
  let type = stripPy(lowerPy(typeFournisseur || ""));
  if (!PROVIDER_TYPES.includes(type)) {
    const det = defaultProviderType(detecte);
    type = det !== "generic" ? det : "gitea";
  }
  return createConnector(
    base,
    uid,
    type,
    hote,
    { token: net, path: chemin, username: utilisateur || "", label: "auto" },
    acteur,
  );
}

/** `(v or "").strip()` d'une valeur de l'ancien fichier ; un non-texte lève (import en échec, comme le Python). */
function texte(v: unknown): string {
  const w = ouPy(v, "");
  if (typeof w !== "string") throw new TypeError("valeur non textuelle dans .git-credentials.json");
  return stripPy(w);
}

/** `import_legacy_git_credentials` : comptes git créés depuis l'ancien fichier du bac (que l'agent peut écrire), jetons dans le coffre à vérifier par l'utilisateur (`unverified`, source `sandbox-file`) : aucun ne sert avant ; un hôte déjà présent est gardé, un hôte non `admis` compté par `refus` ; `-1` si l'import échoue (fichier gardé). */
export async function importLegacyGitCredentials(
  base: Base,
  uid: number,
  donnees: Buffer,
  acteur: Acteur,
  options: { admis?: (hote: string) => Promise<boolean>; refus?: () => void } = {},
): Promise<number> {
  if (!uid) return 0;
  let entrees: unknown;
  try {
    entrees = pyJsonLoads(new TextDecoder("utf-8", { ignoreBOM: true }).decode(donnees), { mode: "natif" });
  } catch {
    return 0;
  }
  if (!estDict(entrees)) return 0;
  try {
    let crees = 0;
    for (const cle of clesOrdonnees(entrees)) {
      const entree = entrees[cle];
      if (!estDict(entree)) continue;
      const jeton = texte(getPy(entree, "token"));
      if (!jeton) continue;
      const url = texte(getPy(entree, "url"));
      const fournisseur = lowerPy(strPy(cle));
      const hote = url
        ? lowerPy(hostname(urlsplit(url)) ?? "")
        : Object.hasOwn(HOTE_CANONIQUE, fournisseur)
          ? (HOTE_CANONIQUE[fournisseur] as string)
          : "";
      if (!hote || hoteExact(hote) === null) continue;
      if ((await findForHost(base, uid, hote)).length) continue;
      if (options.admis && !(await options.admis(hote))) {
        options.refus?.();
        continue;
      }
      const user = ouPy(getPy(entree, "user"), "");
      if (typeof user !== "string" && typeof user !== "number" && typeof user !== "boolean")
        throw new TypeError("identifiant non textuel dans .git-credentials.json");
      await createConnector(
        base,
        uid,
        defaultProviderType(fournisseur),
        hote,
        {
          token: jeton,
          username: user === true ? "1" : strPy(user),
          label: "imported",
          source: "sandbox-file",
        },
        acteur,
      );
      crees += 1;
    }
    return crees;
  } catch {
    return -1;
  }
}
