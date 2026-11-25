// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/reseau-vue.ts — ce que voient les sandboxes d'un profil réseau en cours d'édition : règles que poserait le script de démarrage (miroir de `plagesRefusees` et de sandbox-agent/demarrage.sh, vérifié par packages/bac/test/reseau-vue.test.ts), puis le verdict de chaque destination, tiré de ces règles par un évaluateur de la chaîne OUTPUT. */
import { pluriel } from "./formats";

/** Protection « métadonnées » (`PLAGES_METADONNEES` de @elpis/bac). */
export const PLAGES_METADONNEES: readonly string[] = [
  "169.254.0.0/16",
  "100.100.100.200/32",
  "168.63.129.16/32",
];
/** Protection « réseau local » (`PLAGES_LOCALES` de @elpis/bac). */
export const PLAGES_LOCALES: readonly string[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
];
/** Ce que la protection « hôte » refuse en plus des adresses de la machine : diffusion générale et multidiffusion. */
export const DIFFUSIONS_HOTE: readonly string[] = ["255.255.255.255/32", "224.0.0.0/4"];
/** Réseau Docker des sandboxes qui ont une interface (`RESEAU_BACS` de @elpis/bac). */
export const RESEAU_BACS = "elpis-sandbox";
/** Résolveur d'une liste blanche sans résolveur (`DNS_DE_GARDE` de @elpis/bac) : jamais joignable. */
export const DNS_DE_GARDE = "192.0.2.1";
/** Ports d'une règle `multiport`, comme le script de démarrage. */
export const PORTS_PAR_REGLE = 15;
/** Adresse IPv4 décimale, octets sans zéro de tête. */
export const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

const ENTETE_IPV4: readonly string[] = [
  "*filter",
  ":INPUT ACCEPT [0:0]",
  ":FORWARD ACCEPT [0:0]",
  ":OUTPUT DROP [0:0]",
  "-A OUTPUT -o lo -j ACCEPT",
  "-A OUTPUT -m state --state RELATED,ESTABLISHED -j ACCEPT",
];
const REFUS_IPV4 = "-j REJECT --reject-with icmp-host-unreachable";
const IPV6: readonly string[] = [
  "-P OUTPUT DROP",
  "-A OUTPUT -o lo -j ACCEPT",
  "-A OUTPUT -m state --state RELATED,ESTABLISHED -j ACCEPT",
  "-A OUTPUT -j REJECT --reject-with icmp6-adm-prohibited",
];

export type CleProtection = "metadata" | "lan" | "host";
export type Verdict = "ok" | "partiel" | "inactif" | "refus" | "relais";
/** État de `/api/admin/executors/status` : pas encore reçu, en échec, reçu. */
export type EtatServeur = "attente" | "echec" | "charge";

/** Profil tel que la console l'édite : valeurs saisies, protections, règle Git, politique de ports (`all` : aucun filtre). */
export interface ProfilVu {
  id: string;
  mode: string;
  ips?: readonly (string | number)[];
  domains?: readonly (string | number)[];
  ports?: readonly (string | number)[];
  dns?: readonly (string | number)[];
  block_metadata?: boolean;
  block_lan?: boolean;
  block_host?: boolean;
  git_access?: string;
  git_servers?: readonly string[];
  _portsMode?: string;
}

/** Relevé de la machine servi par la console (`machine` de /api/admin/executors/status). */
export interface MachineVue {
  addresses: readonly string[];
  broadcasts: readonly string[];
}

/** Ce que la vue sait en plus du profil : sudo permis, relevé de la machine, adresses des domaines (`null` : sans réponse à temps, `[]` : nom introuvable), état du serveur. */
export interface ContexteVue {
  sudo: boolean;
  machine: MachineVue | null;
  domaines: Readonly<Record<string, readonly string[] | null>>;
  etat: EtatServeur;
}

/** Règles du conteneur, ou la raison de leur absence ; `causes` : origine de chaque règle de destination (protection, liste, domaine, résolveur) ; `inconnus` : domaines encore sans relevé. */
export type ReglesVues =
  | { genre: "sans-reseau" }
  | { genre: "sans-filtre" }
  | { genre: "machine-inconnue" }
  | {
      genre: "regles";
      ipv4: string[];
      ipv6: string[];
      inconnus: string[];
      causes: Readonly<Record<string, string>>;
    };

