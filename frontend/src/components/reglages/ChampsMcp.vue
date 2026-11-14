<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/ChampsMcp.vue — champs du serveur MCP en cours (perso ou publié) : un seul bloc (nom, portée, type, adresse, authentification, en-têtes ou variables). -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineReglages } from "../../features/reglages/domaine";

const rg = domaineReglages();
const f = computed(() => rg.mcpForm);
const admin = computed(() => rg.user?.role === "admin");
const localInterdit = computed(() =>
  f.value?.portee === "partage" ? "La bibliothèque partagée n'accepte que HTTP et SSE" : "",
);
// « Local » (commande lancée sur le serveur) n'existe que pour l'admin : un compte ordinaire ne le voit pas.
const TYPES = computed(() =>
  [
    { v: "http", l: "HTTP" },
    { v: "sse", l: "SSE" },
    { v: "stdio", l: "Local" },
  ].filter((t) => t.v !== "stdio" || admin.value),
);
const AUTHS = [
  { v: "", l: "Aucune" },
  { v: "bearer", l: "Jeton (Bearer)" },
  { v: "basic", l: "Basic" },
  { v: "header", l: "Clé d'API" },
  { v: "raw", l: "Authorization brut" },
] as const;
const cle = computed<"headers" | "env">(() => (f.value?.type === "stdio" ? "env" : "headers"));
const indiceSecret = (ph: string): string => (f.value?.has_auth ? "inchangé" : ph);
const ERREURS_SECRET: Readonly<Record<string, string>> = {
  undecryptable: "Secret illisible avec la clé actuelle du coffre : ressaisissez-le.",
  missing: "Secret retiré du coffre : ressaisissez-le.",
  not_migrated: "Secret non repris dans le coffre : ressaisissez-le.",
};
// Clé du coffre absente : la ressaisie échouerait aussi, seul un administrateur peut la rétablir.
const erreurSecret = computed(() => {
  const code = f.value?.secret_error;
  if (!code) return "";
  if (code === "key_unavailable")
    return admin.value
      ? "Clé du coffre indisponible sur le serveur : voir ./elpis doctor."
      : "Clé du coffre indisponible sur le serveur : prévenez un administrateur.";
  return ERREURS_SECRET[code] ?? "Secret à ressaisir.";
});
</script>

