// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/deltas-outils.ts — écriture en direct dans l'éditeur des appels `write_file`/`edit_file` (portée d'`app-chat.js`) : arguments JSON décodés au fil des fragments, flux Monaco ouverts, clos et annulés, libellé de statut des appels en génération. */
import {
  extractJsonScalar,
  makeToolStreamKey,
  pullJsonStringField,
  reEsc,
} from "../../../utils/helpers-json.ts";
import type { EtatChampChaine } from "../../../utils/helpers-json.ts";
import { fmtTokens, PREFIXE_STATUT_DELTA } from "./formats.ts";
import type { CoeurChat } from "./liens.ts";
import type { DonneesFlux } from "./types.ts";

interface EtatEcriture {
  key: string;
  chatId: string;
  iter: number;
  index: number;
  nameBuf: string;
  argsBuf: string;
  toolName: string;
  toolKind: "write" | "edit" | null;
  path: string | null;
  relPath: string | null;
  mode: string | null;
  action: string | null;
  oldStrState: EtatChampChaine | null;
  oldStr: string | null;
  startLine: number | null;
  endLine: number | null;
  opened: boolean;
  failed: boolean;
  streamFieldState: EtatChampChaine | null;
  streamField: "content" | "new_str" | null;
  preSnapshot?: string | null;
  markerFor?: string;
  markerRe?: RegExp;
  markerScan?: number;
}

const libre = (v: unknown): boolean => !v || v === "local" || String(v).startsWith("__");

