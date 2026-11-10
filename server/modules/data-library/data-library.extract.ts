import { Parser } from 'htmlparser2';
import JSZip from 'jszip';
import type { DataLibraryFormat, DataLibrarySection } from '../../../shared/data-library.interface';
import { DataLibraryError } from './data-library.fetch';
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 200_000;
export interface ExtractedDocument { rawContent: string; text: string; sections: DataLibrarySection[]; state: 'ready' | 'needs-text' }
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').replace(/[ \t]+/gu, ' ').trim();
function result(sections: DataLibrarySection[], raw?: string): ExtractedDocument {
  let remaining = MAX_TEXT;
  const bounded = sections.flatMap(section => {
    if (remaining <= 0) return [];
    const text = clean(section.text).slice(0, remaining); remaining -= text.length;
    return text ? [{ ...section, text }] : [];
  }).slice(0, 1000);
  const text = bounded.map(s => s.text).join('\n\n').slice(0, MAX_TEXT);
  return { rawContent: (raw ?? text).slice(0, MAX_TEXT), text, sections: bounded, state: text ? 'ready' : 'needs-text' };
}
export function textDocument(text: string): ExtractedDocument {
  return result(text.split(/\n\s*\n/u).map((text, i) => ({ locator: `paragraph:${i + 1}`, text })), text);
}
export function extractHtml(input: string): ExtractedDocument {
  let hidden = 0, paragraph = '', password = false;
  const parts: DataLibrarySection[] = [];
  const hiddenTags = new Set(['script', 'style', 'noscript', 'svg', 'form', 'template', 'nav', 'footer']);
  const stack: boolean[] = [];
  const flush = () => { if (clean(paragraph)) parts.push({ locator: `paragraph:${parts.length + 1}`, text: paragraph }); paragraph = ''; };
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === 'input' && attrs.type?.toLowerCase() === 'password') password = true;
      const blocked = hiddenTags.has(name) || attrs.hidden !== undefined || attrs['aria-hidden'] === 'true';
      stack.push(blocked); if (blocked) hidden++;
      if (!hidden && /^(p|div|article|section|h[1-6]|li|br|tr)$/u.test(name)) flush();
    },
    ontext(text) { if (!hidden && paragraph.length < MAX_TEXT) paragraph += text; },
    onclosetag(name) { if (stack.pop()) hidden--; if (!hidden && /^(p|div|article|section|h[1-6]|li|tr)$/u.test(name)) flush(); },
  }, { decodeEntities: true });
  parser.write(input); parser.end(); flush();
  if (password) throw new DataLibraryError('NEEDS_AUTH');
  if (!parts.length) throw new DataLibraryError('NO_CONTENT');
  // HTML scripts/forms can contain login tokens. Store the faithfully extracted original text, never executable HTML.
  return result(parts);
}
export function extractRss(input: string): ExtractedDocument {
  if (/<!DOCTYPE|<!ENTITY/iu.test(input)) throw new DataLibraryError('UNSAFE_XML');
  let item = false, text = '', title = '', field = '', index = 0;
  const parts: DataLibrarySection[] = [];
  const parser = new Parser({
    onopentag(name) {
      if (name === 'item' || name === 'entry') { item = true; text = ''; title = ''; }
      if (item && ['title', 'description', 'summary', 'content', 'content:encoded'].includes(name)) field = name;
    },
    ontext(value) { if (item && field) { if (field === 'title') title += value; else text += value; } },
    onclosetag(name) {
      if (name === field) field = '';
      if (name === 'item' || name === 'entry') {
        if (index < 200) {
          let body = text;
          if (/<[a-z][\s\S]*>/iu.test(body)) { try { body = extractHtml(body).text; } catch { body = ''; } }
          parts.push({ locator: `entry:${++index}`, title: clean(title).slice(0, 300), text: `${title}\n${body}` });
        }
        item = false;
      }
    },
  }, { xmlMode: true, decodeEntities: true });
  parser.write(input); parser.end();
  if (!parts.length) throw new DataLibraryError('NO_CONTENT');
  return result(parts);
}
export function extractJson(input: string): ExtractedDocument {
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { throw new DataLibraryError('INVALID_JSON'); }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const object = parsed as Record<string, unknown>;
    const authMessage = [object.error, object.message, object.detail].map(value => typeof value === 'string' ? value : '').join(' ');
    if ([401, 403, '401', '403'].includes(object.status as string | number)
      || /unauthoriz|unauthenticat|authentication required|login required|sign.in required|未登录|请.{0,12}登录|登录.{0,12}失效|认证失败/iu.test(authMessage)) {
      throw new DataLibraryError('NEEDS_AUTH');
    }
  }
  const sections: DataLibrarySection[] = [];
  const walk = (value: unknown, path: string, depth: number) => {
    if (depth > 8 || sections.length >= 500) return;
    if (typeof value === 'string' || typeof value === 'number') sections.push({ locator: path, text: String(value).slice(0, 10_000) });
    else if (Array.isArray(value)) value.slice(0, 100).forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
    else if (value && typeof value === 'object') Object.entries(value).slice(0, 100).forEach(([key, v]) => {
      if (!/token|secret|password|authorization|cookie|session|api.?key/iu.test(key)) walk(v, `${path}.${key}`, depth + 1);
    });
  };
  walk(parsed, '$', 0);
  if (!sections.length) throw new DataLibraryError('NO_CONTENT');
  return result(sections);
}
function guardZip(buffer: Buffer) {
  // Validate the central directory sizes before any decompression (JSZip alone does not enforce a byte budget).
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new DataLibraryError('INVALID_PPTX');
  const entries = buffer.readUInt16LE(end + 10), size = buffer.readUInt32LE(end + 12);
  let pos = buffer.readUInt32LE(end + 16), total = 0;
  if (entries > 2000 || pos + size > end) throw new DataLibraryError('ARCHIVE_TOO_LARGE');
  for (let i = 0; i < entries; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) throw new DataLibraryError('INVALID_PPTX');
    const packed = buffer.readUInt32LE(pos + 20), unpacked = buffer.readUInt32LE(pos + 24);
    total += unpacked;
    if (unpacked > 8 * 1024 * 1024 || total > 32 * 1024 * 1024 || unpacked > Math.max(1, packed) * 250) throw new DataLibraryError('ARCHIVE_TOO_LARGE');
    const nameLen = buffer.readUInt16LE(pos + 28);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLen).toString();
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) throw new DataLibraryError('UNSAFE_ARCHIVE_PATH');
    pos += 46 + nameLen + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
  }
}
export async function extractPptx(buffer: Buffer): Promise<ExtractedDocument> {
  guardZip(buffer);
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(buffer); } catch { throw new DataLibraryError('INVALID_PPTX'); }
  let files = Object.values(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/u.test(f.name))
    .sort((a, b) => Number(a.name.match(/\d+/u)![0]) - Number(b.name.match(/\d+/u)![0]));
  if (!files.length || files.length > 200) throw new DataLibraryError('INVALID_PPTX');
  let totalBytes = 0;
  const readXml = (file: JSZip.JSZipObject): Promise<string> => new Promise((resolve, reject) => {
    const stream = file.nodeStream('nodebuffer') as import('node:stream').Readable, chunks: Buffer[] = []; let bytes = 0;
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length; totalBytes += chunk.length;
      if (bytes > 2 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024) {
        stream.destroy(); reject(new DataLibraryError('ARCHIVE_TOO_LARGE'));
      } else chunks.push(chunk);
    });
    stream.on('error', () => reject(new DataLibraryError('INVALID_PPTX')));
    stream.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (/<!DOCTYPE|<!ENTITY/iu.test(text)) reject(new DataLibraryError('UNSAFE_XML')); else resolve(text);
    });
  });
  const presentation = zip.file('ppt/presentation.xml'), relationships = zip.file('ppt/_rels/presentation.xml.rels');
  if (presentation && relationships) {
    const relationshipIds = new Map<string, string>(), order: string[] = [];
    const relParser = new Parser({ onopentag(name, attributes) {
      if (name === 'Relationship' && attributes.TargetMode !== 'External' && /^slides\/slide\d+\.xml$/u.test(attributes.Target ?? '')) {
        relationshipIds.set(attributes.Id, `ppt/${attributes.Target}`);
      }
    } }, { xmlMode: true });
    relParser.end(await readXml(relationships));
    const orderParser = new Parser({ onopentag(name, attributes) { if (name === 'p:sldId') {
      const path = relationshipIds.get(attributes['r:id']); if (path) order.push(path);
    } } }, { xmlMode: true });
    orderParser.end(await readXml(presentation));
    if (order.length) files = order.map(path => zip.file(path)).filter((file): file is JSZip.JSZipObject => Boolean(file));
  }
  const sections: DataLibrarySection[] = [];
  for (const [i, file] of files.entries()) {
    const xml = await readXml(file);
    if (xml.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new DataLibraryError('UNSAFE_XML');
    let withinText = false, text = '';
    const parser = new Parser({ onopentag(name) { if (name === 'a:t') withinText = true; },
      ontext(value) { if (withinText) text += value; }, onclosetag(name) { if (name === 'a:t') { withinText = false; text += '\n'; } },
    }, { xmlMode: true, decodeEntities: true });
    parser.write(xml); parser.end();
    sections.push({ locator: `slide:${i + 1}`, title: `Slide ${i + 1}`, text });
  }
  return result(sections);
}
export async function extractDocument(format: DataLibraryFormat, buffer: Buffer, description = ''): Promise<ExtractedDocument> {
  if (buffer.length > MAX_FILE_BYTES) throw new DataLibraryError('FILE_TOO_LARGE');
  if (format === 'image') return { ...textDocument(description), state: 'needs-text' };
  if (format === 'pptx') return extractPptx(buffer);
  const text = buffer.toString('utf8');
  if (format === 'html') return extractHtml(text);
  if (format === 'rss') return extractRss(text);
  if (format === 'json') return extractJson(text);
  return textDocument(text);
}
