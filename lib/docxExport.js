const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  ShadingType, BorderStyle, LevelFormat, convertInchesToTwip,
  Table, TableRow, TableCell, WidthType, VerticalAlign, ImageRun,
} = require("docx");

// ---------------------------------------------------------------------
// The Com'mon People brand palette + type — pulled directly from
// public/style.css (the live web app) so the downloaded report actually
// matches the site instead of looking like a generic corporate template.
// Previously this file used its own unrelated navy/blue palette
// (#1F3864/#2E74B5) that had nothing to do with the real brand.
// ---------------------------------------------------------------------
const NAVY = "161F29";      // --bg
const NAVY_DARK = "0F151C"; // --bg-dark
const MUSTARD = "E0B03C";   // --mustard
const SKY = "5AA9C2";       // --sky
const ORANGE = "D2691E";    // --orange
const CREAM = "ECE6D8";     // --cream
const CREAM_SOFT = "8A8474"; // muted version of --cream-soft, readable on a light page
const GREY = "5B5648";

// The site's three-colour "sticker" cycle (see .brand span:nth-child in
// style.css) — section headers cycle through these so the report has the
// same alternating colour-block rhythm as the website, instead of every
// section looking identical.
const ACCENT_CYCLE = [MUSTARD, SKY, ORANGE];

// docx-js lets you name any font; Word (or Google Docs) substitutes a
// close match if it isn't installed, but specifying the real brand fonts
// is still correct and renders exactly right on any machine that has them.
const FONT_DISPLAY = "Anton";   // headline / cover font
const FONT_HEADING = "Oswald";  // section headers, labels
const FONT_BODY = "Arvo";       // body copy

// A4 page (11906 twips wide) with docx-js's default 1440-twip (1") margins
// on each side leaves this much usable width. Tables need an explicit DXA
// width on both the table and every cell — percentage widths render fine
// in Word but silently collapse/break in Google Docs and some renderers
// (this is what caused the cover banner and brand mark to render as a
// near-invisible sliver in the first draft of this file).
const CONTENT_WIDTH_DXA = 9026;

// Section headers get dark text on light accent fills (mustard/sky) and
// cream text on the darker orange fill, matching how the real logo mark
// handles contrast per colour.
function textColorFor(bgColor) {
  return bgColor === ORANGE ? CREAM : NAVY;
}

function h1(text, cycleIndex = 0) {
  const bg = ACCENT_CYCLE[cycleIndex % ACCENT_CYCLE.length];
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 320, after: 160 },
    shading: { type: ShadingType.CLEAR, fill: bg },
    children: [new TextRun({
      text: text.toUpperCase(), bold: true, color: textColorFor(bg), size: 27,
      font: FONT_DISPLAY,
    })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 220, after: 100 },
    children: [new TextRun({ text, bold: true, color: ORANGE, size: 22, font: FONT_HEADING })],
  });
}
function p(text, italics = false) {
  return new Paragraph({ spacing: { after: 140 }, children: [new TextRun({ text, size: 21, italics, color: NAVY, font: FONT_BODY })] });
}
function note(text) {
  return new Paragraph({
    spacing: { after: 160 },
    shading: { type: ShadingType.CLEAR, fill: "F4F1E8" },
    children: [new TextRun({ text, italics: true, size: 20, color: GREY, font: FONT_BODY })],
  });
}
function bullet(text) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 90 },
    children: [new TextRun({ text, size: 21, color: NAVY, font: FONT_BODY })],
  });
}
function starLine(label, text) {
  return new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({ text: label + ": ", bold: true, size: 21, color: ORANGE, font: FONT_HEADING }),
      new TextRun({ text: text || "—", size: 21, color: NAVY, font: FONT_BODY }),
    ],
  });
}
// Renders a small "Sources:" line under a researched section, listing the
// real URLs Claude's web search actually cited. Omitted entirely (via the
// caller) when a section has no sources — e.g. it ran in fallback mode.
function sources(list) {
  if (!list || !list.length) return null;
  return new Paragraph({
    spacing: { after: 200 },
    border: { top: { color: CREAM_SOFT, space: 4, style: BorderStyle.SINGLE, size: 4 } },
    children: [
      new TextRun({ text: "Sources: ", bold: true, size: 18, color: GREY, font: FONT_HEADING }),
      new TextRun({ text: list.map((s) => `${s.title} (${s.url})`).join("   •   "), size: 18, color: GREY, italics: true, font: FONT_BODY }),
    ],
  });
}
// Renders a { headline, bullets, sources } research section as a real
// bullet list (not a dense paragraph), with its headline sentence framing
// it and its sources listed underneath. Falls back to a single note
// paragraph if there are no bullets (e.g. the AI call fell back).
function researchSection(title, section, cycleIndex) {
  const out = [h1(title, cycleIndex)];
  if (section.headline) out.push(p(section.headline));
  if (section.bullets && section.bullets.length) {
    out.push(...section.bullets.map((b) => bullet(b)));
  } else {
    out.push(note(section.headline || "No information available for this section."));
  }
  const s = sources(section.sources);
  if (s) out.push(s);
  return out;
}
// A dependency-free "skills match" bar — docx (v9.x) has no native chart
// support, so this fakes a horizontal bar using a 10-cell shaded table
// row rather than pulling in a heavy image/canvas library. Simple, but
// gives a real at-a-glance visual instead of just text.
function skillsMatchBar(skillsMatch) {
  if (!skillsMatch || skillsMatch.percent === null) return [];
  const filled = Math.round(skillsMatch.percent / 10);
  const colWidth = Math.floor(CONTENT_WIDTH_DXA / 10);
  const cells = [];
  for (let i = 0; i < 10; i++) {
    cells.push(new TableCell({
      width: { size: colWidth, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: i < filled ? MUSTARD : "DCD5C4" },
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 60, bottom: 60 },
      children: [new Paragraph({ text: "" })],
    }));
  }
  return [
    new Paragraph({
      spacing: { before: 100, after: 80 },
      children: [
        new TextRun({ text: `Skills Match: ${skillsMatch.percent}%`, bold: true, size: 22, color: NAVY, font: FONT_HEADING }),
        new TextRun({ text: `  —  ${skillsMatch.matched} of ${skillsMatch.total} job requirements matched to your CV`, size: 18, color: GREY, italics: true, font: FONT_BODY }),
      ],
    }),
    new Table({
      width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
      columnWidths: new Array(10).fill(colWidth),
      rows: [new TableRow({ children: cells })],
    }),
    new Paragraph({ text: "", spacing: { after: 160 } }),
  ];
}

