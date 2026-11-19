// SPDX-License-Identifier: MIT
/** apps/core/src/identite/essai.ts — bouton « Tester » d'un fournisseur : réglages, prérequis, résolution, adresse, TLS, découverte et horloge OIDC, rendus en étapes à liste blanche. */
import { networkInterfaces } from "node:os";

import { adresseIpOuNul, estDict, HttpError } from "@elpis/commun";
import type { JugeHote, VerdictHote } from "@elpis/http";
import type { ServerMetadata } from "openid-client";

import { defautsFournisseur, fusionner, hotePortHttps, hotePortLdaps, validerFournisseur } from "./reglages";
import type { Fournisseur, FournisseurLdap, FournisseurOidc } from "./reglages";
import { etapesAnnuaire } from "./annuaire/essai";
import type { DemandeEssaiAnnuaire } from "./annuaire/essai";
import type { FabriqueConnexion } from "./annuaire/client";
import { etapesOidc } from "./oidc/essai";
import type { ContexteEtapesOidc } from "./oidc/essai";
import { adresseDecouverte, lireMetadonnees } from "./oidc/metadonnees";
import { etape, PHRASES_SORTANT as PHRASES } from "./etapes";
import type { EtapeEssai } from "./etapes";
import { classerErreur, clientHttps, connexionTls, jugeSortant } from "./sortant";
import type { OptionsSortant } from "./sortant";

export type { EtapeEssai } from "./etapes";

export const DELAI_GLOBAL_MS = 20_000;
const JOURS_ALERTE = 30;
const ADRESSES_MAX = 5;

export interface ResultatEssai {
  ok: boolean;
  complete: boolean;
  steps: EtapeEssai[];
}

export interface ContexteEssai {
  /** `auth.public_url` enregistrée (vide si absente ou non https). */
  readonly publicUrl: string;
  readonly cookieSecure: boolean;
  readonly adminsLocaux: number;
}

export interface OptionsEssai {
  readonly sortant?: OptionsSortant;
  readonly maintenant?: () => number;
  readonly delaiGlobalMs?: number;
  /** Adresses de cette machine ; celles de ses interfaces non bouclées par défaut. */
  readonly adressesLocales?: () => readonly string[];
  /** Étapes propres à l'annuaire ; sans elle, un test LDAP s'arrête au TLS et reste incomplet. */
  readonly annuaire?: ParametresAnnuaire;
  /** Lecture du secret client enregistré ; sans elle, un test OIDC n'a pas l'étape du secret. */
  readonly oidc?: Pick<ContexteEtapesOidc, "secretEnregistre">;
}

export interface ParametresAnnuaire {
  /** Fabrique de connexions pour les bornes du test (échéance, juge d'adresses). */
  readonly fabrique: (sortant: OptionsSortant) => FabriqueConnexion;
  readonly secretEnregistre: DemandeEssaiAnnuaire["secretEnregistre"];
  /** Identifiant de l'utilisateur d'essai tel que reçu. */
  readonly utilisateur?: unknown;
  /** Secret saisi pour ce test seul, tel que reçu. */
  readonly secret?: unknown;
  readonly limiteur: DemandeEssaiAnnuaire["limiteur"];
  readonly secretEmploye?: DemandeEssaiAnnuaire["secretEmploye"];
}

export interface TestLance {
  /** Résultat rendu au plus tard à l'échéance globale. */
  readonly resultat: Promise<ResultatEssai>;
  /** Fin réelle du travail (résolutions et connexions comprises), jamais rejetée. */
  readonly termine: Promise<void>;
  /** Réglages réellement testés si le test est complet (à lire une fois `resultat` rendu), sinon `null`. */
  readonly fournisseurTeste: () => Fournisseur | null;
}

interface Sortie {
  teste: Fournisseur | null;
  complet: boolean;
}

/** Juge appelé une fois par `hôte:port` (ce que l'étape « adresse » affiche est ce que les connexions utilisent), qui ne démarre ni ne rend rien une fois l'échéance levée. */
function jugeUnique(base: JugeHote, signal: AbortSignal): JugeHote {
  const vus = new Map<string, Promise<VerdictHote>>();
  return async (hote, port) => {
    signal.throwIfAborted();
    const cle = `${hote}:${port}`;
    let v = vus.get(cle);
    if (v === undefined) {
      v = base(hote, port);
      vus.set(cle, v);
    }
    const verdict = await v;
    signal.throwIfAborted();
    return verdict;
  };
}

