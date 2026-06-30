import fs from "node:fs"
import path from "node:path"
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  ImageRun,
  ExternalHyperlink,
  ShadingType,
} from "docx"

const ROOT = process.cwd()
const PRD_PATH = path.join(ROOT, "docs/PRD.md")
const SHOTS = path.join(ROOT, "docs/shots")
const OUT = path.join(ROOT, "docs/AI编标助手-PRD.docx")

const FONT = "Microsoft YaHei"
const BRAND = "4F46E5"
const GRAY = "6B7280"
const LIGHT = "F3F4F6"

// ---- read PNG dimensions from IHDR ----
function pngSize(buf) {
  // width at offset 16, height at offset 20 (big-endian)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

// screenshots inserted after these section heading prefixes
const SHOT_MAP = {
  "3.1": "home.png",
  "3.2": "login.png",
  "3.3": "upload.png",
  "3.4": "read.png",
  "3.5": "outline.png",
  "3.6": "content.png",
  "3.7": "risk.png",
  "3.8": "projects.png",
  "3.9": "membership.png",
}
const SHOT_CAPTION = {
  "3.1": "原型截图：首页（落地页）",
  "3.2": "原型截图：登录 / 注册",
  "3.3": "原型截图：新建标书 / 上传",
  "3.4": "原型截图：招标解读（双栏）",
  "3.5": "原型截图：提纲生成（双栏可编辑）",
  "3.6": "原型截图：标书生成（三栏 + AI 对话）",
  "3.7": "原型截图：标书审查（废标风险审查）",
  "3.8": "原型截图：我的标书 / 项目",
  "3.9": "原型截图：会员中心（积分体系）",
}

function imageParagraphs(file, caption) {
  const full = path.join(SHOTS, file)
  if (!fs.existsSync(full)) return []
  const data = fs.readFileSync(full)
  const { width, height } = pngSize(data)
  const targetW = 560
  const targetH = Math.round((height / width) * targetW)
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 160, after: 40 },
      children: [
        new ImageRun({
          data,
          transformation: { width: targetW, height: targetH },
          // light border via outline is not directly supported; rely on screenshot
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: caption, italics: true, size: 18, color: GRAY, font: FONT })],
    }),
  ]
}

// ---- inline parser: **bold**, `code`, [text](url) ----
function inlineRuns(text, base = {}) {
  const runs = []
  // tokenize by patterns
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) {
      runs.push(new TextRun({ text: text.slice(last, m.index), font: FONT, size: 21, ...base }))
    }
    const tok = m[0]
    if (tok.startsWith("**")) {
      runs.push(new TextRun({ text: tok.slice(2, -2), bold: true, font: FONT, size: 21, ...base }))
    } else if (tok.startsWith("`")) {
      runs.push(new TextRun({ text: tok.slice(1, -1), font: "Consolas", size: 20, color: BRAND, ...base }))
    } else {
      const mt = tok.match(/\[([^\]]+)\]\(([^)]+)\)/)
      runs.push(
        new ExternalHyperlink({
          link: mt[2],
          children: [new TextRun({ text: mt[1], style: "Hyperlink", font: FONT, size: 21 })],
        }),
      )
    }
    last = regex.lastIndex
  }
  if (last < text.length) {
    runs.push(new TextRun({ text: text.slice(last), font: FONT, size: 21, ...base }))
  }
  return runs.length ? runs : [new TextRun({ text: "", font: FONT, size: 21 })]
}

function cell(text, { header = false } = {}) {
  return new TableCell({
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    shading: header ? { type: ShadingType.CLEAR, fill: BRAND } : undefined,
    children: [
      new Paragraph({
        children: header
          ? [new TextRun({ text, bold: true, color: "FFFFFF", font: FONT, size: 20 })]
          : inlineRuns(text, { size: 20 }),
      }),
    ],
  })
}

function makeTable(rows) {
  const [head, , ...body] = rows // rows[1] is the --- separator
  const tableRows = []
  tableRows.push(new TableRow({ tableHeader: true, children: head.map((c) => cell(c, { header: true })) }))
  for (const r of body) {
    tableRows.push(new TableRow({ children: r.map((c) => cell(c)) }))
  }
  const border = { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" }
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: tableRows,
  })
}

function parseTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((s) => s.trim())
}

// ---- main parse ----
const md = fs.readFileSync(PRD_PATH, "utf8")
const lines = md.split("\n")
const children = []
let i = 0
let currentSection = null

while (i < lines.length) {
  let line = lines[i]

  // code block / ascii diagram
  if (line.trim().startsWith("```")) {
    i++
    const code = []
    while (i < lines.length && !lines[i].trim().startsWith("```")) {
      code.push(lines[i])
      i++
    }
    i++ // closing fence
    children.push(
      new Paragraph({
        spacing: { before: 80, after: 120 },
        shading: { type: ShadingType.CLEAR, fill: LIGHT },
        children: code.flatMap((c, idx) => [
          ...(idx ? [new TextRun({ break: 1 })] : []),
          new TextRun({ text: c || " ", font: "Consolas", size: 18, color: "374151" }),
        ]),
      }),
    )
    continue
  }

  // table
  if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|/.test(lines[i + 1])) {
    const rows = []
    while (i < lines.length && lines[i].trim().startsWith("|")) {
      rows.push(parseTableRow(lines[i]))
      i++
    }
    children.push(makeTable(rows))
    children.push(new Paragraph({ spacing: { after: 120 }, children: [] }))
    continue
  }

  // headings
  const h = line.match(/^(#{1,4})\s+(.*)$/)
  if (h) {
    const level = h[1].length
    const text = h[2].trim()
    const secMatch = text.match(/^(\d+\.\d+)/)
    currentSection = secMatch ? secMatch[1] : currentSection
    const headingLevel = [HeadingLevel.TITLE, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][
      level - 1
    ]
    children.push(
      new Paragraph({
        heading: headingLevel,
        spacing: { before: level <= 2 ? 240 : 160, after: 80 },
        children: [new TextRun({ text, bold: true, font: FONT, color: level <= 2 ? BRAND : "111827" })],
      }),
    )
    // insert screenshot right after a 3.x section heading
    if (secMatch && SHOT_MAP[secMatch[1]] && level === 3) {
      for (const p of imageParagraphs(SHOT_MAP[secMatch[1]], SHOT_CAPTION[secMatch[1]])) children.push(p)
    }
    i++
    continue
  }

  // horizontal rule
  if (line.trim() === "---") {
    children.push(
      new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "E5E7EB", space: 1 } },
        spacing: { before: 80, after: 80 },
        children: [],
      }),
    )
    i++
    continue
  }

  // blockquote
  if (line.trim().startsWith(">")) {
    const text = line.replace(/^\s*>\s?/, "")
    children.push(
      new Paragraph({
        spacing: { before: 60, after: 120 },
        indent: { left: 240 },
        border: { left: { style: BorderStyle.SINGLE, size: 18, color: BRAND, space: 12 } },
        children: inlineRuns(text, { italics: true, color: GRAY }),
      }),
    )
    i++
    continue
  }

  // list item (-, *, or numbered)
  const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/)
  if (li) {
    const indent = Math.floor(li[1].length / 2)
    const ordered = /\d+\./.test(li[2])
    children.push(
      new Paragraph({
        spacing: { after: 40 },
        indent: { left: 360 + indent * 360 },
        bullet: ordered ? undefined : { level: indent },
        numbering: undefined,
        children: [
          ...(ordered ? [new TextRun({ text: li[2] + " ", bold: true, font: FONT, size: 21, color: BRAND })] : []),
          ...inlineRuns(li[3]),
        ],
      }),
    )
    i++
    continue
  }

  // blank
  if (line.trim() === "") {
    i++
    continue
  }

  // normal paragraph
  children.push(new Paragraph({ spacing: { after: 100 }, children: inlineRuns(line) }))
  i++
}

const doc = new Document({
  creator: "v0",
  title: "AI 编标助手 PRD",
  styles: {
    default: {
      document: { run: { font: FONT, size: 21 } },
    },
  },
  sections: [
    {
      properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
      children,
    },
  ],
})

const buf = await Packer.toBuffer(doc)
fs.writeFileSync(OUT, buf)
console.log("[v0] PRD docx written to", OUT, "size", buf.length)
