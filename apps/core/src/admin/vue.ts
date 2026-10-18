// SPDX-License-Identifier: MIT
/** apps/core/src/admin/vue.ts — vue d'ensemble de la console : sondes bornées, chiffres de 24 h, sauvegardes et alertes « À traiter » (admin/overview.py). */
import { connect } from "node:net";

import {
  arrondiEntierPy,
  ErreurPython,
  estDict,
  fixePy,
  floatPy,
  getPy,
  hostname,
  intPy,
  maxPy,
  nomTypePy,
  ouPy,
  port,
  strPy,
  stripPy,
  urlsplit,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import {
  config,
  configView,
  httpsEnabled,
  readConfigJson,
  reloadCompressionConfigFromDisk,
  reloadDesktopConfigFromDisk,
} from "@elpis/config";
import type { Base } from "@elpis/db";
import { infoBase } from "@elpis/db";
import { load as chargerManifeste } from "@elpis/mcp";

import { getImageConfig, imageReady } from "../images/config";
import type { Journal } from "../journal";
import { getSharedSecret, listSharedConnectors } from "../llm/connecteurs";
import { testConnector } from "../llm/fournisseurs/decouverte";
import { getLlmHealth } from "../llm/sante";
import { allToolNames } from "../outils/categories";
import { getServiceUrl, isConfigured, ping, RagServiceError } from "../rag/client";
import { configVoix, drapeauxVoix } from "../voix/config";

export const CACHE_TTL = 15.0;
export const PROBE_TIMEOUT = 3.0;
export const TCP_TIMEOUT = 1.5;
export const BACKUP_STALE_DAYS = 7;
export const MAX_CONNECTORS = 8;

type Ligne = Dict;
type Sonde = () => Promise<Ligne | Ligne[]>;

export interface Sondes {
  llm: Sonde;
  connecteurs: Sonde;
  compression: Sonde;
  rag: Sonde;
  vision: Sonde;
  voix: Sonde;
  images: Sonde;
  mcp: Sonde;
  bac: Sonde;
  base: Sonde;
}

export interface Faits {
  kpis(): Promise<Dict>;
  sauvegarde(): Promise<Dict>;
  securite(): Promise<Dict>;
  enAttente(): Promise<string[]>;
}

/** Une ligne de l'inventaire ; `state` : ok · down · warn · off · unknown. */
export function svc(
  sid: string,
  label: string,
  target: string,
  state: string,
  detail = "",
  page = "",
): Ligne {
  return { id: sid, label, target, state, detail, page };
}

/** `_short` : `http://10.0.0.5:8081/v1/chat/completions` → `10.0.0.5:8081`. */
export function court(url: string): string {
  if (!url) return "";
  try {
    const u = urlsplit(url.includes("://") ? url : `http://${url}`);
    const hote = hostname(u) ?? "";
    const p = port(u);
    return p ? `${hote}:${p}` : hote;
  } catch {
    return Array.from(url).slice(0, 60).join("");
  }
}

/** `_fmt_bytes` : o et Ko sans décimale, au-delà une décimale à virgule. */
export function formatOctets(n: number): string {
  let x = n;
  for (const unite of ["o", "Ko", "Mo", "Go", "To"]) {
    if (x < 1024 || unite === "To")
      return unite === "o" || unite === "Ko"
        ? `${fixePy(x, 0)} ${unite}`
        : `${fixePy(x, 1)} ${unite}`.replace(".", ",");
    x /= 1024;
  }
  return `${fixePy(x, 0)} o`;
}

const pluriel = (n: number, mot: string): string => `${mot}${n > 1 ? "s" : ""}`;

/** `_shared_service_reachable` : le port de l'URL accepte-t-il une connexion TCP ? */
export function portJoignable(url: string, delaiS = TCP_TIMEOUT): Promise<boolean> {
  let hote: string;
  let numero: number;
  try {
    const u = urlsplit(url.includes("://") ? url : `http://${url}`);
    hote = hostname(u) || "127.0.0.1";
    numero = port(u) || (u.scheme === "https" ? 443 : 80);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let so: ReturnType<typeof connect>;
    try {
      so = connect({ host: hote, port: numero, timeout: delaiS * 1000 });
    } catch {
      resolve(false);
      return;
    }
    const fin = (ok: boolean): void => {
      so.destroy();
      resolve(ok);
    };
    so.once("connect", () => fin(true));
    so.once("timeout", () => fin(false));
    so.once("error", () => fin(false));
  });
}