/** Une destination vue d'une sandbox du profil (graphe et tableau). */
export interface LigneVue {
  cle: string;
  nom: string;
  verdict: Verdict;
  detail: string;
  icone: string;
  ports: string;
  /** Accès sensible ouvert, en tout ou en partie. */
  risque: boolean;
}

export const VERDICTS: readonly Verdict[] = ["ok", "partiel", "inactif", "refus", "relais"];
export const LIBELLES_VERDICT: Readonly<Record<Verdict, string>> = {
  ok: "Autorisé",
  partiel: "Partiel",
  inactif: "Inactif",
  refus: "Refusé",
  relais: "Par relais",
};
export const ICONES_VERDICT: Readonly<Record<Verdict, string>> = {
  ok: "ph-check",
  partiel: "ph-circle-half",
  inactif: "ph-warning",
  refus: "ph-prohibit",
  relais: "ph-arrows-left-right",
};

const PROTECTIONS: readonly [CleProtection, "block_metadata" | "block_lan" | "block_host", string][] = [
  ["metadata", "block_metadata", "Métadonnées du cloud"],
  ["lan", "block_lan", "Réseau local"],
  ["host", "block_host", "Machine hôte"],
];
const LISTE = "la liste";
const RESOLVEUR = "résolveur DNS";

const parPointsDeCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sansMasque = (t: string): string => t.replace(/\/32$/, "");
const enumerer = (l: readonly string[]): string =>
  l.length > 1 ? `${l.slice(0, -1).join(", ")} et ${l.at(-1) ?? ""}` : (l[0] ?? "");

/** Valeurs d'une liste en texte, rognées, sans les vides. */
function textes(l: readonly (string | number)[] | undefined): string[] {
  return (l ?? []).map((x) => String(x).trim()).filter((x) => x !== "");
}

/** Protections appliquées : celles cochées d'un profil ouvert, aucune ailleurs (`protectionsDe`). */
export function protectionsVues(p: ProfilVu): CleProtection[] {
  if (p.mode !== "bridge") return [];
  return PROTECTIONS.filter(([, champ]) => p[champ] === true).map(([cle]) => cle);
}

/** Réseau filtré dans le conteneur, liste blanche ou profil ouvert protégé (`profilFiltre`). */
export function profilFiltre(p: ProfilVu): boolean {
  return p.mode === "allowlist_ip" || protectionsVues(p).length > 0;
}

/** Sandbox durcie, sans sudo et système en lecture seule : sudo refusé partout, ou profil filtré (`UserSandbox.durci`). */
export function profilDurci(p: ProfilVu, sudo: boolean): boolean {
  return !sudo || profilFiltre(p);
}

/** Adresse ou réseau IPv4 dans la forme qu'enregistre le serveur (bits d'hôte effacés, `/32` retiré) ; `null` pour une autre saisie. */
export function ipv4Canonique(texte: string): string | null {
  const [adresse = "", prefixe, ...reste] = texte.trim().split("/");
  if (reste.length || !IPV4.test(adresse)) return null;
  if (prefixe !== undefined && (!/^\d{1,2}$/.test(prefixe) || Number(prefixe) > 32)) return null;
  const n = prefixe === undefined ? 32 : Number(prefixe);
  const valeur = adresse.split(".").reduce((v, o) => v * 256 + Number(o), 0);
  const reseau = valeur - (valeur % 2 ** (32 - n));
  const texteReseau = [24, 16, 8, 0].map((d) => Math.floor(reseau / 2 ** d) % 256).join(".");
  return n === 32 ? texteReseau : `${texteReseau}/${n}`;
}

/** Ports TCP que reçoit le conteneur : ceux de la liste valides, aucun sous « Tous ». */
function portsEffectifs(p: ProfilVu): string[] {
  if (p._portsMode === "all") return [];
  return textes(p.ports).filter((x) => /^\d{1,5}$/.test(x) && Number(x) >= 1 && Number(x) <= 65535);
}

