// SPDX-License-Identifier: MIT
/** apps/core/src/coffre/jetons.ts — jetons `⟦creds:…⟧` d'une conversation : création, renouvellement, révocation et résolution atomique par le canal interne (empreinte seule en base). */
import type { Base, Executeur } from "@elpis/db";
import { auditEvent, decrypt, encrypt, tokenDigest, tokenUrlsafe } from "@elpis/securite";

import { creerEntree, ErreurCoffre, lireSecretEntree, nomLibrePourOrigine, validerOrigine } from "./stockage";

export const DUREE_JETON_S = 30 * 60;
export const USAGES_DEFAUT = 5;
const JETONS_MAX_PAR_CHAT = 20;
const FORME_JETON = /^[A-Za-z0-9_-]{20,64}$/u;
const PREFIXE_ROUTINE = "routine:";

export interface JetonCreds {
  id: number;
  chat_id: string;
  origin: string;
  label: string;
  entry_id: number | null;
  created_at: number;
  expires_at: number;
  uses_left: number;
  allow_insecure_tls: boolean;
}

function maintenant(): number {
  return Date.now() / 1000;
}

function jeton(l: Record<string, unknown>): JetonCreds {
  return {
    id: Number(l["id"]),
    chat_id: String(l["chat_id"]),
    origin: String(l["origin"]),
    label: String(l["label"] ?? ""),
    entry_id: l["entry_id"] === null || l["entry_id"] === undefined ? null : Number(l["entry_id"]),
    created_at: Number(l["created_at"]),
    expires_at: Number(l["expires_at"]),
    uses_left: Number(l["uses_left"]),
    allow_insecure_tls: Number(l["allow_insecure_tls"]) === 1,
  };
}

const COLONNES =
  "id, chat_id, origin, label, entry_id, created_at, expires_at, uses_left, allow_insecure_tls";

/** Un jeton expiré reste lisible ce temps-là pour que l'appel qui le présente reçoive « expiré » plutôt que « inconnu ». */
const GRACE_EXPIRE_S = 5 * 60;

/** Jetons expirés depuis plus que la grâce retirés (paresseusement, partout pareil : création, liste, résolution, renouvellement). */
export async function purgerJetonsExpires(x: Executeur): Promise<void> {
  await x.run("DELETE FROM coffre_jetons WHERE expires_at<?", [maintenant() - GRACE_EXPIRE_S]);
}

/** Suppression de conversations : leurs jetons partent avec elles. */
export async function purgerJetonsConversations(
  base: Base,
  uid: number,
  chatIds: readonly string[],
): Promise<void> {
  for (let i = 0; i < chatIds.length; i += 500) {
    const lot = chatIds.slice(i, i + 500);
    await base.run(
      `DELETE FROM coffre_jetons WHERE user_id=? AND chat_id IN (${lot.map(() => "?").join(",")})`,
      [uid, ...lot],
    );
  }
}

export async function listerJetons(base: Base, uid: number, chatId: string): Promise<JetonCreds[]> {
  await purgerJetonsExpires(base);
  const l = await base.all(
    `SELECT ${COLONNES} FROM coffre_jetons WHERE user_id=? AND chat_id=? AND expires_at>? ORDER BY id`,
    [uid, chatId, maintenant()],
  );
  return l.map(jeton);
}

export interface DemandeJeton {
  chatId: string;
  entryId?: number | null;
  origin?: unknown;
  username?: unknown;
  password?: unknown;
  enregistrer?: boolean;
  allowInsecureTls?: boolean;
}

