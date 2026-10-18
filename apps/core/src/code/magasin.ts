// SPDX-License-Identifier: MIT
/** apps/core/src/code/magasin.ts — magasin de la page Code (shared_infra/opencode/store.py) : sessions, messages, parts, clients et file de commandes en base. */
import {
  clesOrdonnees,
  copieDict,
  entierExactPy,
  ErreurPython,
  estDict,
  FlottantPy,
  flottantStrictPy,
  getPy,
  itemPy,
  iterExige,
  ouPy,
  poserCle,
  prefixePy,
  pyJsonDumps,
  pyJsonLoads,
  reprFlottant,
  splitPy,
  stripPy,
  strPy,
  trierPy,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base, Executeur, Valeur } from "@elpis/db";

export const CMD_TTL = 90.0;
export const CLIENT_TTL = 40.0;
export const SESSION_TTL = 14 * 86400.0;
const PRUNE_EVERY = 60.0;

export const QUESTION_MAX_QUESTIONS = 20;
export const QUESTION_MAX_OPTIONS = 30;
export const QUESTION_MAX_TEXT = 4000;

export type Horloge = () => number;

export interface CommandeLost {
  id: string;
  sid: string;
  kind: unknown;
}

/** `time.time()`. */
export function maintenant(): number {
  return Date.now() / 1000;
}

/** Valeur liée telle quelle : le moteur refuse ce que sqlite3 ou psycopg refuseraient (liste, dict…). */
export function sql(v: unknown): Valeur {
  return v as Valeur;
}

/** Flottant lié en REAL comme un `float` de Python, même s'il est entier. */
export function reel(x: number): Valeur {
  return new FlottantPy(x) as unknown as Valeur;
}

/** `except (TypeError, ValueError)` : toute autre erreur (OverflowError…) remonte. */
export function estErreurTypeOuValeur(e: unknown): boolean {
  return e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError");
}

function ou(...valeurs: (() => unknown)[]): unknown {
  let v: unknown = undefined;
  for (const f of valeurs) {
    v = f();
    if (veritePy(v)) return v;
  }
  return v;
}

/** `_j` : `json.dumps(v, ensure_ascii=False)`. */
export function j(v: unknown): string {
  return pyJsonDumps(v, { ensureAscii: false });
}

/** `_load` : JSON stocké relu en dict, `{}` s'il est illisible ou n'en est pas un. */
export function charger(s: unknown): Dict {
  if (veritePy(s) && typeof s !== "string") return {};
  try {
    const d = pyJsonLoads(veritePy(s) ? (s as string) : "{}");
    return estDict(d) ? d : {};
  } catch {
    return {};
  }
}

/** `_part_ts` : `time` est un dict (`{start, end}`) chez opencode ; illisible = 0.0. */
export function partTs(p: unknown): number {
  let t = getPy(p, "time");
  if (estDict(t)) {
    const d = t;
    t = ou(
      () => getPy(d, "start"),
      () => getPy(d, "created"),
      () => 0,
    );
  }
  try {
    return flottantStrictPy(veritePy(t) ? t : 0);
  } catch (e) {
    if (estErreurTypeOuValeur(e)) return 0.0;
    throw e;
  }
}

/** `normalize_permission` : forme unique (v1 `permission.updated`, v2 `permission.asked`), `null` sans id ni session. */
export function normalizePermission(props: unknown): Dict | null {
  if (!estDict(props)) return null;
  const p = copieDict(props);
  if (!(veritePy(getPy(p, "id")) && veritePy(getPy(p, "sessionID")))) return null;
  if (!veritePy(getPy(p, "type")) && veritePy(getPy(p, "permission")))
    poserCle(p, "type", strPy(itemPy(p, "permission")));
  const motifs = getPy(p, "patterns");
  if (!veritePy(getPy(p, "pattern")) && Array.isArray(motifs))
    poserCle(p, "pattern", motifs.filter(veritePy).map(strPy).join(" "));
  if (!veritePy(getPy(p, "title"))) {
    const brut = getPy(p, "metadata");
    const md = estDict(brut) ? brut : {};
    const titre = ou(
      () => getPy(md, "command"),
      () => getPy(md, "description"),
      () => getPy(p, "pattern"),
      () => getPy(p, "type"),
      () => "Demande de validation",
    );
    poserCle(p, "title", strPy(titre));
  }
  return p;
}

function texteBorne(v: unknown, n: number): string {
  return prefixePy(stripPy(strPy(veritePy(v) ? v : "")), n);
}

/** `normalize_question` : `question.asked` retypé et borné (le modèle pilote l'outil), `null` s'il ne reste rien. */
export function normalizeQuestion(props: unknown): Dict | null {
  if (!estDict(props)) return null;
  const qid = getPy(props, "id");
  const sid = getPy(props, "sessionID");
  if (!(veritePy(qid) && veritePy(sid))) return null;
  const brut = getPy(props, "questions");
  if (!Array.isArray(brut)) return null;
  const questions: Dict[] = [];
  for (const q of brut.slice(0, QUESTION_MAX_QUESTIONS)) {
    if (!estDict(q)) continue;
    const texte = texteBorne(getPy(q, "question"), QUESTION_MAX_TEXT);
    const options: Dict[] = [];
    const opts = getPy(q, "options");
    for (const o of (Array.isArray(opts) ? opts : []).slice(0, QUESTION_MAX_OPTIONS)) {
      let libelle: string;
      let desc: string;
      if (estDict(o)) {
        libelle = texteBorne(getPy(o, "label"), QUESTION_MAX_TEXT);
        desc = texteBorne(getPy(o, "description"), QUESTION_MAX_TEXT);
      } else {
        libelle = texteBorne(o, QUESTION_MAX_TEXT);
        desc = "";
      }
      if (libelle) options.push({ label: libelle, description: desc });
    }
    if (!texte && options.length === 0) continue;
    questions.push({
      question: texte,
      header: texteBorne(getPy(q, "header"), 200),
      options,
      multiple: veritePy(getPy(q, "multiple")),
      custom: getPy(q, "custom") !== false,
    });
  }
  if (questions.length === 0) return null;
  const sortie: Dict = { id: strPy(qid), sessionID: strPy(sid), questions };
  const outil = getPy(props, "tool");
  if (estDict(outil) && (veritePy(getPy(outil, "messageID")) || veritePy(getPy(outil, "callID")))) {
    sortie["tool"] = {
      messageID: strPy(ouPy(getPy(outil, "messageID"), "")),
      callID: strPy(ouPy(getPy(outil, "callID"), "")),
    };
  }
  return sortie;
}

