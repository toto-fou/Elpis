<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/skills/OngletSkills.vue — onglet Skills des Paramètres : liste en arbre par portée, détail, formulaire, import (zip, dossier, SKILL.md) et dépôt de fichiers. -->
<script setup lang="ts">
import { domaineSkills } from "../../features/skills/domaine";
import NoeudSkill from "./NoeudSkill.vue";

const ks = domaineSkills();

function poserDeclencheur(el: unknown): void {
  ks.importMenuBtn = (el as HTMLElement | null) ?? null;
}
</script>

<!-- eslint-disable vue/no-v-html -- Markdown du skill rendu par le moteur du chat (purifié par DOMPurify). -->
<template>
  <div
    v-if="ks.settingsTab === 'skills'"
    role="region"
    aria-label="Gestion des skills"
    class="flex-1 min-h-0 flex flex-col relative bg-white"
    @dragenter="ks.onSkillsDragEnter"
    @dragover.prevent="ks.onSkillsDragOver"
    @dragleave="ks.onSkillsDragLeave"
    @drop.prevent="ks.onSkillsDrop"
  >
    <!-- Overlay drag-and-drop — v-if sec (reduced-motion-proof), SCOPÉ à l'onglet -->
    <div
      v-if="ks.skillsDragOver"
      class="absolute inset-0 z-10 pointer-events-none flex items-center justify-center"
      style="
        background: color-mix(
          in srgb,
          var(--surface) 62%,
          color-mix(in srgb, var(--accent) 30%, transparent)
        );
      "
    >
      <div class="bg-white border-2 border-dashed border-blue-500 rounded-xl px-8 py-6 text-center shadow-xl">
        <i class="ph ph-download-simple text-3xl text-blue-600 block mb-2"></i>
        <p class="text-sm font-semibold text-slate-800">Déposer pour importer</p>
        <p class="text-xs text-slate-500 mt-1">Archive .zip, dossier de skill ou fichier SKILL.md</p>
      </div>
    </div>

    <!-- ============ VUE LISTE (drill-down niveau 1) ============ v-show : la liste reste montée pendant le détail → -->
    <div v-show="!ks.skillEditMode" class="flex-1 min-h-0 flex flex-col">
      <!-- == Header — MÊME idiome que les autres onglets de la modal -->
      <div class="shrink-0 flex items-start justify-between gap-3 px-6 pt-6 pb-4 border-b border-slate-200">
        <div class="min-w-0">
          <h3 class="text-base font-semibold text-slate-800 mb-1">Skills</h3>
          <p class="text-xs text-slate-500">
            Mémoire procédurale de l'assistant — injectée automatiquement, ou via
            <span class="font-mono">/</span> dans le chat.
          </p>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <!-- Création guidée : ouvre un chat pré-configuré (skill « creer-un-skill » épinglé + outils skill/fs) où le LLM -->
          <button
            title="Créer un skill en dialoguant : l'assistant pose les questions, rédige, embarque les scripts et enregistre"
            class="skl-btn skl-btn--secondary"
            @click="ks.startSkillAssistantChat"
          >
            <i class="ph ph-sparkle"></i> Assistant
          </button>
          <button class="skl-btn bg-blue-600 text-white hover:bg-blue-700" @click="ks.startCreate">
            <i class="ph ph-plus"></i> Nouveau
          </button>
          <!-- Import : menu 3 sources -->
          <div class="relative" @keydown.escape="ks.closeSkillImportMenu">
            <button
              :ref="poserDeclencheur"
              :disabled="!!ks.skillsImporting"
              :aria-busy="ks.skillsImporting ? 'true' : 'false'"
              :aria-expanded="ks.showSkillImportMenu ? 'true' : 'false'"
              aria-haspopup="menu"
              title="Importer un skill : archive .zip, dossier complet ou fichier SKILL.md"
              class="skl-btn skl-btn--secondary"
              :class="ks.showSkillImportMenu && 'bg-slate-200'"
              @click="ks.showSkillImportMenu = !ks.showSkillImportMenu"
            >
              <i class="ph" :class="ks.skillsImporting ? 'ph-spinner animate-spin' : 'ph-upload-simple'"></i>
              Importer
              <i class="ph ph-caret-down text-[10px] text-slate-400"></i>
            </button>
            <div
              v-if="ks.showSkillImportMenu"
              class="fixed inset-0 z-40"
              @click="ks.closeSkillImportMenu"
            ></div>
            <Transition name="popover">
              <div
                v-if="ks.showSkillImportMenu"
                role="menu"
                aria-label="Sources d'import"
                class="absolute right-0 top-full mt-1 z-50 w-72 bg-white border border-slate-200 rounded-lg shadow-xl py-1"
              >
                <label
                  role="menuitem"
                  class="skl-menu-item w-full flex items-start gap-2.5 px-3 py-2 cursor-pointer"
                >
                  <i class="ph ph-file-zip text-slate-400 text-base mt-0.5 shrink-0"></i>
                  <span class="min-w-0">
                    <span class="block text-xs font-medium text-slate-700">Archive .zip</span>
                    <span class="block text-[11px] text-slate-500"
                      >Skill empaqueté ou package multi-skills</span
                    >
                  </span>
                  <input
                    type="file"
                    accept=".zip,application/zip"
                    class="sr-only"
                    aria-label="Importer un skill .zip"
                    @change="
                      ks.showSkillImportMenu = false;
                      ks.importSkillZip($event, 'user');
                    "
                  />
                </label>
                <label
                  role="menuitem"
                  class="skl-menu-item w-full flex items-start gap-2.5 px-3 py-2 cursor-pointer"
                >
                  <i class="ph ph-folder-open text-slate-400 text-base mt-0.5 shrink-0"></i>
                  <span class="min-w-0">
                    <span class="block text-xs font-medium text-slate-700">Dossier de skill</span>
                    <span class="block text-[11px] text-slate-500"
                      >SKILL.md + fichiers (scripts, références…)</span
                    >
                  </span>
                  <input
                    type="file"
                    webkitdirectory
                    class="sr-only"
                    aria-label="Importer un dossier de skill"
                    @change="
                      ks.showSkillImportMenu = false;
                      ks.importSkillFolder($event, 'user');
                    "
                  />
                </label>
                <label
                  role="menuitem"
                  class="skl-menu-item w-full flex items-start gap-2.5 px-3 py-2 cursor-pointer"
                >
                  <i class="ph ph-file-md text-slate-400 text-base mt-0.5 shrink-0"></i>
                  <span class="min-w-0">
                    <span class="block text-xs font-medium text-slate-700">Fichier SKILL.md</span>
                    <span class="block text-[11px] text-slate-500"
                      >Un markdown seul, sans fichiers joints</span
                    >
                  </span>
                  <input
                    type="file"
                    accept=".md,.markdown,text/markdown"
                    class="sr-only"
                    aria-label="Importer un fichier SKILL.md"
                    @change="
                      ks.showSkillImportMenu = false;
                      ks.importSkillMd($event, 'user');
                    "
                  />
                </label>
              </div>
            </Transition>
          </div>
          <button title="Rafraîchir" class="skl-btn skl-btn--ghost skl-btn--icon" @click="ks.loadAllSkills()">
            <i class="ph ph-arrow-clockwise" :class="ks.skillsLoading && 'animate-spin'"></i>
          </button>
        </div>
      </div>

      <!-- Filtre : pleine largeur, input capé (max-w-sm) pour rester calme -->
      <div class="px-6 py-3 shrink-0">
        <div class="relative max-w-sm">
          <i class="ph ph-magnifying-glass absolute left-3 top-2.5 text-slate-400 text-sm"></i>
          <input
            v-model="ks.skillsFilter"
            placeholder="Filtrer les skills…"
            class="w-full bg-slate-50 border border-slate-200 text-sm rounded-lg pl-9 pr-8 py-1.5 outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 placeholder:text-slate-500 transition-colors"
            @keydown.escape="ks.skillsFilter = ''"
          />
          <button
            v-if="ks.skillsFilter"
            aria-label="Effacer le filtre"
            title="Effacer le filtre"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
            @click="ks.skillsFilter = ''"
          >
            <i class="ph ph-x text-xs"></i>
          </button>
        </div>
        <p v-if="ks.skillsFilter.trim()" aria-live="polite" class="text-[11px] text-slate-500 px-1 mt-1.5">
          {{ ks.filteredTotalCount }} résultat{{ ks.filteredTotalCount > 1 ? "s" : "" }}
        </p>
      </div>

      <div class="flex-1 overflow-y-auto px-6 pb-4 custom-scrollbar">
        <!-- premier chargement : squelette STATIQUE (registre calme, reduced-motion-proof) -->
        <div v-if="ks.skillsLoading && ks.totalSkillsCount === 0" aria-busy="true" class="pt-1 space-y-5">
          <span class="sr-only">Chargement des skills…</span>
          <div v-for="g in 2" :key="g" aria-hidden="true">
            <div class="skl-skeleton h-3 w-16 mb-2"></div>
            <div class="space-y-1.5">
              <div v-for="i in 4" :key="i" class="skl-skeleton h-8 w-full"></div>
            </div>
          </div>
        </div>
        <!-- error -->
        <div v-else-if="ks.skillsError" class="text-center py-10">
          <i class="ph ph-warning text-amber-500 text-2xl block mb-2"></i>
          <p class="text-sm text-slate-500">{{ ks.skillsError }}</p>
          <button class="skl-btn skl-btn--secondary mt-3" @click="ks.loadAllSkills()">Réessayer</button>
        </div>
        <!-- bibliothèque vide : état qui ENSEIGNE les 3 portes d'entrée -->
        <div v-else-if="ks.totalSkillsCount === 0" class="text-center py-10 px-2">
          <i class="ph ph-graduation-cap text-slate-300 text-3xl block mb-2"></i>
          <p class="text-sm font-medium text-slate-600 mb-1">Aucun skill pour l'instant</p>
          <p class="text-xs text-slate-500 mb-3">
            Créez votre premier skill, importez un dossier existant, ou laissez l'assistant le rédiger avec
            vous.
          </p>
          <div class="flex items-center justify-center gap-2">
            <button class="skl-btn bg-blue-600 text-white hover:bg-blue-700" @click="ks.startCreate">
              Créer un skill
            </button>
            <button class="skl-btn skl-btn--secondary" @click="ks.showSkillImportMenu = true">
              Importer…
            </button>
          </div>
        </div>
        <!-- filtre sans correspondance (distinct du vide : icône + sortie) -->
        <div v-else-if="ks.filteredTotalCount === 0" class="text-center py-10 px-2">
          <i class="ph ph-magnifying-glass text-slate-300 text-3xl block mb-2"></i>
          <p class="text-sm font-medium text-slate-600 mb-1">
            Aucun résultat pour «&nbsp;{{ ks.skillsFilter.trim() }}&nbsp;»
          </p>
          <p class="text-xs text-slate-500 mb-3">
            La recherche couvre le nom, la description, le domaine et les tags.
          </p>
          <button class="skl-btn skl-btn--secondary" @click="ks.skillsFilter = ''">Effacer le filtre</button>
        </div>

        <!-- grouped : arbre réel (recherche active → liste plate des correspondances) -->
        <template v-else>
          <div v-for="scope in ['global', 'learned', 'user']" :key="scope">
            <div v-if="ks.filteredByScope[scope] && ks.filteredByScope[scope].length" class="mt-3 first:mt-0">
              <div class="text-[11px] font-semibold text-slate-500 px-1 mb-1.5 flex items-center gap-1.5">
                {{ scope === "user" ? "Perso" : scope === "learned" ? "Learned" : "Global" }}
                <span class="text-slate-400 font-normal">({{ ks.filteredByScope[scope].length }})</span>
              </div>
              <!-- Recherche : correspondances à plat (l'arbre masquerait les enfants de parents non matchés) -->
              <div v-if="ks.skillsFilter.trim()">
                <button
                  v-for="sk in ks.filteredByScope[scope]"
                  :key="scope + '/' + (sk.id || sk.name)"
                  class="w-full min-w-0 text-left px-2.5 py-2 rounded-lg mb-1 transition-colors group"
                  :class="
                    ks.skillDetail &&
                    (ks.skillDetail.id || ks.skillDetail.name) === (sk.id || sk.name) &&
                    (ks.skillDetail.source || 'user') === scope
                      ? 'bg-blue-50 ring-1 ring-blue-200'
                      : 'hover:bg-slate-50'
                  "
                  @click="ks.viewSkill(sk)"
                >
                  <div class="flex items-center gap-2">
                    <span class="font-mono text-sm font-medium text-slate-800 truncate flex-1">
                      <span v-if="sk.parent_id" class="text-slate-400 font-normal">{{ sk.parent_id }}/</span
                      >{{ sk.name }}
                    </span>
                    <i
                      v-if="sk.is_folder && (sk.files || []).length"
                      title="Agent Skill : contient des fichiers/scripts"
                      class="ph ph-paperclip text-[11px] text-slate-400 shrink-0"
                    ></i>
                    <span
                      v-if="sk.domain && (sk.depth || 0) === 0"
                      class="text-[10px] text-slate-400 font-mono shrink-0"
                      >{{ sk.domain }}</span
                    >
                  </div>
                  <p class="text-[11px] text-slate-500 mt-0.5 truncate">
                    {{ sk.description || "(sans description)" }}
                  </p>
                </button>
              </div>
              <!-- Arbre : domaines → skills → sous-skills → fichiers/scripts -->
              <ul v-else role="tree" :aria-label="'Skills ' + scope" class="space-y-0.5">
                <NoeudSkill
                  v-for="n in ks.skillsTreeByScope[scope]"
                  :key="n.key"
                  :node="n"
                  :selected-key="ks.selectedNodeKey"
                  :active-file-key="ks.activeFileNodeKey"
                  :collapsed="ks.collapsedSkills"
                  @select-skill="ks.viewSkill"
                  @open-file="ks.onTreeOpenFile"
                  @toggle="ks.toggleCollapse"
                ></NoeudSkill>
              </ul>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- ======== VUE DÉTAIL / FORMULAIRE (drill-down niveau 2) == Plein cadre, v-if sec -->
    <div v-if="ks.skillEditMode" class="flex-1 min-h-0 flex flex-col">
      <!-- Barre retour (aligne px-5 sur le contenu détail) -->
      <div class="shrink-0 px-5 pt-4 pb-1">
        <button
          aria-label="Retour à la liste des skills"
          class="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 px-1.5 py-1 -ml-1.5 rounded-md hover:bg-slate-100 transition-colors"
          @click="ks.backToSkillsList"
        >
          <i class="ph ph-arrow-left text-base"></i> Skills
        </button>
      </div>

      <!-- VIEW detail -->
      <div v-if="ks.skillEditMode === 'view' && ks.skillDetail" class="flex-1 flex flex-col min-h-0">
        <div class="p-5 overflow-y-auto custom-scrollbar flex-1 max-w-3xl w-full mx-auto">
          <div class="flex items-start justify-between gap-2 mb-3">
            <div class="min-w-0">
              <!-- Breadcrumb du sous-skill : ancêtres cliquables (remonte au package) -->
              <div
                v-if="ks.skillBreadcrumb.length"
                class="flex items-center gap-1 text-[11px] font-mono text-slate-400 mb-0.5 flex-wrap"
              >
                <template v-for="p in ks.skillBreadcrumb" :key="p.id || p.name">
                  <button class="hover:text-blue-600 hover:underline" @click="ks.viewSkill(p)">
                    {{ p.name }}
                  </button>
                  <i class="ph ph-caret-right text-[9px]"></i>
                </template>
                <span class="text-slate-500">{{ ks.skillDetail.name }}</span>
              </div>
              <div class="flex items-center gap-2 flex-wrap">
                <h4 class="font-mono font-semibold text-slate-900 truncate">{{ ks.skillDetail.name }}</h4>
                <span class="skl-badge" :class="ks.skillDetail.source === 'learned' && 'skl-badge--learned'">
                  {{ ks.scopeLabel(ks.skillDetail.source || "user") }}
                </span>
              </div>
              <p class="text-xs text-slate-500 mt-1">
                {{ ks.skillDetail.description || "(sans description)" }}
              </p>
            </div>
          </div>

          <div class="flex flex-wrap gap-1.5 mb-3">
            <span
              v-if="ks.skillDetail.domain"
              class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-500"
              >domaine: {{ ks.skillDetail.domain }}</span
            >
            <span
              v-for="t in ks.skillDetail.tags || []"
              :key="t"
              class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-500"
              >#{{ t }}</span
            >
          </div>

          <!-- Sous-skills (enfants directs) → navigation -->
          <div v-if="ks.childSkills(ks.skillDetail).length" class="mb-3">
            <div class="text-[11px] font-semibold text-slate-500 mb-1 flex items-center gap-1">
              <i class="ph ph-tree-structure text-[11px]"></i> Sous-skills ({{
                ks.childSkills(ks.skillDetail).length
              }})
            </div>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="c in ks.childSkills(ks.skillDetail)"
                :key="c.id || c.name"
                class="text-[11px] font-mono px-2 py-1 rounded-md bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors flex items-center gap-1"
                @click="ks.viewSkill(c)"
              >
                <i class="ph ph-arrow-bend-down-right text-[10px]"></i> {{ c.name }}
              </button>
            </div>
          </div>

          <!-- Fichiers/scripts groupés → cliquables (lecture) -->
          <div v-if="ks.skillDetail.is_folder && (ks.skillDetail.files || []).length" class="mb-3">
            <div class="text-[11px] font-semibold text-slate-500 mb-1 flex items-center gap-1">
              <i class="ph ph-paperclip text-[11px]"></i> Fichiers ({{ ks.skillDetail.files.length }})
            </div>
            <div
              class="bg-slate-50 border border-slate-200 rounded-lg p-1.5 max-h-44 overflow-y-auto custom-scrollbar"
            >
              <button
                v-for="f in ks.skillDetail.files"
                :key="f"
                class="w-full text-left text-[11px] font-mono px-2 py-1 rounded hover:bg-white text-slate-600 truncate flex items-center gap-1.5"
                :class="
                  ks.skillFileView && ks.skillFileView.path === f
                    ? 'bg-white ring-1 ring-blue-200 text-blue-700'
                    : ''
                "
                @click="ks.openSkillFile(ks.skillDetail, f)"
              >
                <i class="ph ph-file-code text-[11px] shrink-0 text-slate-400"></i> {{ f }}
              </button>
            </div>
          </div>

          <!-- Lecteur de fichier (lecture seule) OU corps du SKILL.md -->
          <div v-if="ks.skillFileView" class="mb-2">
            <div class="flex items-center gap-2 mb-1">
              <button
                class="text-[11px] text-blue-600 hover:underline flex items-center gap-1"
                @click="ks.closeSkillFile"
              >
                <i class="ph ph-arrow-left text-[10px]"></i> Retour au skill
              </button>
              <span class="text-[11px] font-mono text-slate-500 truncate flex-1">{{
                ks.skillFileView.path
              }}</span>
              <div
                v-if="ks.skillFileIsMd"
                class="inline-flex rounded-md border border-slate-200 overflow-hidden shrink-0"
                role="group"
                aria-label="Affichage du fichier"
              >
                <button
                  class="text-[11px] px-2 py-0.5 transition-colors"
                  :class="
                    ks.skillBodyView === 'rendered'
                      ? 'bg-slate-100 text-slate-800 font-medium'
                      : 'bg-white text-slate-500 hover:bg-slate-50'
                  "
                  @click="ks.skillBodyView = 'rendered'"
                >
                  Rendu
                </button>
                <button
                  class="text-[11px] px-2 py-0.5 transition-colors border-l border-slate-200"
                  :class="
                    ks.skillBodyView === 'source'
                      ? 'bg-slate-100 text-slate-800 font-medium'
                      : 'bg-white text-slate-500 hover:bg-slate-50'
                  "
                  @click="ks.skillBodyView = 'source'"
                >
                  Source
                </button>
              </div>
            </div>
            <div
              v-if="ks.skillFileIsMd && ks.skillBodyView === 'rendered' && !ks.skillFileView.loading"
              class="markdown-body skl-md text-sm p-3 bg-slate-50 border border-slate-200 rounded-lg max-h-[60vh] overflow-y-auto custom-scrollbar"
              @click="ks.handleMarkdownClick"
              v-html="ks.renderMarkdown(ks.skillFileView.content)"
            ></div>
            <pre
              v-else
              class="p-3 bg-slate-900 text-slate-100 border border-slate-700 rounded-lg text-[11px] font-mono whitespace-pre-wrap break-words max-h-[60vh] overflow-y-auto custom-scrollbar"
              >{{ ks.skillFileView.loading ? "…" : ks.skillFileView.content }}</pre>
          </div>
          <div v-else>
            <div class="flex items-center justify-between mb-1">
              <span class="text-[11px] font-semibold text-slate-500 flex items-center gap-1"
                ><i class="ph ph-book-open-text text-[11px]"></i> Corps</span
              >
              <div
                class="inline-flex rounded-md border border-slate-200 overflow-hidden"
                role="group"
                aria-label="Affichage du corps"
              >
                <button
                  class="text-[11px] px-2 py-0.5 transition-colors"
                  :class="
                    ks.skillBodyView === 'rendered'
                      ? 'bg-slate-100 text-slate-800 font-medium'
                      : 'bg-white text-slate-500 hover:bg-slate-50'
                  "
                  @click="ks.skillBodyView = 'rendered'"
                >
                  Rendu
                </button>
                <button
                  class="text-[11px] px-2 py-0.5 transition-colors border-l border-slate-200"
                  :class="
                    ks.skillBodyView === 'source'
                      ? 'bg-slate-100 text-slate-800 font-medium'
                      : 'bg-white text-slate-500 hover:bg-slate-50'
                  "
                  @click="ks.skillBodyView = 'source'"
                >
                  Source
                </button>
              </div>
            </div>
            <div
              v-if="ks.skillBodyView === 'rendered' && (ks.skillDetail.body || '').trim()"
              class="markdown-body skl-md text-sm p-3 bg-slate-50 border border-slate-200 rounded-lg"
              @click="ks.handleMarkdownClick"
              v-html="ks.renderMarkdown(ks.skillDetail.body ?? '')"
            ></div>
            <pre
              v-else
              class="p-3 bg-slate-50 border border-slate-200 rounded-lg text-[11px] text-slate-700 font-mono whitespace-pre-wrap break-words"
              >{{ ks.skillDetail.body || "(corps vide)" }}</pre>
          </div>
        </div>

        <!-- action bar (hauteur de contrôle h-8, comme la toolbar) -->
        <div class="border-t border-slate-200 p-3 flex items-center gap-2 shrink-0">
          <button
            title="Télécharger ce skill en .zip"
            class="skl-btn skl-btn--secondary"
            @click="ks.exportSkillZip(ks.skillDetail)"
          >
            <i class="ph ph-download-simple"></i> Exporter .zip
          </button>
          <button
            v-if="ks.canEditScope(ks.skillDetail.source || 'user')"
            class="skl-btn skl-btn--secondary"
            @click="ks.startEdit(ks.skillDetail)"
          >
            <i class="ph ph-pencil-simple"></i> Éditer
          </button>
          <button
            v-if="ks.skillDetail.source === 'learned' && ks.isSkillAdmin"
            :disabled="ks.skillsBusy"
            class="skl-btn skl-btn--secondary"
            @click="ks.promoteSkill(ks.skillDetail)"
          >
            <i class="ph ph-arrow-up"></i> Promouvoir → global
          </button>
          <button
            v-if="ks.canEditScope(ks.skillDetail.source || 'user')"
            :disabled="ks.skillsBusy"
            class="skl-btn skl-btn--danger ml-auto"
            @click="ks.deleteSkill(ks.skillDetail)"
          >
            <i class="ph ph-trash"></i> Supprimer
          </button>
        </div>
      </div>

      <!-- CREATE / EDIT form (kit .set-* : neutres tokenisés, focus bleu) -->
      <div v-else class="flex-1 flex flex-col min-h-0">
        <div class="p-5 overflow-y-auto custom-scrollbar flex-1 space-y-2.5 max-w-3xl w-full mx-auto">
          <h4 class="font-semibold text-sm text-slate-800">
            {{ ks.skillEditMode === "edit" ? "Éditer le skill" : "Nouveau skill" }}
          </h4>

          <!-- scope selector (only meaningful when >1 scope editable) -->
          <div>
            <label class="text-[11px] font-medium text-slate-500 block mb-1">Portée</label>
            <select
              v-model="ks.skillForm.scope"
              :disabled="ks.skillEditMode === 'edit'"
              class="set-select w-full disabled:opacity-60"
            >
              <option v-for="sc in ks.editableScopes" :key="sc" :value="sc">{{ ks.scopeLabel(sc) }}</option>
            </select>
            <p v-if="!ks.isSkillAdmin" class="text-[10px] text-slate-500 mt-1">
              Les skills learned/global sont réservés aux administrateurs.
            </p>
          </div>

          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="text-[11px] font-medium text-slate-500 block mb-1">Nom</label>
              <input
                v-model="ks.skillForm.name"
                :disabled="ks.skillEditMode === 'edit'"
                placeholder="deploy-staging"
                class="set-input font-mono disabled:opacity-60"
              />
              <p v-if="ks.skillEditMode === 'create'" class="text-[10px] text-slate-500 mt-1">
                Enregistré au format dossier <span class="font-mono">&lt;slug&gt;/SKILL.md</span> (Agent
                Skill).
              </p>
            </div>
            <div>
              <label class="text-[11px] font-medium text-slate-500 block mb-1">Domaine (optionnel)</label>
              <input
                v-model="ks.skillForm.domain"
                placeholder="jenkins"
                :disabled="ks.skillForm._depth > 0"
                class="set-input disabled:opacity-60"
              />
              <p v-if="ks.skillForm._depth > 0" class="text-[10px] text-slate-500 mt-1">
                Sous-skill : hérité du package parent.
              </p>
            </div>
          </div>

          <div>
            <label class="text-[11px] font-medium text-slate-500 block mb-1"
              >Description
              <span class="text-slate-400">(sert au matching — soigne les mots-clés)</span></label
            >
            <input
              v-model="ks.skillForm.description"
              placeholder="Quand et comment déclencher ce skill…"
              class="set-input"
            />
          </div>

          <div>
            <label class="text-[11px] font-medium text-slate-500 block mb-1"
              >Tags <span class="text-slate-400">(séparés par des virgules)</span></label
            >
            <input v-model="ks.skillForm.tags" placeholder="ci, deploy" class="set-input" />
          </div>

          <div>
            <label class="text-[11px] font-medium text-slate-500 block mb-1">Corps (markdown)</label>
            <textarea
              v-model="ks.skillForm.body"
              rows="14"
              placeholder="# Procédure&#10;## Étapes&#10;1. …"
              class="set-textarea font-mono"
            ></textarea>
          </div>
        </div>

        <!-- action bar (hauteur de contrôle h-8, comme la toolbar) -->
        <div class="border-t border-slate-200 p-3 flex items-center justify-end gap-2 shrink-0">
          <button class="skl-btn skl-btn--secondary" @click="ks.cancelEdit">Annuler</button>
          <button
            :disabled="ks.skillsBusy"
            class="skl-btn bg-blue-600 text-white hover:bg-blue-700"
            @click="ks.saveSkill"
          >
            <i class="ph" :class="ks.skillsBusy ? 'ph-spinner animate-spin' : 'ph-floppy-disk'"></i>
            {{ ks.skillEditMode === "edit" ? "Enregistrer" : "Créer" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
