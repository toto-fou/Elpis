// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/attache.ts — secrets attachés à une conversation (`chats.meta_json.secrets` de la conversation racine) : lecture, remplacement contrôlé et journalisé, héritage des sous-agents (`racine#task-…`), runs de routine (politique seule). */
import { poserCle } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { GENRES_ATTACHABLES, SECRETS_ATTACHES_MAX } from "@elpis/contracts";
import type { Secret } from "@elpis/contracts";
import type { Base, Executeur } from "@elpis/db";

import {
  maintenant as maintenantChat,
  mergeMetaJson,
  metaDe,
  TITRE_PAR_DEFAUT,
  upsertChat,
} from "../chats/stockage";
import { ErreurSecret } from "./erreurs";
import { COLONNES_SECRET, journaliser, vueSecret } from "./stockage";
import type { Acteur, LigneSecret } from "./stockage";

/** Clé d'un run de routine (`runChatKey`) : aucune conversation, seule la politique `routines` du secret autorise. */
const RUN_ROUTINE = /^routine:(\d+):run:(\d+)$/u;
/** Suffixe de la conversation d'un sous-agent (`racine#task-<id>`). */
const SUFFIXE_SOUS_AGENT = /^task-[A-Za-z0-9_.:-]{1,80}$/u;

/** Conversation racine d'un appel : celle d'un sous-agent (`racine#task-…`) est celle de son parent. */
export function conversationRacine(chatId: string | null | undefined): string {
  const t = chatId ?? "";
  const i = t.indexOf("#");
  return i < 0 ? t : t.slice(0, i);
}

/** Clé d'un run de routine (une conversation racine qui n'en est pas une). */
export function estRunRoutine(chatId: string | null | undefined): boolean {
  return RUN_ROUTINE.test(conversationRacine(chatId));
}

/** Contexte d'un appel d'outil tiré de sa conversation signée : conversation du compte, ou run de routine du compte en cours, et sous-agent (`racine#task-…`) ; `null` s'il ne se détermine pas (aucune conversation, conversation inconnue ou d'un autre compte, run fini ou d'un autre compte, suffixe inconnu). */
export async function contexteDeConversation(
  x: Executeur,
  uid: number | null,
  chatId: string | null | undefined,
): Promise<{ sousAgent: boolean; routine: boolean } | null> {
  const id = chatId ?? "";
  const racine = conversationRacine(id);
  if (uid === null || !racine || id.length > 400) return null;
  const suite = racine.length < id.length ? id.slice(racine.length + 1) : null;
  if (suite !== null && !SUFFIXE_SOUS_AGENT.test(suite)) return null;
  const run = RUN_ROUTINE.exec(racine);
  const trouve =
    run === null
      ? await x.get("SELECT 1 AS ok FROM chats WHERE id = ? AND user_id = ?", [racine, uid])
      : await x.get(
          "SELECT 1 AS ok FROM editor_routine_runs WHERE id = ? AND routine_id = ? AND owner_user_id = ? AND status = 'running'",
          [Number(run[2]), Number(run[1]), uid],
        );
  return trouve ? { sousAgent: suite !== null, routine: run !== null } : null;
}

/** Genre que la conversation peut attacher (web-login, http-auth). */
export function genreAttachable(kind: unknown): boolean {
  return (GENRES_ATTACHABLES as readonly unknown[]).includes(kind);
}

/** Ids demandés (corps d'un tour, `PUT`) : entiers positifs distincts dans l'ordre reçu ; `null` si ce n'est pas une liste. */
export function idsDemandes(brut: unknown): number[] | null {
  if (!Array.isArray(brut)) return null;
  const ids: number[] = [];
  for (const v of brut)
    if (typeof v === "number" && Number.isSafeInteger(v) && v > 0 && !ids.includes(v)) ids.push(v);
  return ids;
}

/** Ids attachés enregistrés dans une méta de conversation, `SECRETS_ATTACHES_MAX` au plus. */
export function idsDeMeta(meta: Dict): number[] {
  return (idsDemandes(meta["secrets"]) ?? []).slice(0, SECRETS_ATTACHES_MAX);
}

/** Ids attachés à la conversation racine du compte ; `null` : conversation absente (ou d'un autre compte). */
export async function idsAttaches(x: Executeur, uid: number, chatId: string): Promise<number[] | null> {
  const racine = conversationRacine(chatId);
  if (!racine) return null;
  const r = await x.get<{ meta_json: unknown }>("SELECT meta_json FROM chats WHERE id=? AND user_id=?", [
    racine,
    uid,
  ]);
  return r ? idsDeMeta(metaDe(r.meta_json)) : null;
}

