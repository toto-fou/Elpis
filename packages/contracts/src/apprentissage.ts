// SPDX-License-Identifier: MIT
/** packages/contracts/src/apprentissage.ts — apprentissage des procédures : gestes navigateur réussis d'une conversation ou d'un enregistrement du recorder → brouillon (gestes retenus, écartés, paramètres suggérés) → procédure NON approuvée validée par `validerProcedure` ; logique pure, partagée par le core et l'hôte d'outils. */
import { refusCible, refusUrl, validerProcedure } from "./procedures";
import type { Act, Noeud, Procedure, ResultatProcedure } from "./procedures";

type Dict = Record<string, unknown>;
const estDict = (x: unknown): x is Dict => x !== null && typeof x === "object" && !Array.isArray(x);

const VERBES: Readonly<Record<string, Act["act"]>> = {
  goto: "goto",
  click: "click",
  fill: "fill",
  type: "fill",
  press: "press",
  select: "select",
  select_option: "select",
  check: "check",
  uncheck: "uncheck",
  hover: "hover",
};

/** Résultat de `chaineVersSeq`. */
export interface ConversionChaine {
  /** `null` si une étape ne se convertit pas (voir `erreurs`). */
  readonly root: Noeud | null;
  /** Paramètres `string` déclarés par `options.parametres`, à reprendre dans `Procedure.params`. */
  readonly params: Record<string, "string">;
  readonly erreurs: string[];
}

/** Étapes `pw_chain` réussies → `{seq:[act…]}` : cibles sémantiques seulement, `goto` sur `origin`, `options.parametres` ({nom: valeur}) remplace les valeurs par `{nom}` ; à valider ensuite avec `validerProcedure`. */
export function chaineVersSeq(
  etapes: readonly unknown[],
  origin: string,
  options: {
    parametres?: Readonly<Record<string, string>>;
    /** Fusion `target` / `selector` du service navigateur (`mergeTarget` de `@elpis/navigateur`). */
    fusionnerCible: (target: string, selector: string) => string;
  },
): ConversionChaine {
  const erreurs: string[] = [];
  const params: Record<string, "string"> = {};
  const gabarit = (s: string): string => {
    let sortie = s;
    for (const [nom, valeur] of Object.entries(options.parametres ?? {}))
      if (valeur !== "" && sortie.includes(valeur)) {
        sortie = sortie.split(valeur).join(`{${nom}}`);
        params[nom] = "string";
      }
    return sortie;
  };
  const seq: Act[] = [];
  etapes.forEach((brute, i) => {
    if (!estDict(brute)) {
      erreurs.push(`étape ${i} : objet attendu`);
      return;
    }
    const e: Dict = brute;
    const verbe = String(e["do"] || e["type"] || e["action"] || "");
    const act = VERBES[verbe];
    if (act === undefined) {
      erreurs.push(`étape ${i} : geste ${verbe || "(absent)"} non convertible`);
      return;
    }
    if (e["secret"]) {
      erreurs.push(`étape ${i} : secret refusé`);
      return;
    }
    const noeud: Act = { act };
    if (act === "goto") {
      const brut = String(e["url"] ?? "");
      let relatif = brut;
      if (!brut.startsWith("/")) {
        try {
          const u = new URL(brut);
          relatif = u.origin === origin ? `${u.pathname}${u.search}` : brut;
        } catch {
          relatif = brut;
        }
      }
      const r = refusUrl(relatif, origin);
      if (r !== null) erreurs.push(`étape ${i} : ${r}`);
      else noeud.url = gabarit(relatif);
    } else {
      const cible = options.fusionnerCible(String(e["target"] ?? ""), String(e["selector"] ?? ""));
      if (act !== "press" || cible !== "") {
        const r = refusCible(cible);
        if (r !== null) {
          erreurs.push(`étape ${i} : ${r}`);
          return;
        }
        noeud.t = [gabarit(cible)];
      }
      const valeur = String(e["v"] ?? e["value"] ?? e["key"] ?? e["text"] ?? "");
      if (valeur !== "") noeud.v = gabarit(valeur);
    }
    seq.push(noeud);
  });
  if (seq.length === 0 && erreurs.length === 0) erreurs.push("aucune étape");
  return { root: erreurs.length === 0 ? { seq } : null, params, erreurs };
}

