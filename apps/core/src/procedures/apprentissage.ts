// SPDX-License-Identifier: MIT
/** apps/core/src/procedures/apprentissage.ts — « Enregistrer comme procédure » : gestes navigateur réussis de l'historique d'une conversation → brouillon, aperçu et version NON approuvée (aucune règle de validation assouplie, aucun secret gardé). */
import { brouillonDepuisConversation, construireProcedure } from "@elpis/contracts";
import type {
  AppelNavigateur,
  Brouillon,
  BrouillonDto,
  ChoixApprentissage,
  ChoixApprentissageDto,
} from "@elpis/contracts";
import { sauvegarder } from "@elpis/db";
import type { Base } from "@elpis/db";
import { mergeTarget } from "@elpis/navigateur";

import { getChat } from "../chats/stockage";
import { resumeArbre } from "./gestion";

type Dict = Record<string, unknown>;
const estDict = (x: unknown): x is Dict => x !== null && typeof x === "object" && !Array.isArray(x);

function decoder(x: unknown): unknown {
  if (typeof x !== "string") return estDict(x) || Array.isArray(x) ? x : null;
  try {
    return JSON.parse(x) as unknown;
  } catch {
    return null;
  }
}

const OUTILS = new Set(["pw_session", "pw_act", "pw_chain", "pw_login", "pw_run"]);

/** Appels `pw_*` de la conversation dans l'ordre (arguments et résultats décodés, `tool_history` des messages de l'assistant). */
export function appelsNavigateur(messages: readonly unknown[]): AppelNavigateur[] {
  const sortie: AppelNavigateur[] = [];
  for (const m of messages) {
    if (!estDict(m) || !Array.isArray(m["tool_history"])) continue;
    const resultats = new Map<string, unknown>();
    for (const h of m["tool_history"])
      if (estDict(h) && h["role"] === "tool") resultats.set(String(h["tool_call_id"]), decoder(h["content"]));
    for (const h of m["tool_history"]) {
      if (!estDict(h) || h["role"] !== "assistant" || !Array.isArray(h["tool_calls"])) continue;
      for (const tc of h["tool_calls"]) {
        if (!estDict(tc) || !estDict(tc["function"])) continue;
        const nom = String(tc["function"]["name"] ?? "");
        if (!OUTILS.has(nom)) continue;
        const args = decoder(tc["function"]["arguments"]);
        sortie.push({
          outil: nom,
          args: estDict(args) ? args : {},
          resultat: resultats.get(String(tc["id"])) ?? null,
        });
      }
    }
  }
  return sortie;
}

export class ErreurApprentissage extends Error {
  readonly statut: number;
  constructor(statut: number, message: string) {
    super(message);
    this.statut = statut;
  }
}

const slug = (s: string): string => {
  const b = s
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return /^[a-z0-9]/u.test(b) ? b : "procedure";
};

export function libelleNoeud(n: Brouillon["noeuds"][number]): string {
  if (n.genre === "login") return "Connexion (identifiant fourni à chaque exécution par /creds)";
  const a = n.act;
  return `${a.act} ${a.act === "goto" ? (a.url ?? "") : (a.t?.[0] ?? "")}${a.v !== undefined ? ` ← « ${a.v} »` : ""}`.trim();
}

/** Brouillon recalculé côté serveur d'après la conversation du compte (jamais celui du client). */
async function brouillonDe(
  base: Base,
  uid: number,
  chatId: string,
  origin: string | undefined,
): Promise<{ b: Brouillon; titre: string }> {
  const chat = await getChat(base, uid, chatId);
  if (chat === null) throw new ErreurApprentissage(404, "Conversation introuvable.");
  const messages = Array.isArray(chat["messages"]) ? chat["messages"] : [];
  const appels = appelsNavigateur(messages);
  const b = brouillonDepuisConversation(appels, {
    ...(origin ? { origin } : {}),
    fusionnerCible: mergeTarget,
  });
  return { b, titre: typeof chat["title"] === "string" ? chat["title"] : "" };
}

function choixParDefaut(b: Brouillon, titre: string): ChoixApprentissageDto {
  return {
    id: slug(titre),
    description: titre.slice(0, 500),
    params: Object.fromEntries(b.params.map((p) => [p.nom, true])),
    confirm: Object.fromEntries(b.noeuds.filter((n) => n.confirmSuggere).map((n) => [String(n.id), true])),
    retires: [],
    wait_for: {},
  };
}

export async function brouillonConversation(
  base: Base,
  uid: number,
  owner: string,
  chatId: string,
  origin?: string,
): Promise<BrouillonDto> {
  const { b, titre } = await brouillonDe(base, uid, chatId, origin);
  const existantes = await base.all<{ id: string; origin: string }>(
    "SELECT DISTINCT id, origin FROM ax_procedures WHERE owner=? ORDER BY id",
    [owner],
  );
  return {
    origin: b.origin,
    origines: [...b.origines],
    noeuds: b.noeuds.map((n) => ({
      id: n.id,
      genre: n.genre,
      source: n.source,
      libelle: libelleNoeud(n),
      effet: n.genre === "act" && n.effet,
      confirmSuggere: n.confirmSuggere,
      waitForRequis: n.genre === "login" && !n.wait_for,
    })),
    params: [...b.params].map((p) => ({ ...p, noeuds: [...p.noeuds] })),
    ecartes: [...b.ecartes],
    choix: { ...choixParDefaut(b, titre), retires: [] },
    existantes: existantes.map((e) => ({ id: String(e.id), origin: String(e.origin) })),
  };
}

/** Aperçu : même rendu que l'écran Procédures, ou les erreurs de validation (aucune règle assouplie). */
export async function apercuConversation(
  base: Base,
  uid: number,
  chatId: string,
  origin: string | undefined,
  choix: ChoixApprentissageDto,
) {
  const { b } = await brouillonDe(base, uid, chatId, origin);
  const r = construireProcedure(b, choix as ChoixApprentissage);
  return r.ok
    ? { ok: true, lines: resumeArbre(r.procedure.root), erreurs: [] }
    : { ok: false, lines: [], erreurs: r.erreurs };
}

/** Crée la version NON approuvée (nouvelle procédure, ou nouvelle version d'une procédure de même origine). */
export async function enregistrerConversation(
  base: Base,
  uid: number,
  owner: string,
  chatId: string,
  origin: string | undefined,
  choix: ChoixApprentissageDto,
): Promise<{ id: string; version: number }> {
  const { b } = await brouillonDe(base, uid, chatId, origin);
  const r = construireProcedure(b, choix as ChoixApprentissage);
  if (!r.ok) throw new ErreurApprentissage(422, r.erreurs.join(" ; "));
  const existante = await base.get<{ origin: string }>(
    "SELECT origin FROM ax_procedures WHERE owner=? AND id=? ORDER BY version DESC LIMIT 1",
    [owner, r.procedure.id],
  );
  if (existante !== undefined && existante.origin !== r.procedure.origin)
    throw new ErreurApprentissage(
      409,
      "Une procédure de ce nom existe déjà pour un autre site : choisissez un autre nom.",
    );
  const s = await sauvegarder(base, owner, r.procedure);
  if (!s.ok) throw new ErreurApprentissage(422, s.message);
  return { id: s.id, version: s.version };
}
