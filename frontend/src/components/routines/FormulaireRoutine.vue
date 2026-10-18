<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/routines/FormulaireRoutine.vue — formulaire de création et de modification par groupes (nom, déclencheurs, prompt, MCP, skills, agents). -->
<script setup lang="ts">
import { domaineRoutines } from "../../features/routines/domaine";

const rt = domaineRoutines();
</script>

<template>
  <!-- CREATE / EDIT form — UNE colonne compacte (max-w-2xl) : un seul GROUPE de champs à la fois -->
  <div class="flex-1 flex flex-col min-h-0">
    <!-- Scroller pleine largeur (cf. vue lecture) + rythme vertical serré : le formulaire 2 colonnes tient SANS -->
    <div class="flex-1 overflow-y-auto custom-scrollbar min-h-0">
      <div class="px-5 py-5 max-w-2xl w-full mx-auto">
        <!-- UN groupe à la fois, piloté par le menu du header (routineEditTab) -->

        <!-- ═══════ Nom ═══════ -->
        <section v-show="rt.routineEditTab === 'general'" class="space-y-3">
          <div class="flex items-end gap-3">
            <div class="flex-1">
              <label class="text-[11px] font-medium text-slate-500 block mb-1">Nom</label>
              <input v-model="rt.routineForm.name" placeholder="Veille quotidienne" class="set-input" />
            </div>
            <!-- Input NON clippé (absolute+opacity-0, pas sr-only) : le focus d'un input sr-only ferait défiler le shell -->
            <label class="relative flex items-center gap-2 pb-1.5 cursor-pointer shrink-0">
              <input
                v-model="rt.routineForm.enabled"
                type="checkbox"
                class="peer absolute inset-0 opacity-0 cursor-pointer"
              />
              <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
              <span class="text-xs text-slate-600">Active</span>
            </label>
          </div>

          <!-- ── Historique PAR ROUTINE : journal borné + notifications filtrées/bornées -->
          <div class="set-block space-y-2.5" data-routine-history>
            <div class="flex items-center gap-2">
              <i class="ph ph-clock-counter-clockwise text-blue-500"></i>
              <span class="text-xs font-semibold text-slate-700">Historique</span>
              <span class="text-[10px] text-slate-400">0 = tout conserver</span>
            </div>
            <div class="grid gap-2 sm:grid-cols-3">
              <div>
                <label class="text-[11px] font-medium text-slate-500 block mb-1">Exécutions gardées</label>
                <input
                  v-model.number="rt.routineForm.runs_keep"
                  type="number"
                  min="0"
                  :max="rt.ROUTINE_KEEP_MAX"
                  placeholder="0"
                  title="Nombre d'exécutions conservées au journal (0 = toutes)"
                  class="set-input set-control--sm"
                  data-history-runs-keep
                />
              </div>
              <div>
                <label class="text-[11px] font-medium text-slate-500 block mb-1">Notifications</label>
                <select
                  v-model="rt.routineForm.notify_on"
                  class="set-select set-control--sm w-full"
                  data-history-notify-on
                >
                  <option v-for="m in rt.ROUTINE_NOTIFY_MODES" :key="m.id" :value="m.id">
                    {{ m.label }}
                  </option>
                </select>
              </div>
              <div>
                <label class="text-[11px] font-medium text-slate-500 block mb-1">Notifications gardées</label>
                <input
                  v-model.number="rt.routineForm.notify_keep"
                  type="number"
                  min="0"
                  :max="rt.ROUTINE_KEEP_MAX"
                  :disabled="rt.routineForm.notify_on === 'none'"
                  placeholder="0"
                  title="Nombre de notifications conservées pour cette routine (0 = toutes)"
                  class="set-input set-control--sm disabled:opacity-50"
                  data-history-notify-keep
                />
              </div>
            </div>
          </div>
        </section>

        <!-- ═══════ Planification ═══════ -->
        <section v-show="rt.routineEditTab === 'schedule'" class="space-y-3">
          <div class="set-block space-y-2.5">
            <!-- Fréquence -->
            <select v-model="rt.schedule.freq" class="set-select w-full">
              <option value="minutes">Toutes les X minutes</option>
              <option value="hourly">Toutes les heures</option>
              <option value="daily">Tous les jours</option>
              <option value="weekly">Chaque semaine</option>
              <option value="monthly">Chaque mois</option>
              <option value="custom">Avancé (cron)</option>
              <option value="none">Aucune (manuel / webhook)</option>
            </select>

            <!-- Toutes les X minutes -->
            <div v-if="rt.schedule.freq === 'minutes'" class="flex items-center gap-2 text-sm text-slate-600">
              <span>Toutes les</span>
              <input
                v-model.number="rt.schedule.everyMinutes"
                type="number"
                min="1"
                max="59"
                class="set-input !w-20 text-center"
              />
              <span>minutes</span>
            </div>

            <!-- Toutes les heures -->
            <div
              v-else-if="rt.schedule.freq === 'hourly'"
              class="flex items-center gap-2 text-sm text-slate-600"
            >
              <span>À la minute</span>
              <input
                v-model.number="rt.schedule.atMinute"
                type="number"
                min="0"
                max="59"
                class="set-input !w-20 text-center"
              />
              <span>de chaque heure</span>
            </div>

            <!-- Tous les jours -->
            <div
              v-else-if="rt.schedule.freq === 'daily'"
              class="flex items-center gap-2 text-sm text-slate-600"
            >
              <span>À</span>
              <input
                v-model="rt.schedule.time"
                type="time"
                title="Heure du serveur"
                class="set-input !w-auto"
              />
            </div>

            <!-- Chaque semaine -->
            <div v-else-if="rt.schedule.freq === 'weekly'" class="space-y-2">
              <div class="flex flex-wrap gap-1">
                <button
                  v-for="d in rt.weekdayChips"
                  :key="d.n"
                  type="button"
                  class="w-10 h-8 rounded-md text-xs font-medium transition-colors border"
                  :class="
                    rt.isWeekday(d.n)
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                  "
                  @click="rt.toggleWeekday(d.n)"
                >
                  {{ d.l }}
                </button>
              </div>
              <div class="flex items-center gap-2 text-sm text-slate-600">
                <span>à</span>
                <input
                  v-model="rt.schedule.time"
                  type="time"
                  title="Heure du serveur"
                  class="set-input !w-auto"
                />
              </div>
            </div>

            <!-- Chaque mois -->
            <div
              v-else-if="rt.schedule.freq === 'monthly'"
              class="flex items-center gap-2 text-sm text-slate-600 flex-wrap"
            >
              <span>Le</span>
              <select v-model.number="rt.schedule.dayOfMonth" class="set-select">
                <option v-for="n in 31" :key="n" :value="n">{{ n }}</option>
              </select>
              <span>du mois à</span>
              <input
                v-model="rt.schedule.time"
                type="time"
                title="Heure du serveur"
                class="set-input !w-auto"
              />
            </div>

            <!-- Avancé (cron brut) -->
            <div v-else-if="rt.schedule.freq === 'custom'">
              <input v-model="rt.schedule.custom" placeholder="0 9 * * *" class="set-input font-mono" />
              <p class="text-[10px] text-slate-400 mt-1">
                Format : <span class="font-mono">min heure jour mois jour-semaine</span> (Lun=1 … Dim=7).
              </p>
            </div>

            <!-- Aucune planification -->
            <p v-else-if="rt.schedule.freq === 'none'" class="text-xs text-slate-500">
              La routine ne se lancera que via « Exécuter » ou par webhook (section ci-dessous).
            </p>

            <!-- Résumé live -->
            <div class="flex items-center gap-2 pt-2.5 border-t border-slate-100">
              <i class="ph ph-clock text-blue-500"></i>
              <span class="text-xs text-slate-700 font-medium">{{ rt.scheduleSummary }}</span>
              <span class="text-[10px] text-slate-400 font-mono ml-auto" title="Expression cron générée">{{
                rt.builtCron
              }}</span>
            </div>
          </div>

          <!-- ── Webhook ENTRANT : un émetteur HTTP (forge, CI, supervision) déclenche cette routine — auth par secret -->
          <div class="set-block space-y-2.5">
            <div class="flex items-center gap-2">
              <i class="ph ph-lightning text-blue-500"></i>
              <span class="text-xs font-semibold text-slate-700">Webhook</span>
              <span
                v-if="rt.webhookEnabled"
                class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700"
                >Actif</span
              >
            </div>

            <p v-if="rt.routineEditMode === 'create'" class="text-[11px] text-slate-400 italic">
              Enregistrez d'abord la routine.
            </p>

            <template v-else>
              <div class="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  :disabled="rt.webhookBusy"
                  class="text-xs px-2.5 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  @click="rt.rotateWebhook"
                >
                  <i class="ph ph-key"></i> Générer un token
                </button>
                <button
                  v-if="rt.webhookEnabled"
                  type="button"
                  :disabled="rt.webhookBusy"
                  class="text-xs px-2.5 py-1.5 rounded-md bg-slate-100 hover:bg-red-50 text-slate-600 hover:text-red-600 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  @click="rt.disableWebhook"
                >
                  <i class="ph ph-power"></i> Désactiver
                </button>
              </div>

              <!-- Token : visible UNE seule fois, après génération -->
              <div v-if="rt.webhookSecret">
                <label class="text-[11px] font-medium text-amber-700 block mb-1"
                  >Token <span class="font-normal">(affiché une seule fois)</span></label
                >
                <div class="flex items-center gap-1.5">
                  <code
                    class="text-[11px] font-mono bg-amber-50 border border-amber-200 rounded px-1.5 py-1 truncate flex-1 min-w-0"
                    >{{ rt.webhookSecret }}</code
                  >
                  <button
                    type="button"
                    title="Copier"
                    class="w-7 h-7 shrink-0 rounded-md bg-white border border-amber-200 text-amber-700 hover:bg-amber-100 flex items-center justify-center"
                    @click="rt.copyWebhookText(rt.webhookSecret)"
                  >
                    <i class="ph ph-copy" style="font-size: 12px"></i>
                  </button>
                </div>
              </div>

              <div v-if="rt.webhookEnabled" class="space-y-2.5">
                <div>
                  <label class="text-[11px] font-medium text-slate-500 block mb-1">URL</label>
                  <div class="flex items-center gap-1.5">
                    <code
                      class="text-[11px] font-mono bg-slate-50 border border-slate-200 rounded px-1.5 py-1 truncate flex-1 min-w-0"
                      >{{ rt.webhookUrl() }}</code
                    >
                    <button
                      type="button"
                      title="Copier"
                      class="w-7 h-7 shrink-0 rounded-md bg-white border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-300 flex items-center justify-center"
                      @click="rt.copyWebhookText(rt.webhookUrl())"
                    >
                      <i class="ph ph-copy" style="font-size: 12px"></i>
                    </button>
                  </div>
                </div>
                <div class="grid gap-2 sm:grid-cols-3">
                  <div>
                    <label class="text-[11px] font-medium text-slate-500 block mb-1">Événements</label>
                    <!-- état local brut (parsé à l'enregistrement) : un champ dérivé re-normalisait chaque frappe et expulsait le -->
                    <input
                      v-model="rt.webhookEventsInput"
                      title="Liste séparée par des virgules (ex. push, release)"
                      placeholder="tous"
                      class="set-input set-control--sm font-mono"
                    />
                  </div>
                  <div>
                    <label class="text-[11px] font-medium text-slate-500 block mb-1">Branche</label>
                    <input
                      v-model="rt.webhookFilterForm.branch"
                      placeholder="—"
                      class="set-input set-control--sm font-mono"
                    />
                  </div>
                  <div>
                    <label class="text-[11px] font-medium text-slate-500 block mb-1">Dépôt</label>
                    <input
                      v-model="rt.webhookFilterForm.repo"
                      placeholder="owner/nom"
                      class="set-input set-control--sm font-mono"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  :disabled="rt.webhookBusy"
                  class="text-xs px-2.5 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  @click="rt.saveWebhookFilter()"
                >
                  <i class="ph ph-check"></i> Enregistrer
                </button>
              </div>
            </template>
          </div>

          <!-- ── Enchaînement (à la Jenkins) : se lance après une autre routine — enregistré avec la routine (bouton global) -->
          <div class="set-block space-y-2.5">
            <div class="flex items-center gap-2">
              <i class="ph ph-link text-blue-500"></i>
              <span class="text-xs font-semibold text-slate-700">Enchaînement</span>
            </div>
            <div class="grid gap-2 sm:grid-cols-2">
              <div>
                <label class="text-[11px] font-medium text-slate-500 block mb-1">Après</label>
                <select v-model="rt.routineForm.trigger_after_id" class="set-select set-control--sm w-full">
                  <option :value="null">— aucune —</option>
                  <option
                    v-for="r in rt.routines.filter((x) => x.id !== rt.selectedRoutineId)"
                    :key="r.id"
                    :value="r.id"
                  >
                    {{ r.name }}
                  </option>
                </select>
              </div>
              <div>
                <label class="text-[11px] font-medium text-slate-500 block mb-1">Si</label>
                <select
                  v-model="rt.routineForm.trigger_after_on"
                  :disabled="!rt.routineForm.trigger_after_id"
                  class="set-select set-control--sm w-full disabled:opacity-50"
                >
                  <option value="ok">Succès</option>
                  <option value="error">Échec</option>
                  <option value="always">Toujours</option>
                </select>
              </div>
            </div>
          </div>
        </section>

        <!-- ═══════ Prompt (modèle, prompts, réflexion) ═══════ -->
        <section v-show="rt.routineEditTab === 'prompt'" class="space-y-3">
          <!-- Serveur + modèle : le couple est ATOMIQUE (deux serveurs peuvent exposer le même nom de modèle), d'où deux -->
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-[11px] font-medium text-slate-500 block mb-1">Serveur</label>
              <select
                v-model="rt.routineForm.connector_id"
                class="set-select w-full"
                @change="rt.onRoutineConnectorChange"
              >
                <option v-if="rt.builtinAllowed" :value="null">Intégré</option>
                <option v-for="c in rt.pickerConnectors || []" :key="c.id" :value="c.id">
                  {{ c.label }}
                </option>
              </select>
            </div>
            <div>
              <label class="text-[11px] font-medium text-slate-500 block mb-1">Modèle</label>
              <select v-model="rt.routineForm.model" class="set-select w-full">
                <option value="">(modèle par défaut)</option>
                <option v-for="m in rt.routineModelOptions" :key="m.id" :value="m.id">
                  {{ m.label }}
                </option>
              </select>
            </div>
          </div>

          <!-- System prompt -->
          <div>
            <label class="text-[11px] font-medium text-slate-500 block mb-1"
              >System prompt <span class="text-slate-400">(optionnel)</span></label
            >
            <textarea
              v-model="rt.routineForm.system_prompt"
              rows="2"
              placeholder="Tu es un assistant de veille…"
              class="set-textarea !min-h-0"
            ></textarea>
          </div>

          <!-- Task prompt -->
          <div>
            <label class="text-[11px] font-medium text-slate-500 block mb-1">Tâche à exécuter</label>
            <textarea
              v-model="rt.routineForm.task_prompt"
              rows="5"
              placeholder="Liste les fichiers modifiés aujourd'hui dans /work et résume-les."
              class="set-textarea"
            ></textarea>
          </div>

          <!-- Mode réflexion — input NON clippé (cf. toggle « Active ») : sr-only ici déclencherait le scroll-trap du shell -->
          <label class="relative flex items-center gap-2 cursor-pointer w-fit">
            <input
              v-model="rt.routineForm.thinking_mode"
              type="checkbox"
              class="peer absolute inset-0 opacity-0 cursor-pointer"
            />
            <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
            <span class="text-xs text-slate-600">Mode réflexion (thinking)</span>
          </label>
        </section>

        <!-- ═══════ MCP ═══════ -->
        <section v-show="rt.routineEditTab === 'mcp'" class="space-y-3">
          <!-- Serveurs MCP : UN seul conteneur, deux groupes séparés par un filet -->
          <div>
            <label class="text-[11px] font-medium text-slate-500 block mb-1.5"
              >Serveurs MCP utilisés par la tâche</label
            >
            <div class="border border-slate-200 rounded-lg p-3 space-y-3">
              <!-- Outils locaux -->
              <div>
                <div class="text-xs font-semibold text-slate-600 mb-1.5">Outils locaux</div>
                <div
                  v-if="(rt.mcpUserCategories || []).length === 0"
                  class="text-[11px] text-slate-400 italic"
                >
                  Aucune catégorie locale disponible.
                </div>
                <div v-else class="grid gap-0.5 sm:grid-cols-2" data-mcp-local>
                  <label
                    v-for="cat in rt.mcpUserCategories"
                    :key="cat.name"
                    class="relative flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-50 cursor-pointer min-w-0"
                  >
                    <input
                      type="checkbox"
                      :checked="rt.isLocalCatOn(cat.name)"
                      class="peer absolute inset-0 opacity-0 cursor-pointer"
                      @change="rt.toggleRoutineLocalCat(cat.name)"
                    />
                    <i class="ph text-base text-slate-400 shrink-0" :class="cat.icon || 'ph-package'"></i>
                    <span class="text-xs text-slate-700 truncate flex-1">{{ cat.label || cat.name }}</span>
                    <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
                  </label>
                </div>
              </div>
              <!-- Serveurs externes -->
              <div class="pt-3 border-t border-slate-100">
                <div class="text-xs font-semibold text-slate-600 mb-1.5">Serveurs externes</div>
                <div v-if="rt.pinnedServers.length === 0" class="text-[11px] text-slate-400 italic">
                  Aucun serveur MCP externe configuré.
                </div>
                <div v-else class="grid gap-0.5 sm:grid-cols-2" data-mcp-external>
                  <label
                    v-for="srv in rt.pinnedServers"
                    :key="srv.id"
                    class="relative flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-50 cursor-pointer min-w-0"
                  >
                    <input
                      type="checkbox"
                      :checked="rt.isExternalOn(srv.id)"
                      class="peer absolute inset-0 opacity-0 cursor-pointer"
                      @change="rt.toggleRoutineExternal(srv)"
                    />
                    <span class="text-xs text-slate-700 truncate flex-1">{{ srv.name }}</span>
                    <span class="text-[9px] text-slate-400 font-mono shrink-0">{{ srv.type }}</span>
                    <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- ═══════ Skills ═══════ -->
        <section v-show="rt.routineEditTab === 'skills'" class="space-y-3">
          <!-- Skills attachés : l'agent du run n'a pas l'index des skills — le corps des skills cochés est injecté dans son -->
          <div>
            <label class="text-[11px] font-medium text-slate-500 block mb-1.5">
              Skills attachés à la tâche <span class="text-slate-400">(optionnel)</span>
              <!-- &nbsp; : Vue (mode condense) supprime le nœud blanc entre spans -->
              <span v-if="rt.routineSkillsCount" class="text-slate-400"
                >&nbsp;— {{ rt.routineSkillsCount }} sélectionné(s)</span
              >
            </label>
            <div class="border border-slate-200 rounded-lg p-3">
              <!-- Sous-skills LISTÉS d'office sous leur paquet (le chevron replie) : repliés par défaut, ils passaient pour -->
              <p class="text-[10px] text-slate-400 mb-1.5">
                Cocher un paquet embarque tous ses skills ; cocher un skill dessous ne cible que lui.
              </p>
              <div v-if="rt.routineSkillsLoading && !rt.routineSkills.length" class="text-center py-2">
                <i class="ph ph-spinner animate-spin text-slate-300"></i>
              </div>
              <!-- (passe 6, F13) — échec de chargement ≠ liste vide : avant, un /api/skills en erreur affichait -->
              <div
                v-else-if="!rt.routineSkillsLoadedOk"
                class="text-[11px] text-slate-400 italic flex items-center gap-2"
              >
                <span>Skills indisponibles (erreur de chargement).</span>
                <button
                  type="button"
                  class="text-blue-600 hover:underline font-medium not-italic"
                  @click="rt.reloadRoutineSkills()"
                >
                  Réessayer
                </button>
              </div>
              <div v-else-if="!rt.routineSkills.length" class="text-[11px] text-slate-400 italic">
                Aucun skill disponible. Créez-les depuis la page Skills.
              </div>
              <!-- Arbre : racines (paquets dépliables via chevron) → sous-skills indentés. -->
              <div v-else class="max-h-[45vh] overflow-y-auto custom-scrollbar space-y-0.5">
                <template v-for="node in rt.routineSkillTree" :key="node.skill.id || node.skill.name">
                  <div class="flex items-center gap-1">
                    <button
                      v-if="node.children.length"
                      type="button"
                      :aria-expanded="rt.isSkillExpanded(node.skill.id || node.skill.name) ? 'true' : 'false'"
                      :aria-label="'Sous-skills de ' + node.skill.name"
                      class="w-5 h-5 rounded flex items-center justify-center text-slate-400 hover:bg-slate-50 hover:text-slate-600 shrink-0 transition-colors"
                      @click="rt.toggleSkillExpand(node.skill.id || node.skill.name)"
                    >
                      <i
                        class="ph text-[11px]"
                        :class="
                          rt.isSkillExpanded(node.skill.id || node.skill.name)
                            ? 'ph-caret-down'
                            : 'ph-caret-right'
                        "
                      ></i>
                    </button>
                    <span v-else class="w-5 shrink-0"></span>
                    <label
                      :title="node.skill.description || ''"
                      class="flex items-center gap-2 p-1 rounded hover:bg-slate-50 cursor-pointer flex-1 min-w-0"
                    >
                      <input
                        type="checkbox"
                        :checked="rt.isRoutineSkillOn(node.skill.id || node.skill.name)"
                        class="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        @change="rt.toggleRoutineSkill(node.skill.id || node.skill.name)"
                      />
                      <i class="ph ph-graduation-cap text-sm text-slate-400 shrink-0"></i>
                      <span class="text-xs text-slate-700 truncate flex-1">{{ node.skill.name }}</span>
                      <span v-if="node.children.length" class="text-[9px] text-slate-400 shrink-0"
                        >{{ node.children.length }} sous-skill(s)</span
                      >
                      <span
                        v-else-if="rt.skillDomainBadge(node.skill)"
                        class="text-[9px] text-slate-400 shrink-0"
                        >{{ rt.skillDomainBadge(node.skill) }}</span
                      >
                    </label>
                  </div>
                  <template v-if="rt.isSkillExpanded(node.skill.id || node.skill.name)">
                    <div
                      v-for="c in node.children"
                      :key="c.id || c.name"
                      class="flex items-center gap-1"
                      :style="{ paddingLeft: 0.25 + (c.depth || 1) * 1.5 + 'rem' }"
                    >
                      <label
                        :title="c.description || ''"
                        class="flex items-center gap-2 p-1 rounded hover:bg-slate-50 cursor-pointer flex-1 min-w-0"
                      >
                        <input
                          type="checkbox"
                          :checked="rt.isRoutineSkillOn(c.id || c.name)"
                          class="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                          @change="rt.toggleRoutineSkill(c.id || c.name)"
                        />
                        <i class="ph ph-arrow-elbow-down-right text-[11px] text-slate-300 shrink-0"></i>
                        <span class="text-xs text-slate-600 truncate flex-1">{{
                          rt.skillLeafLabel(c, node.skill)
                        }}</span>
                      </label>
                    </div>
                  </template>
                </template>
              </div>
              <!-- Sélections qui ne résolvent plus (skill supprimé/renommé) : visibles, retirables, et retirées du payload à -->
              <div
                v-if="rt.orphanRoutineSkills.length"
                class="mt-1.5 pt-1.5 border-t border-slate-100 flex flex-wrap gap-1"
              >
                <span
                  v-for="sid in rt.orphanRoutineSkills"
                  :key="'orph:' + sid"
                  title="Skill introuvable (supprimé ou renommé ?) — sera retiré à l'enregistrement"
                  class="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-700 flex items-center gap-1"
                >
                  {{ sid }}
                  <button
                    type="button"
                    class="hover:text-amber-900 flex items-center"
                    :aria-label="'Retirer ' + sid"
                    @click="rt.removeRoutineSkill(sid)"
                  >
                    <i class="ph ph-x text-[10px]"></i>
                  </button>
                </span>
              </div>
            </div>
          </div>
        </section>

        <!-- ═══════ AGENTS ═══════ -->
        <!-- Opt-in PAR ROUTINE de l'outil ``task`` -->
        <section v-show="rt.routineEditTab === 'agents'" class="space-y-3">
          <!-- Interrupteur MAÎTRE d'instance coupé : on le DIT au lieu de laisser cocher une case que le serveur ignorera. -->
          <p
            v-if="!rt.features?.agents"
            class="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
          >
            Sous-agents désactivés sur cette instance (réglage administrateur).
          </p>
          <label
            class="relative flex items-center gap-2 w-fit"
            :class="rt.features?.agents ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'"
          >
            <input
              v-model="rt.routineForm.agents_enabled"
              type="checkbox"
              :disabled="!rt.features?.agents"
              class="peer absolute inset-0 opacity-0 cursor-pointer disabled:cursor-not-allowed"
            />
            <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
            <span class="text-xs text-slate-600">Déléguer à des sous-agents</span>
          </label>
          <div
            v-if="rt.routineForm.agents_enabled && rt.features?.agents"
            class="border border-slate-200 rounded-lg p-3 space-y-1.5"
          >
            <div class="text-[11px] font-medium text-slate-500">Agents disponibles pendant le run</div>
            <div class="flex flex-wrap gap-1">
              <span
                v-for="a in rt.ROUTINE_BUILTIN_AGENTS"
                :key="a.name"
                :title="a.hint"
                class="text-[11px] px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-600 font-mono"
                >{{ a.name }}</span
              >
              <span
                v-for="a in rt.settings.custom_agents || []"
                :key="'c:' + a.name"
                :title="a.description || 'agent personnalisé'"
                class="text-[11px] px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-700 font-mono"
                >{{ a.name }}</span
              >
            </div>
            <p class="text-[10px] text-slate-400">
              Contexte, tokens et écritures sandbox propres à chaque agent — comptés dans le journal du run.
            </p>
          </div>
        </section>

        <!-- (Le journal des exécutions ne vit QUE dans la vue lecture.) -->
      </div>
    </div>
    <!-- /scroller pleine largeur -->

    <!-- action bar -->
    <div class="border-t border-slate-200 px-3 py-2 flex items-center gap-2 shrink-0">
      <button
        v-if="rt.routineEditMode === 'edit'"
        :disabled="rt.routinesBusy || !!(rt.viewed && !rt.viewed.enabled)"
        :title="rt.viewed && !rt.viewed.enabled ? 'Routine en pause — réactivez-la pour l\'exécuter' : ''"
        class="text-xs px-3 py-1.5 rounded-md bg-emerald-50 hover:bg-emerald-100 text-emerald-700 transition-colors flex items-center gap-1.5 disabled:opacity-50"
        @click="rt.runRoutineNow"
      >
        <i class="ph ph-play"></i> Exécuter maintenant
      </button>
      <button
        v-if="rt.routineEditMode === 'edit'"
        :disabled="rt.routinesBusy"
        class="text-xs px-3 py-1.5 rounded-md bg-white border border-slate-200 hover:bg-red-50 hover:border-red-200 hover:text-red-600 text-slate-600 transition-colors flex items-center gap-1.5 disabled:opacity-50"
        @click="rt.deleteRoutine()"
      >
        <i class="ph ph-trash"></i> Supprimer
      </button>
      <div class="ml-auto flex items-center gap-2">
        <button
          class="text-xs px-3 py-1.5 rounded-md bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 transition-colors"
          @click="rt.cancelRoutineEdit"
        >
          Annuler
        </button>
        <button
          :disabled="rt.routinesBusy"
          class="text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
          @click="rt.saveRoutine"
        >
          <i class="ph ph-floppy-disk"></i> {{ rt.routineEditMode === "edit" ? "Enregistrer" : "Créer" }}
        </button>
      </div>
    </div>
  </div>
</template>