/** Message de note fusionné au fil (transcript et `code.note` du flux). */
export function noteMessage(
  sid: unknown,
  nid: unknown,
  kind: unknown,
  label: unknown,
  detail: unknown,
  created: number,
): Dict {
  return {
    info: {
      id: "note-" + strPy(nid),
      role: "note",
      sessionID: sid,
      time: { created: versFlottantPy(created) },
      note: { kind, label, detail: veritePy(detail) ? detail : "" },
    },
    parts: [],
  };
}

const EXPIRE_RECENT = "SELECT client_id FROM code_clients WHERE user_id=? AND last_seen>?";

export class MagasinCode {
  readonly base: Base;
  private readonly horloge: Horloge;
  private epochPose = false;
  private dernierElagage = 0.0;

  constructor(base: Base, horloge: Horloge = maintenant) {
    this.base = base;
    this.horloge = horloge;
  }

  /** `_ensure_schema` : l'epoch est posé une fois (le schéma vient d'`initialiserBase`). */
  private async schema(): Promise<void> {
    if (this.epochPose) return;
    await this.base.run(
      `INSERT INTO code_meta(user_id, "key", value) VALUES (0, 'epoch', ?) ON CONFLICT(user_id, "key") DO NOTHING`,
      [reprFlottant(this.horloge())],
    );
    this.epochPose = true;
  }

  private async transaction<T>(fn: (x: Executeur) => Promise<T>): Promise<T> {
    await this.schema();
    return this.base.transaction(fn);
  }

  private async ecriture<T>(fn: (x: Executeur) => Promise<T>): Promise<T> {
    await this.schema();
    return this.base.ecriture(fn);
  }

  private async lecture(): Promise<Base> {
    await this.schema();
    return this.base;
  }

  async getEpoch(): Promise<number> {
    const r = await (
      await this.lecture()
    ).get<{ value: unknown }>(`SELECT value FROM code_meta WHERE user_id=0 AND "key"='epoch'`);
    try {
      return r ? flottantStrictPy(r.value) : 0.0;
    } catch (e) {
      if (estErreurTypeOuValeur(e)) return 0.0;
      throw e;
    }
  }

  private async metaPoser(x: Executeur, uid: number, cle: string, valeur: unknown): Promise<void> {
    await x.run(
      `INSERT INTO code_meta(user_id,"key",value) VALUES(?,?,?) ON CONFLICT(user_id,"key") DO UPDATE SET value=excluded.value`,
      [uid, cle, sql(valeur)],
    );
  }

  /** `x` : transaction de l'appelant, sinon la base. */
  async metaGet(uid: number, cle: string, x?: Executeur): Promise<string> {
    const r = await (x ?? (await this.lecture())).get<{ value: string }>(
      `SELECT value FROM code_meta WHERE user_id=? AND "key"=?`,
      [uid, cle],
    );
    return r ? r.value : "";
  }

  /** `x` : transaction de l'appelant, sinon une transaction propre. */
  async metaSet(uid: number, cle: string, valeur: string, x?: Executeur): Promise<void> {
    if (x) await this.metaPoser(x, uid, cle, valeur);
    else await this.transaction((t) => this.metaPoser(t, uid, cle, valeur));
  }

  /** `seen_client` : un client tombstoné (bye) ne revit que par l'ingest (`revive`). */
  async seenClient(
    uid: number,
    cid: string,
    pluginVersion: unknown = 0,
    directory: unknown = "",
    revive = false,
  ): Promise<void> {
    const t = this.horloge();
    const pv = entierExactPy(veritePy(pluginVersion) ? pluginVersion : 0);
    const rv = revive ? 1 : 0;
    await this.transaction(async (x) => {
      if (cid && !revive) {
        const r = await x.get<{ bye: unknown }>(
          "SELECT bye FROM code_clients WHERE user_id=? AND client_id=?",
          [uid, cid],
        );
        if (r && veritePy(r.bye)) return;
      }
      await this.metaPoser(x, uid, "last_ingest", reprFlottant(t));
      if (cid) {
        await x.run(
          "INSERT INTO code_clients(user_id,client_id,last_seen,plugin_version,directory) " +
            "VALUES(?,?,?,?,?) ON CONFLICT(user_id,client_id) DO UPDATE SET " +
            "last_seen=CASE WHEN code_clients.bye=1 AND ?=0 THEN code_clients.last_seen " +
            "ELSE excluded.last_seen END, " +
            "bye=CASE WHEN ?=1 THEN 0 ELSE code_clients.bye END, " +
            "plugin_version=CASE WHEN ?>0 THEN ? ELSE code_clients.plugin_version END, " +
            "directory=CASE WHEN excluded.directory!='' THEN excluded.directory " +
            "ELSE code_clients.directory END",
          [uid, cid, reel(t), pv > 0 ? pv : 1, sql(veritePy(directory) ? directory : ""), rv, rv, pv, pv],
        );
      }
    });
  }

