# Charts in Word & PowerPoint files

- **Charts come from the chart tools.** Call `chart_<type>` first, then write the `ref` it returns
  (`!a1b2c3d4e5f6`) alone on its own line in the Markdown, or in a slide's `chart` field. The file
  gets an editable chart when possible. Never make up a ref.

<example>
"Make a two-page report on Q3 sales with a chart" →
chart_bar(title="Ventes T3", unit="k€", data=[{"mois":"juillet","ventes":182}, …]) → ref !5e44b60f973d
docx_create(path="rapports/ventes-T3.docx", title="Ventes du T3",
            content="# Synthèse\n\nLes ventes progressent de **8 %**…\n\n!5e44b60f973d\n\n## Détail\n…")
</example>
