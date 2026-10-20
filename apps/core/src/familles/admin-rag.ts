// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-rag.ts — `/api/admin/rag` : console d'administration du RAG (processus admin, administrateurs seulement) : état des services, collections sans accès au contenu, suppression, quotas par compte, réindexation globale, travaux. */
import {
  schemaCorpsEssaiServiceRag,
  schemaCorpsQuotaCompteRag,
  schemaCorpsReindexerToutRag,
  schemaCorpsSuppressionAdminRag,
  schemaRequeteCollectionsAdminRag,
  schemaRequeteComptesRag,
  schemaRequeteTravauxAdminRag,
  SERVICES_ESSAI_RAG,
} from "@elpis/contracts";
import type { ServiceEssaiRag } from "@elpis/contracts";
import type { Base } from "@elpis/db";
import type { ClientQdrant } from "@elpis/rag";
import { auditEvent } from "@elpis/securite";
import type { FastifyRequest } from "fastify";

import {
  essaiServiceRag,
  etatAdminRag,
  LIMITE_LISTE_ADMIN_RAG,
  listerCollectionsAdminRag,
  listerComptesRag,
  modifierQuotaCompteAdminRag,
  reindexationAdminRag,
  supprimerCollectionAdminRag,
  travauxAdminRag,
} from "../rag/admin";
import type { DependancesAdminRag } from "../rag/admin";
import {
  avecErreursRag,
  corpsValide,
  ErreurRouteRag,
  idCollection,
  idTravail,
  parametre,
  requeteValide,
} from "../rag/http";
import { serviceIndexationRag } from "../rag/service";
import type { ServiceIndexationRag } from "../rag/service";
import type { DefinitionRoute, Famille, Traitement } from "../routes";

export interface DependancesFamilleAdminRag {
  readonly base: Base;
  /** Service d'indexation du process (par défaut celui de la composition). */
  readonly service?: (() => ServiceIndexationRag | null) | undefined;
  readonly qdrant?: ((url: string) => ClientQdrant) | undefined;
  readonly sondeExtracteur?: (() => Promise<unknown>) | undefined;
}

function route(methode: DefinitionRoute["methode"], chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode, chemin, processus: ["admin"], acces: "admin", traiter: avecErreursRag(traiter) };
}

const vrai = (v: string | undefined): boolean => v === "1" || v === "true";
const entierOu = (v: string | undefined, defaut: number): number => (v === undefined ? defaut : Number(v));

/** Trace d'une action d'administration : qui, quoi, sur quelle collection ou quel compte ; jamais de contenu. */
function auditer(req: FastifyRequest, action: string, details: Record<string, unknown>): void {
  auditEvent({
    userId: req.utilisateur?.id ?? null,
    username: req.utilisateur?.username ?? null,
    action,
    details,
  });
}

function idCompte(req: FastifyRequest): number {
  const v = parametre(req, "user_id");
  if (!/^[1-9][0-9]{0,15}$/u.test(v))
    throw new ErreurRouteRag(404, "compte_introuvable", "Compte introuvable.");
  return Number(v);
}

