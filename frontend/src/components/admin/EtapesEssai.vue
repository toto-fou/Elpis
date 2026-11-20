<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/EtapesEssai.vue — liste des étapes d'un test (niveau, libellé, cible, phrase), regroupées par cible quand il y en a plusieurs. -->
<script setup lang="ts">
import type { ReponseEssaiFournisseur } from "@elpis/contracts";
import { computed } from "vue";

type Etape = ReponseEssaiFournisseur["steps"][number];
interface Groupe {
  cible: string | null;
  etapes: Etape[];
}

const props = defineProps<{ steps: readonly Etape[] }>();

const GLYPHES = { ok: "✓", warn: "⚠", fail: "✗" } as const;
const ICONES = { ok: "ph-check-circle", warn: "ph-warning", fail: "ph-x-circle" } as const;
const MOTS = { ok: "Réussi", warn: "Avertissement", fail: "Échec" } as const;

const groupes = computed<Groupe[]>(() => {
  const cibles = new Set(props.steps.map((s) => s.target).filter((t) => t !== null));
  if (cibles.size < 2) return [{ cible: null, etapes: [...props.steps] }];
  const sortie: Groupe[] = [];
  for (const s of props.steps) {
    const dernier = sortie[sortie.length - 1];
    const g =
      s.target === null
        ? dernier?.cible === null
          ? dernier
          : undefined
        : sortie.find((x) => x.cible === s.target);
    if (g) g.etapes.push(s);
    else sortie.push({ cible: s.target, etapes: [s] });
  }
  return sortie;
});
const regroupe = computed(() => groupes.value.some((g) => g.cible !== null));
</script>

<template>
  <div class="min-w-0" data-etapes-essai>
    <p v-if="steps.length === 0" class="text-xs text-slate-500" data-etapes-vide>Aucune étape à afficher.</p>
    <div v-for="(g, i) in groupes" :key="(g.cible ?? '') + i" class="space-y-0.5" data-groupe-essai>
      <p v-if="g.cible !== null" class="mt-2 text-[11px] font-mono text-slate-500" data-cible-groupe>
        {{ g.cible }}
      </p>
      <ul class="space-y-1">
        <li
          v-for="s in g.etapes"
          :key="s.id"
          class="flex items-start gap-1.5 text-xs"
          :class="
            s.level === 'fail' ? 'text-red-600' : s.level === 'warn' ? 'text-amber-700' : 'text-slate-700'
          "
          :data-etape="s.id"
          :data-niveau="s.level"
        >
          <i class="ph mt-0.5 shrink-0" :class="ICONES[s.level]" aria-hidden="true"></i>
          <span class="shrink-0 font-mono" aria-hidden="true">{{ GLYPHES[s.level] }}</span>
          <span class="sr-only">{{ MOTS[s.level] }} :</span>
          <span class="min-w-0 break-words">
            <span class="font-medium">{{ s.label }}</span>
            <span v-if="!regroupe && s.target !== null" class="ml-1 text-[11px] font-mono text-slate-500">{{
              s.target
            }}</span>
            <span class="block text-slate-600">{{ s.detail }}</span>
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>
