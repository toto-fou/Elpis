// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/usage.ts — `lireSecretPourUsage` : secret d'un propriétaire choisi par son nom ou par sa cible (origine, hôte, connecteur, serveur), contrôlé (genre, attachement à la conversation, état, portée), déchiffré, compté et journalisé ; `secretsApplicables` : les mêmes contrôles sans valeur, pour ouvrir une session sécurisée. */
import type { GenreSecret, PolitiqueSecret, SecretApplicable } from "@elpis/contracts";
import type { Base, Executeur } from "@elpis/db";

import { contexteDeConversation, genreAttachable, idsAttaches } from "./attache";
import { ErreurSecret } from "./erreurs";
import { hoteExact, lirePolitique, origineExacte, origines, parOrigines } from "./portee";
import { dechiffrerLigne, journaliser, lignesDe, lireLigneParNom, maintenant, porteeDe } from "./stockage";
import type { Acteur, LigneSecret, Proprietaire } from "./stockage";

/** Ce que demande l'appelant : l'usage (le genre attendu), la cible, et le secret désigné par son nom s'il y en a un. */
export interface DemandeUsage {
  usage: GenreSecret;
  /** Origine (web-login, http-auth), hôte (git), id de connecteur (llm), id de serveur (mcp) ; rien pour un jeton. */
  cible?: string | number | null;
  nom?: string | null;
}

/** Contexte de l'appel, lu de l'enveloppe signée : propriétaire, acteur journalisé, conversation, exécution, sous-agent, routine. */
export interface ContexteUsage {
  proprietaire: Proprietaire;
  acteur: Acteur;
  /** Vrai pour un appel d'outil (hôte d'outils : `/resolve`, `/match`) : la conversation signée doit être du compte et le secret y être attaché ; `lireSecretPourUsage` le tire du genre (exigé pour web-login et http-auth, jamais pour git, token et mcp : connecteurs sans conversation). */
  exigeAttachement: boolean;
  chatId?: string | null;
  run?: string | null;
  /** Sous-agent porté par l'enveloppe ; avec l'attachement, aussi tiré de la conversation (`racine#task-…`). */
  sousAgent?: boolean;
  /** Run de routine ; avec l'attachement, tiré de la conversation signée (`routine:<id>:run:<n>` du compte, en cours). */
  routine?: boolean;
}

export interface SecretResolu {
  id: number;
  name: string;
  username: string | null;
  secret: string;
  tls: PolitiqueSecret["tls"];
  version: number;
}

/** Attachement à la conversation de l'appel (`exigeAttachement`) : secret du compte, conversation signée du compte ; un run de routine du compte s'en remet à la politique ; sinon le secret est attaché à la conversation racine (`chats.meta_json.secrets`, héritée par ses sous-agents). Sans exigence (connecteurs du core) : vrai. */
export async function estAttache(
  x: Executeur,
  secret: { id: number; name: string; user_id: number | null },
  c: ContexteUsage,
): Promise<boolean> {
  if (!c.exigeAttachement) return true;
  if (secret.user_id === null || c.proprietaire === null || secret.user_id !== c.proprietaire) return false;
  const conv = await contexteDeConversation(x, c.proprietaire, c.chatId);
  if (conv === null) return false;
  if (conv.routine) return true;
  return (await idsAttaches(x, c.proprietaire, c.chatId ?? ""))?.includes(secret.id) ?? false;
}

/** Contexte vérifié d'un usage qui exige l'attachement : marqueurs de sous-agent et de routine tirés de la conversation signée (ajoutés à ceux de l'enveloppe) ; `null` s'il ne se détermine pas. */
async function contexteVerifie(x: Executeur, c: ContexteUsage): Promise<ContexteUsage | null> {
  if (!c.exigeAttachement) return c;
  const conv = await contexteDeConversation(x, c.proprietaire, c.chatId);
  if (conv === null) return null;
  return { ...c, sousAgent: c.sousAgent === true || conv.sousAgent, routine: conv.routine };
}

/** Refus d'un secret `http-auth` sans nom d'utilisateur (jamais compté comme un usage). */
export function sansIdentifiant(nom: string): string {
  return `Secret '${nom}' has no user name: HTTP authentication needs one. Ask the user to add it in Settings › Secrets.`;
}

const HORS_CONVERSATION =
  "This call comes from no conversation of this account: secrets are only usable in a conversation they are attached to.";

/** Politique du secret envers l'appelant : un sous-agent ou une routine seulement si elle le permet. */
function permisParPolitique(l: LigneSecret, c: ContexteUsage): boolean {
  const p = lirePolitique(l.policy_json);
  return !((c.sousAgent === true && !p.subagents) || (c.routine === true && !p.routines));
}

async function attache(x: Executeur, l: LigneSecret, c: ContexteUsage): Promise<boolean> {
  return (
    permisParPolitique(l, c) &&
    (await estAttache(
      x,
      { id: Number(l.id), name: l.name, user_id: l.user_id === null ? null : Number(l.user_id) },
      c,
    ))
  );
}