// The three-block "The / Com'mon / People" logo mark, recreated as three
// bold coloured cells side by side — same colour cycle and rough
// composition as the real header logo on the live site.
function brandMark() {
  const words = ["THE", "COM'MON", "PEOPLE"];
  const colWidth = Math.floor(CONTENT_WIDTH_DXA / words.length);
  return new Table({
    width: { size: colWidth * words.length, type: WidthType.DXA },
    columnWidths: new Array(words.length).fill(colWidth),
    alignment: AlignmentType.CENTER,
    rows: [new TableRow({
      children: words.map((w, i) => new TableCell({
        width: { size: colWidth, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: ACCENT_CYCLE[i % ACCENT_CYCLE.length] },
        verticalAlign: VerticalAlign.CENTER,
        margins: { top: 140, bottom: 140, left: 80, right: 80 },
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: w, bold: true, size: 30, color: textColorFor(ACCENT_CYCLE[i % ACCENT_CYCLE.length]), font: FONT_DISPLAY })],
        })],
      })),
    })],
  });
}

// A bespoke cover banner: a dark navy block (mirroring the site's dark
// header/hero) containing the brand mark, the AI-generated abstract
// artwork (if it was generated successfully), and the candidate/company
// title in real, crisp text — never AI-rendered text, which tends to come
// out garbled and isn't something a paying customer should see on their
// cover. Omitted cleanly if no image was generated (no OPENAI_API_KEY, or
// the call failed) — falls back to a plain text title only.
function coverBanner(report) {
  const out = [brandMark(), new Paragraph({ text: "", spacing: { after: 200 } })];

  const bannerChildren = [];
  if (report.cover && report.cover.base64) {
    bannerChildren.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new ImageRun({
          data: Buffer.from(report.cover.base64, "base64"),
          transformation: { width: 560, height: 340 },
          type: "png",
        }),
      ],
    }));
  }
  bannerChildren.push(
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 30 }, children: [
      new TextRun({ text: "INTERVIEW PREPARATION REPORT", bold: true, size: 40, color: CREAM, font: FONT_DISPLAY }),
    ] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [
      new TextRun({ text: "PRODUCED BY THE COM'MON PEOPLE AI", bold: true, size: 18, color: MUSTARD, font: FONT_HEADING }),
    ] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 30 }, children: [
      new TextRun({ text: `${report.candidateName || "Candidate"} — ${report.companyName || "Company"}`, bold: true, size: 26, color: SKY, font: FONT_HEADING }),
    ] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [
      new TextRun({ text: `Generated ${new Date(report.generatedAt).toLocaleString("en-GB")}`, size: 18, color: CREAM_SOFT, italics: true, font: FONT_BODY }),
    ] }),
  );

  out.push(new Table({
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: [CONTENT_WIDTH_DXA],
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: NAVY_DARK },
        margins: { top: 300, bottom: 320, left: 300, right: 300 },
        children: bannerChildren,
      })],
    })],
  }));
  out.push(new Paragraph({ text: "", spacing: { after: 260 } }));
  return out;
}

