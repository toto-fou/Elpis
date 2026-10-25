# Complete valid examples

Light and dark, warm paper style:

```elpis-skin
{"id":"papier-chaud","label":"Papier chaud","desc":"Fond crème, accent terre cuite","darkBase":false,"tokens":{"light":{"--app-bg":"#f3ede2","--surface":"#fffdf8","--text-900":"#2b2118","--text-600":"#5c4b3b","--border":"#d9cdb8","--accent":"#b4532a","--rail-bg":"#3a2b20","--rail-text":"#f1e6d3","--radius":"10px"},"dark":{"--app-bg":"#1b1511","--surface":"#241c16","--text-900":"#f4eadb","--text-600":"#c9b9a2","--border":"#4a3b2e","--accent":"#e0875a","--rail-bg":"#120e0b","--rail-text":"#e8dcc8"}}}
```

Dark-only theme (`darkBase`, only `light` is given and serves both modes):

```elpis-skin
{"id":"nuit-bleue","label":"Nuit bleue","desc":"Sombre bleu nuit, accent cyan","darkBase":true,"tokens":{"light":{"--app-bg":"#0b1220","--surface":"#111a2e","--text-900":"#eaf1ff","--text-600":"#a7b6d6","--border":"#25324f","--accent":"#4cc3e8","--rail-bg":"#070c17","--rail-text":"#cfdcf5","--radius":"6px"}}}
```