/** Destinations listées, relues comme le serveur : IPv4 en forme enregistrée, résolveurs IPv4 ; des ports demandés dont aucun n'est valide ferment le profil. */
function listeLue(p: ProfilVu): { ips: string[]; domaines: string[]; dns: string[] } {
  const ferme = p._portsMode !== "all" && textes(p.ports).length > 0 && portsEffectifs(p).length === 0;
  return {
    ips: ferme ? [] : [...new Set(textes(p.ips).map(ipv4Canonique))].filter((x): x is string => x !== null),
    domaines: ferme ? [] : textes(p.domains).map((d) => d.toLowerCase().replace(/\.+$/, "")),
    dns: textes(p.dns).filter((x) => IPV4.test(x)),
  };
}

/** Adresses que relève un domaine : une liste (vide si le nom est introuvable), `null` sans réponse à temps, `undefined` s'il n'a pas encore de relevé. */
function adressesDe(ctx: ContexteVue, dom: string): readonly string[] | null | undefined {
  return Object.hasOwn(ctx.domaines, dom) ? ctx.domaines[dom] : undefined;
}

/** Domaines du profil sans adresse en ce moment (introuvables, ou sans réponse à temps). */
export function domainesSansAdresse(p: ProfilVu, ctx: ContexteVue): string[] {
  if (p.mode !== "allowlist_ip") return [];
  return listeLue(p).domaines.filter((d) => {
    const ips = adressesDe(ctx, d);
    return ips === null || (ips !== undefined && ips.length === 0);
  });
}

/** Résolveurs que reçoit le conteneur d'une liste blanche (`--dns`) : ceux du profil, sinon le résolveur de garde. */
export function resolveursConteneur(p: ProfilVu): string[] {
  if (p.mode !== "allowlist_ip") return [];
  const dns = listeLue(p).dns;
  return dns.length ? dns : [DNS_DE_GARDE];
}

/** Noms épinglés dans /etc/hosts du conteneur (`--add-host`) : la première adresse relevée de chaque domaine. */
export function hotesEpingles(p: ProfilVu, ctx: ContexteVue): string[] {
  if (p.mode !== "allowlist_ip") return [];
  return listeLue(p).domaines.flatMap((d) => {
    const ips = adressesDe(ctx, d);
    return ips?.length ? [`${d}:${ips[0]}`] : [];
  });
}

/** Plages refusées par les protections cochées et les protections qui refusent chacune ; « hôte » sans adresse de la machine : `null`, ou ses seules diffusions avec `sansMachine`. */
function originesPlages(
  protections: readonly CleProtection[],
  machine: MachineVue | null,
  sansMachine = false,
): Map<string, string[]> | null {
  const plages = new Map<string, string[]>();
  const noter = (plage: string, libelle: string): void => {
    const l = plages.get(plage) ?? [];
    if (!l.includes(libelle)) l.push(libelle);
    plages.set(plage, l);
  };
  for (const [cle, , libelle] of PROTECTIONS) {
    if (!protections.includes(cle)) continue;
    if (cle === "metadata") for (const x of PLAGES_METADONNEES) noter(x, libelle);
    else if (cle === "lan") for (const x of PLAGES_LOCALES) noter(x, libelle);
    else {
      const releve = machine?.addresses.length ? machine : null;
      if (releve === null && !sansMachine) return null;
      for (const ip of releve === null ? [] : [...releve.addresses, ...releve.broadcasts])
        noter(`${ip}/32`, libelle);
      for (const x of DIFFUSIONS_HOTE) noter(x, libelle);
    }
  }
  return plages;
}

/** Réseaux IPv4 refusés par les protections, triés sans doublon (`plagesRefusees`) ; `null` si la protection « hôte » n'a aucune adresse de la machine. */
export function plagesRefusees(
  protections: readonly CleProtection[],
  machine: MachineVue | null,
): string[] | null {
  const plages = originesPlages(protections, machine);
  return plages === null ? null : [...plages.keys()].sort(parPointsDeCode);
}

/** Règles que recevrait une sandbox du profil créée maintenant : entrée d'iptables-restore et appels d'ip6tables du script de démarrage. */
export function reglesPosees(p: ProfilVu, ctx: ContexteVue): ReglesVues {
  return construireRegles(p, ctx, false);
}

