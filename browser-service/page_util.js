// SPDX-License-Identifier: MIT
/** browser-service/page_util.js — fonctions exécutées DANS la page (sérialisées par `sourceDe`) : sélecteur qui désigne un seul élément (shadow DOM compris), point de clic vérifié, zones modifiées d'un diff visuel. */

/** Source d'une fonction autonome, à reconstruire dans la page par `new Function('return (' + src + ')')()`. */
export function sourceDe(fn) {
    return fn.toString();
}

// Unique pour Playwright, qui perce les racines shadow ouvertes : candidat gardé s'il désigne `el` seul, sinon chemin `nth-of-type` depuis l'ancêtre à id unique ; en racine shadow, `<hôte unique> >> <intérieur>` (`candidatDe` propose le candidat de l'hôte).
export function selecteurUnique(el, candidat, candidatDe = null) {
    const racine = el.getRootNode ? el.getRootNode() : document;
    const hote = racine && racine.host ? racine.host : null;
    const portee = hote || document;
    const cache = selecteurUnique.racines || (selecteurUnique.racines = new WeakMap());
    if (!cache.has(portee)) {
        const liste = portee.shadowRoot ? [portee, portee.shadowRoot] : [portee];
        for (let i = 0; i < liste.length; i++)
            for (const e of liste[i].querySelectorAll('*')) if (e.shadowRoot) liste.push(e.shadowRoot);
        cache.set(portee, liste);
    }
    const tous = (sel) => {
        const vus = new Set();
        for (const r of cache.get(portee)) for (const e of r.querySelectorAll(sel)) vus.add(e);
        return [...vus];
    };
    const seul = (sel, cible) => {
        try { const m = tous(sel); return m.length === 1 && m[0] === cible; } catch (_) { return false; }
    };
    const prefixe = hote ? `${selecteurUnique(hote, candidatDe ? candidatDe(hote) : null, candidatDe)} >> ` : '';
    const texte = /^([a-z][a-z0-9-]*):(has-text|text-is)\("((?:[^"\\]|\\.)*)"\)$/i.exec(candidat || '');
    if (texte) {
        const exact = texte[2].toLowerCase() === 'text-is';
        const voulu = texte[3].replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim();
        const norme = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim();
        const memes = tous(texte[1]).filter((e) => (exact ? norme(e) === voulu : norme(e).toLowerCase().includes(voulu.toLowerCase())));
        if (memes.length === 1 && memes[0] === el) return prefixe + candidat;
    } else if (candidat && seul(candidat, el)) return prefixe + candidat;
    const parties = [];
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
        if (cur.id && seul('#' + CSS.escape(cur.id), cur)) { parties.unshift('#' + CSS.escape(cur.id)); break; }
        const tag = cur.tagName.toLowerCase();
        if (cur === document.body || !cur.parentElement) { parties.unshift(tag); break; }
        const freres = Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName);
        parties.unshift(freres.length > 1 ? `${tag}:nth-of-type(${freres.indexOf(cur) + 1})` : tag);
    }
    return prefixe + parties.join(' > ');
}

// Point de clic d'un élément visible (amené à l'écran ; `pos` depuis son coin, sinon le centre) : touché si l'élément au point est lui, un descendant (shadow compris) ou son <label> ; sinon ce qui le couvre. null s'il n'est pas visible.
export function pointDeClic(el, pos = null) {
    const decrire = (e) => {
        const tag = e.tagName.toLowerCase();
        const classes = typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
        const texte = String(e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const role = e.getAttribute('role');
        return { css: tag + (e.id ? `#${e.id}` : '') + classes.map((c) => `.${c}`).join(''),
                 ...(role ? { role } : {}), ...(texte ? { text: texte } : {}) };
    };
    const cs = getComputedStyle(el);
    let r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width <= 0 || r.height <= 0) return null;
    const dx = pos && Number.isFinite(pos.x) ? pos.x : r.width / 2;
    const dy = pos && Number.isFinite(pos.y) ? pos.y : r.height / 2;
    const dehors = () => r.left + dx < 0 || r.top + dy < 0 || r.left + dx >= innerWidth || r.top + dy >= innerHeight;
    if (dehors()) { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); r = el.getBoundingClientRect(); }
    const x = r.left + dx, y = r.top + dy, element = decrire(el);
    const inactif = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || Boolean(el.closest && el.closest('fieldset:disabled'));
    if (inactif) element.disabled = true;
    if (dehors()) return { x, y, hit: false, offscreen: true, element };
    let touche = document.elementFromPoint(x, y);
    while (touche && touche.shadowRoot) {
        const d = touche.shadowRoot.elementFromPoint(x, y);
        if (!d || d === touche) break;
        touche = d;
    }
    for (let n = touche; n; n = n.parentNode || n.host) if (n === el) return { x, y, hit: true, element, disabled: inactif };
    if (touche && touche.tagName === 'LABEL' && touche.control === el) return { x, y, hit: true, element, disabled: inactif };
    return { x, y, hit: false, cover: touche ? decrire(touche) : null, element };
}

// Cellules marquées regroupées par 8-voisinage : boîtes au pixel près, les plus fournies d'abord (`max` au plus), plus la boîte de l'ensemble.
export function regionsModifiees(cols, rows, compte, x0, y0, x1, y1, max) {
    const vu = new Uint8Array(cols * rows);
    const zones = [];
    for (let c = 0; c < cols * rows; c++) {
        if (!compte[c] || vu[c]) continue;
        let gx = Infinity, gy = Infinity, dx = -1, dy = -1, pixels = 0;
        const pile = [c];
        vu[c] = 1;
        while (pile.length) {
            const k = pile.pop();
            pixels += compte[k];
            gx = Math.min(gx, x0[k]); gy = Math.min(gy, y0[k]);
            dx = Math.max(dx, x1[k]); dy = Math.max(dy, y1[k]);
            const cx = k % cols, cy = (k - cx) / cols;
            for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
                const nx = cx + ox, ny = cy + oy;
                if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
                const v = ny * cols + nx;
                if (compte[v] && !vu[v]) { vu[v] = 1; pile.push(v); }
            }
        }
        zones.push({ x: gx, y: gy, w: dx - gx + 1, h: dy - gy + 1, pixels });
    }
    if (!zones.length) return { regions: [], total: 0, bbox: null };
    let bx = Infinity, by = Infinity, bx2 = -1, by2 = -1;
    for (const z of zones) {
        bx = Math.min(bx, z.x); by = Math.min(by, z.y);
        bx2 = Math.max(bx2, z.x + z.w); by2 = Math.max(by2, z.y + z.h);
    }
    zones.sort((a, b) => b.pixels - a.pixels || a.y - b.y || a.x - b.x);
    return { regions: zones.slice(0, max), total: zones.length, bbox: { x: bx, y: by, w: bx2 - bx, h: by2 - by } };
}