/** Crée un jeton depuis une entrée confirmée ou un secret ponctuel (éventuellement enregistré) ; le jeton en clair n'est rendu qu'ici. */
export async function creerJetonCreds(
  base: Base,
  uid: number,
  d: DemandeJeton,
): Promise<{ token: string; item: JetonCreds }> {
  if (!(await base.get("SELECT 1 AS un FROM chats WHERE id=? AND user_id=?", [d.chatId, uid])))
    throw new ErreurCoffre(404, "Conversation introuvable.");
  const token = tokenUrlsafe(24);
  const t = maintenant();
  const item = await base.ecriture(async (x) => {
    await purgerJetonsExpires(x);
    const n = await x.get(
      "SELECT COUNT(*) AS n FROM coffre_jetons WHERE user_id=? AND chat_id=? AND expires_at>?",
      [uid, d.chatId, t],
    );
    if (Number(n?.["n"] ?? 0) >= JETONS_MAX_PAR_CHAT)
      throw new ErreurCoffre(409, "Trop de jetons actifs sur cette conversation.");
    let entryId: number | null = null;
    let origine: string;
    let label: string;
    let secret: string | null = null;
    let tls: boolean;
    if (d.entryId !== undefined && d.entryId !== null) {
      const e = await x.get(
        "SELECT nom, origin, origin_confirmed, allow_insecure_tls FROM coffre_identifiants WHERE id=? AND user_id=?",
        [d.entryId, uid],
      );
      if (!e) throw new ErreurCoffre(404, "Entrée introuvable.");
      if (Number(e["origin_confirmed"]) !== 1 || typeof e["origin"] !== "string")
        throw new ErreurCoffre(409, "Origine à confirmer dans le coffre.");
      entryId = d.entryId;
      origine = e["origin"];
      label = String(e["nom"]);
      tls = Number(e["allow_insecure_tls"]) === 1;
    } else {
      tls = d.allowInsecureTls === true;
      origine = validerOrigine(d.origin);
      const username = typeof d.username === "string" ? d.username.trim() : "";
      const password = typeof d.password === "string" ? d.password : "";
      if (!username || username.length > 256 || !password || password.length > 1024)
        throw new ErreurCoffre(422, "Identifiant et mot de passe requis.");
      label = username;
      if (d.enregistrer) {
        const nom = await nomLibrePourOrigine(x, uid, origine);
        const e = await creerEntree(base, uid, {
          nom,
          origin: origine,
          username,
          password,
          allow_insecure_tls: tls,
        });
        entryId = e.id;
        label = e.nom;
      } else {
        secret = encrypt(JSON.stringify({ u: username, p: password }));
      }
    }
    const id = await x.insertId(
      "INSERT INTO coffre_jetons (token_hash, user_id, chat_id, origin, entry_id, label, secret_enc, created_at, expires_at, uses_left, allow_insecure_tls) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        tokenDigest(token),
        uid,
        d.chatId,
        origine,
        entryId,
        label,
        secret,
        t,
        t + DUREE_JETON_S,
        USAGES_DEFAUT,
        tls ? 1 : 0,
      ],
    );
    const l = await x.get(`SELECT ${COLONNES} FROM coffre_jetons WHERE id=?`, [id]);
    return jeton(l as Record<string, unknown>);
  });
  return { token, item };
}

/** Renouvelle un jeton encore valide : 30 minutes à partir de maintenant et usages remis à leur valeur par défaut ; un jeton expiré ne se renouvelle pas (il faut un nouveau /creds). */
export async function renouvelerJeton(base: Base, uid: number, id: number): Promise<JetonCreds | null> {
  const t = maintenant();
  await purgerJetonsExpires(base);
  const r = await base.run(
    "UPDATE coffre_jetons SET expires_at=?, uses_left=? WHERE id=? AND user_id=? AND expires_at>?",
    [t + DUREE_JETON_S, USAGES_DEFAUT, id, uid, t],
  );
  if (r.changes === 0) return null;
  const l = await base.get(`SELECT ${COLONNES} FROM coffre_jetons WHERE id=?`, [id]);
  return l ? jeton(l) : null;
}

export async function revoquerJeton(base: Base, uid: number, id: number): Promise<boolean> {
  return (await base.run("DELETE FROM coffre_jetons WHERE id=? AND user_id=?", [id, uid])).changes > 0;
}

export interface ContexteResolution {
  uid: number;
  username: string;
  chatId: string;
  sousAgent: boolean;
}

export type ResolutionCreds =
  | { ok: true; values: Record<string, { value: string; origin: string; insecure_tls: boolean }> }
  | { ok: false; code: string; message: string };

class Refus extends Error {
  readonly refus: Extract<ResolutionCreds, { ok: false }>;
  constructor(refus: Extract<ResolutionCreds, { ok: false }>) {
    super(refus.code);
    this.refus = refus;
  }
}

const REFUS_GENERIQUE = {
  ok: false,
  code: "creds_invalid",
  message: "unknown or unusable credentials token",
} as const;

/** Sépare `<jeton>.password` ou `<jeton>.username` ; `null` si la forme est autre. */
export function lireReference(ref: unknown): { token: string; champ: "password" | "username" } | null {
  if (typeof ref !== "string") return null;
  const i = ref.lastIndexOf(".");
  const token = ref.slice(0, i);
  const champ = ref.slice(i + 1);
  return i > 0 && FORME_JETON.test(token) && (champ === "password" || champ === "username")
    ? { token, champ }
    : null;
}