/** `reglesPosees` ; avec `sansMachine`, la protection « hôte » sans relevé garde ses seules diffusions (chaîne qu'évalue la vue). */
function construireRegles(p: ProfilVu, ctx: ContexteVue, sansMachine: boolean): ReglesVues {
  const liste = p.mode === "allowlist_ip";
  if (!liste && p.mode !== "bridge") return { genre: "sans-reseau" };
  const protections = protectionsVues(p);
  if (!liste && protections.length === 0) return { genre: "sans-filtre" };
  const ipv4 = [...ENTETE_IPV4];
  const causes: Record<string, string> = {};
  const poser = (ligne: string, cause: string | null): void => {
    ipv4.push(ligne);
    if (cause !== null) causes[ligne] = cause;
  };
  const inconnus: string[] = [];
  if (liste) {
    const lue = listeLue(p);
    for (const ip of lue.dns) {
      poser(`-A OUTPUT -d ${ip} -p udp --dport 53 -j ACCEPT`, RESOLVEUR);
      poser(`-A OUTPUT -d ${ip} -p tcp --dport 53 -j ACCEPT`, RESOLVEUR);
    }
    const ports = portsEffectifs(p);
    const paquets: string[] = [];
    for (let i = 0; i < ports.length; i += PORTS_PAR_REGLE)
      paquets.push(ports.slice(i, i + PORTS_PAR_REGLE).join(","));
    const permis = new Map<string, string>(lue.ips.map((ip) => [ip, LISTE]));
    for (const dom of lue.domaines) {
      const ips = adressesDe(ctx, dom);
      if (ips === undefined) inconnus.push(dom);
      else for (const ip of ips ?? []) if (!permis.has(ip)) permis.set(ip, `le domaine ${dom}`);
    }
    for (const [ip, cause] of permis) {
      if (!paquets.length) poser(`-A OUTPUT -d ${ip} -j ACCEPT`, cause);
      for (const q of paquets) poser(`-A OUTPUT -d ${ip} -p tcp -m multiport --dports ${q} -j ACCEPT`, cause);
    }
    poser(`-A OUTPUT ${REFUS_IPV4}`, null);
  } else {
    const origines = originesPlages(protections, ctx.machine, sansMachine);
    if (origines === null) return { genre: "machine-inconnue" };
    for (const n of [...origines.keys()].sort(parPointsDeCode))
      poser(`-A OUTPUT -d ${n} ${REFUS_IPV4}`, enumerer(origines.get(n) ?? []));
    poser("-A OUTPUT -j ACCEPT", null);
  }
  ipv4.push("COMMIT");
  return { genre: "regles", ipv4, ipv6: [...IPV6], inconnus, causes };
}

/** Texte montré et copié : l'entrée d'iptables-restore, puis les appels d'ip6tables. */
export function texteRegles(r: { ipv4: readonly string[]; ipv6: readonly string[] }): string {
  return [...r.ipv4, "", "# IPv6 : tout refusé", ...r.ipv6.map((l) => `ip6tables ${l}`)].join("\n");
}

// ── Évaluateur de la chaîne OUTPUT ──────────────────────────────────────────

interface Plage {
  base: number;
  taille: number;
}
/** Une règle qui juge une nouvelle connexion : destination (`null` : toutes), protocole et ports (`null` : tous), cible, origine (`""` : règle finale). */
interface RegleLue {
  d: Plage | null;
  dest: string;
  passe: string | null;
  accepte: boolean;
  cause: string;
}
interface Chaine {
  regles: RegleLue[];
  politiqueAccepte: boolean;
}
/** Jugement d'une plage : la règle qui en décide (ou la politique), ce qui passe sur certains ports avant elle, et les sous-plages ouvertes ou refusées avant elle. */
interface Issue {
  accepte: boolean;
  cause: string;
  dest: string;
  passes: RegleLue[];
  ouvertes: RegleLue[];
  fermees: RegleLue[];
}

const RE_REGLE =
  /^-A OUTPUT(?: -d (\S+))?(?: -p (tcp|udp)(?: --dport (\d+)| -m multiport --dports (\S+)))? -j (ACCEPT|REJECT)\b/;

/** Plage d'une adresse ou d'un réseau IPv4 ; `null` sinon. */
function plageDe(texte: string): Plage | null {
  const c = ipv4Canonique(texte);
  if (c === null) return null;
  const [adresse = "", n = "32"] = c.split("/");
  return { base: adresse.split(".").reduce((v, o) => v * 256 + Number(o), 0), taille: 2 ** (32 - Number(n)) };
}