function cleIp(texte: string): string | null {
  const a = adresseIpOuNul(texte);
  return a === null ? null : `${a.version}:${a.valeur}`;
}

function adressesDeLaMachine(): string[] {
  return Object.values(networkInterfaces()).flatMap((l) =>
    (l ?? []).filter((i) => !i.internal).map((i) => i.address),
  );
}

function coupe(hotePort: string): { hote: string; port: number } {
  const i = hotePort.lastIndexOf(":");
  return { hote: hotePort.slice(0, i).replace(/^\[(.*)\]$/su, "$1"), port: Number(hotePort.slice(i + 1)) };
}

function dateIso(secondes: number): string {
  return new Date(secondes * 1000).toISOString().slice(0, 10);
}

function motifRefus(motif: string): string {
  const ip = /\(([0-9a-fA-F:.]{2,45})\)/u.exec(motif)?.[1];
  const suite = ip === undefined ? "" : ` (${ip})`;
  return `Adresse refusée : boucle locale, lien local, adresse non spécifiée ou multidiffusion${suite}.`;
}

/** Résolution, adresse et TLS d'une adresse ; une étape en échec saute les suivantes. */
async function etapesAdresse(
  etapes: EtapeEssai[],
  cible: string,
  juge: JugeHote,
  sortant: OptionsSortant,
  maintenant: () => number,
  locales: ReadonlySet<string>,
): Promise<void> {
  const { hote, port } = coupe(cible);
  const litterale = adresseIpOuNul(hote) !== null;
  let v: VerdictHote;
  try {
    v = await juge(hote, port);
  } catch {
    etapes.push(etape("resolve", "Résolution", "fail", PHRASES.resolution, cible));
    return;
  }
  if (v.motif?.startsWith("unresolvable_host")) {
    etapes.push(etape("resolve", "Résolution", "fail", PHRASES.resolution, cible));
    return;
  }
  etapes.push(
    etape(
      "resolve",
      "Résolution",
      "ok",
      litterale ? "Adresse IP donnée telle quelle." : "Nom résolu.",
      cible,
    ),
  );
  if (v.motif !== null) {
    etapes.push(etape("address", "Adresse", "fail", motifRefus(v.motif), cible));
    return;
  }
  const liste = v.adresses.slice(0, ADRESSES_MAX).join(", ");
  const machine = v.adresses.some((a) => locales.has(cleIp(a) ?? ""));
  etapes.push(
    etape(
      "address",
      "Adresse",
      machine ? "warn" : "ok",
      `Adresse autorisée : ${liste}.${machine ? " Cette adresse est celle de cette machine." : ""}`,
      cible,
    ),
  );
  try {
    const { socket, certificat: c } = await connexionTls(hote, port, { ...sortant, juger: juge });
    socket.destroy();
    const jours = Math.floor((c.valide_au - maintenant() / 1000) / 86_400);
    const decrit = `${c.version_tls}, sujet ${c.sujet || "?"}, émis par ${c.emetteur || "?"}, valable du ${dateIso(c.valide_du)} au ${dateIso(c.valide_au)} (${jours} jours restants), adresse ${c.adresse}.`;
    etapes.push(etape("tls", "Certificat", jours < JOURS_ALERTE ? "warn" : "ok", decrit, cible));
  } catch (e) {
    etapes.push(etape("tls", "Certificat", "fail", PHRASES[classerErreur(e)], cible));
  }
}

/** Découverte OIDC, écart d'horloge d'après l'en-tête `Date` de la même réponse, puis les étapes OIDC propres au fournisseur. */
async function etapesDecouverte(
  etapes: EtapeEssai[],
  f: FournisseurOidc,
  juge: JugeHote,
  sortant: OptionsSortant,
  maintenant: () => number,
  oidc: OptionsEssai["oidc"],
): Promise<void> {
  const client = clientHttps({ ...sortant, juger: juge });
  const cible = hotePortHttps(f.issuer);
  try {
    let lu: { statut: number; texte: string; date: string | null };
    try {
      const rep = await client.fetch(adresseDecouverte(f.issuer), {
        headers: { accept: "application/json" },
      });
      lu = { statut: rep.status, texte: await rep.text(), date: rep.headers.get("date") };
    } catch (e) {
      etapes.push(etape("discovery", "Découverte", "fail", PHRASES[classerErreur(e)], cible));
      return;
    }
    const d = decouverte(f, lu.statut, lu.texte, cible);
    etapes.push(d.etape);
    etapes.push(horloge(f, lu.date, maintenant, cible));
    if (d.metadonnees !== null && oidc !== undefined)
      await etapesOidc(etapes, f, d.metadonnees, {
        fetch: client.fetch,
        secretEnregistre: oidc.secretEnregistre,
      });
  } finally {
    await client.fermer().catch(() => undefined);
  }
}