/** Appel d'outil navigateur de la conversation, dans l'ordre : arguments et résultat déjà décodés (`null` si illisible). */
export interface AppelNavigateur {
  readonly outil: string;
  readonly args: Dict;
  readonly resultat: unknown;
}

export interface Ecarte {
  readonly raison: string;
  readonly quoi: string;
}

/** Paramètre suggéré : valeur littérale d'un geste (`v` ou requête d'un `goto`) que l'utilisateur peut transformer en `{nom}`. */
export interface ParamSuggere {
  readonly nom: string;
  readonly valeur: string;
  readonly noeuds: readonly number[];
  readonly champ: "v" | "url";
}

export type NoeudBrouillon =
  | {
      readonly id: number;
      readonly genre: "act";
      readonly act: Act;
      readonly source: string;
      readonly effet: boolean;
      /** `confirm: true` proposé par défaut (dernier geste à effet) : l'utilisateur ajuste. */
      readonly confirmSuggere: boolean;
    }
  | {
      readonly id: number;
      readonly genre: "login";
      readonly source: string;
      readonly username_target?: string;
      readonly password_target?: string;
      readonly submit_target?: string;
      /** Absent : à compléter par l'utilisateur (jamais deviné). */
      readonly wait_for?: string;
      readonly confirmSuggere: false;
    };

export interface Brouillon {
  readonly origin: string;
  /** Origines rencontrées et nombre de gestes candidats (l'origine retenue est la plus fournie, ou celle demandée). */
  readonly origines: readonly { readonly origin: string; readonly gestes: number }[];
  readonly noeuds: readonly NoeudBrouillon[];
  readonly params: readonly ParamSuggere[];
  readonly ecartes: readonly Ecarte[];
}

const EFFETS_APPRIS: ReadonlySet<string> = new Set(["click", "press", "fill", "select", "check", "uncheck"]);
const COMPOSANTES = ["role", "name", "text", "label", "placeholder", "test_id", "alt", "title"] as const;
const SECRET_PRESUME =
  /pass(?:word|wd|phrase|code)?(?![a-z])|passw|pwd|mot.?de.?passe|(?<![a-z])otp(?![a-z])|totp|2fa|mfa|token|secret|api.?key|(?<![a-z])(?:pin|cvc|cvv)(?![a-z])/iu;

const texte = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" ? String(x) : "");
const echappe = (v: string): string =>
  v.replace(
    /\|(?=\s*(?:role|name|text|label|placeholder|test_id|alt|title|css|xpath|ref|nth)\s*=)/giu,
    "\\|",
  );

/** Cible DSL d'un appel `pw_act` : `target` tel quel, sinon les composantes sémantiques (`role`, `name`…) ; css/xpath/ref : cible non sémantique. */
function cibleDeLArgs(a: Dict, fusion: (t: string, s: string) => string): string {
  const brute = fusion(texte(a["target"]), texte(a["selector"]));
  if (brute !== "") return brute;
  const morceaux = COMPOSANTES.filter((k) => texte(a[k]) !== "").map((k) => `${k}=${echappe(texte(a[k]))}`);
  if (morceaux.length > 0) return morceaux.join("|");
  for (const k of ["css", "xpath", "ref"]) if (texte(a[k]) !== "") return `${k}=${texte(a[k])}`;
  return "";
}

function origineDe(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
}
const cheminDe = (u: string): string => {
  try {
    return new URL(u).pathname;
  } catch {
    return "";
  }
};

function reussi(r: unknown): { ok: boolean; raison: string } {
  if (!estDict(r)) return { ok: false, raison: "résultat illisible" };
  const code = texte(r["code"]) || texte(r["error"]);
  if (
    /ambig/iu.test(JSON.stringify(r).slice(0, 4000)) &&
    (r["success"] === false || r["ok"] === false || code !== "")
  )
    return { ok: false, raison: "geste ambigu" };
  if (
    r["ok"] === false ||
    r["success"] === false ||
    code !== "" ||
    ["error", "failed", "fail"].includes(texte(r["status"]))
  )
    return { ok: false, raison: `échec${code ? ` (${code})` : ""}` };
  return {
    ok: r["status"] === "success" || r["ok"] === true || r["success"] === true,
    raison: "résultat non confirmé",
  };
}