const contient = (a: Plage, b: Plage): boolean => b.base >= a.base && b.base + b.taille <= a.base + a.taille;

/** Règles qui jugent une nouvelle connexion (boucle et connexions établies écartées), dans l'ordre, et la politique. */
function lireChaine(r: Extract<ReglesVues, { genre: "regles" }>): Chaine {
  const regles: RegleLue[] = [];
  for (const ligne of r.ipv4) {
    const m = RE_REGLE.exec(ligne);
    if (!m) continue;
    const [, dest, proto, port, ports, cible] = m;
    const d = dest === undefined ? null : plageDe(dest);
    if (dest !== undefined && d === null) continue;
    regles.push({
      d,
      dest: sansMasque(dest ?? ""),
      passe:
        proto === undefined ? null : `${proto.toUpperCase()} ${(port ?? ports ?? "").split(",").join(", ")}`,
      accepte: cible === "ACCEPT",
      cause: r.causes[ligne] ?? "",
    });
  }
  return { regles, politiqueAccepte: !r.ipv4.includes(":OUTPUT DROP [0:0]") };
}

/** Première règle sans restriction de port qui couvre la plage, sinon la politique ; avec `sousPlages`, les règles plus étroites rencontrées avant comptent aussi. */
function evaluer(u: Plage, c: Chaine, sousPlages: boolean): Issue {
  const vu: Pick<Issue, "passes" | "ouvertes" | "fermees"> = { passes: [], ouvertes: [], fermees: [] };
  for (const r of c.regles) {
    if (r.d === null || contient(r.d, u)) {
      if (r.passe === null) return { ...vu, accepte: r.accepte, cause: r.cause, dest: r.dest };
      if (r.accepte) vu.passes.push(r);
    } else if (sousPlages && contient(u, r.d)) (r.accepte ? vu.ouvertes : vu.fermees).push(r);
  }
  return { ...vu, accepte: c.politiqueAccepte, cause: "", dest: "" };
}

/** Protocoles et ports qui passent, réunis par protocole (« UDP 53, TCP 53 »). */
function fusion(regles: readonly RegleLue[]): string {
  const parProto = new Map<string, string[]>();
  for (const r of regles) {
    const [proto = "", ...reste] = (r.passe ?? "").split(" ");
    parProto.set(proto, [...(parProto.get(proto) ?? []), ...reste.join(" ").split(", ")]);
  }
  return [...parProto].map(([proto, ports]) => `${proto} ${[...new Set(ports)].join(", ")}`).join(", ");
}

/** Chaîne qu'évalue la vue : celle du profil ; sans relevé de la machine, la protection « hôte » n'y garde que ses diffusions (la ligne « Machine hôte » le dit). */
function chaineDe(p: ProfilVu, ctx: ContexteVue): Chaine {
  const r = construireRegles(p, ctx, true);
  return r.genre === "regles" ? lireChaine(r) : { regles: [], politiqueAccepte: r.genre === "sans-filtre" };
}

/** Verdict d'une plage dans la chaîne : tout passe, une partie des ports passe (et lesquels), rien ne passe. */
function juger(texte: string, c: Chaine): { verdict: Verdict; passe: string } {
  const u = plageDe(texte);
  const i = u === null ? null : evaluer(u, c, false);
  if (i?.accepte) return { verdict: "ok", passe: "tous" };
  return i?.passes.length ? { verdict: "partiel", passe: fusion(i.passes) } : { verdict: "refus", passe: "" };
}

/** Verdict d'une adresse ou d'un réseau pour une sandbox du profil, tiré des règles posées : autorisé, partiel (ports qui passent) ou refusé. */
export function jugerAdresse(
  p: ProfilVu,
  ctx: ContexteVue,
  cible: string,
): { verdict: Verdict; passe: string } {
  return juger(cible, chaineDe(p, ctx));
}

/** Catégorie de destinations jugée par des plages représentatives ; `accord` : terminaison des participes accordés à son nom. */
interface Categorie {
  cle: string;
  nom: string;
  icone: string;
  unites: readonly string[];
  sousPlages: boolean;
  accord: "" | "e" | "es";
  /** Textes d'un accès entièrement ouvert, et entièrement refusé, par la règle finale. */
  ouvert: string;
  ferme: string;
  protection: string;
  sensible: boolean;
}

