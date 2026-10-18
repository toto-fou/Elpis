// SPDX-License-Identifier: MIT
/** apps/core/src/git/resolveur.ts — identifiants git saisis enregistrés pour l'hôte du dépôt, et import de l'ancien `.git-credentials.json` (shared_infra/git/resolver.py). */
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
import type { Executeur } from "@elpis/db";

import {
  createConnector,
  findForHost,
  hoteEnregistre,
  hoteJoint,
  PROVIDER_TYPES,
  updateConnector,
} from "./connecteurs";
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

/** `save_git_credential` : connecteur de l'hôte rafraîchi (jeton, identifiant fourni), sinon créé (type donné, détecté, ou gitea) ; son id, `null` sans jeton ni hôte. */
export async function saveGitCredential(
  x: Executeur,
  uid: number,
  cible: string,
  utilisateur: string,
  jeton: string,
  typeFournisseur = "",
): Promise<number | null> {
  if (!(uid && jeton && stripPy(jeton))) return null;
  const [hote, detecte] = hoteEtFournisseur(cible);
  if (!hote) return null;
  const net = stripPy(jeton);
  const existants = await findForHost(x, uid, hote);
  const premier = existants[0];
  if (premier !== undefined) {
    await updateConnector(x, uid, premier.id, { token: net, username: utilisateur || null });
    return premier.id;
  }
  let type = stripPy(lowerPy(typeFournisseur || ""));
  if (!PROVIDER_TYPES.includes(type)) {
    const det = defaultProviderType(detecte);
    type = det !== "generic" ? det : "gitea";
  }
  return createConnector(x, uid, type, hote, { token: net, username: utilisateur || "", label: "auto" });
}

/** Identifiant posé par un outil de l'agent : seulement pour un hôte déjà enregistré par le compte ou un admin, et sans toucher un connecteur saisi à la main ou importé (seul un `auto` est mis à jour) ; écart : Python crée ou met à jour pour tout hôte. */
export async function saveGitCredentialAgent(
  x: Executeur,
  uid: number,
  cible: string,
  utilisateur: string,
  jeton: string,
  typeFournisseur = "",
): Promise<{ id: number | null; refus: "host_not_registered" | "connector_exists" | null }> {
  if (!(uid && jeton && stripPy(jeton))) return { id: null, refus: null };
  const [hote] = hoteEtFournisseur(cible);
  if (!hote) return { id: null, refus: null };
  if (!(await hoteEnregistre(x, uid, hote))) return { id: null, refus: "host_not_registered" };
  const premier = (await findForHost(x, uid, hote))[0];
  if (premier !== undefined && premier.label !== "auto") return { id: null, refus: "connector_exists" };
  return { id: await saveGitCredential(x, uid, cible, utilisateur, jeton, typeFournisseur), refus: null };
}

/** `(v or "").strip()` d'une valeur de l'ancien fichier ; un non-texte lève (import en échec, comme le Python). */
function texte(v: unknown): string {
  const w = ouPy(v, "");
  if (typeof w !== "string") throw new TypeError("valeur non textuelle dans .git-credentials.json");
  return stripPy(w);
}

/** `import_legacy_git_credentials` : connecteurs créés depuis l'ancien fichier (un hôte déjà présent est gardé, un hôte non `admis` compté par `refus`) ; `-1` si l'import échoue (fichier gardé). */
export async function importLegacyGitCredentials(
  x: Executeur,
  uid: number,
  donnees: Buffer,
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
      if (!hote) continue;
      if ((await findForHost(x, uid, hote)).length) continue;
      if (options.admis && !(await options.admis(hote))) {
        options.refus?.();
        continue;
      }
      const user = ouPy(getPy(entree, "user"), "");
      if (typeof user !== "string" && typeof user !== "number" && typeof user !== "boolean")
        throw new TypeError("identifiant non textuel dans .git-credentials.json");
      await createConnector(x, uid, defaultProviderType(fournisseur), hote, {
        token: jeton,
        username: user === true ? "1" : strPy(user),
        label: "imported",
      });
      crees += 1;
    }
    return crees;
  } catch {
    return -1;
  }
}
