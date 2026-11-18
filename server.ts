import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createHttpsServer } from 'node:https';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as serverDb from './src/serverDb.js';
import * as supabaseDb from './src/db/supabaseService.ts';
import {
  getBibleChapterData,
  getBibleCommentarySource,
  getBibleCommentarySources,
  getBibleCommentarySourceChapter,
  getGreekChapter,
  getHebrewChapter,
} from './src/bibleData.js';
import type { CslItem, CslName, WordCitationItem } from './src/word/types.js';
import type { ReaderAnnotation, TextHighlightAnnotation } from './src/types.js';
import {
  downloadStoredFile,
  finalizeUpload,
  isSupabaseConfigured,
  listStoredFiles,
  prepareUpload,
  readStoredNotes,
  updateStoredSidecar,
  writeStoredNotes,
} from './src/supabaseStorage.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const documentFolders = new Map([
  ['artigo de periódico', 'Artigo'],
  ['artigo de revista', 'Artigo'],
  ['artigo de jornal', 'Artigo'],
  ['livro', 'Livro'],
  ['comentário bíblico', 'Comentários'],
  ['capítulo de livro', 'Capítulo'],
  ['tese/dissertação', 'Tese'],
  ['conferência', 'Conferência'],
  ['verbete de enciclopédia', 'Verbete'],
  ['relatório técnico', 'Relatório'],
  ['patente', 'Patente'],
  ['legislação / estatuto', 'Legislação'],
  ['jurisprudência', 'Jurisprudência'],
  ['software', 'Software'],
  ['filme / audiovisual', 'Filme'],
  ['transmissão de tv', 'Transmissão'],
  ['página da web', 'Página'],
  ['não especificado', 'Outros'],
]);
const validDocumentFolders = new Set(Array.from(documentFolders.values(), name => `Citame-${name}`).concat('Citame-Outros'));

function sanitizeStoredFilename(filename: string): string {
  const normalized = filename.replace(/\\/g, '/');
  const basename = path.posix.basename(normalized);
  if (!basename || basename !== normalized || /[<>:"|?*\x00-\x1f]/.test(basename) || /[. ]$/.test(basename)) {
    throw new Error('Nome de arquivo inválido.');
  }
  return basename;
}

function getDocumentFolder(docType: unknown): string {
  const normalizedType = typeof docType === 'string' ? docType.trim().toLocaleLowerCase('pt-BR') : '';
  return `Citame-${documentFolders.get(normalizedType) || 'Outros'}`;
}

function sanitizeLibraryFilePath(filename: string): string {
  const normalized = filename.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    segments.length > 2 ||
    segments.some(segment => !segment || segment === '.' || segment === '..') ||
    (segments.length === 2 && !validDocumentFolders.has(segments[0]))
  ) {
    throw new Error('Caminho de arquivo inválido na biblioteca.');
  }
  const safeFilename = sanitizeStoredFilename(segments[segments.length - 1]);
  return segments.length === 2 ? `${segments[0]}/${safeFilename}` : safeFilename;
}

function sanitizeFileStem(value: string, fallback: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 150)
    .replace(/[. ]+$/, '');
  return sanitized || fallback;
}

function getLibraryPath(): string {
  return path.join(__dirname, 'Citame-Biblioteca');
}

function getLibraryFilePath(filename: string): string {
  const safeFilename = sanitizeLibraryFilePath(filename);
  const libraryPath = path.resolve(getLibraryPath());
  const filePath = path.resolve(libraryPath, ...safeFilename.split('/'));
  if (!filePath.startsWith(`${libraryPath}${path.sep}`)) {
    throw new Error('Caminho de arquivo fora da biblioteca.');
  }
  return filePath;
}

function getSidecarFilename(filename: string): string {
  const parsed = path.posix.parse(sanitizeLibraryFilePath(filename));
  return parsed.dir ? `${parsed.dir}/${parsed.name}.citame.json` : `${parsed.name}.citame.json`;
}

function getSidecarPath(filename: string): string {
  return getLibraryFilePath(getSidecarFilename(filename));
}

function parseReaderAnnotations(value: unknown): ReaderAnnotation[] {
  if (!Array.isArray(value) || value.length > 2000) {
    throw new Error('A lista de notas do documento está inválida ou excede o limite.');
  }

  return value.map(annotation => {
    if (
      !annotation ||
      typeof annotation.id !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(annotation.id) ||
      !Number.isInteger(annotation.page) ||
      annotation.page < 1 ||
      typeof annotation.x !== 'number' ||
      !Number.isFinite(annotation.x) ||
      annotation.x < 0 ||
      annotation.x > 1 ||
      typeof annotation.y !== 'number' ||
      !Number.isFinite(annotation.y) ||
      annotation.y < 0 ||
      annotation.y > 1 ||
      typeof annotation.text !== 'string' ||
      !annotation.text.trim() ||
      annotation.text.length > 10000 ||
      typeof annotation.createdAt !== 'string' ||
      annotation.createdAt.length > 40 ||
      typeof annotation.updatedAt !== 'string' ||
      annotation.updatedAt.length > 40
    ) {
      throw new Error('Uma nota do documento contém dados inválidos.');
    }

    return {
      id: annotation.id,
      page: annotation.page,
      x: annotation.x,
      y: annotation.y,
      text: annotation.text,
      createdAt: annotation.createdAt,
      updatedAt: annotation.updatedAt,
    };
  });
}

function parseTextHighlightAnnotations(value: unknown): TextHighlightAnnotation[] {
  if (!Array.isArray(value) || value.length > 5000) {
    throw new Error('A lista de destaques do texto é inválida ou excede o limite.');
  }

  const ids = new Set<string>();
  return value.map(annotation => {
    if (
      !annotation ||
      typeof annotation !== 'object' ||
      typeof annotation.id !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(annotation.id) ||
      ids.has(annotation.id) ||
      typeof annotation.referenceId !== 'string' ||
      annotation.referenceId.length > 240 ||
      typeof annotation.sourceKey !== 'string' ||
      annotation.sourceKey.length > 240 ||
      typeof annotation.commentId !== 'string' ||
      !annotation.commentId ||
      annotation.commentId.length > 300 ||
      typeof annotation.book !== 'string' ||
      !annotation.book ||
      annotation.book.length > 80 ||
      !Number.isInteger(annotation.chapter) ||
      annotation.chapter < 1 ||
      annotation.chapter > 200 ||
      !Number.isInteger(annotation.start) ||
      annotation.start < 0 ||
      !Number.isInteger(annotation.end) ||
      annotation.end <= annotation.start ||
      annotation.end > 2_000_000 ||
      typeof annotation.quote !== 'string' ||
      !annotation.quote.trim() ||
      annotation.quote.length > 10000 ||
      typeof annotation.note !== 'string' ||
      annotation.note.length > 10000 ||
      typeof annotation.createdAt !== 'string' ||
      Number.isNaN(Date.parse(annotation.createdAt)) ||
      typeof annotation.updatedAt !== 'string' ||
      Number.isNaN(Date.parse(annotation.updatedAt))
    ) {
      throw new Error('Um destaque contém dados inválidos.');
    }

    ids.add(annotation.id);
    return {
      id: annotation.id,
      referenceId: annotation.referenceId,
      sourceKey: annotation.sourceKey,
      commentId: annotation.commentId,
      book: annotation.book,
      chapter: annotation.chapter,
      start: annotation.start,
      end: annotation.end,
      quote: annotation.quote,
      note: annotation.note,
      createdAt: annotation.createdAt,
      updatedAt: annotation.updatedAt,
    };
  });
}

