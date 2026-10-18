<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageComptes.vue — pages Comptes et Groupes. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";

const adm = domaineAdmin();
</script>

<template>
  <div v-if="['accounts', 'groups'].includes(adm.adminTab)" class="animate-[fadeIn_0.2s]">
    <div class="space-y-6 min-w-0">
      <section v-if="adm.adminTab === 'accounts'" id="accounts" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-user-circle adm-card__icon" aria-hidden="true"></i>
          <div>
            <h3 class="adm-card__title">
              Comptes <span class="font-normal text-slate-500">· {{ adm.filteredSortedUsers.length }}</span>
            </h3>
          </div>
        </header>

        <div v-if="!adm.filteredSortedUsers.length" class="px-5">
          <p class="adm-empty">
            {{ adm.usersSearch ? "Aucun compte ne correspond au filtre." : "Aucun compte enregistré." }}
          </p>
        </div>

        <div v-else class="overflow-x-auto">
          <table class="adm-users w-full text-sm text-left">
            <thead class="text-slate-500 text-xs">
              <tr>
                <th scope="col" class="px-5 py-2.5">
                  <button
                    class="flex items-center gap-1 hover:text-slate-800 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/40 rounded"
                    @click="adm.toggleUsersSort('username')"
                  >
                    Compte
                    <i
                      class="ph text-[10px]"
                      :class="
                        adm.usersSort.field === 'username'
                          ? adm.usersSort.dir > 0
                            ? 'ph-caret-up'
                            : 'ph-caret-down'
                          : 'ph-caret-up-down text-slate-300'
                      "
                      aria-hidden="true"
                    ></i>
                  </button>
                </th>
                <th scope="col" class="px-3 py-2.5">Rôle</th>
                <th scope="col" class="px-3 py-2.5">Groupes</th>
                <th scope="col" class="px-3 py-2.5" title="Serveurs d'inférence utilisables">Serveurs</th>
                <th scope="col" class="px-3 py-2.5" title="Charger / décharger les modèles">Modèles</th>
                <th scope="col" class="px-3 py-2.5">Sandbox</th>
                <th scope="col" class="px-3 py-2.5" title="Machines desktop pilotables">Machines</th>
                <th scope="col" class="px-5 py-2.5"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="u in adm.pagedUsers" :key="u.id">
                <tr
                  :class="adm.userEditOpen(u) ? 'adm-users__open' : 'hover:bg-slate-50'"
                  class="transition-colors"
                >
                  <td class="px-5 py-2.5">
                    <div class="flex items-center gap-3">
                      <img
                        v-if="u.avatar"
                        :src="'/avatars/' + u.avatar"
                        alt=""
                        class="w-7 h-7 rounded-full object-cover"
                      />
                      <div
                        v-else
                        class="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center text-[11px] font-bold text-blue-700"
                        aria-hidden="true"
                      >
                        {{ u.username.substring(0, 2).toUpperCase() }}
                      </div>
                      <div class="min-w-0">
                        <div class="font-medium text-slate-800 truncate">
                          {{ u.username
                          }}<span v-if="u.id === adm.user.id" class="adm-users__muted font-normal">
                            · vous</span
                          >
                        </div>
                        <div class="adm-users__muted font-mono">#{{ u.id }}</div>
                      </div>
                    </div>
                  </td>
                  <td class="px-3 py-2.5">
                    <span v-if="u.is_admin === 1" class="adm-pill elpis-role-admin-badge">{{
                      adm.admRoleLabel(u)
                    }}</span>
                    <span v-else-if="u.is_admin === 2" class="adm-pill adm-pill--mod">{{
                      adm.admRoleLabel(u)
                    }}</span>
                    <span v-else class="text-xs text-slate-600">{{ adm.admRoleLabel(u) }}</span>
                  </td>
                  <td class="px-3 py-2.5">
                    <div v-if="u.group_names" class="flex flex-wrap gap-1">
                      <span v-for="g in u.group_names.split(', ')" :key="g" class="adm-pill">{{ g }}</span>
                    </div>
                    <span v-else class="adm-users__muted">—</span>
                  </td>
                  <td class="px-3 py-2.5" data-llm-servers :title="adm.admLlmAccessServersTitle(u)">
                    <span
                      class="adm-pill"
                      :class="{ 'adm-pill--warn': adm.admLlmAccessServersLabel(u) === 'Aucun' }"
                      >{{ adm.admLlmAccessServersLabel(u)
                      }}<i
                        v-if="u.llm_engine_source === 'groups'"
                        class="ph ph-users-three"
                        aria-label="hérité des groupes"
                      ></i
                    ></span>
                  </td>
                  <td class="px-3 py-2.5" data-llm-manage :title="adm.admLlmAccessManageTitle(u)">
                    <span
                      class="adm-pill"
                      :class="{ 'adm-pill--warn': adm.admLlmAccessManageLabel(u) === 'Non' }"
                      >{{ adm.admLlmAccessManageLabel(u)
                      }}<i
                        v-if="u.llm_manage_source === 'groups'"
                        class="ph ph-users-three"
                        aria-label="hérité des groupes"
                      ></i
                    ></span>
                  </td>
                  <td class="px-3 py-2.5 whitespace-nowrap">
                    <div
                      class="text-xs tabular-nums"
                      :class="
                        u.sandbox_quota_mb > 0 && u.sandbox_used_mb / u.sandbox_quota_mb >= 0.9
                          ? 'text-red-600 font-semibold'
                          : 'text-slate-700'
                      "
                    >
                      {{ u.sandbox_used_mb || 0 }} /
                      {{ u.sandbox_quota_mb > 0 ? u.sandbox_quota_mb + " Mo" : "illimité" }}
                    </div>
                    <div
                      class="adm-users__muted flex items-center gap-1"
                      :title="
                        u.forced_network_profile_id
                          ? 'Profil réseau imposé'
                          : 'Profil réseau choisi par le compte'
                      "
                    >
                      <i v-if="u.forced_network_profile_id" class="ph ph-lock-simple" aria-label="imposé"></i
                      >{{ adm.admNetProfileName(u.network_profile_id) }}
                    </div>
                  </td>
                  <td class="px-3 py-2.5" data-desktop :title="adm.admDesktopTitle(u)">
                    <span
                      class="adm-pill"
                      :class="{ 'adm-pill--warn': adm.admDesktopLabel(u) === 'Aucune' }"
                      >{{ adm.admDesktopLabel(u) }}</span
                    >
                  </td>
                  <td class="px-5 py-2.5">
                    <div class="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        class="adm-btn adm-btn--quiet"
                        :aria-expanded="adm.userEditOpen(u) ? 'true' : 'false'"
                        :aria-controls="'user-edit-' + u.id"
                        @click="adm.toggleUserEdit(u)"
                      >
                        {{ adm.userEditOpen(u) ? "Fermer" : "Modifier" }}
                        <i
                          class="ph text-xs"
                          :class="adm.userEditOpen(u) ? 'ph-caret-up' : 'ph-caret-down'"
                          aria-hidden="true"
                        ></i>
                      </button>
                      <button
                        type="button"
                        class="adm-btn adm-btn--icon"
                        :title="'Mot de passe de ' + u.username"
                        :aria-label="'Réinitialiser le mot de passe de ' + u.username"
                        @click="adm.openResetModal(u)"
                      >
                        <i class="ph ph-key" aria-hidden="true"></i>
                      </button>
                      <button
                        v-if="u.id !== adm.user.id"
                        type="button"
                        class="adm-btn adm-btn--icon adm-btn--danger-hover"
                        :title="'Supprimer ' + u.username"
                        :aria-label="'Supprimer ' + u.username"
                        @click="adm.deleteUser(u)"
                      >
                        <i class="ph ph-trash" aria-hidden="true"></i>
                      </button>
                    </div>
                  </td>
                </tr>
                <tr v-if="adm.userEdit && adm.userEditOpen(u)" :id="'user-edit-' + u.id">
                  <td colspan="8" class="p-0">
                    <form
                      class="adm-user-edit"
                      role="group"
                      :aria-label="'Réglages de ' + u.username"
                      data-user-edit
                      @submit.prevent="adm.saveUserEdit"
                      @keydown.esc.stop="adm.closeUserEdit"
                    >
                      <div class="adm-user-edit__grid">
                        <fieldset class="adm-user-edit__col">
                          <legend class="adm-user-edit__legend">Compte</legend>
                          <label class="adm-field">
                            <span class="adm-field__label">Rôle</span>
                            <select
                              v-model="adm.userEdit.role"
                              :disabled="u.id === adm.user.id"
                              class="set-select w-full"
                              data-user-edit-first
                            >
                              <option value="user">Utilisateur</option>
                              <option value="moderator">Modérateur</option>
                              <option value="admin">Administrateur</option>
                            </select>
                          </label>
                          <div class="adm-field">
                            <span class="adm-field__label">Groupes</span>
                            <div class="adm-checks">
                              <div v-if="!adm.groupsList.length" class="adm-checks__empty">Aucun groupe</div>
                              <label v-for="g in adm.groupsList" :key="g.id" class="adm-checks__item">
                                <input
                                  v-model="adm.userEdit.groups"
                                  type="checkbox"
                                  :value="g.id"
                                  class="w-4 h-4 rounded border-slate-300 text-blue-600"
                                />
                                <span class="truncate">{{ g.name }}</span>
                              </label>
                            </div>
                          </div>
                        </fieldset>

                        <fieldset class="adm-user-edit__col" data-llm-access>
                          <legend class="adm-user-edit__legend">Inférence</legend>
                          <div class="adm-field" data-llm-access-servers>
                            <span class="adm-field__label">Serveurs</span>
                            <div class="adm-seg adm-seg--sm self-start" role="group" aria-label="Serveurs">
                              <button
                                v-for="o in [
                                  ['inherit', 'Hérité', 'Serveurs de ses groupes, sinon tous'],
                                  ['all', 'Tous', 'Tous les serveurs, y compris ceux ajoutés plus tard'],
                                  ['list', 'Liste', 'Seulement les serveurs cochés'],
                                ]"
                                :key="o[0]"
                                type="button"
                                :title="o[2]"
                                :class="['adm-seg__btn', adm.userEdit.engineMode === o[0] ? 'is-active' : '']"
                                :aria-pressed="adm.userEdit.engineMode === o[0] ? 'true' : 'false'"
                                @click="adm.userEdit.engineMode = o[0]"
                              >
                                {{ o[1] }}
                              </button>
                            </div>
                            <div
                              v-if="adm.userEdit.engineMode === 'list'"
                              class="adm-checks"
                              data-llm-access-list
                            >
                              <div v-if="!adm.admLlmAccessOptions.length" class="adm-checks__empty">
                                Aucun serveur
                              </div>
                              <label
                                v-for="e in adm.admLlmAccessOptions"
                                :key="e.key"
                                class="adm-checks__item"
                                :title="e.base_url || e.provider_type"
                              >
                                <input
                                  v-model="adm.userEdit.engineKeys"
                                  type="checkbox"
                                  :value="e.key"
                                  class="w-4 h-4 rounded border-slate-300 text-blue-600"
                                />
                                <span class="truncate">{{ e.label }}</span>
                                <span class="adm-checks__meta">{{
                                  e.enabled ? e.provider_type : "désactivé"
                                }}</span>
                              </label>
                            </div>
                            <span
                              v-if="
                                adm.userEdit.engineMode === 'list' &&
                                adm.admLlmAccessOptions.length &&
                                !adm.userEdit.engineKeys.length
                              "
                              class="adm-field__warn"
                              >Aucun serveur coché : aucun accès</span
                            >
                          </div>
                          <div class="adm-field" data-llm-access-manage>
                            <span class="adm-field__label" title="Charger / décharger les modèles"
                              >Modèles</span
                            >
                            <div
                              class="adm-seg adm-seg--sm self-start"
                              role="group"
                              aria-label="Gérer les modèles"
                            >
                              <button
                                v-for="o in [
                                  ['inherit', 'Hérité', 'Règle de ses groupes, sinon autorisé'],
                                  ['allow', 'Autorisé', 'Peut charger et décharger les modèles'],
                                  ['deny', 'Interdit', 'Ne peut ni charger ni décharger'],
                                ]"
                                :key="o[0]"
                                type="button"
                                :title="o[2]"
                                :class="['adm-seg__btn', adm.userEdit.manage === o[0] ? 'is-active' : '']"
                                :aria-pressed="adm.userEdit.manage === o[0] ? 'true' : 'false'"
                                @click="adm.userEdit.manage = o[0]"
                              >
                                {{ o[1] }}
                              </button>
                            </div>
                          </div>
                        </fieldset>

                        <fieldset class="adm-user-edit__col">
                          <legend class="adm-user-edit__legend">Sandbox et machines</legend>
                          <label class="adm-field">
                            <span class="adm-field__label">Quota</span>
                            <span class="adm-field__row">
                              <input
                                v-model.number="adm.userEdit.quota"
                                type="number"
                                min="0"
                                step="512"
                                class="set-input adm-num--sm"
                                aria-label="Quota en Mo, 0 pour illimité"
                                title="0 = illimité"
                              />
                              <span class="adm-unit">Mo · {{ u.sandbox_used_mb || 0 }} utilisés</span>
                            </span>
                          </label>
                          <label class="adm-field">
                            <span class="adm-field__label">Réseau</span>
                            <select
                              v-model="adm.userEdit.network"
                              class="set-select w-full"
                              aria-label="Profil réseau imposé"
                            >
                              <option value="">Au choix du compte</option>
                              <option v-for="p in adm.usersNetProfiles" :key="p.id" :value="p.id">
                                {{ p.name }} (imposé)
                              </option>
                            </select>
                          </label>
                          <div class="adm-field" data-desktop-access>
                            <span class="adm-field__label">Machines</span>
                            <div class="adm-checks">
                              <div v-if="!adm.usersDesktopTargets.length" class="adm-checks__empty">
                                Aucune machine déclarée
                              </div>
                              <label
                                v-for="t in adm.usersDesktopTargets"
                                :key="t.name"
                                class="adm-checks__item"
                                :class="{ 'is-locked': t.access !== 'list' }"
                                :title="
                                  t.access !== 'list'
                                    ? 'Machine ouverte à tous (Connexions → Agents de contrôle)'
                                    : ''
                                "
                              >
                                <input
                                  v-if="t.access === 'list'"
                                  v-model="adm.userEdit.desktop"
                                  type="checkbox"
                                  :value="t.name"
                                  class="w-4 h-4 rounded border-slate-300 text-blue-600"
                                />
                                <input
                                  v-else
                                  type="checkbox"
                                  checked
                                  disabled
                                  class="w-4 h-4 rounded border-slate-300"
                                />
                                <span class="truncate">{{ t.name }}</span>
                                <span class="adm-checks__meta">{{
                                  t.access === "list" ? (t.os === "win" ? "Windows" : "Linux") : "ouverte"
                                }}</span>
                              </label>
                            </div>
                          </div>
                          <div class="adm-field" data-user-access>
                            <span class="adm-field__label">Accès par jeton</span>
                            <div class="adm-users__muted flex items-center gap-2">
                              <span v-if="!adm.userEdit.access">Chargement…</span>
                              <template v-else>
                                <span
                                  >{{ adm.userEdit.access.tokens.length }} jeton{{
                                    adm.userEdit.access.tokens.length > 1 ? "s" : ""
                                  }}
                                  · {{ adm.userEdit.access.grants.length }} application{{
                                    adm.userEdit.access.grants.length > 1 ? "s" : ""
                                  }}
                                  autorisée{{ adm.userEdit.access.grants.length > 1 ? "s" : "" }}</span
                                >
                                <button
                                  v-if="
                                    adm.userEdit.access.tokens.length || adm.userEdit.access.grants.length
                                  "
                                  type="button"
                                  class="adm-btn adm-btn--quiet"
                                  @click="adm.revokeUserAccess(u)"
                                >
                                  Tout révoquer
                                </button>
                              </template>
                            </div>
                          </div>
                        </fieldset>
                      </div>
                      <div class="adm-user-edit__foot">
                        <span class="adm-users__muted">{{
                          adm.userEdit.role === "admin"
                            ? "Administrateur : accès complet"
                            : adm.userEditDirty
                              ? "Modifications non enregistrées"
                              : ""
                        }}</span>
                        <button type="button" class="adm-btn adm-btn--quiet" @click="adm.closeUserEdit">
                          Annuler
                        </button>
                        <button
                          type="submit"
                          class="adm-btn adm-btn--primary"
                          :disabled="!adm.userEditDirty || adm.userEdit.saving"
                        >
                          {{ adm.userEdit.saving ? "Enregistrement…" : "Enregistrer" }}
                        </button>
                      </div>
                    </form>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <div
          v-if="adm.usersPageCount > 1"
          class="px-5 py-2.5 border-t border-slate-100 flex items-center justify-between"
        >
          <span class="text-xs text-slate-500"
            >Page {{ Math.min(adm.usersPage, adm.usersPageCount) }} sur {{ adm.usersPageCount }}</span
          >
          <div class="flex gap-1.5">
            <button
              :disabled="Math.min(adm.usersPage, adm.usersPageCount) <= 1"
              aria-label="Page précédente"
              type="button"
              class="adm-btn adm-btn--icon adm-tool"
              @click="adm.usersPage = Math.max(1, Math.min(adm.usersPage, adm.usersPageCount) - 1)"
            >
              <i class="ph ph-caret-left text-xs" aria-hidden="true"></i>
            </button>
            <button
              :disabled="Math.min(adm.usersPage, adm.usersPageCount) >= adm.usersPageCount"
              aria-label="Page suivante"
              type="button"
              class="adm-btn adm-btn--icon adm-tool"
              @click="
                adm.usersPage = Math.min(adm.usersPageCount, Math.min(adm.usersPage, adm.usersPageCount) + 1)
              "
            >
              <i class="ph ph-caret-right text-xs" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      </section>

      <section v-if="adm.adminTab === 'groups'" id="groups" class="adm-card scroll-mt-32">
        <header class="adm-card__head">
          <i class="ph ph-users-three adm-card__icon" aria-hidden="true"></i>
          <div class="min-w-0">
            <h3 class="adm-card__title">
              Groupes
              <span v-if="adm.groupsList.length" class="font-normal text-slate-500"
                >· {{ adm.groupsList.length }}</span
              >
            </h3>
          </div>
          <div class="adm-card__actions">
            <button class="adm-btn adm-tool" @click="adm.openCreateGroup()">
              <i class="ph ph-plus" aria-hidden="true"></i> Nouveau groupe
            </button>
          </div>
        </header>

        <div class="p-5">
          <p v-if="!adm.groupsList.length" class="adm-empty py-2">
            Aucun groupe. Créez-en un pour organiser les comptes et ouvrir le partage entre eux.
          </p>
          <div v-else class="grid gap-3" style="grid-template-columns: repeat(auto-fit, minmax(260px, 1fr))">
            <div
              v-for="g in adm.groupsList"
              :key="g.id"
              class="border border-slate-200 rounded-lg p-3.5 flex flex-col gap-2.5"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="font-medium text-slate-800 truncate">{{ g.name }}</div>
                  <div v-if="g.description" class="text-xs text-slate-500 mt-0.5">{{ g.description }}</div>
                </div>
                <div class="flex gap-0.5 shrink-0">
                  <button
                    :title="'Renommer ' + g.name"
                    :aria-label="'Renommer ' + g.name"
                    type="button"
                    class="adm-btn adm-btn--icon"
                    @click="adm.openEditGroup(g)"
                  >
                    <i class="ph ph-pencil text-sm" aria-hidden="true"></i>
                  </button>
                  <button
                    :title="'Supprimer ' + g.name"
                    class="adm-btn adm-btn--icon adm-btn--icon-danger"
                    @click="adm.confirmDeleteGroup(g)"
                  >
                    <i class="ph ph-trash text-sm" aria-hidden="true"></i>
                  </button>
                </div>
              </div>
              <div class="flex items-center justify-between text-xs border-t border-slate-100 pt-2">
                <span class="text-slate-500"
                  >{{ g.member_count }} membre{{ g.member_count > 1 ? "s" : "" }}</span
                >
                <button class="adm-link" @click="adm.openGroupMembers(g)">Gérer les membres</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
