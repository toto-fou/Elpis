// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/bac-fichiers.ts — routes de fichiers du bac relayées par l'hôte d'outils (`/api/sandbox/*`) : arbre, quota, recherche, état disque, écritures, structure, envois, remplacement, archives, historique. */
import { z } from "zod";

import { entier, horodatage } from "./commun";

export interface NoeudArbre {
  name: string;
  path: string;
  type: "folder" | "file";
  children?: NoeudArbre[] | undefined;
  size?: number | undefined;
}

export const schemaNoeudArbre: z.ZodType<NoeudArbre> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    type: z.enum(["folder", "file"]),
    children: z.array(schemaNoeudArbre).optional(),
    size: entier.optional(),
  }),
);

export const schemaReponseArbreBac = z.object({
  root: z.string(),
  items: z.array(schemaNoeudArbre),
  truncated: z.boolean(),
  max_entries: entier,
});

/** `quota_mb` 0 : sans plafond (`quota_bytes` 0, `remaining_bytes` nul). */
export const schemaReponseQuotaFichiers = z.object({
  used_mb: z.number(),
  quota_mb: entier,
  pct: z.number(),
  used_bytes: entier,
  quota_bytes: entier,
  remaining_bytes: entier.nullable(),
});

const schemaResultatRecherche = z.object({
  path: z.string(),
  name: z.string(),
  line: entier,
  col: entier,
  preview: z.string(),
});
const schemaNomTrouve = z.object({ path: z.string(), name: z.string(), type: z.literal("file") });
/** Requête vide : `{items: []}` sans autre champ ; sinon éléments par contenu (`mode=content`) ou par nom (`mode=name`). */
export const schemaReponseRechercheBac = z.union([
  z.object({ items: z.array(schemaResultatRecherche), errors: entier, truncated: z.boolean() }),
  z.object({ items: z.array(schemaNomTrouve), errors: entier, truncated: z.boolean() }),
  z.object({ items: z.tuple([]) }),
]);

export const schemaReponseDocx = z.object({
  path: z.string(),
  text: z.string(),
  size: entier,
  read_only: z.literal(true),
  format: z.literal("docx"),
});

export const schemaCorpsVerifierEtats = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      mtime: horodatage,
      size: entier.optional(),
      sha256: z.string().optional(),
    }),
  ),
});
/** Un fichier dont l'état diffère de celui de l'onglet : absent, illisible, pas un fichier, ou nouvelle empreinte. */
const schemaEtatPerime = z.union([
  z.object({ path: z.string(), missing: z.literal(true) }),
  z.object({ path: z.string(), unreadable: z.literal(true) }),
  z.object({ path: z.string(), not_file: z.literal(true) }),
  z.object({ path: z.string(), new_mtime: horodatage, size: entier, sha256: z.string().nullable() }),
]);
export const schemaReponseVerifierEtats = z.object({
  stale: z.array(schemaEtatPerime),
  truncated: z.boolean(),
});

export const schemaCorpsEnregistrement = z.object({
  path: z.string(),
  content: z.string().optional(),
  content_b64: z.string().optional(),
  expected_mtime: horodatage.nullable().optional(),
  expected_sha256: z.string().nullable().optional(),
  if_absent: z.boolean().optional(),
  source: z.enum(["editor", "restore"]).optional(),
});
export const schemaReponseEnregistrement = z.object({
  ok: z.literal(true),
  size: entier,
  mtime: horodatage.nullable(),
  sha256: z.string(),
});
/** `detail` d'un refus d'enregistrement : conflit (412), dossier ou fichier existant (409), refus d'agent ou du conteneur (objet sans `code`), texte. */
export const schemaDetailRefusEnregistrement = z.union([
  z.string(),
  z.object({
    code: z.string().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
    missing: z.boolean().optional(),
    mtime: horodatage.nullable().optional(),
    sha256: z.string().nullable().optional(),
    unreadable: z.boolean().optional(),
  }),
]);
export const schemaRefusEnregistrement = z.object({ detail: schemaDetailRefusEnregistrement });

export const schemaCorpsChemin = z.object({ path: z.string() });
export const schemaCorpsRenommerFichier = z.object({ old_path: z.string(), new_path: z.string() });
export const schemaCorpsCopie = z.object({ src: z.string(), dst: z.string() });
export const schemaReponseCopieBac = z.object({ ok: z.literal(true), path: z.string() });
export const schemaReponseViderBac = z.object({ ok: z.literal(true), deleted: entier.optional() });

