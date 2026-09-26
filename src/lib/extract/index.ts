/**
 * Turning an uploaded file into text.
 *
 * Everything that can go wrong here is something a user has to be told about,
 * so failures are typed and carry a sentence written for a person, not a stack
 * trace:
 *
 *   unsupported-type  the extension or the file's own bytes say it is not a
 *                     contract file we can read
 *   unreadable        it claims to be a PDF or DOCX but the bytes are damaged
 *   no-text           it is a PDF with no text layer at all — a scan. Storing
 *                     this as an empty document and calling it a success is the
 *                     failure mode the assignment warns about, so it is refused
 *
 * A partially-scanned PDF (some pages with text, some without) is accepted, but
 * says so: quotes cannot be verified against pages that produced no text, and
 * the user is told which pages those are rather than silently getting an
 * "I couldn't find that" later.
 */

import { type PageSpan, buildPaginatedText } from "@/lib/text/document";

export type ExtractionFailureCode = "unsupported-type" | "unreadable" | "no-text" | "too-large";

export class ExtractionError extends Error {
  readonly code: ExtractionFailureCode;
  /** Safe to show to the user as-is. */
  readonly userMessage: string;
  readonly hints: string[];

  constructor(code: ExtractionFailureCode, userMessage: string, hints: string[] = []) {
    super(userMessage);
    this.name = "ExtractionError";
    this.code = code;
    this.userMessage = userMessage;
    this.hints = hints;
  }
}

export type ExtractionResult = {
  kind: "pdf" | "docx";
  /** Full text, pages joined by a newline. */
  text: string;
  /** Page ranges into `text`. Empty for DOCX, which has no fixed pages. */
  pages: PageSpan[];
  pageCount: number;
  charCount: number;
  /** Non-fatal remarks shown next to the document in the library. */
  warnings: string[];
};

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MIN_TEXT_CHARS = 40;
const MIN_CHARS_PER_PAGE = 20;

function extensionOf(fileName: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  return match?.[1]?.toLowerCase() ?? "";
}

function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function looksLikeLegacyDoc(bytes: Uint8Array): boolean {
  // OLE2 compound file header — the old binary .doc format.
  return (
    bytes.length > 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  );
}

function decodeText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractionResult> {
  let pageTexts: string[] = [];
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    // pdf.js hands the document bytes to its worker and *transfers* the backing
    // ArrayBuffer, which detaches the caller's view and leaves it zero-length.
    // Passing a copy keeps the original usable for hashing, size and storage —
    // without it every PDF is stored as 0 bytes under one shared content hash.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const result = await extractText(pdf, { mergePages: false });
    pageTexts = (Array.isArray(result.text) ? result.text : [result.text]).map(decodeText);
  } catch (error) {
    throw new ExtractionError(
      "unreadable",
      "This PDF could not be read. It may be damaged or password protected.",
      [error instanceof Error ? error.message : String(error)],
    );
  }

  const pageCount = pageTexts.length;
  const charCount = pageTexts.reduce((total, page) => total + page.trim().length, 0);

  if (charCount < MIN_TEXT_CHARS || (pageCount > 0 && charCount / pageCount < MIN_CHARS_PER_PAGE)) {
    throw new ExtractionError(
      "no-text",
      "This PDF has no extractable text, so nothing in it could be quoted or verified.",
      [
        "It looks like a scan or an image-only export.",
        "Optical character recognition is not built in, so the file was not saved.",
        "Re-export the contract from Word, or upload the DOCX version, and it will work.",
      ],
    );
  }

  const { text, pages } = buildPaginatedText(pageTexts);
  const warnings: string[] = [];
  const emptyPages = pages
    .filter((page) => text.slice(page.start, page.end).trim().length < MIN_CHARS_PER_PAGE)
    .map((page) => page.number);

  if (emptyPages.length > 0) {
    warnings.push(
      `${emptyPages.length} of ${pageCount} pages contain no extractable text (page${emptyPages.length === 1 ? "" : "s"} ${emptyPages.slice(0, 6).join(", ")}${emptyPages.length > 6 ? "…" : ""}). Quotes cannot be verified against those pages.`,
    );
  }

  return { kind: "pdf", text, pages, pageCount, charCount, warnings };
}

async function extractDocx(bytes: Uint8Array): Promise<ExtractionResult> {
  let text = "";
  try {
    const mammoth = (await import("mammoth")).default;
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    text = decodeText(result.value);
  } catch (error) {
    throw new ExtractionError(
      "unreadable",
      "This DOCX file could not be read. It may be damaged or in the older .doc format renamed.",
      [error instanceof Error ? error.message : String(error)],
    );
  }

  const charCount = text.trim().length;
  if (charCount < MIN_TEXT_CHARS) {
    throw new ExtractionError(
      "no-text",
      "This DOCX file contains no readable text, so there is nothing to quote or verify.",
      ["If the content is an image, the document needs to be re-created as text."],
    );
  }

  const warnings = [
    "DOCX files have no fixed page layout, so citations are located by clause and position rather than by page number.",
  ];

  return {
    kind: "docx",
    text: text.replace(/\r\n?/g, "\n").trim(),
    pages: [],
    pageCount: 0,
    charCount,
    warnings,
  };
}

export async function extractDocument(file: {
  name: string;
  bytes: Uint8Array;
}): Promise<ExtractionResult> {
  const { name, bytes } = file;
  const extension = extensionOf(name);

  if (bytes.length === 0) {
    throw new ExtractionError("unsupported-type", "That file is empty.", ["Choose a PDF or DOCX file."]);
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new ExtractionError(
      "too-large",
      `That file is ${(bytes.length / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
      ["A 150-page text contract is normally well under 1 MB.", "Split the contract and upload the parts separately."],
    );
  }

  if (looksLikeLegacyDoc(bytes) || extension === "doc") {
    throw new ExtractionError(
      "unsupported-type",
      "That is a legacy .doc file, which cannot be parsed reliably.",
      ["Open it in Word and save as .docx, then upload again."],
    );
  }

  const isPdf = extension === "pdf" || looksLikePdf(bytes);
  const isDocx = extension === "docx" || (looksLikeZip(bytes) && extension !== "pdf");

  if (isPdf && looksLikePdf(bytes)) return extractPdf(bytes);
  if (isDocx) return extractDocx(bytes);

  if (extension === "pdf") {
    throw new ExtractionError("unreadable", "That file is named .pdf but its contents are not a PDF.", []);
  }
  if (extension === "docx") {
    throw new ExtractionError("unreadable", "That file is named .docx but its contents are not a DOCX file.", []);
  }

  throw new ExtractionError(
    "unsupported-type",
    extension ? `.${extension} files are not supported. Upload a PDF or DOCX contract.` : "Upload a PDF or DOCX contract.",
    [
      "Supported: .pdf, .docx",
      "Not supported: .doc, .txt, .rtf, .pages, images and emails",
    ],
  );
}