  /** `client_bye` : client mort tout de suite ; plus aucun client vivant → `last_ingest` remis à 0. */
  async clientBye(uid: number, cid: string): Promise<void> {
    const t = this.horloge();
    await this.transaction(async (x) => {
      if (cid)
        await x.run("UPDATE code_clients SET last_seen=0, bye=1 WHERE user_id=? AND client_id=?", [uid, cid]);
      const r = await x.get<{ n: unknown }>(
        "SELECT COUNT(*) AS n FROM code_clients WHERE user_id=? AND last_seen>?",
        [uid, reel(t - CLIENT_TTL)],
      );
      if (!(r && veritePy(r.n))) await this.metaPoser(x, uid, "last_ingest", "0");
    });
  }

  async activeClients(uid: number): Promise<string[]> {
    const lignes = await (
      await this.lecture()
    ).all<{ client_id: string }>(EXPIRE_RECENT, [uid, reel(this.horloge() - CLIENT_TTL)]);
    return lignes.map((l) => l.client_id);
  }

  /** Clients actifs `[{id, directory, plugin_version}]`, les plus récents d'abord. */
  async clientsList(uid: number): Promise<Dict[]> {
    const lignes = await (
      await this.lecture()
    ).all<{
      client_id: unknown;
      directory: unknown;
      plugin_version: unknown;
    }>(
      "SELECT client_id, directory, plugin_version FROM code_clients WHERE user_id=? AND last_seen>? ORDER BY last_seen DESC",
      [uid, reel(this.horloge() - CLIENT_TTL)],
    );
    return lignes.map((l) => ({
      id: l.client_id,
      directory: l.directory,
      plugin_version: entierExactPy(ouPy(l.plugin_version, 0)),
    }));
  }

  async clientPluginVersion(uid: number, cid: string): Promise<number> {
    const r = await (
      await this.lecture()
    ).get<{ plugin_version: unknown }>(
      "SELECT plugin_version FROM code_clients WHERE user_id=? AND client_id=? AND last_seen>?",
      [uid, cid, reel(this.horloge() - CLIENT_TTL)],
    );
    return r ? Number(ouPy(r.plugin_version, 0)) : 0;
  }

  async sessionOwner(uid: number, sid: string): Promise<string> {
    const r = await (
      await this.lecture()
    ).get<{ client_id: unknown }>("SELECT client_id FROM code_sessions WHERE user_id=? AND id=?", [uid, sid]);
    return r ? strPy(ouPy(r.client_id, "")) : "";
  }

  async minPluginVersion(uid: number): Promise<number> {
    const r = await (
      await this.lecture()
    ).get<{ v: unknown }>(
      "SELECT MIN(plugin_version) AS v FROM code_clients WHERE user_id=? AND last_seen>?",
      [uid, reel(this.horloge() - CLIENT_TTL)],
    );
    return r ? Number(ouPy(r.v, 0)) : 0;
  }

  async lastIngest(uid: number): Promise<number> {
    const v = await this.metaGet(uid, "last_ingest");
    try {
      return flottantStrictPy(veritePy(v) ? v : 0);
    } catch (e) {
      if (estErreurTypeOuValeur(e)) return 0.0;
      throw e;
    }
  }

  private async assurerSession(x: Executeur, uid: number, sid: unknown, cid: string): Promise<void> {
    await x.run(
      "INSERT INTO code_sessions(user_id,id,info,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,id) DO NOTHING",
      [uid, sql(sid), j({ id: sid, title: "" }), reel(this.horloge())],
    );
    if (cid)
      await x.run("UPDATE code_sessions SET client_id=? WHERE user_id=? AND id=?", [cid, uid, sql(sid)]);
  }

  /** Une seule session VIDE par CLI : les précédentes sont oubliées. */
  private async elaguerVidesSoeurs(x: Executeur, uid: number, sid: unknown, cid: string): Promise<void> {
    if (!cid) return;
    const lignes = await x.valeurs<[unknown]>(
      "SELECT s.id FROM code_sessions s WHERE s.user_id=? AND s.client_id=? AND s.id<>? " +
        "AND NOT EXISTS (SELECT 1 FROM code_messages m WHERE m.user_id=s.user_id AND m.session_id=s.id) " +
        "AND NOT EXISTS (SELECT 1 FROM code_notes n WHERE n.user_id=s.user_id AND n.session_id=s.id)",
      [uid, cid, sql(sid)],
    );
    for (const [ancien] of lignes) await this.supprimerSessionComplete(x, uid, ancien);
  }

  private async poserOccupee(x: Executeur, uid: number, sid: unknown, occupee: boolean): Promise<void> {
    await x.run("UPDATE code_sessions SET busy=? WHERE user_id=? AND id=?", [occupee ? 1 : 0, uid, sql(sid)]);
  }

