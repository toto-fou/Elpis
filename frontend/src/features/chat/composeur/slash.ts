// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/composeur/slash.ts — menu « / » du composeur : registre des commandes (arguments, disponibilité), skills épinglés, prompts, cascade clavier, résolution à l'envoi. */
import type * as Vue from "vue";
import type { ComputedRef, Ref } from "vue";

import type { JobsSlash } from "../jobs/jobs.ts";
import type { ResultatCommande, TemplatesChat } from "./templates.ts";

export interface EnvSlash {
  chatId?: string | null;
  isStreaming?: boolean;
  planMode?: boolean;
  imageAvailable?: boolean;
  [cle: string]: unknown;
}

export interface ValeurArgument {
  value: string;
  label: string;
  last?: boolean;
  /** Icône de la rangée (classe Phosphor) à la place du chevron. */
  icone?: string;
  /** Argument attendu après la valeur, écrit entre parenthèses : `(collection)`. */
  indice?: string;
}

interface SpecArgument {
  name: string;
  label: string;
  readonly values: readonly ValeurArgument[];
  /** Valeurs qui dépendent des mots déjà saisis (prioritaires sur `values`). */
  /** Garde l'ordre déclaré (la valeur par défaut en tête) au lieu du tri par nom. */
  readonly ordreDonne?: boolean;
  readonly valuesFor?: (avant: readonly string[]) => readonly ValeurArgument[];
  /** Titre de l'en-tête du menu des valeurs (par défaut « Valeurs »). */
  readonly titre?: (avant: readonly string[]) => string;
  /** L'argument prend le reste de la ligne (un nom de plusieurs mots) : le choix le remplace en entier. */
  readonly libre?: boolean;
}

export interface CommandeSlash {
  name: string;
  label: string;
  icon: string;
  desc: string;
  mode?: "skills" | "prompts";
  args?: readonly SpecArgument[];
  /** Arguments appliqués quand la commande validée est tapée en entier, sans argument. */
  sansArgument?: readonly string[];
  /** Les mots saisis suffisent à lancer la commande (sinon : autant que d'arguments). */
  complet?: (mots: readonly string[]) => boolean;
  when?: (env: EnvSlash) => boolean;
  whenLabel?: string;
  hidden?: (env: EnvSlash) => boolean;
  run?: (args: readonly string[], raw: string) => Promise<ResultatCommande | null | undefined>;
}

export interface Skill {
  name: string;
  description?: string;
  domain?: string;
  tags?: readonly string[];
}

export interface PromptSlash {
  id: string | number;
  title: string;
  content: string;
  shared: boolean;
  from?: string;
}

export interface ContexteSaisie {
  head: boolean;
  name: string;
  raw: string;
  words: string[];
  hasSpace: boolean;
  trailing: boolean;
  start: number;
  end: number;
}

type Niveau = "commands" | "values" | "skills" | "prompts";
type Rangee = CommandeSlash | ValeurArgument | Skill | PromptSlash;

export interface RefsSlash {
  inputRef: Ref<HTMLTextAreaElement | null>;
  inputMessage: Ref<string>;
  showMentionDropdown?: Ref<boolean>;
  templates?: TemplatesChat | null;
}

/** Commande `/rag` : sous-commandes et collections des menus, exécution (features/rag/commande.ts). */
export interface RagSlash {
  disponible(): boolean;
  valeurs(avant: readonly string[]): readonly ValeurArgument[];
  actualiser(): void;
  lancer(raw: string): Promise<ResultatCommande>;
}

export interface CtxSlash {
  fetchAuth(url: string, options?: Record<string, unknown>, soft?: boolean): Promise<Response | null>;
  showToast(message: string, type?: string): void;
  readonly autoResize?: (() => void) | undefined;
  readonly env?: EnvSlash;
  manualCompress?: () => unknown;
  openSettingsTab?: (onglet: string | null) => unknown;
  openHelp?: () => unknown;
  setPlanMode?: (on: boolean) => unknown;
  imageSlash?: (raw: string) => Promise<ResultatCommande> | ResultatCommande;
  jobs?: JobsSlash;
  rag?: RagSlash | null;
}

export interface Commande {
  cmd: CommandeSlash;
  raw: string;
  args: string[];
}

