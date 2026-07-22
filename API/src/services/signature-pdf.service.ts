import { createHash } from 'node:crypto';

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFStream,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';

import { getEnv, type Env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

const PDF_HEADER = Buffer.from('%PDF-', 'ascii');
const PDF_EOF = Buffer.from('%%EOF', 'ascii');

const FORBIDDEN_PDF_NAMES = [
  '/AA',
  '/AcroForm',
  '/EmbeddedFile',
  '/Filespec',
  '/GoToE',
  '/GoToR',
  '/ImportData',
  '/JavaScript',
  '/JS',
  '/Launch',
  '/OpenAction',
  '/RichMedia',
  '/Sound',
  '/SubmitForm',
  '/URI',
  '/XFA',
] as const;
const FORBIDDEN_PARSED_PDF_NAMES = new Set(FORBIDDEN_PDF_NAMES.map((name) => name.slice(1)));

export interface ValidatedSourcePdf {
  byteLength: number;
  pageCount: number;
  sha256: string;
}

export interface ReceiptCertificateData {
  signatureId: string;
  verificationReference: string;
  verificationUrl: string;
  domain: string;
  agreementId: string;
  agreementVersionId: string;
  version: number;
  agreementTitle: string;
  signerName: string;
  signerEmail: string;
  signingMethod: 'CLICKWRAP' | 'TYPED_NAME';
  typedName?: string;
  acceptanceStatement: string;
  signedAt: Date;
  authMethod: string;
  twoFaCompleted: boolean;
  sourcePdfSha256: string;
  evidenceManifestSha256: string;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodePdfNames(value: string): string {
  return value.replace(/#([\da-f]{2})/giu, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function rejectActivePdfContent(value: Uint8Array): void {
  const source = decodePdfNames(Buffer.from(value).toString('latin1'));
  if (FORBIDDEN_PDF_NAMES.some((name) => source.includes(name))) {
    throw new AppError('BAD_REQUEST', 400, 'PDF_ACTIVE_CONTENT_NOT_ALLOWED');
  }
}

function rejectParsedActivePdfContent(document: PDFDocument): void {
  const visited = new Set<object>();
  const visit = (object: unknown): void => {
    if (!object || typeof object !== 'object' || visited.has(object)) return;
    visited.add(object);
    if (object instanceof PDFName) {
      if (FORBIDDEN_PARSED_PDF_NAMES.has(object.decodeText())) {
        throw new AppError('BAD_REQUEST', 400, 'PDF_ACTIVE_CONTENT_NOT_ALLOWED');
      }
      return;
    }
    if (object instanceof PDFRef) {
      visit(document.context.lookup(object));
      return;
    }
    if (object instanceof PDFStream) {
      visit(object.dict);
      return;
    }
    if (object instanceof PDFDict) {
      for (const [key, value] of object.entries()) {
        visit(key);
        visit(value);
      }
      return;
    }
    if (object instanceof PDFArray) {
      for (const value of object.asArray()) visit(value);
    }
  };

  for (const [, object] of document.context.enumerateIndirectObjects()) visit(object);
  visit(document.catalog);
}

export async function validateSourcePdf(
  value: Uint8Array,
  env: Env = getEnv(),
): Promise<ValidatedSourcePdf> {
  if (value.byteLength > env.SIGNATURE_MAX_PDF_BYTES) {
    throw new AppError('BAD_REQUEST', 400, 'PDF_TOO_LARGE');
  }
  if (
    value.byteLength < PDF_HEADER.length ||
    !Buffer.from(value).subarray(0, 5).equals(PDF_HEADER)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_PDF');
  }
  const eofWindow = Buffer.from(value).subarray(Math.max(0, value.byteLength - 2048));
  if (eofWindow.lastIndexOf(PDF_EOF) < 0) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_PDF');
  }

  rejectActivePdfContent(value);

  try {
    const document = await PDFDocument.load(value, {
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    if (document.isEncrypted) {
      throw new AppError('BAD_REQUEST', 400, 'ENCRYPTED_PDF_NOT_ALLOWED');
    }
    rejectParsedActivePdfContent(document);
    const pageCount = document.getPageCount();
    if (pageCount < 1) {
      throw new AppError('BAD_REQUEST', 400, 'PDF_HAS_NO_PAGES');
    }
    if (pageCount > env.SIGNATURE_MAX_PDF_PAGES) {
      throw new AppError('BAD_REQUEST', 400, 'PDF_TOO_MANY_PAGES');
    }
    return { byteLength: value.byteLength, pageCount, sha256: sha256(value) };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('BAD_REQUEST', 400, 'INVALID_PDF');
  }
}

function certificateText(value: string, font?: PDFFont): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (character === '\n' || (codePoint >= 0x20 && codePoint <= 0x7e)) return character;
      if (font) {
        try {
          font.encodeText(character);
          return character;
        } catch {
          // Preserve unsupported code points as a reversible ASCII escape.
        }
      }
      return `\\u{${codePoint.toString(16).toUpperCase()}}`;
    })
    .join('');
}

function wrapText(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of certificateText(value, font).replace(/\r/g, '').split('\n')) {
    const words = paragraph.split(/\s+/u).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        line = word;
        continue;
      }
      let chunk = '';
      for (const character of word) {
        if (font.widthOfTextAtSize(`${chunk}${character}`, size) > maxWidth && chunk) {
          lines.push(chunk);
          chunk = character;
        } else {
          chunk += character;
        }
      }
      line = chunk;
    }
    if (line) lines.push(line);
  }
  return lines;
}

