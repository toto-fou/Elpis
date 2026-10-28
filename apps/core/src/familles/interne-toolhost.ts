// SPDX-License-Identifier: MIT
/** apps/core/src/familles/interne-toolhost.ts — `/api/internal/*` appelées par l'hôte d'outils (jeton de service) : introspection de jeton, identité, identifiant git, hôtes des connecteurs (toolhost/routes_internal.py) ; notification, ancres du bureau, ouverture de PR et identifiant git saisi pour le compte de l'enveloppe signée ; quota du bac et anciens identifiants git importés (propres au TS). */
import { getUser, getUserSettings, ligneUtilisateur, resoudreJeton } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { estDict, getPy, HttpError, intPy, lowerPy, ouPy, stripPy, strPy, texteNet } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";
import { corpsJson, entrees, premierEntete, py } from "@elpis/http";
import { toolhostEntry } from "@elpis/mcp";
import { IDENTITY_HEADER, verify } from "@elpis/securite";
import type { Identity } from "@elpis/securite";
import type { FastifyRequest } from "fastify";

import { ancresDeLaBase, obsKey } from "../bureau";
import { resoudreReferences } from "../coffre/jetons";
import { hoteEnregistre, listConnectorHosts, resolveGitCredential } from "../git/connecteurs";
import { detectProvider, normalizeHost } from "../git/detection";
import { ouvrirPrPourHote } from "../git/pr";
import { importLegacyGitCredentials, saveGitCredential, saveGitCredentialAgent } from "../git/resolveur";
import type { Journal } from "../journal";
import { consommer, creerDemande } from "../procedures/demandes";
import { createNotification } from "../notifications/stockage";
import { resolveNetworkProfileId } from "../relais/identite";
import type { Famille } from "../routes";

function jetonDuManifeste(): string {
  try {
    return toolhostEntry()?.token ?? "";
  } catch {
    return "";
  }
}

/** `_service_token` : jeton de l'entrée toolhost du manifeste, sinon LOCAL_MCP_TOKEN. */
export function jetonServiceDuManifeste(): string {
  return jetonDuManifeste() || texteNet(config.LOCAL_MCP_TOKEN);
}

export interface DependancesInterne {
  readonly auth: DependancesAuth & DependancesJetons;
  readonly journal: Journal;
}

/** `_identity_dict` : compte, profil réseau effectif, admin plein seulement (`is_admin == 1`) ; `null` si le compte manque. */
async function identite(dep: DependancesInterne, uid: number): Promise<Dict | null> {
  const ligne = await ligneUtilisateur(dep.auth.base, uid);
  if (!ligne) return null;
  let reglages: Record<string, unknown>;
  try {
    reglages = await getUserSettings(dep.auth.base, uid);
  } catch {
    reglages = {};
  }
  const admin = ligne.is_admin as unknown;
  return {
    user_id: intPy(ligne.id),
    username: strPy(ligne.username),
    network_profile_id: resolveNetworkProfileId(reglages),
    is_admin: admin === 1 || admin === true || admin === 1n,
  };
}

/** Seul genre de notification qu'un hôte peut créer (fin de matrice d'automatisation du bureau). */
const GENRE_AUTOMATION = "automation";
const NOTIFICATION = py.model({
  title: py.str({ min_length: 1, max_length: 500 }),
  body: py.str({ max_length: 4000 }).defaut(""),
  kind: py.literal(GENRE_AUTOMATION).defaut(GENRE_AUTOMATION),
  ref_type: py.literal(GENRE_AUTOMATION).defaut(GENRE_AUTOMATION),
});
const DEMANDE_PR = py.model({
  remote_url: py.str({ min_length: 1, max_length: 8192 }),
  head: py.str({ min_length: 1, max_length: 1024 }),
  base: py.str({ min_length: 1, max_length: 1024 }),
  title: py.str({ min_length: 1, max_length: 256 }),
  body: py.str({ max_length: 200_000 }).defaut(""),
  draft: py.bool().defaut(true),
});
const ANCRE = py.model({
  target: py.str({ max_length: 200 }),
  query: py.str({ min_length: 1, max_length: 2000 }),
  auto_id: py.str({ min_length: 1, max_length: 512 }),
  role: py.str({ max_length: 100 }).defaut(""),
  center: py.optional(py.list(py.any(), { max_length: 4 })).defaut(null),
});

