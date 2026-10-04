# SPDX-License-Identifier: MIT
"""The design tokens a deck is built from: colours, typefaces, a type scale.

A caller supplies at most an accent colour and a preset name. Everything else —
the muted grey that is still legible on the chosen background, the tint used for
KPI tiles, the size of a slide title relative to body text — is derived here, so
every slide in a deck resolves the same decisions the same way.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

from ..ooxml.charts import DEFAULT_PALETTE
from ..ooxml.util import mix, parse_color, readable_text_color, relative_luminance, shade, tint


@dataclass(frozen=True)
class Preset:
    background: str
    surface: str
    accent: str
    accent2: str
    text: str
    muted: str
    border: str
    heading_font: str = "Calibri Light"
    body_font: str = "Calibri"


#: Named starting points. A caller overriding ``accent`` keeps everything else.
PRESETS: dict[str, Preset] = {
    "corporate": Preset(
        background="FFFFFF", surface="F4F7FB", accent="1F4E79", accent2="2A78D6",
        text="1A1F26", muted="5B6570", border="DCE3EC",
    ),
    "slate": Preset(
        background="FFFFFF", surface="F5F6F8", accent="334155", accent2="64748B",
        text="16202B", muted="5D6B7A", border="E1E5EA",
    ),
    "emerald": Preset(
        background="FFFFFF", surface="F1F8F4", accent="0F6B4B", accent2="1BAF7A",
        text="14201A", muted="55655D", border="D8E8DF",
    ),
    "plum": Preset(
        background="FFFFFF", surface="F7F4FA", accent="4A3AA7", accent2="7C6BD6",
        text="1E1A2B", muted="5F5A72", border="E3DEEE",
    ),
    "sand": Preset(
        background="FDFBF7", surface="F6F0E6", accent="8A5A16", accent2="EDA100",
        text="241D12", muted="6B6053", border="E8DECB",
    ),
    "midnight": Preset(
        background="0E1726", surface="18243A", accent="4EA1FF", accent2="7CC4FF",
        text="F1F5FA", muted="9FB0C4", border="27364F",
    ),
    "carbon": Preset(
        background="15171C", surface="1F232B", accent="EB6834", accent2="F2A07B",
        text="F4F5F7", muted="A2A9B5", border="2C313B",
    ),
}

DEFAULT_PRESET = "corporate"

#: Type scale in points, at the reference slide height of 19.05 cm (16:9).
BASE_SCALE = {
    "deck_title": 40.0,
    "deck_subtitle": 18.0,
    "section_title": 32.0,
    "slide_title": 28.0,
    "kicker": 11.0,
    "body": 16.0,
    "small": 12.0,
    "caption": 10.5,
    "footer": 9.0,
    "kpi_value": 40.0,
    "kpi_label": 11.5,
    "quote": 24.0,
}

REFERENCE_HEIGHT_CM = 19.05


@dataclass
class Theme:
    """Resolved design tokens. Everything the builders read comes from here."""

    preset: str = DEFAULT_PRESET
    background: str = "FFFFFF"
    surface: str = "F4F7FB"
    accent: str = "1F4E79"
    accent2: str = "2A78D6"
    text: str = "1A1F26"
    muted: str = "5B6570"
    border: str = "DCE3EC"
    heading_font: str = "Calibri Light"
    body_font: str = "Calibri"
    mono_font: str = "Consolas"
    chart_palette: tuple[str, ...] = DEFAULT_PALETTE
    scale: dict[str, float] = field(default_factory=lambda: dict(BASE_SCALE))
    #: Multiplier applied to the whole type scale, derived from the slide height.
    size_factor: float = 1.0

    # -- derived -----------------------------------------------------------------

    @property
    def is_dark(self) -> bool:
        return relative_luminance(self.background) < 0.4

    def pt(self, role: str) -> float:
        """A size from the type scale, scaled to this deck's slide height."""
        return round(self.scale.get(role, BASE_SCALE["body"]) * self.size_factor, 1)

    def on(self, background: str) -> str:
        """A text colour that is legible on the given fill."""
        return readable_text_color(background, dark=self.text, light="FFFFFF")

    @property
    def on_accent(self) -> str:
        return self.on(self.accent)

    def tinted(self, color: str | None = None, amount: float = 0.88) -> str:
        """A pale wash of a colour, for tiles and table headers.

        On a dark deck "pale" means *towards the background*, not towards white —
        otherwise every tile would glare.
        """
        base = color or self.accent
        return mix(base, self.background, amount)

    def hairline(self) -> str:
        return self.border

    def palette(self) -> Sequence[str]:
        return self.chart_palette or DEFAULT_PALETTE


def _clean(value: str | None) -> str | None:
    return parse_color(value) if value else None


def resolve_theme(
    spec,
    *,
    slide_height_cm: float = REFERENCE_HEIGHT_CM,
) -> Theme:
    """Build a :class:`Theme` from a ``ThemeSpec`` (or None)."""
    name = str(getattr(spec, "preset", None) or DEFAULT_PRESET).strip().lower()
    preset = PRESETS.get(name)
    if preset is None:
        raise ValueError(
            f"Unknown theme preset {name!r}. Available: {', '.join(sorted(PRESETS))}."
        )

    accent = _clean(getattr(spec, "accent", None)) or preset.accent
    background = _clean(getattr(spec, "background", None)) or preset.background
    dark_deck = relative_luminance(background) < 0.4

    accent2 = _clean(getattr(spec, "accent2", None)) or preset.accent2
    text = _clean(getattr(spec, "text_color", None)) or preset.text
    # A caller who overrides only the background still needs readable text on it.
    if _clean(getattr(spec, "text_color", None)) is None and background != preset.background:
        text = readable_text_color(background, dark="1A1F26", light="F1F5FA")

    muted = _clean(getattr(spec, "muted_color", None)) or (
        preset.muted if background == preset.background else mix(text, background, 0.42)
    )
    surface = _clean(getattr(spec, "surface", None)) or (
        preset.surface if background == preset.background
        else (tint(background, 0.06) if dark_deck else shade(background, 0.035))
    )
    border = _clean(getattr(spec, "border", None)) or (
        preset.border if background == preset.background else mix(text, background, 0.82)
    )

    palette = getattr(spec, "chart_palette", None)
    if palette:
        resolved_palette = tuple(parse_color(c) for c in palette)
    else:
        # Lead the palette with the brand accent so the first series is on-brand,
        # then continue with the validated set, dropping anything too close to it.
        rest = tuple(c for c in DEFAULT_PALETTE if c.upper() != accent.upper())
        resolved_palette = (accent,) + rest

    scale = dict(BASE_SCALE)
    for role, value in (getattr(spec, "font_sizes", None) or {}).items():
        if role in scale and value:
            scale[role] = float(value)

    base_pt = getattr(spec, "base_font_size_pt", None)
    if base_pt:
        ratio = float(base_pt) / BASE_SCALE["body"]
        scale = {role: round(size * ratio, 1) for role, size in scale.items()}

    return Theme(
        preset=name,
        background=background,
        surface=surface,
        accent=accent,
        accent2=accent2,
        text=text,
        muted=muted,
        border=border,
        heading_font=getattr(spec, "heading_font", None) or preset.heading_font,
        body_font=getattr(spec, "body_font", None) or preset.body_font,
        mono_font=getattr(spec, "mono_font", None) or "Consolas",
        chart_palette=resolved_palette,
        scale=scale,
        size_factor=round(max(0.6, min(1.35, slide_height_cm / REFERENCE_HEIGHT_CM)), 3),
    )


def preset_names() -> list[str]:
    return sorted(PRESETS)
