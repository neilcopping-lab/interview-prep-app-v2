const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  ShadingType, BorderStyle, LevelFormat, convertInchesToTwip,
  Table, TableRow, TableCell, WidthType, VerticalAlign, ImageRun,
} = require("docx");

const NAVY = "1F3864";
const ACCENT = "2E74B5";
const GREY = "595959";
const MUSTARD = "C99A1D";
const LIGHT = "EFEFEF";

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 300, after: 140 },
    border: { bottom: { color: NAVY, space: 4, style: BorderStyle.SINGLE, size: 8 } },
    children: [new TextRun({ text, bold: true, color: NAVY, size: 28 })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 200, after: 100 },
    children: [new TextRun({ text, bold: true, color: ACCENT, size: 22 })],
  });
}
function p(text, italics = false) {
  return new Paragraph({ spacing: { after: 140 }, children: [new TextRun({ text, size: 21, italics })] });
}
function note(text) {
  return new Paragraph({
    spacing: { after: 160 },
    shading: { type: ShadingType.CLEAR, fill: "F2F2F2" },
    children: [new TextRun({ text, italics: true, size: 20, color: GREY })],
  });
}
function bullet(text) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 90 },
    children: [new TextRun({ text, size: 21 })],
  });
}
function starLine(label, text) {
  return new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({ text: label + ": ", bold: true, size: 21, color: ACCENT }),
      new TextRun({ text: text || "—", size: 21 }),
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
    children: [
      new TextRun({ text: "Sources: ", bold: true, size: 18, color: GREY }),
      new TextRun({ text: list.map((s) => `${s.title} (${s.url})`).join("   •   "), size: 18, color: GREY, italics: true }),
    ],
  });
}
// Renders a { headline, bullets, sources } research section as a real
// bullet list (not a dense paragraph), with its headline sentence framing
// it and its sources listed underneath. Falls back to a single note
// paragraph if there are no bullets (e.g. the AI call fell back).
function researchSection(title, section) {
  const out = [h1(title)];
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
  const cells = [];
  for (let i = 0; i < 10; i++) {
    cells.push(new TableCell({
      width: { size: 10, type: WidthType.PERCENTAGE },
      shading: { type: ShadingType.CLEAR, fill: i < filled ? MUSTARD : LIGHT },
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 60, bottom: 60 },
      children: [new Paragraph({ text: "" })],
    }));
  }
  return [
    new Paragraph({
      spacing: { before: 100, after: 80 },
      children: [
        new TextRun({ text: `Skills Match: ${skillsMatch.percent}%`, bold: true, size: 22, color: NAVY }),
        new TextRun({ text: `  —  ${skillsMatch.matched} of ${skillsMatch.total} job requirements matched to your CV`, size: 18, color: GREY, italics: true }),
      ],
    }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [new TableRow({ children: cells })],
    }),
    new Paragraph({ text: "", spacing: { after: 160 } }),
  ];
}

// A bespoke cover banner: the AI-generated abstract artwork (if it was
// generated successfully) followed immediately by the candidate/company
// title in real, crisp text — never AI-rendered text, which tends to come
// out garbled and isn't something a paying customer should see on their
// cover. Omitted cleanly if no image was generated (no OPENAI_API_KEY,
// or the call failed) — falls back to a plain text title only.
function coverBanner(report) {
  const out = [];
  if (report.cover && report.cover.base64) {
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [
        new ImageRun({
          data: Buffer.from(report.cover.base64, "base64"),
          transformation: { width: 600, height: 400 },
          type: "png",
        }),
      ],
    }));
  }
  out.push(
    new Paragraph({ spacing: { after: 10 }, children: [new TextRun({ text: "Interview Preparation Report", bold: true, size: 36, color: NAVY })] }),
    new Paragraph({ spacing: { after: 30 }, children: [new TextRun({ text: "Produced by The Com'mon People AI", bold: true, size: 18, color: MUSTARD })] }),
    new Paragraph({ spacing: { after: 30 }, children: [new TextRun({ text: `${report.candidateName || "Candidate"} — ${report.companyName || "Company"}`, bold: true, size: 24, color: ACCENT })] }),
    new Paragraph({ spacing: { after: 300 }, children: [new TextRun({ text: `Generated ${new Date(report.generatedAt).toLocaleString("en-GB")}`, size: 18, color: GREY, italics: true })] }),
  );
  return out;
}

// A single consolidated list of every real source cited anywhere in the
// report (company overview, employee sentiment, social media, market
// intelligence, recent news, role challenges), in addition to the inline
// "Sources:" line already shown under each section — so it's all visible
// in one place at the end, grouped by which section it backs.
function referencesSection(allSources) {
  if (!allSources || !allSources.length) return [];
  const out = [
    h1("11. Sources & References"),
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

    ...researchSection("1. Company Overview", report.research),
    ...researchSection("2. Recent News & Press Activity", report.recentNews),
    ...researchSection("3. Employee Sentiment (Reviews)", report.employeeSentiment),
    ...researchSection("4. Social Media Presence", report.socialMedia),
    ...researchSection("5. Market & Sector Intelligence", report.marketIntelligence),
    ...researchSection("6. Challenges You May Be Facing in This Role", report.roleChallenges),

    h1("7. Opening Pitch — The Pitch Sandwich"),
    h2("Bread 1 — Connect"),
    p(report.pitch.bread1, true),
    h2("Filling — Fit"),
    p(report.pitch.filling, true),
    h2("Bread 2 — Values"),
    p(report.pitch.bread2, true),

    h1("8. Gap Analysis — the Cake + Cherry Method"),
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

    h1("9. STAR Answers"),
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

    h1("10. Your Questions"),
    ...Object.entries(report.questionsToAsk).flatMap(([type, qs]) => [
      h2(type),
      ...qs.map((q) => bullet(q)),
    ]),

    ...referencesSection(report.allSources),
  ];

  const doc = new Document({
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
