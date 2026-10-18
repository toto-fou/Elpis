// SPDX-License-Identifier: MIT
/** apps/core/src/git/pr.ts — ouverture d'une PR pour l'hôte d'outils (bloc PR de `git_submit`, git_tools.py) : identifiant du compte résolu par hôte, dépôt et branches vérifiés avant l'API, api_base gardée en `critical_only`, appel par le client durci sous échéance, URL de repli ; le jeton de l'API ne quitte jamais main. */
import { ErreurPython, getPy, prefixePy, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Executeur } from "@elpis/db";
import { GIT_REMOTE_SCHEMES } from "@elpis/securite";
import type { Resolveur } from "@elpis/securite";

import { resolveGitCredential } from "./connecteurs";
import type { IdentifiantGit } from "./connecteurs";
import { detectProvider } from "./detection";
import { compareUrlFor, getProvider } from "./fournisseurs";
import type { Http } from "./fournisseurs";
import { gardeGit } from "./garde";
import { httpJson } from "./http";

/** Ce que l'hôte envoie : dépôt distant, branches, titre, corps, brouillon ; jamais d'identifiant. */
export interface DemandePrHote {
  readonly remote_url: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
}

// Sous-classes de ValueError que lève le bloc PR (`except ValueError` de git_submit : message sans `unexpected:`).
const VALEURS: ReadonlySet<string> = new Set(["ValueError", "UnicodeEncodeError", "UnicodeDecodeError"]);

/** `str(e)` d'une exception, préfixé `unexpected: ` hors ValueError (`_err` de git_submit). */
function messageErreur(e: unknown): string {
  const texte = e instanceof Error ? e.message : strPy(e);
  const valeur = (e instanceof ErreurPython && VALEURS.has(e.type)) || e instanceof RangeError;
  return valeur ? texte : `unexpected: ${texte}`;
}

// Segment de propriétaire ou de dépôt, et branche, sans caractère qui changerait le chemin ou la requête de l'API.
const SEGMENT = /^[A-Za-z0-9_.-]+$/u;
const BRANCHE = /^[A-Za-z0-9_./-]+$/u;
// Échéance de l'appel aux API de PR, sous le délai d'attente de l'hôte (60 s).
const ECHEANCE_MS = 45_000;

/** Propriétaire et dépôt en segments sûrs (plusieurs pour GitLab seulement), branches sans `..` ni tiret ou barre en tête. */
function cibleSure(owner: string, repo: string, head: string, base: string, type: string): boolean {
  const segments = repo.split("/");
  if (segments.length > 1 && type !== "gitlab") return false;
  const segmentSur = (x: string): boolean => SEGMENT.test(x) && x !== "." && x !== "..";
  const brancheSure = (x: string): boolean =>
    x.length <= 255 && BRANCHE.test(x) && !/^[-/]/u.test(x) && !x.includes("..") && !x.includes("//");
  return segmentSur(owner) && segments.every(segmentSur) && brancheSure(head) && brancheSure(base);
}

/** api_base rendue à l'hôte sans les identifiants d'une saisie `schéma://user:secret@hôte` (écart : le Python la recopiait). */
function sansIdentifiants(url: string): string {
  return url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/u, "$1***@");
}

/** `api_response` : corps texte tronqué à 400, sinon son `str()` tronqué. */
function reponseApi(r: Dict): string {
  const b = getPy(r, "body");
  return prefixePy(typeof b === "string" ? b : strPy(b), 400);
}

/** Issue de la PR (`outcome` : fallback, blocked_api_base, no_api, failed, opened, error), messages composés par l'hôte ; écart : connecteur générique → `no_api` direct (le Python butait sur `empty_url`). */
export async function ouvrirPrPourHote(
  x: Executeur,
  uid: number,
  d: DemandePrHote,
  o: {
    readonly resoudre?: Resolveur;
    readonly signaler?: (e: unknown) => void;
    readonly echeanceMs?: number;
  } = {},
): Promise<Dict> {
  try {
    const info = detectProvider(d.remote_url);
    const provider = info?.provider ?? "unknown";
    const host = info?.host ?? "";
    const cmp = { host, owner: info?.owner ?? "", repo: info?.repo ?? "", head: d.head, base: d.base };
    let cred: IdentifiantGit | null = null;
    try {
      cred = await resolveGitCredential(x, uid, d.remote_url);
    } catch (e) {
      o.signaler?.(e);
    }
    if (!cred || !cred.token)
      return { outcome: "fallback", provider, host, fallback_url: compareUrlFor(provider, cmp) };
    const type = cred.provider_type;
    const repli = compareUrlFor(provider, cmp, type);
    const f = getProvider(type);
    if (f.providerType === "generic") return { outcome: "no_api", provider_type: type, fallback_url: repli };
    if (!cibleSure(cmp.owner, cmp.repo, d.head, d.base, f.providerType))
      return {
        outcome: "error",
        message: "unsafe_pr_target",
        hint: `Pushed, but origin (${cmp.owner}/${cmp.repo}) or the branches (${d.head} → ${d.base}) contain characters refused by the PR API: open the PR manually.`,
      };
    const apiBase = strPy(cred.api_base || "");
    const permis = host ? [host] : [];
    const resolution = o.resoudre ? { resoudre: o.resoudre } : {};
    const verdict = await gardeGit(apiBase, {
      allowSchemes: GIT_REMOTE_SCHEMES,
      allowHosts: permis,
      criticalOnly: true,
      ...resolution,
    });
    if (verdict.motif)
      return {
        outcome: "blocked_api_base",
        api_base: sansIdentifiants(apiBase),
        reason: verdict.motif,
        fallback_url: repli,
      };
    const http: Http = (url, a) =>
      httpJson(url, {
        ...a,
        ssrfAllowHosts: permis,
        ssrfAllowSchemes: ["https", "http"],
        ssrfCriticalOnly: true,
        ...resolution,
      });
    let minuterie: NodeJS.Timeout | undefined;
    const echeance = new Promise<Dict>((fin) => {
      minuterie = setTimeout(
        () =>
          fin({
            ok: false,
            error_code: "pr_api_timeout",
            error: `TimeoutError: the PR API did not answer within ${Math.round((o.echeanceMs ?? ECHEANCE_MS) / 1000)}s`,
            status: null,
          }),
        o.echeanceMs ?? ECHEANCE_MS,
      );
    });
    const appel = f.createPr(http, {
      apiBase,
      token: cred.token,
      username: cred.username || "",
      owner: cmp.owner,
      repo: cmp.repo,
      head: d.head,
      base: d.base,
      title: d.title,
      body: d.body,
      draft: d.draft,
    });
    const r = await Promise.race([appel, echeance]).finally(() => clearTimeout(minuterie));
    if (getPy(r, "error_code") === "no_api")
      return { outcome: "no_api", provider_type: type, fallback_url: repli };
    if (!veritePy(getPy(r, "ok")))
      return {
        outcome: "failed",
        error_code: getPy(r, "error_code", "pr_open_failed"),
        error: getPy(r, "error", "unknown"),
        status: getPy(r, "status"),
        api_response: reponseApi(r),
        fallback_url: repli,
      };
    return {
      outcome: "opened",
      provider_type: type,
      pr_url: getPy(r, "pr_url"),
      pr_number: getPy(r, "pr_number"),
      already_open: getPy(r, "already_open", false),
    };
  } catch (e) {
    return { outcome: "error", message: messageErreur(e) };
  }
}