/** `_guard` : une sonde qui lève ou dépasse son délai rend sa ligne de repli (« Inconnu », « Sonde sans réponse »). */
export async function garde(
  sonde: () => Promise<Ligne | Ligne[]>,
  repli: Ligne,
  journal: Journal,
  delaiS = PROBE_TIMEOUT + 1.0,
): Promise<Ligne | Ligne[]> {
  let minuterie: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      sonde(),
      new Promise<never>((_, rejeter) => {
        minuterie = setTimeout(() => rejeter(new Error("TimeoutError")), delaiS * 1000);
      }),
    ]);
  } catch (e) {
    journal.info(`[overview] sonde ${String(repli["id"])} : ${e instanceof Error ? e.message : String(e)}`);
    const out: Ligne = { ...repli };
    if (!Object.hasOwn(out, "state")) out["state"] = "unknown";
    out["detail"] = veritePy(out["detail"]) ? out["detail"] : "Sonde sans réponse";
    return out;
  } finally {
    clearTimeout(minuterie);
  }
}

export interface DependancesSondes {
  readonly base: Base;
  readonly journal: Journal;
  /** Sonde du bac à sable (Docker, image, conteneurs actifs) : le core TS ne pilote pas Docker. */
  readonly bac?: Sonde;
}

/** Sondes réelles : moteur local, connecteurs partagés, compression, RAG, vision, voix, images, outils MCP, bac, base. */
export function sondesParDefaut(dep: DependancesSondes): Sondes {
  return {
    async llm() {
      const cible = court(config.LLAMA_URL || "");
      const h = await getLlmHealth();
      if (!veritePy(h["server_reachable"]))
        return svc("llm", "Moteur local", cible, "down", "Injoignable", "inference");
      const modeles = h["models_loaded"];
      const n = Array.isArray(modeles) ? modeles.length : 0;
      return svc(
        "llm",
        "Moteur local",
        cible,
        "ok",
        n ? `${n} ${pluriel(n, "modèle")} ${pluriel(n, "chargé")}` : "Aucun modèle chargé",
        "inference",
      );
    },
    async connecteurs() {
      const lignes = (await listSharedConnectors(dep.base))
        .filter((r) => veritePy(Object.hasOwn(r, "enabled") ? r["enabled"] : true))
        .slice(0, MAX_CONNECTORS);
      const un = async (r: Dict): Promise<Ligne> => {
        const etiquette = strPy(r["label"] || r["provider_type"] || "Connecteur");
        const ligne = svc(
          `conn-${String(r["id"])}`,
          etiquette,
          court(strPy(r["base_url"] || "")),
          "unknown",
          "",
          "inference",
        );
        const secret = await getSharedSecret(dep.base, Number(r["id"]));
        const res = await testConnector(secret ?? r, { timeout: PROBE_TIMEOUT });
        if (veritePy(res["ok"])) {
          const n = Number(res["models_count"] || 0);
          return { ...ligne, state: "ok", detail: `${n} ${pluriel(n, "modèle")}` };
        }
        return {
          ...ligne,
          state: "down",
          detail: Array.from(strPy(res["hint"] || res["error"] || "Injoignable"))
            .slice(0, 80)
            .join(""),
        };
      };
      return (await Promise.all(
        lignes.map((r) =>
          garde(
            () => un(r),
            svc(
              `conn-${String(r["id"])}`,
              strPy(r["label"] || "Connecteur"),
              court(strPy(r["base_url"] || "")),
              "unknown",
              "",
              "inference",
            ),
            dep.journal,
          ),
        ),
      )) as Ligne[];
    },
    async compression() {
      reloadCompressionConfigFromDisk(false);
      if (!config.COMPRESSION_ENABLED) return svc("compression", "Compression", "", "off", "", "compression");
      const url = config.COMPRESSION_ENDPOINT_URL || "";
      if (!url) return svc("compression", "Compression", "", "same", "", "compression");
      const ok = await portJoignable(url);
      return svc(
        "compression",
        "Compression",
        court(url),
        ok ? "ok" : "down",
        ok ? "Joignable" : "Injoignable",
        "compression",
      );
    },
    async rag() {
      if (!isConfigured()) return svc("rag", "RAG", "", "off", "Non configuré", "rag");
      const url = getServiceUrl();
      try {
        await ping(null, null, PROBE_TIMEOUT);
      } catch (e) {
        if (!(e instanceof RagServiceError)) throw e;
        const message = e.message;
        const detail = message.includes("401") || message.includes("403") ? "Accès refusé" : "Injoignable";
        return {
          ...svc("rag", "RAG", court(url), "down", detail, "rag"),
          hint: Array.from(message).slice(0, 160).join(""),
        };
      }
      return svc("rag", "RAG", court(url), "ok", "Joignable", "rag");
    },
    async vision() {
      reloadDesktopConfigFromDisk(false);
      const url = stripPy(config.VISION_ENDPOINT_URL || "");
      if (!url) return svc("vision", "Vision", "", "off", "Non configurée", "vision");
      const ok = await portJoignable(url);
      return svc(
        "vision",
        "Vision",
        court(url),
        ok ? "ok" : "down",
        ok ? "Joignable" : "Injoignable",
        "vision",
      );
    },
    async voix() {
      const cfg = configVoix();
      const [stt, tts] = drapeauxVoix(cfg);
      if (!(stt || tts)) return svc("voice", "Voix", "", "off", "", "voice");
      const sections = (
        [
          ["stt", stt, "Transcription"],
          ["tts", tts, "Synthèse"],
        ] as const
      ).filter(([, actif]) => actif);
      const oks = await Promise.all(sections.map(([cle]) => portJoignable(cfg[cle].endpoint_url)));
      const cibles = sections.map(([cle]) => court(cfg[cle].endpoint_url));
      const parties = sections.map(([, , nom], i) => `${nom} ${oks[i] ? "joignable" : "injoignable"}`);
      const etat = oks.every((o) => o) ? "ok" : !oks.some((o) => o) ? "down" : "warn";
      return svc("voice", "Voix", [...new Set(cibles)].join(" · "), etat, parties.join(" · "), "voice");
    },
    async images() {
      const cfg = getImageConfig();
      if (!imageReady(cfg)) return svc("images", "Images", "", "off", "", "images");
      const url = strPy(cfg.url);
      const ok = await portJoignable(url);
      return svc(
        "images",
        "Images",
        court(url),
        ok ? "ok" : "down",
        ok ? "Joignable" : "Injoignable",
        "images",
      );
    },
    async mcp() {
      const n = allToolNames().size;
      const erreurs = chargerManifeste().errors.length;
      if (erreurs)
        return svc(
          "mcp",
          "Outils MCP",
          "",
          "warn",
          `${erreurs} ${pluriel(erreurs, "erreur")} de configuration`,
          "mcp",
        );
      if (!n) return svc("mcp", "Outils MCP", "", "unknown", "Pas encore chargés", "mcp");
      return svc("mcp", "Outils MCP", "", "ok", `${n} outils`, "mcp");
    },
    async bac() {
      if (!dep.bac) throw new Error("pas de sonde du bac à sable dans ce process");
      return dep.bac();
    },
    async base() {
      let info;
      try {
        info = await infoBase(dep.base, { location: "", cheminSqlite: config.DB_PATH });
      } catch (e) {
        const message = Array.from(e instanceof Error ? e.message : String(e))
          .slice(0, 80)
          .join("");
        return svc("database", "Base", "", "down", message || "Injoignable", "data");
      }
      const libelles: Record<string, string> = {
        sqlite: "SQLite",
        postgresql: "PostgreSQL",
        postgres: "PostgreSQL",
      };
      const etiquette =
        libelles[String(info.backend).toLowerCase()] ?? (String(info.backend || "") || "Base");
      const taille = info.size_bytes;
      return svc(
        "database",
        "Base",
        etiquette,
        "ok",
        typeof taille === "number" && taille > 0 ? formatOctets(taille) : "Joignable",
        "data",
      );
    },
  };
}