  private async ecrireMessage(
    x: Executeur,
    uid: number,
    sid: unknown,
    mid: unknown,
    info: Dict,
  ): Promise<void> {
    const temps = getPy(info, "time");
    const created = estDict(temps)
      ? flottantStrictPy(
          ou(
            () => getPy(temps, "created"),
            () => 0,
          ),
        )
      : 0.0;
    await x.run(
      "INSERT INTO code_messages(user_id,session_id,id,info,created) VALUES(?,?,?,?,?) " +
        "ON CONFLICT(user_id,session_id,id) DO UPDATE SET info=excluded.info, created=excluded.created",
      [uid, sql(sid), sql(mid), j(info), reel(created)],
    );
  }

  private async ecrirePart(
    x: Executeur,
    uid: number,
    sid: unknown,
    mid: unknown,
    pid: unknown,
    part: Dict,
  ): Promise<void> {
    const texte = j(part);
    await x.run(
      "INSERT INTO code_parts(user_id,session_id,message_id,id,part,ts) VALUES(?,?,?,?,?,?) " +
        "ON CONFLICT(user_id,session_id,message_id,id) DO UPDATE SET part=excluded.part, ts=excluded.ts",
      [uid, sql(sid), sql(mid), sql(pid), texte, reel(partTs(part))],
    );
  }

  /** Ne touche PAS code_notes : un re-snapshot supprime puis réinsère, les traces restent. */
  private async supprimerSession(x: Executeur, uid: number, sid: unknown): Promise<void> {
    await x.run("DELETE FROM code_sessions WHERE user_id=? AND id=?", [uid, sql(sid)]);
    await x.run("DELETE FROM code_messages WHERE user_id=? AND session_id=?", [uid, sql(sid)]);
    await x.run("DELETE FROM code_parts WHERE user_id=? AND session_id=?", [uid, sql(sid)]);
  }

  private async supprimerSessionComplete(x: Executeur, uid: number, sid: unknown): Promise<void> {
    await this.supprimerSession(x, uid, sid);
    await x.run("DELETE FROM code_notes WHERE user_id=? AND session_id=?", [uid, sql(sid)]);
    await x.run("DELETE FROM code_permissions WHERE user_id=? AND session_id=?", [uid, sql(sid)]);
    await x.run("DELETE FROM code_questions WHERE user_id=? AND session_id=?", [uid, sql(sid)]);
  }

  /** Modèle du dernier message assistant, dénormalisé pour la carte de la session. */
  private async toucherModele(x: Executeur, uid: number, sid: unknown, info: Dict): Promise<void> {
    if (
      getPy(info, "role") === "assistant" &&
      veritePy(getPy(info, "providerID")) &&
      veritePy(getPy(info, "modelID"))
    ) {
      await x.run("UPDATE code_sessions SET last_model=? WHERE user_id=? AND id=?", [
        strPy(itemPy(info, "providerID")) + "/" + strPy(itemPy(info, "modelID")),
        uid,
        sql(sid),
      ]);
    }
  }

  /** Aperçu : dernier texte non synthétique, aplati et borné à 160 caractères. */
  private async toucherApercu(x: Executeur, uid: number, sid: unknown, part: Dict): Promise<void> {
    if (getPy(part, "type") !== "text" || veritePy(getPy(part, "synthetic"))) return;
    const texte = splitPy(strPy(ouPy(getPy(part, "text"), ""))).join(" ");
    if (texte)
      await x.run("UPDATE code_sessions SET preview=? WHERE user_id=? AND id=?", [
        prefixePy(texte, 160),
        uid,
        sql(sid),
      ]);
  }

