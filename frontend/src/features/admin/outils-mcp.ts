// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/outils-mcp.ts — console › Modèles & services › Outils MCP : manifeste mcp.json (lecture, rechargement, export) et clients OAuth. */
import {
  schemaReponseClientsOauth,
  schemaReponseExportManifeste,
  schemaReponseManifesteAdmin,
  schemaReponseRechargementManifeste,
} from "@elpis/contracts";
import { ref } from "vue";
import type { Ref } from "vue";

import type { ClientHttp } from "../../platform/http/client";
import { valeurOuNull } from "../../platform/http/resultat";

type ClientOauth = (typeof schemaReponseClientsOauth)["_output"]["items"][number];
type Manifeste = (typeof schemaReponseManifesteAdmin)["_output"]["manifest"];

export interface CtxOutilsMcpAdmin {
  showToast?(message: string, type?: string): void;
  openConfirm?(titre: string, message: string, danger: boolean, libelle?: string): Promise<boolean>;
}

export function setupAdminMcp(ctx: CtxOutilsMcpAdmin | null | undefined, http: ClientHttp) {
  const toast = (m: string, type?: string): void => ctx?.showToast?.(m, type);
  const oauthClients: Ref<ClientOauth[]> = ref([]);
  const mcpManifest: Ref<Manifeste | null> = ref(null);
  const mcpManifestBusy = ref(false);
  const mcpExportTransport = ref("http");
  const mcpExportToken = ref(false);

  async function loadOauthClients(): Promise<void> {
    const d = valeurOuNull(
      await http.requete("/api/admin/oauth/clients", {}, { schema: schemaReponseClientsOauth }),
    );
    oauthClients.value = d?.items ?? [];
  }

  async function deleteOauthClient(c: ClientOauth): Promise<void> {
    const ok = await ctx?.openConfirm?.(
      "Supprimer ce client ?",
      "« " + (c.name || c.client_id) + " » perd toutes ses autorisations ; il devra se réenregistrer.",
      true,
      "Supprimer",
    );
    if (!ok) return;
    const r = await http.requete("/api/admin/oauth/clients?client_id=" + encodeURIComponent(c.client_id), {
      method: "DELETE",
    });
    if (r.type !== "ok") {
      toast("Suppression impossible", "error");
      return;
    }
    await loadOauthClients();
  }

  async function loadMcpManifest(): Promise<void> {
    const d = valeurOuNull(
      await http.requete("/api/admin/mcp/manifest", {}, { schema: schemaReponseManifesteAdmin }),
    );
    mcpManifest.value = d ? d.manifest : null;
  }

  async function reloadMcpManifest(): Promise<void> {
    if (mcpManifestBusy.value) return;
    mcpManifestBusy.value = true;
    try {
      const d = valeurOuNull(
        await http.requete(
          "/api/admin/mcp/manifest/reload",
          { method: "POST" },
          { schema: schemaReponseRechargementManifeste },
        ),
      );
      if (d) {
        const avecErreurs = d.errors.length > 0;
        toast(
          avecErreurs ? "Manifeste rechargé avec erreurs" : "Manifeste rechargé",
          avecErreurs ? "warning" : "success",
        );
      } else toast("Rechargement impossible", "error");
    } finally {
      mcpManifestBusy.value = false;
      await loadMcpManifest();
    }
  }

  async function copyMcpExport(): Promise<void> {
    if (mcpManifestBusy.value) return;
    mcpManifestBusy.value = true;
    try {
      const q = new URLSearchParams({
        transport: mcpExportTransport.value,
        with_token: mcpExportToken.value ? "1" : "0",
      });
      const d = valeurOuNull(
        await http.requete(
          "/api/admin/mcp/manifest/export?" + q.toString(),
          {},
          { schema: schemaReponseExportManifeste },
        ),
      );
      if (!d) {
        toast("Export impossible", "error");
        return;
      }
      await navigator.clipboard.writeText(JSON.stringify({ mcpServers: d.mcpServers }, null, 2));
      const n = Object.keys(d.mcpServers).length;
      if (d.omis.length) {
        toast(
          "Configuration copiée (" + n + " serveurs) ; sans " + d.transport + " : " + d.omis.join(", "),
          "warning",
        );
      } else toast("Configuration copiée (" + n + " serveurs)");
    } catch {
      toast("Export impossible", "error");
    } finally {
      mcpManifestBusy.value = false;
    }
  }

  const mcpManifestRoleLabel = (role: string): string =>
    role === "toolhost" ? "intégré" : role === "app" ? "app" : "externe";

  return {
    mcpManifest,
    mcpManifestBusy,
    loadMcpManifest,
    reloadMcpManifest,
    mcpManifestRoleLabel,
    oauthClients,
    loadOauthClients,
    deleteOauthClient,
    mcpExportTransport,
    mcpExportToken,
    copyMcpExport,
  };
}