/** Lignes des secrets du compte parmi `ids`, dans l'ordre de `ids` ; un id inconnu ou d'un autre compte est absent. */
async function lignesParIds(x: Executeur, uid: number, ids: readonly number[]): Promise<LigneSecret[]> {
  if (!ids.length) return [];
  const lignes = await x.all<LigneSecret & Record<string, unknown>>(
    `SELECT ${COLONNES_SECRET} FROM vault_secrets WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    [uid, ...ids],
  );
  const parId = new Map(lignes.map((l) => [Number(l.id), l] as const));
  return ids.flatMap((id) => parId.get(id) ?? []);
}

/** Secret attachable : genre du navigateur, vérifié. */
function attachable(l: LigneSecret): boolean {
  return genreAttachable(l.kind) && l.state === "active";
}

/** Refus d'un id demandé (inconnu ou d'un autre compte, genre, non vérifié) ; `null` s'il s'attache. */
function refusAttache(id: number, l: LigneSecret | undefined): ErreurSecret | null {
  if (l === undefined) return new ErreurSecret(404, "secret_unknown", `No secret with id ${id}.`);
  if (!genreAttachable(l.kind))
    return new ErreurSecret(
      422,
      "secret_type_mismatch",
      `Secret '${l.name}' is a ${l.kind} secret: only web-login and http-auth secrets attach to a conversation.`,
    );
  if (l.state !== "active")
    return new ErreurSecret(
      422,
      "secret_unverified",
      `Secret '${l.name}' is unverified: verify it in Settings › Secrets before attaching it.`,
    );
  return null;
}

/** Secrets attachés à la conversation (métadonnées, ordre d'attachement) ; supprimés ou devenus inattachables omis ; `null` : conversation absente. */
export async function secretsAttaches(x: Executeur, uid: number, chatId: string): Promise<Secret[] | null> {
  const ids = await idsAttaches(x, uid, chatId);
  if (ids === null) return null;
  return (await lignesParIds(x, uid, ids)).filter(attachable).map((l) => vueSecret(l));
}

/** Conversation vierge du compte, créée avant le flux pour y attacher des secrets ; faux si l'id est pris par un autre compte. */
async function creerConversationVierge(base: Base, uid: number, chatId: string): Promise<boolean> {
  try {
    await upsertChat(base, uid, chatId, TITRE_PAR_DEFAUT, [], maintenantChat());
    return true;
  } catch {
    return false;
  }
}

export interface OptionsRemplacement {
  /** Vrai (`PUT`) : un id invalide est refusé ; faux (corps d'un tour) : il est écarté. */
  readonly strict: boolean;
  /** Conversation absente créée vierge (premier tour d'un chat neuf). */
  readonly creer?: boolean;
}

/** Remplace l'ensemble attaché à la conversation racine du compte (ids en double ignorés), écrit seulement s'il change ; journalise chaque secret attaché ou détaché ; `null` : conversation absente. */
export async function remplacerSecretsAttaches(
  base: Base,
  uid: number,
  chatId: string,
  demandes: readonly number[],
  acteur: Acteur,
  o: OptionsRemplacement,
): Promise<Secret[] | null> {
  const racine = conversationRacine(chatId);
  if (!racine || estRunRoutine(racine)) return null;
  let avant = await idsAttaches(base, uid, racine);
  if (avant === null && !o.creer) return null;
  if (o.strict && demandes.length > SECRETS_ATTACHES_MAX)
    throw new ErreurSecret(
      400,
      "secret_request_invalid",
      `${SECRETS_ATTACHES_MAX} secrets at most per conversation.`,
    );
  const uniques = [...new Set(demandes)];
  const lignes = await lignesParIds(base, uid, uniques);
  const parId = new Map(lignes.map((l) => [Number(l.id), l] as const));
  const gardees: LigneSecret[] = [];
  for (const id of uniques) {
    const l = parId.get(id);
    const refus = refusAttache(id, l);
    if (refus !== null && o.strict) throw refus;
    if (refus === null && l !== undefined && gardees.length < SECRETS_ATTACHES_MAX) gardees.push(l);
  }
  const ids = gardees.map((l) => Number(l.id));
  if (avant === null) {
    if (!ids.length || !(await creerConversationVierge(base, uid, racine))) return null;
    avant = [];
  }
  if (JSON.stringify(avant) !== JSON.stringify(ids)) {
    let precedents: number[] = [];
    const ecrit = await mergeMetaJson(base, uid, racine, (meta) => {
      precedents = idsDeMeta(meta);
      poserCle(meta, "secrets", ids);
    });
    if (!ecrit) return null;
    await journaliserChangement(base, uid, racine, precedents, ids, acteur);
  }
  return gardees.map((l) => vueSecret(l));
}

/** `vault.secret.attached` / `vault.secret.detached` pour chaque secret ajouté ou retiré (jamais de valeur). */
async function journaliserChangement(
  x: Executeur,
  uid: number,
  chatId: string,
  avant: readonly number[],
  apres: readonly number[],
  acteur: Acteur,
): Promise<void> {
  const ajoutes = apres.filter((id) => !avant.includes(id));
  const retires = avant.filter((id) => !apres.includes(id));
  if (!ajoutes.length && !retires.length) return;
  const noms = new Map((await lignesParIds(x, uid, [...ajoutes, ...retires])).map((l) => [Number(l.id), l]));
  const details = (id: number): Record<string, unknown> => ({
    secret_id: id,
    name: noms.get(id)?.name ?? null,
    kind: noms.get(id)?.kind ?? null,
    chat_id: chatId,
  });
  for (const id of ajoutes) journaliser(acteur, "vault.secret.attached", details(id));
  for (const id of retires) journaliser(acteur, "vault.secret.detached", details(id));
}
