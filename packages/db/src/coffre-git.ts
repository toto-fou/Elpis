// SPDX-License-Identifier: MIT
/** packages/db/src/coffre-git.ts — migration 0027_vault_git : jetons des comptes git rangés dans le coffre et secrets de webhook des routines chiffrés sur place, par main (ports du contexte) ; nom dérivé d'un secret et AAD d'un secret de webhook. */
import type { Executeur } from "./base";
import { MigrationDifferee } from "./migration";
import type { Migration } from "./migration";

/** Politique des secrets git (celle de `createConnector` au core) : sous-agents et routines s'en servent, comme des comptes git d'avant le coffre. */
const POLITIQUE_SECRET_GIT = { subagents: true, routines: true, confirm_first_use: false, tls: "strict" };

const CONTROLE = /\p{Cc}/u;
const NOM_MAX = 48;

/** AAD du secret de webhook d'une routine, chiffré sur place (hors liste du coffre) et lié à la routine. */
export function aadWebhookRoutine(routine: number): string {
  return `vault|v1|routine-webhook|${routine}`;
}

/** Slug d'un libellé libre : minuscules ASCII sans accents, autres caractères en `-`, sans séparateur en tête ni en fin. */
function slug(texte: string): string {
  return texte
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[-._]+|[-._]+$/gu, "");
}

/** Nom de secret dérivé de libellés (hôte, libellé…) : slug de 48 caractères au plus, suffixé `-2`, `-3`… s'il est déjà pris. */
export function nomDeriveCoffre(parties: readonly string[], pris: ReadonlySet<string>): string {
  const base = parties.map(slug).filter(Boolean).join("-") || "secret";
  const couper = (n: number): string => base.slice(0, n).replace(/[-._]+$/u, "");
  let nom = couper(NOM_MAX);
  for (let i = 2; pris.has(nom); i++) nom = `${couper(NOM_MAX - String(i).length - 1)}-${i}`;
  return nom;
}

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

/** 0027 : un secret `git` par compte git (portée : son hôte), relié par `secret_id`, jeton en clair effacé (refusé par le coffre : gardé en place, signalé) ; secrets de webhook chiffrés sur place (HMAC du corps : réversibles) ; sans le coffre dans le contexte, laissée à main ; clé indisponible : le port lève, rien n'est changé. */
export const MIGRATION_COFFRE_GIT: Migration = {
  name: "0027_vault_git",
  tables: ["git_connectors", "editor_routines"],
  async migrer(x: Executeur, _base, ctx) {
    const git = await x.all<LigneGit & Record<string, unknown>>(
      "SELECT id, owner_user_id, host, label, username, token_enc FROM git_connectors " +
        "WHERE secret_id IS NULL AND token_enc <> '' ORDER BY id",
    );
    const webhooks = await x.all<{ id: number; webhook_secret: string }>(
      "SELECT id, webhook_secret FROM editor_routines WHERE webhook_secret IS NOT NULL AND webhook_secret <> '' ORDER BY id",
    );
    if (!git.length && !webhooks.length) return;
    if (ctx.coffre === null)
      throw new MigrationDifferee(
        "jetons git ou secrets de webhook à chiffrer : laissée à main, qui a le coffre",
      );
    const pris = new Map<number, Set<string>>();
    const refuses: number[] = [];
    for (const l of git) {
      const uid = Number(l.owner_user_id);
      let noms = pris.get(uid);
      if (noms === undefined) {
        const lus = await x.all<{ name: string }>("SELECT name FROM vault_secrets WHERE user_id = ?", [uid]);
        noms = new Set(lus.map((r) => r.name));
        pris.set(uid, noms);
      }
      const nom = nomDeriveCoffre(["git", l.host, l.label], noms);
      noms.add(nom);
      const id = await ctx.coffre.ranger(x, {
        proprietaire: uid,
        genre: "git",
        nom,
        portee: { host: l.host },
        valeur: l.token_enc,
        username: identifiantCoffre(l.username),
        politique: { ...POLITIQUE_SECRET_GIT },
        meta: { connector_id: Number(l.id) },
      });
      if (id === null) {
        refuses.push(Number(l.id));
        continue;
      }
      await x.run(
        "UPDATE git_connectors SET secret_id = ?, token_enc = '', token_scheme = 'vault' WHERE id = ?",
        [id, l.id],
      );
    }
    for (const r of webhooks) {
      const enc = await ctx.coffre.chiffrer(x, r.webhook_secret, aadWebhookRoutine(Number(r.id)));
      await x.run("UPDATE editor_routines SET webhook_secret_enc = ?, webhook_secret = NULL WHERE id = ?", [
        enc,
        r.id,
      ]);
    }
    return {
      infos: [
        `${git.length - refuses.length} jeton(s) git rangé(s) dans le coffre, ${webhooks.length} secret(s) de webhook chiffré(s)`,
      ],
      avertissements: refuses.length
        ? [
            `compte(s) git ${refuses.join(", ")} : jeton refusé par le coffre (hôte ou valeur invalide), gardé en place, à ressaisir`,
          ]
        : [],
    };
  },
};