interface CertificateWriter {
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
  y: number;
}

function drawLines(
  writer: CertificateWriter,
  value: string,
  options: {
    x: number;
    width: number;
    size?: number;
    bold?: boolean;
    color?: ReturnType<typeof rgb>;
  },
): void {
  const size = options.size ?? 8.5;
  const font = options.bold ? writer.bold : writer.regular;
  const lines = wrapText(value, font, size, options.width);
  const lineHeight = size + 2.5;
  if (writer.y - lines.length * lineHeight < 38) {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_RECEIPT_CONTENT_TOO_LONG');
  }
  for (const line of lines) {
    writer.page.drawText(line, {
      x: options.x,
      y: writer.y,
      size,
      font,
      color: options.color ?? rgb(0.12, 0.15, 0.2),
    });
    writer.y -= lineHeight;
  }
}

function drawField(writer: CertificateWriter, label: string, value: string): void {
  drawLines(writer, label, { x: 42, width: 112, bold: true });
  const labelBottom = writer.y;
  writer.y += 11;
  drawLines(writer, value, { x: 158, width: 395 });
  writer.y = Math.min(labelBottom, writer.y) - 2;
}

function drawCertificatePage(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  data: ReceiptCertificateData,
): void {
  const writer: CertificateWriter = { page, regular, bold, y: 794 };
  drawLines(writer, 'UnlikeOtherAI Authenticated Agreement Evidence', {
    x: 42,
    width: 510,
    size: 17,
    bold: true,
    color: rgb(0.05, 0.19, 0.35),
  });
  writer.y -= 3;
  drawLines(
    writer,
    'Service-generated record of an authenticated agreement action. This is not a qualified electronic signature, notarisation, trusted timestamp, or independent identity verification.',
    { x: 42, width: 510, size: 8, color: rgb(0.34, 0.38, 0.44) },
  );
  writer.y -= 8;
  page.drawLine({
    start: { x: 42, y: writer.y },
    end: { x: 553, y: writer.y },
    thickness: 0.75,
    color: rgb(0.72, 0.76, 0.81),
  });
  writer.y -= 15;

  drawField(writer, 'Agreement', data.agreementTitle);
  drawField(writer, 'Agreement ID', data.agreementId);
  drawField(writer, 'Version', `${data.version} (${data.agreementVersionId})`);
  drawField(writer, 'Domain', data.domain);
  drawField(writer, 'Signer', data.signerName);
  drawField(writer, 'Signer email', data.signerEmail);
  drawField(
    writer,
    'Signing method',
    data.signingMethod === 'TYPED_NAME' ? 'Typed name' : 'Click-wrap',
  );
  if (data.typedName) drawField(writer, 'Typed name', data.typedName);
  drawField(writer, 'Signed at (UTC)', data.signedAt.toISOString());
  drawField(
    writer,
    'Authentication',
    `${data.authMethod}; 2FA completed: ${data.twoFaCompleted ? 'yes' : 'no'}`,
  );
  drawField(writer, 'Source PDF SHA-256', data.sourcePdfSha256);
  drawField(writer, 'Evidence SHA-256', data.evidenceManifestSha256);
  drawField(writer, 'Verification reference', data.verificationReference);
  drawField(writer, 'Verification URL', data.verificationUrl);

  writer.y -= 3;
  drawLines(writer, 'Acceptance statement', { x: 42, width: 510, bold: true });
  drawLines(writer, data.acceptanceStatement, { x: 42, width: 510 });

  page.drawText(`Signature record ${certificateText(data.signatureId, regular)}`, {
    x: 42,
    y: 22,
    size: 7,
    font: regular,
    color: rgb(0.42, 0.45, 0.5),
  });
}

export async function buildSignatureReceiptPdf(
  sourcePdf: Uint8Array,
  data: ReceiptCertificateData,
): Promise<Buffer> {
  await validateSourcePdf(sourcePdf);
  const source = await PDFDocument.load(sourcePdf, { updateMetadata: false });
  const receipt = await PDFDocument.create();
  receipt.setTitle(`Agreement evidence - ${certificateText(data.agreementTitle)}`);
  receipt.setSubject('Authenticated agreement evidence receipt');
  receipt.setProducer('UnlikeOtherAI Authenticator');
  receipt.setCreator('UnlikeOtherAI Authenticator');
  // pdf-lib otherwise stamps wall-clock creation/modification times. Pin both to
  // the immutable server acceptance time so a crash retry recreates byte-identical
  // evidence for the claimed intent and can safely converge on its create-only key.
  receipt.setCreationDate(data.signedAt);
  receipt.setModificationDate(data.signedAt);
  const copiedPages = await receipt.copyPages(source, source.getPageIndices());
  for (const page of copiedPages) receipt.addPage(page);

  const regular = await receipt.embedFont(StandardFonts.Helvetica);
  const bold = await receipt.embedFont(StandardFonts.HelveticaBold);
  const certificate = receipt.addPage([595.28, 841.89]);
  drawCertificatePage(certificate, regular, bold, data);

  return Buffer.from(await receipt.save({ useObjectStreams: false }));
}

export function hashPdf(value: Uint8Array): string {
  return sha256(value);
}
