// SPDX-License-Identifier: MIT
/** apps/core/test/memoire/aides-sessions.ts — remplissage d'une base et rejeu des recherches de sessions décrites par la spec de migration-kit/vecteurs/memoire_sessions.py. */
import { ErreurPython } from "@elpis/commun";
import type { Base, Executeur } from "@elpis/db";

import { upsertChat } from "../../src/chats/stockage";
import {
  sessionIndexMessages,
  sessionMessageByRef,
  sessionSearchFts,
  sessionSearchSnippets,
} from "../../src/memoire/sessions";

export interface Recherche {
  type: "fts" | "snippets" | "ref";
  uid: number | null;
  query?: string;
  limit?: unknown;
  roles?: string[] | null;
  ref?: unknown;
}

export interface SpecSessions {
  utilisateurs: string[];
  chats: [number, string, string][];
  corpus: Record<string, unknown>[];
  recherches: Recherche[];
}

export type Reponse = { valeur: unknown } | { erreur: string };

/** Comptes, chats et messages de la spec, dans l'ordre (ids 1…n comme en Python). */
export async function remplirSessions(base: Base, spec: SpecSessions): Promise<void> {
  for (const nom of spec.utilisateurs)
    await base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, settings_json) VALUES (?,?,?,?,?)",
      [nom, "s", "h", 0, "{}"],
    );
  for (const [uid, id, titre] of spec.chats) await upsertChat(base, uid, id, titre, [], 1_700_000_000);
  const n = await sessionIndexMessages(base, spec.corpus);
  if (n !== spec.corpus.length) throw new Error(`indexation partielle : ${n} sur ${spec.corpus.length}`);
}

/** Les recherches de la spec ; une erreur de type Python est rendue par son nom, comme le fait le script Python. */
export async function rejouerRecherches(x: Executeur, recherches: readonly Recherche[]): Promise<Reponse[]> {
  const sortie: Reponse[] = [];
  for (const r of recherches) {
    try {
      let valeur: unknown;
      if (r.type === "fts")
        valeur = await sessionSearchFts(x, r.uid, r.query ?? "", "limit" in r ? r.limit : undefined);
      else if (r.type === "snippets")
        valeur = await sessionSearchSnippets(
          x,
          r.uid,
          r.query ?? "",
          "limit" in r ? r.limit : undefined,
          r.roles ?? null,
        );
      else valeur = await sessionMessageByRef(x, r.uid, r.ref);
      sortie.push({ valeur });
    } catch (e) {
      if (!(e instanceof ErreurPython)) throw e;
      sortie.push({ erreur: e.type });
    }
  }
  return sortie;
}

/** Plein texte retiré, comme le fait le script Python : déclencheurs et table FTS5 en SQLite, colonne générée en PostgreSQL. */
export async function degraderPleinTexte(base: Base): Promise<void> {
  if (base.dialecte === "postgres") {
    await base.run("ALTER TABLE session_messages DROP COLUMN content_tsv");
    return;
  }
  for (const nom of ["sm_ai", "sm_ad", "sm_au"]) await base.run(`DROP TRIGGER IF EXISTS ${nom}`);
  await base.run("DROP TABLE session_messages_fts");
}