/** `x[:n]` d'une valeur JSON : texte ou liste coupés, autre chose lève TypeError comme en Python. */
function prefixe(v: unknown, n: number): unknown {
  if (typeof v === "string") return Array.from(v).slice(0, n).join("");
  if (Array.isArray(v)) return v.slice(0, n);
  throw new ErreurPython("TypeError", `'${nomTypePy(v)}' object is not subscriptable`);
}

/** Sous-section `backup.remote` réduite à ce que lit la vue (`get_remote_config` : mêmes conversions qui lèvent). */
function sauvegardeDistante(): Dict {
  const sauvegarde = getPy(readConfigJson(), "backup", {});
  const brut = estDict(sauvegarde) ? getPy(sauvegarde, "remote", {}) : {};
  const r = estDict(brut) ? brut : {};
  intPy(veritePy(getPy(r, "timeout_sec", 300)) ? getPy(r, "timeout_sec", 300) : 300);
  const dernier = estDict(getPy(r, "last_send", null)) ? (getPy(r, "last_send", null) as Dict) : {};
  const actif = veritePy(getPy(r, "enabled", false));
  const derniereFois: Dict = {
    at: getPy(dernier, "at", 0),
    ok: getPy(dernier, "ok", null),
    ok_at: getPy(dernier, "ok_at", 0),
    error: getPy(dernier, "error", ""),
  };
  if (actif && veritePy(getPy(r, "schedule_enabled", false)))
    floatPy(veritePy(derniereFois["at"]) ? derniereFois["at"] : 0);
  return { enabled: actif, last_send: derniereFois };
}