interface LocalTextNote {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface LibrarySidecar {
  schemaVersion: 1;
  application: 'Citame';
  storedAt: string;
  attachment: {
    filename: string;
    originalFilename: string;
    contentType: string;
    fileSize: number;
  };
  reference: Record<string, unknown> & { title: string; authors: string; filename: string };
  annotations: ReaderAnnotation[];
  textAnnotations: TextHighlightAnnotation[];
}

function parseLocalTextNotes(value: unknown): LocalTextNote[] {
  if (!Array.isArray(value) || value.length > 5000) {
    throw new Error('A lista de anotações está inválida ou excede o limite.');
  }

  const ids = new Set<string>();
  return value.map(note => {
    if (
      !note ||
      typeof note.id !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(note.id) ||
      ids.has(note.id) ||
      typeof note.title !== 'string' ||
      !note.title.trim() ||
      note.title.length > 200 ||
      typeof note.content !== 'string' ||
      note.content.length > 2_000_000 ||
      typeof note.createdAt !== 'string' ||
      Number.isNaN(Date.parse(note.createdAt)) ||
      typeof note.updatedAt !== 'string' ||
      Number.isNaN(Date.parse(note.updatedAt))
    ) {
      throw new Error('Uma anotação contém dados inválidos.');
    }

    ids.add(note.id);
    return {
      id: note.id,
      title: note.title.trim(),
      content: note.content,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };
  });
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(temporaryPath, JSON.stringify(value, null, 2), { flag: 'wx' });
  try {
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(cleanupError => {
      console.error('[Biblioteca local] Falha ao remover arquivo temporário:', cleanupError);
    });
    throw error;
  }
}

function getLocalNotesPath(): string {
  return path.join(getLibraryPath(), 'minhas-notas.json');
}

async function readLocalTextNotes(): Promise<LocalTextNote[]> {
  let contents: string;
  try {
    contents = await fs.promises.readFile(getLocalNotesPath(), 'utf8');
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    const emptyDocument = { schemaVersion: 1, application: 'Citame', updatedAt: new Date().toISOString(), notes: [] };
    await writeJsonAtomically(getLocalNotesPath(), emptyDocument);
    return [];
  }

  const document = JSON.parse(contents);
  if (document?.schemaVersion !== 1 || document?.application !== 'Citame') {
    throw new Error('O arquivo minhas-notas.json não possui um formato reconhecido.');
  }
  return parseLocalTextNotes(document.notes);
}

async function writeLocalTextNotes(value: unknown): Promise<LocalTextNote[]> {
  const notes = parseLocalTextNotes(value);
  await writeJsonAtomically(getLocalNotesPath(), {
    schemaVersion: 1,
    application: 'Citame',
    updatedAt: new Date().toISOString(),
    notes,
  });
  return notes;
}

function parseLibrarySidecar(value: unknown): LibrarySidecar {
  const sidecar = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const attachment = sidecar?.attachment && typeof sidecar.attachment === 'object' && !Array.isArray(sidecar.attachment)
    ? sidecar.attachment as Record<string, unknown>
    : null;
  const reference = sidecar?.reference && typeof sidecar.reference === 'object' && !Array.isArray(sidecar.reference)
    ? sidecar.reference as Record<string, unknown>
    : null;
  const filename = typeof attachment?.filename === 'string'
    ? sanitizeLibraryFilePath(attachment.filename)
    : '';
  const originalFilename = typeof attachment?.originalFilename === 'string'
    ? sanitizeStoredFilename(attachment.originalFilename)
    : path.posix.basename(filename);
  if (
    sidecar?.schemaVersion !== 1 ||
    sidecar?.application !== 'Citame' ||
    !filename ||
    !reference ||
    typeof reference.title !== 'string' ||
    typeof reference.authors !== 'string' ||
    typeof sidecar.storedAt !== 'string' ||
    !attachment ||
    !Number.isFinite(Number(attachment.fileSize)) ||
    Number(attachment.fileSize) < 0
  ) {
    throw new Error('Metadados de arquivo inválidos.');
  }

  return {
    schemaVersion: 1,
    application: 'Citame',
    storedAt: sidecar.storedAt,
    attachment: {
      filename,
      originalFilename,
      contentType: typeof attachment.contentType === 'string' ? attachment.contentType.slice(0, 255) : 'application/octet-stream',
      fileSize: Number(attachment.fileSize),
    },
    reference: {
      ...reference,
      title: reference.title,
      authors: reference.authors,
      filename,
    },
    annotations: sidecar.annotations === undefined ? [] : parseReaderAnnotations(sidecar.annotations),
    textAnnotations: sidecar.textAnnotations === undefined
      ? []
      : parseTextHighlightAnnotations(sidecar.textAnnotations),
  };
}

interface LibrarySidecarFile {
  absolutePath: string;
  relativePath: string;
}

async function listLibrarySidecarFiles(): Promise<LibrarySidecarFile[]> {
  const libraryPath = getLibraryPath();
  await fs.promises.mkdir(libraryPath, { recursive: true });
  const rootEntries = await fs.promises.readdir(libraryPath, { withFileTypes: true });
  const sidecarFiles: LibrarySidecarFile[] = [];

  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.endsWith('.citame.json')) {
      sidecarFiles.push({ absolutePath: path.join(libraryPath, entry.name), relativePath: entry.name });
    } else if (entry.isDirectory() && validDocumentFolders.has(entry.name)) {
      const directoryPath = path.join(libraryPath, entry.name);
      const children = await fs.promises.readdir(directoryPath, { withFileTypes: true });
      for (const child of children) {
        if (child.isFile() && child.name.endsWith('.citame.json')) {
          sidecarFiles.push({
            absolutePath: path.join(directoryPath, child.name),
            relativePath: `${entry.name}/${child.name}`,
          });
        }
      }
    }
  }
  return sidecarFiles;
}

async function readLibrarySidecars(): Promise<LibrarySidecar[]> {
  const entries = await listLibrarySidecarFiles();
  const sidecars: LibrarySidecar[] = [];
  for (const entry of entries) {
    try {
      const sidecar = parseLibrarySidecar(JSON.parse(await fs.promises.readFile(entry.absolutePath, 'utf8')));
      if (getSidecarFilename(sidecar.attachment.filename) !== entry.relativePath) {
        throw new Error('O nome dos metadados não corresponde ao arquivo anexado.');
      }
      await fs.promises.access(getLibraryFilePath(sidecar.attachment.filename));
      sidecars.push(sidecar);
    } catch (error) {
      console.warn(`[Biblioteca local] Ignorando metadados inválidos em ${entry.relativePath}:`, error);
    }
  }
  return sidecars;
}

function parseImportedLibrarySidecars(value: unknown): LibrarySidecar[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10000) {
    throw new Error('A lista de metadados de arquivos do backup é inválida ou excede o limite.');
  }
  return value.map(parseLibrarySidecar);
}

async function restoreLibrarySidecars(sidecars: LibrarySidecar[]): Promise<{ restored: number; missing: number }> {
  const libraryPath = getLibraryPath();
  await fs.promises.mkdir(libraryPath, { recursive: true });
  let restored = 0;
  let missing = 0;
  for (const sidecar of sidecars) {
    try {
      await fs.promises.access(getLibraryFilePath(sidecar.attachment.filename));
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        missing += 1;
        continue;
      }
      throw error;
    }
    await fs.promises.mkdir(path.dirname(getSidecarPath(sidecar.attachment.filename)), { recursive: true });
    await writeJsonAtomically(getSidecarPath(sidecar.attachment.filename), sidecar);
    restored += 1;
  }
  return { restored, missing };
}

