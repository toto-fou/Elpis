// SPDX-License-Identifier: MIT
/** packages/securite/src/secrets.ts — secrets dans les lignes ajoutées d'un diff indexé (harnais B-06) et dans un texte libre (rapport de sous-agent) : motifs courts et documentés, valeurs d'exemple écartées, aperçu masqué, jamais la valeur. */

export interface Trouvaille {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly preview: string;
}

interface Motif {
  readonly kind: string;
  /** Groupe 1 : la valeur secrète. */
  readonly re: RegExp;
}

/** Motifs retenus : une famille de jeton par ligne, préfixe public seul montré. */
const MOTIFS: readonly Motif[] = [
  // identifiant de clé d'accès AWS (AKIA… / ASIA…, 20 caractères)
  { kind: "aws_access_key_id", re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/u },
  // clé secrète AWS nommée (40 caractères)
  {
    kind: "aws_secret_access_key",
    re: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/iu,
  },
  // jetons GitHub classiques (ghp_, gho_, ghu_, ghs_, ghr_) et à grain fin (github_pat_)
  {
    kind: "github_token",
    re: /\b((?:gh[pousr]_[A-Za-z0-9]{36,255})|(?:github_pat_[A-Za-z0-9_]{22,255}))\b/u,
  },
  // jeton personnel GitLab
  { kind: "gitlab_token", re: /\b(glpat-[A-Za-z0-9_-]{20,})/u },
  // jetons Slack (xoxb-, xoxp-…) et webhook entrant
  { kind: "slack_token", re: /\b(xox[abposr]-[A-Za-z0-9-]{10,})/u },
  { kind: "slack_webhook", re: /(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/]{20,})/u },
  // clés Stripe de production
  { kind: "stripe_live_key", re: /\b((?:sk|rk)_live_[A-Za-z0-9]{20,})/u },
  // clé d'API Google
  { kind: "google_api_key", re: /\b(AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/u },
];