/** Politique (sous-agent, routine) et attachement du secret pour ce contexte, contrôlés comme par `lireSecretPourUsage`, sans lecture, compte ni journal (sondage de présence). */
export function permisPourContexte(x: Executeur, l: LigneSecret, c: ContexteUsage): Promise<boolean> {
  return attache(x, l, c);
}

/** Cible normalisée selon l'usage ; illisible : `null`. */
function cibleNormalisee(usage: GenreSecret, cible: DemandeUsage["cible"]): string | number | null {
  if (parOrigines(usage)) return typeof cible === "string" ? origineExacte(cible) : null;
  if (usage === "git") return typeof cible === "string" ? hoteExact(cible) : null;
  if (usage === "llm") return typeof cible === "number" && Number.isSafeInteger(cible) ? cible : null;
  if (usage === "mcp") return typeof cible === "string" && cible.trim() ? cible.trim() : null;
  return null;
}

/** La portée du secret couvre la cible (un jeton n'a pas de cible : il se désigne par son nom). */
function couvre(l: LigneSecret, usage: GenreSecret, cible: string | number | null): boolean {
  if (usage === "token") return true;
  if (cible === null) return false;
  const p = porteeDe(l);
  if (parOrigines(usage)) return origines(p).includes(String(cible));
  const champs = p as Record<string, unknown>;
  if (usage === "git") return champs["host"] === cible;
  if (usage === "llm") return champs["connector_id"] === cible;
  return champs["server"] === cible;
}

/** Cible normalisée telle qu'écrite au journal et dans les messages (jamais l'adresse brute : chemin et requête restent hors du journal). */
function texteCible(cible: string | number | null): string {
  return cible === null ? "(none)" : String(cible).slice(0, 300);
}

/** Refus journalisé (`vault.secret.refused`, sans valeur) puis levé. */
function refuser(
  d: DemandeUsage,
  c: ContexteUsage,
  statut: number,
  code: ErreurSecret["code"],
  message: string,
): never {
  journaliser(
    c.acteur,
    "vault.secret.refused",
    {
      code,
      usage: d.usage,
      target: texteCible(cibleNormalisee(d.usage, d.cible)),
      name: d.nom ?? null,
      chat_id: c.chatId ?? null,
      run: c.run ?? null,
      subagent: c.sousAgent === true,
    },
    "failure",
  );
  throw new ErreurSecret(statut, code, message);
}

/** Secret désigné par son nom : attaché (avec l'attachement exigé, un nom inconnu, d'un autre genre ou d'un autre compte a le même refus ; sans lui, un secret existant refusé par sa politique reste `secret_not_attached`), du bon genre, vérifié, portée couvrant la cible. */
async function parNom(
  x: Executeur,
  d: DemandeUsage,
  c: ContexteUsage,
  nom: string,
  cible: string | number | null,
): Promise<LigneSecret> {
  const l = await lireLigneParNom(x, c.proprietaire, nom);
  if (l === null || !(await attache(x, l, c)))
    return c.exigeAttachement || l !== null
      ? refuser(d, c, 422, "secret_not_attached", `Secret '${nom}' is not attached to this conversation.`)
      : refuser(d, c, 404, "secret_unknown", `No secret named '${nom}'.`);
  if (l.kind !== d.usage)
    return refuser(
      d,
      c,
      422,
      "secret_type_mismatch",
      `Secret '${nom}' is a ${l.kind} secret, not ${d.usage}.`,
    );
  if (l.state !== "active")
    return refuser(
      d,
      c,
      422,
      "secret_unverified",
      `Secret '${nom}' is unverified: its owner must verify it in Settings › Secrets.`,
    );
  if (!couvre(l, d.usage, cible))
    return refuser(
      d,
      c,
      422,
      "secret_scope_mismatch",
      `Secret '${nom}' does not apply to ${texteCible(cible)}.`,
    );
  return l;
}

/** Secret choisi par sa cible : un seul secret attaché, vérifié et du bon genre doit la couvrir. */
async function parCible(
  x: Executeur,
  d: DemandeUsage,
  c: ContexteUsage,
  cible: string | number | null,
): Promise<LigneSecret> {
  const cibleLue = texteCible(cible);
  if (d.usage === "token")
    return refuser(d, c, 404, "secret_unknown", "A token secret is designated by its name.");
  const candidats = (await lignesDe(x, c.proprietaire, d.usage)).filter((l) => couvre(l, d.usage, cible));
  const attaches: LigneSecret[] = [];
  for (const l of candidats) if (await attache(x, l, c)) attaches.push(l);
  if (attaches.length === 0)
    return c.exigeAttachement
      ? refuser(
          d,
          c,
          422,
          "secret_not_attached",
          `No secret attached to this conversation applies to ${cibleLue}.`,
        )
      : refuser(d, c, 404, "secret_unknown", `No secret applies to ${cibleLue}.`);
  const actifs = attaches.filter((l) => l.state === "active");
  if (actifs.length === 0)
    return refuser(
      d,
      c,
      422,
      "secret_unverified",
      `The secret for ${cibleLue} is unverified: its owner must verify it in Settings › Secrets.`,
    );
  if (actifs.length > 1)
    return refuser(
      d,
      c,
      409,
      "secret_ambiguous",
      `Several secrets apply to ${cibleLue}: name one (${actifs.map((l) => l.name).join(", ")}).`,
    );
  return actifs[0] as LigneSecret;
}