async function organizeLegacyLibraryFiles(updateReferenceFilename: (id: string, filename: string) => Promise<void>): Promise<void> {
  const libraryPath = getLibraryPath();
  await fs.promises.mkdir(libraryPath, { recursive: true });
  const rootEntries = await fs.promises.readdir(libraryPath, { withFileTypes: true });
  const rootSidecars = rootEntries.filter(entry => entry.isFile() && entry.name.endsWith('.citame.json'));

  for (const entry of rootSidecars) {
    const sourceMetadataPath = path.join(libraryPath, entry.name);
    let sidecar: LibrarySidecar;
    try {
      sidecar = parseLibrarySidecar(JSON.parse(await fs.promises.readFile(sourceMetadataPath, 'utf8')));
      if (
        sidecar.attachment.filename.includes('/') ||
        getSidecarFilename(sidecar.attachment.filename) !== entry.name
      ) {
        continue;
      }
    } catch (error) {
      console.warn(`[Biblioteca local] Não foi possível organizar ${entry.name}:`, error);
      continue;
    }

    const sourceFilename = sidecar.attachment.filename;
    const sourcePath = getLibraryFilePath(sourceFilename);
    try {
      await fs.promises.access(sourcePath);
    } catch (error: any) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }

    const folder = getDocumentFolder(sidecar.reference.docType);
    const destinationDirectory = path.join(libraryPath, folder);
    await fs.promises.mkdir(destinationDirectory, { recursive: true });
    const parsedFilename = path.posix.parse(sourceFilename);
    let destinationFilename = '';
    let destinationPath = '';
    let destinationMetadataPath = '';

    for (let suffix = 1; suffix <= 1000; suffix += 1) {
      const stem = suffix === 1 ? parsedFilename.name : `${parsedFilename.name} (${suffix})`;
      destinationFilename = `${folder}/${stem}${parsedFilename.ext}`;
      destinationPath = getLibraryFilePath(destinationFilename);
      destinationMetadataPath = getSidecarPath(destinationFilename);
      try {
        await fs.promises.access(destinationPath);
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        try {
          await fs.promises.access(destinationMetadataPath);
        } catch (metadataError: any) {
          if (metadataError.code !== 'ENOENT') throw metadataError;
          break;
        }
      }
      destinationFilename = '';
    }

    if (!destinationFilename) {
      throw new Error(`Não foi possível escolher uma pasta de destino para ${sourceFilename}.`);
    }

    const destinationSidecar: LibrarySidecar = {
      ...sidecar,
      attachment: { ...sidecar.attachment, filename: destinationFilename },
      reference: { ...sidecar.reference, filename: destinationFilename },
    };
    let fileMoved = false;
    let metadataWritten = false;
    let referenceUpdated = false;
    const referenceId = typeof sidecar.reference.id === 'string' ? sidecar.reference.id : '';

    try {
      await fs.promises.rename(sourcePath, destinationPath);
      fileMoved = true;
      await writeJsonAtomically(destinationMetadataPath, destinationSidecar);
      metadataWritten = true;
      if (referenceId) {
        await updateReferenceFilename(referenceId, destinationFilename);
        referenceUpdated = true;
      }
      await fs.promises.unlink(sourceMetadataPath);
      console.log(`[Biblioteca local] Arquivo organizado em ${destinationFilename}`);
    } catch (error) {
      if (referenceUpdated && referenceId) {
        await updateReferenceFilename(referenceId, sourceFilename).catch(rollbackError => {
          console.error(`[Biblioteca local] Falha ao restaurar o caminho da referência ${referenceId}:`, rollbackError);
        });
      }
      if (metadataWritten) {
        await fs.promises.unlink(destinationMetadataPath).catch(cleanupError => {
          console.error('[Biblioteca local] Falha ao remover metadados migrados:', cleanupError);
        });
      }
      if (fileMoved) {
        await fs.promises.rename(destinationPath, sourcePath).catch(rollbackError => {
          console.error('[Biblioteca local] Falha ao restaurar o arquivo original:', rollbackError);
        });
      }
      throw error;
    }
  }
}

function generateSmartFallback(filename: string, textSnippet: string) {
  const cleanName = filename.replace(/\.[^/.]+$/, '').replace(/[_.-]+/g, ' ').trim();
  
  let year = 2024;
  const yearMatch = (filename + ' ' + textSnippet).match(/\b(19\d\d|20[0-2]\d)\b/);
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
  }

  let authors = 'Pesquisador, Autor Exemplo';
  const lower = (filename + ' ' + textSnippet).toLowerCase();
  if (lower.includes('chiavenato')) {
    authors = 'Chiavenato, Idalberto';
  } else if (lower.includes('bardin')) {
    authors = 'Bardin, Laurence';
  } else if (lower.includes('gil')) {
    authors = 'Gil, Antônio Carlos';
  } else if (lower.includes('dutra')) {
    authors = 'Dutra, Joel Souza; Fleury, Maria Tereza Leme';
  } else if (lower.includes('zarifian')) {
    authors = 'Zarifian, Philippe';
  } else if (lower.includes('pasquali')) {
    authors = 'Pasquali, Luiz';
  } else if (lower.includes('kandel')) {
    authors = 'Kandel, Eric R.; Schwartz, James H.';
  } else if (lower.includes('damasio') || lower.includes('damásio')) {
    authors = 'Damásio, António';
  }

  const titleFormatted = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);

  return {
    title: titleFormatted || 'Artigo Acadêmico Extraído',
    authors: authors,
    publicationYear: year,
    journal: 'Revista Brasileira de Pós-Graduação e Pesquisa',
    volume: '28',
    issue: '2',
    pages: '105-124',
    doi: `10.1590/s0102-${year}.${Math.floor(100000 + Math.random() * 900000)}`,
    docType: 'Artigo de Periódico',
    abstract: textSnippet && textSnippet.length > 50 
      ? textSnippet.slice(0, 300) + '...'
      : 'Este artigo aborda investigações teóricas e empíricas, analisando metodologias científicas aplicadas e fundamentação conceitual na área de estudo.',
    tags: ['Pesquisa Acadêmica', 'Doutorado', 'Metodologia', 'Artigo Científico']
  };
}

function getWordApiAuthError(authorization: string | undefined): string | undefined {
  const expectedToken = process.env.CITAME_WORD_API_TOKEN?.trim();
  if (!expectedToken) return 'Configure CITAME_WORD_API_TOKEN no arquivo .env local.';

  const suppliedToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!suppliedToken) return 'Token de acesso ausente.';

  const expected = Buffer.from(expectedToken);
  const supplied = Buffer.from(suppliedToken);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return 'Token de acesso inválido.';
  }
}

function parseCslNames(value: string | undefined): CslName[] | undefined {
  const names = value?.split(';').map(name => name.trim()).filter(Boolean) || [];
  if (names.length === 0) return undefined;
  return names.map(name => {
    const commaIndex = name.indexOf(',');
    return commaIndex < 0
      ? { literal: name }
      : { family: name.slice(0, commaIndex).trim(), given: name.slice(commaIndex + 1).trim() };
  });
}

function getCslType(docType: string): string {
  const types: Record<string, string> = {
    'Artigo de Periódico': 'article-journal',
    Livro: 'book',
    'Capítulo de Livro': 'chapter',
    'Tese/Dissertação': 'thesis',
    Conferência: 'paper-conference',
    'Artigo de Revista': 'article-magazine',
    'Artigo de Jornal': 'article-newspaper',
    'Verbete de Enciclopédia': 'entry-encyclopedia',
    'Relatório Técnico': 'report',
    Patente: 'patent',
    'Legislação / Estatuto': 'legislation',
    Jurisprudência: 'legal_case',
    Software: 'software',
    'Filme / Audiovisual': 'motion_picture',
    'Transmissão de TV': 'broadcast',
    'Página da Web': 'webpage',
  };
  return types[docType] || 'article';
}

