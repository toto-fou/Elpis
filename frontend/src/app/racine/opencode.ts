// SPDX-License-Identifier: MIT
/** frontend/src/app/racine/opencode.ts — fenêtre d'installation du client opencode : commandes d'installation et de resynchronisation par plateforme, familles d'outils publiées, archive hors ligne. */
import { computed, ref, watch } from "vue";

import type { FetchAuth } from "../../features/editor/etat";

export type PlateformeOpencode = "linux" | "macos" | "windows";

export interface DependancesOpencode {
  readonly fetchAuth: FetchAuth;
  showToast(message: string, type?: string): void;
}

function plateformeDuPoste(): PlateformeOpencode {
  try {
    const ua = (navigator.userAgent || "").toLowerCase();
    if (ua.includes("windows")) return "windows";
    if (ua.includes("mac")) return "macos";
  } catch {
    /* navigateur sans userAgent lisible */
  }
  return "linux";
}

export function creerOpencode(dep: DependancesOpencode) {
  const showOpenCodeModal = ref(false);
  const openCodePlatform = ref<PlateformeOpencode>(plateformeDuPoste());
  // Bloc dont la commande vient d'être copiée ('install' | 'sync'), sinon ''.
  const openCodeCopied = ref("");
  // Familles d'outils publiées à opencode : liste du serveur, aucune copie figée côté page.
  const openCodeFamilies = ref<unknown[]>([]);

  watch(showOpenCodeModal, async (ouvert) => {
    if (!ouvert) return;
    try {
      const r = await dep.fetchAuth("/api/cli/opencode/families", {}, true);
      const corps: unknown = r?.ok ? await r.json() : null;
      const familles = corps && typeof corps === "object" ? (corps as { families?: unknown }).families : null;
      openCodeFamilies.value = Array.isArray(familles) ? familles : [];
    } catch {
      openCodeFamilies.value = [];
    }
  });

  // Amorçage en clair sur :80 derrière le frontal TLS : le poste cible ne connaît pas encore la CA locale.
  const openCodeBootBase = computed(() =>
    window.location.protocol === "https:" ? `http://${window.location.hostname}` : window.location.origin,
  );
  const openCodeCommand = computed(() => {
    const serveur = openCodeBootBase.value;
    if (openCodePlatform.value === "windows") return `iex(irm ${serveur}/opencode.ps1)`;
    return `curl -fsSL ${serveur}/opencode | bash`;
  });
  // Resynchronisation de la seule configuration : le jeton est lu sur le poste et ne part que vers l'application.
  const openCodeSyncCommand = computed(() => {
    const base = window.location.origin;
    if (openCodePlatform.value === "windows") {
      return (
        `$t = (Get-Content "$env:USERPROFILE\\.config\\opencode\\elpis-remote.json" -Raw | ConvertFrom-Json).token; ` +
        `irm -Headers @{ 'x-elpis-token' = "$t" } ${base}/api/cli/opencode.json -OutFile "$env:USERPROFILE\\.config\\opencode\\opencode.json"`
      );
    }
    return (
      `T="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' ~/.config/opencode/elpis-remote.json | head -n1)"; ` +
      `curl -fsSL -H "x-elpis-token: $T" ${base}/api/cli/opencode.json -o ~/.config/opencode/opencode.json`
    );
  });

  let minuterieCopie: ReturnType<typeof setTimeout> | null = null;
  async function copyOpenCodeCommand(genre: string): Promise<void> {
    const texte = genre === "sync" ? openCodeSyncCommand.value : openCodeCommand.value;
    try {
      await navigator.clipboard.writeText(texte);
      openCodeCopied.value = genre === "sync" ? "sync" : "install";
      dep.showToast("Commande copiée");
      if (minuterieCopie) clearTimeout(minuterieCopie);
      minuterieCopie = setTimeout(() => {
        openCodeCopied.value = "";
        minuterieCopie = null;
      }, 2000);
    } catch {
      dep.showToast("Copie échouée", "error");
    }
  }

  /** Archive hors ligne du client : le nom réel vient du Content-Disposition du serveur. */
  function downloadOpenCodeBundle(): void {
    const p = openCodePlatform.value;
    const a = document.createElement("a");
    a.href = `/api/cli/bundle/${p}`;
    a.download = `opencode-${p}.${p === "windows" ? "zip" : "tar.gz"}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    dep.showToast("Téléchargement démarré");
  }

  return {
    showOpenCodeModal,
    openCodePlatform,
    openCodeCopied,
    openCodeCommand,
    openCodeSyncCommand,
    openCodeFamilies,
    copyOpenCodeCommand,
    downloadOpenCodeBundle,
  };
}
