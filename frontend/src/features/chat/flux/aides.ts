// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/flux/aides.ts — petits utilitaires du flux d'appels d'outils : chemin affichable, lecture d'un fichier du bac, instantané d'avant écriture sur le message (porté de `chat/_helpers_misc.js`). */
import type { Ref } from "vue";

import { canonPath } from "../../../utils/utils-purs.ts";

export type FetchAuth = (url: string, init?: RequestInit, soft?: boolean) => Promise<Response | null>;

export interface MessageDiff {
  _diffFiles?: Record<string, string | null> | null;
  [cle: string]: unknown;
}

export interface CtxAidesFlux {
  fetchAuth: FetchAuth;
  _getStreamMsgs(): readonly MessageDiff[];
  _patch(idx: number, patch: Record<string, unknown>): void;
}

export function setupChatHelpersMisc(
  _vue: unknown,
  refs: { settings: Ref<{ sandbox_path_display?: string | null }> },
  ctx: CtxAidesFlux,
) {
  const { settings } = refs;

  /** Chemin du bac ramené à sa forme affichable (même canonisation que l'éditeur). */
  function _relPath<T>(p: T): T | string {
    if (!p) return p;
    return canonPath(p, settings.value.sandbox_path_display);
  }

  async function _prefetchSandboxFile(path: string): Promise<string | null> {
    try {
      const res = await ctx.fetchAuth("/api/sandbox/download?path=" + encodeURIComponent(path), {}, true);
      if (res && res.ok) return await res.text();
    } catch {
      /* non bloquant */
    }
    return null;
  }

  /** Garde l'instantané du premier appel de ce tour pour chaque chemin (le diff couvre tout le tour). */
  function _recordDiffForMessage(msgIdx: number, path: string, before: string | null): void {
    if (msgIdx < 0) return;
    const cur = ctx._getStreamMsgs()[msgIdx];
    if (!cur) return;
    const prev = cur._diffFiles || {};
    if (prev[path] !== undefined) {
      ctx._patch(msgIdx, { _diffPath: path, _diffBefore: prev[path] });
      return;
    }
    ctx._patch(msgIdx, {
      _diffFiles: { ...prev, [path]: before },
      _diffPath: path,
      _diffBefore: before,
    });
  }

  return { _relPath, _prefetchSandboxFile, _recordDiffForMessage };
}