export type VueSlash = Pick<typeof Vue, "ref" | "computed" | "nextTick">;

export interface MenuSlash {
  showSlash: ComputedRef<boolean>;
  slashLevel: ComputedRef<Niveau>;
  slashList: ComputedRef<readonly Rangee[]>;
  slashIdx: Ref<number>;
  slashRaw: Ref<ContexteSaisie | null>;
  pinnedSkills: Ref<Skill[]>;
  selectSlash(item: Rangee | null | undefined): Promise<void>;
  selectValue(v: ValeurArgument | null | undefined): Promise<void>;
  selectSkill(skill: Skill | null | undefined): void;
  selectPrompt(p: PromptSlash | null | undefined): void;
  removePinnedSkill(nom: string): void;
  slashDismiss(): void;
  slashSetIdx(i: number): void;
  resetSlash(): void;
  slashKeydown(e: KeyboardEvent): boolean;
  onInput(): void;
  slashResolve(texte: string): Commande | null;
  slashRun(hit: Commande | null | undefined): Promise<void>;
  slashCmdOk(cmd: CommandeSlash | null | undefined): boolean;
  slashRowKey(item: Rangee | null | undefined, i: number): string;
  promptPreview(p: PromptSlash | null | undefined): string;
  slashRowTitle(item: Rangee | null | undefined): string;
  slashHeaderIcon: ComputedRef<string>;
  slashHeaderLabel: ComputedRef<string>;
  /** Commande écrite dans l'en-tête : `/rag use` quand le menu liste les valeurs d'une sous-commande. */
  slashHeaderCmd: ComputedRef<string>;
}

const CACHE_MS = 30000;

/** Onglets réels de la modale Paramètres (identifiants attendus par settingsTab). */
export const SETTINGS_TABS: readonly ValeurArgument[] = [
  { value: "profile", label: "Profil" },
  { value: "chat", label: "Chat" },
  { value: "ai_models", label: "Moteurs" },
  { value: "appearance", label: "Apparence" },
  { value: "features", label: "Fonctions" },
  { value: "usage", label: "Utilisation" },
  { value: "memory", label: "Mémoire" },
  { value: "agents", label: "Agents" },
  { value: "prompts", label: "Prompts" },
  { value: "skills", label: "Skills" },
  { value: "archives", label: "Archives" },
  { value: "sandbox", label: "Sandbox" },
  { value: "connectors", label: "Connecteurs" },
];

// Tables littérales : une classe d'icône composée à la volée serait absente de la feuille générée.
const HEADER_ICON: Readonly<Record<Niveau, string>> = {
  commands: "ph-terminal",
  values: "ph-caret-right",
  prompts: "ph-bookmark-simple",
  skills: "ph-graduation-cap",
};
const HEADER_LABEL: Readonly<Record<Niveau, string>> = {
  commands: "Commandes",
  values: "Valeurs",
  prompts: "Prompts",
  skills: "Skills",
};

const objet = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";

/** Tri en deux paquets : préfixe d'abord, sous-chaîne ensuite, chacun par ordre alphabétique. */
function paquets<T>(src: readonly T[], q: string, texte: (x: T) => string): T[] {
  const parNom = (a: T, b: T): number => texte(a).localeCompare(texte(b));
  const debut = src.filter((x) => texte(x).toLowerCase().startsWith(q));
  const dedans = q
    ? src.filter((x) => !texte(x).toLowerCase().startsWith(q) && texte(x).toLowerCase().includes(q))
    : [];
  return [...debut.sort(parNom), ...dedans.sort(parNom)];
}

