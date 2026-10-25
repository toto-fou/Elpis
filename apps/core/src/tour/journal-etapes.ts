// SPDX-License-Identifier: MIT
/** apps/core/src/tour/journal-etapes.ts — ce que le direct montre d'un tour à outils et que la `tool_history` ne garde pas (durée, réflexion, capture, arrêt de chaque étape, réflexion finale), enregistré avec le message (`tool_meta`). */
import { estDict, longueurPy, prefixePy, strPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";

export const PREFIXE_CAPTURE = "/api/playwright/screenshot/";
const ETAPES_MAX = 500;
const REFLEXION_MAX = 60_000;
const MUTANTS_MEMOIRE = ["add", "replace", "remove", "rewrite"];

const entierPositif = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 10 ** 10 ? Math.trunc(v) : null;

/** Appel rendu hors liste par le direct (délégation, mémoire modifiée, tâches) : la réflexion en cours reste au message. */
function reflexionGardee(nom: string, args: unknown): boolean {
  if (nom === "task" || nom === "todowrite") return true;
  return (
    nom === "memory" && estDict(args) && MUTANTS_MEMOIRE.includes(strPy(args["action"] ?? "").toLowerCase())
  );
}

export class JournalEtapes {
  private readonly etapes = new Map<string, Dict>();
  private readonly debuts = new Map<string, number>();
  private pensee = "";
  private penseeDebut: number | null = null;
  private penseeFin: number | null = null;

  /** Note un événement transmis au client (les événements tus après un Stop n'y passent pas). */
  noter(ev: Dict, maintenant = Date.now()): void {
    const t = ev["type"];
    if (t === "thinking_token" || t === "thinking_content") {
      const texte = strPy(ev["text"] ?? "");
      this.pensee = t === "thinking_content" ? texte : this.pensee + texte;
      this.penseeDebut ??= maintenant;
      this.penseeFin = null;
    } else if (t === "content_token") {
      if (this.penseeDebut !== null) this.penseeFin ??= maintenant;
    } else if (t === "tool_call") this.appel(ev, maintenant);
    else if (t === "tool_result") this.resultat(ev);
  }

  private appel(ev: Dict, maintenant: number): void {
    const id = ev["call_id"];
    if (typeof id !== "string" || !id || this.etapes.has(id) || this.etapes.size >= ETAPES_MAX) return;
    const entree: Dict = {};
    if (!reflexionGardee(strPy(ev["name"] ?? ""), ev["args"]) && this.pensee) {
      Object.assign(entree, this.reflexion(maintenant));
      this.pensee = "";
      this.penseeDebut = this.penseeFin = null;
    }
    this.etapes.set(id, entree);
    this.debuts.set(id, maintenant);
  }

  private resultat(ev: Dict): void {
    const id = ev["call_id"];
    const entree = typeof id === "string" ? this.etapes.get(id) : undefined;
    if (!entree || typeof id !== "string") return;
    this.debuts.delete(id);
    const ms = entierPositif(ev["duration_ms"]);
    if (ms !== null) entree["ms"] = ms;
    const capture = ev["screenshot_url"];
    if (typeof capture === "string" && capture.startsWith(PREFIXE_CAPTURE) && longueurPy(capture) <= 300) {
      entree["shot"] = capture;
      const pas = entierPositif(
        typeof ev["screenshot_step"] === "string" ? Number(ev["screenshot_step"]) : ev["screenshot_step"],
      );
      if (pas !== null) entree["shot_step"] = pas;
    }
  }

  private reflexion(maintenant: number): Dict {
    const out: Dict = { think: prefixePy(this.pensee, REFLEXION_MAX) };
    if (this.penseeDebut !== null)
      out["think_ms"] = Math.max(0, (this.penseeFin ?? maintenant) - this.penseeDebut);
    return out;
  }

  /** Tour interrompu : les étapes encore en cours sont arrêtées à la durée atteinte. */
  arreter(maintenant = Date.now()): void {
    for (const [id, debut] of this.debuts) {
      const entree = this.etapes.get(id);
      if (entree) Object.assign(entree, { state: "stopped", ms: Math.max(0, maintenant - debut) });
    }
    this.debuts.clear();
  }

  /** `tool_meta` du message, ou `null` pour un tour sans appel d'outil identifié. */
  versMessage(maintenant = Date.now()): Dict | null {
    if (!this.etapes.size) return null;
    const out: Dict = { steps: Object.fromEntries([...this.etapes].map(([id, e]) => [id, { ...e }])) };
    if (this.pensee) out["tail"] = this.reflexion(maintenant);
    return out;
  }
}

/** `tool_meta` validé (il revient du client) : clés et valeurs connues, bornées ; `null` sinon. */
export function metaOutilsPropre(brut: unknown): Dict | null {
  if (!estDict(brut) || !estDict(brut["steps"])) return null;
  const steps: Dict = {};
  for (const [id, e] of Object.entries(brut["steps"]).slice(0, ETAPES_MAX)) {
    if (!id || longueurPy(id) > 128 || !estDict(e)) continue;
    const propre: Dict = {};
    for (const k of ["ms", "think_ms", "shot_step"]) {
      const v = entierPositif(e[k]);
      if (v !== null) propre[k] = v;
    }
    if (typeof e["think"] === "string" && e["think"]) propre["think"] = prefixePy(e["think"], REFLEXION_MAX);
    if (e["state"] === "stopped") propre["state"] = "stopped";
    const capture = e["shot"];
    if (typeof capture === "string" && capture.startsWith(PREFIXE_CAPTURE) && longueurPy(capture) <= 300)
      propre["shot"] = capture;
    steps[id] = propre;
  }
  if (!Object.keys(steps).length) return null;
  const out: Dict = { steps };
  const queue = brut["tail"];
  if (estDict(queue) && typeof queue["think"] === "string" && queue["think"]) {
    out["tail"] = { think: prefixePy(queue["think"], REFLEXION_MAX) };
    const ms = entierPositif(queue["think_ms"]);
    if (ms !== null) (out["tail"] as Dict)["think_ms"] = ms;
  }
  return out;
}

/** « Continuer » : étapes du segment tronqué puis celles de la suite ; la réflexion finale suit le dernier segment. */
export function fusionnerMetaOutils(prec: unknown, suite: unknown): Dict | null {
  const a = metaOutilsPropre(prec);
  const b = metaOutilsPropre(suite);
  if (!a || !b) return a ?? b;
  const out: Dict = { steps: { ...(a["steps"] as Dict), ...(b["steps"] as Dict) } };
  if (b["tail"]) out["tail"] = b["tail"];
  return out;
}

/** Erreur d'un tour en échec, gardée sur son message : texte, détail technique, genre. */
export function erreurPourMessage(texte: unknown, detail: unknown, kind: unknown): Dict {
  return {
    text: prefixePy(strPy(texte ?? ""), 2000),
    detail: prefixePy(strPy(detail ?? ""), 4000),
    kind: prefixePy(strPy(kind ?? ""), 40),
  };
}

/** Erreur persistée validée (elle revient du client) ; `null` sinon. */
export function erreurPropre(brut: unknown): Dict | null {
  if (!estDict(brut) || typeof brut["text"] !== "string" || !brut["text"]) return null;
  return erreurPourMessage(brut["text"], brut["detail"], brut["kind"]);
}