export function creerDeltasOutils(c: CoeurChat) {
  const { r, ctx, l } = c;
  const etats = new Map<string, EtatEcriture>();
  // File par clé : un fragment ne s'exécute qu'après le précédent (ordre du curseur Monaco).
  const files = new Map<string, Promise<void>>();
  const nomsDelta = new Map<string, string>();
  const taillesDelta = new Map<string, number>();
  let libelleDelta = "";

  function finaliserSansSucces(st: EtatEcriture): void {
    if (st.opened && !st.failed && st.path)
      try {
        void ctx.streamFinalize?.(st.path, { success: false });
      } catch {
        /* éditeur absent */
      }
  }

  // Ferme les flux d'une conversation (`local` et ids provisoires : sans conversation, fermés avec tout appelant).
  function closeToolStreamsFor(chatId: string | null): void {
    const cid = chatId == null ? "" : String(chatId);
    for (const [k, v] of Array.from(etats.entries())) {
      if (cid && !libre(cid) && !libre(v.chatId) && String(v.chatId) !== cid) continue;
      finaliserSansSucces(v);
      etats.delete(k);
      files.delete(k);
    }
  }

  function clearToolStreams(): void {
    etats.clear();
    files.clear();
  }

  function handleToolCallDelta(data: DonneesFlux, chatId: string, sansOuverture: boolean): Promise<void> {
    const key = makeToolStreamKey(chatId, data.iter, data.index);
    const avant = files.get(key) || Promise.resolve();
    const suite = avant.then(
      () => traiterDelta(data, chatId, sansOuverture),
      () => traiterDelta(data, chatId, sansOuverture),
    );
    files.set(key, suite);
    void suite
      .finally(() => {
        if (files.get(key) === suite) files.delete(key);
      })
      .catch(() => undefined);
    return suite;
  }

  async function prechargeSiFerme(path: string): Promise<{ ouvert: boolean; contenu: string | null }> {
    const modeles = ctx.models;
    const m = modeles ? modeles[path] : undefined;
    if (m && !m.isDisposed()) return { ouvert: true, contenu: null };
    return { ouvert: false, contenu: await l.prefetchSandboxFile(path) };
  }

  // Les scalaires précèdent le champ streamé : extraits seulement avant l'ouverture (sinon O(n²)).
  function extraireScalaires(st: EtatEcriture): void {
    if (!st.path) {
      const p = extractJsonScalar(st.argsBuf, "path");
      if (p && p.type === "string") {
        st.path = p.value;
        st.relPath = l.relPath(p.value);
      }
    }
    if (st.toolKind === "write" && !st.mode) {
      const mo = extractJsonScalar(st.argsBuf, "mode");
      if (mo && mo.type === "string") st.mode = mo.value.toLowerCase();
    }
    if (st.toolKind !== "edit") return;
    if (!st.action) {
      const ac = extractJsonScalar(st.argsBuf, "action");
      if (ac && ac.type === "string") st.action = ac.value.toLowerCase();
    }
    if (st.startLine === null) {
      const sl = extractJsonScalar(st.argsBuf, "start_line");
      if (sl && sl.type === "number") st.startLine = sl.value;
    }
    if (st.endLine === null) {
      const el = extractJsonScalar(st.argsBuf, "end_line");
      if (el && el.type === "number") st.endLine = el.value;
    }
    if (st.oldStr === null && st.action === "str_replace") {
      st.oldStrState ??= {};
      const res = pullJsonStringField(st.argsBuf, "old_str", st.oldStrState);
      if (res.found && res.complete) {
        const os = extractJsonScalar(st.argsBuf, "old_str");
        if (os && os.type === "string") st.oldStr = os.value;
      }
    }
  }

  // Ouverture : rendue `null` tant qu'il faut attendre, `false` pour abandonner, `true` si le flux est ouvert.
  async function ouvrir(st: EtatEcriture, path: string): Promise<boolean | null> {
    if (st.toolKind === "write") {
      const mode = st.mode || "write";
      if (mode === "b64" || mode === "mkdir") return false;
      let pre: string | null = null;
      if (mode === "append") pre = (await prechargeSiFerme(path)).contenu;
      st.streamField = "content";
      return (
        (await ctx.streamOpenForWrite?.(path, { append: mode === "append", preloadContent: pre })) ?? false
      );
    }
    if (!st.action) return null;
    if (st.action === "delete") return false;
    const pre = await prechargeSiFerme(path);
    if (!pre.ouvert && pre.contenu === null) return false;
    const preloadContent = pre.contenu;
    const localiser = (o: Record<string, unknown>): Promise<boolean> =>
      ctx.streamLocateEdit ? ctx.streamLocateEdit(path, { ...o, preloadContent }) : Promise.resolve(false);
    if (st.action === "str_replace") {
      if (st.oldStr === null) return null;
      st.streamField = "new_str";
      return localiser({ action: "str_replace", old_str: st.oldStr });
    }
    if (st.action === "replace") {
      if (st.startLine === null || st.endLine === null) return null;
      st.streamField = "content";
      return localiser({ action: "replace", start_line: st.startLine, end_line: st.endLine });
    }
    if (st.action === "insert") {
      if (st.startLine === null) return null;
      st.streamField = "content";
      return localiser({ action: "insert", start_line: st.startLine });
    }
    return false;
  }

  async function traiterDelta(data: DonneesFlux, chatId: string, sansOuverture: boolean): Promise<void> {
    if (!r.settings.value.enable_editor) return;
    const key = makeToolStreamKey(chatId, data.iter, data.index);
    let st = etats.get(key);
    // Rejeu d'un journal : écritures déjà faites, seul un flux déjà ouvert continue.
    if (sansOuverture && !st?.opened) return;
    if (!st) {
      st = {
        key,
        chatId,
        iter: Number(data.iter) || 0,
        index: Number(data.index) || 0,
        nameBuf: "",
        argsBuf: "",
        toolName: "",
        toolKind: null,
        path: null,
        relPath: null,
        mode: null,
        action: null,
        oldStrState: null,
        oldStr: null,
        startLine: null,
        endLine: null,
        opened: false,
        failed: false,
        streamFieldState: null,
        streamField: null,
      };
      etats.set(key, st);
    }
    if (st.failed) return;
    if (data.name_delta) st.nameBuf += data.name_delta;
    if (data.args_delta) st.argsBuf += data.args_delta;
    if (!st.toolKind && st.nameBuf) {
      const n = st.nameBuf;
      if (/(^|_)write_file$/.test(n)) {
        st.toolKind = "write";
        st.toolName = "write_file";
      } else if (/(^|_)edit_file$/.test(n)) {
        st.toolKind = "edit";
        st.toolName = "edit_file";
      } else if (st.argsBuf.length > 0 || n.length > 40) {
        st.failed = true;
        return;
      }
    }
    if (!st.toolKind) return;
    if (!st.opened) extraireScalaires(st);
    if (!st.opened && !st.failed && st.path) {
      if (st.toolKind === "edit" && !st.action) return;
      const champ = st.toolKind === "edit" && st.action === "str_replace" ? "new_str" : "content";
      // Marqueur du champ streamé cherché dans la queue du tampon seulement (64 caractères de recouvrement).
      if (st.markerFor !== champ || !st.markerRe) {
        st.markerFor = champ;
        st.markerRe = new RegExp('"' + reEsc(champ) + '"\\s*:\\s*"');
        st.markerScan = 0;
      }
      const vu = st.markerRe.test(st.argsBuf.slice(Math.max(0, (st.markerScan || 0) - 64)));
      st.markerScan = st.argsBuf.length;
      if (!vu) return;
      const ouvert = await ouvrir(st, st.path);
      if (ouvert === null) return;
      // État purgé pendant les attentes : un flux ouvert sur un état détaché serait orphelin.
      if (etats.get(key) !== st) {
        if (ouvert) finaliserSansSucces({ ...st, opened: true, failed: false });
        return;
      }
      if (!ouvert) {
        st.failed = true;
        return;
      }
      st.opened = true;
      st.streamFieldState = {};
      ctx.showToast("Édition : " + (st.relPath || st.path) + "…");
    }
    if (st.opened && st.streamField && st.streamFieldState && st.path) {
      const res = pullJsonStringField(st.argsBuf, st.streamField, st.streamFieldState);
      if (res.chunk) ctx.streamWriteChunk?.(st.path, res.chunk);
      if (res.complete && st.toolKind === "edit" && st.action === "insert" && Number(st.startLine) === 0)
        if (res.chunk && !res.chunk.endsWith("\n")) ctx.streamWriteChunk?.(st.path, "\n");
    }
  }

  /** Clôt le flux du plus ancien appel ouvert de ce chat dont le nom correspond au résultat. */
  async function finalizeToolStream(
    data: DonneesFlux,
    chatId: string,
    o: { resultStr?: unknown; finalContent: string | null; disk: unknown },
  ): Promise<{ handled: boolean; ok?: boolean; path?: string; preSnapshot?: string | null }> {
    const enVol: Promise<void>[] = [];
    for (const [k, p] of files.entries()) if (k.startsWith((chatId || "local") + ":")) enVol.push(p);
    if (enVol.length) await Promise.all(enVol.map((p) => p.catch(() => undefined)));
    const nomResultat = String(data.name || "").toLowerCase();
    const entrees = [...etats.entries()]
      .filter(([, v]) => v.chatId === chatId && v.opened && !v.failed)
      .sort(([, a], [, b]) => a.iter - b.iter || a.index - b.index);
    let choisie = entrees.find(([, v]) => {
      const n = (v.toolName || "").toLowerCase();
      return !n || nomResultat.endsWith(n) || n.endsWith(nomResultat);
    });
    choisie ??= entrees[0];
    if (!choisie) return { handled: false };
    const [cle, meilleur] = choisie;
    let ok = true;
    try {
      const p: unknown = JSON.parse(typeof o.resultStr === "string" && o.resultStr ? o.resultStr : "{}");
      if (p && typeof p === "object" && (p as { ok?: unknown }).ok === false) ok = false;
    } catch {
      /* résultat non JSON */
    }
    const preSnapshot = meilleur.preSnapshot || null;
    const chemin = meilleur.path || "";
    etats.delete(cle);
    await ctx.streamFinalize?.(chemin, { success: ok, finalContent: o.finalContent, disk: o.disk || null });
    return { handled: true, ok, path: chemin, preSnapshot };
  }

  // Un flux encore ouvert ici n'a jamais reçu son résultat : l'éditeur retrouve son état d'avant.
  function purgeToolStreams(chatId: string): void {
    for (const [k, v] of Array.from(etats.entries())) {
      if (v.chatId !== chatId) continue;
      finaliserSansSucces(v);
      etats.delete(k);
    }
  }

  /** Erreur du tour : flux encore ouverts de ce chat annulés (attendus), puis purgés. */
  async function finalizeAllToolStreams(chatId?: string): Promise<void> {
    for (const v of Array.from(etats.values())) {
      if (chatId !== undefined && v.chatId !== chatId) continue;
      if (v.opened && !v.failed && v.path)
        try {
          await ctx.streamFinalize?.(v.path, { success: false });
        } catch {
          /* éditeur absent */
        }
    }
    if (chatId !== undefined) purgeToolStreams(chatId);
  }

  /** Stop : tous les flux ouverts sont annulés, l'état vidé. */
  function cancelAllToolStreams(): void {
    for (const v of etats.values()) finaliserSansSucces(v);
    etats.clear();
  }

  // Itération rejouée ou abandonnée : ses accumulateurs sont jetés, l'éditeur revient à son état d'avant.
  async function resetToolStreamsForIter(chatId: string, iter: unknown): Promise<void> {
    const pref = chatId + ":" + String(iter) + ":";
    const enVol: Promise<void>[] = [];
    for (const [k, p] of files.entries()) if (k.startsWith(pref)) enVol.push(p.catch(() => undefined));
    if (enVol.length) await Promise.all(enVol);
    for (const [k, v] of Array.from(etats.entries())) {
      if (v.chatId !== chatId || v.iter !== iter) continue;
      finaliserSansSucces(v);
      etats.delete(k);
    }
  }

  // Arguments d'un appel en génération (nom, taille reçue dès 1000 caractères) : libellé posé seulement quand il change.
  function noteDeltaStatus(data: DonneesFlux, idx: number): void {
    const k = String(data.iter) + ":" + String(data.index);
    const nom = (nomsDelta.get(k) || "") + (data.name_delta || "");
    if (data.name_delta) nomsDelta.set(k, nom);
    const taille = (taillesDelta.get(k) || 0) + (data.args_delta || "").length;
    taillesDelta.set(k, taille);
    const volume = taille >= 1000 ? " (" + fmtTokens(taille) + " caractères)" : "";
    const libelle = PREFIXE_STATUT_DELTA + (nom ? " · " + nom : "") + volume + "…";
    if (libelle === libelleDelta) return;
    const cur = l.getStreamMsgs()[idx];
    if (!cur) return;
    if (cur._statusLine && !cur._statusLine.startsWith(PREFIXE_STATUT_DELTA)) return;
    libelleDelta = libelle;
    l.patch(idx, { _statusLine: libelle });
  }

  function forgetDeltaNames(iter: unknown): void {
    for (const carte of [nomsDelta, taillesDelta])
      for (const k of Array.from(carte.keys())) if (k.startsWith(String(iter) + ":")) carte.delete(k);
    libelleDelta = "";
  }

  function resetDeltaStatus(): void {
    nomsDelta.clear();
    taillesDelta.clear();
    libelleDelta = "";
  }

  function oublierLibelleDelta(): void {
    libelleDelta = "";
  }

  return {
    closeToolStreamsFor,
    clearToolStreams,
    handleToolCallDelta,
    finalizeToolStream,
    purgeToolStreams,
    finalizeAllToolStreams,
    cancelAllToolStreams,
    resetToolStreamsForIter,
    noteDeltaStatus,
    forgetDeltaNames,
    resetDeltaStatus,
    oublierLibelleDelta,
  };
}
