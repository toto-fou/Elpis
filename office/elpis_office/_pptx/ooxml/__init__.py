# SPDX-License-Identifier: MIT
"""Raw OOXML helpers for the parts python-pptx does not model.

python-pptx covers shapes, text, tables, pictures and charts well. It has no API
for bullet glyphs, autofit, slide-number fields, slide deletion or reordering,
table cell borders, theme colours or transitions — all of which a corporate deck
needs. Those live here, written as schema-order-aware XML.
"""

from __future__ import annotations