function slug(s: string, secours: string): string {
  const base = s
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 20);
  return /^[a-z]/u.test(base) ? base : secours;
}

/** Nom suggéré d'un paramètre d'après la cible du geste (`label=Montant` → `montant`). */
function nomSuggere(cible: string, secours: string): string {
  const m = /(?:label|name|placeholder|test_id|title|text)=([^|]+)/iu.exec(cible);
  return slug(m?.[1] ?? "", secours);
}

interface Candidat {
  readonly act?: Act;
  readonly login?: {
    username_target?: string;
    password_target?: string;
    submit_target?: string;
    wait_for?: string;
  };
  readonly source: string;
  readonly origin: string;
}

/** Brouillon d'après les appels navigateur d'une conversation (ordre chronologique) : gestes réussis d'UNE origine ; `pw_run` écarté (ses gestes appartiennent déjà à une procédure). */
export function brouillonDepuisConversation(
  appels: readonly AppelNavigateur[],
  options: { origin?: string; fusionnerCible: (t: string, s: string) => string },
): Brouillon {
  const ecartes: Ecarte[] = [];
  const candidats: Candidat[] = [];
  const pages = new Map<string, string>();
  const pageDe = (sid: string): string => pages.get(sid) ?? "";
  const majPage = (sid: string, r: unknown): void => {
    const u = estDict(r) ? texte(r["url"]) || texte(r["current_url"]) : "";
    if (u !== "") pages.set(sid, u);
  };
  const noter = (raison: string, quoi: string): void =>
    void ecartes.push({ raison, quoi: quoi.slice(0, 120) });
  for (const a of appels) {
    const sid = texte(a.args["session_id"]);
    if (a.outil === "pw_session") {
      if (texte(a.args["action"] ?? a.args["do"]) !== "start") continue;
      const r = reussi(a.resultat);
      const sidR = estDict(a.resultat) ? texte(a.resultat["session_id"]) || sid : sid;
      const url = texte(a.args["url"]);
      if (!r.ok) {
        noter(`ouverture de session : ${r.raison}`, url);
        continue;
      }
      majPage(sidR, a.resultat);
      if (!pageDe(sidR) && url !== "") pages.set(sidR, url);
      if (url !== "")
        candidats.push({ act: gotoObserve(url, a.resultat), source: "pw_session", origin: origineDe(url) });
    } else if (a.outil === "pw_act") {
      const verbe = texte(a.args["do"] ?? a.args["action"] ?? a.args["op"]);
      const brut = traiterGeste(verbe, a.args, a.resultat, pageDe(sid), options.fusionnerCible);
      if (brut === "ignore") continue;
      if ("ecarte" in brut)
        noter(brut.ecarte, `${verbe} ${texte(a.args["target"]) || texte(a.args["name"])}`);
      else candidats.push({ act: brut.act, source: "pw_act", origin: brut.origin });
      if (!("ecarte" in brut)) majPage(sid, a.resultat);
    } else if (a.outil === "pw_chain") {
      const actions = Array.isArray(a.args["actions"]) ? a.args["actions"] : [];
      const res = estDict(a.resultat) && Array.isArray(a.resultat["results"]) ? a.resultat["results"] : [];
      actions.forEach((etape, i) => {
        const e = estDict(etape) ? etape : {};
        const verbe = texte(e["action"] ?? e["do"] ?? e["type"]);
        const rr = res[i];
        const ok = estDict(rr) && rr["success"] === true;
        if (!ok) {
          if (rr !== undefined || verbe !== "")
            noter(
              estDict(rr) && texte(rr["code"])
                ? `échec (${texte(rr["code"])})`
                : "étape non exécutée ou en échec",
              `${verbe} ${texte(e["target"])}`,
            );
          return;
        }
        // Conversion pure partagée avec l'outil : une étape à la fois, sur l'origine de la page courante de la session.
        const origin = origineDe(pageDe(sid));
        if (origin === "" && verbe !== "goto") {
          noter("page courante inconnue", `${verbe} ${texte(e["target"])}`);
          return;
        }
        const conv = chaineVersSeq([e], origin, { fusionnerCible: options.fusionnerCible });
        const act = conv.root !== null && "seq" in conv.root ? conv.root.seq[0] : undefined;
        if (act === undefined || !("act" in act)) {
          if (!/non convertible/u.test(conv.erreurs.join("")))
            noter(conv.erreurs.join(" ; ") || "étape non convertible", `${verbe} ${texte(e["target"])}`);
          return;
        }
        if (act.act === "fill" && SECRET_PRESUME.test(act.t?.[0] ?? "")) {
          noter("champ présumé secret : valeur jamais gardée", `${verbe} ${texte(e["target"])}`);
          return;
        }
        candidats.push({
          act,
          source: "pw_chain",
          origin: act.act === "goto" && !(act.url ?? "").startsWith("/") ? origineDe(act.url ?? "") : origin,
        });
      });
      majPage(
        sid,
        estDict(a.resultat) && estDict(a.resultat["page_after"]) ? a.resultat["page_after"] : a.resultat,
      );
    } else if (a.outil === "pw_login") {
      const r = reussi(a.resultat);
      const wait = texte(a.args["wait_for"]);
      const page = pageDe(sid);
      if (!r.ok) {
        noter(`connexion : ${r.raison}`, "pw_login");
        continue;
      }
      const login = {
        ...(texte(a.args["username_target"]) ? { username_target: texte(a.args["username_target"]) } : {}),
        ...(texte(a.args["password_target"]) ? { password_target: texte(a.args["password_target"]) } : {}),
        ...(texte(a.args["submit_target"]) ? { submit_target: texte(a.args["submit_target"]) } : {}),
        ...(wait ? { wait_for: wait } : {}),
      };
      candidats.push({ login, source: "pw_login", origin: origineDe(page) });
      majPage(sid, a.resultat);
    } else if (a.outil === "pw_run") {
      noter(
        "procédure rejouée (pw_run) : ses gestes appartiennent déjà à une procédure, enregistrez plutôt une nouvelle version de celle-ci",
        texte(a.args["procedure"]),
      );
    }
  }
  return assembler(candidats, ecartes, options.origin);
}

