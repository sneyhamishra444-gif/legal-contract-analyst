/**
 * Generates the sample contracts in fixtures/.
 *
 *   node tools/make-fixtures.mjs
 *
 * These are real files, not mocks: a 6-page agreement, a ~150-page agreement,
 * a PDF containing no extractable text (a scan), and two DOCX revisions that
 * differ in specific, known ways so the comparison feature can be asserted
 * against something true.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { BASE_CLAUSES, SERVICE_AGREEMENT, renderContract, revisedClauses } from "./fixtures/contract-text.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", "fixtures");
fs.mkdirSync(outDir, { recursive: true });

const PAGE = { width: 595.28, height: 841.89, margin: 56, fontSize: 10, leading: 13.6 };

/** Greedy word wrap at a measured width. */
function wrap(text, font, size, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Render text as a paginated PDF, with a page number footer on every page. */
async function buildPdf(text, { title, footer = true } = {}) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  const body = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const maxWidth = PAGE.width - PAGE.margin * 2;
  const paragraphs = text.split("\n");
  const pages = [];
  let page = pdf.addPage([PAGE.width, PAGE.height]);
  pages.push(page);
  let y = PAGE.height - PAGE.margin;

  const newPage = () => {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    pages.push(page);
    y = PAGE.height - PAGE.margin;
  };

  for (const paragraph of paragraphs) {
    const isHeading = /^(\d+\.\s+[A-Z][A-Z\s,&-]+|MASTER SERVICES AGREEMENT)$/.test(paragraph.trim());
    const font = isHeading ? bold : body;
    const size = isHeading ? 11 : PAGE.fontSize;
    if (!paragraph.trim()) {
      y -= PAGE.leading * 0.6;
      if (y < PAGE.margin) newPage();
      continue;
    }
    for (const line of wrap(paragraph, font, size, maxWidth)) {
      if (y < PAGE.margin) newPage();
      page.drawText(line, { x: PAGE.margin, y, size, font, color: rgb(0.1, 0.1, 0.12) });
      y -= PAGE.leading;
    }
    y -= PAGE.leading * 0.35;
  }

  if (footer) {
    pages.forEach((p, index) => {
      p.drawText(`Page ${index + 1} of ${pages.length}`, {
        x: PAGE.width / 2 - 32,
        y: PAGE.margin / 2,
        size: 8,
        font: body,
        color: rgb(0.45, 0.45, 0.5),
      });
    });
  }

  return Buffer.from(await pdf.save());
}

/** Prefix clause numbers so repeated schedules read as distinct clauses. */
function renumber(clauses, offset) {
  const shift = (value) =>
    value.replace(/^(\d+)(\.\d+)?/, (whole, a, b) => {
      const first = Number(a) + offset;
      return b ? `${first}${b}` : `${first}.`;
    });
  return clauses.map((clause) => ({
    number: String(Number(clause.number) + offset),
    heading: clause.heading,
    paragraphs: clause.paragraphs.map((p) => shift(p)),
  }));
}

function xmlEscape(value) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

/**
 * A minimal but genuine .docx. Paragraph text is deliberately split across
 * several runs (as Word does once formatting is applied), because a parser
 * that reads runs naively will corrupt sentences that were written normally.
 */