<template>
  <fieldset v-if="f" class="space-y-2.5 max-w-[600px] min-w-0" :disabled="rg.mcpOccupe">
    <legend class="text-xs font-semibold text-slate-500 pb-1.5">Connexion</legend>
    <p v-if="erreurSecret" class="flex items-center gap-1.5 text-xs text-amber-700" role="status">
      <i class="ph ph-warning" aria-hidden="true"></i>{{ erreurSecret }}
    </p>
    <div class="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-x-3">
      <label for="mcp-nom" class="text-[13px] text-slate-500 pt-1.5">Nom</label>
      <div>
        <input
          id="mcp-nom"
          v-model="f.name"
          class="elpis-mcp-champ"
          placeholder="ex. Git interne"
          :aria-invalid="rg.mcpErreurs.name ? 'true' : undefined"
          :aria-describedby="rg.mcpErreurs.name ? 'mcp-err-nom' : undefined"
          @input="rg.mcpEffacerErreur('name')"
        />
        <p v-if="rg.mcpErreurs.name" id="mcp-err-nom" class="mt-1 text-xs text-red-600">
          {{ rg.mcpErreurs.name }}
        </p>
      </div>
    </div>
    <div v-if="!f.id && admin" class="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3">
      <span id="mcp-portee-lbl" class="text-[13px] text-slate-500">Portée</span>
      <div class="adm-seg adm-seg--sm w-fit" role="group" aria-labelledby="mcp-portee-lbl">
        <button
          type="button"
          class="adm-seg__btn"
          :class="{ 'is-active': f.portee === 'perso' }"
          :aria-pressed="f.portee === 'perso'"
          @click="rg.mcpSetPortee('perso')"
        >
          Moi
        </button>
        <button
          type="button"
          class="adm-seg__btn"
          :class="{ 'is-active': f.portee === 'partage' }"
          :aria-pressed="f.portee === 'partage'"
          title="Publié pour tous les comptes"
          @click="rg.mcpSetPortee('partage')"
        >
          Tous
        </button>
      </div>
    </div>
    <div class="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3">
      <span id="mcp-type-lbl" class="text-[13px] text-slate-500">Type</span>
      <div class="adm-seg adm-seg--sm w-fit" role="group" aria-labelledby="mcp-type-lbl">
        <button
          v-for="t in TYPES"
          :key="t.v"
          type="button"
          class="adm-seg__btn disabled:opacity-50 disabled:cursor-not-allowed"
          :class="{ 'is-active': f.type === t.v }"
          :aria-pressed="f.type === t.v"
          :disabled="t.v === 'stdio' && !!localInterdit"
          :title="t.v === 'stdio' ? localInterdit || 'Commande lancée sur le serveur' : undefined"
          @click="rg.mcpSetType(t.v)"
        >
          {{ t.l }}
        </button>
      </div>
    </div>
    <div class="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-x-3">
      <label
        :for="f.type === 'stdio' ? 'mcp-commande' : 'mcp-adresse'"
        class="text-[13px] text-slate-500 pt-1.5"
        >{{ f.type === "stdio" ? "Commande" : "Adresse" }}</label
      >
      <div>
        <input
          v-if="f.type === 'stdio'"
          id="mcp-commande"
          v-model="f.command"
          class="elpis-mcp-champ font-mono"
          placeholder="npx -y wikijs-mcp"
          :aria-invalid="rg.mcpErreurs.command ? 'true' : undefined"
          :aria-describedby="rg.mcpErreurs.command ? 'mcp-err-adresse' : undefined"
          @input="rg.mcpEffacerErreur('command')"
        />
        <input
          v-else
          id="mcp-adresse"
          v-model="f.url"
          class="elpis-mcp-champ font-mono"
          :placeholder="f.type === 'http' ? 'http://…:4445/mcp' : 'https://…/mcp-server/sse'"
          :aria-invalid="rg.mcpErreurs.url ? 'true' : undefined"
          :aria-describedby="rg.mcpErreurs.url ? 'mcp-err-adresse' : undefined"
          @input="rg.mcpEffacerErreur('url')"
        />
        <p
          v-if="rg.mcpErreurs.url || rg.mcpErreurs.command"
          id="mcp-err-adresse"
          class="mt-1 text-xs text-red-600"
        >
          {{ rg.mcpErreurs.url || rg.mcpErreurs.command }}
        </p>
      </div>
    </div>
    <label
      v-if="f.portee === 'partage' && admin"
      class="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 cursor-pointer"
      title="Un serveur inactif reste publié mais n'est plus proposé"
    >
      <span class="text-[13px] text-slate-500">Actif</span>
      <span class="relative inline-flex items-center">
        <input v-model="f.enabled" type="checkbox" class="sr-only peer" aria-label="Actif pour tous" />
        <span class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"></span>
      </span>
    </label>
    <div v-if="f.type !== 'stdio'" class="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3">
      <label for="mcp-auth" class="text-[13px] text-slate-500">Auth</label>
      <div class="flex flex-wrap gap-2">
        <select id="mcp-auth" v-model="f.auth_mode" class="elpis-mcp-champ w-auto min-w-[150px]">
          <option v-for="a in AUTHS" :key="a.v" :value="a.v">{{ a.l }}</option>
        </select>
        <input
          v-if="f.auth_mode === 'basic' || f.auth_mode === 'header'"
          v-model="f.auth_user"
          class="elpis-mcp-champ font-mono flex-1 min-w-[120px]"
          :placeholder="f.auth_mode === 'basic' ? 'username' : 'X-API-Key'"
          :aria-label="f.auth_mode === 'basic' ? 'Utilisateur' : 'Nom de l\'en-tête'"
        />
        <input
          v-if="f.auth_mode"
          v-model="f.auth_secret"
          type="password"
          autocomplete="new-password"
          class="elpis-mcp-champ font-mono flex-[2_1_160px]"
          aria-label="Secret"
          :placeholder="
            f.auth_mode === 'bearer'
              ? indiceSecret('jeton seul, sans « Bearer »')
              : f.auth_mode === 'basic'
                ? indiceSecret('API token / password')
                : f.auth_mode === 'header'
                  ? indiceSecret('valeur de la clé')
                  : indiceSecret('Bearer eyJ… ou Basic dXNlcjpwYXNz')
          "
        />
      </div>
    </div>
    <div class="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-x-3">
      <span class="text-[13px] text-slate-500 pt-1.5">{{
        f.type === "stdio" ? "Variables" : "En-têtes"
      }}</span>
      <div class="space-y-1.5">
        <div
          v-for="(p, i) in f[cle]"
          :key="cle + i"
          class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_2rem] gap-1.5 items-center"
        >
          <input
            v-model="p.name"
            class="elpis-mcp-champ font-mono"
            :placeholder="cle === 'env' ? 'WIKIJS_TOKEN' : 'X-API-Key'"
            :aria-label="(cle === 'env' ? 'Variable ' : 'En-tête ') + (i + 1) + ' : nom'"
          />
          <input
            v-model="p.value"
            type="password"
            autocomplete="new-password"
            class="elpis-mcp-champ font-mono"
            :placeholder="p.has_value ? 'inchangé' : 'valeur'"
            :aria-label="(cle === 'env' ? 'Variable ' : 'En-tête ') + (i + 1) + ' : valeur'"
          />
          <button
            type="button"
            class="adm-btn adm-btn--icon adm-btn--icon-danger"
            title="Retirer"
            :aria-label="'Retirer ' + (p.name || (cle === 'env' ? 'la variable' : 'l\'en-tête'))"
            @click="rg.mcpRemovePair(f, cle, i)"
          >
            <i class="ph ph-minus-circle" aria-hidden="true"></i>
          </button>
        </div>
        <button
          type="button"
          class="inline-flex items-center gap-1 h-7 px-1.5 -ml-1.5 rounded-md text-[13px] font-medium text-blue-600 hover:bg-blue-50"
          @click="rg.mcpAddPair(f, cle)"
        >
          <i class="ph ph-plus" aria-hidden="true"></i> {{ cle === "env" ? "Variable" : "En-tête" }}
        </button>
      </div>
    </div>
  </fieldset>
</template>
