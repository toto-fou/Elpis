// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/skins.ts — console › Système › Apparence : skins de l'instance (activation, défaut, import, éditeur de jetons) via `/api/admin/skins*`. */
import {
  schemaDetailSkin,
  schemaReponseSkinEcrit,
  schemaReponseSkinSupprime,
  schemaReponseSkinsConsole,
} from "@elpis/contracts";
import type { DetailSkin, SkinConsole } from "@elpis/contracts";
import { computed, ref } from "vue";
import type { Ref } from "vue";

import type { ClientHttp } from "../../platform/http/client";
import type { ApiResult } from "../../platform/http/resultat";

export interface JetonSkin {
  k: string;
  l: string;
  color?: boolean;
}

export const SKIN_TOKENS: readonly JetonSkin[] = [
  { k: "--accent", l: "Accent" },
  { k: "--accent-fg", l: "Sur accent" },
  { k: "--app-bg", l: "Fond" },
  { k: "--surface", l: "Surface" },
  { k: "--surface-2", l: "Surface 2" },
  { k: "--text-900", l: "Texte" },
  { k: "--text-700", l: "Texte 2" },
  { k: "--text-500", l: "Discret" },
  { k: "--border", l: "Bordure" },
  { k: "--rail-bg", l: "Rail" },
  { k: "--rail-text", l: "Texte rail" },
  { k: "--rail-active-bg", l: "Rail actif" },
  { k: "--ok", l: "Succès" },
  { k: "--warn", l: "Alerte" },
  { k: "--danger-text", l: "Erreur" },
  { k: "--prose-link", l: "Lien" },
  { k: "--radius", l: "Rayon", color: false },
  { k: "--cl-ink", l: "Encre" },
  { k: "--cl-clay", l: "Argile" },
  { k: "--cl-muted", l: "Sourdine" },
];
const PRINCIPAUX = new Set(SKIN_TOKENS.map((t) => t.k));
const DERIVES = new Set(["--radius-sm", "--radius-md", "--radius-lg", "--radius-xl"]);
type Jetons = Record<string, string>;
type Modes = "light" | "dark";

