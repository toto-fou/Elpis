// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/vue-scindee.ts — vue scindée (deux éditeurs, aperçu web ou rendu Markdown/SVG à droite, diviseur), aperçu Markdown/SVG en direct et visionneuse d'image (zoom). */
import { computed, nextTick, ref, watch } from "vue";

import { purifierSvg } from "../chat/rendu/instance";
import type { CtxEditeur, EtatEditeur } from "./etat";
import type { LiensEditeur, ServicesEditeur } from "./liens";

const SVG_INVALIDE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60">' +
  '<text x="10" y="35" fill="#ef4444" font-family="monospace" font-size="12">SVG invalide ou vide</text></svg>';

/** Genre de rendu à côté du code : 'md', 'svg' ou ''. */
export function genreRendu(chemin: string | null | undefined): "md" | "svg" | "" {
  const p = (chemin || "").toLowerCase();
  if (/\.(md|mdx|markdown)$/.test(p)) return "md";
  if (p.endsWith(".svg")) return "svg";
  return "";
}

export function setupEditorSplit(e: EtatEditeur, s: ServicesEditeur, l: LiensEditeur, ctx: CtxEditeur) {
  const {
    monacoRef,
    splitView,
    splitTabPath,
    splitMode,
    activePane,
    activeTabPath,
    openTabs,
    showEditorMore,
  } = e;
  const { models, vis } = s;
  const modelOk = (p: string | null | undefined): boolean => !!p && s.modeles.ok(p);
  const mettreModeleDroit = (p: string | null): void => {
    try {
      const m = p ? models[p] : undefined;
      monacoRef.instance2?.setModel(m ?? null);
    } catch {
      /* éditeur libéré */
    }
  };

  /** Fichier du panneau droit (un visualiseur reste à gauche). */
  function setSplitFile(chemin: string): void {
    if (!chemin) return;
    if (vis.officeIsViewerPath(chemin)) {
      ctx.showToast("Aperçu disponible dans le panneau gauche", "info");
      return;
    }
    splitTabPath.value = chemin;
    if (!modelOk(chemin)) {
      void l.openFile(chemin);
      return;
    }
    mettreModeleDroit(chemin);
    activePane.value = "right";
    void nextTick(() => {
      l.robustLayout();
      try {
        monacoRef.instance2?.focus();
      } catch {
        /* éditeur libéré */
      }
    });
  }

  function enterSplit(): void {
    if (!activeTabPath.value) return;
    splitView.value = true;
    splitMode.value = "code";
    // À droite par défaut : un autre onglet, sinon le même fichier.
    if (
      !splitTabPath.value ||
      !openTabs.value.find((t) => t.path === splitTabPath.value) ||
      vis.officeIsViewerPath(splitTabPath.value)
    ) {
      const autre = openTabs.value.find(
        (t) => t.path !== activeTabPath.value && !vis.officeIsViewerPath(t.path),
      );
      splitTabPath.value = autre
        ? autre.path
        : vis.officeIsViewerPath(activeTabPath.value)
          ? null
          : activeTabPath.value;
    }
    void nextTick(() => {
      if (monacoRef.instance2 && modelOk(splitTabPath.value)) mettreModeleDroit(splitTabPath.value);
      activePane.value = "right";
      l.relayoutDuringTransition();
      l.robustLayout();
    });
  }

  function exitSplit(): void {
    splitView.value = false;
    splitMode.value = "code";
    s.apercu.previewLive.value = false;
    s.apercu._cancelPreviewLive();
    activePane.value = "left";
    mettreModeleDroit(null);
    void nextTick(() => l.robustLayout());
  }

  function toggleSplit(): void {
    if (splitView.value && splitMode.value === "preview") {
      enterSplit();
      return;
    }
    if (splitView.value) exitSplit();
    else enterSplit();
  }

  /** Panneau droit = rendu web de la page, à côté de son code. */
  function enterSplitPreview(): void {
    splitView.value = true;
    splitMode.value = "preview";
    activePane.value = "left";
    const p = activeTabPath.value || "";
    if (p.toLowerCase().endsWith(".html")) s.apercu.previewPath.value = p;
    mettreModeleDroit(null);
    void nextTick(() => {
      l.relayoutDuringTransition();
      l.robustLayout();
    });
  }

  function toggleSplitPreview(): void {
    if (splitView.value && splitMode.value === "preview") exitSplit();
    else enterSplitPreview();
  }

  /** Clic d'onglet : ouvre dans le panneau focalisé. */
  function onTabActivate(chemin: string): void {
    if (splitView.value && activePane.value === "right") {
      if (vis.officeIsViewerPath(chemin)) {
        activePane.value = "left";
        void l.switchTab(chemin);
        return;
      }
      setSplitFile(chemin);
    } else void l.switchTab(chemin);
  }

  function openInSplit(chemin: string): void {
    l.closeTabCtxMenu();
    if (!chemin || vis.officeIsViewerPath(chemin)) return;
    splitView.value = true;
    splitMode.value = "code";
    void nextTick(() => setSplitFile(chemin));
  }

  /** Diviseur entre les deux panneaux : largeur du gauche en %, bornée à 15–85. */
  function splitResizeStart(ev: MouseEvent | TouchEvent): void {
    ev.preventDefault();
    const rangee = (ev.currentTarget as HTMLElement | null)?.parentElement;
    if (!rangee) return;
    const boite = rangee.getBoundingClientRect();
    const deplacer = (m: MouseEvent | TouchEvent): void => {
      const x = "touches" in m ? (m.touches[0]?.clientX ?? 0) : m.clientX;
      e.splitRatio.value = Math.max(15, Math.min(85, ((x - boite.left) / boite.width) * 100));
      l.forceLayout();
    };
    const finir = (): void => {
      document.removeEventListener("mousemove", deplacer);
      document.removeEventListener("mouseup", finir);
      document.removeEventListener("touchmove", deplacer);
      document.removeEventListener("touchend", finir);
      l.robustLayout();
    };
    document.addEventListener("mousemove", deplacer);
    document.addEventListener("mouseup", finir);
    document.addEventListener("touchmove", deplacer, { passive: false });
    document.addEventListener("touchend", finir);
  }

  // Aperçu Markdown / SVG à côté du code, rafraîchi pendant la frappe (200 ms).
  const renderPaneKind = ref<"md" | "svg" | "">("");
  const renderPaneSource = ref("");
  let minuterieRendu: ReturnType<typeof setTimeout> | undefined;
  function rafraichirRendu(): void {
    const p = activeTabPath.value;
    renderPaneKind.value = genreRendu(p);
    renderPaneSource.value = renderPaneKind.value && p && modelOk(p) ? (models[p]?.getValue() ?? "") : "";
  }
  function _scheduleRenderPane(): void {
    if (!(splitView.value && splitMode.value === "render")) return;
    clearTimeout(minuterieRendu);
    minuterieRendu = setTimeout(rafraichirRendu, 200);
  }
  watch(activeTabPath, () => {
    if (splitView.value && splitMode.value === "render") rafraichirRendu();
  });
  function toggleSplitRender(): void {
    showEditorMore.value = false;
    if (splitView.value && splitMode.value === "render") {
      exitSplit();
      return;
    }
    splitView.value = true;
    splitMode.value = "render";
    activePane.value = "left";
    mettreModeleDroit(null);
    rafraichirRendu();
    void nextTick(() => {
      l.relayoutDuringTransition();
      l.robustLayout();
    });
  }
  /** SVG purifié (jamais de script ni de lien externe) ; repli lisible s'il est invalide. */
  function renderSvgSafe(src: string): string {
    return purifierSvg(src || "") || SVG_INVALIDE;
  }

  const isCurrentFileMd = computed(() => {
    const p = (activeTabPath.value || "").toLowerCase();
    return p.endsWith(".md") || p.endsWith(".mdx") || p.endsWith(".markdown");
  });
  const isCurrentFileSvg = computed(() => (activeTabPath.value || "").toLowerCase().endsWith(".svg"));
  watch(activeTabPath, () => {
    e.mdPreview.value = false;
  });
  watch(activeTabPath, () => {
    e.svgPreview.value = false;
  });

  // Visionneuse d'image : zoom ajusté ou facteur (Ctrl + molette).
  const imageZoom = ref<"fit" | number>("fit");
  const imageNatural = ref({ w: 0, h: 0 });
  watch(activeTabPath, () => {
    imageZoom.value = "fit";
  });
  function onImageLoad(ev: Event): void {
    const img = ev.target as HTMLImageElement | null;
    if (img) imageNatural.value = { w: img.naturalWidth || 0, h: img.naturalHeight || 0 };
  }
  function echelleAjustee(): number {
    const img = document.querySelector<HTMLImageElement>("[data-image-viewer] img");
    const nw = imageNatural.value.w;
    return img && nw ? img.clientWidth / nw : 1;
  }
  function imageZoomBy(f: number): void {
    const cur = imageZoom.value === "fit" ? echelleAjustee() : imageZoom.value;
    imageZoom.value = Math.max(0.05, Math.min(16, Math.round(cur * f * 100) / 100));
  }
  function imageZoomSet(v: "fit" | number): void {
    imageZoom.value = v;
  }
  function onImageWheel(ev: WheelEvent): void {
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    imageZoomBy(ev.deltaY < 0 ? 1.15 : 1 / 1.15);
  }
  const imageStyle = computed(() => {
    const z = imageZoom.value;
    return z === "fit"
      ? {}
      : {
          maxWidth: "none",
          maxHeight: "none",
          width: Math.max(1, Math.round((imageNatural.value.w || 0) * z)) + "px",
        };
  });
  const imageZoomLabel = computed(() =>
    imageZoom.value === "fit" ? "Ajusté" : Math.round(imageZoom.value * 100) + " %",
  );

  return {
    setSplitFile,
    enterSplit,
    exitSplit,
    toggleSplit,
    enterSplitPreview,
    toggleSplitPreview,
    onTabActivate,
    openInSplit,
    splitResizeStart,
    renderPaneKind,
    renderPaneSource,
    _scheduleRenderPane,
    toggleSplitRender,
    toggleSvgPreview: toggleSplitRender,
    renderSvgSafe,
    isCurrentFileMd,
    isCurrentFileSvg,
    imageZoom,
    imageZoomLabel,
    imageStyle,
    imageZoomBy,
    imageZoomSet,
    onImageLoad,
    onImageWheel,
    libererVueScindee(): void {
      clearTimeout(minuterieRendu);
    },
  };
}
