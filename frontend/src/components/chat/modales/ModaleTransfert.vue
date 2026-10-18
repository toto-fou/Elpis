<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/ModaleTransfert.vue — fenêtre globale de transfert (import, export, sauvegarde, restauration) : progression dans l'application, attente serveur, erreur ; chat et console. -->
<script setup lang="ts">
import { domaineModales } from "../../../features/chat/modales/domaine";

const m = domaineModales();
</script>

<template>
  <!-- ═══ Modale de transfert (import/export : backup, restore, exports) ═══ -->
  <Transition name="modal">
    <div
      v-if="m.transferModal.active"
      role="dialog"
      aria-modal="true"
      :aria-label="m.transferModal.title"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
    >
      <div class="bg-white p-5 rounded-2xl w-full max-w-md shadow-2xl border border-slate-200">
        <div class="flex items-center gap-3 mb-4">
          <div
            class="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            :class="
              m.transferModal.error
                ? 'bg-red-50 text-red-500'
                : m.transferModal.done
                  ? 'bg-emerald-50 text-emerald-600'
                  : 'bg-blue-50 text-blue-600'
            "
          >
            <!-- Serveur au travail : l'icône devient une roue qui tourne. -->
            <i
              class="ph text-lg"
              aria-hidden="true"
              :class="
                m.transferModal.error
                  ? 'ph-warning-circle'
                  : m.transferModal.done
                    ? 'ph-check-circle'
                    : m.transferModal.waiting
                      ? 'ph-spinner-gap animate-spin'
                      : m.transferModal.mode === 'upload'
                        ? 'ph-upload-simple'
                        : 'ph-download-simple'
              "
            ></i>
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold text-slate-800 truncate">{{ m.transferModal.title }}</div>
            <div class="text-[11px] text-slate-500 font-mono truncate">
              {{ m.transferModal.filename || "…" }}
            </div>
          </div>
        </div>
        <div
          class="h-2 bg-slate-100 rounded-full overflow-hidden"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="m.transferModal.indeterminate ? undefined : Math.round(m.transferModal.percent)"
        >
          <!-- taille inconnue (pas de Content-Length) ou serveur au travail → barre pulsée -->
          <div
            v-if="m.transferModal.indeterminate && !m.transferModal.done && !m.transferModal.error"
            class="h-full w-full bg-blue-500/60 animate-pulse motion-reduce:animate-none rounded-full"
          ></div>
          <div
            v-else
            class="h-full w-full rounded-full transition-transform duration-300"
            :class="
              m.transferModal.error ? 'bg-red-400' : m.transferModal.done ? 'bg-emerald-500' : 'bg-blue-500'
            "
            :style="{
              transformOrigin: 'left',
              transform: 'scaleX(' + (m.transferModal.done ? 100 : m.transferModal.percent) / 100 + ')',
            }"
          ></div>
        </div>
        <div class="flex items-center justify-between mt-2 text-[11px] text-slate-500 tabular-nums gap-2">
          <span v-if="m.transferModal.error" class="text-red-600 truncate">{{ m.transferModal.error }}</span>
          <span v-else-if="m.transferModal.done" class="text-emerald-600 font-medium">Terminé</span>
          <!-- Serveur au travail, aucun octet ne circule (archive en cours de
                           compression, restauration) : libellé + temps écoulé (la roue est
                           dans l'en-tête), pour montrer que rien n'est bloqué. -->
          <span
            v-else-if="m.transferModal.waiting"
            class="inline-flex items-center gap-1.5 text-slate-600 min-w-0"
          >
            <span role="status" class="truncate">{{ m.transferModal.waitLabel }}</span>
            <span v-if="m.transferModal.elapsed >= 1" class="text-slate-400 shrink-0" aria-hidden="true">{{
              m.fmtElapsed(m.transferModal.elapsed)
            }}</span>
          </span>
          <span v-else
            >{{ m.fmtBytes(m.transferModal.loaded)
            }}<template v-if="m.transferModal.total">
              / {{ m.fmtBytes(m.transferModal.total) }}</template
            ></span
          >
          <span
            v-if="
              !m.transferModal.indeterminate &&
              m.transferModal.total &&
              !m.transferModal.error &&
              !m.transferModal.done
            "
            >{{ Math.round(m.transferModal.percent) }}%</span
          >
        </div>
        <div class="flex justify-end mt-4">
          <button
            class="px-4 py-2 rounded-lg font-medium transition-colors text-sm"
            :class="
              m.transferModal.done || m.transferModal.error
                ? 'bg-slate-900 hover:bg-slate-800 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100'
            "
            @click="m.closeTransferModal"
          >
            {{ m.transferModal.done || m.transferModal.error ? "Fermer" : "Annuler" }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
