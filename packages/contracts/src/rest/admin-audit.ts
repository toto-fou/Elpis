// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-audit.ts — console › journal de sécurité (admins seulement) : recherche paginée, vérification d'intégrité, réglages de conservation. */
import { z } from "zod";

import { entier } from "./commun";

export const schemaReglagesJournal = z.object({
  retention_days: entier,
  hold: z.boolean(),
  hold_reason: z.string(),
  forwarding_expected: z.boolean(),
  /** Durée écrite à la main hors des bornes : affichée telle quelle, jamais de purge plus courte que le minimum. */
  out_of_bounds: z.boolean(),
  /** Durée présente mais illisible dans config.json : la purge est suspendue. */
  invalid: z.boolean(),
  /** Durée ou centralisation absente de config.json, reprise du témoin du dossier du journal. */
  from_witness: z.boolean(),
  bounds: z.object({ min: entier, max: entier, default: entier }),
});
export type ReglagesJournal = z.infer<typeof schemaReglagesJournal>;

export const schemaCorpsReglagesJournal = z
  .object({
    retention_days: entier,
    hold: z.boolean(),
    hold_reason: z.string(),
    forwarding_expected: z.boolean(),
  })
  .partial();
export type CorpsReglagesJournal = z.infer<typeof schemaCorpsReglagesJournal>;

const issue = z.enum(["success", "failure", "unknown"]);

export const schemaEvenementJournal = z.object({
  /** Jour du fichier et position de la ligne : clé stable d'une ligne. */
  ref: z.string(),
  v: z.union([z.literal(0), z.literal(1)]),
  time: z.string().nullable(),
  ts: z.number().nullable(),
  host: z.string().nullable(),
  service: z.string().nullable(),
  boot: z.string().nullable(),
  seq: entier.nullable(),
  action: z.string(),
  outcome: issue,
  user_id: entier.nullable(),
  username: z.string().nullable(),
  ip: z.string().nullable(),
  details: z.unknown(),
  signed: z.boolean(),
  /** Identifiant de la clé de signature de la ligne (jamais la signature) ; `null` si non signée. */
  kid: z.string().nullable(),
});
export type EvenementJournal = z.infer<typeof schemaEvenementJournal>;

export const schemaPageJournal = z.object({
  events: z.array(schemaEvenementJournal),
  /** Suite (lignes plus anciennes) ; `null` quand la période est entièrement parcourue. */
  cursor: z.string().nullable(),
  scanned_bytes: entier,
  budget_reached: z.boolean(),
  /** Lignes sautées par cette page : JSON illisible ou plus de 64 Kio. */
  unreadable: entier,
  /** `ts` de la dernière ligne examinée : la page couvre le journal jusqu'à cet instant. */
  last_ts: z.number().nullable(),
  from: z.string(),
  to: z.string(),
});
export type PageJournal = z.infer<typeof schemaPageJournal>;

const ligneEnCause = z.object({ file: z.string(), line: entier });

