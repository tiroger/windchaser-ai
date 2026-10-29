"""An Altair theme derived from the site's design tokens, plus chart helpers.

Colours come from apps/web/app/globals.css (light theme), so the notebooks read
as part of WindChaser:

    ground   #fafaf9   surface  #ffffff   line  #e5e4e0
    ink      #16181c   ink-2    #5c6169   ink-3 #8b9099
    wind     #2f6fa9   effort   #c45314   open  #128857

The categorical order puts the blue/orange pair first: it stays distinct under
the common colour-vision deficiencies, where the site's green and orange do
not (they share lightness). A third series is drawn in neutral ink rather than
green for the same reason, and charts with more series also vary dash or
shape. Every text colour clears 4.5:1 against the white chart surface.
"""

from __future__ import annotations

import altair as alt
import pandas as pd

GROUND = "#fafaf9"
SURFACE = "#ffffff"
LINE = "#e5e4e0"
LINE_SOFT = "#efeeeb"
INK = "#16181c"
INK_2 = "#5c6169"
INK_3 = "#8b9099"
WIND = "#2f6fa9"
EFFORT = "#c45314"
OPEN = "#128857"
WARN = "#9a6510"
ALERT = "#b4272c"

CATEGORICAL = [WIND, EFFORT, INK_2, OPEN, WARN, ALERT, INK_3]
SEQUENTIAL = ["#e8f0f8", "#b9cfe6", "#7fa6cf", "#4a7fb6", WIND, "#1f4a73"]
DIVERGING = [WIND, "#9cbbdb", "#f0efec", "#e5a37f", EFFORT]

FONT = "Geist, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace"

WIDTH = 620
HEIGHT = 300


def theme() -> dict:
    return {
        "config": {
            "background": SURFACE,
            "padding": 8,
            "font": FONT,
            "view": {"stroke": None, "continuousWidth": WIDTH, "continuousHeight": HEIGHT},
            "title": {
                "font": FONT,
                "fontSize": 15,
                "fontWeight": 600,
                "color": INK,
                "anchor": "start",
                "offset": 10,
                "subtitleColor": INK_2,
                "subtitleFontSize": 12,
                "subtitleFontWeight": 400,
            },
            "axis": {
                "labelColor": INK_2,
                "labelFont": MONO,
                "labelFontSize": 11,
                "titleColor": INK_2,
                "titleFont": FONT,
                "titleFontSize": 12,
                "titleFontWeight": 500,
                "gridColor": LINE_SOFT,
                "domainColor": LINE,
                "tickColor": LINE,
                "labelPadding": 4,
                "titlePadding": 8,
            },
            "axisBand": {"grid": False},
            "legend": {
                "labelColor": INK_2,
                "labelFont": FONT,
                "labelFontSize": 12,
                "titleColor": INK_2,
                "titleFontSize": 12,
                "titleFontWeight": 500,
                "symbolStrokeWidth": 2,
                "orient": "top",
                "direction": "horizontal",
            },
            "header": {"labelColor": INK, "labelFont": FONT, "labelFontSize": 12, "titleColor": INK_2},
            "range": {
                "category": CATEGORICAL,
                "ordinal": SEQUENTIAL,
                "ramp": SEQUENTIAL,
                "diverging": DIVERGING,
                "heatmap": SEQUENTIAL,
            },
            "mark": {"color": WIND},
            "point": {"filled": True, "size": 36, "opacity": 0.75},
            "circle": {"size": 36, "opacity": 0.75},
            "line": {"strokeWidth": 2},
            "bar": {"cornerRadiusEnd": 2},
            "rule": {"color": INK_3},
            "text": {"font": FONT, "color": INK_2, "fontSize": 11},
        }
    }


def enable() -> None:
    """Register and enable the theme. Safe to call more than once."""
    alt.theme.register("windchaser", enable=True)(theme)
    # Charts aggregate before plotting; the guard stays, with room for the
    # few per-effort scatters (hundreds of rows) these notebooks draw.
    alt.data_transformers.enable("default", max_rows=20_000)


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def identity_line(lo: float, hi: float, color: str = INK_3) -> alt.Chart:
    """y = x, for predicted-against-actual charts."""
    return (
        alt.Chart(pd.DataFrame({"x": [lo, hi], "y": [lo, hi]}))
        .mark_line(color=color, strokeDash=[4, 4], strokeWidth=1)
        .encode(x="x:Q", y="y:Q")
    )


def hrule(value: float, color: str = INK_3, dash=(4, 4)) -> alt.Chart:
    return alt.Chart(pd.DataFrame({"y": [value]})).mark_rule(color=color, strokeDash=list(dash)).encode(y="y:Q")


def loess_scatter(
    df: pd.DataFrame,
    x: str,
    y: str,
    x_title: str,
    y_title: str,
    title: str,
    tooltip: list | None = None,
    color: str = WIND,
    width: int = 280,
    height: int = 200,
    bandwidth: float = 0.6,
) -> alt.LayerChart:
    """Points with a LOESS smooth and a zero rule: the residual-against-feature
    chart that justifies (or not) a feature."""
    base = alt.Chart(df).properties(width=width, height=height, title=title)
    pts = base.mark_circle(size=22, opacity=0.45, color=color).encode(
        x=alt.X(f"{x}:Q", title=x_title, scale=alt.Scale(zero=False)),
        y=alt.Y(f"{y}:Q", title=y_title),
        tooltip=tooltip or [x, y],
    )
    smooth = base.transform_loess(x, y, bandwidth=bandwidth).mark_line(color=EFFORT, strokeWidth=2.5).encode(
        x=f"{x}:Q", y=f"{y}:Q"
    )
    return alt.layer(hrule(0.0), pts, smooth)


def reliability_chart(df: pd.DataFrame, title: str, subtitle: str | None = None) -> alt.LayerChart:
    """Nominal against empirical coverage, one line per method.

    Expects columns: method, nominal, coverage. On the diagonal is calibrated;
    below it the intervals are too narrow."""
    diag = identity_line(0.4, 1.0)
    lines = alt.Chart(df).mark_line(point=alt.OverlayMarkDef(size=50, filled=True)).encode(
        x=alt.X("nominal:Q", title="Nominal coverage", scale=alt.Scale(domain=[0.4, 1.0]), axis=alt.Axis(format="%")),
        y=alt.Y("coverage:Q", title="Empirical coverage on held-out efforts", scale=alt.Scale(domain=[0.4, 1.0]), axis=alt.Axis(format="%")),
        color=alt.Color("method:N", title=None),
        strokeDash=alt.StrokeDash("method:N", title=None),
        tooltip=[
            "method:N",
            alt.Tooltip("nominal:Q", format=".0%"),
            alt.Tooltip("coverage:Q", format=".1%"),
            alt.Tooltip("width_pct:Q", title="median width", format=".1%"),
        ],
    )
    t = alt.TitleParams(title, subtitle=subtitle) if subtitle else title
    return alt.layer(diag, lines).properties(width=420, height=320, title=t)


def titled(text: str, subtitle: str | None = None) -> alt.TitleParams:
    return alt.TitleParams(text, subtitle=subtitle) if subtitle else alt.TitleParams(text)