/** `goto` d'après une ouverture de session ou un `goto` : `expect.url_path` seulement si la page atteinte a le chemin demandé (aucune redirection constatée). */
function gotoObserve(url: string, resultat: unknown): Act {
  const finale = estDict(resultat) ? texte(resultat["url"]) : "";
  const relatif = url.startsWith("/")
    ? url
    : `${cheminDe(url)}${url.includes("?") ? `?${url.split("?")[1]?.split("#")[0] ?? ""}` : ""}`;
  const act: Act = { act: "goto", url: relatif || "/" };
  if (
    finale !== "" &&
    cheminDe(finale) === cheminDe(url) &&
    cheminDe(url) !== "" &&
    !cheminDe(url).includes("*")
  )
    act.expect = { url_path: cheminDe(url) };
  return act;
}

function traiterGeste(
  verbe: string,
  args: Dict,
  resultat: unknown,
  page: string,
  fusion: (t: string, s: string) => string,
): "ignore" | { act: Act; origin: string } | { ecarte: string } {
  const act = (
    {
      goto: "goto",
      click: "click",
      fill: "fill",
      type: "fill",
      press: "press",
      select: "select",
      select_option: "select",
      check: "check",
      uncheck: "uncheck",
      hover: "hover",
    } as Record<string, Act["act"]>
  )[verbe];
  if (act === undefined) return "ignore";
  const r = reussi(resultat);
  if (!r.ok) return { ecarte: r.raison };
  if (texte(args["secret"]) !== "") return { ecarte: "saisie d'un secret : jamais gardée" };
  if (act === "goto") {
    const brut = texte(args["url"]);
    const origin = brut.startsWith("/") ? origineDe(page) : origineDe(brut);
    if (origin === "") return { ecarte: "adresse ou page courante inconnue" };
    const g = gotoObserve(brut.startsWith("/") ? `${origin}${brut}` : brut, resultat);
    const e = refusUrl(g.url ?? "", origin);
    return e === null ? { act: g, origin } : { ecarte: e };
  }
  const origin = origineDe(page);
  if (origin === "") return { ecarte: "page courante inconnue" };
  const cible = cibleDeLArgs(args, fusion);
  if (cible === "" && act !== "press") return { ecarte: "cible absente" };
  if (cible !== "") {
    const e = refusCible(cible);
    if (e !== null) return { ecarte: `cible non sémantique ou invalide : ${e}` };
  }
  const noeud: Act = { act };
  if (cible !== "") noeud.t = [cible];
  const valeur =
    act === "select"
      ? texte(args["v"] ?? args["value"] ?? args["option_label"] ?? args["option_value"])
      : texte(args["v"] ?? args["value"] ?? args["key"]);
  if (valeur !== "") {
    if (act === "fill" && SECRET_PRESUME.test(cible))
      return { ecarte: "champ présumé secret : valeur jamais gardée" };
    noeud.v = valeur;
  }
  if ((act === "fill" || act === "select" || act === "press") && valeur === "")
    return { ecarte: "valeur absente" };
  // Navigation constatée par un clic : le chemin atteint devient la vérification.
  if (act === "click" && estDict(resultat)) {
    const apres = texte(resultat["url"]);
    if (
      apres !== "" &&
      cheminDe(apres) !== "" &&
      cheminDe(apres) !== cheminDe(page) &&
      !cheminDe(apres).includes("*") &&
      origineDe(apres) === origin
    )
      noeud.expect = { url_path: cheminDe(apres) };
  }
  return { act: noeud, origin };
}