/** Ligne d'une catégorie : chaque plage jugée par la chaîne, puis le verdict d'ensemble, ce qui passe et ce qui est refusé, avec leur cause. */
function ligneCategorie(cat: Categorie, c: Chaine): LigneVue {
  const passe = new Map<string, Map<string, RegleLue[] | null>>();
  const refus = new Map<string, string[]>();
  let restePorts = true;
  const ouvrir = (cause: string, dest: string, r: RegleLue | null): void => {
    const m = passe.get(cause) ?? new Map<string, RegleLue[] | null>();
    const deja = m.get(dest);
    m.set(dest, r === null || r.passe === null || deja === null ? null : [...(deja ?? []), r]);
    passe.set(cause, m);
  };
  const refuser = (cause: string, item: string): void => {
    const l = refus.get(cause) ?? [];
    if (!l.includes(item)) l.push(item);
    refus.set(cause, l);
  };
  for (const texte of cat.unites) {
    const u = plageDe(texte);
    if (u === null) continue;
    const nom = sansMasque(texte);
    const i = evaluer(u, c, cat.sousPlages);
    if (i.accepte) {
      ouvrir(i.cause, i.dest || nom, null);
      for (const f of i.fermees) refuser(f.cause, f.dest);
      continue;
    }
    for (const r of [...i.passes, ...i.ouvertes]) ouvrir(r.cause, r.dest, r);
    if (i.cause === "" && !i.passes.length) restePorts = false;
    refuser(i.cause, nom);
  }
  const verdict: Verdict = passe.size === 0 ? "refus" : refus.size === 0 ? "ok" : "partiel";
  const e = cat.accord;
  const s = e === "es" ? "s" : "";
  const items = (m: Map<string, RegleLue[] | null>): string =>
    [...m].map(([dest, regles]) => (regles === null ? dest : `${dest} (${fusion(regles)})`)).join(", ");
  const ouvertPar = ([cause, m]: [string, Map<string, RegleLue[] | null>]): string =>
    `${cause === "" ? `joignable${s}` : cause === RESOLVEUR ? RESOLVEUR : `autorisé${e} par ${cause}`} : ${items(m)}`;
  const refusePar = ([cause, l]: [string, string[]]): string =>
    cause === ""
      ? restePorts
        ? "autres ports et protocoles refusés"
        : "le reste hors liste"
      : `refusé${e} par ${cause} : ${l.join(", ")}`;
  const nbRefus = [...refus.values()].reduce((t, l) => t + l.length, 0);
  const nbPasse = [...passe.values()].reduce((t, m) => t + m.size, 0);
  let detail: string;
  if (verdict === "ok")
    detail = passe.size === 1 && passe.has("") ? cat.ouvert : [...passe].map(ouvertPar).join(" ; ");
  else if (verdict === "refus")
    detail = refus.size === 1 && refus.has("") ? cat.ferme : texteRefus(cat, refus);
  else if (passe.size === 1 && passe.has("") && !refus.has("") && nbRefus < nbPasse)
    detail = `joignable${s}, sauf ${[...refus].map(([cause, l]) => `${l.join(", ")} (refus par ${cause})`).join(", ")}`;
  else detail = [...[...passe].map(ouvertPar), ...[...refus].map(refusePar)].join(" ; ");
  return {
    cle: cat.cle,
    nom: cat.nom,
    verdict,
    detail,
    icone: cat.icone,
    ports: verdict === "ok" ? "tous" : "",
    risque: cat.sensible && verdict !== "refus",
  };
}

/** Refus entier par des protections : celle de la catégorie si elle couvre tout, sinon toutes celles en jeu ; « Machine hôte » compte ses adresses. */
function texteRefus(cat: Categorie, refus: ReadonlyMap<string, string[]>): string {
  const causes = [...refus.keys()];
  const noms =
    cat.protection !== "" && causes.every((c) => c.includes(cat.protection))
      ? [cat.protection]
      : PROTECTIONS.map(([, , libelle]) => libelle).filter((l) => causes.some((c) => c.includes(l)));
  const par = `par ${enumerer(noms)}`;
  if (cat.cle !== "hote") return `refusé${cat.accord} ${par}`;
  const n = cat.unites.length;
  const diffusions = noms.includes("Machine hôte") ? ", diffusion et multidiffusion aussi" : "";
  return `${pluriel(n, "adresse")} de la machine, ${n > 1 ? "refusées" : "refusée"} ${par}${diffusions}`;
}

