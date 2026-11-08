<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/TiroirEvenementJournal.vue — Journaux › Sécurité : tiroir de détail d'une ligne (tous les champs, details en JSON indenté, signature sans clé). -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

import { gardeFocus, piegerTab } from "../../utils/focus";

import { domaineAdmin } from "../../features/admin/domaine";
import { heureLocale } from "../../features/admin/horodatage";
import { LIBELLES_ACTIONS } from "../../features/admin/journal-securite-affichage";

const adm = domaineAdmin();
const garde = gardeFocus();
const ligne = computed(() => adm.secuSelection);
const tiroir = ref<HTMLElement | null>(null);
const position = computed(() => adm.secuLignes.findIndex((l) => l.ref === ligne.value?.ref));
const json = computed(() => JSON.stringify(ligne.value?.details ?? null, null, 2));
const CHAMPS = [
  "ts",
  "user_id",
  "username",
  "ip",
  "service",
  "host",
  "boot",
  "seq",
  "outcome",
  "kid",
  "v",
] as const;
const MONO: ReadonlySet<string> = new Set(["ts", "ip", "boot", "kid"]);
const ISSUES: Record<string, string> = { success: "Réussite", failure: "Échec", unknown: "Inconnu" };
/** `ref` = « jour:position » : fichier et octet de la ligne. */
const fichier = computed(() => {
  const [jour, octet] = (ligne.value?.ref ?? "").split(":");
  return { nom: jour ? `audit-${jour}.jsonl` : "", octet: octet ?? "" };
});

function touche(ev: KeyboardEvent): void {
  piegerTab(ev, tiroir.value);
  if (ev.key === "Escape") adm.fermerEvenement();
  else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    adm.evenementVoisin(ev.key === "ArrowDown" ? 1 : -1);
  }
}
watch(ligne, (l, avant) => {
  if (l && !avant) garde.remember();
  if (l) void nextTick(() => tiroir.value?.focus());
  else if (avant) void nextTick(() => garde.restore());
});
onBeforeUnmount(() => adm.fermerEvenement());
</script>

<template>
  <teleport to="body">
    <div v-if="ligne" class="adm-drawer-backdrop" @click.self="adm.fermerEvenement()">
      <aside
        ref="tiroir"
        class="adm-drawer sup-secu-tiroir"
        role="dialog"
        aria-modal="true"
        aria-labelledby="secu-tiroir-titre"
        tabindex="-1"
        @keydown="touche"
      >
        <header class="adm-drawer__head">
          <i class="ph ph-shield-check adm-card__icon" aria-hidden="true"></i>
          <div class="min-w-0">
            <div id="secu-tiroir-titre" class="adm-drawer__title sup-mono">{{ ligne.action }}</div>
            <div class="sup-secu-tiroir__sous">
              {{ LIBELLES_ACTIONS[ligne.action] || "" }}{{ LIBELLES_ACTIONS[ligne.action] ? " · " : ""
              }}{{ heureLocale(ligne.ts) }}
            </div>
          </div>
          <div class="sup-secu-tiroir__nav">
            <button
              type="button"
              class="adm-btn adm-btn--icon"
              aria-label="Ligne plus récente"
              title="Ligne plus récente (↑)"
              :disabled="position <= 0"
              @click="adm.evenementVoisin(-1)"
            >
              <i class="ph ph-caret-up" aria-hidden="true"></i>
            </button>
            <button
              type="button"
              class="adm-btn adm-btn--icon"
              aria-label="Ligne plus ancienne"
              title="Ligne plus ancienne (↓)"
              :disabled="position < 0 || position >= adm.secuLignes.length - 1"
              @click="adm.evenementVoisin(1)"
            >
              <i class="ph ph-caret-down" aria-hidden="true"></i>
            </button>
            <button
              type="button"
              class="adm-btn adm-btn--icon"
              aria-label="Fermer"
              title="Fermer (Échap)"
              @click="adm.fermerEvenement()"
            >
              <i class="ph ph-x" aria-hidden="true"></i>
            </button>
          </div>
        </header>
        <div class="adm-drawer__body custom-scrollbar">
          <div class="flex flex-wrap items-center gap-2">
            <span
              class="adm-status"
              :data-state="
                ligne.outcome === 'success' ? 'ok' : ligne.outcome === 'failure' ? 'down' : 'unknown'
              "
              >{{ ISSUES[ligne.outcome] }}</span
            >
            <span class="adm-muted text-xs">
              <template v-if="ligne.signed"
                ><i class="ph ph-seal-check sup-secu-sig--ok" aria-hidden="true"></i> Ligne signée
                (HMAC)</template
              >
              <template v-else><i class="ph ph-seal" aria-hidden="true"></i> Ligne non signée</template>
            </span>
          </div>
          <dl class="sup-champs sup-champs--tiroir">
            <dt>time</dt>
            <dd>
              {{ heureLocale(ligne.ts) }} <span class="adm-muted">heure locale</span><br />
              <span class="sup-mono">{{ ligne.time ?? "—" }}</span> <span class="adm-muted">UTC</span>
            </dd>
            <template v-for="c in CHAMPS" :key="c">
              <dt>{{ c }}</dt>
              <dd :class="MONO.has(c) ? 'sup-mono' : undefined">{{ ligne[c] ?? "null" }}</dd>
            </template>
            <dt>fichier</dt>
            <dd>
              <span class="sup-mono">{{ fichier.nom }}</span>
              <span class="adm-muted"> position {{ fichier.octet }}</span>
            </dd>
          </dl>
          <div>
            <div class="sup-secu-bloc-titre">details</div>
            <pre class="sup-secu-json">{{ json }}</pre>
          </div>
        </div>
        <footer class="adm-drawer__foot sup-secu-tiroir__pied">
          <button
            v-if="ligne.user_id !== null || ligne.username"
            type="button"
            class="adm-btn adm-tool adm-btn--sm"
            @click="
              adm.secuFiltrerSur(
                'compte',
                ligne.user_id !== null ? String(ligne.user_id) : (ligne.username ?? ''),
              )
            "
          >
            <i class="ph ph-user" aria-hidden="true"></i> Ce compte
          </button>
          <button
            v-if="ligne.ip"
            type="button"
            class="adm-btn adm-tool adm-btn--sm"
            @click="adm.secuFiltrerSur('ip', ligne.ip)"
          >
            <i class="ph ph-globe-simple" aria-hidden="true"></i> Cette IP
          </button>
          <button
            type="button"
            class="adm-btn adm-tool adm-btn--sm"
            @click="adm.secuFiltrerSur('action', ligne.action)"
          >
            <i class="ph ph-funnel" aria-hidden="true"></i> Cette action
          </button>
        </footer>
      </aside>
    </div>
  </teleport>
</template>