function assembler(
  candidats: readonly Candidat[],
  ecartes: Ecarte[],
  demandee: string | undefined,
): Brouillon {
  const compte = new Map<string, number>();
  for (const c of candidats) if (c.origin !== "") compte.set(c.origin, (compte.get(c.origin) ?? 0) + 1);
  const origines = [...compte]
    .map(([origin, gestes]) => ({ origin, gestes }))
    .sort((a, b) => b.gestes - a.gestes);
  const origin = demandee !== undefined && compte.has(demandee) ? demandee : (origines[0]?.origin ?? "");
  const noeuds: NoeudBrouillon[] = [];
  for (const c of candidats) {
    if (c.origin !== origin) {
      ecartes.push({
        raison: `autre origine (${c.origin || "inconnue"})`,
        quoi: c.act ? `${c.act.act} ${c.act.url ?? c.act.t?.[0] ?? ""}`.slice(0, 120) : c.source,
      });
      continue;
    }
    const id = noeuds.length;
    if (c.login) noeuds.push({ id, genre: "login", source: c.source, ...c.login, confirmSuggere: false });
    else if (c.act)
      noeuds.push({
        id,
        genre: "act",
        act: c.act,
        source: c.source,
        effet: EFFETS_APPRIS.has(c.act.act),
        confirmSuggere: false,
      });
  }
  const dernier = [...noeuds].reverse().find((n) => n.genre === "act" && n.effet);
  const finals = noeuds.map((n) => (n === dernier && n.genre === "act" ? { ...n, confirmSuggere: true } : n));
  return { origin, origines, noeuds: finals, params: suggererParametres(finals), ecartes };
}