function decouverte(
  f: FournisseurOidc,
  statut: number,
  texte: string,
  cible: string,
): { etape: EtapeEssai; metadonnees: ServerMetadata | null } {
  const echec = (detail: string): { etape: EtapeEssai; metadonnees: null } => ({
    etape: etape("discovery", "Découverte", "fail", detail, cible),
    metadonnees: null,
  });
  if (statut !== 200) return echec(`Le serveur a répondu avec le statut ${statut} au lieu de 200.`);
  let doc: unknown;
  try {
    doc = JSON.parse(texte);
  } catch {
    return echec("La réponse n'est pas un document JSON.");
  }
  const v = lireMetadonnees(doc, f.issuer);
  if (!v.ok) return echec(v.raison);
  return {
    etape: etape("discovery", "Découverte", "ok", "Document de découverte valide (statut 200).", cible),
    metadonnees: v.metadonnees,
  };
}

function horloge(
  f: FournisseurOidc,
  date: string | null,
  maintenant: () => number,
  cible: string,
): EtapeEssai {
  const t = date === null ? NaN : Date.parse(date);
  if (!Number.isFinite(t))
    return etape("clock", "Horloge", "warn", "Le serveur n'indique pas son heure : écart non mesuré.", cible);
  const ecart = Math.round((t - maintenant()) / 1000);
  const abs = Math.abs(ecart);
  const detail = `Écart de ${ecart} s avec le serveur d'identité (tolérance ${f.clock_skew_sec} s).`;
  if (abs > f.clock_skew_sec) return etape("clock", "Horloge", "fail", detail, cible);
  return etape("clock", "Horloge", abs > f.clock_skew_sec / 2 ? "warn" : "ok", detail, cible);
}

function prerequis(c: ContexteEssai): EtapeEssai {
  const manque: string[] = [];
  if (c.publicUrl === "") manque.push("adresse publique en https absente");
  if (!c.cookieSecure) manque.push("connexion sécurisée (https) non en vigueur sur ce serveur");
  if (c.adminsLocaux < 1) manque.push("aucun administrateur actif avec un mot de passe local");
  return manque.length === 0
    ? etape(
        "prerequisites",
        "Prérequis",
        "ok",
        "Adresse publique, connexion sécurisée et administrateur local en place.",
      )
    : etape("prerequisites", "Prérequis", "fail", `À corriger : ${manque.join(" ; ")}.`);
}

const CLES_D_ETAT = ["has_secret", "tested", "active", "identities"];

/** Réglages du formulaire : l'état affiché (secret, test, activité, identités) retiré, les valeurs de départ du type comblées. */
function reglagesDuFormulaire(brut: unknown): unknown {
  if (!estDict(brut) || (brut["type"] !== "ldap" && brut["type"] !== "oidc")) return brut;
  const sans = Object.fromEntries(Object.entries(brut).filter(([k]) => !CLES_D_ETAT.includes(k)));
  return fusionner(defautsFournisseur(brut["type"]), sans);
}