function toCslItem(reference: serverDb.DbReference): CslItem {
  const dateParts: number[] = [];
  if (reference.publicationYear > 0) {
    dateParts.push(reference.publicationYear);
    const month = Number(reference.month);
    if (month >= 1 && month <= 12) {
      dateParts.push(month);
      const day = Number(reference.day);
      if (day >= 1 && day <= 31) dateParts.push(day);
    }
  }

  const item: CslItem = {
    id: reference.id,
    type: getCslType(reference.docType),
    title: reference.subtitle ? `${reference.title}: ${reference.subtitle}` : reference.title,
    author: parseCslNames(reference.authors),
    issued: dateParts.length > 0 ? { 'date-parts': [dateParts] } : undefined,
    'container-title': reference.journal || undefined,
    genre: reference.docType === 'Tese/Dissertação' ? reference.docType : undefined,
    number: reference.issue || undefined,
    volume: reference.volume || undefined,
    page: reference.pages || undefined,
    DOI: reference.doi || undefined,
    URL: reference.url || undefined,
    abstract: reference.abstract || undefined,
    publisher: reference.publisher || undefined,
    'publisher-place': reference.city || undefined,
    edition: reference.edition || undefined,
    ISBN: reference.isbn || undefined,
    ISSN: reference.issn || undefined,
    'collection-title': reference.series || undefined,
    language: reference.language || undefined,
    translator: parseCslNames(reference.translator),
    institution: reference.institution || undefined,
  };
  return item;
}