  private async appliquerUn(x: Executeur, uid: number, ev: Dict, cid: string, t: number): Promise<void> {
    const typ = ouPy(getPy(ev, "type"), "");
    const props = ouPy(getPy(ev, "properties"), {});
    if (typ === "client.commands") {
      const cmds = getPy(props, "commands");
      if (!Array.isArray(cmds)) return;
      const propres: Dict[] = [];
      for (const cm of cmds) {
        if (!(estDict(cm) && veritePy(getPy(cm, "name")))) continue;
        const entree: Dict = {
          name: strPy(ouPy(getPy(cm, "name"), "")),
          description: strPy(ouPy(getPy(cm, "description"), "")),
        };
        for (const k of ["agent", "model"]) if (veritePy(getPy(cm, k))) entree[k] = strPy(itemPy(cm, k));
        if (veritePy(getPy(cm, "has_args"))) entree["has_args"] = true;
        propres.push(entree);
      }
      await this.metaPoser(x, uid, "commands", j(propres));
    } else if (typ === "client.models") {
      await this.appliquerModeles(x, uid, props);
    } else if (typ === "client.agents") {
      const ags = getPy(props, "agents");
      if (!Array.isArray(ags)) return;
      const propres: Dict[] = [];
      for (const ag of ags) {
        if (!(estDict(ag) && veritePy(getPy(ag, "name")))) continue;
        propres.push({
          name: strPy(itemPy(ag, "name")),
          description: strPy(ouPy(getPy(ag, "description"), "")),
        });
      }
      if (propres.length === 0) return;
      const noms = new Set(propres.map((a) => a["name"]));
      let defaut = strPy(ouPy(getPy(props, "default"), ""));
      if (!noms.has(defaut)) defaut = noms.has("build") ? "build" : (propres[0]?.["name"] as string);
      await this.metaPoser(x, uid, "agents", j({ agents: propres, default: defaut }));
    } else if (typ === "session.snapshot") {
      await this.appliquerInstantane(x, uid, props, cid, t);
    } else if (typ === "session.created" || typ === "session.updated") {
      const s = ou(
        () => getPy(props, "session"),
        () => getPy(props, "info"),
        () => ({}),
      );
      if (!(estDict(s) && veritePy(getPy(s, "id")))) return;
      const sid = s["id"];
      await this.assurerSession(x, uid, sid, cid);
      await x.run("UPDATE code_sessions SET info=?, updated_at=? WHERE user_id=? AND id=?", [
        j(s),
        reel(t),
        uid,
        sql(sid),
      ]);
      if (typ === "session.created") await this.elaguerVidesSoeurs(x, uid, sid, cid);
    } else if (typ === "session.deleted") {
      const sid = ou(
        () => getPy(props, "sessionID"),
        () => getPy(ouPy(getPy(props, "info"), {}), "id"),
      );
      if (veritePy(sid)) await this.supprimerSessionComplete(x, uid, sid);
    } else if (typ === "session.idle" || typ === "session.error") {
      const sid = ou(
        () => getPy(props, "sessionID"),
        () => getPy(ouPy(getPy(props, "info"), {}), "id"),
        () => "",
      );
      if (veritePy(sid)) await this.poserOccupee(x, uid, sid, false);
    } else if (typ === "message.updated") {
      const info = ouPy(getPy(props, "info"), {});
      const sid = getPy(info, "sessionID");
      const mid = getPy(info, "id");
      if (!(veritePy(sid) && veritePy(mid))) return;
      const d = info as Dict;
      await this.assurerSession(x, uid, sid, cid);
      await this.ecrireMessage(x, uid, sid, mid, d);
      await this.toucherModele(x, uid, sid, d);
      if (getPy(d, "role") === "assistant") {
        const temps = getPy(d, "time");
        const fini = estDict(temps) ? veritePy(getPy(temps, "completed")) : false;
        await this.poserOccupee(x, uid, sid, !fini);
      }
    } else if (typ === "message.part.updated") {
      const part = ouPy(getPy(props, "part"), {});
      const sid = getPy(part, "sessionID");
      const mid = getPy(part, "messageID");
      const pid = getPy(part, "id");
      if (!(veritePy(sid) && veritePy(mid) && veritePy(pid))) return;
      const d = part as Dict;
      await this.assurerSession(x, uid, sid, cid);
      await x.run(
        "INSERT INTO code_messages(user_id,session_id,id,info) VALUES(?,?,?,?) ON CONFLICT(user_id,session_id,id) DO NOTHING",
        [uid, sql(sid), sql(mid), j({ id: mid, role: "assistant", sessionID: sid })],
      );
      await this.ecrirePart(x, uid, sid, mid, pid, d);
      await this.toucherApercu(x, uid, sid, d);
      await this.poserOccupee(x, uid, sid, true);
    } else if (typ === "permission.updated" || typ === "permission.asked") {
      const p = normalizePermission(props);
      if (p === null) return;
      const temps = getPy(p, "time");
      let created: number;
      try {
        created = estDict(temps)
          ? flottantStrictPy(
              ou(
                () => getPy(temps, "created"),
                () => 0,
              ),
            )
          : 0.0;
      } catch (e) {
        if (!estErreurTypeOuValeur(e)) throw e;
        created = 0.0;
      }
      if (!created && !Number.isNaN(created)) created = t * 1000.0;
      await x.run(
        "INSERT INTO code_permissions(user_id,session_id,id,info,created) VALUES(?,?,?,?,?) " +
          "ON CONFLICT(user_id,session_id,id) DO UPDATE SET info=excluded.info, created=excluded.created",
        [uid, sql(p["sessionID"]), sql(p["id"]), j(p), reel(created)],
      );
    } else if (typ === "permission.replied") {
      const sid = getPy(props, "sessionID");
      const pid = ou(
        () => getPy(props, "permissionID"),
        () => getPy(props, "requestID"),
      );
      if (veritePy(sid) && veritePy(pid))
        await x.run("DELETE FROM code_permissions WHERE user_id=? AND session_id=? AND id=?", [
          uid,
          sql(sid),
          sql(pid),
        ]);
    } else if (typ === "question.asked") {
      const q = normalizeQuestion(props);
      if (q === null) return;
      await x.run(
        "INSERT INTO code_questions(user_id,session_id,id,info,created) VALUES(?,?,?,?,?) " +
          "ON CONFLICT(user_id,session_id,id) DO UPDATE SET info=excluded.info, created=excluded.created",
        [uid, sql(q["sessionID"]), sql(q["id"]), j(q), reel(t * 1000.0)],
      );
    } else if (typ === "question.replied" || typ === "question.rejected") {
      const sid = getPy(props, "sessionID");
      const qid = ou(
        () => getPy(props, "requestID"),
        () => getPy(props, "questionID"),
      );
      if (veritePy(sid) && veritePy(qid))
        await x.run("DELETE FROM code_questions WHERE user_id=? AND session_id=? AND id=?", [
          uid,
          sql(sid),
          sql(qid),
        ]);
    } else if (typ === "message.removed") {
      const sid = getPy(props, "sessionID");
      const mid = getPy(props, "messageID");
      if (!(veritePy(sid) && veritePy(mid))) return;
      await x.run("DELETE FROM code_messages WHERE user_id=? AND session_id=? AND id=?", [
        uid,
        sql(sid),
        sql(mid),
      ]);
      await x.run("DELETE FROM code_parts WHERE user_id=? AND session_id=? AND message_id=?", [
        uid,
        sql(sid),
        sql(mid),
      ]);
    }
  }

