// SPDX-License-Identifier: MIT
/** apps/core/src/identite/essai.ts — bouton « Tester » d'un fournisseur : réglages, prérequis, résolution, adresse, TLS, découverte et horloge OIDC, rendus en étapes à liste blanche. */
import { estDict, HttpError } from "@elpis/commun";
import type { JugeHote, VerdictHote } from "@elpis/http";

import { defautsFournisseur, fusionner, hotePortHttps, hotePortLdaps, validerFournisseur } from "./reglages";
import type { Fournisseur, FournisseurOidc } from "./reglages";
import { classerErreur, clientHttps, connexionTls, jugeSortant } from "./sortant";
import type { CodeSortant, OptionsSortant } from "./sortant";

export const DELAI_GLOBAL_MS = 20_000;
const DETAIL_MAX = 300;
const JOURS_ALERTE = 30;
const ADRESSES_MAX = 5;

export interface EtapeEssai {
  id: string;
  label: string;
  level: "ok" | "warn" | "fail";
  detail: string;
  /** `hôte:port` joint par l'étape ; `null` pour une étape qui ne vise aucune adresse. */
  target: string | null;
}

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
}

const PHRASES: Readonly<Record<CodeSortant, string>> = {
  ca_illisible: "L'autorité de certification collée est illisible : collez-la à nouveau au format PEM.",
  adresse_refusee: "Adresse refusée.",
  resolution: "Le nom de l'hôte ne se résout pas.",
  refusee: "Connexion refusée par la machine distante.",
  delai: "Délai dépassé.",
  cert_expire: "Le certificat présenté par le serveur est expiré.",
  cert_futur:
    "Le certificat présenté par le serveur n'est pas encore valide : vérifiez l'horloge de ce serveur et celle du serveur distant.",
  ca_inconnue:
    "Autorité de certification inconnue : collez l'autorité de certification de votre organisation.",
  auto_signe:
    "Le certificat présenté par le serveur est auto-signé : collez-le comme autorité de certification.",
  nom_certificat: "Le nom de l'hôte ne correspond pas au certificat présenté par le serveur.",
  version_tls: "Version de TLS refusée : TLS 1.2 au minimum est exigé.",
  tls: "Échec de la négociation TLS.",
  redirection: "Le serveur répond par une redirection : les redirections ne sont pas suivies.",
  taille: "Réponse trop volumineuse (plus de 1 Mio).",
  schema: "Adresse https attendue.",
  reseau: "Échec de la connexion.",
};

const borner = (t: string): string => t.slice(0, DETAIL_MAX);

function etape(
  id: string,
  label: string,
  level: EtapeEssai["level"],
  detail: string,
  target: string | null = null,
): EtapeEssai {
  return { id, label, level, detail: borner(detail), target };
}