function suggererParametres(noeuds: readonly NoeudBrouillon[]): ParamSuggere[] {
  const sortie: ParamSuggere[] = [];
  const pris = new Set<string>(["login"]);
  const unique = (nom: string): string => {
    let n = nom;
    for (let i = 2; pris.has(n); i++) n = `${nom}_${i}`.slice(0, 32);
    pris.add(n);
    return n;
  };
  for (const n of noeuds) {
    if (n.genre !== "act") continue;
    if (n.act.v !== undefined && (n.act.act === "fill" || n.act.act === "select")) {
      const existant = sortie.find((p) => p.champ === "v" && p.valeur === n.act.v);
      if (existant !== undefined) (existant.noeuds as number[]).push(n.id);
      else
        sortie.push({
          nom: unique(nomSuggere(n.act.t?.[0] ?? "", "valeur")),
          valeur: n.act.v,
          noeuds: [n.id],
          champ: "v",
        });
    }
    if (n.act.act === "goto" && n.act.url?.includes("?")) {
      const requete = new URLSearchParams(n.act.url.split("?")[1]?.split("#")[0] ?? "");
      for (const [k, val] of requete) {
        if (val === "" || SECRET_PRESUME.test(k)) continue;
        sortie.push({ nom: unique(slug(k, "valeur")), valeur: val, noeuds: [n.id], champ: "url" });
      }
    }
  }
  return sortie;
}

/** Choix de l'utilisateur dans l'aperçu : identifiant et description, paramètres gardés (`true`) ou littéraux, `confirm` par nœud, nœuds retirés, `wait_for` des connexions incomplètes. */
export interface ChoixApprentissage {
  readonly id: string;
  readonly description: string;
  readonly params: Readonly<Record<string, boolean>>;
  readonly confirm: Readonly<Record<string, boolean>>;
  readonly retires: readonly number[];
  readonly wait_for: Readonly<Record<string, string>>;
}

/** Procédure (toujours NON approuvée : c'est le stockage qui la crée ainsi) construite d'après le brouillon et les choix, validée sans aucune règle assouplie. */
export function construireProcedure(b: Brouillon, c: ChoixApprentissage): ResultatProcedure {
  const params: Procedure["params"] = {};
  const retires = new Set(c.retires);
  const seq: Noeud[] = [];
  let nLogin = 0;
  for (const n of b.noeuds) {
    if (retires.has(n.id)) continue;
    if (n.genre === "login") {
      const nom = nLogin === 0 ? "login" : `login${nLogin + 1}`;
      nLogin += 1;
      params[nom] = "creds";
      const wait = c.wait_for[String(n.id)] ?? n.wait_for ?? "";
      seq.push({
        login: {
          creds: `{${nom}}`,
          ...(n.username_target ? { username_target: n.username_target } : {}),
          ...(n.password_target ? { password_target: n.password_target } : {}),
          ...(n.submit_target ? { submit_target: n.submit_target } : {}),
          wait_for: wait,
        },
      });
      continue;
    }
    const act: Act = { ...n.act };
    if (c.confirm[String(n.id)] === true) act.confirm = true;
    seq.push(act);
  }
  for (const p of b.params) {
    if (c.params[p.nom] !== true) continue;
    let utilise = false;
    for (const noeud of seq) {
      if (!("act" in noeud)) continue;
      const id = b.noeuds.find(
        (n) =>
          n.genre === "act" &&
          n.act.act === noeud.act &&
          n.act.t?.[0] === noeud.t?.[0] &&
          n.act.v === noeud.v &&
          n.act.url === noeud.url,
      )?.id;
      if (id === undefined || !p.noeuds.includes(id)) continue;
      if (p.champ === "v" && noeud.v === p.valeur) {
        noeud.v = `{${p.nom}}`;
        utilise = true;
      } else if (p.champ === "url" && noeud.url !== undefined) {
        const jeton = encodeURIComponent(p.valeur);
        if (noeud.url.includes(`=${jeton}`)) {
          noeud.url = noeud.url.split(`=${jeton}`).join(`={${p.nom}}`);
          utilise = true;
        }
      }
    }
    if (utilise) params[p.nom] = "string";
  }
  if (seq.length === 0) return { ok: false, erreurs: ["aucun geste retenu"] };
  return validerProcedure({
    id: c.id,
    origin: b.origin,
    version: 1,
    description: c.description,
    params,
    root: { seq },
  });
}

