// SPDX-License-Identifier: MIT
/** apps/core/src/familles/interne-toolhost.ts — `/api/internal/*` appelées par l'hôte d'outils (jeton de service) : introspection de jeton, identité (toolhost/routes_internal.py) ; hôtes des comptes git, identifiant git lu dans le coffre (ou sa seule présence), notification, ancres du bureau, ouverture de PR et identifiant git saisi dans l'éditeur pour le compte de l'enveloppe signée ; quota du bac et anciens identifiants git importés (propres au TS). */
import { getUser, getUserSettings, ligneUtilisateur, nomCanonique, resoudreJeton } from "@elpis/auth";
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
import {
  hoteEnregistre,
  identifiantGitDisponible,
  listConnectorHosts,
  resolveGitCredential,
} from "../git/connecteurs";
import type { ContexteGit } from "../git/connecteurs";
import { detectProvider, normalizeHost } from "../git/detection";
import { ouvrirPrPourHote } from "../git/pr";
import { importLegacyGitCredentials, saveGitCredential } from "../git/resolveur";
import type { Journal } from "../journal";
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
/** Seul compte dont la forme canonique (nom des dossiers et des anciennes clés des outils) vaut `nom`, `null` sinon. */
async function idCanonique(base: DependancesInterne["auth"]["base"], nom: string): Promise<number | null> {
  const comptes = await base.all<{ id: number; username: string }>("SELECT id, username FROM users");
  const egaux = comptes.filter((c) => nomCanonique(String(c.username ?? "")) === nom);
  return egaux.length === 1 && egaux[0] ? intPy(egaux[0].id) : null;
}

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

/** Compte de l'enveloppe `X-Elpis-Identity` signée au jeton de service, relu en base : jamais du corps ni de la requête ; l'enveloppe vérifiée suit (conversation, sous-agent). */
export async function compteSigne(
  dep: Pick<DependancesInterne, "auth">,
  req: FastifyRequest,
): Promise<{ uid: number; username: string; identite: Identity }> {
  const ident = verify(premierEntete(req, IDENTITY_HEADER), jetonServiceDuManifeste());
  if (ident === null || ident.user_id <= 0) throw new HttpError(401, "identity envelope missing or invalid");
  const ligne = await ligneUtilisateur(dep.auth.base, ident.user_id);
  if (!ligne || strPy(ligne.username) !== ident.username) throw new HttpError(403, "unknown account");
  return { uid: ident.user_id, username: ident.username, identite: ident };
}