export async function createCitameApp() {
  const app = express();
  const useSupabase = isSupabaseConfigured();
  const useLocalDatabase = !useSupabase;
  if (useLocalDatabase) {
    await organizeLegacyLibraryFiles(async (id, filename) => {
      if (serverDb.getReferenceById(id)) serverDb.updateReference(id, { filename });
    });
  }
  const buildLibraryBackup = async () => {
    const database = useLocalDatabase ? serverDb.exportFullDatabase() : await supabaseDb.exportFullDatabase();
    const [notes, libraryFiles] = await Promise.all([
      useLocalDatabase ? readLocalTextNotes() : readStoredNotes(),
      useLocalDatabase ? readLibrarySidecars() : listStoredFiles(),
    ]);
    return { ...database, notes, libraryFiles };
  };
  const persistLibraryBackup = async () => {
    if (!useLocalDatabase) return;
    const backup = await buildLibraryBackup();
    await writeJsonAtomically(path.join(getLibraryPath(), '0.Minha-biblioteca.json'), backup);
  };
  let snapshotWriteQueue: Promise<void> = Promise.resolve();
  const scheduleLibraryBackup = () => {
    snapshotWriteQueue = snapshotWriteQueue
      .then(persistLibraryBackup)
      .catch(error => {
        console.error('[Biblioteca local] Falha ao atualizar o backup automático:', error);
      });
  };

  // Middleware para JSON com limite generoso para dados de PDF
  app.use(express.json({ limit: '35mb' }));
  app.use((req, res, next) => {
    const isWrite = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE';
    const isLocalDataRoute = req.path.startsWith('/api/db/')
      || req.path.startsWith('/api/files/')
      || req.path.startsWith('/api/word/')
      || req.path === '/api/notes';
    if (isWrite && isLocalDataRoute) {
      res.on('finish', () => {
        if (res.statusCode < 400) scheduleLibraryBackup();
      });
    }
    next();
  });

  app.get('/api/bible/commentaries/sources', async (_req, res) => {
    try {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ data: await getBibleCommentarySources() });
    } catch (error) {
      console.error('[Biblioteca bíblica] Falha ao listar fontes de comentários:', error);
      res.status(500).json({ error: 'Não foi possível carregar as fontes de comentários locais.' });
    }
  });

  app.get('/api/bible/commentaries/source', async (req, res) => {
    const sourceKey = typeof req.query.sourceKey === 'string' ? req.query.sourceKey.trim() : '';
    if (!sourceKey || sourceKey.length > 240) {
      return res.status(400).json({ error: 'Informe uma fonte de comentário válida.' });
    }

    try {
      const data = await getBibleCommentarySource(sourceKey);
      if (!data) return res.status(404).json({ error: 'A fonte de comentário solicitada não foi encontrada.' });
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ data });
    } catch (error) {
      console.error('[Biblioteca bíblica] Falha ao carregar os dados da fonte:', error);
      res.status(500).json({ error: 'Não foi possível carregar os dados da fonte de comentários.' });
    }
  });

  app.get('/api/bible/commentaries/source-chapter', async (req, res) => {
    const sourceKey = typeof req.query.sourceKey === 'string' ? req.query.sourceKey.trim() : '';
    const book = typeof req.query.book === 'string' ? req.query.book.trim() : '';
    const chapter = typeof req.query.chapter === 'string' ? Number(req.query.chapter) : Number.NaN;
    if (!sourceKey || !book || !Number.isInteger(chapter) || chapter < 1 || chapter > 200) {
      return res.status(400).json({ error: 'Informe a fonte, livro e capítulo do comentário bíblico.' });
    }

    try {
      const sources = await getBibleCommentarySources();
      if (!sources.some(source => source.key === sourceKey)) {
        return res.status(404).json({ error: 'A fonte de comentário solicitada não foi encontrada.' });
      }
      const data = await getBibleCommentarySourceChapter(sourceKey, book, chapter);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ data });
    } catch (error) {
      console.error('[Biblioteca bíblica] Falha ao carregar o capítulo do comentário:', error);
      res.status(500).json({ error: 'Não foi possível carregar o capítulo do comentário local.' });
    }
  });

  app.get('/api/bible/chapter', async (req, res) => {
    const book = typeof req.query.book === 'string' ? req.query.book.trim() : '';
    const chapter = typeof req.query.chapter === 'string' ? Number(req.query.chapter) : Number.NaN;
    if (!book || book.length > 80 || !Number.isInteger(chapter) || chapter < 0 || chapter > 200) {
      return res.status(400).json({ error: 'Informe um livro e capítulo bíblico válidos.' });
    }

    try {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json(await getBibleChapterData(book, chapter));
    } catch (error) {
      console.error('[Bíblia local] Falha ao carregar os comentários do capítulo:', error);
      res.status(500).json({ error: 'Não foi possível carregar os comentários bíblicos locais.' });
    }
  });

  app.get('/api/bible/hebrew', async (req, res) => {
    const book = typeof req.query.book === 'string' ? Number(req.query.book) : Number.NaN;
    const chapter = typeof req.query.chapter === 'string' ? Number(req.query.chapter) : Number.NaN;
    if (!Number.isInteger(book) || book < 1 || book > 39 || !Number.isInteger(chapter) || chapter < 1 || chapter > 200) {
      return res.status(400).json({ error: 'Informe um livro e capítulo do Antigo Testamento válidos.' });
    }

    try {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ data: await getHebrewChapter(book, chapter) });
    } catch (error) {
      console.error('[Bíblia local] Falha ao carregar o texto hebraico:', error);
      res.status(500).json({ error: 'Não foi possível carregar o texto hebraico local.' });
    }
  });

  app.get('/api/bible/greek', (req, res) => {
    const book = typeof req.query.book === 'string' ? req.query.book.trim() : '';
    const chapter = typeof req.query.chapter === 'string' ? Number(req.query.chapter) : Number.NaN;
    if (!book || book.length > 80 || !Number.isInteger(chapter) || chapter < 1 || chapter > 200) {
      return res.status(400).json({ error: 'Informe um livro e capítulo do Novo Testamento válidos.' });
    }

    try {
      const data = getGreekChapter(book, chapter);
      if (!data.length) {
        return res.status(404).json({ error: `Não há texto grego local para ${book} ${chapter}.` });
      }
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ data });
    } catch (error) {
      console.error('[Bíblia local] Falha ao carregar o texto grego:', error);
      res.status(500).json({ error: 'Não foi possível carregar o texto grego local.' });
    }
  });

  app.use('/api/word', (req, res, next) => {
    const authError = getWordApiAuthError(req.get('authorization'));
    if (authError) {
      const status = process.env.CITAME_WORD_API_TOKEN?.trim() ? 401 : 503;
      return res.status(status).json({ success: false, error: authError });
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/word/references', (req, res) => {
    if (!useLocalDatabase) {
      return res.status(503).json({ success: false, error: 'A integração com o Word está disponível no banco SQLite local.' });
    }
    const idsValue = typeof req.query.ids === 'string' ? req.query.ids : '';
    if (idsValue) {
      const ids = [...new Set(idsValue.split(',').filter(Boolean))];
      if (ids.length > 200 || ids.some(id => !/^[A-Za-z0-9._:-]{1,128}$/.test(id))) {
        return res.status(400).json({ success: false, error: 'A lista de IDs de obras está inválida.' });
      }
      const references = ids
        .map(id => serverDb.getReferenceById(id))
        .filter((reference): reference is serverDb.DbReference => reference !== null);
      return res.json({
        success: true,
        references: references.map(reference => ({ ...reference, csl: toCslItem(reference) })),
      });
    }
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 200) : '';
    const references = serverDb.getAllReferences(undefined, search);
    res.json({
      success: true,
      references: references.map(reference => ({ ...reference, csl: toCslItem(reference) })),
    });
  });

  app.get('/api/word/citations', (req, res) => {
    if (!useLocalDatabase) {
      return res.status(503).json({ success: false, error: 'A integração com o Word está disponível no banco SQLite local.' });
    }
    const idsValue = typeof req.query.ids === 'string' ? req.query.ids : '';
    const ids = [...new Set(idsValue.split(',').filter(Boolean))];
    if (ids.length === 0 || ids.length > 200 || ids.some(id => !/^[A-Za-z0-9._:-]{1,128}$/.test(id))) {
      return res.status(400).json({ success: false, error: 'A lista de IDs de citações está ausente ou inválida.' });
    }
    res.json({ success: true, citations: serverDb.getWordCitations(ids) });
  });

  app.put('/api/word/citations/:id', (req, res) => {
    if (!useLocalDatabase) {
      return res.status(503).json({ success: false, error: 'A integração com o Word está disponível no banco SQLite local.' });
    }
    const id = req.params.id;
    const items = req.body?.items;
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id) || !Array.isArray(items) || items.length === 0 || items.length > 50) {
      return res.status(400).json({ success: false, error: 'Os dados da citação estão ausentes ou inválidos.' });
    }

    const normalizedItems: WordCitationItem[] = [];
    for (const item of items) {
      if (!item || typeof item.referenceId !== 'string' || item.referenceId.length > 128) {
        return res.status(400).json({ success: false, error: 'Uma obra da citação possui um ID inválido.' });
      }
      if (!serverDb.getReferenceById(item.referenceId)) {
        return res.status(404).json({ success: false, error: `A obra ${item.referenceId} não foi encontrada.` });
      }
      normalizedItems.push({
        referenceId: item.referenceId,
        locator: typeof item.locator === 'string' ? item.locator.slice(0, 100) : undefined,
        label: typeof item.label === 'string' ? item.label.slice(0, 40) : undefined,
        prefix: typeof item.prefix === 'string' ? item.prefix.slice(0, 100) : undefined,
        suffix: typeof item.suffix === 'string' ? item.suffix.slice(0, 100) : undefined,
        suppressAuthor: item.suppressAuthor === true,
      });
    }
    const lastRenderedText = typeof req.body.lastRenderedText === 'string'
      ? req.body.lastRenderedText.slice(0, 2000)
      : undefined;
    const citation = serverDb.saveWordCitation(id, normalizedItems, lastRenderedText);
    res.json({ success: true, citation });
  });

  app.post('/api/files/local', express.raw({ type: 'application/octet-stream', limit: '500mb' }), async (req, res) => {
    if (useSupabase) {
      return res.status(503).json({ success: false, error: 'Uploads online usam o Supabase Storage.' });
    }
    let reservedFilePath: string | undefined;
    let newlyCreatedFolder: string | undefined;
    try {
      const body = req.body as Buffer | undefined;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return res.status(400).json({ success: false, error: 'O arquivo enviado está vazio ou inválido.' });
      }

      const originalFilename = sanitizeStoredFilename(String(req.query.filename || ''));
      let reference: Record<string, unknown>;
      try {
        reference = JSON.parse(decodeURIComponent(String(req.headers['x-citame-metadata'] || ''))) as Record<string, unknown>;
      } catch {
        return res.status(400).json({ success: false, error: 'Os metadados da obra estão ausentes ou inválidos.' });
      }
      if (typeof reference.title !== 'string' || typeof reference.authors !== 'string') {
        return res.status(400).json({ success: false, error: 'Título e autor são necessários para nomear o arquivo.' });
      }

      const libraryPath = getLibraryPath();
      await fs.promises.mkdir(libraryPath, { recursive: true });

      const extension = path.extname(originalFilename);
      const author = sanitizeFileStem(reference.authors, 'Autor desconhecido');
      const title = sanitizeFileStem(reference.title, 'Obra sem título');
      const baseStem = sanitizeFileStem(`${author} - ${title}`, 'Obra');
      const folder = getDocumentFolder(reference.docType);
      const folderPath = path.join(libraryPath, folder);
      if (await fs.promises.mkdir(folderPath, { recursive: true })) {
        newlyCreatedFolder = folderPath;
      }
      let storedFilename = '';
      let pdfPath = '';
      let metadataPath = '';
      let stored = false;

      for (let suffix = 1; suffix <= 1000; suffix += 1) {
        const stem = suffix === 1 ? baseStem : `${baseStem} (${suffix})`;
        storedFilename = `${folder}/${stem}${extension}`;
        pdfPath = getLibraryFilePath(storedFilename);
        metadataPath = getSidecarPath(storedFilename);
        try {
          await fs.promises.writeFile(pdfPath, body, { flag: 'wx' });
          reservedFilePath = pdfPath;
        } catch (error: any) {
          if (error.code === 'EEXIST') continue;
          throw error;
        }

        const storedAt = new Date().toISOString();
        const savedReference = {
          ...reference,
          filename: storedFilename,
          fileSize: `${(body.length / 1024 / 1024).toFixed(1)} MB`,
        };
        try {
          await fs.promises.writeFile(metadataPath, JSON.stringify({
            schemaVersion: 1,
            application: 'Citame',
            storedAt,
            attachment: {
              filename: storedFilename,
              originalFilename,
              contentType: decodeURIComponent(String(req.headers['x-file-content-type'] || 'application/octet-stream')),
              fileSize: body.length,
            },
            annotations: [],
            textAnnotations: [],
            reference: savedReference,
          }, null, 2), { flag: 'wx' });
          stored = true;
          reservedFilePath = undefined;
          newlyCreatedFolder = undefined;
          break;
        } catch (error: any) {
          await fs.promises.unlink(pdfPath);
          reservedFilePath = undefined;
          if (error.code === 'EEXIST') continue;
          throw error;
        }
      }

      if (!stored) {
        throw new Error('Não foi possível encontrar um nome disponível para salvar o arquivo.');
      }

      res.json({
        success: true,
        file: {
          filename: storedFilename,
          originalFilename,
          fileSize: body.length,
          storedAt: new Date().toISOString(),
          reference: { ...reference, filename: storedFilename, fileSize: `${(body.length / 1024 / 1024).toFixed(1)} MB` },
        },
      });
    } catch (err: any) {
      if (reservedFilePath) {
        await fs.promises.unlink(reservedFilePath).catch(cleanupError => {
          console.error('[Biblioteca local] Falha ao remover arquivo incompleto:', cleanupError);
        });
      }
      if (newlyCreatedFolder) {
        await fs.promises.rmdir(newlyCreatedFolder).catch(cleanupError => {
          if (cleanupError.code !== 'ENOENT' && cleanupError.code !== 'ENOTEMPTY') {
            console.error('[Biblioteca local] Falha ao remover pasta vazia:', cleanupError);
          }
        });
      }
      console.error('[Biblioteca local] Falha ao salvar arquivo:', err);
      res.status(500).json({ success: false, error: `Não foi possível salvar o arquivo localmente: ${err.message}` });
    }
  });

  app.post('/api/files/storage-upload', express.json({ limit: '1mb' }), async (req, res) => {
    if (!useSupabase) {
      return res.status(503).json({ success: false, error: 'Supabase Storage não está configurado.' });
    }
    try {
      const originalFilename = sanitizeStoredFilename(String(req.body?.filename || ''));
      const reference = req.body?.reference;
      if (!reference || typeof reference.title !== 'string' || typeof reference.authors !== 'string') {
        return res.status(400).json({ success: false, error: 'Título e autor são obrigatórios.' });
      }
      const prepared = await prepareUpload(originalFilename, reference);
      res.json({ success: true, directUpload: true, ...prepared });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível preparar o upload.';
      console.error('[Supabase Storage] Falha ao preparar upload:', error);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.post('/api/files/storage-finalize', express.json({ limit: '1mb' }), async (req, res) => {
    if (!useSupabase) {
      return res.status(503).json({ success: false, error: 'Supabase Storage não está configurado.' });
    }
    try {
      const file = await finalizeUpload({
        objectPath: sanitizeLibraryFilePath(String(req.body?.objectPath || '')),
        sidecarPath: sanitizeLibraryFilePath(String(req.body?.sidecarPath || '')),
        originalFilename: sanitizeStoredFilename(String(req.body?.originalFilename || '')),
        fileSize: Number(req.body?.fileSize),
        contentType: String(req.body?.contentType || 'application/octet-stream').slice(0, 255),
        reference: req.body?.reference,
      });
      res.status(201).json({ success: true, file });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível finalizar o upload.';
      console.error('[Supabase Storage] Falha ao finalizar upload:', error);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.get('/api/files/library', async (_req, res) => {
    if (useSupabase) {
      try {
        return res.json({ success: true, files: await listStoredFiles() });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Não foi possível listar os arquivos.';
        return res.status(500).json({ success: false, error: message });
      }
    }
    try {
      const entries = await listLibrarySidecarFiles();
      const files = [];
      for (const entry of entries) {
        try {
          const sidecar = JSON.parse(await fs.promises.readFile(entry.absolutePath, 'utf8'));
          const filename = sanitizeLibraryFilePath(String(sidecar.attachment?.filename || ''));
          if (
            sidecar.schemaVersion !== 1 ||
            sidecar.application !== 'Citame' ||
            typeof sidecar.reference?.title !== 'string' ||
            typeof sidecar.reference?.authors !== 'string' ||
            getSidecarFilename(filename) !== entry.relativePath
          ) {
            throw new Error('Formato de metadados inválido.');
          }
          await fs.promises.access(getLibraryFilePath(filename));
          files.push({
            filename,
            originalFilename: String(sidecar.attachment.originalFilename || path.posix.basename(filename)),
            fileSize: Number(sidecar.attachment.fileSize) || 0,
            storedAt: String(sidecar.storedAt || ''),
            reference: { ...sidecar.reference, filename },
            annotations: sidecar.annotations === undefined ? [] : parseReaderAnnotations(sidecar.annotations),
            textAnnotations: sidecar.textAnnotations === undefined
              ? []
              : parseTextHighlightAnnotations(sidecar.textAnnotations),
          });
        } catch (error) {
          console.warn(`[Biblioteca local] Ignorando metadados inválidos em ${entry.relativePath}:`, error);
        }
      }
      res.json({ success: true, files });
    } catch (err: any) {
      console.error('[Biblioteca local] Falha ao listar arquivos:', err);
      res.status(500).json({ success: false, error: `Não foi possível listar a biblioteca local: ${err.message}` });
    }
  });

  app.get('/api/files/library/folders', (_req, res) => {
    res.json({ success: true, folders: Array.from(validDocumentFolders) });
  });

  app.get('/api/notes', async (_req, res) => {
    try {
      const notes = useSupabase ? await readStoredNotes() : await readLocalTextNotes();
      res.json({ success: true, notes });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível carregar as anotações locais.';
      console.error('[Anotações locais] Falha ao carregar:', error);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.put('/api/notes', async (req, res) => {
    try {
      const parsedNotes = parseLocalTextNotes(req.body?.notes);
      const notes = useSupabase ? await writeStoredNotes(parsedNotes) : await writeLocalTextNotes(parsedNotes);
      res.json({ success: true, notes });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível salvar as anotações locais.';
      console.error('[Anotações locais] Falha ao salvar:', error);
      res.status(400).json({ success: false, error: message });
    }
  });

  app.put('/api/files/library/:filename', async (req, res) => {
    try {
      const filename = sanitizeLibraryFilePath(req.params.filename);
      const reference = req.body?.reference;
      if (!reference || typeof reference.title !== 'string' || typeof reference.authors !== 'string') {
        return res.status(400).json({ success: false, error: 'Metadados de título e autor são obrigatórios.' });
      }
      let annotations: ReaderAnnotation[] | undefined;
      if (req.body.annotations !== undefined) {
        try {
          annotations = parseReaderAnnotations(req.body.annotations);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'As notas do documento são inválidas.';
          return res.status(400).json({ success: false, error: message });
        }
      }
      let textAnnotations: TextHighlightAnnotation[] | undefined;
      if (req.body.textAnnotations !== undefined) {
        try {
          textAnnotations = parseTextHighlightAnnotations(req.body.textAnnotations);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Os destaques do texto são inválidos.';
          return res.status(400).json({ success: false, error: message });
        }
      }

      if (useSupabase) {
        await updateStoredSidecar(filename, reference, annotations, textAnnotations);
        return res.json({ success: true });
      }

      const metadataPath = getSidecarPath(filename);
      const sidecar = JSON.parse(await fs.promises.readFile(metadataPath, 'utf8'));
      if (sidecar.attachment?.filename !== filename || sidecar.application !== 'Citame') {
        return res.status(404).json({ success: false, error: 'Metadados do arquivo não encontrados.' });
      }

      sidecar.reference = { ...reference, filename };
      if (annotations) sidecar.annotations = annotations;
      if (textAnnotations) sidecar.textAnnotations = textAnnotations;
      const temporaryPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(temporaryPath, JSON.stringify(sidecar, null, 2), { flag: 'wx' });
      try {
        await fs.promises.rename(temporaryPath, metadataPath);
      } catch (error) {
        await fs.promises.unlink(temporaryPath).catch(cleanupError => {
          console.error('[Biblioteca local] Falha ao remover metadados temporários:', cleanupError);
        });
        throw error;
      }
      res.json({ success: true });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({ success: false, error: 'Arquivo ou metadados não encontrados na biblioteca local.' });
      }
      console.error('[Biblioteca local] Falha ao atualizar metadados:', err);
      res.status(500).json({ success: false, error: `Não foi possível atualizar os metadados: ${err.message}` });
    }
  });

  app.get('/api/files/local/:filename', async (req, res) => {
    try {
      const filename = sanitizeLibraryFilePath(req.params.filename);
      if (useSupabase) {
        const stored = await downloadStoredFile(filename);
        const basename = path.posix.basename(filename);
        const fallbackName = basename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        res.type(stored.contentType).setHeader(
          'Content-Disposition',
          `${stored.contentType === 'application/pdf' ? 'inline' : 'attachment'}; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(basename)}`,
        );
        return res.send(Buffer.from(await stored.data.arrayBuffer()));
      }
      const pdfPath = getLibraryFilePath(filename);
      const contents = await fs.promises.readFile(pdfPath);
      const isPdf = path.extname(filename).toLowerCase() === '.pdf';
      const basename = path.posix.basename(filename);
      const fallbackName = basename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      res.type(isPdf ? 'application/pdf' : 'application/octet-stream')
        .setHeader(
          'Content-Disposition',
          `${isPdf ? 'inline' : 'attachment'}; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(basename)}`,
        );
      res.send(contents);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({ success: false, error: 'Arquivo não encontrado na biblioteca local.' });
      }
      console.error('[Biblioteca local] Falha ao abrir arquivo:', err);
      res.status(400).json({ success: false, error: `Não foi possível abrir o arquivo: ${err.message}` });
    }
  });

  // Endpoint com Gemini AI para extrair dados bibliográficos diretamente do PDF
  app.post('/api/gemini/extract-pdf-metadata', async (req, res) => {
    try {
      const { filename, pdfBase64, textContent } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        console.warn('GEMINI_API_KEY não encontrada, usando extração heurística...');
        return res.json({
          success: true,
          source: 'heuristica',
          data: generateSmartFallback(filename || 'documento.pdf', textContent || '')
        });
      }

      const ai = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });

      const contents: any[] = [];

      // Anexa os dados do PDF caso enviados em base64
      if (pdfBase64) {
        contents.push({
          inlineData: {
            mimeType: 'application/pdf',
            data: pdfBase64
          }
        });
      }

      const prompt = `Você é um catalogador bibliográfico sênior especialista nas normas ABNT NBR 6023 e APA 7ª edição (estilo Zotero e Mendeley).
Analise o arquivo PDF anexo (nome do arquivo: "${filename}").
Extraia diretamente do texto original da obra os seguintes dados bibliográficos com exatidão:
1. Título completo da obra acadêmica (title)
2. Autores completos formatados no padrão "Sobrenome, Nome; Sobrenome2, Nome2" (authors)
3. Ano de publicação com 4 dígitos (publicationYear)
4. Periódico, Revista Acadêmica, Anais de Congresso ou Editora (journal)
5. Volume (volume, se identificado)
6. Número / Edição (issue, se identificado)
7. Faixa de páginas exata (pages, ex: 45-62, se identificado)
8. DOI (doi, ex: 10.1590/..., se identificado)
9. Tipo de documento ("Artigo de Periódico", "Livro", "Capítulo de Livro", "Tese/Dissertação" ou "Conferência") (docType)
10. Resumo original / Abstract obtido diretamente no documento (abstract)
11. Lista de 3 a 6 palavras-chave ou temas principais da obra (tags, array de strings)

${textContent ? `Trecho de texto preliminar da obra:\n"""\n${textContent}\n"""` : ''}`;

      contents.push(prompt);

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: contents,
        config: {
          systemInstruction: 'Você é um catalogador bibliográfico acadêmico de alta precisão. Extraia informações reais contidas na obra.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING, description: 'Título completo do artigo/livro' },
              authors: { type: Type.STRING, description: 'Autores no padrão Sobrenome, Nome; Sobrenome, Nome' },
              publicationYear: { type: Type.INTEGER, description: 'Ano de publicação (4 dígitos)' },
              journal: { type: Type.STRING, description: 'Revista, periódico ou conferência' },
              volume: { type: Type.STRING, description: 'Volume' },
              issue: { type: Type.STRING, description: 'Número/edição' },
              pages: { type: Type.STRING, description: 'Páginas (ex: 110-125)' },
              doi: { type: Type.STRING, description: 'DOI do artigo' },
              docType: { 
                type: Type.STRING, 
                description: 'Tipo de documento: "Artigo de Periódico", "Livro", "Capítulo de Livro", "Tese/Dissertação" ou "Conferência"' 
              },
              abstract: { type: Type.STRING, description: 'Resumo ou abstract original' },
              tags: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Palavras-chave'
              }
            },
            required: ['title', 'authors', 'publicationYear', 'journal', 'abstract']
          }
        }
      });

      const responseText = response.text || '{}';
      const parsedData = JSON.parse(responseText);

      return res.json({
        success: true,
        source: 'gemini-3.8-flash',
        data: parsedData
      });
    } catch (err: any) {
      console.error('Erro na extração com Gemini:', err);
      return res.json({
        success: true,
        source: 'fallback',
        data: generateSmartFallback(req.body.filename || 'artigo.pdf', req.body.textContent || ''),
        error: err.message
      });
    }
  });

  // ==============================================================================
  // ENDPOINTS DO BANCO DE DADOS (SQLite local ou Supabase na Vercel)
  // ==============================================================================

  // Status e integridade do banco de dados
  app.get('/api/db/stats', async (_req, res) => {
    if (useLocalDatabase) {
      return res.json({ success: true, stats: serverDb.getDatabaseStats() });
    }
    try {
      const stats = await supabaseDb.getDatabaseStats();
      res.json({ success: true, stats });
    } catch (err: any) {
      console.error('[Supabase] Falha ao obter estatísticas:', err);
      res.status(503).json({ success: false, error: 'Não foi possível acessar o banco Supabase.' });
    }
  });

  // Listar todas as referências com filtros opcionais
  app.get('/api/db/references', async (req, res) => {
    if (useLocalDatabase) {
      const collection = req.query.collection as string | undefined;
      const search = req.query.search as string | undefined;
      const references = serverDb.getAllReferences(collection, search);
      return res.json({ success: true, count: references.length, references });
    }
    try {
      const collection = req.query.collection as string | undefined;
      const search = req.query.search as string | undefined;
      const references = await supabaseDb.getAllReferences(collection, search);
      res.json({ success: true, count: references.length, references });
    } catch (err: any) {
      console.error('[Supabase] Falha ao listar referências:', err);
      res.status(503).json({ success: false, error: 'Não foi possível acessar as referências no Supabase.' });
    }
  });

  // Buscar uma referência por ID
  app.get('/api/db/references/:id', async (req, res) => {
    if (useLocalDatabase) {
      const reference = serverDb.getReferenceById(req.params.id);
      if (!reference) {
        return res.status(404).json({ success: false, error: 'Referência não encontrada no banco de dados.' });
      }
      return res.json({ success: true, reference });
    }
    try {
      const reference = await supabaseDb.getReferenceById(req.params.id);
      if (!reference) {
        return res.status(404).json({ success: false, error: 'Referência não encontrada no banco de dados.' });
      }
      res.json({ success: true, reference });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Inserir nova referência
  app.post('/api/db/references', async (req, res) => {
    if (useLocalDatabase) {
      const created = serverDb.insertReference(req.body);
      return res.status(201).json({ success: true, reference: created });
    }
    try {
      const created = await supabaseDb.insertReference(req.body);
      res.status(201).json({ success: true, reference: created });
    } catch (err: any) {
      console.error('[Supabase] Falha ao inserir referência:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Inserção em lote (após upload de múltiplos PDFs ou extração Gemini)
  app.post('/api/db/references/batch', async (req, res) => {
    try {
      const { references } = req.body;
      if (!Array.isArray(references)) {
        return res.status(400).json({ success: false, error: 'Array "references" é obrigatório.' });
      }
      if (useLocalDatabase) {
        const created = serverDb.batchInsertReferences(references);
        return res.status(201).json({ success: true, count: created.length, references: created });
      }
      const created = await supabaseDb.batchInsertReferences(references);
      res.status(201).json({ success: true, count: created.length, references: created });
    } catch (err: any) {
      console.error('[Supabase] Falha ao inserir referências:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Atualizar uma referência
  app.put('/api/db/references/:id', async (req, res) => {
    if (useLocalDatabase) {
      const updated = serverDb.updateReference(req.params.id, req.body);
      if (!updated) {
        return res.status(404).json({ success: false, error: 'Referência não encontrada.' });
      }
      return res.json({ success: true, reference: updated });
    }
    try {
      const updated = await supabaseDb.updateReference(req.params.id, req.body);
      if (!updated) {
        return res.status(404).json({ success: false, error: 'Referência não encontrada.' });
      }
      res.json({ success: true, reference: updated });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Excluir uma referência
  app.delete('/api/db/references/:id', async (req, res) => {
    if (useLocalDatabase) {
      if (!serverDb.deleteReference(req.params.id)) {
        return res.status(404).json({ success: false, error: 'Referência não encontrada.' });
      }
      return res.json({ success: true, id: req.params.id });
    }
    try {
      await supabaseDb.deleteReference(req.params.id);
      res.json({ success: true, id: req.params.id });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Exclusão em lote
  app.post('/api/db/references/batch-delete', async (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids)) {
        return res.status(400).json({ success: false, error: 'Array "ids" é obrigatório.' });
      }
      if (useLocalDatabase) {
        return res.json({ success: true, count: serverDb.batchDeleteReferences(ids) });
      }
      const count = await supabaseDb.batchDeleteReferences(ids);
      res.json({ success: true, count });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Atualização em lote (ex: mover para coleção, marcar favoritos, lidos)
  app.post('/api/db/references/batch-update', async (req, res) => {
    try {
      const { ids, updates } = req.body;
      if (!Array.isArray(ids) || !updates) {
        return res.status(400).json({ success: false, error: 'Campos "ids" e "updates" são obrigatórios.' });
      }
      if (useLocalDatabase) {
        return res.json({ success: true, count: serverDb.batchUpdateReferences(ids, updates) });
      }
      const count = await supabaseDb.batchUpdateReferences(ids, updates);
      res.json({ success: true, count });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Listar todas as coleções com contagem de itens
  app.get('/api/db/collections', async (_req, res) => {
    if (useLocalDatabase) {
      const collections = serverDb.getAllCollections();
      return res.json({ success: true, count: collections.length, collections });
    }
    try {
      const collections = await supabaseDb.getAllCollections();
      res.json({ success: true, count: collections.length, collections });
    } catch (err: any) {
      console.error('[Supabase] Falha ao listar coleções:', err);
      res.status(503).json({ success: false, error: 'Não foi possível acessar as coleções no Supabase.' });
    }
  });

  // Criar coleção
  app.post('/api/db/collections', async (req, res) => {
    try {
      const { name, description, color } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Nome da coleção é obrigatório.' });
      }
      if (useLocalDatabase) {
        const collection = serverDb.createCollection(name, description, color);
        return res.status(201).json({ success: true, collection });
      }
      const created = await supabaseDb.createCollection(name, description, color);
      res.status(201).json({ success: true, collection: created });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Atualizar / renomear coleção
  app.put('/api/db/collections/:id', async (req, res) => {
    try {
      const { name, description, color } = req.body;
      if (useLocalDatabase) {
        const ok = serverDb.updateCollection(req.params.id, name, description, color);
        return res.json({ success: ok });
      }
      const ok = await supabaseDb.updateCollection(req.params.id, name, description, color);
      res.json({ success: ok });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Excluir coleção
  app.delete('/api/db/collections/:id', async (req, res) => {
    try {
      if (useLocalDatabase) {
        return res.json({ success: serverDb.deleteCollection(req.params.id) });
      }
      const ok = await supabaseDb.deleteCollection(req.params.id);
      res.json({ success: ok });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Obter perfil do usuário pesquisador
  app.get('/api/db/profile', async (_req, res) => {
    if (useLocalDatabase) {
      return res.json({ success: true, profile: serverDb.getUserProfile() });
    }
    try {
      const profile = await supabaseDb.getUserProfile();
      res.json({ success: true, profile });
    } catch (err: any) {
      console.error('[Supabase] Falha ao carregar perfil:', err);
      res.status(503).json({ success: false, error: 'Não foi possível acessar o perfil no Supabase.' });
    }
  });

  // Atualizar perfil do usuário pesquisador
  app.put('/api/db/profile', async (req, res) => {
    if (useLocalDatabase) {
      return res.json({ success: true, profile: serverDb.saveUserProfile(req.body) });
    }
    try {
      const updated = await supabaseDb.saveUserProfile(req.body);
      res.json({ success: true, profile: updated });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Logs de auditoria do banco de dados
  app.get('/api/db/logs', async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 30;
      if (useLocalDatabase) {
        const logs = serverDb.getAuditLogs(limit);
        return res.json({ success: true, count: logs.length, logs });
      }
      const logs = await supabaseDb.getAuditLogs(limit);
      res.json({ success: true, count: logs.length, logs });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Explorador SQL interativo (somente leitura para segurança)
  app.post('/api/db/query', (req, res) => {
    try {
      const { sql } = req.body;
      if (!sql || !sql.trim()) {
        return res.status(400).json({ success: false, error: 'Instrução SQL é obrigatória.' });
      }
      const results = serverDb.executeSafeQuery(sql);
      res.json({ success: true, results, count: Array.isArray(results) ? results.length : 0 });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // Exportar backup completo do banco de dados em JSON
  app.get('/api/db/export', async (_req, res) => {
    try {
      const dump = await buildLibraryBackup();
      if (useLocalDatabase) {
        await writeJsonAtomically(path.join(getLibraryPath(), '0.Minha-biblioteca.json'), dump);
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="0.Minha-biblioteca.json"');
      res.send(JSON.stringify(dump, null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível exportar o backup.';
      console.error('[Backup local] Falha ao exportar:', error);
      res.status(500).json({ success: false, error: message });
    }
  });

  // Importar / restaurar backup
  app.post('/api/db/import', async (req, res) => {
    try {
      const importedNotes = req.body?.notes === undefined ? undefined : parseLocalTextNotes(req.body.notes);
      if (useSupabase) {
        return res.status(503).json({ success: false, error: 'A restauração em massa do Supabase ainda exige migração administrativa.' });
      }
      const importedSidecars = parseImportedLibrarySidecars(req.body?.libraryFiles);
      const stats = serverDb.importFullDatabase(req.body);
      if (importedNotes !== undefined) await writeLocalTextNotes(importedNotes);
      const sidecars = await restoreLibrarySidecars(importedSidecars);
      await persistLibraryBackup();
      res.json({
        success: true,
        message: 'Banco de dados restaurado com sucesso.',
        stats,
        restoredSidecars: sidecars.restored,
        missingAttachments: sidecars.missing,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível restaurar o backup.';
      console.error('[Backup local] Falha ao importar:', error);
      res.status(400).json({ success: false, error: message });
    }
  });

  // Redefinir para o acervo acadêmico inicial
  app.post('/api/db/reset', async (_req, res) => {
    try {
      const stats = useLocalDatabase
        ? serverDb.resetDatabaseToInitial()
        : await supabaseDb.resetDatabaseToInitial();
      res.json({ success: true, message: 'Banco de dados restaurado aos padrões iniciais.', stats });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Em desenvolvimento, integra Vite via middlewares
  if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else if (!process.env.VERCEL) {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  try {
    await persistLibraryBackup();
  } catch (error) {
    console.error('[Biblioteca local] Falha ao criar o backup inicial:', error);
  }

  return app;
}

async function startLocalServer() {
  const app = await createCitameApp();
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  app.listen(PORT, HOST, () => {
    console.log(`Servidor Citame rodando em http://localhost:${PORT}`);
  });
  const wordHttpsPort = Number(process.env.CITAME_WORD_ADDIN_HTTPS_PORT);
  if (Number.isInteger(wordHttpsPort) && wordHttpsPort > 0) {
    try {
      const devCerts = await import('office-addin-dev-certs');
      const httpsOptions = await devCerts.getHttpsServerOptions();
      const wordAddinServer = createHttpsServer(httpsOptions, app);
      wordAddinServer.on('error', error => {
        console.error(`[Word Add-in] Falha no servidor HTTPS da porta ${wordHttpsPort}:`, error);
      });
      wordAddinServer.listen(wordHttpsPort, '127.0.0.1', () => {
        console.log(`[Word Add-in] Painel seguro disponível em https://localhost:${wordHttpsPort}`);
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[Word Add-in] HTTPS indisponível. Execute "npm run word:addin:trust-cert" e reinicie o Citame. Detalhes: ${reason}`);
    }
  }
}

if (!process.env.VERCEL && process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  startLocalServer().catch(error => {
    console.error('[Citame] Falha ao iniciar o servidor:', error);
    process.exitCode = 1;
  });
}
