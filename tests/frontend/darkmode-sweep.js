// SPDX-License-Identifier: MIT
// Sonde DOM partagée du mode sombre — expression évaluée telle quelle par
// Playwright (`page.evaluate(fs.readFileSync(...))`).
//
// Rend, pour la page telle qu'elle est rendue à cet instant :
//   • light    : îlots CLAIRS (fond opaque de luminance haute) sur une page
//                sombre — « l'élément est resté en clair » ;
//   • contrast : textes sous le seuil WCAG AA de leur taille ;
//   • seams    : coutures de surface — fonds voisins censés être continus qui
//                ne coïncident pas (cadre d'un bloc de code ≠ fond du code).
//
// Couleurs normalisées via canvas 2D : `fillStyle` accepte oklch/color-mix et
// rend des pixels sRGB — indispensable, les skins en utilisent. Le fond
// EFFECTIF est composé en alpha en remontant jusqu'au premier ancêtre opaque.
(() => {
    const cx = document.createElement('canvas').getContext('2d');
    const toRGBA = (c) => {
        if (!c || c === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
        const m = String(c).match(/^rgba?\(([^)]+)\)$/);
        if (m) {
            const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
            return { r: p[0], g: p[1], b: p[2], a: (p.length > 3 ? p[3] : 1) };
        }
        try {
            cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c;
            cx.fillRect(0, 0, 1, 1);
            const d = cx.getImageData(0, 0, 1, 1).data;
            return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
        } catch (_) { return { r: 0, g: 0, b: 0, a: 0 }; }
    };
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a),
                                g: fg.g * fg.a + bg.g * (1 - fg.a),
                                b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
    const ratio = (a, b) => { const L1 = lum(a), L2 = lum(b);
                              return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); };
    const effBg = (el) => {
        let acc = null, n = el;
        while (n && n.nodeType === 1) {
            const c = toRGBA(getComputedStyle(n).backgroundColor);
            if (c.a > 0) acc = acc ? over(acc, c) : c;
            if (acc && acc.a >= 0.99) return acc;
            n = n.parentElement;
        }
        const base = toRGBA(getComputedStyle(document.body).backgroundColor);
        const fond = base.a ? base : { r: 255, g: 255, b: 255, a: 1 };
        return acc ? over(acc, fond) : fond;
    };
    const sig = (el) => {
        const cls = (el.className && typeof el.className === 'string')
            ? el.className.trim().split(/\s+/).slice(0, 6).join('.') : '';
        return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
    };
    const hex = (c) => '#' + [c.r, c.g, c.b]
        .map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

    const pageBg = effBg(document.body);
    const pageL = lum(pageBg);
    const light = {}, contrast = {}, seams = [];

    // Couleurs d'ACCENT du skin actif. Un skin a le droit d'avoir un accent
    // CLAIR — llamacpp inverse son primary en mode sombre — et l'encre posée
    // dessus suit --accent-fg. Un îlot clair n'est donc un défaut que si sa
    // couleur n'est PAS celle de l'accent. On compare les couleurs résolues,
    // pas les noms de classes : la signature d'un élément est tronquée et
    // `bg-blue-600` peut s'y trouver au-delà de la troncature.
    const bodyCS = getComputedStyle(document.body);
    const accents = ['--accent', '--accent-strong', '--accent-500', '--accent-400', '--accent-300']
        .map((t) => toRGBA(bodyCS.getPropertyValue(t).trim()))
        .filter((c) => c.a > 0)
        .map((c) => [Math.round(c.r), Math.round(c.g), Math.round(c.b)]);
    const estAccent = (c) => accents.some(([r, g, b]) =>
        Math.abs(r - c.r) <= 2 && Math.abs(g - c.g) <= 2 && Math.abs(b - c.b) <= 2);

    for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.15) continue;

        const own = toRGBA(cs.backgroundColor);
        if (own.a > 0.55 && pageL < 0.30) {
            const L = lum(over(own, effBg(el.parentElement || document.body)));
            if (L > 0.55) {
                const k = sig(el);
                light[k] = light[k] || { n: 0, L: +L.toFixed(3), bg: cs.backgroundColor,
                                         accent: estAccent(own) };
                light[k].n++;
            }
        }

        const txt = Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3 && n.textContent.trim())
            .map((n) => n.textContent.trim()).join(' ');
        if (txt) {
            const fg = toRGBA(cs.color), bg = effBg(el);
            const cr = ratio(over(fg, bg), bg);
            const size = parseFloat(cs.fontSize) || 16;
            const bold = (parseInt(cs.fontWeight) || 400) >= 700;
            const need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
            if (cr < need) {
                const k = sig(el);
                contrast[k] = contrast[k] || { n: 0, ratio: +cr.toFixed(2), need,
                                               fg: hex(fg), bg: hex(bg), ex: txt.slice(0, 40) };
                contrast[k].n++;
            }
        }
    }

    // ── Coutures : surfaces voisines censées être continues ─────────────────
    // Un bloc de code est UNE surface : cadre, en-tête et zone de code doivent
    // partager le même fond (à l'appui près de l'en-tête). Trois gris
    // différents empilés dessinent des bordures parasites entre le texte et
    // le bloc — c'est le défaut signalé en 2026-09-07.
    const ecart = (a, b) => +Math.abs(lum(a) - lum(b)).toFixed(4);
    for (const w of document.querySelectorAll('.code-wrapper')) {
        const code = w.querySelector('pre code');
        const hd = w.querySelector('.code-header');
        const cw = over(toRGBA(getComputedStyle(w).backgroundColor), effBg(w.parentElement));
        const cc = code ? over(toRGBA(getComputedStyle(code).backgroundColor), cw) : null;
        const ch = hd ? over(toRGBA(getComputedStyle(hd).backgroundColor), cw) : null;
        seams.push({
            zone: 'code-wrapper',
            wrapper: hex(cw), code: cc ? hex(cc) : null, header: ch ? hex(ch) : null,
            ecart_code: cc ? ecart(cw, cc) : null,
            ecart_header: ch ? ecart(cw, ch) : null,
        });
    }
    for (const p of document.querySelectorAll('.markdown-body pre')) {
        if (p.closest('.code-wrapper')) continue;   // déjà couvert ci-dessus
        const code = p.querySelector('code');
        const cp = over(toRGBA(getComputedStyle(p).backgroundColor), effBg(p.parentElement));
        const cc = code ? over(toRGBA(getComputedStyle(code).backgroundColor), cp) : null;
        seams.push({ zone: 'pre-nu', wrapper: hex(cp), code: cc ? hex(cc) : null,
                     ecart_code: cc ? ecart(cp, cc) : null, ecart_header: null });
    }

    return { pageL: +pageL.toFixed(3), pageBg: hex(pageBg), light, contrast, seams };
})()
