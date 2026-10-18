<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/ModalesGroupes.vue — modales des groupes (création, édition, membres). -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";

const adm = domaineAdmin();
</script>

<template>
  <Transition name="modal">
    <div
      v-if="adm.isShareModalOpen"
      data-a11y-modal
      role="dialog"
      aria-modal="true"
      aria-label="Partager"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="adm.isShareModalOpen = false"
    >
      <div class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 p-6 w-full max-w-md">
        <div class="flex justify-between items-center mb-4">
          <h3 class="text-lg font-bold text-slate-800 flex items-center gap-2">
            <div class="w-8 h-8 bg-blue-50 text-blue-600 rounded-lg flex items-center justify-center">
              <i class="ph ph-share-network"></i>
            </div>
            Transférer
          </h3>
          <button
            class="w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-100 flex items-center justify-center transition-colors"
            @click="adm.isShareModalOpen = false"
          >
            <i class="ph ph-x"></i>
          </button>
        </div>
        <p
          class="text-xs text-slate-500 mb-4 truncate font-mono bg-slate-50 p-3 rounded-lg border border-slate-200"
        >
          "{{ adm.promptToShare && adm.promptToShare.title }}"
        </p>
        <div v-if="adm.myGroups && adm.myGroups.length > 0" class="flex flex-wrap gap-1.5 mb-3">
          <span class="text-xs font-semibold text-slate-500 self-center mr-1">Groupe :</span>
          <button
            v-for="g in adm.myGroups"
            :key="g.id"
            :class="
              adm.selectedGroupFilter === g.id
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-blue-50 text-blue-600 border-blue-200'
            "
            class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold border transition-colors"
            @click="adm.selectedGroupFilter = adm.selectedGroupFilter === g.id ? null : g.id"
          >
            {{ g.name }}
          </button>
        </div>
        <div class="mb-3">
          <label
            class="flex items-center gap-2 text-sm font-medium text-slate-700 p-2.5 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-100 transition-colors"
          >
            <input
              v-model="adm.selectAllUsers"
              type="checkbox"
              class="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              @change="adm.toggleSelectAllUsers"
            />
            Sélectionner tous les membres visibles
          </label>
        </div>
        <div
          class="max-h-52 overflow-y-auto bg-white border border-slate-200 rounded-lg mb-5 custom-scrollbar"
        >
          <div v-if="adm.filteredShareUsers.length === 0" class="text-center text-xs text-slate-400 py-4">
            Aucun membre disponible.
          </div>
          <template
            v-for="(grp, grpIdx) in adm.groupedShareUsers"
            :key="grp.groupLabel || '__nolabel_' + grpIdx"
          >
            <div
              v-if="grp.groupLabel"
              class="sticky top-0 z-10 px-3 py-1.5 bg-slate-50 border-b border-slate-100 flex items-center gap-1.5"
            >
              <i class="ph ph-users-three text-slate-400 text-xs"></i>
              <span class="text-xs font-semibold text-slate-500">{{ grp.groupLabel }}</span>
              <span class="ml-auto text-[10px] text-slate-300 font-normal">{{ grp.users.length }}</span>
            </div>
            <label
              v-for="u in grp.users"
              :key="u.id"
              class="flex items-center gap-3 px-3 py-2 hover:bg-slate-50 cursor-pointer transition-colors border-b border-slate-50 last:border-0"
            >
              <input
                v-model="adm.shareTargetUsers"
                type="checkbox"
                :value="u.id"
                class="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <div
                class="w-6 h-6 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center text-[10px] font-bold shrink-0"
              >
                {{ u.username.substring(0, 2).toUpperCase() }}
              </div>
              <span class="text-sm font-medium text-slate-700">{{ u.username }}</span>
            </label>
          </template>
        </div>
        <div class="flex justify-end gap-2">
          <button
            class="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            @click="adm.isShareModalOpen = false"
          >
            Annuler
          </button>
          <button
            :disabled="adm.shareTargetUsers.length === 0 || adm.shareSending"
            class="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg shadow-sm transition-colors"
            @click="adm.confirmShare"
          >
            {{ adm.shareSending ? "Envoi…" : "Envoyer" }}
          </button>
        </div>
      </div>
    </div>
  </Transition>

  <Transition name="modal">
    <div
      v-if="adm.groupModal.show"
      class="fixed inset-0 z-[7500] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
      @click.self="adm.groupModal.show = false"
    >
      <div
        class="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 context-menu-enter"
        role="dialog"
        aria-modal="true"
        :aria-label="adm.groupModal.isEdit ? 'Modifier le groupe' : 'Nouveau groupe'"
        tabindex="-1"
        data-a11y-modal
      >
        <div class="flex items-center gap-3 mb-5">
          <div class="w-10 h-10 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center">
            <i class="ph ph-users-three text-xl"></i>
          </div>
          <h3 class="font-bold text-slate-800 text-lg">
            {{ adm.groupModal.isEdit ? "Modifier le groupe" : "Nouveau groupe" }}
          </h3>
        </div>
        <div class="space-y-4">
          <label class="adm-field"
            ><span class="adm-field__label">Nom</span
            ><input v-model="adm.groupModal.name" type="text" class="set-input" placeholder="Ex : Équipe Dev"
          /></label>
          <label class="adm-field"
            ><span class="adm-field__label">Description</span
            ><input
              v-model="adm.groupModal.description"
              type="text"
              class="set-input"
              placeholder="Facultatif"
          /></label>
        </div>

        <div class="mt-5 space-y-4" data-llm-access>
          <div class="adm-field" data-llm-access-servers>
            <span class="adm-field__label">Serveurs</span>
            <div class="adm-seg adm-seg--sm self-start" role="group" aria-label="Serveurs">
              <button
                v-for="o in [
                  ['inherit', 'Libre', 'Ce groupe ne restreint pas les serveurs'],
                  ['all', 'Tous', 'Tous les serveurs, y compris ceux ajoutés plus tard'],
                  ['list', 'Liste', 'Seulement les serveurs cochés'],
                ]"
                :key="o[0]"
                type="button"
                :title="o[2]"
                :class="['adm-seg__btn', adm.groupModal.engineMode === o[0] ? 'is-active' : '']"
                :aria-pressed="adm.groupModal.engineMode === o[0] ? 'true' : 'false'"
                @click="adm.groupModal.engineMode = o[0]"
              >
                {{ o[1] }}
              </button>
            </div>
            <div v-if="adm.groupModal.engineMode === 'list'" class="adm-checks" data-llm-access-list>
              <div v-if="!adm.admLlmAccessOptions.length" class="adm-checks__empty">Aucun serveur</div>
              <label
                v-for="e in adm.admLlmAccessOptions"
                :key="e.key"
                class="adm-checks__item"
                :title="e.base_url || e.provider_type"
              >
                <input
                  v-model="adm.groupModal.engineKeys"
                  type="checkbox"
                  :value="e.key"
                  class="w-4 h-4 rounded border-slate-300 text-blue-600"
                />
                <span class="truncate">{{ e.label }}</span>
                <span class="adm-checks__meta">{{ e.enabled ? e.provider_type : "désactivé" }}</span>
              </label>
            </div>
            <span
              v-if="
                adm.groupModal.engineMode === 'list' &&
                adm.admLlmAccessOptions.length &&
                !adm.groupModal.engineKeys.length
              "
              class="adm-field__warn"
              >Aucun serveur coché : aucun accès</span
            >
          </div>
          <div class="adm-field" data-llm-access-manage>
            <span class="adm-field__label" title="Charger / décharger les modèles">Modèles</span>
            <div class="adm-seg adm-seg--sm self-start" role="group" aria-label="Gérer les modèles">
              <button
                v-for="o in [
                  ['inherit', 'Libre', 'Ce groupe ne règle pas ce droit'],
                  ['allow', 'Autorisé', 'Peut charger et décharger les modèles'],
                  ['deny', 'Interdit', 'Ne peut ni charger ni décharger'],
                ]"
                :key="o[0]"
                type="button"
                :title="o[2]"
                :class="['adm-seg__btn', adm.groupModal.manage === o[0] ? 'is-active' : '']"
                :aria-pressed="adm.groupModal.manage === o[0] ? 'true' : 'false'"
                @click="adm.groupModal.manage = o[0]"
              >
                {{ o[1] }}
              </button>
            </div>
          </div>
        </div>
        <div class="flex justify-end gap-3 mt-5">
          <button type="button" class="adm-btn adm-btn--quiet" @click="adm.groupModal.show = false">
            Annuler
          </button>
          <button
            :disabled="!adm.groupModal.name.trim()"
            type="button"
            class="adm-btn adm-btn--primary"
            @click="adm.saveGroup()"
          >
            {{ adm.groupModal.isEdit ? "Enregistrer" : "Créer" }}
          </button>
        </div>
      </div>
    </div>
  </Transition>

  <Transition name="modal">
    <div
      v-if="adm.groupMembersModal.show"
      class="fixed inset-0 z-[7500] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
      @click.self="adm.groupMembersModal.show = false"
    >
      <div
        class="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden context-menu-enter"
        role="dialog"
        aria-modal="true"
        aria-label="Membres du groupe"
        tabindex="-1"
        data-a11y-modal
      >
        <div class="p-5 border-b border-slate-100 flex items-center justify-between bg-blue-50">
          <div class="flex items-center gap-3">
            <div
              class="w-10 h-10 bg-white text-blue-600 rounded-xl flex items-center justify-center shadow-sm"
            >
              <i class="ph ph-users-three text-xl"></i>
            </div>
            <div>
              <h3 class="font-bold text-slate-800">
                {{ adm.groupMembersModal.group && adm.groupMembersModal.group.name }}
              </h3>
              <p class="text-xs text-slate-500">
                {{ adm.groupMembersModal.group && adm.groupMembersModal.group.member_count }} membre(s)
              </p>
            </div>
          </div>
          <button
            class="w-8 h-8 flex items-center justify-center text-slate-400 hover:bg-white/80 rounded-lg transition-colors"
            @click="adm.groupMembersModal.show = false"
          >
            <i class="ph ph-x"></i>
          </button>
        </div>
        <div class="p-4 max-h-80 overflow-y-auto custom-scrollbar">
          <div
            v-for="u in adm.allUsersWithGroups"
            :key="u.id"
            class="flex items-center justify-between p-2.5 rounded-xl hover:bg-slate-50 transition-colors"
          >
            <div class="flex items-center gap-3">
              <div
                class="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-xs font-bold text-slate-600"
              >
                {{ u.username.substring(0, 2).toUpperCase() }}
              </div>
              <div>
                <div class="text-sm font-semibold text-slate-700">{{ u.username }}</div>
                <div class="text-[11px] text-slate-400">{{ u.group_names || "Aucun groupe" }}</div>
              </div>
            </div>
            <button
              :class="
                adm.isInCurrentGroup(u)
                  ? 'bg-blue-600 text-white border-blue-600 hover:bg-red-500 hover:border-red-500'
                  : 'bg-white text-slate-500 border-slate-200 hover:bg-blue-50 hover:text-blue-600'
              "
              class="px-3 py-1.5 rounded-lg text-xs font-bold border transition-all"
              @click="adm.toggleMembership(u)"
            >
              {{ adm.isInCurrentGroup(u) ? "Retirer" : "Ajouter" }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>