  /** `client.models` : fournisseurs et modèles de la CLI (`limit` gardé si lisible), modèle par défaut par fournisseur. */
  private async appliquerModeles(x: Executeur, uid: number, props: unknown): Promise<void> {
    const provs = getPy(props, "providers");
    if (!Array.isArray(provs)) return;
    const propres: Dict[] = [];
    for (const pv of provs) {
      if (!estDict(pv)) continue;
      let modeles = getPy(pv, "models");
      if (estDict(modeles)) {
        const d = modeles;
        modeles = clesOrdonnees(d).map((k) => d[k]);
      }
      const mpropres: Dict[] = [];
      for (const mm of iterExige(veritePy(modeles) ? modeles : [])) {
        if (!(estDict(mm) && veritePy(getPy(mm, "id")))) continue;
        const entree: Dict = {
          id: strPy(ouPy(getPy(mm, "id"), "")),
          name: strPy(
            ou(
              () => getPy(mm, "name"),
              () => getPy(mm, "id"),
              () => "",
            ),
          ),
        };
        const lim = getPy(mm, "limit");
        if (estDict(lim) && (veritePy(getPy(lim, "context")) || veritePy(getPy(lim, "output")))) {
          try {
            const context = entierExactPy(ouPy(getPy(lim, "context"), 0));
            entree["limit"] = { context, output: entierExactPy(ouPy(getPy(lim, "output"), 0)) };
          } catch (e) {
            if (!estErreurTypeOuValeur(e)) throw e;
          }
        }
        mpropres.push(entree);
      }
      if (veritePy(getPy(pv, "id")) && mpropres.length > 0)
        propres.push({
          id: strPy(itemPy(pv, "id")),
          name: strPy(ouPy(getPy(pv, "name"), itemPy(pv, "id"))),
          models: mpropres,
        });
    }
    const brut = getPy(props, "default");
    const defaut: Dict = {};
    if (estDict(brut)) for (const k of clesOrdonnees(brut)) poserCle(defaut, strPy(k), strPy(brut[k]));
    await this.metaPoser(x, uid, "models", j({ providers: propres, default: defaut }));
  }

  /** `session.snapshot` : état complet qui remplace l'historique de la session. */
  private async appliquerInstantane(
    x: Executeur,
    uid: number,
    props: unknown,
    cid: string,
    t: number,
  ): Promise<void> {
    const s = ouPy(getPy(props, "session"), {});
    const sid = getPy(s, "id");
    if (!(estDict(s) && veritePy(sid))) return;
    await this.supprimerSession(x, uid, sid);
    await x.run("INSERT INTO code_sessions(user_id,id,info,client_id,updated_at) VALUES(?,?,?,?,?)", [
      uid,
      sql(sid),
      j(s),
      cid,
      reel(t),
    ]);
    if (!veritePy(ouPy(getPy(props, "messages"), []))) await this.elaguerVidesSoeurs(x, uid, sid, cid);
    for (const m of iterExige(ouPy(getPy(props, "messages"), []))) {
      const info = ouPy(getPy(ouPy(m, {}), "info"), {});
      const mid = getPy(info, "id");
      if (!veritePy(mid)) continue;
      const d = info as Dict;
      await this.ecrireMessage(x, uid, sid, mid, d);
      await this.toucherModele(x, uid, sid, d);
      for (const p of iterExige(ouPy(getPy(m, "parts"), []))) {
        if (!veritePy(getPy(p, "id"))) continue;
        const part = p as Dict;
        await this.ecrirePart(x, uid, sid, mid, part["id"], part);
        await this.toucherApercu(x, uid, sid, part);
      }
    }
  }

  /** `apply_events` : un lot d'events (déjà filtrés) dans une seule transaction ; rend le nombre traité. */
  async applyEvents(
    uid: number,
    events: readonly Dict[],
    cid = "",
    directory: unknown = "",
  ): Promise<number> {
    const t = this.horloge();
    return this.transaction(async (x) => {
      let n = 0;
      for (const ev of events) {
        await this.appliquerUn(x, uid, ev, cid, t);
        n += 1;
      }
      await this.metaPoser(x, uid, "last_ingest", reprFlottant(t));
      if (veritePy(directory)) await this.metaPoser(x, uid, "dir", directory);
      return n;
    });
  }

  /** `sessions_list` : sessions du compte, badge « connectée », compteurs et aperçu ; tri par `time.updated` décroissant. */
  async sessionsList(uid: number): Promise<Dict[]> {
    const t = this.horloge();
    const base = await this.lecture();
    const lignes = await base.all<{
      id: unknown;
      info: unknown;
      busy: unknown;
      client_id: unknown;
      last_model: unknown;
      preview: unknown;
    }>("SELECT id, info, busy, client_id, last_model, preview FROM code_sessions WHERE user_id=?", [uid]);
    const vivants = new Set(
      (await base.valeurs<[unknown]>(EXPIRE_RECENT, [uid, reel(t - CLIENT_TTL)])).map(([c]) => c),
    );
    const comptes = new Map<unknown, unknown>(
      await base.valeurs<[unknown, unknown]>(
        "SELECT session_id, COUNT(*) AS n FROM code_messages WHERE user_id=? GROUP BY session_id",
        [uid],
      ),
    );
    const sortie: Dict[] = [];
    for (const l of lignes) {
      const s = charger(l.info);
      poserCle(s, "busy", veritePy(l.busy));
      poserCle(s, "connected", veritePy(l.client_id) && vivants.has(l.client_id));
      poserCle(s, "client", ouPy(l.client_id, ""));
      poserCle(s, "last_model", ouPy(l.last_model, ""));
      poserCle(s, "preview", ouPy(l.preview, ""));
      poserCle(s, "msg_count", Number(comptes.get(l.id) ?? 0));
      sortie.push(s);
    }
    return trierPy(
      sortie,
      (s) =>
        ou(
          () => getPy(ouPy(getPy(s, "time"), {}), "updated"),
          () => 0,
        ),
      true,
    );
  }