/** Compte de l'enveloppe `X-Elpis-Identity` signée au jeton de service, relu en base : jamais du corps ni de la requête. */
export async function compteSigne(
  dep: Pick<DependancesInterne, "auth">,
  req: FastifyRequest,
): Promise<{ uid: number; username: string }> {
  const ident = verify(premierEntete(req, IDENTITY_HEADER), jetonServiceDuManifeste());
  if (ident === null || ident.user_id <= 0)
    throw new HttpError(401, "enveloppe d'identité absente ou invalide");
  const ligne = await ligneUtilisateur(dep.auth.base, ident.user_id);
  if (!ligne || strPy(ligne.username) !== ident.username) throw new HttpError(403, "compte inconnu");
  return { uid: ident.user_id, username: ident.username };
}

/** Enveloppe `X-Elpis-Identity` entière (conversation et sous-agent compris), relue en base comme `compteSigne`. */
async function identiteSignee(dep: Pick<DependancesInterne, "auth">, req: FastifyRequest): Promise<Identity> {
  const ident = verify(premierEntete(req, IDENTITY_HEADER), jetonServiceDuManifeste());
  if (ident === null || ident.user_id <= 0)
    throw new HttpError(401, "enveloppe d'identité absente ou invalide");
  const ligne = await ligneUtilisateur(dep.auth.base, ident.user_id);
  if (!ligne || strPy(ligne.username) !== ident.username) throw new HttpError(403, "compte inconnu");
  return ident;
}

/** Corps JSON d'une route interne : objet attendu, sinon `{}`. */
function corpsObjet(req: Parameters<typeof corpsJson>[0]): Record<string, unknown> {
  let corps: unknown;
  try {
    corps = corpsJson(req);
  } catch {
    corps = {};
  }
  return estDict(corps) ? corps : {};
}

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** Base64 standard strict (`b64decode(validate=True)`), `null` s'il est mal formé. */
function base64Strict(s: string): Buffer | null {
  return B64.test(s) ? Buffer.from(s, "base64") : null;
}

