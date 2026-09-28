// SPDX-License-Identifier: MIT
/* ============================================================================
 * js/editor/_office_grid.js — composant ``office-grid`` : grille xlsx en
 * lecture seule de l'éditeur (valeurs « telles qu'affichées » converties par
 * LibreOffice côté serveur, servies par morceaux de ``chunkSize`` lignes).
 *
 * Tenue en mémoire et en DOM BORNÉES quelle que soit la taille du classeur :
 *   • virtualisation lignes ET colonnes (seules les cellules visibles + marge
 *     existent dans le DOM) ;
 *   • morceaux gardés dans un LRU de 30 ; requêtes annulées (AbortController)
 *     au changement de feuille, de clé et au démontage ;
 *   • un seul ``requestAnimationFrame`` par salve de défilement ;
 *   • ResizeObserver déconnecté au démontage.
 * Le texte des cellules passe par l'interpolation Vue (jamais ``v-html``).
 * Modèle de template : #office-grid-template (index.html).
 * Cf. docs/editor-office-preview-design-2026-09-15.md
 * ==========================================================================*/
const OfficeGrid = {
    template: '#office-grid-template',
    props: {
        docKey:     { type: String, required: true },
        sheets:     { type: Array, required: true },
        chunkSize:  { type: Number, default: 200 },
        fetchChunk: { type: Function, required: true },
    },
    setup(props) {
        const { ref, computed, watch, onMounted, onBeforeUnmount } = Vue;
        const O = window.elpisOffice;
        const ROW_H = 22;
        const HEAD_H = 22;
        const CHAR_PX = 7;
        const CELL_PAD = 14;
        const LRU_MAX = 30;

        const scroller = ref(null);
        const scrollTop = ref(0);
        const scrollLeft = ref(0);
        const viewW = ref(800);
        const viewH = ref(400);
        const version = ref(0);          // bumpé à l'arrivée d'un morceau
        const failed = ref(0);           // morceaux en échec (affichage discret)

        const firstVisible = () => {
            const i = (props.sheets || []).findIndex(s => !s.hidden);
            return i >= 0 ? i : 0;
        };
        const sheetIdx = ref(firstVisible());

        let cache = O.createLru(LRU_MAX);
        const inflight = new Map();      // clé de morceau → AbortController
        let rafId = null;
        let ro = null;
        let alive = true;

        const sheet = computed(() => (props.sheets || [])[sheetIdx.value] || null);
        const widths = computed(() => {
            const s = sheet.value;
            if (!s) return [];
            const w = s.widths || [];
            const out = [];
            for (let i = 0; i < s.cols; i++) out.push((w[i] || 6) * CHAR_PX + CELL_PAD);
            return out;
        });
        const prefix = computed(() => O.prefixSums(widths.value));
        const rownumW = computed(() => {
            const rows = sheet.value ? sheet.value.rows : 0;
            return Math.max(40, String(rows).length * 8 + 18);
        });
        const totalW = computed(() => rownumW.value + prefix.value[prefix.value.length - 1]);
        const totalH = computed(() => HEAD_H + (sheet.value ? sheet.value.rows : 0) * ROW_H);

        const rowWin = computed(() => O.rowWindow(
            scrollTop.value, viewH.value - HEAD_H, ROW_H, sheet.value ? sheet.value.rows : 0, 6));
        const colWin = computed(() => O.colWindow(
            scrollLeft.value, Math.max(0, viewW.value - rownumW.value), prefix.value, 2));

        const cols = computed(() => {
            const out = [];
            for (let c = colWin.value.start; c < colWin.value.end; c++) {
                out.push({ c, name: O.colName(c), left: rownumW.value + prefix.value[c], width: widths.value[c] });
            }
            return out;
        });

        const NUMERIC = /^[-+]?[\d\s .,]+(%|\s?[€$£])?$/;
        const visibleRows = computed(() => {
            version.value;                          // dépendance : morceaux arrivés
            const s = sheet.value;
            const out = [];
            if (!s) return out;
            for (let r = rowWin.value.start; r < rowWin.value.end; r++) {
                const chunk = cache.get(chunkKey(sheetIdx.value, Math.floor(r / props.chunkSize)));
                const row = chunk ? (chunk[r % props.chunkSize] || []) : null;
                const cells = [];
                for (const col of cols.value) {
                    const text = row ? (row[col.c] == null ? '' : String(row[col.c])) : '';
                    cells.push({
                        c: col.c, left: col.left, width: col.width, text,
                        num: text !== '' && NUMERIC.test(text),
                        long: text.length * CHAR_PX > col.width - CELL_PAD || text.indexOf('\n') >= 0,
                    });
                }
                out.push({ r, top: HEAD_H + r * ROW_H, loaded: !!row, cells });
            }
            return out;
        });

        function chunkKey(s, c) { return props.docKey + ':' + s + ':' + c; }

        function abortAll() {
            inflight.forEach(ac => { try { ac.abort(); } catch (_) {} });
            inflight.clear();
        }

        async function ensureChunks() {
            const s = sheet.value;
            if (!s || !s.rows || !alive) return;
            const idx = sheetIdx.value;
            const key = props.docKey;
            const wanted = O.chunksFor(rowWin.value.start, rowWin.value.end, props.chunkSize);
            for (const c of wanted) {
                const k = chunkKey(idx, c);
                if (cache.has(k) || inflight.has(k) || c >= s.chunks) continue;
                const ac = new AbortController();
                inflight.set(k, ac);
                props.fetchChunk(key, idx, c, ac.signal).then(rows => {
                    if (!alive || ac.signal.aborted || key !== props.docKey) return;
                    cache.set(k, Array.isArray(rows) ? rows : []);
                    version.value++;
                }).catch(() => {
                    if (!alive || ac.signal.aborted) return;
                    failed.value++;
                }).finally(() => {
                    if (inflight.get(k) === ac) inflight.delete(k);
                });
            }
        }

        function onScroll() {
            if (rafId != null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                const el = scroller.value;
                if (!el) return;
                scrollTop.value = el.scrollTop;
                scrollLeft.value = el.scrollLeft;
            });
        }

        function measure() {
            const el = scroller.value;
            if (!el) return;
            viewW.value = el.clientWidth;
            viewH.value = el.clientHeight;
        }

        function selectSheet(i) {
            if (i === sheetIdx.value) return;
            abortAll();
            sheetIdx.value = i;
            failed.value = 0;
            const el = scroller.value;
            if (el) { el.scrollTop = 0; el.scrollLeft = 0; }
            scrollTop.value = 0;
            scrollLeft.value = 0;
        }

        watch(() => [rowWin.value.start, rowWin.value.end, sheetIdx.value, props.docKey], ensureChunks);
        watch(() => props.docKey, () => {
            abortAll();
            cache.clear();
            cache = O.createLru(LRU_MAX);
            sheetIdx.value = firstVisible();
            version.value++;
        });

        onMounted(() => {
            measure();
            if (typeof ResizeObserver !== 'undefined' && scroller.value) {
                ro = new ResizeObserver(() => measure());
                ro.observe(scroller.value);
            }
            ensureChunks();
        });
        onBeforeUnmount(() => {
            alive = false;
            abortAll();
            cache.clear();
            if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
            if (ro) { ro.disconnect(); ro = null; }
        });

        return {
            scroller, sheetIdx, sheet, cols, visibleRows, rownumW, totalW, totalH,
            HEAD_H, ROW_H, failed, onScroll, selectSheet,
        };
    },
};

if (typeof module !== 'undefined' && module.exports) module.exports = { OfficeGrid };
