// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/zoom-diagramme.ts — vue plein écran d'un diagramme : ajusté à l'ouverture, zoom (+/−, molette, clavier) et déplacement à la souris. */

interface Superposition extends HTMLDivElement {
  _elpisClose?: () => void;
}

function tailleNaturelle(svg: SVGElement): { w: number; h: number } {
  let w = 0;
  let h = 0;
  const vb = svg.getAttribute("viewBox");
  if (vb) {
    const p = vb.split(/[\s,]+/).map(parseFloat);
    if (p.length === 4 && (p[2] ?? 0) > 0) {
      w = p[2] ?? 0;
      h = p[3] ?? 0;
    }
  }
  if (!w) w = parseFloat(svg.getAttribute("width") || "") || 800;
  if (!h) h = parseFloat(svg.getAttribute("height") || "") || 600;
  return { w, h };
}

/** Ouvre la vue ; `nettoyer` repurifie le SVG avant insertion. La purge de déconnexion appelle `_elpisClose`. */
export function ouvrirZoomDiagramme(svgMarkup: string, nettoyer: (svg: string) => string | null): void {
  const overlay: Superposition = document.createElement("div");
  overlay.className = "elpis-diagram-zoom-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Diagramme agrandi");
  const precedent = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,0.85);" +
    "display:flex;flex-direction:column;backdrop-filter:blur(2px);";
  const bar = document.createElement("div");
  bar.style.cssText =
    "display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;flex-shrink:0;";
  bar.innerHTML =
    '<button data-act="out" class="elpis-zoom-btn" aria-label="Dézoomer">−</button>' +
    '<button data-act="reset" class="elpis-zoom-btn" aria-label="Réinitialiser le zoom" style="width:auto;padding:0 12px;">Réinitialiser</button>' +
    '<button data-act="in" class="elpis-zoom-btn" aria-label="Zoomer">+</button>' +
    '<button data-act="close" class="elpis-zoom-btn" aria-label="Fermer" style="margin-left:16px;">✕</button>';
  overlay.appendChild(bar);
  const stage = document.createElement("div");
  stage.style.cssText =
    "flex:1;overflow:hidden;display:flex;align-items:center;justify-content:center;cursor:grab;";
  const inner = document.createElement("div");
  inner.innerHTML = nettoyer(svgMarkup) || "";
  const zsvg = inner.querySelector("svg");
  if (zsvg) {
    const { w, h } = tailleNaturelle(zsvg);
    zsvg.removeAttribute("width");
    zsvg.removeAttribute("height");
    zsvg.style.width = w + "px";
    zsvg.style.height = h + "px";
    zsvg.style.maxWidth = "none";
    zsvg.style.display = "block";
  }
  inner.style.display = "inline-block";
  inner.style.transformOrigin = "center center";
  stage.appendChild(inner);
  overlay.appendChild(stage);
  document.body.appendChild(overlay);
  bar.querySelector<HTMLElement>('[data-act="close"]')?.focus();

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let fitScale = 1;
  const apply = (): void => {
    inner.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
  };
  inner.style.transition = "transform 0.08s ease-out";
  requestAnimationFrame(() => {
    const sb = stage.getBoundingClientRect();
    const ib = (zsvg || inner).getBoundingClientRect();
    if (ib.width > 0 && ib.height > 0) {
      const fit = Math.min((sb.width - 48) / ib.width, (sb.height - 48) / ib.height, 1.5);
      if (fit > 0 && isFinite(fit)) {
        scale = fit;
        fitScale = fit;
      }
    }
    apply();
  });

  let dragging = false;
  let sx = 0;
  let sy = 0;
  const onDragMove = (e: MouseEvent): void => {
    if (!dragging) return;
    tx = e.clientX - sx;
    ty = e.clientY - sy;
    apply();
  };
  const onDragUp = (): void => {
    dragging = false;
    stage.style.cursor = "grab";
    inner.style.transition = "transform 0.08s ease-out";
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Tab") {
      const boutons = [...bar.querySelectorAll<HTMLButtonElement>("button")];
      const i = boutons.indexOf(document.activeElement as HTMLButtonElement);
      const suivant = boutons[(i + (e.shiftKey ? -1 : 1) + boutons.length) % boutons.length];
      if (suivant) {
        e.preventDefault();
        suivant.focus();
      }
    } else if (e.key === "Escape") close();
    else if (e.key === "+" || e.key === "=") {
      scale = Math.min(scale * 1.25, 8);
      apply();
    } else if (e.key === "-") {
      scale = Math.max(scale / 1.25, 0.2);
      apply();
    }
  };
  function close(): void {
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragUp);
    overlay.remove();
    if (precedent?.isConnected) precedent.focus();
  }
  overlay._elpisClose = close;
  document.addEventListener("keydown", onKey);
  bar.addEventListener("click", (e) => {
    const act = (e.target as Element | null)?.getAttribute("data-act");
    if (act === "in") scale = Math.min(scale * 1.25, 8);
    if (act === "out") scale = Math.max(scale / 1.25, 0.2);
    if (act === "reset") {
      scale = fitScale;
      tx = 0;
      ty = 0;
    }
    if (act === "close") close();
    else if (act) apply();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target === stage) close();
  });
  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      scale = Math.min(Math.max(scale * f, 0.2), 8);
      apply();
    },
    { passive: false },
  );
  stage.addEventListener("mousedown", (e) => {
    dragging = true;
    sx = e.clientX - tx;
    sy = e.clientY - ty;
    stage.style.cursor = "grabbing";
    inner.style.transition = "none";
  });
  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragUp);
}