  /** `messages_list` : messages et parts (triées par début puis id), notes fusionnées, tri chronologique. */
  async messagesList(uid: number, sid: string): Promise<Dict[]> {
    const base = await this.lecture();
    const mlignes = await base.valeurs<[unknown, unknown]>(
      "SELECT id, info FROM code_messages WHERE user_id=? AND session_id=?",
      [uid, sid],
    );
    const plignes = await base.valeurs<[unknown, unknown]>(
      "SELECT message_id, part FROM code_parts WHERE user_id=? AND session_id=?",
      [uid, sid],
    );
    const nlignes = await base.valeurs<[unknown, unknown, unknown, unknown, unknown]>(
      "SELECT id, kind, label, detail, created FROM code_notes WHERE user_id=? AND session_id=?",
      [uid, sid],
    );
    const parMessage = new Map<unknown, Dict[]>();
    for (const [mid, texte] of plignes) {
      const liste = parMessage.get(mid) ?? [];
      liste.push(charger(texte));
      parMessage.set(mid, liste);
    }
    let sortie: Dict[] = [];
    for (const [mid, texte] of mlignes) {
      const parts = trierPy(parMessage.get(mid) ?? [], (p) => [partTs(p), ouPy(getPy(p, "id"), "")]);
      const info = charger(texte);
      sortie.push({ info: veritePy(info) ? info : { id: mid }, parts });
    }
    for (const [nid, kind, label, detail, created] of nlignes)
      sortie.push(noteMessage(sid, nid, kind, label, detail, Number(created)));
    sortie = trierPy(sortie, (m) => {
      const info = m["info"] as Dict;
      return [
        ou(
          () => getPy(ouPy(getPy(info, "time"), {}), "created"),
          () => 0,
        ),
        ouPy(getPy(info, "id"), ""),
      ];
    });
    return sortie;
  }

  /** `add_note` : trace persistante d'une commande ou d'une action de la page (`created` en ms). */
  async addNote(
    uid: number,
    sid: string,
    nid: string,
    kind: string,
    label: string,
    detail = "",
  ): Promise<Dict> {
    const created = this.horloge() * 1000.0;
    await this.transaction((x) =>
      x.run(
        "INSERT INTO code_notes(user_id,session_id,id,kind,label,detail,created) VALUES(?,?,?,?,?,?,?) " +
          "ON CONFLICT(user_id,session_id,id) DO UPDATE SET kind=excluded.kind, label=excluded.label, " +
          "detail=excluded.detail, created=excluded.created",
        [uid, sid, nid, kind, label, detail || "", reel(created)],
      ),
    );
    return noteMessage(sid, nid, kind, label, detail, created);
  }

  private async listeInfos(
    table: "code_permissions" | "code_questions",
    uid: number,
    sid: string,
  ): Promise<Dict[]> {
    const lignes = await (
      await this.lecture()
    ).valeurs<[unknown]>(`SELECT info FROM ${table} WHERE user_id=? AND session_id=? ORDER BY created, id`, [
      uid,
      sid,
    ]);
    return lignes.map(([info]) => charger(info));
  }

  permissionsList(uid: number, sid: string): Promise<Dict[]> {
    return this.listeInfos("code_permissions", uid, sid);
  }

  questionsList(uid: number, sid: string): Promise<Dict[]> {
    return this.listeInfos("code_questions", uid, sid);
  }

  async sessionCount(uid: number): Promise<number> {
    const r = await (
      await this.lecture()
    ).get<{ n: unknown }>("SELECT COUNT(*) AS n FROM code_sessions WHERE user_id=?", [uid]);
    return Number(ouPy(r?.n, 0));
  }

  async commandsList(uid: number): Promise<unknown[]> {
    try {
      const cmds = pyJsonLoads(ouPy(await this.metaGet(uid, "commands"), "[]") as string);
      return Array.isArray(cmds) ? cmds : [];
    } catch {
      return [];
    }
  }

  /** `{providers, default}` du sélecteur /model (liste nue d'un greffon v3 tolérée). */
  async modelsList(uid: number): Promise<Dict> {
    try {
      const d = pyJsonLoads(ouPy(await this.metaGet(uid, "models"), "{}") as string);
      if (Array.isArray(d)) return { providers: d, default: {} };
      if (estDict(d))
        return { providers: ouPy(getPy(d, "providers"), []), default: ouPy(getPy(d, "default"), {}) };
    } catch {
      // repli : sélecteur vide
    }
    return { providers: [], default: {} };
  }

  /** `{agents, default}` du sélecteur plan/build, vide tant qu'aucune CLI v12+ ne s'est annoncée. */
  async agentsList(uid: number): Promise<Dict> {
    try {
      const d = pyJsonLoads(ouPy(await this.metaGet(uid, "agents"), "{}") as string);
      if (estDict(d) && Array.isArray(getPy(d, "agents")))
        return { agents: d["agents"], default: strPy(ouPy(getPy(d, "default"), "")) };
    } catch {
      // repli : sélecteur masqué
    }
    return { agents: [], default: "" };
  }