export function creerFamilleAdminRag(dependances: DependancesFamilleAdminRag): Famille {
  const base = dependances.base;
  const service = dependances.service ?? serviceIndexationRag;
  const dep: DependancesAdminRag = {
    base,
    service,
    qdrant: dependances.qdrant,
    sondeExtracteur: dependances.sondeExtracteur,
  };
  const serviceExige = (): ServiceIndexationRag => {
    const s = service();
    if (s === null)
      throw new ErreurRouteRag(
        503,
        "rag_desactive",
        "Le RAG n'est pas encore démarré : réessayez dans un instant.",
      );
    return s;
  };
  return {
    nom: "admin-rag",
    routes: [
      route("GET", "/api/admin/rag/etat", () => etatAdminRag(dep)),
      route("POST", "/api/admin/rag/essai/:service", async (req) => {
        const nom = parametre(req, "service");
        if (!(SERVICES_ESSAI_RAG as readonly string[]).includes(nom))
          throw new ErreurRouteRag(404, "service_inconnu", "Service inconnu.");
        return essaiServiceRag(dep, nom as ServiceEssaiRag, corpsValide(req, schemaCorpsEssaiServiceRag));
      }),
      route("GET", "/api/admin/rag/collections", async (req) => {
        const q = requeteValide(req, schemaRequeteCollectionsAdminRag);
        const offset = entierOu(q.offset, 0);
        const limit = Math.min(
          LIMITE_LISTE_ADMIN_RAG.max,
          Math.max(1, entierOu(q.limit, LIMITE_LISTE_ADMIN_RAG.defaut)),
        );
        const r = await listerCollectionsAdminRag(base, {
          q: q.q,
          ownerId: q.owner_id === undefined ? undefined : Number(q.owner_id),
          visibility: q.visibility,
          status: q.status,
          tri: q.tri,
          offset,
          limite: limit,
        });
        return { collections: r.collections, total: r.total, offset, limit };
      }),
      route("DELETE", "/api/admin/rag/collections/:collection_id", async (req) => {
        const id = idCollection(req);
        const corps = corpsValide(req, schemaCorpsSuppressionAdminRag);
        const supprimee = await supprimerCollectionAdminRag(dep, id, corps.name);
        auditer(req, "admin.rag.collection.delete", {
          collection_id: id,
          name: supprimee.name,
          owner_user_id: supprimee.owner.id,
        });
        return { ok: true, deleted: supprimee };
      }),
      route("GET", "/api/admin/rag/comptes", async (req) => {
        const q = requeteValide(req, schemaRequeteComptesRag);
        const offset = entierOu(q.offset, 0);
        const limit = Math.min(
          LIMITE_LISTE_ADMIN_RAG.max,
          Math.max(1, entierOu(q.limit, LIMITE_LISTE_ADMIN_RAG.defaut)),
        );
        const r = await listerComptesRag(base, {
          q: q.q,
          seulementSurcharges: vrai(q.seulement_surcharges),
          offset,
          limite: limit,
        });
        return { accounts: r.accounts, total: r.total, offset, limit };
      }),
      route("PUT", "/api/admin/rag/comptes/:user_id/quota", async (req) => {
        const uid = idCompte(req);
        const corps = corpsValide(req, schemaCorpsQuotaCompteRag);
        const account = await modifierQuotaCompteAdminRag(base, uid, corps);
        auditer(req, "admin.rag.quota.set", { target_user_id: uid, override: account.override });
        return { account };
      }),
      route("GET", "/api/admin/rag/reindexation", () => reindexationAdminRag(base)),
      route("POST", "/api/admin/rag/reindexer", async (req) => {
        const corps = corpsValide(req, schemaCorpsReindexerToutRag);
        const started = await serviceExige().migrerTout(corps.force ? { force: true } : {});
        auditer(req, "admin.rag.reindex_all", { force: corps.force === true, collections: started });
        return { started, to_migrate: (await reindexationAdminRag(base)).to_migrate };
      }),
      route("GET", "/api/admin/rag/travaux", async (req) => {
        const q = requeteValide(req, schemaRequeteTravauxAdminRag);
        return {
          jobs: await travauxAdminRag(base, { actifs: vrai(q.actifs), limite: entierOu(q.limite, 50) }),
        };
      }),
      route("POST", "/api/admin/rag/travaux/:job_id/suspendre", async (req) => ({
        job: await serviceExige().suspendre("admin", idTravail(req)),
      })),
      route("POST", "/api/admin/rag/travaux/:job_id/reprendre", async (req) => ({
        job: await serviceExige().reprendre("admin", idTravail(req)),
      })),
      route("POST", "/api/admin/rag/travaux/:job_id/annuler", async (req) => ({
        job: await serviceExige().annuler("admin", idTravail(req)),
      })),
    ],
  };
}