export interface DependancesFaits {
  readonly base: Base;
  readonly journal: Journal;
  readonly maintenant: () => number;
  readonly enAttente: () => Promise<string[]>;
}

/** Chiffres de 24 h, dernière sauvegarde, faits de sécurité et réglages en attente de redémarrage. */
export function faitsParDefaut(dep: DependancesFaits): Faits {
  return {
    async kpis() {
      const depuis = dep.maintenant() - 86400;
      const t = await dep.base.get<Record<string, unknown>>(
        "SELECT COUNT(*) AS turns, COALESCE(SUM(input_tokens), 0) AS input_tokens, " +
          "COALESCE(SUM(output_tokens), 0) AS output_tokens, " +
          "COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END), 0) AS failures, " +
          "COUNT(DISTINCT user_id) AS users FROM usage_events WHERE ts > ?",
        [depuis],
      );
      let outils = { calls: 0, failed: 0 };
      try {
        const r = await dep.base.valeurs<[unknown, unknown]>(
          "SELECT COUNT(*), SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) FROM tool_call_metrics WHERE ts > ?",
          [depuis],
        );
        outils = { calls: Number(r[0]?.[0] ?? 0) || 0, failed: Number(r[0]?.[1] ?? 0) || 0 };
      } catch (e) {
        dep.journal.info(
          `[overview] tool_call_metrics illisible : ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const total = Number(t?.["input_tokens"] ?? 0) + Number(t?.["output_tokens"] ?? 0);
      return {
        users: Number(t?.["users"] ?? 0) || 0,
        turns: Number(t?.["turns"] ?? 0) || 0,
        tokens: total,
        failures: Number(t?.["failures"] ?? 0) || 0,
        tool_calls: outils.calls,
        tool_failures: outils.failed,
      };
    },
    async sauvegarde() {
      let local = 0;
      try {
        const r = await dep.base.valeurs<[unknown]>(
          "SELECT MAX(created_at) FROM metric_events WHERE event_type='backup_created'",
        );
        local = veritePy(r[0]?.[0]) ? Number(r[0]?.[0]) : 0;
      } catch (e) {
        dep.journal.info(
          `[overview] metric_events illisible : ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      let distante: Dict = {};
      try {
        distante = sauvegardeDistante();
      } catch (e) {
        dep.journal.info(
          `[overview] config de sauvegarde distante illisible : ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const dernier = (veritePy(distante["last_send"]) ? distante["last_send"] : {}) as Dict;
      const okA = floatPy(veritePy(getPy(dernier, "ok_at", null)) ? getPy(dernier, "ok_at", null) : 0) || 0;
      const echec = getPy(dernier, "ok", null) === false;
      const erreur = getPy(dernier, "error", null);
      return {
        at: veritePy(maxPy(local, okA)) ? versFlottantPy(maxPy(local, okA)) : null,
        remote_enabled: veritePy(distante["enabled"]),
        remote_failed: echec,
        remote_error: echec ? prefixe(veritePy(erreur) ? erreur : "", 120) : "",
      };
    },
    async securite() {
      const vue = configView() as Dict;
      const sec = getPy(vue, "security", null);
      const politiqueBrute = getPy(veritePy(sec) ? sec : {}, "password_policy", null);
      const pol = veritePy(politiqueBrute) ? politiqueBrute : {};
      const vide = !(
        intPy(ouPy(getPy(pol, "min_length", null), 0)) > 0 ||
        ["require_uppercase", "require_lowercase", "require_numbers", "require_special"].some((k) =>
          veritePy(getPy(pol, k, null)),
        )
      );
      let aChanger = 0;
      try {
        const r = await dep.base.valeurs<[unknown]>(
          "SELECT COUNT(*) FROM users WHERE is_admin=1 AND must_change_pwd=1",
        );
        aChanger = Number(r[0]?.[0] ?? 0) || 0;
      } catch (e) {
        dep.journal.info(`[overview] table users illisible : ${e instanceof Error ? e.message : String(e)}`);
      }
      const infos = getPy(vue, "app_info", null);
      const nom = stripPy(strPy(ouPy(getPy(veritePy(infos) ? infos : {}, "name", null), "")));
      return {
        https: httpsEnabled(),
        policy_empty: vide,
        admin_must_change: aChanger,
        instance_named: Boolean(nom),
      };
    },
    enAttente: dep.enAttente,
  };
}

/** `_collect` : sondes en parallèle, compression héritée du moteur local, alertes et liste d'installation. */
export async function collecter(
  sondes: Sondes,
  faits: Faits,
  journal: Journal,
  maintenant: () => number,
): Promise<Dict> {
  const inconnu = (sid: string, label: string, page: string): Ligne =>
    svc(sid, label, "", "unknown", "", page);
  const resultats = await Promise.all([
    garde(sondes.llm, inconnu("llm", "Moteur local", "inference"), journal),
    garde(
      sondes.connecteurs,
      inconnu("connectors", "Connecteurs", "inference"),
      journal,
      2 * PROBE_TIMEOUT + 2.0,
    ),
    garde(sondes.compression, inconnu("compression", "Compression", "compression"), journal),
    garde(sondes.rag, inconnu("rag", "RAG", "rag"), journal),
    garde(sondes.vision, inconnu("vision", "Vision", "vision"), journal),
    garde(sondes.voix, inconnu("voice", "Voix", "voice"), journal),
    garde(sondes.images, inconnu("images", "Images", "images"), journal),
    garde(sondes.mcp, inconnu("mcp", "Outils MCP", "mcp"), journal),
    garde(sondes.bac, inconnu("sandbox", "Sandbox", "sandbox-limits"), journal, 2 * PROBE_TIMEOUT + 1.0),
    garde(sondes.base, inconnu("database", "Base", "data"), journal),
  ]);
  const services: Ligne[] = resultats.flatMap((p) => (Array.isArray(p) ? p : [p]));
  const llm = services.find((s) => s["id"] === "llm");
  for (const s of services)
    if (s["state"] === "same") {
      s["state"] = llm ? llm["state"] : "unknown";
      s["detail"] = "Via le moteur local";
      s["inherited"] = true;
    }
  const [kpis, sauvegarde, sec, attente] = await Promise.all([
    faits.kpis(),
    faits.sauvegarde(),
    faits.securite(),
    faits.enAttente(),
  ]);
  const t = maintenant();
  const alertes: Dict[] = [];
  if (attente.length)
    alertes.push({
      id: "restart",
      level: "warn",
      title: "Redémarrage nécessaire",
      detail: `${attente.length} ${pluriel(attente.length, "réglage")} en attente`,
      paths: attente,
      action: "restart",
    });
  for (const s of services) {
    if (veritePy(s["inherited"])) continue;
    if (s["state"] === "down")
      alertes.push({
        id: `svc-${String(s["id"])}`,
        level: "danger",
        title: `${String(s["label"])} injoignable`,
        detail: veritePy(s["target"]) ? s["target"] : s["detail"],
        page: s["page"],
        action: "page",
      });
    else if (s["state"] === "warn")
      alertes.push({
        id: `svc-${String(s["id"])}`,
        level: "warn",
        title: `${String(s["label"])} : ${veritePy(s["detail"]) ? String(s["detail"]) : "à vérifier"}`,
        detail: s["target"],
        page: s["page"],
        action: "page",
      });
  }
  if (veritePy(sec["admin_must_change"]))
    alertes.push({
      id: "admin-pwd",
      level: "danger",
      title: "Mot de passe administrateur provisoire",
      detail: "À changer à la prochaine connexion",
      page: "accounts",
      action: "page",
    });
  const a = veritePy(sauvegarde["at"]) ? Number(sauvegarde["at"]) : null;
  const age = veritePy(a) ? (t - (a as number)) / 86400 : null;
  if (age === null || age > BACKUP_STALE_DAYS)
    alertes.push({
      id: "backup",
      level: "warn",
      title: age ? `Aucune sauvegarde depuis ${Math.trunc(age)} jours` : "Aucune sauvegarde enregistrée",
      detail: "",
      page: "data",
      action: "backup",
    });
  if (veritePy(sauvegarde["remote_failed"]))
    alertes.push({
      id: "backup-remote",
      level: "warn",
      title: "Dernier envoi distant en échec",
      detail: sauvegarde["remote_error"],
      page: "data",
      action: "page",
    });
  const appels = Number(kpis["tool_calls"]);
  const echecs = Number(kpis["tool_failures"]);
  if (echecs >= 5 && appels && echecs / appels >= 0.1)
    alertes.push({
      id: "tools",
      level: "warn",
      title: `Appels d’outils : ${arrondiEntierPy((100 * echecs) / appels)} % en échec`,
      detail: `${echecs} sur ${appels} en 24 h`,
      page: "tool-calls",
      action: "page",
    });
  if (!veritePy(sec["https"]))
    alertes.push({
      id: "https",
      level: "warn",
      title: "HTTPS désactivé",
      detail: "Mots de passe et cookies circulent en clair",
      page: "https",
      action: "page",
    });
  if (veritePy(sec["policy_empty"]))
    alertes.push({
      id: "pwd-policy",
      level: "warn",
      title: "Aucune règle de mot de passe",
      detail: "",
      page: "sessions",
      action: "page",
    });
  const moteurOk = services.some(
    (s) => (s["id"] === "llm" || String(s["id"]).startsWith("conn-")) && s["state"] === "ok",
  );
  const installation = [
    { id: "name", label: "Nommer l’instance", done: veritePy(sec["instance_named"]), page: "instance" },
    { id: "engine", label: "Un moteur joignable", done: moteurOk, page: "inference" },
    {
      id: "admin-pwd",
      label: "Mot de passe administrateur définitif",
      done: !veritePy(sec["admin_must_change"]),
      page: "accounts",
    },
    { id: "https", label: "Accès HTTPS", done: veritePy(sec["https"]), page: "https" },
    {
      id: "backup",
      label: "Sauvegarde distante",
      done: veritePy(sauvegarde["remote_enabled"]),
      page: "data",
    },
  ];
  return {
    generated_at: versFlottantPy(t),
    alerts: alertes,
    services,
    kpis,
    backup: { at: a === null ? null : versFlottantPy(a), remote_enabled: sauvegarde["remote_enabled"] },
    setup: installation,
    restart: { pending: attente },
  };
}