  /** `sweep_undeliverable` : commandes qu'aucune CLI vivante ne prendra plus, purgées et rendues. */
  async sweepUndeliverable(uid: number): Promise<CommandeLost[]> {
    const t = this.horloge();
    return this.ecriture(async (x) => {
      const lignes = await x.valeurs<[unknown, unknown, unknown, unknown, unknown]>(
        "SELECT id, session_id, kind, target, created_at FROM code_commands WHERE user_id=? AND created_at<?",
        [uid, reel(t - CLIENT_TTL)],
      );
      if (lignes.length === 0) return [];
      const vivants = new Set(
        (await x.valeurs<[unknown]>(EXPIRE_RECENT, [uid, reel(t - CLIENT_TTL)])).map(([c]) => c),
      );
      const proprietaires = new Map<unknown, unknown>(
        await x.valeurs<[unknown, unknown]>("SELECT id, client_id FROM code_sessions WHERE user_id=?", [uid]),
      );
      const morts: unknown[] = [];
      const sortie: CommandeLost[] = [];
      for (const [rid, sid, kind, cible] of lignes) {
        let livrable: boolean;
        if (veritePy(cible)) livrable = vivants.has(cible);
        else {
          const prop = ouPy(proprietaires.get(sid), "");
          livrable = veritePy(prop) ? vivants.has(prop) : vivants.size > 0;
        }
        if (!livrable) {
          morts.push(rid);
          sortie.push({ id: strPy(rid), sid: strPy(ouPy(sid, "")), kind });
        }
      }
      for (const rid of morts)
        await x.run("DELETE FROM code_commands WHERE id=? AND user_id=?", [sql(rid), uid]);
      return sortie;
    });
  }

  async dismissSession(uid: number, sid: string): Promise<void> {
    await this.transaction((x) => this.supprimerSessionComplete(x, uid, sid));
  }

  /** `queue_command` : `{id, sid, kind, target?}` + charge ; une cible (`target`) n'est prenable que par ce client. */
  async queueCommand(uid: number, cmd: Dict): Promise<void> {
    const charge: Dict = {};
    for (const k of clesOrdonnees(cmd))
      if (!["id", "sid", "kind", "target"].includes(k)) poserCle(charge, k, cmd[k]);
    await this.transaction(async (x) => {
      await x.run("DELETE FROM code_commands WHERE created_at<?", [reel(this.horloge() - CMD_TTL)]);
      await x.run(
        "INSERT INTO code_commands(id,user_id,session_id,kind,payload,created_at,target) VALUES(?,?,?,?,?,?,?)",
        [
          sql(cmd["id"]),
          uid,
          sql(ouPy(cmd["sid"], "")),
          sql(cmd["kind"]),
          j(charge),
          reel(this.horloge()),
          sql(ouPy(cmd["target"], "")),
        ],
      );
    });
  }

  /** `claim_commands` : tirage atomique (verrou d'écriture) ; cible stricte, sinon propriétaire de la session, absent ou mort. */
  async claimCommands(uid: number, cid: string): Promise<Dict[]> {
    const t = this.horloge();
    return this.ecriture(async (x) => {
      await x.run("DELETE FROM code_commands WHERE created_at<?", [reel(t - CMD_TTL)]);
      const lignes = await x.valeurs<[unknown, unknown, unknown, unknown, unknown]>(
        "SELECT id, session_id, kind, payload, target FROM code_commands WHERE user_id=? ORDER BY created_at",
        [uid],
      );
      if (lignes.length === 0) return [];
      const proprietaires = new Map<unknown, unknown>(
        await x.valeurs<[unknown, unknown]>("SELECT id, client_id FROM code_sessions WHERE user_id=?", [uid]),
      );
      const vivants = new Set(
        (await x.valeurs<[unknown]>(EXPIRE_RECENT, [uid, reel(t - CLIENT_TTL)])).map(([c]) => c),
      );
      const miennes: Dict[] = [];
      const prises: unknown[] = [];
      for (const [rid, sid, kind, charge, cible] of lignes) {
        if (veritePy(cible)) {
          if (cible !== cid) continue;
        } else {
          const prop = ouPy(proprietaires.get(sid), "");
          if (!(prop === cid || !veritePy(prop) || !vivants.has(prop))) continue;
        }
        const cmd: Dict = { id: rid, sid, kind };
        const d = charger(charge);
        for (const k of clesOrdonnees(d)) poserCle(cmd, k, d[k]);
        miennes.push(cmd);
        prises.push(rid);
      }
      for (const rid of prises) await x.run("DELETE FROM code_commands WHERE id=?", [sql(rid)]);
      return miennes;
    });
  }

  /** `prune` (au plus toutes les 60 s) : clients et commandes périmés, sessions sans activité depuis 14 j, orphelins. */
  async prune(): Promise<void> {
    const t = this.horloge();
    if (t - this.dernierElagage < PRUNE_EVERY) return;
    this.dernierElagage = t;
    await this.transaction(async (x) => {
      await x.run("DELETE FROM code_clients WHERE last_seen<?", [reel(t - 3 * CLIENT_TTL)]);
      await x.run("DELETE FROM code_commands WHERE created_at<?", [reel(t - CMD_TTL)]);
      const vieilles = await x.valeurs<[unknown, unknown]>(
        "SELECT user_id, id FROM code_sessions WHERE updated_at<?",
        [reel(t - SESSION_TTL)],
      );
      for (const [vuid, sid] of vieilles) await this.supprimerSessionComplete(x, Number(vuid), sid);
      for (const table of ["code_messages", "code_parts", "code_notes", "code_permissions", "code_questions"])
        await x.run(
          `DELETE FROM ${table} WHERE NOT EXISTS (SELECT 1 FROM code_sessions s ` +
            `WHERE s.user_id=${table}.user_id AND s.id=${table}.session_id)`,
        );
    });
  }
}