async function corps(
  etapes: EtapeEssai[],
  reglages: unknown,
  contexte: ContexteEssai,
  o: OptionsEssai,
  signal: AbortSignal,
  sortie: Sortie,
): Promise<void> {
  const maintenant = o.maintenant ?? Date.now;
  let f: Fournisseur;
  try {
    f = validerFournisseur(reglagesDuFormulaire(reglages));
    etapes.push(etape("settings", "Réglages", "ok", "Réglages valides."));
  } catch (e) {
    etapes.push(
      etape("settings", "Réglages", "fail", e instanceof HttpError ? e.message : "Réglages invalides."),
    );
    etapes.push(prerequis(contexte));
    return;
  }
  etapes.push(prerequis(contexte));
  const sortant: OptionsSortant = { ...o.sortant, caPem: f.ca_pem, signal };
  const juge = jugeUnique(o.sortant?.juger ?? jugeSortant(o.sortant?.resoudre), signal);
  const locales = new Set((o.adressesLocales ?? adressesDeLaMachine)().map((a) => cleIp(a) ?? ""));
  if (f.type === "ldap") {
    let premiere: string | null = null;
    for (const u of f.urls) {
      if (signal.aborted) return;
      const n = etapes.length;
      await etapesAdresse(etapes, hotePortLdaps(u), juge, sortant, maintenant, locales);
      if (premiere === null && etapes.slice(n).every((e) => e.level !== "fail")) premiere = u;
    }
    if (premiere !== null && o.annuaire !== undefined && !signal.aborted)
      sortie.complet = await etapesLdap(
        etapes,
        f,
        premiere,
        o.annuaire,
        { ...sortant, juger: juge },
        maintenant,
        signal,
      );
    sortie.teste = f;
  } else {
    const n = etapes.length;
    await etapesAdresse(etapes, hotePortHttps(f.issuer), juge, sortant, maintenant, locales);
    if (!signal.aborted && etapes.slice(n).every((e) => e.level !== "fail"))
      await etapesDecouverte(etapes, f, juge, sortant, maintenant, o.oidc);
  }
}

/** Étapes de l'annuaire sur la première adresse joignable ; vrai si elles sont toutes passées avec un utilisateur d'essai. */
function etapesLdap(
  etapes: EtapeEssai[],
  f: FournisseurLdap,
  url: string,
  a: ParametresAnnuaire,
  sortant: OptionsSortant,
  maintenant: () => number,
  signal: AbortSignal,
): Promise<boolean> {
  return etapesAnnuaire(etapes, f, url, {
    fabrique: a.fabrique(sortant),
    secretEnregistre: a.secretEnregistre,
    utilisateur: a.utilisateur,
    secret: a.secret,
    limiteur: a.limiteur,
    ...(a.secretEmploye === undefined ? {} : { secretEmploye: a.secretEmploye }),
    maintenant: () => maintenant() / 1000,
    signal,
  });
}

/** Lance le test d'un fournisseur sans jamais lever : `resultat` part au plus tard à l'échéance globale, qui arrête aussi le travail (plus aucune résolution ni connexion ne démarre) ; `termine` n'est tenu qu'à la fin réelle du travail. `complete` n'est vrai que pour un annuaire dont toutes les étapes, utilisateur d'essai compris, sont passées avant l'échéance (les clés OIDC viennent plus tard). */
export function lancerTest(
  reglages: unknown,
  contexte: ContexteEssai,
  options: OptionsEssai = {},
): TestLance {
  const etapes: EtapeEssai[] = [];
  const global = options.delaiGlobalMs ?? DELAI_GLOBAL_MS;
  const arret = new AbortController();
  let minuteur: NodeJS.Timeout | undefined;
  const limite = new Promise<"delai">((r) => {
    minuteur = setTimeout(() => {
      arret.abort();
      r("delai");
    }, global);
  });
  const sortie: Sortie = { teste: null, complet: false };
  let retenu: Fournisseur | null = null;
  const travail = corps(etapes, reglages, contexte, options, arret.signal, sortie).then(
    () => "fini" as const,
    () => "erreur" as const,
  );
  const resultat = Promise.race([travail, limite]).then((fin) => {
    const steps = [...etapes];
    if (fin === "delai")
      steps.push(
        etape("timeout", "Délai global", "fail", `Le test a dépassé ${Math.round(global / 1000)} secondes.`),
      );
    if (fin === "erreur")
      steps.push(etape("internal", "Test", "fail", "Le test a échoué : demandez à votre administrateur."));
    const ok = steps.every((e) => e.level !== "fail");
    const complete = ok && fin === "fini" && sortie.complet;
    retenu = complete ? sortie.teste : null;
    return { ok, complete, steps };
  });
  const termine = travail.then(() => clearTimeout(minuteur));
  return { resultat, termine, fournisseurTeste: () => retenu };
}

/** Teste les réglages d'un fournisseur et rend le résultat (voir `lancerTest`). */
export async function testerFournisseur(
  reglages: unknown,
  contexte: ContexteEssai,
  options: OptionsEssai = {},
): Promise<ResultatEssai> {
  return lancerTest(reglages, contexte, options).resultat;
}