/** Même contrat que l'ancien `setupChatSlash(vue, refs, ctx)` de chat/_slash.js. */
export function creerMenuSlash(vue: VueSlash, refs: RefsSlash, ctx: CtxSlash): MenuSlash {
  const { ref, computed, nextTick } = vue;
  const { inputRef, inputMessage, showMentionDropdown } = refs;
  const templates = refs.templates || null;
  const { fetchAuth, showToast } = ctx;
  const env = (): EnvSlash => ctx.env || {};

  // Poussé par l'événement input : il dépend de `selectionStart`, qui n'est pas réactif.
  const slashRaw = ref<ContexteSaisie | null>(null);
  const slashDismissed = ref(false);
  const slashIdx = ref(0);
  // Sous-niveau choisi explicitement (/skills, /prompt) : la frappe « / » seule est ambiguë.
  const slashSub = ref<"skills" | "prompts" | null>(null);
  const pinnedSkills = ref<Skill[]>([]);

  const skills = ref<Skill[]>([]);
  const prompts = ref<PromptSlash[]>([]);
  let skillsAt = 0;
  let promptsAt = 0;

  const fenetre = globalThis as { addEventListener?: (type: string, f: () => void) => void };
  fenetre.addEventListener?.("skills:changed", () => {
    skillsAt = 0;
    skills.value = [];
  });
  fenetre.addEventListener?.("prompts:changed", () => {
    promptsAt = 0;
    prompts.value = [];
  });

  async function lireJson(url: string): Promise<Record<string, unknown> | null> {
    const res = await fetchAuth(url, {}, true);
    if (!res || !res.ok) return null;
    const corps: unknown = await res.json();
    return objet(corps) ? corps : null;
  }

  async function chargerSkills(): Promise<void> {
    if (Date.now() - skillsAt < CACHE_MS && skills.value.length) return;
    try {
      const data = await lireJson("/api/skills");
      if (data) {
        skills.value = Array.isArray(data.skills) ? (data.skills as Skill[]) : [];
        skillsAt = Date.now();
      }
    } catch {
      /* la commande ne marchera juste pas */
    }
  }

  // Prompts personnels et reçus en partage : deux routes, une liste.
  async function chargerPrompts(): Promise<void> {
    if (Date.now() - promptsAt < CACHE_MS && prompts.value.length) return;
    const out: PromptSlash[] = [];
    const lire = async (url: string, partage: boolean): Promise<void> => {
      try {
        const data = await lireJson(url);
        const items = data && Array.isArray(data.items) ? data.items : [];
        for (const p of items) {
          if (!objet(p) || !p.content) continue;
          out.push(
            partage
              ? {
                  id: "s" + String(p.id),
                  title: String(p.title || ""),
                  content: String(p.content),
                  shared: true,
                  from: String(p.from_username || ""),
                }
              : {
                  id: p.id as string,
                  title: String(p.title || ""),
                  content: String(p.content),
                  shared: false,
                },
          );
        }
      } catch {
        /* silencieux */
      }
    };
    await lire("/api/prompts", false);
    await lire("/api/prompts/shared", true);
    prompts.value = out;
    promptsAt = Date.now();
  }

  const SLASH_CORE: readonly CommandeSlash[] = [
    {
      name: "skills",
      label: "Skills",
      icon: "ph-graduation-cap",
      desc: "Parcourir et épingler un skill dans le prompt",
      mode: "skills",
    },
    {
      name: "prompt",
      label: "Prompts",
      icon: "ph-bookmark-simple",
      desc: "Reprendre un prompt sauvegardé ou reçu",
      mode: "prompts",
    },
    {
      name: "template",
      label: "Templates",
      icon: "ph-brackets-curly",
      desc: "Insérer un template de prompt, variables à remplir",
      args: [
        {
          name: "nom",
          label: "nom",
          get values(): ValeurArgument[] {
            const liste = templates ? templates.templatesAll.value : [];
            return liste
              .map((t): ValeurArgument => ({ value: t.name, label: t.title || t.name }))
              .concat([{ value: "+", label: "Nouveau template", last: true }]);
          },
        },
      ],
      when: () => !!templates,
      whenLabel: "Indisponible",
      run: async (a) => (templates ? templates.runTemplateByName(a[0] || "") : null),
    },
    {
      name: "plan",
      label: "Mode plan",
      icon: "ph-binoculars",
      desc: "Préparer un plan : outils d'écriture retirés jusqu'à la réponse",
      // Bascule immédiate ; bloquée pendant une génération (le tour en cours a déjà ses outils).
      when: (e) => !e.isStreaming,
      whenLabel: "Hors génération",
      run: async (a) => {
        const avant = !!env().planMode;
        const on = a[0] === "on" ? true : a[0] === "off" ? false : !avant;
        if (on === avant)
          return { ok: true, info: true, msg: "Mode plan déjà " + (on ? "actif." : "coupé.") };
        const ok = await ctx.setPlanMode?.(on);
        if (!ok) return { ok: false, msg: "Bascule impossible." };
        if (on && !env().chatId)
          return { ok: true, msg: "Mode plan armé — la " + "conversation démarrera sans outils d'écriture." };
        return {
          ok: true,
          msg: on ? "Mode plan actif — outils d'écriture retirés jusqu'à la réponse." : "Mode plan coupé.",
        };
      },
    },
    {
      name: "image",
      label: "Images",
      icon: "ph-image",
      desc: "Générer une image : /image 16:9 x2 description",
      hidden: (e) => !e.imageAvailable,
      when: (e) => !e.isStreaming,
      whenLabel: "Hors génération",
      run: async (_a, raw) =>
        ctx.imageSlash ? ctx.imageSlash(raw) : { ok: false, msg: "Génération d’images indisponible." },
    },
    {
      name: "rag",
      label: "RAG",
      icon: "ph-books",
      desc: "Interroger vos collections : /rag use, off, search, add, new, status, open",
      args: [
        {
          name: "action",
          label: "action",
          ordreDonne: true,
          titre: () => "RAG",
          get values(): ValeurArgument[] {
            return [...(ctx.rag?.valeurs([]) ?? [])];
          },
        },
        {
          name: "cible",
          label: "collection",
          values: [],
          ordreDonne: true,
          libre: true,
          titre: (avant) =>
            avant[0] === "use"
              ? "Collection à interroger"
              : avant[0] === "add"
                ? "Collection à enrichir"
                : "Collection à ouvrir",
          valuesFor: (avant) => [...(ctx.rag?.valeurs(avant) ?? [])],
        },
      ],
      // « off », « status » et « open » se lancent d'eux-mêmes ; les autres attendent leur argument.
      complet: (mots) =>
        mots[0] === "off" ||
        mots[0] === "status" ||
        mots[0] === "open" ||
        ((mots[0] === "use" || mots[0] === "add") && mots.length >= 2),
      hidden: () => !ctx.rag || !ctx.rag.disponible(),
      run: async (_a, raw) => (ctx.rag ? ctx.rag.lancer(raw) : { ok: false, msg: "RAG indisponible." }),
    },
    {
      name: "jobs",
      label: "Tâches de fond",
      icon: "ph-timer",
      desc: "Lister les tâches de fond : /jobs, /jobs all, /jobs stop <id|all>",
      args: [
        {
          name: "action",
          label: "action",
          ordreDonne: true,
          values: [
            { value: "list", label: "Cette conversation" },
            { value: "all", label: "Toutes les conversations" },
            { value: "stop", label: "Arrêter une tâche" },
          ],
        },
        {
          name: "tâche",
          label: "tâche",
          values: [],
          valuesFor: (avant) =>
            avant[0] === "stop"
              ? [
                  { value: "all", label: "Toutes celles de la conversation" },
                  ...(ctx.jobs?.ids() ?? []).map((v): ValeurArgument => ({ ...v })),
                ]
              : [],
        },
      ],
      sansArgument: ["list"],
      complet: (mots) => mots[0] === "list" || mots[0] === "all" || (mots[0] === "stop" && mots.length >= 2),
      when: () => !!ctx.jobs,
      whenLabel: "Indisponible",
      run: async (a) => {
        const jobs = ctx.jobs;
        if (!jobs) return { ok: false, msg: "Tâches de fond indisponibles." };
        const [verbe, cible] = a;
        if (!verbe || verbe === "list") return jobs.lister("chat");
        if (verbe === "all") return jobs.lister("all");
        if (verbe === "stop" && cible) {
          if (cible !== "all" && !/^j-[0-9a-f]{8}$/.test(cible))
            return { ok: false, msg: "Identifiant de tâche invalide : " + cible };
          return jobs.arreter(cible);
        }
        return { ok: false, msg: "Usage : /jobs [all] ou /jobs stop <id|all>" };
      },
    },
    {
      name: "compact",
      label: "Compacter",
      icon: "ph-arrows-in-simple",
      desc: "Résume l'historique ancien pour libérer du contexte",
      when: (e) => !!e.chatId && !e.isStreaming,
      whenLabel: "Demande une conversation en cours, hors génération",
      // La compaction a sa propre progression puis sa notice : pas de toast en plus.
      run: async () => {
        await ctx.manualCompress?.();
        return { ok: true, silent: true };
      },
    },
    {
      name: "settings",
      label: "Réglages",
      icon: "ph-gear",
      desc: "Ouvrir les réglages sur un onglet",
      args: [{ name: "onglet", label: "onglet", values: SETTINGS_TABS }],
      run: async (a) => {
        const tab = a[0] ? SETTINGS_TABS.find((t) => t.value === a[0]) || null : null;
        if (a[0] && !tab) return { ok: false, msg: "Onglet inconnu : " + a[0] };
        await ctx.openSettingsTab?.(tab ? tab.value : null);
        return { ok: true, silent: true };
      },
    },
    {
      name: "memory",
      label: "Mémoire",
      icon: "ph-brain",
      desc: "Ouvrir la mémoire long terme",
      run: async () => {
        await ctx.openSettingsTab?.("memory");
        return { ok: true, silent: true };
      },
    },
    {
      name: "usage",
      label: "Utilisation",
      icon: "ph-chart-bar",
      desc: "Ouvrir votre consommation",
      run: async () => {
        await ctx.openSettingsTab?.("usage");
        return { ok: true, silent: true };
      },
    },
    {
      name: "help",
      label: "Aide",
      icon: "ph-question",
      desc: "Ouvrir la documentation",
      run: async () => {
        await ctx.openHelp?.();
        return { ok: true, silent: true };
      },
    },
  ];

  function cachee(cmd: CommandeSlash): boolean {
    if (typeof cmd.hidden !== "function") return false;
    try {
      return !!cmd.hidden(env());
    } catch {
      return false;
    }
  }

  function trouver(name: unknown): CommandeSlash | null {
    const n = String(name || "").toLowerCase();
    return SLASH_CORE.find((c) => c.name === n && !cachee(c)) || null;
  }

  function slashCmdOk(cmd: CommandeSlash | null | undefined): boolean {
    if (!cmd || typeof cmd.when !== "function") return true;
    try {
      return !!cmd.when(env());
    } catch {
      return true;
    }
  }

  // Deux régimes : tête « /nom arg1 arg2 » (arguments admis) et en ligne « …texte /frag » (sans argument).
  function contexteSaisie(): ContexteSaisie | null {
    const el = inputRef.value;
    if (!el) return null;
    const cursor = el.selectionStart;
    const avant = (inputMessage.value || "").substring(0, cursor);
    const tete = avant.match(/^\/([\w.-]*)((?:[ \t]+[^\n]*)?)$/);
    if (tete) {
      const brut = (tete[2] || "").replace(/^[ \t]+/, "");
      return {
        head: true,
        name: tete[1] ?? "",
        raw: brut,
        words: brut ? brut.split(/[ \t]+/) : [],
        hasSpace: !!tete[2],
        trailing: /[ \t]$/.test(avant),
        start: 0,
        end: cursor,
      };
    }
    const m = avant.match(/(?:^|\s)\/([\w.-]*)$/);
    const nom = m ? (m[1] ?? "") : "";
    return m
      ? {
          head: false,
          name: nom,
          raw: "",
          words: [],
          hasSpace: false,
          trailing: false,
          start: cursor - nom.length - 1,
          end: cursor,
        }
      : null;
  }

  const requete = computed(() => (slashRaw.value?.name || "").toLowerCase());
  const slashCmdList = computed(() =>
    paquets(
      SLASH_CORE.filter((c) => !cachee(c)),
      requete.value,
      (c) => c.name,
    ),
  );
  const slashSkillList = computed(() => {
    const q = requete.value.trim();
    const liste = !q
      ? skills.value
      : skills.value.filter((s) =>
          [s.name, s.description, s.domain, (s.tags || []).join(" ")].join(" ").toLowerCase().includes(q),
        );
    return liste
      .slice()
      .sort(
        (a, b) =>
          (a.domain || "").localeCompare(b.domain || "") || (a.name || "").localeCompare(b.name || ""),
      );
  });
  const slashPromptList = computed(() => {
    const q = requete.value.trim();
    if (!q) return prompts.value.slice();
    return prompts.value.filter((p) => (p.title + " " + p.content).toLowerCase().includes(q));
  });
  interface PositionArgument {
    cmd: CommandeSlash;
    spec: SpecArgument;
    mots: string[];
    /** Rang du mot en cours de saisie. */
    i: number;
    /** Rang de la spécification d'argument qui s'applique. */
    rang: number;
  }

  function positionArgument(): PositionArgument | null {
    const c = slashRaw.value;
    const cmd = c && c.head ? trouver(c.name) : null;
    if (!c || !cmd || !(cmd.args || []).length) return null;
    const args = cmd.args || [];
    const mots = c.words.filter(Boolean);
    const i = c.trailing ? mots.length : Math.max(0, mots.length - 1);
    const rang = Math.min(i, args.length - 1);
    const spec = args[rang];
    return spec ? { cmd, spec, mots, i, rang } : null;
  }

  const slashValueList = computed((): ValeurArgument[] => {
    const c = slashRaw.value;
    const pos = positionArgument();
    if (!c || !pos) return [];
    const { spec, mots, i, rang } = pos;
    if (!(spec.values || spec.valuesFor)) return [];
    const valeurs = spec.valuesFor ? spec.valuesFor(mots.slice(0, i)) : spec.values;
    // Un argument libre est filtré par tout ce qui a été tapé depuis son rang (un nom de plusieurs mots).
    const q = (
      spec.libre && i >= rang
        ? mots.slice(rang).join(" ") + (c.trailing && mots.length > rang ? " " : "")
        : c.trailing
          ? ""
          : mots[mots.length - 1] || ""
    ).toLowerCase();
    // La rangée d'action (« Nouveau template ») reste en dernier, hors filtre.
    const tries = spec.ordreDonne
      ? valeurs.filter((v) => !v.last && v.value.toLowerCase().includes(q))
      : paquets(
          valeurs.filter((v) => !v.last),
          q,
          (v) => v.value,
        );
    return q ? tries : tries.concat(valeurs.filter((v) => v.last));
  });

  const slashLevel = computed((): Niveau => {
    const c = slashRaw.value;
    if (!c) return "commands";
    if (slashSub.value && !c.hasSpace) return slashSub.value;
    if (c.head) {
      const exacte = trouver(c.name);
      if (exacte && c.hasSpace && (exacte.args || []).length) return "values";
    }
    if (slashCmdList.value.length) return "commands";
    // Aucune commande ne correspond : la frappe filtre les skills (geste du menu /skill historique).
    return "skills";
  });

  const slashList = computed((): readonly Rangee[] => {
    switch (slashLevel.value) {
      case "values":
        return slashValueList.value;
      case "skills":
        return slashSkillList.value;
      case "prompts":
        return slashPromptList.value;
      default:
        return slashCmdList.value;
    }
  });

  const showSlash = computed(
    () =>
      slashRaw.value !== null &&
      !slashDismissed.value &&
      !(showMentionDropdown && showMentionDropdown.value) &&
      slashList.value.length > 0,
  );

  function remplacer(c: ContexteSaisie | null, texte: string): void {
    if (!c) return;
    const avant = (inputMessage.value || "").substring(0, c.start);
    const apres = (inputMessage.value || "").substring(c.end);
    inputMessage.value = avant + texte + apres;
    const pos = c.start + texte.length;
    void nextTick(() => {
      if (inputRef.value) {
        inputRef.value.setSelectionRange(pos, pos);
        inputRef.value.focus();
      }
      ctx.autoResize?.();
    });
  }

  function rafraichir(): void {
    slashRaw.value = contexteSaisie();
    if (slashRaw.value === null) slashSub.value = null;
    slashIdx.value = 0;
  }

  async function slashRun(hit: Commande | null | undefined): Promise<void> {
    if (!hit || !hit.cmd) return;
    const cmd = hit.cmd;
    if (!slashCmdOk(cmd)) {
      showToast(cmd.whenLabel || "Indisponible ici.", "error");
      return;
    }
    let out: ResultatCommande | null | undefined;
    try {
      out = cmd.run ? await cmd.run(hit.args || [], hit.raw || "") : null;
    } catch {
      showToast("Échec de /" + cmd.name, "error");
      return;
    }
    const r = out || { ok: true };
    // Une commande confirme toujours, sauf celles qui ont leur propre rendu.
    if (!r.silent && r.msg) showToast(r.msg, r.ok ? (r.info ? "info" : "success") : "error");
  }

  async function consommerPuisLancer(cmd: CommandeSlash, args: string[], raw: string): Promise<void> {
    remplacer(slashRaw.value, "");
    slashDismissed.value = true;
    slashSub.value = null;
    await slashRun({ cmd, args, raw });
  }

  async function selectSlash(item: Rangee | null | undefined): Promise<void> {
    if (!item) return;
    const niveau = slashLevel.value;
    if (niveau === "skills") return selectSkill(item as Skill);
    if (niveau === "prompts") return selectPrompt(item as PromptSlash);
    if (niveau === "values") return selectValue(item as ValeurArgument);
    const cmd = item as CommandeSlash;
    if (cmd.mode) {
      remplacer(slashRaw.value, "/");
      slashSub.value = cmd.mode;
      if (cmd.mode === "skills") await chargerSkills();
      if (cmd.mode === "prompts") await chargerPrompts();
      void nextTick(rafraichir);
      return;
    }
    const tape = slashRaw.value;
    if (cmd.sansArgument && tape && tape.head && !tape.trailing && tape.name === cmd.name) {
      await consommerPuisLancer(cmd, [...cmd.sansArgument], cmd.sansArgument.join(" "));
      return;
    }
    if ((cmd.args || []).length) {
      if (cmd.name === "template" && templates) await templates.loadTemplates();
      remplacer(slashRaw.value, "/" + cmd.name + " ");
      void nextTick(rafraichir);
      return;
    }
    // Arguments tapés à la main : relayés seulement si la rangée validée est la commande tapée.
    const c = slashRaw.value;
    const mots =
      c && c.head && Array.isArray(c.words) && trouver(c.name) === cmd ? c.words.filter(Boolean) : [];
    await consommerPuisLancer(cmd, mots, mots.join(" "));
  }

  async function selectValue(v: ValeurArgument | null | undefined): Promise<void> {
    const c = slashRaw.value;
    if (!c || !c.head || !v) return;
    const cmd = trouver(c.name);
    if (!cmd) return;
    const pos = positionArgument();
    const saisis = c.words.filter(Boolean);
    // Argument libre : le choix remplace tout ce qui a été tapé depuis son rang (« Procédures ré » devient « Procédures réseau »).
    const mots =
      pos && pos.spec.libre && pos.i >= pos.rang
        ? saisis.slice(0, pos.rang)
        : c.trailing
          ? saisis
          : saisis.slice(0, -1);
    mots.push(v.value);
    if (cmd.complet ? cmd.complet(mots) : mots.length >= (cmd.args || []).length) {
      await consommerPuisLancer(cmd, mots, mots.join(" "));
      return;
    }
    remplacer(c, "/" + cmd.name + " " + mots.join(" ") + " ");
    void nextTick(rafraichir);
  }

  function selectSkill(skill: Skill | null | undefined): void {
    if (!skill || !skill.name) return;
    remplacer(slashRaw.value, "");
    slashDismissed.value = true;
    slashSub.value = null;
    if (pinnedSkills.value.some((s) => s.name === skill.name)) return;
    pinnedSkills.value.push({
      name: skill.name,
      description: skill.description || "",
      domain: skill.domain || "",
    });
  }

  function removePinnedSkill(nom: string): void {
    pinnedSkills.value = pinnedSkills.value.filter((s) => s.name !== nom);
  }

  // Le prompt est inséré, jamais envoyé : l'utilisateur relit puis décide.
  function selectPrompt(p: PromptSlash | null | undefined): void {
    if (!p || !p.content) return;
    remplacer(slashRaw.value, "");
    slashDismissed.value = true;
    slashSub.value = null;
    void nextTick(() => {
      inputMessage.value = p.content;
      void nextTick(() => {
        if (inputRef.value) {
          const n = (p.content || "").length;
          inputRef.value.setSelectionRange(n, n);
          inputRef.value.focus();
        }
        ctx.autoResize?.();
      });
    });
  }

  // Commande tapée en entier puis Entrée : exécutée au lieu de partir au modèle ; inconnue → null (envoi normal).
  function slashResolve(texte: string): Commande | null {
    const m = String(texte || "")
      .trim()
      .match(/^\/([\w.-]+)(?:[ \t]+([\s\S]*))?$/);
    if (!m) return null;
    const cmd = trouver(m[1]);
    if (!cmd || cmd.mode) return null;
    const raw = (m[2] || "").trim();
    return { cmd, raw, args: raw ? raw.split(/[ \t]+/) : [] };
  }

  function slashSetIdx(i: number): void {
    slashIdx.value = i;
  }

  function slashDismiss(): void {
    slashDismissed.value = true;
  }

  function resetSlash(): void {
    slashRaw.value = null;
    slashSub.value = null;
    slashDismissed.value = false;
    slashIdx.value = 0;
  }

  function onInput(): void {
    slashDismissed.value = false;
    rafraichir();
    const c = slashRaw.value;
    if (c === null) return;
    const niveau = slashLevel.value;
    if (niveau === "skills" || slashSub.value === "skills") void chargerSkills();
    if (niveau === "prompts" || slashSub.value === "prompts") void chargerPrompts();
    if (c.head && "jobs".startsWith(String(c.name || "").toLowerCase()) && String(c.name || "").length >= 2)
      ctx.jobs?.actualiser();
    if (c.head && c.name.toLowerCase() === "rag") ctx.rag?.actualiser();
    if (
      templates &&
      c.head &&
      "template".startsWith(String(c.name || "").toLowerCase()) &&
      String(c.name || "").length >= 2
    )
      void templates.loadTemplates();
  }

  // Rend vrai si la touche est consommée ; la ligne active est gardée visible par MenuSlash.vue.
  function slashKeydown(e: KeyboardEvent): boolean {
    if (!showSlash.value) return false;
    const liste = slashList.value;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      slashIdx.value = Math.min(slashIdx.value + 1, liste.length - 1);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      slashIdx.value = Math.max(slashIdx.value - 1, 0);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const choisie = liste[slashIdx.value];
      if (choisie) void selectSlash(choisie);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      slashDismiss();
      return true;
    }
    return false;
  }

  const slashHeaderIcon = computed(() => HEADER_ICON[slashLevel.value] || "ph-terminal");
  const slashHeaderLabel = computed(() => {
    const pos = slashLevel.value === "values" ? positionArgument() : null;
    const titre = pos?.spec.titre?.(pos.mots.slice(0, pos.rang));
    return titre || HEADER_LABEL[slashLevel.value] || "Commandes";
  });
  const slashHeaderCmd = computed(() => {
    const c = slashRaw.value;
    if (!c || !c.name) return "";
    const pos = slashLevel.value === "values" ? positionArgument() : null;
    const avant = pos && pos.spec.titre ? pos.mots.slice(0, pos.rang) : [];
    return "/" + [c.name, ...avant].join(" ");
  });

  function slashRowKey(item: Rangee | null | undefined, i: number): string {
    const r = item as unknown as Record<string, unknown> | null | undefined;
    const k = r && (r.name || r.value || r.id);
    return k != null ? String(k) : "row-" + i;
  }

  function promptPreview(p: PromptSlash | null | undefined): string {
    const t = String(p?.content || "")
      .replace(/\s+/g, " ")
      .trim();
    return t.length > 90 ? t.slice(0, 90) + "…" : t;
  }

  // Infobulle : texte complet, et pour une commande indisponible, la raison.
  function slashRowTitle(item: Rangee | null | undefined): string {
    if (!item) return "";
    const r = item as unknown as Record<string, unknown>;
    switch (slashLevel.value) {
      case "commands":
        return String((slashCmdOk(item as CommandeSlash) ? r.desc : r.whenLabel) || "");
      case "values":
        return String(r.label || "");
      case "prompts":
        return String(r.content || "");
      default:
        return String(r.description || "");
    }
  }

  return {
    showSlash,
    slashLevel,
    slashList,
    slashIdx,
    slashRaw,
    pinnedSkills,
    selectSlash,
    selectValue,
    selectSkill,
    selectPrompt,
    removePinnedSkill,
    slashDismiss,
    slashSetIdx,
    resetSlash,
    slashKeydown,
    onInput,
    slashResolve,
    slashRun,
    slashCmdOk,
    slashRowKey,
    promptPreview,
    slashRowTitle,
    slashHeaderIcon,
    slashHeaderLabel,
    slashHeaderCmd,
  };
}
