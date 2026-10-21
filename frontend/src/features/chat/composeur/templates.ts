// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/composeur/templates.ts — templates de prompt : analyse et rendu des variables ({{nom | type:…}}, variables système), cache, fenêtre de saisie, insertion au curseur du composeur. */
import type * as Vue from "vue";
import type { Ref } from "vue";

export interface VariableTemplate {
  name: string;
  type: string;
  placeholder: string;
  default: string;
  required: boolean;
  options: string[];
  _system?: boolean;
}

export interface AnalyseTemplate {
  vars: VariableTemplate[];
  system: string[];
}

export interface Template {
  name: string;
  title?: string;
  content: string;
  [cle: string]: unknown;
}

export type ValeursSysteme = Record<string, string>;

// Un nom : lettres (accents compris), chiffres, « _ » et « - ».
const TOKEN_RE = /\{\{\s*([\p{L}\p{N}_-]+)\s*(?:\|\s*([^{}]*?))?\s*\}\}/gu;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const TYPES = new Set(["text", "textarea", "select"]);

const SYSTEM: Readonly<Record<string, string>> = {
  date: "date",
  current_date: "date",
  heure: "heure",
  current_time: "heure",
  date_heure: "date_heure",
  current_datetime: "date_heure",
  jour: "jour",
  current_weekday: "jour",
  utilisateur: "utilisateur",
  user_name: "utilisateur",
  current_user: "utilisateur",
  presse_papier: "presse_papier",
  clipboard: "presse_papier",
  iso_datetime: "iso_datetime",
};

export const SYSTEM_NAMES = Object.keys(SYSTEM);

export function systemKey(name: unknown): string | null {
  return SYSTEM[String(name || "").toLowerCase()] || null;
}

/** Découpe « a:b="x:y":c=[1,2] » sur `sep` hors guillemets et crochets. */
function decouper(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (q) {
      cur += c;
      if (c === q && s[i - 1] !== "\\") q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if (c === "[") depth++;
    if (c === "]") depth = Math.max(0, depth - 1);
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x);
}