/** Résout des références `jeton.champ` pour l'appel courant : propriétaire, conversation, expiration puis un usage décompté par jeton, atomiquement ; l'usage est audité sans valeur. */
export async function resoudreReferences(
  base: Base,
  c: ContexteResolution,
  refs: readonly unknown[],
  options: { expectOrigin?: string } = {},
): Promise<ResolutionCreds> {
  if (c.sousAgent || !c.chatId || c.chatId.startsWith(PREFIXE_ROUTINE))
    return {
      ok: false,
      code: "creds_not_available",
      message: "credentials are only usable from the user's own conversation",
    };
  const lues = refs.map(lireReference);
  if (lues.length === 0 || lues.length > 8 || lues.some((r) => r === null)) return REFUS_GENERIQUE;
  const parJeton = new Map<string, Set<"password" | "username">>();
  for (const r of lues) {
    if (r === null) continue;
    const champs = parJeton.get(r.token) ?? new Set();
    champs.add(r.champ);
    parJeton.set(r.token, champs);
  }
  const t = maintenant();
  const sortie: Record<string, { value: string; origin: string; insecure_tls: boolean }> = {};
  const usages: { id: number; origin: string; champs: string[] }[] = [];
  try {
    await base.ecriture(async (x) => {
      await purgerJetonsExpires(x);
      for (const [token, champs] of parJeton) {
        const l = await x.get(
          "SELECT id, user_id, chat_id, origin, entry_id, secret_enc, expires_at, allow_insecure_tls FROM coffre_jetons WHERE token_hash=?",
          [tokenDigest(token)],
        );
        if (!l || Number(l["user_id"]) !== c.uid || String(l["chat_id"]) !== c.chatId)
          throw new Refus(REFUS_GENERIQUE);
        if (Number(l["expires_at"]) <= t) {
          throw new Refus({
            ok: false,
            code: "creds_expired",
            message: "credentials token expired: ask the user to renew it with /creds",
          });
        }
        if (options.expectOrigin !== undefined && options.expectOrigin !== String(l["origin"]))
          throw new Refus({
            ok: false,
            code: "creds_origin_mismatch",
            message: "the requested URL is not on the exact origin these credentials are bound to",
          });
        let identifiant: string;
        let motDePasse: string;
        let tls = Number(l["allow_insecure_tls"]) === 1;
        if (l["entry_id"] !== null && l["entry_id"] !== undefined) {
          const e = await lireSecretEntree(x, c.uid, Number(l["entry_id"]));
          if (!e || !e.confirmee || e.origin !== String(l["origin"]) || !e.password)
            throw new Refus(REFUS_GENERIQUE);
          identifiant = e.username;
          motDePasse = e.password;
          tls = e.tls;
        } else {
          try {
            const brut = JSON.parse(decrypt(String(l["secret_enc"] ?? ""))) as { u?: unknown; p?: unknown };
            identifiant = String(brut.u ?? "");
            motDePasse = String(brut.p ?? "");
          } catch {
            throw new Refus(REFUS_GENERIQUE);
          }
          if (!identifiant || !motDePasse) throw new Refus(REFUS_GENERIQUE);
        }
        const maj = await x.run(
          "UPDATE coffre_jetons SET uses_left = uses_left - 1 WHERE id=? AND uses_left > 0 AND expires_at > ?",
          [Number(l["id"]), t],
        );
        if (maj.changes === 0)
          throw new Refus({
            ok: false,
            code: "creds_exhausted",
            message: "credentials token has no uses left: ask the user to renew it with /creds",
          });
        if (l["entry_id"] !== null && l["entry_id"] !== undefined)
          await x.run(
            "UPDATE coffre_identifiants SET use_count = use_count + 1, last_used_at=? WHERE id=? AND user_id=?",
            [t, Number(l["entry_id"]), c.uid],
          );
        for (const champ of champs) {
          sortie[`${token}.${champ}`] = {
            value: champ === "password" ? motDePasse : identifiant,
            origin: String(l["origin"]),
            insecure_tls: tls,
          };
        }
        usages.push({ id: Number(l["id"]), origin: String(l["origin"]), champs: [...champs] });
      }
    });
  } catch (e) {
    if (e instanceof Refus) return e.refus;
    throw e;
  }
  for (const u of usages)
    auditEvent({
      userId: c.uid,
      username: c.username,
      action: "creds.use",
      details: { token_id: u.id, origin: u.origin, fields: u.champs, chat_id: c.chatId },
    });
  return { ok: true, values: sortie };
}
