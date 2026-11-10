// SPDX-License-Identifier: MIT
/** frontend/src/features/secrets/format.ts — règles pures du coffre côté interface : actions permises par genre et propriétaire, portée affichée, dernier usage, formulaire (slug, origines exactes, élargissement de portée) et corps des requêtes. */
import { GENRES_ATTACHABLES, ORIGINES_SECRET_MAX, RE_NOM_SECRET, VALEUR_SECRET_MAX } from "@elpis/contracts";
import type { CorpsCreationSecret, CorpsMajSecret, GenreSecret, Secret } from "@elpis/contracts";

import type { PorteeCoffre } from "./api";

/** Genres créés depuis Paramètres › Secrets ; git, llm et mcp naissent dans le formulaire de leur connecteur. */
export const GENRES_CREABLES = ["web-login", "http-auth", "token"] as const;
export type GenreCreable = (typeof GENRES_CREABLES)[number];

/** Endroit qui gère un secret de connecteur : identifiant de la cible et son libellé. */
export interface Gestionnaire {
  readonly cible: string;
  readonly libelle: string;
}

export interface DroitsSecret {
  readonly rotation: boolean;
  readonly modification: boolean;
  readonly verification: boolean;
  readonly suppression: boolean;
  readonly gere: Gestionnaire | null;
}

const GERE_COMPTE: Readonly<Partial<Record<GenreSecret, Gestionnaire>>> = {
  git: { cible: "connectors", libelle: "Comptes Git" },
  llm: { cible: "ai_models", libelle: "Modèles IA" },
  mcp: { cible: "mcp", libelle: "Serveurs MCP" },
};
const GERE_INSTANCE: Readonly<Partial<Record<GenreSecret, Gestionnaire>>> = {
  llm: { cible: "inference", libelle: "Inférence" },
  mcp: { cible: "mcp", libelle: "Outils MCP" },
};

export function estCreable(kind: string): kind is GenreCreable {
  return (GENRES_CREABLES as readonly string[]).includes(kind);
}

export function estAttachable(s: Pick<Secret, "kind" | "state">): boolean {
  return (GENRES_ATTACHABLES as readonly string[]).includes(s.kind) && s.state === "active";
}

/** Une valeur `mcp` est un JSON (auth, en-têtes, variables) : jamais remplacée par une valeur nue. */
export function droitsDe(s: Pick<Secret, "kind" | "state" | "name">, portee: PorteeCoffre): DroitsSecret {
  if (portee === "instance") {
    const gere =
      GERE_INSTANCE[s.kind] ??
      (s.kind === "token" && s.name === "image-engine" ? { cible: "images", libelle: "Images" } : null);
    return {
      rotation: s.kind !== "mcp",
      modification: false,
      verification: false,
      suppression: true,
      gere,
    };
  }
  const propre = estCreable(s.kind);
  return {
    rotation: s.kind !== "mcp",
    modification: propre,
    verification: propre && s.state === "unverified",
    suppression: propre,
    gere: GERE_COMPTE[s.kind] ?? null,
  };
}

/** Portée lisible : origines, hôte, connecteur ou serveur ; vide pour un jeton. */
export function porteeTexte(s: Pick<Secret, "scope">): string[] {
  const p = s.scope as Record<string, unknown>;
  if (Array.isArray(p["origins"])) return p["origins"].filter((o): o is string => typeof o === "string");
  if (typeof p["host"] === "string") return [p["host"]];
  if (typeof p["connector_id"] === "number") return [`connector_id=${p["connector_id"]}`];
  if (typeof p["server"] === "string") return [`server=${p["server"]}`];
  return [];
}

/** Résumé d'une ligne de menu : genre, première portée, identifiant. */
export function resumeSecret(s: Pick<Secret, "kind" | "scope" | "username">): string {
  const portee = porteeTexte(s);
  const premiere = portee[0] ? portee[0] + (portee.length > 1 ? ` +${portee.length - 1}` : "") : "";
  return [s.kind, premiere, s.username ? `user=${s.username}` : ""].filter(Boolean).join(" · ");
}

/** Dernier usage compact (« 3 min », « 2 h », « 5 j ») ; « — » s'il n'a jamais servi. */
export function dernierUsage(ts: number | null, maintenantS: number): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor(maintenantS - ts));
  if (s < 60) return "< 1 min";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} j`;
}

export const nomValide = (nom: string): boolean => RE_NOM_SECRET.test(nom);

/** Origine exacte `scheme://hôte[:port]` d'une saisie (sans compte, chemin, requête ni fragment), comme le serveur ; `null` sinon. */
export function origineExacte(brut: string): string | null {
  const t = brut.trim();
  if (!t || t.length > 2048 || !URL.canParse(t) || t.endsWith("?") || t.endsWith("#")) return null;
  const u = new URL(t);
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname || u.username || u.password || u.pathname !== "/" || u.search || u.hash) return null;
  return u.origin;
}

/** Lignes non vides d'une saisie d'origines, sans doublon. */
export function lignesOrigines(texte: string): string[] {
  return [...new Set(texte.split(/\r?\n/u).map((l) => l.trim()))].filter(Boolean);
}