async function buildDocx(clauses) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`,
  );

  const paragraphs = [];
  const push = (text, style) => {
    if (text === undefined) return;
    if (!text.trim()) {
      paragraphs.push("<w:p/>");
      return;
    }
    // Split into 2-3 runs to imitate real Word fragmentation.
    const runs = [];
    const words = text.split(" ");
    const chunkSize = Math.max(1, Math.ceil(words.length / 3));
    for (let i = 0; i < words.length; i += chunkSize) {
      const chunk = words.slice(i, i + chunkSize).join(" ");
      const tail = i + chunkSize < words.length ? " " : "";
      runs.push(`<w:r><w:t xml:space="preserve">${xmlEscape(chunk + tail)}</w:t></w:r>`);
    }
    paragraphs.push(
      `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${runs.join("")}</w:p>`,
    );
  };

  push(SERVICE_AGREEMENT.title, "Heading1");
  for (const p of SERVICE_AGREEMENT.parties) push(p);
  for (const clause of clauses) {
    push(`${clause.number}. ${clause.heading}`, "Heading1");
    for (const p of clause.paragraphs) push(p);
  }

  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  );

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** A PDF whose pages contain no text operators at all — i.e. a scan. */
async function buildScannedPdf() {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Scanned contract (image only)");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i += 1) {
    const page = pdf.addPage([PAGE.width, PAGE.height]);
    // Grey bands standing in for a scanned page image.
    for (let band = 0; band < 14; band += 1) {
      page.drawRectangle({
        x: PAGE.margin,
        y: PAGE.height - PAGE.margin - band * 50,
        width: PAGE.width - PAGE.margin * 2,
        height: band % 3 === 0 ? 8 : 5,
        color: rgb(0.82, 0.82, 0.84),
      });
    }
    page.drawText("", { x: PAGE.margin, y: PAGE.margin, size: 1, font });
  }
  return Buffer.from(await pdf.save());
}

async function main() {
  const baseText = renderContract(BASE_CLAUSES);

  const written = [];
  const write = async (name, data) => {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, data);
    written.push([name, data.length]);
  };

  await write("services-agreement.pdf", await buildPdf(baseText, { title: "Master Services Agreement" }));
  await write("services-agreement.docx", await buildDocx(BASE_CLAUSES));
  await write("services-agreement-revised.docx", await buildDocx(revisedClauses()));

  // One page, short: handy for a quick end-to-end check without a large upload.
  await write(
    "short-nda.pdf",
    await buildPdf(
      `MUTUAL NON-DISCLOSURE AGREEMENT\n\n1. CONFIDENTIALITY\n\n1.1 Each Party shall keep the other Party's Confidential Information strictly confidential and shall not disclose it to any third party without prior written consent.\n\n1.2 The obligations in this clause 1 shall survive for a period of three (3) years from the date of disclosure.\n\n2. GOVERNING LAW\n\n2.1 This Agreement shall be governed by the laws of England and Wales.`,
      { title: "Mutual NDA", footer: false },
    ),
  );

  // ~150 pages: the same clauses repeated as numbered schedules.
  const bulk = [];
  const repeats = 44;
  for (let r = 0; r < repeats; r += 1) {
    if (r === 0) {
      bulk.push(...BASE_CLAUSES);
    } else {
      bulk.push({
        number: String(r * 100),
        heading: `SCHEDULE ${r} — SUPPLEMENTAL TERMS`,
        paragraphs: [`${r * 100}.1 The following supplemental terms apply to Schedule ${r} and form part of this Agreement.`],
      });
      bulk.push(...renumber(BASE_CLAUSES, r * 100));
    }
  }
  await write(
    "large-master-agreement.pdf",
    await buildPdf(renderContract(bulk), { title: "Master Services Agreement (consolidated schedules)" }),
  );

  await write("scanned-contract.pdf", await buildScannedPdf());

  fs.writeFileSync(
    path.join(outDir, "README.md"),
    `# Sample contracts

Generated by \`node tools/make-fixtures.mjs\` from \`tools/fixtures/contract-text.mjs\`.
They are committed so the app can be tried immediately and so the test suite
runs without creating anything first.

| File | What it is for |
| --- | --- |
| \`services-agreement.pdf\` | A normal 6-page contract. Multi-page, wraps lines, page numbers. |
| \`services-agreement.docx\` | The same wording as DOCX, with sentences split across runs. |
| \`services-agreement-revised.docx\` | A second version differing in known ways: liability cap AED 100,000 to AED 1,000,000, payment terms 60 to 30 days, a deleted clause, two added clauses, and two clauses that were reworded only. |
| \`large-master-agreement.pdf\` | About 150 pages (44 repeated schedules). Used to test large-document handling. |
| \`scanned-contract.pdf\` | Three pages with no extractable text. The app must reject it with a clear message rather than storing an empty document. |
| \`short-nda.pdf\` | A single short page, for a quick manual check. |

Note the revised version is a deliberate mix: some changes are substantive
(money, notice periods, forum) and some are pure rewording. A comparison that
flags all of them as equally important has not done the job.
`,
  );

  console.log("fixtures written to", outDir);
  for (const [name, size] of written) {
    console.log(`  ${name.padEnd(34)} ${(size / 1024).toFixed(1)} KB`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
