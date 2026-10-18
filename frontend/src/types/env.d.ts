// SPDX-License-Identifier: MIT
/** frontend/src/types/env.d.ts — types des modules sans déclaration (Vite, SFC, carte vendor, DOMPurify 3.1). */
/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const composant: DefineComponent;
  export default composant;
}

declare module "virtual:elpis-vendor" {
  const carte: Readonly<Record<string, string>>;
  export default carte;
}

declare module "dompurify" {
  interface DOMPurify {
    readonly version: string;
    readonly isSupported: boolean;
    sanitize(source: string | Node, config?: Readonly<Record<string, unknown>>): string;
    addHook(point: string, rappel: (...args: unknown[]) => void): void;
    removeHook(point: string): void;
  }
  const purify: DOMPurify;
  export default purify;
}