/** Destinations vues d'une sandbox du profil : verdicts tirés des règles posées (autorisé, partiel, refusé), domaines sans adresse (inactif), relais de l'hôte. */
export function destinationsVues(p: ProfilVu, ctx: ContexteVue): LigneVue[] {
  const lignes: LigneVue[] = [];
  const ajouter = (l: Omit<LigneVue, "ports" | "risque"> & Partial<LigneVue>): void =>
    void lignes.push({ ports: "", risque: false, ...l });
  const liste = p.mode === "allowlist_ip";
  if (liste || p.mode === "bridge") {
    const c = chaineDe(p, ctx);
    if (liste) lignesListe(p, ctx, c, ajouter);
    const releve = ctx.machine?.addresses ?? [];
    const cat = (
      cle: string,
      nom: string,
      icone: string,
      unites: readonly string[],
      accord: Categorie["accord"],
      ouvert: string,
    ): Categorie => ({
      cle,
      nom,
      icone,
      unites,
      sousPlages: cle !== "internet",
      accord,
      ouvert,
      ferme: cle === "internet" ? "tout ce qui n'est pas listé" : "hors liste",
      protection: cle === "internet" ? "" : nom,
      sensible: cle !== "internet",
    });
    const internet = cat(
      "internet",
      liste ? "Reste d'internet" : "Internet",
      "ph-globe-hemisphere-west",
      ["0.0.0.0/0"],
      "",
      "destinations publiques",
    );
    const metadonnees = cat(
      "metadonnees",
      "Métadonnées du cloud",
      "ph-cloud",
      PLAGES_METADONNEES,
      "es",
      "joignables : jetons de la machine exposés",
    );
    const lan = cat("lan", "Réseau local", "ph-house-line", PLAGES_LOCALES, "", "joignable");
    const hote = cat("hote", "Machine hôte", "ph-desktop-tower", releve, "e", "ports de l'hôte joignables");
    for (const x of liste ? [internet, lan, hote, metadonnees] : [internet, metadonnees, lan, hote])
      lignes.push(x === hote && releve.length === 0 ? ligneHoteSansReleve(p, ctx, x) : ligneCategorie(x, c));
  } else
    ajouter({
      cle: "tout",
      nom: "Toutes destinations",
      verdict: "refus",
      detail: "aucune interface réseau (--network none)",
      icone: "ph-prohibit",
    });
  ajouter({
    cle: "sandboxes",
    nom: "Autres sandboxes",
    verdict: "refus",
    detail:
      liste || p.mode === "bridge"
        ? `trafic entre sandboxes coupé par le réseau ${RESEAU_BACS}, quelles que soient les règles`
        : "trafic entre sandboxes coupé",
    icone: "ph-cube",
  });
  const serveurs = p.git_servers ?? [];
  const sansServeur = p.git_access === "servers" && serveurs.length === 0;
  const git =
    p.git_access === "servers"
      ? sansServeur
        ? "aucun serveur listé, tout refusé"
        : serveurs.join(", ")
      : p.git_access === "accounts"
        ? "dépôts des comptes Git de chaque utilisateur"
        : "tous les dépôts";
  ajouter({
    cle: "git",
    nom: "Dépôts Git",
    verdict: sansServeur ? "refus" : "relais",
    detail: `par le relais Git de l'hôte : ${git}`,
    icone: "ph-git-branch",
  });
  const navigateur = liste
    ? "mêmes destinations que la liste"
    : p.mode !== "bridge"
      ? "sites de la sandbox (localhost) seulement"
      : protectionsVues(p).length
        ? "protections du profil appliquées, sans IPv6"
        : "internet et réseau local (liste du navigateur)";
  ajouter({
    cle: "navigateur",
    nom: "Navigateur",
    verdict: "relais",
    detail: `par le relais du navigateur : ${navigateur}`,
    icone: "ph-browser",
  });
  return lignes;
}