/** Conversation d'un run de routine (`runChatKey` : `routine:<id>:run:<id>`), sous-agents du run compris (`…#task-<id>`) ; groupe 1 : la clé du run. */
const RUN_DE_ROUTINE = /^(routine:-?\d+:run:-?\d+)(?:#|$)/u;

/** Lecture d'un jeton git pour le compte signé : politique et journal du coffre selon la conversation, le run de routine et le sous-agent de l'enveloppe. */
function contexteSigne(uid: number, username: string, identite: Identity): ContexteGit {
  const run = RUN_DE_ROUTINE.exec(identite.chat_id)?.[1] ?? null;
  return {
    acteur: { userId: uid, username, ip: null },
    chatId: identite.chat_id || null,
    run,
    sousAgent: identite.subagent !== undefined && identite.subagent !== null,
    routine: run !== null,
  };
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

/** Hôte d'un identifiant enregistré au clone de l'éditeur : détecté, sinon saisi nu, en minuscules ; `""` s'il ne se lit pas. */
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
          const q = entrees(req, {
            query: { username: py.str().defaut(""), canonical: py.str().defaut("") },
          }).query;
          const nom = stripPy(q.username || "");
          if (!nom) throw new HttpError(400, "username requis");
          const ligne = await getUser(base, nom);
          const id = ligne ? intPy(ligne.id) : q.canonical === "1" ? await idCanonique(base, nom) : null;
          if (id === null) return { ok: false };
          const ident = await identite(dep, id);
          return ident ? { ok: true, ...ident } : { ok: false };
        },
      },
      {
        methode: "GET",
        chemin: "/api/internal/git/credential",
        processus: ["main"],
        acces: "service",
        traiter: async (req, rep) => {
          const { uid, username, identite } = await compteSigne(dep, req);
          const { remote_url } = entrees(req, { query: { remote_url: py.str().defaut("") } }).query;
          if (!remote_url) throw new HttpError(400, "remote_url requis");
          let cred: Awaited<ReturnType<typeof resolveGitCredential>> = null;
          try {
            cred = await resolveGitCredential(base, uid, remote_url, contexteSigne(uid, username, identite));
          } catch (e) {
            const nom = e instanceof Error ? e.name : typeof e;
            dep.journal.warn(`[internal] résolution d'identifiant git impossible : ${nom}`);
          }
          rep.header("cache-control", "no-store");
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
        chemin: "/api/internal/git/credential/available",
        processus: ["main"],
        acces: "service",
        traiter: async (req, rep) => {
          const { uid, username, identite } = await compteSigne(dep, req);
          const { remote_url } = entrees(req, { query: { remote_url: py.str().defaut("") } }).query;
          if (!remote_url) throw new HttpError(400, "remote_url requis");
          let available = false;
          try {
            available = await identifiantGitDisponible(
              base,
              uid,
              remote_url,
              contexteSigne(uid, username, identite),
            );
          } catch (e) {
            const nom = e instanceof Error ? e.name : typeof e;
            dep.journal.warn(`[internal] présence d'identifiant git non vérifiée : ${nom}`);
          }
          rep.header("cache-control", "no-store");
          return { ok: true, available };
        },
      },
      {
        methode: "GET",
        chemin: "/api/internal/git/connector-hosts",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const { uid } = await compteSigne(dep, req);
          let hosts: string[];
          try {
            hosts = await listConnectorHosts(base, uid);
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
          const { uid, username, identite } = await compteSigne(dep, req);
          const d = entrees(req, { body: DEMANDE_PR }).body;
          const result = await ouvrirPrPourHote(base, uid, d, {
            contexte: contexteSigne(uid, username, identite),
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
          const { uid, username } = await compteSigne(dep, req);
          const c = corpsObjet(req);
          // Seul le clone de l'éditeur (origine posée par l'hôte, saisie de l'humain) enregistre : aucun outil de l'agent ne reçoit de jeton.
          if (c["origine"] !== "editeur")
            return { ok: true, saved: false, connector_id: null, host: "", refus: "editor_only" };
          let id: number | null = null;
          const cible = texteDe(c["target"]);
          try {
            id = await saveGitCredential(
              base,
              uid,
              cible,
              stripPy(texteDe(c["username"])),
              texteDe(c["token"]),
              stripPy(texteDe(c["provider_type"])),
              { userId: uid, username, ip: null },
            );
          } catch (e) {
            const nom = e instanceof Error ? e.name : typeof e;
            dep.journal.warn(`[internal] identifiant git non enregistré : ${nom}`);
          }
          return {
            ok: true,
            saved: id !== null,
            connector_id: id,
            host: id === null ? "" : hoteSaisi(cible),
          };
        },
      },
      {
        methode: "POST",
        chemin: "/api/internal/git/legacy-credentials",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const { uid, username } = await compteSigne(dep, req);
          const c = corpsObjet(req);
          const donnees = typeof c["data_b64"] === "string" ? base64Strict(c["data_b64"]) : null;
          if (donnees === null) throw new HttpError(400, "data_b64 requis");
          let refuses = 0;
          // Fichier du bac, modifiable par l'agent : seulement pour un hôte déjà enregistré par le compte ou un admin.
          const n = await base.ecriture(() =>
            importLegacyGitCredentials(
              base,
              uid,
              donnees,
              { userId: uid, username, ip: null },
              {
                admis: (hote) => hoteEnregistre(base, uid, hote),
                refus: () => void (refuses += 1),
              },
            ),
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
