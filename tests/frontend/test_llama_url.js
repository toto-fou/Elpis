// SPDX-License-Identifier: MIT
// tests/frontend/test_llama_url.js — l'URL complète du moteur local suit
// l'hôte et le port quand elle visait l'ancien hôte:port (admin/llama_url.js).
'use strict';
const { t, fin, assert } = require('./lib/harnais.js');
const { suivreHotePort } = require('../../frontend/js/admin/llama_url.js');

t('URL qui visait l\'ancien hôte:port : recalée, chemin gardé', () => {
    assert.equal(suivreHotePort('http://192.0.2.53:8080/v1/chat/completions', '192.0.2.53', 8080, '192.0.2.60', 8080),
                 'http://192.0.2.60:8080/v1/chat/completions');
    assert.equal(suivreHotePort('http://10.0.0.5:8080/v1/chat/completions', '10.0.0.5', '8080', '10.0.0.5', 9000),
                 'http://10.0.0.5:9000/v1/chat/completions');
});

t('URL propre (autre hôte, proxy https) : jamais réécrite', () => {
    const u = 'https://llm.lan/api/v1/chat/completions';
    assert.equal(suivreHotePort(u, '192.0.2.53', 8080, '192.0.2.60', 8080), u);
});

t('URL vide ou hôte inchangé : rien', () => {
    assert.equal(suivreHotePort('', 'a', 1, 'b', 1), '');
    const u = 'http://a:1/x';
    assert.equal(suivreHotePort(u, 'a', 1, 'a', 1), u);
});

fin('test_llama_url.js');