/** Juge appelé une fois par `hôte:port` : ce que l'étape « adresse » affiche est ce que les connexions utilisent. */
function jugeUnique(base: JugeHote): JugeHote {
  const vus = new Map<string, Promise<VerdictHote>>();
  return (hote, port) => {
    const cle = `${hote}:${port}`;
    let v = vus.get(cle);
    if (v === undefined) {
      v = base(hote, port);
      vus.set(cle, v);
    }
    return v;
  };
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
): Promise<void> {
  const { hote, port } = coupe(cible);
  const litterale = hote.includes(":") || /^[\d.]+$/u.test(hote);
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
  etapes.push(etape("address", "Adresse", "ok", `Adresse autorisée : ${liste}.`, cible));
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

const POINTS_DE_TERMINAISON = ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const;

function pointInvalide(doc: Record<string, unknown>, origine: string): string | null {
  for (const nom of POINTS_DE_TERMINAISON) {
    const v = doc[nom];
    if (typeof v !== "string" || !URL.canParse(v))
      return `Le champ ${nom} est absent ou n'est pas une adresse.`;
    const u = new URL(v);
    if (u.protocol !== "https:") return `Le champ ${nom} n'est pas en https.`;
    if (u.origin !== origine)
      return `Le champ ${nom} n'est pas sur la même origine que l'émetteur : le fournisseur est mal configuré.`;
  }
  return null;
}

/** Découverte OIDC puis écart d'horloge, d'après l'en-tête `Date` de la même réponse. */
async function etapesDecouverte(
  etapes: EtapeEssai[],
  f: FournisseurOidc,
  juge: JugeHote,
  sortant: OptionsSortant,
  maintenant: () => number,
): Promise<void> {
  const client = clientHttps({ ...sortant, juger: juge });
  const adresse = `${f.issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`;
  const cible = hotePortHttps(f.issuer);
  let lu: { statut: number; texte: string; date: string | null };
  try {
    const rep = await client.fetch(adresse, { headers: { accept: "application/json" } });
    lu = { statut: rep.status, texte: await rep.text(), date: rep.headers.get("date") };
  } catch (e) {
    etapes.push(etape("discovery", "Découverte", "fail", PHRASES[classerErreur(e)], cible));
    return;
  } finally {
    await client.fermer().catch(() => undefined);
  }
  etapes.push(decouverte(f, lu.statut, lu.texte, cible));
  etapes.push(horloge(f, lu.date, maintenant, cible));
}

function decouverte(f: FournisseurOidc, statut: number, texte: string, cible: string): EtapeEssai {
  const echec = (detail: string): EtapeEssai => etape("discovery", "Découverte", "fail", detail, cible);
  if (statut !== 200) return echec(`Le serveur a répondu avec le statut ${statut} au lieu de 200.`);
  let doc: unknown;
  try {
    doc = JSON.parse(texte);
  } catch {
    return echec("La réponse n'est pas un document JSON.");
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    return echec("La réponse n'est pas un objet JSON.");
  const d = doc as Record<string, unknown>;
  if (d["issuer"] !== f.issuer)
    return echec("L'émetteur annoncé par le serveur ne correspond pas exactement à celui configuré.");
  const invalide = pointInvalide(d, new URL(f.issuer).origin);
  if (invalide !== null) return echec(invalide);
  return etape("discovery", "Découverte", "ok", "Document de découverte valide (statut 200).", cible);
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
  const sortant: OptionsSortant = { ...o.sortant, caPem: f.ca_pem };
  const juge = jugeUnique(o.sortant?.juger ?? jugeSortant(o.sortant?.resoudre));
  if (f.type === "ldap")
    for (const u of f.urls) await etapesAdresse(etapes, hotePortLdaps(u), juge, sortant, maintenant);
  else {
    const n = etapes.length;
    await etapesAdresse(etapes, hotePortHttps(f.issuer), juge, sortant, maintenant);
    if (etapes.slice(n).every((e) => e.level !== "fail"))
      await etapesDecouverte(etapes, f, juge, sortant, maintenant);
  }
}

/** Teste les réglages d'un fournisseur sans jamais lever ; `complete` reste faux (liaison LDAP et clés OIDC viennent plus tard) : aucun test réussi n'est enregistré. */
export async function testerFournisseur(
  reglages: unknown,
  contexte: ContexteEssai,
  options: OptionsEssai = {},
): Promise<ResultatEssai> {
  const etapes: EtapeEssai[] = [];
  const global = options.delaiGlobalMs ?? DELAI_GLOBAL_MS;
  let minuteur: NodeJS.Timeout | undefined;
  const limite = new Promise<"delai">((r) => {
    minuteur = setTimeout(() => r("delai"), global);
  });
  try {
    const fin = await Promise.race([
      corps(etapes, reglages, contexte, options).then(() => "fini" as const),
      limite,
    ]);
    const steps = [...etapes];
    if (fin === "delai")
      steps.push(
        etape("timeout", "Délai global", "fail", `Le test a dépassé ${Math.round(global / 1000)} secondes.`),
      );
    return { ok: steps.every((e) => e.level !== "fail"), complete: false, steps };
  } catch {
    const steps = [
      ...etapes,
      etape("internal", "Test", "fail", "Le test a échoué : demandez à votre administrateur."),
    ];
    return { ok: false, complete: false, steps };
  } finally {
    clearTimeout(minuteur);
  }
}
