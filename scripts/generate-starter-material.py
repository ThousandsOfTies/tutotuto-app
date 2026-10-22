"""Regenerate the bundled starter PDFs and thumbnails from the app translations.

Requires reportlab and Poppler's pdftoppm. Supply Japanese-capable TrueType fonts
with embedding permission; TTC files use their first face. No fonts are copied.
"""

import argparse
import json
from pathlib import Path
import subprocess

from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parent.parent
BLUE = HexColor("#23799c")
INK = HexColor("#263b48")
MUTED = HexColor("#526674")
LINE = HexColor("#c7d5db")
# Match the usable area of a landscape iPad below the app's study toolbar.
PAGE_SIZE = (960, 640)


def wrap(text, width, font, size):
    lines = []
    current = ""
    # Prefer word wrapping for Latin text and character wrapping for Japanese.
    tokens = list(text) if any(ord(char) > 255 for char in text) else text.split(" ")
    separator = "" if any(ord(char) > 255 for char in text) else " "
    for token in tokens:
        candidate = current + (separator if current else "") + token
        if current and pdfmetrics.stringWidth(candidate, font, size) > width:
            lines.append(current)
            current = token
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def paragraph(pdf, text, x, y, width, size=10, leading=15, color=MUTED):
    pdf.setFillColor(color)
    pdf.setFont("StarterRegular", size)
    for line in wrap(text, width, "StarterRegular", size):
        pdf.drawString(x, y, line)
        y -= leading
    return y


def draw_page(pdf, content, common, number, total):
    pdf.setFillColor(BLUE)
    pdf.rect(36, 610, 38, 4, fill=1, stroke=0)
    pdf.setFillColor(INK)
    pdf.setFont("StarterBold", 28)
    pdf.drawString(36, 572, content["title"])
    paragraph(pdf, content["subtitle"], 36, 546, 888, 12)

    pdf.setStrokeColor(LINE)
    pdf.setLineWidth(0.7)
    pdf.line(292, 100, 292, 524)
    pdf.setFillColor(BLUE)
    pdf.setFont("StarterBold", 17)
    pdf.drawString(36, 506, content["guideTitle"])
    step_spacing = min(82, 324 / max(1, len(content["steps"]) - 1))
    for step_number, step in enumerate(content["steps"], start=1):
        y = 468 - (step_number - 1) * step_spacing
        pdf.setFont("StarterBold", 16)
        pdf.setFillColor(BLUE)
        pdf.drawString(36, y, str(step_number))
        pdf.setFillColor(INK)
        pdf.setFont("StarterBold", 12.5)
        pdf.drawString(58, y, step["title"])
        paragraph(pdf, step["body"], 58, y - 18, 212, 10.5, 14)

    for index, section in enumerate(content["sections"]):
        y = 506 - index * 144
        pdf.setFillColor(BLUE)
        pdf.setFont("StarterBold", 19)
        pdf.drawString(322, y, section["title"])
        for question_index, question in enumerate(section["items"]):
            # Two questions share a row, each with its own wide answer space.
            x = 322 + question_index * 315
            question_y = y - 45
            pdf.setFillColor(INK)
            pdf.setFont("StarterRegular", 24 if index == 0 else 18)
            pdf.drawString(x, question_y, question)
            pdf.setStrokeColor(LINE)
            pdf.setLineWidth(0.6)
            pdf.line(x, question_y - 48, x + 287, question_y - 48)

    pdf.setStrokeColor(LINE)
    pdf.line(36, 80, 924, 80)
    paragraph(pdf, content["tryOne"], 36, 54, 888, 11.5, color=INK)
    paragraph(pdf, common["network"], 36, 32, 800, 10)
    pdf.setFillColor(MUTED)
    pdf.setFont("StarterRegular", 10)
    page_number = common["pageNumber"].replace("{{current}}", str(number)).replace("{{total}}", str(total))
    pdf.drawRightString(924, 32, page_number)
    pdf.showPage()


def generate(language, renderer):
    content = json.loads((ROOT / f"src/i18n/locales/{language}.json").read_text(encoding="utf-8"))["starterMaterial"]
    output = ROOT / f"public/drills/starter-{language}-v1.pdf"
    output.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(output), pagesize=PAGE_SIZE, invariant=1, pageCompression=1)
    pdf.setTitle(content["title"])
    pdf.setAuthor("TutoTuto")
    for number, page in enumerate([content, content["practice"]], start=1):
        draw_page(pdf, page, content, number, 2)
    pdf.save()
    subprocess.run([renderer, "-f", "1", "-singlefile", "-scale-to", "640", "-jpeg",
                    "-jpegopt", "quality=85", str(output), str(output.with_suffix(""))], check=True)
    print(f"Generated {output.name} and {output.with_suffix('.jpg').name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", required=True)
    parser.add_argument("--bold-font", required=True)
    parser.add_argument("--pdftoppm", default="pdftoppm")
    args = parser.parse_args()
    pdfmetrics.registerFont(TTFont("StarterRegular", args.font, subfontIndex=0))
    pdfmetrics.registerFont(TTFont("StarterBold", args.bold_font, subfontIndex=0))
    for locale in ("ja", "en"):
        generate(locale, args.pdftoppm)