function valeur(brut: unknown): string | string[] {
  const v = String(brut == null ? "" : brut).trim();
  if ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))
    return v.slice(1, -1);
  if (v[0] === "[") {
    try {
      const a: unknown = JSON.parse(v);
      if (Array.isArray(a)) return a.map(String);
    } catch {
      /* liste non JSON : découpée à la main */
    }
    return v
      .slice(1, v.endsWith("]") ? -1 : undefined)
      .split(",")
      .map((x) => x.trim().replace(/^["']|["']$/g, ""))
      .filter((x) => x);
  }
  return v;
}

function definition(def: string | undefined): VariableTemplate {
  const spec: VariableTemplate = {
    name: "",
    type: "text",
    placeholder: "",
    default: "",
    required: false,
    options: [],
  };
  if (!def) return spec;
  const parts = decouper(def, ":");
  const first = parts[0];
  if (first === undefined) return spec;
  const m = first.match(/^type\s*=\s*(.+)$/);
  let type = String(m ? valeur(m[1]) : first).toLowerCase();
  let reste = parts.slice(1);
  if (!TYPES.has(type)) {
    if (first.indexOf("=") > 0 || first === "required") reste = parts;
    type = "text";
  }
  spec.type = type;
  for (const p of reste) {
    const i = p.indexOf("=");
    if (i < 0) {
      if (p.toLowerCase() === "required") spec.required = true;
      continue;
    }
    const k = p.slice(0, i).trim().toLowerCase();
    const v = valeur(p.slice(i + 1));
    if (k === "placeholder") spec.placeholder = String(v);
    else if (k === "default" || k === "value") spec.default = String(v);
    else if (k === "options")
      spec.options = Array.isArray(v)
        ? v
        : String(v)
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
    else if (k === "required") spec.required = String(v) !== "false";
  }
  if (spec.type === "select" && !spec.options.length) spec.type = "text";
  return spec;
}

/** Variables d'un contenu, dans l'ordre de première apparition ; une définition typée plus loin complète une mention nue. */
export function parse(content: unknown): AnalyseTemplate {
  const vars: VariableTemplate[] = [];
  const nues = new Set<number>();
  const vus = new Map<string, number>();
  const system: string[] = [];
  const s = String(content == null ? "" : content);
  for (const m of s.matchAll(TOKEN_RE)) {
    const name = m[1] ?? "";
    const sk = systemKey(name);
    if (sk) {
      if (!system.includes(sk)) system.push(sk);
      continue;
    }
    const cle = name.toLowerCase();
    const deja = vus.get(cle);
    if (deja !== undefined) {
      if (m[2] && nues.has(deja)) {
        vars[deja] = { ...definition(m[2]), name: vars[deja]?.name ?? name };
        nues.delete(deja);
      }
      continue;
    }
    vars.push({ ...definition(m[2]), name });
    if (!m[2]) nues.add(vars.length - 1);
    vus.set(cle, vars.length - 1);
  }
  return { vars, system };
}

/** Remplace chaque {{…}} : système → `sys[clé]`, sinon `values[nom]` (casse indifférente) ; sans valeur → vide. */
export function render(
  content: unknown,
  values?: Record<string, unknown>,
  sys?: Record<string, unknown>,
): string {
  const vals = new Map<string, unknown>();
  for (const [k, v] of Object.entries(values || {})) vals.set(k.toLowerCase(), v);
  return String(content == null ? "" : content).replace(TOKEN_RE, (_tout, name: string) => {
    const sk = systemKey(name);
    if (sk) return sys && sys[sk] != null ? String(sys[sk]) : "";
    const v = vals.get(String(name).toLowerCase());
    return v == null ? "" : String(v);
  });
}

/** Valeurs système au moment de l'insertion (heure locale, en français). */
export function systemValues(
  opts: { now?: Date; userName?: string; clipboard?: string | null } = {},
): ValeursSysteme {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const pad = (n: number): string => (n < 10 ? "0" : "") + n;
  const date = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
  const heure = pad(now.getHours()) + ":" + pad(now.getMinutes());
  let jour = "";
  try {
    jour = now.toLocaleDateString("fr-FR", { weekday: "long" });
  } catch {
    /* locale absente */
  }
  return {
    date,
    heure,
    date_heure: date + " " + heure,
    jour,
    iso_datetime: now.toISOString(),
    utilisateur: String(opts.userName || ""),
    presse_papier: opts.clipboard == null ? "" : String(opts.clipboard),
  };
}

export function validName(name: unknown): boolean {
  return NAME_RE.test(String(name || ""));
}

/** L'API pure publiée sous `window.elpisTemplates` (réglages, tests). */
export const elpisTemplates = Object.freeze({
  parse,
  render,
  systemValues,
  systemKey,
  validName,
  SYSTEM_NAMES,
});

export type VueTemplates = Pick<typeof Vue, "ref" | "reactive" | "nextTick"> &
  Partial<Pick<typeof Vue, "onScopeDispose">>;

export interface RefsTemplates {
  inputRef: Ref<HTMLTextAreaElement | null>;
  inputMessage: Ref<string>;
}

export interface CtxTemplates {
  fetchAuth(url: string, options?: Record<string, unknown>, soft?: boolean): Promise<Response | null>;
  readonly userName?: string;
  readonly autoResize?: (() => void) | undefined;
  openSettingsTab?: (onglet: string) => unknown;
}

export interface SaisieTemplate {
  open: boolean;
  template: Template | null;
  fields: VariableTemplate[];
  values: Record<string, string>;
  error: string;
  sys: ValeursSysteme;
}

export interface ResultatCommande {
  ok: boolean;
  msg?: string;
  info?: boolean;
  silent?: boolean;
}

export interface TemplatesChat {
  templatesAll: Ref<Template[]>;
  loadTemplates(force?: boolean): Promise<Template[]>;
  openTemplate(tpl: Template | null | undefined): Promise<boolean>;
  runTemplateByName(name: string): Promise<ResultatCommande>;
  templateFill: SaisieTemplate;
  submitTemplateFill(): void;
  cancelTemplateFill(): void;
  templateFillKeydown(e: KeyboardEvent, field?: VariableTemplate): void;
  templateVarsLabel(tpl: Template | null | undefined): string;
}

const CACHE_MS = 30000;
const VIDE = (): SaisieTemplate => ({
  open: false,
  template: null,
  fields: [],
  values: {},
  error: "",
  sys: {},
});

interface Fenetre {
  addEventListener?: (type: string, f: () => void) => void;
  removeEventListener?: (type: string, f: () => void) => void;
  document?: { querySelector(sel: string): { focus(): void } | null };
  navigator?: { clipboard?: { readText?: () => Promise<string> } };
}

/** Même contrat que l'ancien `setupChatTemplates(vue, refs, ctx)` de chat/_templates.js. */
export function creerTemplates(vue: VueTemplates, refs: RefsTemplates, ctx: CtxTemplates): TemplatesChat {
  const { ref, reactive, nextTick } = vue;
  const onScopeDispose = vue.onScopeDispose ?? ((_fn: () => void): void => undefined);
  const { inputRef, inputMessage } = refs;
  const fenetre = globalThis as Fenetre;
  const templatesAll = ref<Template[]>([]);
  let cacheAt = 0;
  const surTemplates = (): void => {
    cacheAt = 0;
    templatesAll.value = [];
  };
  fenetre.addEventListener?.("templates:changed", surTemplates);
  onScopeDispose(() => fenetre.removeEventListener?.("templates:changed", surTemplates));

  async function loadTemplates(force?: boolean): Promise<Template[]> {
    if (!force && Date.now() - cacheAt < CACHE_MS && templatesAll.value.length) return templatesAll.value;
    try {
      const res = await ctx.fetchAuth("/api/prompt-templates", {}, true);
      if (res && res.ok) {
        const corps: unknown = await res.json();
        const items = corps && typeof corps === "object" ? (corps as { items?: unknown }).items : null;
        templatesAll.value = Array.isArray(items) ? (items as Template[]) : [];
        cacheAt = Date.now();
      }
    } catch {
      /* la liste reste vide */
    }
    return templatesAll.value;
  }

  const templateFill = reactive<SaisieTemplate>(VIDE()) as SaisieTemplate;

  function inserer(texte: string): void {
    const el = inputRef.value;
    const cur = inputMessage.value || "";
    let a = cur.length;
    let b = cur.length;
    if (el && typeof el.selectionStart === "number") {
      a = el.selectionStart;
      b = el.selectionEnd;
    }
    inputMessage.value = cur.slice(0, a) + texte + cur.slice(b);
    const pos = a + texte.length;
    void nextTick(() => {
      if (inputRef.value) {
        inputRef.value.focus();
        try {
          inputRef.value.setSelectionRange(pos, pos);
        } catch {
          /* champ sans sélection */
        }
      }
      ctx.autoResize?.();
    });
  }

  async function lirePressePapier(): Promise<string | null> {
    try {
      const lire = fenetre.navigator?.clipboard?.readText;
      if (lire) return await lire.call(fenetre.navigator?.clipboard);
    } catch {
      /* contexte non sécurisé ou refus */
    }
    return null;
  }

  async function openTemplate(tpl: Template | null | undefined): Promise<boolean> {
    if (!tpl || !tpl.content) return false;
    // Le menu « / » replace le curseur au tick suivant : l'insertion attend.
    await nextTick();
    const info = parse(tpl.content);
    let clip: string | null = null;
    const fields = info.vars.slice();
    if (info.system.includes("presse_papier")) {
      clip = await lirePressePapier();
      if (clip == null)
        fields.unshift({
          name: "presse_papier",
          type: "textarea",
          placeholder: "Collez le texte ici",
          default: "",
          required: false,
          options: [],
          _system: true,
        });
    }
    const sys = systemValues({ userName: ctx.userName || "", clipboard: clip });
    if (!fields.length) {
      inserer(render(tpl.content, {}, sys));
      return true;
    }
    const values: Record<string, string> = {};
    for (const f of fields) values[f.name] = f.default || (f.type === "select" ? f.options[0] || "" : "");
    Object.assign(templateFill, { open: true, template: tpl, fields, values, error: "", sys });
    void nextTick(() =>
      fenetre.document?.querySelector("[data-template-fill] [data-template-field]")?.focus(),
    );
    return true;
  }

  function cancelTemplateFill(): void {
    Object.assign(templateFill, VIDE());
    void nextTick(() => inputRef.value?.focus());
  }

  function submitTemplateFill(): void {
    if (!templateFill.open || !templateFill.template) return;
    const manquants = templateFill.fields.filter(
      (f) => f.required && !String(templateFill.values[f.name] || "").trim(),
    );
    if (manquants.length) {
      templateFill.error = "À remplir : " + manquants.map((f) => f.name).join(", ");
      return;
    }
    const sys = { ...templateFill.sys };
    if (Object.hasOwn(templateFill.values, "presse_papier") && templateFill.fields.some((f) => f._system))
      sys.presse_papier = templateFill.values.presse_papier ?? "";
    const texte = render(templateFill.template.content, templateFill.values, sys);
    cancelTemplateFill();
    inserer(texte);
  }

  function templateFillKeydown(e: KeyboardEvent, field?: VariableTemplate): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelTemplateFill();
      return;
    }
    if (e.key !== "Enter" || e.isComposing) return;
    if (field && field.type === "textarea" && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    submitTemplateFill();
  }

  async function runTemplateByName(name: string): Promise<ResultatCommande> {
    const cle = String(name || "")
      .trim()
      .replace(/^\//, "")
      .toLowerCase();
    if (cle === "+") {
      ctx.openSettingsTab?.("prompts:templates");
      return { ok: true, silent: true };
    }
    const liste = await loadTemplates();
    if (!cle)
      return liste.length
        ? { ok: false, msg: "Précisez un template : /template <nom>." }
        : { ok: true, info: true, msg: "Aucun template : créez-en un dans Paramètres → Prompts." };
    const tpl = liste.find((t) => String(t.name).toLowerCase() === cle);
    if (!tpl) return { ok: false, msg: "Template inconnu : " + cle };
    await openTemplate(tpl);
    return { ok: true, silent: true };
  }

  function templateVarsLabel(tpl: Template | null | undefined): string {
    return tpl
      ? parse(tpl.content)
          .vars.map((v) => v.name)
          .join(", ")
      : "";
  }

  return {
    templatesAll,
    loadTemplates,
    openTemplate,
    runTemplateByName,
    templateFill,
    submitTemplateFill,
    cancelTemplateFill,
    templateFillKeydown,
    templateVarsLabel,
  };
}
