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

/** Commande exécutée depuis un mot de shell (`$(…)`, backquote, `<(…)`) : jamais masquée. */
const SUBSTITUTION = /\$\(|`|[<>]\(/u;
/** Nom et séparateur d'une affectation `NOM=valeur` ou `NOM: valeur` d'un texte libre, suivis de 4 caractères de valeur au moins ; un seul essai par suite de caractères de nom (à son premier début de mot), en temps linéaire. */
const AFFECTATION_TEXTE =
  /\b(?=[A-Za-z_])(?<!\b[A-Za-z_][\w.-]*?)([A-Za-z_][A-Za-z0-9_.-]*)(["']?[ \t]*[:=][ \t]*["']?)(?=(?:[^\s"'`,;()\]}&?#|<>$]|\$(?!\()){4})/gu;
/** Valeur d'une affectation : jusqu'à un blanc, un guillemet, un séparateur d'URL (`&`, `?`, `#`) ou un opérateur de shell, jamais à travers `$(`. */
const VALEUR_AFFECTATION = /(?:[^\s"'`,;()\]}&?#|<>$]|\$(?!\())+/uy;
/** Nom d'une affectation de texte libre qui désigne un secret (finit par le mot : `DB_PASSWORD`, `api_key`, `X-Api-Key`, `DB_PASS`, `SECRET_KEY`, pas `author` ni `bypass`). */
const NOM_SECRET_TEXTE =
  /(?:SECRET|TOKEN|PASSW(?:OR)?D|PWD|PASSPHRASE|API[-_]?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?)$|(?:^|[-_.])PASS$|[-_]KEY$/iu;
/** Jeton porteur d'un en-tête `Authorization`. */
const PORTEUR = /\b(Bearer[ \t]+)([A-Za-z0-9._~+/=-]{12,})/gu;
/** En-tête `Authorization` (ou `Proxy-Authorization`) quelle que soit la casse : schéma gardé, justificatif masqué, sur la même ligne. */
const AUTORISATION =
  /\b((?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?)(?:([A-Za-z][\w-]*[ \t]+)([A-Za-z0-9._~+/=-]{4,})|([A-Za-z0-9._~+/=-]{8,}))/giu;
/** En-tête `Cookie` ou `Set-Cookie` : ses paires `nom=valeur` (RFC 6265), jusqu'au premier blanc, guillemet ou opérateur de shell (`echo cookie: && …` reste lisible). */
const COOKIE =
  /\b((?:set-)?cookie["']?[ \t]*:[ \t]*)([^\s"'`;&|<>()$\\=]+=[^\s"'`;&|<>()$\\]*(?:;[ \t]*[^\s"'`;&|<>()$\\=]+=[^\s"'`;&|<>()$\\]*)*)/giu;
/** Identifiants d'une URL (`https://alice:mdp@hote`, `postgresql://u:mdp@db`) : le mot de passe masqué, le nom aussi s'il ressemble à un jeton ; ni blanc ni opérateur de shell. */
const IDENTIFIANTS_URL = /:\/\/((?:[^\s/?#@:"'<>`;&|()$]|\$(?!\())*):((?:[^\s/?#@"'<>`;&|()$]|\$(?!\())+)@/gu;
/** Jeton seul en nom d'utilisateur d'une URL (`https://<40 hexadécimaux>@gitea/r.git`). */
const JETON_URL = /:\/\/([A-Za-z0-9_+=-]{20,})@/gu;
/** Nom d'URL qui ressemble à un jeton (32 hexadécimaux au moins, ou 20 caractères mêlant minuscules, majuscules et chiffres), pas à un compte (`oauth2`, `gitlab-ci-token`). */
const JETON_PROBABLE =
  /^(?:[0-9a-f]{32,}|[0-9A-F]{32,}|(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9_+=-]{20,})$/su;
/** Mot de passe SQL cité (`IDENTIFIED BY '…'`, `PASSWORD '…'`, `PASSWORD('…')`), sans guillemet de l'autre sorte (texte de shell cité). */
const MOT_DE_PASSE_SQL =
  /\b((?:IDENTIFIED[ \t]+(?:WITH[ \t]+\w+[ \t]+)?BY|PASSWORD)(?:[ \t]*\([ \t]*|[ \t]+))(['"])([^'"\r\n]+)\2/giu;
/** En-tête d'une clé privée, puis son corps possible (en-têtes PEM, base64, blancs, `\n` échappés d'un JSON) et sa fin. */
const DEBUT_CLE_PRIVEE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/gu;
const CORPS_CLE_PRIVEE =
  /(?:(?:Proc-Type|DEK-Info|Version|Comment|Hash|Charset):[^\n\\$`]*|\\+[nrt]|[A-Za-z0-9+/=\s])*/uy;
const FIN_CLE_PRIVEE = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/uy;
/** Ligne de base64 d'une vraie clé (64 ou 70 caractères en PEM et OpenSSH). */
const LIGNE_CLE = /[A-Za-z0-9+/=]{40,}/gu;

/** Corps des clés privées masqués : jusqu'à la marque de fin, ou sans elle jusqu'à la dernière ligne de base64 longue (la suite reste lisible) ; un en-tête déjà balayé n'est pas relu (temps linéaire). */
function masquerClesPrivees(texte: string): { texte: string; n: number } {
  let n = 0;
  let sortie = "";
  let pos = 0;
  let vu = 0;
  for (const m of texte.matchAll(DEBUT_CLE_PRIVEE)) {
    if (m.index < pos || m.index < vu) continue;
    const debut = m.index + m[0].length;
    CORPS_CLE_PRIVEE.lastIndex = debut;
    CORPS_CLE_PRIVEE.exec(texte);
    vu = CORPS_CLE_PRIVEE.lastIndex;
    FIN_CLE_PRIVEE.lastIndex = CORPS_CLE_PRIVEE.lastIndex;
    const fin = FIN_CLE_PRIVEE.exec(texte);
    let corps = texte.slice(debut, CORPS_CLE_PRIVEE.lastIndex);
    if (!fin) corps = corps.slice(0, finDerniereLigne(corps));
    if (!corps.replace(/\\+[nrt]/gu, "").trim() || EXEMPLE.test(corps)) continue;
    n++;
    sortie += `${texte.slice(pos, m.index)}${m[0]}\n****${fin ? `\n${fin[0]}` : ""}`;
    pos = fin ? fin.index + fin[0].length : debut + corps.length;
  }
  return { texte: n ? sortie + texte.slice(pos) : texte, n };
}

/** Fin de la dernière ligne de base64 longue d'un corps de clé. */
function finDerniereLigne(corps: string): number {
  const derniere = [...corps.matchAll(LIGNE_CLE)].at(-1);
  return derniere ? derniere.index + derniere[0].length : 0;
}

/** Nom d'une option dont l'argument est un secret : le nom entier ou sa fin après un séparateur (`--db-password`, `--api_key`, `-storepass`), jamais `--bypass` ni `--no-password`. */
const OPTION_SECRETE =
  /^-{1,2}(?!-|no-)(?:[\w.-]*[-_.])?(?:pass(?:word|wd|phrase|in|out)?|pwd|token|bearer|secret|api[-_]?key|(?:private|access|secret)[-_]?key|creds|credentials?|cookie|(?:src|dest)?(?:store|key)pass)$/iu;
/** Même nom en camelCase (`--dbPassword`, `--apiKey`, `--clientSecret`). */
const OPTION_SECRETE_CAMEL =
  /^-{1,2}(?!-|no[A-Z])[\w.-]*[a-z0-9](?:Pass(?:word|wd|phrase)?|Pwd|Token|Secret|(?:Api|Private|Access|Secret)Key|Creds|Credentials?)$/u;
/** Option dont l'argument est `compte:mot de passe` (`curl -u`, `--user`, `--proxy-user`, `http --auth`, `smbclient -U compte%mdp`). */
const OPTION_COMPTE = /^(?:-u|-U|--user|--proxy-user|--auth)$/u;
/** Même option courte, valeur collée (`curl -uadmin:x`, `smbclient -Ualice%x`). */
const OPTION_COMPTE_COLLEE = /^(-[uU])(.+)$/su;
/** Option et valeur collées (`--password=x`, `--user=alice:x`). */
const OPTION_COLLEE = /^(-{1,2}[^=\s]+)=(.+)$/su;
/** Affectation de shell (`DB_PASS=x`, préfixe d'une commande ou argument d'`export`). */
const AFFECTATION_SHELL = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/su;
/** Référence (`$VAR`, `${VAR}`, `$(…)`) : pas une valeur secrète, gardée lisible. */
const REFERENCE = /^\$(?:[\w{(]|$)/u;
/** Options courtes de mot de passe propres à une commande : lettres, forme séparée admise (`mysql -p base` demande le mot de passe, `base` est la base), forme collée admise (`openssl -kfile` est une autre option). */
type OptionCourte = readonly [lettres: string, separee: boolean, collee: boolean];
const OPTIONS_COURTES: readonly (readonly [RegExp, ...OptionCourte])[] = [
  [/^(?:mysql|mariadb)[\w-]*$/u, "p", false, true],
  [/^sshpass$/u, "p", true, true],
  [/^redis-cli$/u, "a", true, true],
  [/^ldap[a-z]*$/u, "w", true, true],
  [/^(?:un)?zip$/u, "P", true, true],
  [/^7z[arz]?$/u, "p", false, true],
  [/^sqlcmd$/u, "P", true, true],
  [/^ssh-keygen$/u, "NP", true, true],
  [/^openssl$/u, "kK", true, false],
];
/** Outils de conteneurs dont la sous-commande `login` prend `-p` (`docker login -u alice -p x`). */
const CONTENEURS = /^(?:docker|podman|nerdctl|buildah|skopeo|helm|oras)$/u;
/** Interprètes de commandes dont l'option `-c` lit un script. */
const SHELLS = /^(?:ba|da|z|k|a)?sh$/u;
/** Niveaux de commandes imbriquées relus (`bash -c "ssh hote 'mysql --password x'"`). */
const PROFONDEUR_SHELL = 3;

/** Mot ou opérateur d'un texte de shell : position dans le texte, valeur après guillemets et échappements. */
interface Jeton {
  readonly debut: number;
  readonly fin: number;
  readonly valeur: string;
  /** Opérateur : `commande` sépare deux commandes (`;`, `|`, `&`, retour…), `redirection` sépare deux mots. */
  readonly op?: "commande" | "redirection";
  /** Mot qui contient une substitution (`$(`, backquote, `<(`) ou la touche (`x$` devant `(` hors guillemets) : jamais masqué en entier. */
  readonly sub?: boolean;
}

/** Option dont l'argument suivant est un secret, nommée en kebab-case, snake_case ou camelCase. */
function optionSecrete(mot: string): boolean {
  return OPTION_SECRETE.test(mot) || OPTION_SECRETE_CAMEL.test(mot);
}

/** `alice:x` (`alice%x` pour smbclient) devient `alice:****` ; rien sans séparateur, pour `uid:gid` (`docker -u 1000:1000`), un format (`date -u +%H:%M`) ou une référence. */
function masqueCompte(valeur: string): string | null {
  const i = valeur.search(/[:%]/u);
  if (
    i < 0 ||
    i === valeur.length - 1 ||
    valeur.startsWith("+") ||
    /^\d+:\d+$/u.test(valeur) ||
    REFERENCE.test(valeur.slice(i + 1))
  )
    return null;
  return `${valeur.slice(0, i + 1)}****`;
}

/** Remplacement d'un mot secret (`****`, `-p****`, `alice:****`, `DB_PASS=****`), `null` sinon ; `avant` : mot précédent, `courte` : option courte de la commande en cours. */
function masqueDuMot(mot: string, avant: string | null, courte: OptionCourte | null): string | null {
  if (avant?.startsWith("-") && mot !== "" && !mot.startsWith("-") && !REFERENCE.test(mot)) {
    if (
      optionSecrete(avant) ||
      (courte?.[1] === true && avant.length === 2 && courte[0].includes(avant[1] ?? ""))
    )
      return "****";
    if (OPTION_COMPTE.test(avant)) return masqueCompte(mot);
  }
  const collee = mot.startsWith("-") ? OPTION_COLLEE.exec(mot) : null;
  if (collee) {
    const [, option = "", valeur = ""] = collee;
    if (REFERENCE.test(valeur)) return null;
    if (optionSecrete(option)) return `${option}=****`;
    const compte = OPTION_COMPTE.test(option) ? masqueCompte(valeur) : null;
    return compte === null ? null : `${option}=${compte}`;
  }
  const colle = OPTION_COMPTE_COLLEE.exec(mot);
  const masque = colle ? masqueCompte(colle[2] ?? "") : null;
  if (masque !== null) return `${colle?.[1] ?? ""}${masque}`;
  if (courte?.[2] === true && mot.length > 2 && mot[0] === "-" && courte[0].includes(mot[1] ?? ""))
    return `${mot.slice(0, 2)}****`;
  const aff = AFFECTATION_SHELL.exec(mot);
  return aff && NOM_SECRET_TEXTE.test(aff[1] ?? "") && !REFERENCE.test(aff[2] ?? "")
    ? `${aff[1]}=****`
    : null;
}

/** Mots secrets d'une suite de jetons (indice → remplacement), commande par commande. */
function masquesDesMots(jetons: readonly Jeton[]): Map<number, string> {
  const masques = new Map<number, string>();
  let avant: string | null = null;
  let courte: OptionCourte | null = null;
  let conteneur = false;
  for (const [i, j] of jetons.entries()) {
    if (j.op !== undefined) {
      avant = null;
      if (j.op === "commande") [courte, conteneur] = [null, false];
      continue;
    }
    const masque = j.sub === true ? null : masqueDuMot(j.valeur, avant, courte);
    if (masque !== null) masques.set(i, masque);
    avant = j.valeur;
    if (j.valeur.startsWith("-") || j.valeur.length > 64) continue;
    const nom = j.valeur.slice(j.valeur.lastIndexOf("/") + 1);
    const famille = OPTIONS_COURTES.find(([re]) => re.test(nom));
    if (famille) courte = [famille[1], famille[2], famille[3]];
    else if (conteneur && nom === "login") courte = ["p", true, true];
    conteneur ||= CONTENEURS.test(nom);
  }
  return masques;
}

/** Séparateurs de commandes du shell (hors guillemets), suites de caractères ordinaires d'un mot et d'un texte entre guillemets doubles. */
const OPERATEURS = new Set(["\n", ";", "&", "|", "(", ")", "`", "<", ">"]);
const ORDINAIRES = /[^ \t\n;&|()<>`'"\\$]+/uy;
const ORDINAIRES_DOUBLES = /[^"\\]+/uy;

/** Fin d'une suite de caractères ordinaires commençant en `i` (`i` si aucune). */
function finSuite(re: RegExp, t: string, i: number): number {
  re.lastIndex = i;
  return re.test(t) ? re.lastIndex : i;
}

/** Mots et opérateurs d'un texte de shell : guillemets simples et doubles, `$'…'`, échappements, commentaires ; tolérant (un guillemet non fermé court jusqu'à la fin). */
function jetonsShell(t: string): Jeton[] {
  const jetons: Jeton[] = [];
  const car = (k: number): string => t[k] ?? "";
  let i = 0;
  while (i < t.length) {
    const c = car(i);
    if (c === " " || c === "\t" || (c === "\\" && car(i + 1) === "\n")) {
      i += c === "\\" ? 2 : 1;
      continue;
    }
    if (OPERATEURS.has(c)) {
      jetons.push({
        debut: i,
        fin: i + 1,
        valeur: c,
        op: c === "<" || c === ">" ? "redirection" : "commande",
      });
      i++;
      continue;
    }
    if (c === "#") {
      const f = t.indexOf("\n", i);
      i = f < 0 ? t.length : f;
      continue;
    }
    const debut = i;
    let valeur = "";
    while (i < t.length && car(i) !== " " && car(i) !== "\t" && !OPERATEURS.has(car(i))) {
      const d = car(i);
      if (d === "'") {
        const f = t.indexOf("'", i + 1);
        valeur += t.slice(i + 1, f < 0 ? t.length : f);
        i = f < 0 ? t.length : f + 1;
      } else if (d === "$" && car(i + 1) === "'") {
        for (i += 2; i < t.length && car(i) !== "'"; i++) valeur += car(i) === "\\" ? car(++i) : car(i);
        i++;
      } else if (d === '"') {
        for (i++; i < t.length && car(i) !== '"';) {
          const e = car(i + 1);
          if (car(i) !== "\\") {
            const f = finSuite(ORDINAIRES_DOUBLES, t, i);
            valeur += t.slice(i, f);
            i = f;
          } else {
            valeur += e && '"\\$`'.includes(e) ? e : e === "\n" ? "" : `\\${e}`;
            i += 2;
          }
        }
        i++;
      } else if (d === "\\") {
        valeur += car(i + 1).replace("\n", "");
        i += 2;
      } else {
        const f = Math.max(finSuite(ORDINAIRES, t, i), i + 1);
        valeur += t.slice(i, f);
        i = f;
      }
    }
    const sub = SUBSTITUTION.test(t.slice(debut, i)) || t.startsWith("$(", i - 1);
    jetons.push({ debut, fin: Math.min(i, t.length), valeur, sub });
  }
  return jetons;
}

/** Texte de shell masqué mot à mot ; un mot qui contient un blanc est relu comme une commande imbriquée (`sh -c '…'`, `ssh hote '…'`) puis recité. */
function masquerMotsShell(t: string, profondeur: number): string {
  const jetons = jetonsShell(t);
  const masques = masquesDesMots(jetons);
  let sortie = "";
  let pos = 0;
  for (const [i, j] of jetons.entries()) {
    let r = masques.get(i);
    if (r === undefined && j.op === undefined && profondeur < PROFONDEUR_SHELL && /\s/u.test(j.valeur)) {
      const interne = masquerMotsShell(j.valeur, profondeur + 1);
      if (interne !== j.valeur) r = `'${interne.replaceAll("'", "'\\''")}'`;
    }
    if (r === undefined) continue;
    sortie += t.slice(pos, j.debut) + r;
    pos = j.fin;
  }
  return sortie + t.slice(pos);
}

/** Texte d'une commande de shell (`bash -c`) masqué : mots secrets, puis secrets d'un texte libre ; une demi-paire UTF-16 devient U+FFFD. */
export function masquerCommandeShell(texte: string): string {
  return masquerSecretsTexte(masquerMotsShell(texte.toWellFormed(), 0)).texte;
}

/** Indice du script d'un interprète (`bash -euo pipefail -c SCRIPT …`), -1 sans `-c`. */
function indiceScript(argv: readonly string[]): number {
  if (!SHELLS.test((argv[0] ?? "").slice((argv[0] ?? "").lastIndexOf("/") + 1))) return -1;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--") && a.length > 2) continue;
    if (!/^[-+][A-Za-z]+$/u.test(a)) return -1;
    if (a.startsWith("-") && a.includes("c")) return i + 1 < argv.length ? i + 1 : -1;
    if (a.endsWith("o")) i++;
  }
  return -1;
}

/** Argument qui ferait plusieurs mots relu par un shell (blanc, opérateur, substitution) : jamais masqué en entier, relu comme du shell. */
const PLUSIEURS_MOTS = /[\s;&|()<>`]|\$\(/u;

/** Arguments d'une commande masqués (journal, audit) : règles d'option sur les mots ; script de `bash -c`, arguments qui le suivent et tout argument à blancs ou opérateurs relus comme du shell ; les autres comme un texte libre. */
export function masquerArgv(argv: readonly string[]): string[] {
  const mots = argv.map((a) => a.toWellFormed());
  const script = indiceScript(mots);
  const masques = masquesDesMots(
    mots.map((valeur, i) =>
      i === script
        ? { debut: 0, fin: 0, valeur, op: "commande" }
        : { debut: 0, fin: 0, valeur, sub: PLUSIEURS_MOTS.test(valeur) },
    ),
  );
  return mots.map(
    (a, i) =>
      masques.get(i) ??
      ((script >= 0 && i >= script) || PLUSIEURS_MOTS.test(a)
        ? masquerCommandeShell(a)
        : masquerSecretsTexte(a).texte),
  );
}

/** Affectations nommées d'un secret masquées ; un nom ordinaire (`username=a&password=x`, `config: db_password=x`) laisse relire sa valeur, une valeur lue n'est jamais relue (temps linéaire). */
function masquerAffectations(t: string): { texte: string; n: number } {
  let n = 0;
  let sortie = "";
  let pos = 0;
  AFFECTATION_TEXTE.lastIndex = 0;
  for (let m = AFFECTATION_TEXTE.exec(t); m !== null; m = AFFECTATION_TEXTE.exec(t)) {
    if (!NOM_SECRET_TEXTE.test(m[1] ?? "")) continue;
    const debut = m.index + m[0].length;
    VALEUR_AFFECTATION.lastIndex = debut;
    VALEUR_AFFECTATION.test(t);
    AFFECTATION_TEXTE.lastIndex = VALEUR_AFFECTATION.lastIndex;
    const valeur = t.slice(debut, VALEUR_AFFECTATION.lastIndex);
    if (EXEMPLE.test(valeur) || /^\$[\w{(]|^\{|^%[(\w]|\*{4}/u.test(valeur)) continue;
    n++;
    sortie += `${t.slice(pos, debut)}****`;
    pos = VALEUR_AFFECTATION.lastIndex;
  }
  return { texte: n ? sortie + t.slice(pos) : t, n };
}

/** Secrets d'un texte libre masqués (jetons connus, clés privées, affectations nommées, en-têtes d'authentification, identifiants d'URL, mots de passe SQL) ; `n` : nombre de remplacements. */
export function masquerSecretsTexte(texte: string): { texte: string; n: number } {
  const cles = masquerClesPrivees(texte);
  let n = cles.n;
  let t = cles.texte;
  for (const m of MOTIFS) {
    const global = new RegExp(m.re.source, m.re.flags.includes("g") ? m.re.flags : `${m.re.flags}g`);
    t = t.replace(global, (tout: string, valeur: string) => {
      if (!valeur || EXEMPLE.test(valeur) || valeur.includes("****")) return tout;
      n++;
      return tout.replace(valeur, masqueCourt(valeur));
    });
  }
  t = t.replace(IDENTIFIANTS_URL, (tout, nom: string, mdp: string) => {
    if (EXEMPLE.test(mdp) || mdp.includes("****") || REFERENCE.test(mdp)) return tout;
    n++;
    return `://${JETON_PROBABLE.test(nom) ? "****" : nom}:****@`;
  });
  t = t.replace(JETON_URL, (tout, nom: string) => {
    if (!JETON_PROBABLE.test(nom) || EXEMPLE.test(nom)) return tout;
    n++;
    return "://****@";
  });
  t = t.replace(
    AUTORISATION,
    (tout, debut: string, schema: string | undefined, v1: string | undefined, v2: string | undefined) => {
      if (EXEMPLE.test(v1 ?? v2 ?? "")) return tout;
      n++;
      return `${debut}${schema ?? ""}****`;
    },
  );
  t = t.replace(COOKIE, (tout, debut: string, valeur: string) => {
    if (!valeur.trim() || /^\*{4}\s*$/u.test(valeur) || EXEMPLE.test(valeur)) return tout;
    n++;
    return `${debut}****`;
  });
  t = t.replace(MOT_DE_PASSE_SQL, (tout, debut: string, q: string, valeur: string) => {
    if (
      EXEMPLE.test(valeur) ||
      valeur.includes("****") ||
      REFERENCE.test(valeur) ||
      SUBSTITUTION.test(valeur)
    )
      return tout;
    n++;
    return `${debut}${q}****${q}`;
  });
  const affectations = masquerAffectations(t);
  n += affectations.n;
  t = affectations.texte;
  t = t.replace(PORTEUR, (tout, debut: string, valeur: string) => {
    if (EXEMPLE.test(valeur) || valeur.includes("****")) return tout;
    n++;
    return `${debut}****`;
  });
  return { texte: t, n };
}
