// SPDX-License-Identifier: MIT
/** packages/db/src/migrations.ts — migrations propres au TS, numérotées à la suite des migrations Python : jetons des comptes git et secrets de webhook des routines chiffrés par le coffre « Secrets » (0027). */
import {
  aadCoffre,
  aadWebhookRoutine,
  chargerCleCoffre,
  chiffrerSecret,
  cleCoffre,
  coffreConfigure,
  kidDe,
  nomDeriveCoffre,
} from "@elpis/securite";
import type { CleCoffre, ColonnesLieesCoffre } from "@elpis/securite";

import type { Executeur } from "./base";

export interface Migration {
  name: string;
  /** Lève `MigrationReportee` si ce process ne peut pas l'appliquer : annulée, ni tamponnée ni en échec. */
  migrer(x: Executeur): Promise<void>;
}

/** Migration laissée à un autre process (le core) : l'hôte d'outils, qui partage parfois la base, n'a pas la clé du coffre. */
export class MigrationReportee extends Error {
  override name = "MigrationReportee";
}

/** Politique des secrets git (celle de `createConnector` au core) : sous-agents et routines s'en servent, comme des comptes git d'avant le coffre. */
const POLITIQUE_SECRET_GIT = JSON.stringify({
  subagents: true,
  routines: true,
  confirm_first_use: false,
  tls: "strict",
});

const CONTROLE = /\p{Cc}/u;

/** Identifiant non secret recopié dans le coffre ; vide, trop long ou avec un caractère de contrôle : aucun. */
function identifiantCoffre(brut: unknown): string | null {
  const v = typeof brut === "string" ? brut.trim() : "";
  return v && v.length <= 256 && !CONTROLE.test(v) ? v : null;
}

interface LigneGit {
  id: number;
  owner_user_id: number;
  host: string;
  label: string;
  username: string;
  token_enc: string;
}

/** Clé du coffre pour chiffrer : coffre absent du process (hôte d'outils) : reportée ; la courante, sinon la clé de repli posée seulement si aucun chiffré n'existe encore ; illisible ou perdue : échec bruyant, rien n'est perdu. */
async function cleExigee(x: Executeur, git: number, webhooks: number): Promise<CleCoffre> {
  if (!coffreConfigure()) throw new MigrationReportee("coffre non configuré dans ce process");
  try {
    const courante = cleCoffre();
    if (courante !== null) return courante;
    const n = await x.get<{ n: number }>(
      "SELECT (SELECT COUNT(*) FROM vault_secrets) + " +
        "(SELECT COUNT(*) FROM editor_routines WHERE webhook_secret_enc IS NOT NULL) AS n",
    );
    if (Number(n?.n ?? 0) > 0) throw new Error("aucune clé alors que des secrets chiffrés existent");
    return chargerCleCoffre();
  } catch (e) {
    throw new Error(
      `clé du coffre indisponible (${e instanceof Error ? e.message : String(e)}) : ` +
        `${git} jeton(s) git et ${webhooks} secret(s) de webhook restent en clair, rien n'est perdu ; voir ./elpis doctor`,
      { cause: e },
    );
  }
}

/** Un secret `git` par compte git (portée : son hôte), relié par `secret_id` ; le jeton en clair est effacé. */
async function jetonsGit(x: Executeur, lignes: readonly LigneGit[], cle: CleCoffre): Promise<void> {
  const pris = new Map<number, Set<string>>();
  for (const l of lignes) {
    const uid = Number(l.owner_user_id);
    let noms = pris.get(uid);
    if (noms === undefined) {
      const lus = await x.all<{ name: string }>("SELECT name FROM vault_secrets WHERE user_id = ?", [uid]);
      noms = new Set(lus.map((r) => r.name));
      pris.set(uid, noms);
    }
    const nom = nomDeriveCoffre(["git", l.host, l.label], noms);
    noms.add(nom);
    const liees: ColonnesLieesCoffre = {
      scope_json: JSON.stringify({ host: l.host }),
      policy_json: POLITIQUE_SECRET_GIT,
      state: "active",
      version: 1,
      username: identifiantCoffre(l.username),
    };
    const enc = chiffrerSecret(l.token_enc, aadCoffre(uid, "git", nom, liees), cle);
    const t = Date.now() / 1000;
    const id = await x.insertId(
      "INSERT INTO vault_secrets (user_id, kind, name, scope_json, username, secret_enc, kid, version, state, " +
        "policy_json, meta_json, created_at, updated_at, use_count) VALUES (?, 'git', ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, 0)",
      [
        uid,
        nom,
        liees.scope_json,
        liees.username,
        enc,
        kidDe(enc) ?? "",
        liees.policy_json,
        JSON.stringify({ connector_id: Number(l.id) }),
        t,
        t,
      ],
    );
    await x.run(
      "UPDATE git_connectors SET secret_id = ?, token_enc = '', token_scheme = 'vault' WHERE id = ?",
      [id, l.id],
    );
  }
}

/** 0027 : jetons des comptes git dans le coffre ; secrets de webhook des routines chiffrés sur place (HMAC du corps : réversibles). */
const VAULT_GIT: Migration = {
  name: "0027_vault_git",
  async migrer(x) {
    const git = await x.all<LigneGit & Record<string, unknown>>(
      "SELECT id, owner_user_id, host, label, username, token_enc FROM git_connectors " +
        "WHERE secret_id IS NULL AND token_enc <> '' ORDER BY id",
    );
    const webhooks = await x.all<{ id: number; webhook_secret: string }>(
      "SELECT id, webhook_secret FROM editor_routines WHERE webhook_secret IS NOT NULL AND webhook_secret <> '' ORDER BY id",
    );
    if (!git.length && !webhooks.length) return;
    const cle = await cleExigee(x, git.length, webhooks.length);
    await jetonsGit(x, git, cle);
    for (const r of webhooks) {
      const enc = chiffrerSecret(r.webhook_secret, aadWebhookRoutine(Number(r.id)), cle);
      await x.run("UPDATE editor_routines SET webhook_secret_enc = ?, webhook_secret = NULL WHERE id = ?", [
        enc,
        r.id,
      ]);
    }
  },
};

/** Migrations propres au TS, dans l'ordre. */
export const MIGRATIONS_TS: readonly Migration[] = [VAULT_GIT];
