// SPDX-License-Identifier: MIT
/** packages/contracts/src/systeme.ts — événements du flux SSE `/api/system-events` (un objet JSON par trame `data`) et leur décodage. */
import { z } from "zod";

import { schemaResumeJob, schemaResumeReveil } from "./rest/jobs";
import { schemaDocumentRag, schemaTravailRag, schemaUuidRag } from "./rest/rag";

const entier = z.number().int();
const dict = z.record(z.string(), z.unknown());

/** Session expirée ou révoquée : le flux se ferme juste après. */
export const schemaSystemeSessionExpiree = z.object({ type: z.literal("session_expired") });
/** Le worker qui porte le flux s'arrête : se reconnecter sans rien afficher. */
export const schemaSystemeRecyclage = z.object({ type: z.literal("worker_recycling") });
export const schemaSystemeRedemarrage = z.object({
  type: z.literal("restart"),
  message: z.string(),
  started_at: z.number(),
});
/** Relayé de main vers la console ; plus émis par le core TS, gardé pour le front qui le traite comme `restart`. */
export const schemaSystemeRedemarrageApp = z.object({
  type: z.literal("app_restarting"),
  message: z.string().optional(),
  force_logout: z.boolean().optional(),
});
/** Relayé de main vers la console ; plus émis par le core TS. */
export const schemaSystemeModeleChange = z.looseObject({ type: z.literal("model_changed") });
/** Ligne de journal, au staff seulement ; `level`, `category`, `service` et `ts` sont recopiés bruts du journal commun. */
export const schemaSystemeJournal = z.object({
  type: z.literal("log"),
  message: z.string(),
  level: z.unknown(),
  category: z.unknown().optional(),
  service: z.unknown().optional(),
  ts: z.unknown().optional(),
});
export const schemaModeleAvecStatut = z.looseObject({ id: z.string() });
/** Profil du moteur déclaré (`llama.engine` ou type du connecteur) tel que l'interface le lit. */
export const schemaMoteurDeclare = z.object({
  type: z.string(),
  libelle: z.string(),
  chargement: z.boolean(),
  file: z.boolean(),
  contexte: z.boolean(),
});
export type MoteurDeclare = z.infer<typeof schemaMoteurDeclare>;
const nombreNul = z.number().nullable();
/** Charge lue sur les métriques du moteur ; `null` = non exposée. */
export const schemaChargeMoteur = z.object({
  en_cours: nombreNul,
  en_attente: nombreNul,
  debit_tps: nombreNul,
  cache_prefixe_pct: nombreNul,
});
export const schemaEtatModeles = z.object({
  models: z.array(z.string()),
  models_with_status: z.array(schemaModeleAvecStatut),
  models_loaded: z.array(z.looseObject({ id: z.string() })),
  kv_cache: dict,
  server_reachable: z.boolean(),
  status: z.string(),
  props: dict,
  moteur: schemaMoteurDeclare.optional(),
  charge: schemaChargeMoteur.optional(),
});
export type EtatModeles = z.infer<typeof schemaEtatModeles>;
export const schemaSystemeEtatModeles = z.object({
  type: z.literal("model_status"),
  data: schemaEtatModeles,
});
export const schemaNotificationDirecte = z.object({
  user_id: entier.positive(),
  id: entier.nullable(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  ref_type: z.string(),
  ref_id: z.union([z.string(), entier]).nullable(),
  unread: entier.nonnegative(),
});
export type NotificationDirecte = z.infer<typeof schemaNotificationDirecte>;
export const schemaSystemeNotification = z.object({
  type: z.literal("notification"),
  data: schemaNotificationDirecte,
});

/** Job de fond créé ou changé d'état (puce « Tâches de fond », `/jobs`) ; `active` : de la conversation, `active_total` : du compte. */
export const schemaSystemeJob = z.object({
  type: z.literal("chat_job"),
  data: z.object({
    chat_id: z.string(),
    job: schemaResumeJob,
    active: entier.nonnegative(),
    active_total: entier.nonnegative(),
  }),
});
/** Réveil d'une conversation par ses jobs : en file, tour lancé (`run_id`), fini, ou écarté (`reason`, `stopped` : « Arrêter » de l'utilisateur) ; `queued` : réveils en attente du compte. */
export const schemaSystemeReveil = z.object({
  type: z.literal("chat_wake"),
  data: z.object({
    chat_id: z.string(),
    chat_title: z.string(),
    status: z.enum(["queued", "started", "done", "skipped"]),
    run_id: z.string().nullable(),
    wake: schemaResumeReveil,
    queued: entier.nonnegative(),
    reason: z.enum(["wake_disabled", "max_depth", "quota", "chat_deleted", "stopped"]).optional(),
  }),
});

/** Progression d'un travail d'indexation RAG, au seul propriétaire (`data.user_id`) ; `document` : la ligne qui vient de changer. */
export const schemaSystemeTravailRag = z.object({
  type: z.literal("rag_job"),
  data: z.object({
    user_id: entier.positive(),
    collection_id: schemaUuidRag,
    job: schemaTravailRag,
    document: schemaDocumentRag.optional(),
  }),
});

export const schemaEvenementSysteme = z.discriminatedUnion("type", [
  schemaSystemeSessionExpiree,
  schemaSystemeRecyclage,
  schemaSystemeRedemarrage,
  schemaSystemeRedemarrageApp,
  schemaSystemeModeleChange,
  schemaSystemeJournal,
  schemaSystemeEtatModeles,
  schemaSystemeNotification,
  schemaSystemeJob,
  schemaSystemeReveil,
  schemaSystemeTravailRag,
]);
export type EvenementSysteme = z.infer<typeof schemaEvenementSysteme>;
export type TypeEvenementSysteme = EvenementSysteme["type"];

export const TYPES_EVENEMENTS_SYSTEME: readonly TypeEvenementSysteme[] = [
  "session_expired",
  "worker_recycling",
  "restart",
  "app_restarting",
  "model_changed",
  "log",
  "model_status",
  "notification",
  "chat_job",
  "chat_wake",
  "rag_job",
];

export type DecodageSysteme =
  | { readonly statut: "ok"; readonly evenement: EvenementSysteme }
  | { readonly statut: "inconnu"; readonly type: string }
  | { readonly statut: "invalide"; readonly erreur: string };

/** Décode le texte d'une trame `data` : type inconnu signalé à part (à journaliser), forme invalide jamais acceptée. */
export function decoderEvenementSysteme(donnees: string): DecodageSysteme {
  let brut: unknown;
  try {
    brut = JSON.parse(donnees);
  } catch {
    return { statut: "invalide", erreur: "JSON illisible" };
  }
  const type = brut !== null && typeof brut === "object" ? (brut as { type?: unknown }).type : undefined;
  if (typeof type !== "string") return { statut: "invalide", erreur: "champ « type » absent" };
  if (!(TYPES_EVENEMENTS_SYSTEME as readonly string[]).includes(type)) return { statut: "inconnu", type };
  const r = schemaEvenementSysteme.safeParse(brut);
  return r.success ? { statut: "ok", evenement: r.data } : { statut: "invalide", erreur: r.error.message };
}