/** Mêmes interdits que le serveur (`check_token_value`). */
export function valeurJetonOk(v: unknown): boolean {
  return (
    typeof v === "string" &&
    !!v.trim() &&
    v.length <= 200 &&
    !/[;{}<>\\]/.test(v) &&
    !/url\(|@|expression|\/\*|\*\/|image-set|image\(|src\(|javascript:|element\(|cross-fade/i.test(v)
  );
}

export interface EditeurSkin {
  mode: "create" | "edit";
  id: string;
  label: string;
  description: string;
  base: string;
  darkBase: boolean;
  swatch: string[];
  tokens: Record<Modes, Jetons>;
  extra: Record<Modes, Jetons>;
  css: string;
  brand: string;
  view: Modes;
  error: string;
  saving: boolean;
  version?: string;
  author?: string;
  license?: string;
}

export interface CtxSkinsAdmin {
  showToast?(message: string, type?: string): void;
  openConfirm?(
    titre: string,
    message: string,
    danger: boolean,
    libelle?: string,
    annuler?: string,
  ): Promise<boolean>;
  reloadAppSkins?(): unknown;
}

interface EtatSkins {
  loading: boolean;
  loaded: boolean;
  error: string;
  list: SkinConsole[];
  default: string;
}

const erreurHttp = (r: ApiResult<unknown>): r is Extract<ApiResult<unknown>, { erreur: unknown }> =>
  r.type === "requete" || r.type === "refus" || r.type === "serveur" || r.type === "conflit";

function messageEchec(r: ApiResult<unknown>, repli: string): string {
  if (erreurHttp(r)) return r.erreur.detail || repli;
  return r.type === "invalide" ? repli : "Erreur réseau.";
}

function nomsJetons(baseId: string): string[] {
  const noms = new Set<string>();
  const sels = new Set([":root", "body.elpis-app-dark", "body.elpis-dark-surface"]);
  const pref = baseId ? "body.elpis-skin-" + baseId : null;
  for (const sh of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sh.cssRules;
    } catch {
      continue;
    }
    for (const r of Array.from(rules)) {
      if (!(r instanceof CSSStyleRule)) continue;
      const sel = r.selectorText || "";
      if (!(sels.has(sel) || (pref && sel.startsWith(pref) && !sel.includes(" ")))) continue;
      for (let i = 0; i < r.style.length; i++) {
        const n = r.style[i]!;
        if (n.startsWith("--")) noms.add(n);
      }
    }
  }
  for (const t of SKIN_TOKENS) noms.add(t.k);
  return Array.from(noms);
}

/** Valeurs calculées sous les classes d'un skin, posées et retirées dans la même tâche : aucun rendu intermédiaire. */
function lireJetons(baseId: string, dark: boolean, darkBase: boolean, noms: readonly string[]): Jetons {
  const body = document.body;
  const avant = body.className;
  const out: Jetons = {};
  try {
    const cls = body.classList;
    for (const c of Array.from(cls)) {
      if (c.startsWith("elpis-skin-") || c === "elpis-app-dark" || c === "elpis-dark-surface") cls.remove(c);
    }
    if (baseId) cls.add("elpis-skin-" + baseId);
    if (dark) cls.add("elpis-app-dark");
    if (dark || darkBase) cls.add("elpis-dark-surface");
    const cs = getComputedStyle(body);
    for (const n of noms) out[n] = (cs.getPropertyValue(n) || "").trim();
  } finally {
    body.className = avant;
  }
  return out;
}

function jetonsDepuis(base: Jetons, ardoise: Jetons): { principaux: Jetons; autres: Jetons } {
  const principaux: Jetons = {};
  const autres: Jetons = {};
  for (const t of SKIN_TOKENS) principaux[t.k] = base[t.k] || ardoise[t.k] || "";
  for (const n of Object.keys(base)) {
    if (PRINCIPAUX.has(n) || DERIVES.has(n)) continue;
    const v = base[n]!;
    if (v && v !== ardoise[n] && valeurJetonOk(v)) autres[n] = v;
  }
  return { principaux, autres };
}

let ctx2d: CanvasRenderingContext2D | null = null;
/** Couleur quelconque vers #rrggbb pour `<input type=color>` (alpha perdu). */
export function skinHex(v: unknown): string {
  try {
    ctx2d ??= document.createElement("canvas").getContext("2d");
    if (ctx2d) {
      ctx2d.fillStyle = "#000000";
      ctx2d.fillStyle = String(v || "").trim();
      const f = String(ctx2d.fillStyle);
      if (/^#[0-9a-f]{6}$/i.test(f)) return f;
      const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(f);
      if (m) return "#" + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("");
    }
  } catch {
    /* repli noir */
  }
  return "#000000";
}

export function setupAdminSkins(ctx: CtxSkinsAdmin | null | undefined, http: ClientHttp) {
  const toast = (m: string, type?: string): void => ctx?.showToast?.(m, type);
  const skinAdm: Ref<EtatSkins> = ref({ loading: false, loaded: false, error: "", list: [], default: "" });
  const skinAdmBusy = ref("");
  const skinImportInput: Ref<HTMLInputElement | null> = ref(null);
  const skinImportErr = ref("");
  const skinEd: Ref<EditeurSkin | null> = ref(null);
  const skinAdmPlugins = computed(() => skinAdm.value.list.filter((s) => s.source === "plugin").length);
  const json = (methode: string, corps: unknown): RequestInit => ({
    method: methode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corps),
  });

  function appliquer(d: { skins: SkinConsole[]; default: string }): void {
    skinAdm.value.list = d.skins;
    skinAdm.value.default = d.default;
  }
  function relireCompte(): void {
    try {
      void ctx?.reloadAppSkins?.();
    } catch {
      /* au mieux */
    }
  }

  async function loadAdminSkins(): Promise<void> {
    skinAdm.value.loading = true;
    skinAdm.value.error = "";
    try {
      const r = await http.requete("/api/admin/skins", {}, { schema: schemaReponseSkinsConsole });
      if (r.type === "ok") {
        appliquer(r.valeur);
        skinAdm.value.loaded = true;
      } else if (erreurHttp(r)) {
        skinAdm.value.error = r.erreur.detail || "Erreur " + r.statut;
      } else {
        skinAdm.value.error = "Erreur réseau.";
      }
    } finally {
      skinAdm.value.loading = false;
    }
  }

  async function putState(corps: unknown, busyId: string): Promise<boolean> {
    skinAdmBusy.value = busyId;
    try {
      const r = await http.requete("/api/admin/skins", json("PUT", corps), {
        schema: schemaReponseSkinsConsole,
      });
      if (r.type !== "ok") {
        toast(messageEchec(r, "Modification refusée."), "error");
        return false;
      }
      appliquer(r.valeur);
      relireCompte();
      return true;
    } finally {
      skinAdmBusy.value = "";
    }
  }

  const skinToggle = (sk: SkinConsole): Promise<boolean> | undefined =>
    sk.locked ? undefined : putState({ enabled: { [sk.id]: !sk.enabled } }, sk.id);
  const skinSetDefault = (sk: SkinConsole): Promise<boolean> | undefined =>
    sk.is_default ? undefined : putState({ default: sk.id }, sk.id);

  function skinExport(sk: SkinConsole): void {
    const a = document.createElement("a");
    a.href = "/api/admin/skins/" + encodeURIComponent(sk.id) + "/export";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function skinDelete(sk: SkinConsole): Promise<void> {
    if (sk.source !== "plugin") return;
    const ok = await ctx?.openConfirm?.(
      "Supprimer « " + sk.label + " » ?",
      "Les comptes qui l'utilisent passeront au skin par défaut.",
      true,
      "Supprimer",
    );
    if (!ok) return;
    skinAdmBusy.value = sk.id;
    try {
      const r = await http.requete(
        "/api/admin/skins/" + encodeURIComponent(sk.id),
        { method: "DELETE" },
        { schema: schemaReponseSkinSupprime },
      );
      if (r.type !== "ok") {
        toast(messageEchec(r, "Suppression refusée."), "error");
        return;
      }
      appliquer(r.valeur);
      relireCompte();
      toast("Skin supprimé.");
    } finally {
      skinAdmBusy.value = "";
    }
  }

  function skinImportPick(): void {
    skinImportErr.value = "";
    skinImportInput.value?.click();
  }

  const envoyerZip = (file: File, ecraser: boolean) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("overwrite", ecraser ? "true" : "false");
    return http.requete(
      "/api/admin/skins/import",
      { method: "POST", body: fd },
      { schema: schemaReponseSkinEcrit },
    );
  };

  async function proposerActivation(sk: SkinConsole, titre: string, repli: string): Promise<void> {
    if (sk.id && !sk.enabled) {
      const act = await ctx?.openConfirm?.(
        titre,
        "Il est désactivé : aucun compte ne le voit encore.",
        false,
        "Activer",
        "Plus tard",
      );
      if (act) await putState({ enabled: { [sk.id]: true } }, sk.id);
    } else {
      toast(repli);
      relireCompte();
    }
  }

  async function skinImportFile(ev: Event): Promise<void> {
    const cible = ev.target as HTMLInputElement | null;
    const file = cible?.files?.[0];
    if (cible) cible.value = "";
    if (!file) return;
    skinImportErr.value = "";
    skinAdmBusy.value = "__import";
    try {
      let r = await envoyerZip(file, false);
      if (r.type === "conflit") {
        const ok = await ctx?.openConfirm?.(
          "Remplacer ?",
          (r.erreur.detail || "Ce skin existe déjà.") + " Son état est conservé.",
          true,
          "Remplacer",
        );
        if (!ok) return;
        r = await envoyerZip(file, true);
      }
      if (r.type !== "ok") {
        skinImportErr.value = erreurHttp(r)
          ? r.erreur.detail || "Import refusé (" + r.statut + ")."
          : r.type === "invalide"
            ? "Import refusé (" + r.statut + ")."
            : "Erreur réseau.";
        return;
      }
      appliquer(r.valeur);
      const sk = r.valeur.skin;
      await proposerActivation(sk, "« " + (sk.label || sk.id) + " » importé", "Skin importé.");
    } finally {
      skinAdmBusy.value = "";
    }
  }

  const skinBases = computed(() =>
    skinAdm.value.list.filter((s) => s.source === "builtin" || s.source === "plugin"),
  );

  async function remplirDepuis(ed: EditeurSkin, baseId: string): Promise<void> {
    const base = skinAdm.value.list.find((s) => s.id === baseId);
    const source = base?.source ?? "builtin";
    const id = base?.id ?? "";
    let detail: DetailSkin | null = null;
    if (base && source === "plugin") {
      const r = await http.requete(
        "/api/admin/skins/" + encodeURIComponent(id),
        {},
        { schema: schemaDetailSkin },
      );
      if (r.type === "ok") detail = r.valeur;
    }
    const builtinId = source === "builtin" ? id : "";
    const noms = nomsJetons(builtinId);
    const darkBase = !!base?.darkBase;
    const modes = {} as Record<Modes, ReturnType<typeof jetonsDepuis>>;
    for (const mode of ["light", "dark"] as const) {
      const dark = mode === "dark";
      const ardoise = lireJetons("", dark, false, noms);
      let vals = lireJetons(builtinId, dark, darkBase, noms);
      if (detail) vals = { ...ardoise, ...(detail.tokens[mode] ?? {}) };
      modes[mode] = jetonsDepuis(vals, ardoise);
    }
    ed.tokens = { light: modes.light.principaux, dark: modes.dark.principaux };
    ed.extra = { light: modes.light.autres, dark: modes.dark.autres };
    ed.darkBase = darkBase;
    ed.swatch =
      base?.sw.length === 3
        ? base.sw.slice()
        : [
            ed.tokens.light["--rail-bg"] ?? "",
            ed.tokens.light["--app-bg"] ?? "",
            ed.tokens.light["--accent"] ?? "",
          ];
    if (detail?.css && !ed.css) ed.css = detail.css;
  }

  async function skinNew(): Promise<void> {
    const ed: EditeurSkin = {
      mode: "create",
      id: "",
      label: "",
      description: "",
      base: skinAdm.value.default || "elpis",
      darkBase: false,
      swatch: ["#0f172a", "#f8fafc", "#2563eb"],
      tokens: { light: {}, dark: {} },
      extra: { light: {}, dark: {} },
      css: "",
      brand: "",
      view: "light",
      error: "",
      saving: false,
    };
    await remplirDepuis(ed, ed.base);
    skinEd.value = ed;
  }

  async function skinEdBase(baseId: string): Promise<void> {
    if (!skinEd.value) return;
    skinEd.value.base = baseId;
    await remplirDepuis(skinEd.value, baseId);
  }

  async function skinEdit(sk: SkinConsole): Promise<void> {
    if (sk.source !== "plugin") return;
    const r = await http.requete(
      "/api/admin/skins/" + encodeURIComponent(sk.id),
      {},
      { schema: schemaDetailSkin },
    );
    if (r.type !== "ok") {
      toast("Skin illisible.", "error");
      return;
    }
    const d = r.valeur;
    const noms = nomsJetons("");
    const ed: EditeurSkin = {
      mode: "edit",
      id: d.id,
      label: d.label,
      description: d.description || "",
      base: "",
      darkBase: !!d.darkBase,
      swatch: d.swatch.slice(0, 3),
      tokens: { light: {}, dark: {} },
      extra: { light: {}, dark: {} },
      css: d.css || "",
      brand: typeof d.brand.name === "string" ? d.brand.name : "",
      version: d.version || "",
      author: d.author || "",
      license: d.license || "",
      view: "light",
      error: "",
      saving: false,
    };
    for (const mode of ["light", "dark"] as const) {
      const ardoise = lireJetons("", mode === "dark", false, noms);
      const t = d.tokens[mode] ?? {};
      for (const x of SKIN_TOKENS) ed.tokens[mode][x.k] = t[x.k] || ardoise[x.k] || "";
      for (const n of Object.keys(t)) if (!PRINCIPAUX.has(n)) ed.extra[mode][n] = t[n]!;
    }
    skinEd.value = ed;
  }

  const skinEdClose = (): void => {
    skinEd.value = null;
  };

  const skinPreviewStyle = computed<Jetons>(() => {
    const ed = skinEd.value;
    if (!ed) return {};
    const m = ed.view === "dark" ? "dark" : "light";
    const st: Jetons = { ...ed.extra[m], ...ed.tokens[m] };
    const rayon = st["--radius"];
    if (rayon) {
      st["--radius-sm"] = "calc(" + rayon + " - 4px)";
      st["--radius-md"] = "calc(" + rayon + " - 2px)";
      st["--radius-lg"] = rayon;
      st["--radius-xl"] = "calc(" + rayon + " + 4px)";
    }
    return st;
  });
  const skinEdExtraCount = computed(() => {
    const ed = skinEd.value;
    return ed ? Object.keys(ed.extra.light).length + Object.keys(ed.extra.dark).length : 0;
  });

  async function skinEdSave(): Promise<void> {
    const ed = skinEd.value;
    if (!ed || ed.saving) return;
    ed.error = "";
    const tokens: Record<Modes, Jetons> = { light: {}, dark: {} };
    for (const m of ["light", "dark"] as const) {
      Object.assign(tokens[m], ed.extra[m]);
      for (const t of SKIN_TOKENS) {
        const v = String(ed.tokens[m][t.k] || "").trim();
        if (v) tokens[m][t.k] = v;
      }
    }
    const corps: Record<string, unknown> = {
      id: String(ed.id || "").trim(),
      label: ed.label,
      description: ed.description,
      darkBase: !!ed.darkBase,
      swatch: ed.swatch,
      tokens,
      css: ed.css || "",
      brand: ed.brand ? { name: ed.brand } : null,
      update: ed.mode === "edit",
    };
    if (ed.mode === "edit")
      Object.assign(corps, { version: ed.version, author: ed.author, license: ed.license });
    ed.saving = true;
    try {
      const r = await http.requete("/api/admin/skins", json("POST", corps), {
        schema: schemaReponseSkinEcrit,
      });
      if (r.type !== "ok") {
        ed.error = erreurHttp(r)
          ? r.erreur.detail || "Refusé (" + r.statut + ")."
          : r.type === "invalide"
            ? "Refusé (" + r.statut + ")."
            : "Erreur réseau.";
        return;
      }
      appliquer(r.valeur);
      skinEd.value = null;
      const sk = r.valeur.skin;
      await proposerActivation(sk, "« " + (sk.label || sk.id) + " » créé", "Skin enregistré.");
    } finally {
      ed.saving = false;
    }
  }

  return {
    SKIN_TOKENS,
    skinAdm,
    skinAdmBusy,
    skinAdmPlugins,
    skinImportInput,
    skinImportErr,
    skinEd,
    skinBases,
    skinPreviewStyle,
    skinEdExtraCount,
    loadAdminSkins,
    skinToggle,
    skinSetDefault,
    skinExport,
    skinDelete,
    skinImportPick,
    skinImportFile,
    skinNew,
    skinEdBase,
    skinEdit,
    skinEdClose,
    skinEdSave,
    skinHex,
  };
}