/** Brouillon d'après un dump JSON du recorder (`GET /recorder/dump?format=json`, secrets déjà remplacés par une variable) ; identifiant + mot de passe + validation → nœud `login` (jamais de valeur), gestes secrets isolés écartés. */
export function brouillonDepuisRecorder(
  evenements: readonly unknown[],
  options: { origin?: string; pageInitiale?: string },
): Brouillon {
  const ecartes: Ecarte[] = [];
  const candidats: Candidat[] = [];
  // Sans `goto` enregistré, la page de départ est celle de la session (même origine).
  let page = options.pageInitiale ?? "";
  const notes = (raison: string, e: Dict): void =>
    void ecartes.push({
      raison,
      quoi: `${texte(e["action"])} ${texte(e["url"]) || texte(e["selector"])}`.slice(0, 120),
    });
  const liste = evenements.filter(estDict);
  const cibleRec = (e: Dict): string => {
    const l = estDict(e["locator"]) ? e["locator"] : {};
    return cibleDeLArgs(l, (t, s) => (t !== "" ? t : s !== "" ? `css=${s}` : ""));
  };
  for (let i = 0; i < liste.length; i++) {
    const e = liste[i] as Dict;
    const action = texte(e["action"]);
    if (action === "goto") {
      const url = texte(e["url"]);
      if (e["url_masked"] === true) {
        notes("adresse avec paramètre sensible masqué", e);
        continue;
      }
      if (origineDe(url) === "") {
        notes("adresse illisible", e);
        continue;
      }
      page = url;
      candidats.push({ act: gotoObserve(url, null), source: "recorder", origin: origineDe(url) });
      continue;
    }
    if (!["click", "fill", "type", "select", "check", "uncheck", "hover", "press"].includes(action)) {
      if (action !== "") notes("geste non repris", e);
      continue;
    }
    if ((action === "fill" || action === "type") && texte(e["secret"]) !== "") {
      // Motif de connexion : [identifiant] mot de passe, puis clic de validation.
      const pwd = cibleRec(e);
      const prec = liste[i - 1];
      const suiv = liste[i + 1];
      const idEv =
        prec !== undefined && ["fill", "type"].includes(texte(prec["action"])) && texte(prec["secret"]) === ""
          ? prec
          : undefined;
      const idCible = idEv ? cibleRec(idEv) : "";
      if (
        suiv !== undefined &&
        texte(suiv["action"]) === "click" &&
        pwd !== "" &&
        refusCible(pwd) === null &&
        cibleRec(suiv) !== "" &&
        refusCible(cibleRec(suiv)) === null
      ) {
        // Le champ identifiant déjà retenu comme geste est retiré : sa valeur appartient au jeton creds.
        if (idEv && candidats.length > 0 && candidats[candidats.length - 1]?.act?.t?.[0] === idCible)
          candidats.pop();
        candidats.push({
          login: {
            ...(idCible !== "" && refusCible(idCible) === null ? { username_target: idCible } : {}),
            password_target: pwd,
            submit_target: cibleRec(suiv),
          },
          source: "recorder",
          origin: origineDe(page),
        });
        i += 1;
        continue;
      }
      notes("champ secret hors motif identifiant + mot de passe + validation : écarté", e);
      continue;
    }
    const cible = cibleRec(e);
    const err =
      cible === ""
        ? "cible absente (le recorder n'a pas fourni role/name/label/placeholder/text)"
        : refusCible(cible);
    if (err !== null) {
      notes(`cible non sémantique ou invalide : ${err}`, e);
      continue;
    }
    const noeud: Act = { act: action === "type" ? "fill" : (action as Act["act"]), t: [cible] };
    const valeur = texte(e["value"]) || texte(e["key"]) || texte(e["option_label"]);
    if (valeur !== "") {
      if (SECRET_PRESUME.test(cible)) {
        notes("champ présumé secret : valeur jamais gardée", e);
        continue;
      }
      noeud.v = valeur;
    }
    if (["fill", "select", "press"].includes(noeud.act) && valeur === "") {
      notes("valeur absente", e);
      continue;
    }
    candidats.push({ act: noeud, source: "recorder", origin: origineDe(page) });
  }
  return assembler(candidats, ecartes, options.origin);
}