// A single consolidated list of every real source cited anywhere in the
// report (company overview, employee sentiment, social media, market
// intelligence, recent news, role challenges), in addition to the inline
// "Sources:" line already shown under each section — so it's all visible
// in one place at the end, grouped by which section it backs.
function referencesSection(allSources, cycleIndex) {
  if (!allSources || !allSources.length) return [];
  const out = [
    h1("11. Sources & References", cycleIndex),
    p("Every source the AI actually drew on while researching this report, for your own reference or spot-checking."),
  ];
  const bySection = {};
  allSources.forEach((s) => {
    if (!bySection[s.section]) bySection[s.section] = [];
    bySection[s.section].push(s);
  });
  Object.entries(bySection).forEach(([section, list]) => {
    out.push(h2(section));
    list.forEach((s) => out.push(bullet(`${s.title} — ${s.url}`)));
  });
  return out;
}

async function buildReportDocx(report) {
  const children = [
    ...coverBanner(report),

    ...researchSection("1. Company Overview", report.research, 0),
    ...researchSection("2. Recent News & Press Activity", report.recentNews, 1),
    ...researchSection("3. Employee Sentiment (Reviews)", report.employeeSentiment, 2),
    ...researchSection("4. Social Media Presence", report.socialMedia, 0),
    ...researchSection("5. Market & Sector Intelligence", report.marketIntelligence, 1),
    ...researchSection("6. Challenges You May Be Facing in This Role", report.roleChallenges, 2),

    h1("7. Opening Pitch — The Pitch Sandwich", 0),
    h2("Bread 1 — Connect"),
    p(report.pitch.bread1, true),
    h2("Filling — Fit"),
    p(report.pitch.filling, true),
    h2("Bread 2 — Values"),
    p(report.pitch.bread2, true),

    h1("8. Gap Analysis — the Cake + Cherry Method", 1),
    ...skillsMatchBar(report.skillsMatch),
    p("Matched strengths (found in both the job description and your CV):"),
    ...(report.gapAnalysis.matchedStrengths.length
      ? report.gapAnalysis.matchedStrengths.map((m) => bullet(m))
      : [note("No strong keyword overlap detected — worth checking the CV genuinely covers the role.")]),
    p("Development areas and cherries on top:"),
    ...report.gapAnalysis.developmentAreas.flatMap((d) => [
      starLine("Area", d.area),
      starLine("Cherry", d.cherry),
    ]),

    h1("9. STAR Answers", 2),
    p(report.starGuide.intro),
    ...report.starGuide.steps.flatMap((s) => [starLine(`${s.letter} — ${s.label}`, s.explanation)]),
    ...report.starGuide.tips.map((t) => bullet(t)),
    ...(report.questionsFootnote ? [note(report.questionsFootnote)] : []),
    new Paragraph({ text: "", spacing: { after: 100 } }),
    ...report.starAnswers.flatMap((a) => [
      h2(a.question),
      ...(a.basedOn ? [note(`Based on: "${a.basedOn}" in the job description`)] : []),
      starLine("Situation", a.situation),
      starLine("Task", a.task),
      starLine("Action", a.action),
      starLine("Result", a.result),
      ...(a.note ? [note(a.note)] : []),
    ]),

    h1("10. Your Questions", 0),
    ...Object.entries(report.questionsToAsk).flatMap(([type, qs]) => [
      h2(type),
      ...qs.map((q) => bullet(q)),
    ]),

    ...referencesSection(report.allSources, 1),
  ];

  const doc = new Document({
    background: { color: CREAM },
    numbering: {
      config: [{
        reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: convertInchesToTwip(0.3), hanging: convertInchesToTwip(0.18) } } } }],
      }],
    },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 } } }, children }],
  });

  return Packer.toBuffer(doc);
}

module.exports = { buildReportDocx };
