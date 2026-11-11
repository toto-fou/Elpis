// SPDX-License-Identifier: MIT
/** frontend/test/preparation-dom.ts — préparation du projet « web » : getter `nodeName` conforme (DOMPurify), sans démarrage de l'i18n. */
const prototypeNode = globalThis.Node.prototype;

function nomDuNoeud(this: Node): string {
  for (
    let p = Object.getPrototypeOf(this) as object | null;
    p && p !== prototypeNode;
    p = Object.getPrototypeOf(p)
  ) {
    const lire = Object.getOwnPropertyDescriptor(p, "nodeName")?.get;
    if (lire) return lire.call(this) as string;
  }
  return "";
}

Object.defineProperty(prototypeNode, "nodeName", { configurable: true, enumerable: true, get: nomDuNoeud });