/** Champ texte du corps, `""` sinon. */
function texteDe(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Hôte d'un identifiant enregistré, comme le rend `git_set_credential` : détecté, sinon saisi nu, en minuscules ; `""` s'il ne se lit pas. */
function hoteSaisi(cible: string): string {
  try {
    return lowerPy(detectProvider(cible)?.host || normalizeHost(cible) || "");
  } catch {
    return "";
  }
}

export function creerFamilleInterneToolhost(dep: DependancesInterne): Famille {
  const base = dep.auth.base;
  return {
    nom: "interne-toolhost",
    routes: [
      {
        methode: "POST",
        chemin: "/api/internal/tokens/introspect",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          let corps: unknown;
          try {
            corps = corpsJson(req);
          } catch {
            corps = {};
          }
          const jeton = stripPy(strPy(ouPy(getPy(ouPy(corps, {}), "token"), "")));
          if (!jeton) throw new HttpError(400, "token requis");
          const d = await resoudreJeton(dep.auth, jeton, ["opencode", "tools"]);
          if (!d) return { ok: false };
          const ident = await identite(dep, d.user_id);
          if (!ident) return { ok: false };
          return { ok: true, ...ident, kind: d.kind, families: [...d.families] };
        },
      },
      {
        methode: "GET",
        chemin: "/api/internal/identity",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const { username } = entrees(req, { query: { username: py.str().defaut("") } }).query;
          const nom = stripPy(username || "");
          if (!nom) throw new HttpError(400, "username requis");
          const ligne = await getUser(base, nom);
          if (!ligne) return { ok: false };
          const ident = await identite(dep, intPy(ligne.id));
          return ident ? { ok: true, ...ident } : { ok: false };
        },
      },
      {
        methode: "GET",
        chemin: "/api/internal/git/credential",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const q = entrees(req, {
            query: { user_id: py.int().defaut(0), remote_url: py.str().defaut("") },
          }).query;
          if (!q.user_id || !q.remote_url) throw new HttpError(400, "user_id et remote_url requis");
          let cred: Awaited<ReturnType<typeof resolveGitCredential>> = null;
          try {
            cred = await resolveGitCredential(base, q.user_id, q.remote_url);
          } catch (e) {
            const nom = e instanceof Error ? e.name : typeof e;
            dep.journal.warn(`[internal] résolution d'identifiant git impossible : ${nom}`);
          }
          if (!cred) return { ok: true, credential: null };
          return {
            ok: true,
            credential: {
              username: strPy(cred.username || ""),
              token: strPy(cred.token || ""),
              host: strPy(cred.host || ""),
            },
          };
        },
      },
      {
        methode: "GET",
        chemin: "/api/internal/git/connector-hosts",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const { user_id } = entrees(req, { query: { user_id: py.int().defaut(0) } }).query;
          if (!user_id) throw new HttpError(400, "user_id requis");
          let hosts: string[];
          try {
            hosts = await listConnectorHosts(base, user_id);
          } catch {
            hosts = [];
          }
          return { ok: true, hosts };
        },
      },
      {
        methode: "POST",
        chemin: "/api/internal/git/pr",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const { uid } = await compteSigne(dep, req);
          const d = entrees(req, { body: DEMANDE_PR }).body;
          const result = await ouvrirPrPourHote(base, uid, d, {
            signaler: (e) =>
              dep.journal.warn(
                `[internal] résolution d'identifiant git impossible : ${e instanceof Error ? e.name : typeof e}`,
              ),
          });
          if (result["outcome"] === "error")
            dep.journal.warn(`[git] PR non ouverte (user=${uid}) : ${strPy(result["message"])}`);
          return { ok: true, result };
        },
      },
      {
        methode: "POST",
        chemin: "/api/internal/notifications",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const { uid } = await compteSigne(dep, req);
          const n = entrees(req, { body: NOTIFICATION }).body;
          const id = await createNotification(base, uid, n.kind, n.title, n.body, n.ref_type, null);
          return { ok: true, id };
        },
      },
      {
        methode: "GET",
        chemin: "/api/internal/desktop/anchor",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const { username } = await compteSigne(dep, req);
          const q = entrees(req, {
            query: {
              target: py.str({ max_length: 200 }),
              query: py.str({ min_length: 1, max_length: 2000 }),
            },
          }).query;
          const ancre = await ancresDeLaBase(base).lookupActionAnchor(obsKey(username, q.target), q.query);
          return { ok: true, anchor: ancre };
        },
      },
      {
        methode: "POST",
        chemin: "/api/internal/desktop/anchor",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const { username } = await compteSigne(dep, req);
          const a = entrees(req, { body: ANCRE }).body;
          await ancresDeLaBase(base).recordActionAnchor(obsKey(username, a.target), a.query, a.auto_id, {
            role: a.role,
            center: a.center,
          });
          return { ok: true };
        },
      },
      {
        methode: "GET",
        chemin: "/api/internal/sandbox/quota",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const { user_id } = entrees(req, { query: { user_id: py.int().defaut(0) } }).query;
          if (!user_id) throw new HttpError(400, "user_id requis");
          let quota: number | null = null;
          try {
            const reglages = await getUserSettings(base, user_id);
            if (Object.hasOwn(reglages, "sandbox_quota_mb")) quota = intPy(reglages["sandbox_quota_mb"]);
          } catch {
            quota = null;
          }
          return { ok: true, quota_mb: quota };
        },
      },
      {
        methode: "POST",
        chemin: "/api/internal/git/credential",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const { uid } = await compteSigne(dep, req);
          const c = corpsObjet(req);
          let id: number | null = null;
          let refus: string | null = null;
          const cible = texteDe(c["target"]);
          const args = [
            uid,
            cible,
            stripPy(texteDe(c["username"])),
            texteDe(c["token"]),
            stripPy(texteDe(c["provider_type"])),
          ] as const;
          try {
            // Hors clone de l'éditeur (origine posée par l'hôte, jamais par l'agent), fermé par défaut.
            if (c["origine"] === "editeur") id = await saveGitCredential(base, ...args);
            else ({ id, refus } = await base.ecriture((x) => saveGitCredentialAgent(x, ...args)));
          } catch (e) {
            const nom = e instanceof Error ? e.name : typeof e;
            dep.journal.warn(`[internal] identifiant git non enregistré : ${nom}`);
          }
          return {
            ok: true,
            saved: id !== null,
            connector_id: id,
            host: id === null && refus === null ? "" : hoteSaisi(cible),
            ...(refus === null ? {} : { refus }),
          };
        },
      },
      {
        methode: "POST",
        chemin: "/api/internal/creds/resolve",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const ident = await identiteSignee(dep, req);
          const corps = corpsObjet(req);
          const refs = corps["refs"];
          const attendue = typeof corps["expect_origin"] === "string" ? corps["expect_origin"] : undefined;
          const r = await resoudreReferences(
            base,
            {
              uid: ident.user_id,
              username: ident.username,
              chatId: ident.chat_id,
              sousAgent: Boolean(ident.subagent),
            },
            Array.isArray(refs) ? refs : [],
            attendue === undefined ? {} : { expectOrigin: attendue },
          );
          if (!r.ok) dep.journal.info(`[creds] résolution refusée (${r.code}, user=${ident.user_id})`);
          return r.ok ? { ok: true, values: r.values } : { ok: false, code: r.code, message: r.message };
        },
      },
      {
        methode: "POST",
        chemin: "/api/internal/procedures/demande",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const ident = await identiteSignee(dep, req);
          const c = corpsObjet(req);
          const chatId = typeof ident.chat_id === "string" ? ident.chat_id : "";
          const texte = (k: string, max: number): string =>
            typeof c[k] === "string" ? (c[k] as string).slice(0, max) : "";
          const g = estDict(c["gesture"]) ? c["gesture"] : {};
          const version = typeof c["version"] === "number" ? Math.trunc(c["version"]) : 0;
          if (
            !chatId ||
            !texte("procedure_id", 200) ||
            !texte("path", 300) ||
            !texte("fingerprint", 100) ||
            version < 1
          )
            return {
              ok: false,
              code: "approval_invalid",
              message: "conversation, procedure, version, path and fingerprint are required",
            };
          const d = await creerDemande(base, {
            owner: ident.username,
            uid: ident.user_id,
            chatId,
            sessionId: texte("session_id", 200),
            procedureId: texte("procedure_id", 200),
            version,
            path: texte("path", 300),
            fingerprint: texte("fingerprint", 100),
            description: texte("description", 700),
            gesture: {
              act: typeof g["act"] === "string" ? g["act"].slice(0, 40) : "",
              targets: Array.isArray(g["targets"])
                ? g["targets"]
                    .filter((t): t is string => typeof t === "string")
                    .map((t) => t.slice(0, 300))
                    .slice(0, 8)
                : [],
              value: typeof g["value"] === "string" ? g["value"].slice(0, 500) : "",
              url: typeof g["url"] === "string" ? g["url"].slice(0, 1000) : "",
            },
            page: texte("page", 1000),
            once: c["once"] === true,
          });
          return { ok: true, id: d.id, expires_at: d.expires_at, state: d.state };
        },
      },
      {
        methode: "POST",
        chemin: "/api/internal/procedures/approbation",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const ident = await identiteSignee(dep, req);
          const c = corpsObjet(req);
          const chatId = typeof ident.chat_id === "string" ? ident.chat_id : "";
          if (ident.subagent)
            return { ok: false, code: "approval_unavailable", message: "a sub-agent cannot use an approval" };
          const texte = (k: string): string => (typeof c[k] === "string" ? (c[k] as string) : "");
          const r = await consommer(base, texte("id"), {
            owner: ident.username,
            chatId,
            sessionId: texte("session_id"),
            procedureId: texte("procedure_id"),
            version: typeof c["version"] === "number" ? Math.trunc(c["version"]) : 0,
            path: texte("path"),
            fingerprint: texte("fingerprint"),
            page: texte("page"),
          });
          if (!r.ok) dep.journal.info(`[procedures] accord refusé (${r.code}, user=${ident.user_id})`);
          return r;
        },
      },
      {
        methode: "POST",
        chemin: "/api/internal/git/legacy-credentials",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const { uid } = await compteSigne(dep, req);
          const c = corpsObjet(req);
          const donnees = typeof c["data_b64"] === "string" ? base64Strict(c["data_b64"]) : null;
          if (donnees === null) throw new HttpError(400, "data_b64 requis");
          let refuses = 0;
          // Fichier du bac, modifiable par l'agent : même règle que ses outils (hôte déjà enregistré par le compte ou un admin).
          const n = await base.ecriture((x) =>
            importLegacyGitCredentials(x, uid, donnees, {
              admis: (hote) => hoteEnregistre(x, uid, hote),
              refus: () => void (refuses += 1),
            }),
          );
          if (n > 0)
            dep.journal.info(
              `[git] ${n} connecteur(s) importé(s) depuis .git-credentials.json (user=${uid})`,
            );
          if (refuses > 0)
            dep.journal.warn(
              `[git] ${refuses} hôte(s) de .git-credentials.json sans connecteur enregistré : non importé(s) (user=${uid})`,
            );
          return n < 0 ? { ok: false } : { ok: true, created: n, ...(refuses ? { refused: refuses } : {}) };
        },
      },
    ],
  };
}