export const schemaCorpsVerificationJournal = z.object({ from: z.string(), to: z.string() }).partial();
export const schemaVerificationJournal = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
  /** `intact` : toutes les lignes signées et valides, aucun trou, début et fin établis ; `non_verifie` : signatures absentes, clé inconnue, ou début ou fin du journal non établis (`reasons`) ; `vide` : rien sur la période. */
  status: z.enum(["intact", "anomalies", "non_verifie", "vide"]),
  intact: z.boolean(),
  key_available: z.boolean(),
  files: entier,
  first_file: z.string().nullable(),
  last_file: z.string().nullable(),
  lines: entier,
  v0_lines: entier,
  signed: entier,
  valid: entier,
  unsigned: entier,
  unknown_key: entier,
  invalid_signatures: z.array(ligneEnCause),
  unreadable: z.array(ligneEnCause),
  gaps: z.array(
    z.object({
      file: z.string(),
      line: entier,
      host: z.string(),
      service: z.string(),
      boot: z.string(),
      from: entier,
      to: entier,
      /** `fichiers` : premier fichier postérieur au `kept_from` de la dernière purge (boot, from et to vides). */
      kind: z.enum(["milieu", "debut", "fin", "ecrivain", "fichiers"]),
    }),
  ),
  out_of_order: z.array(ligneEnCause),
  unverified: z.array(ligneEnCause),
  inconsistent: z.array(ligneEnCause),
  misplaced: z.array(ligneEnCause),
  /** Copies à l'octet de lignes validement signées (file rsyslog rejouée) : avertissement. */
  duplicates: z.array(ligneEnCause),
  writers: entier,
  writers_without_stop: entier,
  uncertain_ends: z.array(
    z.object({
      host: z.string(),
      service: z.string(),
      boot: z.string(),
      last_ts: z.number(),
      reason: z.enum(["silence_avant_suivant", "silence_fin_periode"]),
    }),
  ),
  /** Pourquoi le statut est `non_verifie` alors que les signatures le permettraient : fin ancienne ou incertaine (sans `to`), purge sans `kept_from`. */
  reasons: z.array(
    z.object({
      kind: z.enum(["fin_ancienne", "fin_incertaine", "purge_sans_borne"]),
      host: z.string().nullable(),
      service: z.string().nullable(),
      last_ts: z.number().nullable(),
      text: z.string(),
    }),
  ),
  totals: z.object({
    invalid_signatures: entier,
    unreadable: entier,
    gaps: entier,
    out_of_order: entier,
    unverified: entier,
    inconsistent: entier,
    misplaced: entier,
    late_v0: entier,
    duplicates: entier,
  }),
});
export type VerificationJournal = z.infer<typeof schemaVerificationJournal>;

const alerte = z.object({
  id: z.string(),
  level: z.enum(["danger", "warn", "info"]),
  title: z.string(),
  detail: z.string(),
});

export const schemaEtatJournal = z.object({
  directory: z.string(),
  fallback_directory: z.boolean(),
  mode: z.string().nullable(),
  group_id: entier.nullable(),
  world_readable: z.boolean(),
  signed: z.boolean(),
  kid: z.string().nullable(),
  files: entier,
  bytes: entier,
  oldest: z.string().nullable(),
  newest: z.string().nullable(),
  daily_avg_bytes: entier.nullable(),
  disk: z.object({ free_bytes: entier, total_bytes: entier, days_left: entier.nullable() }).nullable(),
  clock_synchronized: z.boolean().nullable(),
  forwarding: z.object({
    expected: z.boolean(),
    agent: z.enum(["rsyslog", "syslog-ng"]).nullable(),
    active: z.boolean().nullable(),
    rule: z.string().nullable(),
    collector: z.string().nullable(),
    transport: z.string().nullable(),
    queue: z
      .object({ type: z.string(), file: z.string().nullable(), max_disk: z.string().nullable() })
      .nullable(),
    certificates: z.array(
      z.object({
        path: z.string(),
        role: z.enum(["ca", "client"]),
        readable: z.boolean(),
        expires_at: z.string().nullable(),
        days_left: entier.nullable(),
      }),
    ),
  }),
  retention: z.object({
    retention_days: entier,
    hold: z.boolean(),
    hold_reason: z.string(),
    forwarding_expected: z.boolean(),
    out_of_bounds: z.boolean(),
    invalid: z.boolean(),
    from_witness: z.boolean(),
    eligible_files: entier,
  }),
  write_failures: z.object({ count: entier, last_error: z.string().nullable() }),
  writers: z.array(
    z.object({
      host: z.string(),
      service: z.string(),
      boot: z.string(),
      last_ts: z.number(),
      last_action: z.string(),
      failures: entier.nullable(),
      stopped: z.boolean(),
    }),
  ),
  alerts: z.array(alerte),
  generated_at: z.number(),
});
export type EtatJournal = z.infer<typeof schemaEtatJournal>;

export const schemaTestJournal = z.object({ ok: z.literal(true), nonce: z.string(), ts: z.number() });