/** Lignes propres à une liste blanche : adresses et réseaux listés, domaines, résolveurs ; une entrée listée est autorisée sur les ports qui passent. */
function lignesListe(
  p: ProfilVu,
  ctx: ContexteVue,
  c: Chaine,
  ajouter: (l: Omit<LigneVue, "ports" | "risque"> & Partial<LigneVue>) => void,
): void {
  const lue = listeLue(p);
  const entree = (ip: string): { verdict: Verdict; ports: string } => {
    const j = juger(ip, c);
    return { verdict: j.verdict === "refus" ? "refus" : "ok", ports: j.passe };
  };
  for (const ip of lue.ips)
    ajouter({
      cle: `ip:${ip}`,
      nom: ip,
      ...entree(ip),
      detail: ip.includes("/") ? "réseau autorisé" : "adresse autorisée",
      icone: "ph-hard-drives",
    });
  const ports = portsEffectifs(p);
  const portsPrevus = ports.length ? `TCP ${ports.join(", ")}` : "tous";
  const attente: Readonly<Record<EtatServeur, string>> = {
    attente: "résolution en cours",
    echec: "résolution indisponible : adresses relevées à la création",
    charge: "adresses relevées à l'enregistrement du profil",
  };
  for (const dom of new Set(lue.domaines)) {
    const adresses = adressesDe(ctx, dom);
    const ligne = { cle: `dom:${dom}`, nom: dom, icone: "ph-globe" };
    if (adresses === undefined)
      ajouter({ ...ligne, verdict: "ok", ports: portsPrevus, detail: attente[ctx.etat] });
    else if (adresses === null)
      ajouter({
        ...ligne,
        verdict: "inactif",
        detail: "pas de réponse DNS en 3 s : la création attend plus longtemps et peut l'épingler",
      });
    else if (adresses.length === 0)
      ajouter({
        ...ligne,
        verdict: "inactif",
        detail: "nom introuvable : une sandbox créée maintenant ne le joindrait pas",
      });
    else {
      const [premiere = "", ...autres] = adresses;
      const aussi = autres.length
        ? `, ${autres.join(", ")} ${autres.length > 1 ? "autorisées" : "autorisée"} aussi`
        : "";
      ajouter({ ...ligne, ...entree(premiere), detail: `${premiere} épinglée${aussi}` });
    }
  }
  for (const ip of new Set(lue.dns))
    ajouter({ cle: `dns:${ip}`, nom: ip, ...entree(ip), detail: RESOLVEUR, icone: "ph-signpost" });
  if (!lue.dns.length)
    ajouter({
      cle: "noms",
      nom: "Autres noms",
      verdict: "refus",
      detail: "aucun résolveur : seuls les domaines listés ont une adresse",
      icone: "ph-signpost",
    });
}

/** « Machine hôte » sans adresse relevée : refusée si sa protection est cochée (la sandbox ne démarrerait pas sans relevé) ; sinon la règle finale, relevé signalé manquant. */
function ligneHoteSansReleve(p: ProfilVu, ctx: ContexteVue, cat: Categorie): LigneVue {
  const etat =
    ctx.etat === "attente"
      ? "adresses de la machine en cours de lecture"
      : ctx.machine === null
        ? "relevé de la machine indisponible"
        : "aucune adresse de la machine relevée";
  const ligne = { cle: cat.cle, nom: cat.nom, icone: cat.icone };
  if (protectionsVues(p).includes("host"))
    return {
      ...ligne,
      verdict: "refus",
      detail:
        ctx.etat === "charge" && ctx.machine !== null ? `${etat} : la sandbox ne démarrerait pas` : etat,
      ports: "",
      risque: false,
    };
  if (p.mode === "allowlist_ip")
    return {
      ...ligne,
      verdict: "refus",
      detail: `hors liste, sauf adresse listée qui la couvre (${etat})`,
      ports: "",
      risque: false,
    };
  return { ...ligne, verdict: "ok", detail: `${cat.ouvert} (${etat})`, ports: "tous", risque: true };
}

/** Boîte « Sandbox du profil » du graphe : sudo et interface réseau. */
export function sourceVue(p: ProfilVu, ctx: ContexteVue): { sudo: string; reseau: string } {
  const sansReseau = p.mode !== "allowlist_ip" && p.mode !== "bridge";
  return {
    sudo: profilDurci(p, ctx.sudo) ? "sans sudo · lecture seule" : "sudo permis",
    reseau: sansReseau ? "sans interface réseau" : `réseau ${RESEAU_BACS}`,
  };
}
