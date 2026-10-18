// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/message/captures-web.ts — carrousel des captures web d'un message assistant et libération de leurs URL blob (porté de `chat/_webshot.js`). */
import type { Ref } from "vue";

export interface CaptureMutable {
  blobUrl?: string | null;
  [cle: string]: unknown;
}

export interface MessageCaptures {
  webScreenshots?: CaptureMutable[] | null;
  webScreenshotIdx?: number | null;
  webScreenshotExpanded?: boolean;
  [cle: string]: unknown;
}

/** Révoque les URL blob des captures des messages donnés (1 à 2 Mo chacune). */
export function revoquerCaptures(messages: readonly unknown[]): void {
  for (const m of messages) {
    const caps = m && typeof m === "object" ? (m as MessageCaptures).webScreenshots : null;
    if (!Array.isArray(caps)) continue;
    for (const s of caps) {
      if (s && s.blobUrl) {
        try {
          URL.revokeObjectURL(s.blobUrl);
        } catch {
          /* déjà libérée */
        }
        s.blobUrl = null;
      }
    }
  }
}

export function setupChatWebshot(_vue: unknown, refs: { messages: Ref<readonly unknown[]> }) {
  const { messages } = refs;

  function _revokeAllWebShotBlobs(): void {
    try {
      revoquerCaptures(messages.value);
    } catch {
      /* liste en cours de remplacement */
    }
  }

  function webShotPrev(msg: MessageCaptures | null | undefined): void {
    const n = msg?.webScreenshots?.length;
    if (!msg || !n) return;
    const cur = msg.webScreenshotIdx ?? n - 1;
    msg.webScreenshotIdx = (cur - 1 + n) % n;
  }

  function webShotNext(msg: MessageCaptures | null | undefined): void {
    const n = msg?.webScreenshots?.length;
    if (!msg || !n) return;
    const cur = msg.webScreenshotIdx ?? n - 1;
    msg.webScreenshotIdx = (cur + 1) % n;
  }

  function webShotToggleExpand(msg: MessageCaptures | null | undefined): void {
    if (msg) msg.webScreenshotExpanded = !msg.webScreenshotExpanded;
  }

  function webShotGoto(msg: MessageCaptures | null | undefined, i: number): void {
    if (msg?.webScreenshots && i >= 0 && i < msg.webScreenshots.length) msg.webScreenshotIdx = i;
  }

  return { _revokeAllWebShotBlobs, webShotPrev, webShotNext, webShotToggleExpand, webShotGoto };
}