export const schemaCorpsPreControleEnvoi = z.object({
  files: z.array(z.object({ path: z.string(), size: entier })).optional(),
  total_bytes: entier.optional(),
});
export const schemaReponsePreControleEnvoi = z.object({
  fits: z.boolean(),
  reason: z.string(),
  allowed_bytes: entier.nullable(),
  needed_bytes: entier,
  total_bytes: entier,
  overwrite_bytes: entier,
  escaped: entier,
  detailed: z.boolean(),
  unlimited: z.boolean(),
  quota_bytes: entier,
  used_bytes: entier,
  remaining_bytes: entier.nullable(),
  limit_bytes: entier.nullable(),
  max_pct: z.number(),
});

export const schemaReponseEnvoiBac = z.object({
  ok: z.literal(true),
  saved: entier,
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  mtimes: z.record(z.string(), horodatage),
  sha256s: z.record(z.string(), z.string()),
});
/** Dernier morceau (`done: true`) : chemin, date et empreinte du fichier assemblé. */
export const schemaReponseMorceauBac = z.union([
  z.object({ ok: z.literal(true), done: z.literal(false) }),
  z.object({
    ok: z.literal(true),
    done: z.literal(true),
    path: z.string(),
    mtime: horodatage.nullable(),
    sha256: z.string().nullable(),
  }),
]);
export const schemaReponseAnnulerMorceauBac = z.object({ ok: z.literal(true), removed: z.boolean() });

export const schemaCorpsRechercheContenu = z.object({
  query: z.string(),
  regex: z.boolean().optional(),
  case_sensitive: z.boolean().optional(),
  glob: z.string().optional(),
  include_hidden: z.boolean().optional(),
});
export const schemaReponseRechercheContenu = z.object({
  matches: z.array(
    z.object({
      path: z.string(),
      line: entier,
      col: entier,
      snippet: z.string(),
      match_start: entier,
      match_end: entier,
    }),
  ),
  total_files_scanned: entier,
  truncated: z.boolean(),
  elapsed_ms: entier,
});

export const schemaCorpsRemplacement = z.object({
  query: z.string(),
  replacement: z.string(),
  regex: z.boolean().optional(),
  case_sensitive: z.boolean().optional(),
  glob: z.string().optional(),
  include_hidden: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  paths: z.array(z.string()).optional(),
});
const schemaFichierRemplace = z.object({
  path: z.string(),
  count: entier,
  samples: z.array(z.object({ line: entier, before: z.string(), after: z.string() })).optional(),
  mtime: horodatage.nullable().optional(),
  sha256: z.string().optional(),
});
/** Aperçu (`dry_run`) : exemples et fichiers ignorés ; application : `mtime` par fichier, `failed` si l'écriture s'est arrêtée. */
export const schemaReponseRemplacement = z.object({
  files: z.array(schemaFichierRemplace),
  total: entier,
  truncated: z.boolean(),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  failed: z.object({ path: z.string(), error: z.string() }).optional(),
});

export const schemaCorpsDiagnostics = z.object({ content: z.string(), filename: z.string().optional() });
export const schemaReponseDiagnostics = z.object({
  diagnostics: z.array(
    z.object({
      row: entier,
      col: entier,
      end_row: entier,
      end_col: entier,
      code: z.string().nullable(),
      message: z.string(),
      severity: entier,
    }),
  ),
  error: z.string().optional(),
});
export const schemaReponseFormatage = z.object({ content: z.string() });

export const schemaReponseImportBac = z.object({
  ok: z.literal(true),
  files: entier,
  conflicts: entier,
  conflict_paths: z.array(z.string()),
  snapshot: z.object({ id: z.string(), name: z.string() }),
});
export const schemaReponseMiroirSkills = z.object({ ok: z.literal(true), files: entier });

export const schemaClicheHistorique = z.object({
  exists: z.boolean(),
  sha: z.string().nullable(),
  size: entier,
  unknown: z.boolean().optional(),
  too_big: z.boolean().optional(),
});
/** Version datée d'un fichier : cliché plus l'instant et l'origine de l'écriture. */
export const schemaVersionHistoriqueBac = schemaClicheHistorique.extend({
  ts: horodatage,
  source: z.string(),
});
export const schemaReponseHistoriqueSession = z.object({
  session: z.string(),
  started: horodatage.nullable(),
  files: z.array(
    z.object({
      path: z.string(),
      versions: entier,
      original_exists: z.boolean(),
      deleted: z.boolean(),
      last_ts: horodatage.nullable(),
      last_source: z.string().nullable(),
    }),
  ),
});
export const schemaReponseHistoriqueFichier = z.object({
  original: schemaClicheHistorique,
  versions: z.array(schemaVersionHistoriqueBac),
  created: horodatage,
  path: z.string(),
  current: z.object({
    exists: z.boolean(),
    sha256: z.string().nullable(),
    size: entier.nullable(),
    mtime: horodatage.nullable(),
  }),
});