/** En-tête d'une clé privée PEM, OpenSSH ou PGP. */
const CLE_PRIVEE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/u;
/** Ligne de corps d'une vraie clé (base64 assez longue), sur les lignes suivantes ou après l'en-tête (`\n` échappés d'un JSON). */
const CORPS_CLE = /^[A-Za-z0-9+/=]{40,}$/u;
/** Valeurs d'exemple évidentes : jamais signalées. */
const EXEMPLE =
  /example|sample|dummy|fake|placeholder|changeme|redacted|your[_-]|x{6,}|\*{3,}|0{8,}|\.\.\.|<[^<>]*>|\$\{|\{\{/iu;
/** Préfixes publics montrés dans l'aperçu. */
const PREFIXE_PUBLIC = /^(?:AKIA|ASIA|gh[pousr]_|github_pat_|glpat-|xox[abposr]-|[sr]k_live_|AIza)/u;
/** Fichier `.env*` hors modèles (`.env.example`, `.env.sample`…). */
const FICHIER_ENV = /(?:^|\/)\.env(?:\.[^/]*)?$/u;
const MODELE_ENV = /\.(?:example|sample|template|dist|defaults?)$/iu;
/** Affectation `NOM=valeur` d'un `.env`, nom évocateur d'un secret. */
const AFFECTATION = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S.*)?$/u;
const NOM_SECRET = /SECRET|TOKEN|PASSW(?:OR)?D|PWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|AUTH/iu;

/** Aperçu masqué : préfixe public éventuel, puis la longueur ; jamais un caractère secret. */
export function masquer(valeur: string): string {
  const prefixe = PREFIXE_PUBLIC.exec(valeur)?.[0] ?? "";
  return `${prefixe}****(${[...valeur].length} chars)`;
}

/** Valeur d'une affectation `.env` sans guillemets ni commentaire de fin ; vide si absente ou référence. */
function valeurEnv(brute: string): string {
  let v = brute.trim();
  const q = v[0];
  if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) v = v.slice(1, v.indexOf(q, 1));
  else {
    const i = v.search(/\s#/u);
    if (i >= 0) v = v.slice(0, i).trimEnd();
  }
  return /^\$\w|^\$\{/u.test(v) ? "" : v;
}

/** Trouvailles d'une ligne ajoutée (au plus une par ligne) ; `suite` : lignes ajoutées qui la suivent dans le même fichier. */
function trouverDansLigne(fichier: string, texte: string, suite: readonly string[]): [string, string] | null {
  for (const m of MOTIFS) {
    const v = m.re.exec(texte)?.[1];
    if (v && !EXEMPLE.test(v)) return [m.kind, masquer(v)];
  }
  const cle = CLE_PRIVEE.exec(texte);
  if (cle && !EXEMPLE.test(texte)) {
    const reste = texte
      .slice(cle.index + cle[0].length)
      .replace(/\\+/gu, "\\")
      .split(/\\n|\s+/u);
    if (reste.some((x) => CORPS_CLE.test(x)) || suite.some((l) => CORPS_CLE.test(l.trim())))
      return ["private_key", cle[0]];
    return ["private_key_header", cle[0]];
  }
  if (FICHIER_ENV.test(fichier) && !MODELE_ENV.test(fichier)) {
    const a = AFFECTATION.exec(texte);
    const v = a ? valeurEnv(a[2] ?? "") : "";
    if (a && NOM_SECRET.test(a[1] ?? "") && v.length >= 4 && !EXEMPLE.test(v))
      return ["env_secret", `${a[1]}=****(${[...v].length} chars)`];
  }
  return null;
}

/** Chemin d'une ligne `+++ b/…` (forme entre guillemets de git comprise), `null` pour `/dev/null`. */
export function cheminDiff(entete: string): string | null {
  let p = entete.slice(4).replace(/\t$/u, "");
  if (p === "/dev/null") return null;
  if (p.startsWith('"') && p.endsWith('"')) {
    const octets: number[] = [];
    const corps = p.slice(1, -1);
    const echap: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
    for (let i = 0; i < corps.length; i++) {
      const c = corps[i] as string;
      if (c !== "\\") {
        octets.push(...Buffer.from(c, "utf-8"));
        continue;
      }
      const o = /^[0-7]{3}/u.exec(corps.slice(i + 1))?.[0];
      if (o) {
        octets.push(parseInt(o, 8));
        i += 3;
      } else {
        octets.push(echap[corps[i + 1] ?? ""] ?? 92);
        i += 1;
      }
    }
    p = Buffer.from(octets).toString("utf-8");
  }
  return p.startsWith("b/") ? p.slice(2) : p;
}

/** Secrets des lignes ajoutées d'un `git diff --cached -U0` : fichier, ligne (nouvelle numérotation), famille, aperçu masqué. */
export function secretsDuDiff(diff: string): Trouvaille[] {
  const trouvailles: Trouvaille[] = [];
  const lignes = diff.split("\n");
  let fichier: string | null = null;
  let entete = false;
  let numero = 0;
  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i] as string;
    if (l.startsWith("diff --git ")) [fichier, entete] = [null, true];
    else if (entete && l.startsWith("+++ ")) fichier = cheminDiff(l);
    else if (l.startsWith("@@")) [numero, entete] = [Number(/\+(\d+)/u.exec(l)?.[1] ?? 0), false];
    else if (!entete && l.startsWith("+") && fichier !== null) {
      const suite: string[] = [];
      for (let j = i + 1; j < lignes.length && suite.length < 5 && (lignes[j] ?? "").startsWith("+"); j++)
        suite.push((lignes[j] as string).slice(1));
      const t = trouverDansLigne(fichier, l.slice(1), suite);
      if (t) trouvailles.push({ file: fichier, line: numero, kind: t[0], preview: t[1] });
      numero++;
    } else if (!entete && l.startsWith(" ")) numero++;
  }
  return trouvailles;
}

/** Remplacement d'un secret dans un texte : 4 caractères du préfixe public au plus, jamais la valeur. */
function masqueCourt(valeur: string): string {
  return `${(PREFIXE_PUBLIC.exec(valeur)?.[0] ?? "").slice(0, 4)}****`;
}

/** Affectation `NOM=valeur` ou `NOM: valeur` dans un texte libre, nom évocateur d'un secret ; un seul essai par suite de caractères de nom (à son premier début de mot), en temps linéaire. */
const AFFECTATION_TEXTE =
  /\b(?=[A-Za-z_])(?<!\b[A-Za-z_][\w.-]*?)([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"'`,;)\]}]{4,})/gu;
/** Nom d'une affectation de texte libre qui désigne un secret (finit par le mot : `DB_PASSWORD`, `api_key`, pas `author`). */
const NOM_SECRET_TEXTE =
  /(?:SECRET|TOKEN|PASSW(?:OR)?D|PWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?)$/iu;
/** Jeton porteur d'un en-tête `Authorization`. */
const PORTEUR = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gu;
/** Corps d'une clé privée entre son en-tête et sa fin. */
const BLOC_CLE_PRIVEE =
  /(-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----)([\s\S]*?)(-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/gu;

/** Secrets d'un texte libre masqués (jetons connus, clés privées, affectations nommées) ; `n` : nombre de remplacements. */
export function masquerSecretsTexte(texte: string): { texte: string; n: number } {
  let n = 0;
  let t = texte.replace(BLOC_CLE_PRIVEE, (tout, debut: string, corps: string, fin: string) => {
    if (!corps.trim() || EXEMPLE.test(corps)) return tout;
    n++;
    return `${debut}\n****\n${fin}`;
  });
  for (const m of MOTIFS) {
    const global = new RegExp(m.re.source, m.re.flags.includes("g") ? m.re.flags : `${m.re.flags}g`);
    t = t.replace(global, (tout: string, valeur: string) => {
      if (!valeur || EXEMPLE.test(valeur) || valeur.includes("****")) return tout;
      n++;
      return tout.replace(valeur, masqueCourt(valeur));
    });
  }
  t = t.replace(AFFECTATION_TEXTE, (tout, nom: string, sep: string, valeur: string) => {
    if (!NOM_SECRET_TEXTE.test(nom) || EXEMPLE.test(valeur) || /^\$\w|^\$\{|\*{4}/u.test(valeur)) return tout;
    n++;
    return `${nom}${sep}****`;
  });
  t = t.replace(PORTEUR, (tout, debut: string, valeur: string) => {
    if (EXEMPLE.test(valeur) || valeur.includes("****")) return tout;
    n++;
    return `${debut}****`;
  });
  return { texte: t, n };
}
