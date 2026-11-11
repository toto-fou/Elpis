// SPDX-License-Identifier: MIT
// tests/frontend/lib/acces-racine.js — script d'initialisation des tests navigateur : `window.__racine()` rend l'objet racine de l'application (celui que reçoivent les domaines injectés), lu et écrit comme l'ancien proxy du composant racine.
(function () {
    window.__racine = function () {
        const app = document.getElementById('app');
        const instance = app && app.__vue_app__ && app.__vue_app__._container._vnode && app.__vue_app__._container._vnode.component;
        if (!instance) return null;
        const provides = instance.provides;
        const cle = Object.getOwnPropertySymbols(provides).find((s) => String(s.description).startsWith('elpis:racine:'));
        return cle ? provides[cle] : null;
    };
})();