/** `lireSecretPourUsage` : contexte vérifié (attachement exigé : conversation signée du compte), secret contrôlé puis déchiffré ; `use_count` et `last_used_at` mis à jour, `vault.secret.used` journalisé ; tout refus lève une `ErreurSecret` et journalise `vault.secret.refused`. */
export async function lireSecretPourUsage(
  base: Base,
  d: DemandeUsage,
  contexte: ContexteUsage,
): Promise<SecretResolu> {
  const cible = cibleNormalisee(d.usage, d.cible);
  const nom = d.nom?.trim() || null;
  const exige = { ...contexte, exigeAttachement: parOrigines(d.usage) };
  const c =
    (await contexteVerifie(base, exige)) ?? refuser(d, exige, 422, "secret_not_attached", HORS_CONVERSATION);
  if (cible === null && d.usage !== "token")
    refuser(
      d,
      c,
      422,
      "secret_scope_mismatch",
      parOrigines(d.usage) ? "Secrets apply to http(s) origins only." : "Invalid target for this secret.",
    );
  const l = await (nom === null ? parCible(base, d, c, cible) : parNom(base, d, c, nom, cible));
  if (d.usage === "http-auth" && !l.username)
    refuser({ ...d, nom: l.name }, c, 422, "secret_username_required", sansIdentifiant(l.name));
  let secret: string;
  try {
    secret = dechiffrerLigne(l);
  } catch (e) {
    if (e instanceof ErreurSecret) return refuser({ ...d, nom: l.name }, c, e.statut, e.code, e.message);
    throw e;
  }
  const t = maintenant();
  await base.ecriture((x) =>
    x.run("UPDATE vault_secrets SET use_count = use_count + 1, last_used_at = ? WHERE id = ?", [t, l.id]),
  );
  journaliser(c.acteur, "vault.secret.used", {
    secret_id: Number(l.id),
    name: l.name,
    kind: l.kind,
    owner: l.user_id === null ? "instance" : "user",
    usage: d.usage,
    target: texteCible(cible),
    version: Number(l.version),
    chat_id: c.chatId ?? null,
    run: c.run ?? null,
    subagent: c.sousAgent === true,
  });
  return {
    id: Number(l.id),
    name: l.name,
    username: l.username ?? null,
    secret,
    tls: lirePolitique(l.policy_json).tls,
    version: Number(l.version),
  };
}

/** Secret applicable vu de l'hôte d'outils : nom, genre, identifiant, origines, TLS et politique des sous-agents, jamais la valeur. */
function applicable(l: LigneSecret): SecretApplicable {
  const p = lirePolitique(l.policy_json);
  return {
    name: l.name,
    kind: l.kind === "http-auth" ? "http-auth" : "web-login",
    username: l.username ?? null,
    origins: origines(porteeDe(l)),
    tls: p.tls,
    subagents: p.subagents,
  };
}

/** `secretsApplicables` : par nom, le secret désigné (attaché — un nom inconnu, d'un autre genre ou d'un autre compte a le même refus —, vérifié, portée couvrant l'origine) ou son refus codé ; sans nom, tous les secrets attachés et vérifiés qui couvrent l'origine (ni valeur, ni usage compté, ni journal). */
export async function secretsApplicables(
  x: Executeur,
  origine: string,
  nom: string | null,
  contexte: ContexteUsage,
): Promise<SecretApplicable[]> {
  const c = await contexteVerifie(x, { ...contexte, exigeAttachement: true });
  if (c === null) throw new ErreurSecret(422, "secret_not_attached", HORS_CONVERSATION);
  const cible = origineExacte(origine);
  if (cible === null)
    throw new ErreurSecret(422, "secret_scope_mismatch", "Secrets apply to http(s) origins only.");
  if (nom !== null) {
    const l = await lireLigneParNom(x, c.proprietaire, nom);
    if (l === null || !genreAttachable(l.kind) || !(await attache(x, l, c)))
      throw new ErreurSecret(
        422,
        "secret_not_attached",
        `Secret '${nom}' is not attached to this conversation.`,
      );
    if (l.state !== "active")
      throw new ErreurSecret(
        422,
        "secret_unverified",
        `Secret '${nom}' is unverified: its owner must verify it in Settings › Secrets.`,
      );
    if (!origines(porteeDe(l)).includes(cible))
      throw new ErreurSecret(422, "secret_scope_mismatch", `Secret '${nom}' does not apply to ${cible}.`);
    return [applicable(l)];
  }
  const sortie: SecretApplicable[] = [];
  for (const l of await lignesDe(x, c.proprietaire)) {
    if (!genreAttachable(l.kind) || l.state !== "active" || !origines(porteeDe(l)).includes(cible)) continue;
    if (await attache(x, l, c)) sortie.push(applicable(l));
  }
  return sortie;
}