export interface FormulaireSecret {
  /** `null` : création. */
  id: number | null;
  kind: GenreSecret;
  name: string;
  origins: string;
  username: string;
  value: string;
  tls: "strict" | "insecure";
  subagents: boolean;
  routines: boolean;
  /** Valeurs enregistrées (modification) : ce qui change part seul, et élargir exige la valeur. */
  avant: {
    name: string;
    origins: string[];
    username: string;
    tls: "strict" | "insecure";
    subagents: boolean;
    routines: boolean;
  } | null;
}

export function formulaireVide(kind: GenreCreable = "web-login"): FormulaireSecret {
  return {
    id: null,
    kind,
    name: "",
    origins: "",
    username: "",
    value: "",
    tls: "strict",
    subagents: true,
    routines: false,
    avant: null,
  };
}

export function formulaireDe(s: Secret): FormulaireSecret {
  const origines = Array.isArray((s.scope as { origins?: unknown }).origins) ? porteeTexte(s) : [];
  const avant = {
    name: s.name,
    origins: origines,
    username: s.username ?? "",
    tls: s.policy.tls,
    subagents: s.policy.subagents,
    routines: s.policy.routines,
  };
  return { id: s.id, kind: s.kind, ...avant, origins: origines.join("\n"), value: "", avant };
}

export const parOrigines = (kind: string): boolean => kind === "web-login" || kind === "http-auth";

export interface VerdictFormulaire {
  readonly erreurs: Readonly<Partial<Record<"name" | "origins" | "username" | "value", string>>>;
  /** Raison pour laquelle la valeur doit être ressaisie (modification), sinon `null`. */
  readonly valeurExigee: string | null;
  readonly corps: CorpsCreationSecret | CorpsMajSecret | null;
}

/** Contrôle local (mêmes règles que le serveur) et corps de la requête : la création complète, la modification ne porte que ce qui change. */
export function verdictFormulaire(f: FormulaireSecret): VerdictFormulaire {
  const erreurs: Partial<Record<"name" | "origins" | "username" | "value", string>> = {};
  if (!nomValide(f.name)) erreurs.name = "slug [a-z0-9][a-z0-9._-]{0,47}";
  const origines: string[] = [];
  if (parOrigines(f.kind)) {
    const lignes = lignesOrigines(f.origins);
    const fautive = lignes.find((l) => origineExacte(l) === null);
    if (!lignes.length) erreurs.origins = "une origine au moins";
    else if (fautive !== undefined) erreurs.origins = `origine invalide : ${fautive}`;
    else {
      for (const l of lignes) {
        const o = origineExacte(l) as string;
        if (!origines.includes(o)) origines.push(o);
      }
      if (origines.length > ORIGINES_SECRET_MAX) erreurs.origins = `${ORIGINES_SECRET_MAX} origines au plus`;
    }
  }
  if (f.username.trim().length > 256) erreurs.username = "256 caractères au plus";
  if (f.value.length > VALEUR_SECRET_MAX) erreurs.value = `${VALEUR_SECRET_MAX} caractères au plus`;
  const a = f.avant;
  const elargie = !!a && parOrigines(f.kind) && origines.some((o) => !a.origins.includes(o));
  const insecure = !!a && f.tls === "insecure" && a.tls !== "insecure";
  const valeurExigee =
    f.id === null
      ? null
      : elargie
        ? "valeur requise : portée élargie"
        : insecure
          ? "valeur requise : tls insecure"
          : null;
  if (!erreurs.value && f.value === "" && (f.id === null || valeurExigee))
    erreurs.value = valeurExigee ?? "valeur requise";
  if (Object.keys(erreurs).length) return { erreurs, valeurExigee, corps: null };
  const username = f.username.trim() || null;
  const politique = { tls: f.tls, subagents: f.subagents, routines: f.routines };
  if (f.id === null || !a) {
    const commun = { name: f.name, username, value: f.value, policy: politique };
    const corps: CorpsCreationSecret =
      f.kind === "web-login" || f.kind === "http-auth"
        ? { kind: f.kind, scope: { origins: origines }, ...commun }
        : { kind: "token", ...commun };
    return { erreurs, valeurExigee, corps };
  }
  const corps: CorpsMajSecret = {};
  if (f.name !== a.name) corps.name = f.name;
  if (parOrigines(f.kind) && origines.join("\n") !== a.origins.join("\n"))
    corps.scope = { origins: origines };
  if ((username ?? "") !== a.username) corps.username = username;
  if (f.value !== "") corps.value = f.value;
  if (f.tls !== a.tls || f.subagents !== a.subagents || f.routines !== a.routines) corps.policy = politique;
  return { erreurs, valeurExigee, corps };
}

/** La saisie diffère de l'état de départ (garde de fermeture). */
export function formulaireModifie(f: FormulaireSecret | null): boolean {
  if (!f) return false;
  if (f.value !== "") return true;
  const a = f.avant;
  if (!a) return f.name !== "" || f.origins.trim() !== "" || f.username.trim() !== "";
  return (
    f.name !== a.name ||
    lignesOrigines(f.origins).join("\n") !== a.origins.join("\n") ||
    f.username.trim() !== a.username ||
    f.tls !== a.tls ||
    f.subagents !== a.subagents ||
    f.routines !== a.routines
  );
}
