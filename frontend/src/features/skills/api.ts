// SPDX-License-Identifier: MIT
/** frontend/src/features/skills/api.ts — accès REST aux skills (`/api/skills*`), réponses validées par les schémas C2. */
import {
  schemaReponseEcritureSkill,
  schemaReponseFichierSkill,
  schemaReponseImportSkills,
  schemaReponseListeSkills,
  schemaReponsePromotionSkill,
  schemaReponseSuppressionSkill,
  schemaSkill,
} from "@elpis/contracts";
import type { ResumeSkill } from "@elpis/contracts";

import type { ClientHttp } from "../../platform/http/client";
import type { ApiResult } from "../../platform/http/resultat";
import type { Portee } from "./arbre";

/** Issue d'une écriture : succès avec valeur, ou statut HTTP (0 : réseau) et détail du serveur. */
export type EcritureSkill<T> =
  { ok: true; valeur: T } | { ok: false; statut: number; detail: string | null; brut: unknown };

export interface CorpsEcritureSkill {
  scope?: Portee;
  name?: string;
  description?: string;
  body?: string;
  tags?: string[];
  domain?: string | undefined;
  raw_md?: string;
  filename?: string;
}

export interface ResultatImport {
  imported: string[];
  count: number;
  name: string;
  scope: Portee;
}

function ecriture<T>(r: ApiResult<T>): EcritureSkill<T> {
  if (r.type === "ok") return { ok: true, valeur: r.valeur };
  if ("erreur" in r) return { ok: false, statut: r.statut, detail: r.erreur.detail, brut: r.erreur.brut };
  return { ok: false, statut: "statut" in r ? r.statut : 0, detail: null, brut: null };
}

const JSON_ENTETES = { "Content-Type": "application/json" };

export interface ApiSkills {
  parPortee(scope: Portee): Promise<ResumeSkill[]>;
  corpsComplet(id: string, scope: string): Promise<string | null>;
  corpsPourEdition(name: string, scope: string, id: string): Promise<string | null>;
  fichier(id: string, path: string, scope: string): Promise<string | null>;
  ecrire(
    corps: CorpsEcritureSkill,
    edition: { feuille: string; original: string } | null,
  ): Promise<EcritureSkill<{ name: string }>>;
  supprimer(feuille: string, scope: string, id: string): Promise<EcritureSkill<unknown>>;
  promouvoir(name: string): Promise<EcritureSkill<unknown>>;
  importerZip(fichier: File, scope: Portee, ecraser: boolean): Promise<EcritureSkill<ResultatImport>>;
  importerDossier(
    entrees: ReadonlyArray<{ file: File; relPath: string }>,
    scope: Portee,
    ecraser: boolean,
  ): Promise<EcritureSkill<ResultatImport>>;
  remplacerMd(slug: string, corps: CorpsEcritureSkill): Promise<EcritureSkill<{ name: string }>>;
}

export function creerApiSkills(http: ClientHttp): ApiSkills {
  const enc = encodeURIComponent;
  return {
    async parPortee(scope) {
      const r = await http.requete(`/api/skills?scope=${scope}`, {}, { schema: schemaReponseListeSkills });
      return r.type === "ok" ? r.valeur.skills : [];
    },
    async corpsComplet(id, scope) {
      const r = await http.requete(
        `/api/skills/file?id=${enc(id)}&path=SKILL.md&scope=${enc(scope)}`,
        {},
        { schema: schemaReponseFichierSkill },
      );
      return r.type === "ok" ? r.valeur.content : null;
    },
    async corpsPourEdition(name, scope, id) {
      const r = await http.requete(
        `/api/skills/${enc(name)}?scope=${enc(scope)}&id=${enc(id)}`,
        {},
        { schema: schemaSkill },
      );
      return r.type === "ok" ? r.valeur.body : null;
    },
    async fichier(id, path, scope) {
      const r = await http.requete(
        `/api/skills/file?id=${enc(id)}&path=${enc(path)}&scope=${enc(scope)}`,
        {},
        { schema: schemaReponseFichierSkill },
      );
      return r.type === "ok" ? r.valeur.content : null;
    },
    async ecrire(corps, edition) {
      const url = edition ? `/api/skills/${enc(edition.feuille)}?id=${enc(edition.original)}` : "/api/skills";
      const r = await http.requete(
        url,
        { method: edition ? "PUT" : "POST", headers: JSON_ENTETES, body: JSON.stringify(corps) },
        { schema: schemaReponseEcritureSkill },
      );
      return ecriture(r);
    },
    async supprimer(feuille, scope, id) {
      const r = await http.requete(
        `/api/skills/${enc(feuille)}?scope=${enc(scope)}&id=${enc(id)}`,
        { method: "DELETE" },
        { schema: schemaReponseSuppressionSkill },
      );
      return ecriture(r);
    },
    async promouvoir(name) {
      const r = await http.requete(
        "/api/skills/promote",
        { method: "POST", headers: JSON_ENTETES, body: JSON.stringify({ name }) },
        { schema: schemaReponsePromotionSkill },
      );
      return ecriture(r);
    },
    async importerZip(fichier, scope, ecraser) {
      const fd = new FormData();
      fd.append("file", fichier);
      const r = await http.requete(
        `/api/skills/import?scope=${scope}${ecraser ? "&overwrite=1" : ""}`,
        { method: "POST", body: fd },
        { schema: schemaReponseImportSkills },
      );
      return ecriture(r);
    },
    async importerDossier(entrees, scope, ecraser) {
      const fd = new FormData();
      for (const en of entrees) {
        fd.append("files", en.file);
        fd.append("paths", en.relPath);
      }
      const r = await http.requete(
        `/api/skills/import-folder?scope=${scope}${ecraser ? "&overwrite=1" : ""}`,
        { method: "POST", body: fd },
        { schema: schemaReponseImportSkills },
      );
      return ecriture(r);
    },
    async remplacerMd(slug, corps) {
      const r = await http.requete(
        `/api/skills/${enc(slug)}`,
        { method: "PUT", headers: JSON_ENTETES, body: JSON.stringify(corps) },
        { schema: schemaReponseEcritureSkill },
      );
      return ecriture(r);
    },
  };
}
