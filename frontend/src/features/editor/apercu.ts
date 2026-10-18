// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/apercu.ts — aperçu web de l'éditeur : source fichier ou serveur du conteneur, saisie libre de l'URL, jeton d'URL signé (lié à la génération de session), rafraîchissement « live » pendant la frappe. */
import { computed, ref } from "vue";
import { schemaReponseJetonApercu } from "@elpis/contracts";

import type { GestionnaireSession } from "../auth/session";

type FetchAuth = (url: string, init?: RequestInit, soft?: boolean) => Promise<Response | null>;

export interface CibleServeur {
  port: number | null;
  path: string;
  host: string;
}

/** Saisie libre (« http://localhost:5173/app », « 8080 », « /docs ») éclatée ; `port` null quand la saisie n'en porte pas. */
export function analyserUrlServeur(brut: unknown): CibleServeur {
  let s = String(brut ?? "").trim();
  if (!s) return { port: null, path: "/", host: "" };
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  if (s.startsWith("/")) return { port: null, path: s, host: "" };
  const barre = s.indexOf("/");
  const autorite = barre === -1 ? s : s.slice(0, barre);
  const chemin = barre === -1 ? "/" : s.slice(barre);
  let hote = "";
  let port: string;
  if (autorite.startsWith("[")) {
    const fin = autorite.indexOf("]");
    hote = autorite.slice(0, fin + 1);
    port = autorite.slice(fin + 1).replace(/^:/, "");
  } else {
    const i = autorite.lastIndexOf(":");
    if (i === -1) port = autorite;
    else {
      hote = autorite.slice(0, i);
      port = autorite.slice(i + 1);
    }
  }
  if (port && !/^\d+$/.test(port)) {
    if (!hote) hote = port;
    port = "";
  }
  const n = Number(port);
  return { port: /^\d+$/.test(port) && n >= 1 && n <= 65535 ? n : null, path: chemin || "/", host: hote };
}

const HOTES_LOCAUX = ["", "localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"];
const DELAI_LIVE_MS = 700;

export interface DepsApercu {
  fetchAuth: FetchAuth;
  ongletActif(): string | null;
  apercuScinde(): boolean;
  enregistrer(opts: { silent: boolean; path: string }): Promise<unknown>;
}

export function setupEditorPreview(session: GestionnaireSession | null, deps: DepsApercu) {
  const previewPath = ref("index.html");
  const previewKey = ref(0);
  const previewSource = ref<"file" | "server">("file");
  const previewPort = ref(8080);
  const previewServerPath = ref("/");
  const previewServerUrl = ref("localhost:8080/");
  const previewServerHostWarn = ref("");
  const previewLive = ref(false);

  // Le jeton voyage dans le chemin (origine opaque de l'iframe) ; il appartient à la génération qui l'a obtenu.
  const previewToken = ref("");
  let expiration = 0;
  let generationJeton = -1;
  let enCours: Promise<void> | null = null;
  const generation = (): number => (session ? session.generation : 0);

  function oublierJeton(): void {
    previewToken.value = "";
    expiration = 0;
    generationJeton = -1;
  }
  session?.surChangement((etat, precedent) => {
    if (etat.generation !== precedent.generation) oublierJeton();
  });

  function _ensurePreviewToken(): Promise<void> {
    if (previewToken.value && generationJeton !== generation()) oublierJeton();
    if (previewToken.value && expiration - Date.now() / 1000 > 300) return Promise.resolve();
    if (!enCours) {
      const gen = generation();
      enCours = deps
        .fetchAuth("/api/sandbox/preview-token", {}, true)
        .then(async (r) => (r && r.ok ? schemaReponseJetonApercu.safeParse(await r.json()) : null))
        .then((d) => {
          if (!d || !d.success || !d.data.token || gen !== generation()) return;
          previewToken.value = d.data.token;
          expiration = d.data.expires;
          generationJeton = gen;
        })
        .catch(() => {})
        .finally(() => {
          enCours = null;
        });
    }
    return enCours;
  }

  const previewSrc = computed(() => {
    const jeton = previewToken.value;
    if (!jeton) {
      void _ensurePreviewToken();
      return "about:blank";
    }
    if (previewSource.value === "server") {
      const port = Math.max(1, Math.min(65535, Number(previewPort.value) || 8080));
      let p = String(previewServerPath.value || "/");
      if (!p.startsWith("/")) p = "/" + p;
      return "/api/sandbox/pvs/" + jeton + "/" + port + p;
    }
    return (
      "/api/sandbox/pv/" +
      jeton +
      "/" +
      String(previewPath.value || "")
        .split("/")
        .map(encodeURIComponent)
        .join("/")
    );
  });

  function refreshPreview(): void {
    void _ensurePreviewToken().then(() => {
      previewKey.value++;
    });
  }

  /** Validation de la saisie (Entrée, perte de focus, recharger) : jamais à chaque frappe. */
  function commitPreviewServerUrl(): void {
    const t = analyserUrlServeur(previewServerUrl.value);
    if (t.port !== null) previewPort.value = t.port;
    previewServerPath.value = t.path.startsWith("/") ? t.path : "/" + t.path;
    previewServerHostWarn.value = HOTES_LOCAUX.includes(t.host.toLowerCase()) ? "" : t.host;
    previewServerUrl.value = "localhost:" + previewPort.value + previewServerPath.value;
    refreshPreview();
  }

  function reloadPreview(): void {
    if (previewSource.value === "server") commitPreviewServerUrl();
    else refreshPreview();
  }

  let minuterieLive: ReturnType<typeof setTimeout> | null = null;
  function _cancelPreviewLive(): void {
    if (minuterieLive) clearTimeout(minuterieLive);
    minuterieLive = null;
  }
  /** Mode live : enregistre le fichier actif (chemin figé à la frappe) puis recharge l'aperçu après une pause. */
  function _schedulePreviewLive(): void {
    if (!previewLive.value || !deps.apercuScinde() || previewSource.value !== "file") return;
    const chemin = deps.ongletActif();
    if (!chemin) return;
    _cancelPreviewLive();
    minuterieLive = setTimeout(() => {
      minuterieLive = null;
      void deps
        .enregistrer({ silent: true, path: chemin })
        .catch(() => undefined)
        .then(() => refreshPreview());
    }, DELAI_LIVE_MS);
  }
  function togglePreviewLive(): void {
    previewLive.value = !previewLive.value;
    if (previewLive.value) _schedulePreviewLive();
    else _cancelPreviewLive();
  }
  function openPreviewInNewTab(): void {
    try {
      window.open(previewSrc.value, "_blank", "noopener");
    } catch {
      /* fenêtre bloquée */
    }
  }

  return {
    previewPath,
    previewKey,
    previewSource,
    previewPort,
    previewServerPath,
    previewServerUrl,
    previewServerHostWarn,
    previewToken,
    previewSrc,
    previewLive,
    parsePreviewServerUrl: analyserUrlServeur,
    commitPreviewServerUrl,
    reloadPreview,
    refreshPreview,
    _ensurePreviewToken,
    _schedulePreviewLive,
    _cancelPreviewLive,
    togglePreviewLive,
    openPreviewInNewTab,
    oublierJeton,
  };
}
