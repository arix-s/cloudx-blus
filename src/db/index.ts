import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { decodeFileToken, getMimeTypeFromExt } from '../utils/token.js';
import { shortCodeToMessageId } from '../utils/shortCode.js';
import { getTelegramFileByMessageId } from '../services/telegram.js';

export interface StoredFile {
  id: string; // public random id (e.g., 'a82k3')
  original_filename: string;
  file_extension: string; // e.g. '.mp4'
  mime_type: string;
  file_size: number;
  telegram_chat_id: string;
  telegram_message_id: number;
  telegram_file_id: string;
  created_at: string;
}

function getDataDir(): string {
  if (process.env.VERCEL) {
    return '/tmp/data';
  }
  return path.resolve(process.cwd(), 'data');
}

function getDbFilePath(): string {
  const dir = getDataDir();
  return path.resolve(dir, 'db.json');
}

let pgPool: pg.Pool | null = null;

function getPgPool(): pg.Pool | null {
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
    if (!pgPool) {
      pgPool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
      });
    }
    return pgPool;
  }
  return null;
}

// File system fallback helper
function ensureLocalDbFile(): StoredFile[] {
  const dir = getDataDir();
  const dbFile = getDbFilePath();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify([]), 'utf-8');
    return [];
  }
  try {
    const raw = fs.readFileSync(dbFile, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading local db file:', err);
    return [];
  }
}

function saveLocalDbFile(files: StoredFile[]) {
  const dir = getDataDir();
  const dbFile = getDbFilePath();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(dbFile, JSON.stringify(files, null, 2), 'utf-8');
}

export async function initDb() {
  const pool = getPgPool();
  if (pool) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS telegram_files (
          id VARCHAR(64) PRIMARY KEY,
          original_filename TEXT NOT NULL,
          file_extension TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          file_size BIGINT NOT NULL,
          telegram_chat_id TEXT NOT NULL,
          telegram_message_id INT NOT NULL,
          telegram_file_id TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('PostgreSQL database initialized successfully.');
    } catch (err) {
      console.error('Failed to initialize PostgreSQL DB, falling back to local file DB:', err);
    }
  } else {
    ensureLocalDbFile();
    console.log('Local JSON database initialized at:', getDbFilePath());
  }
}

export async function saveFileRecord(record: StoredFile): Promise<StoredFile> {
  const pool = getPgPool();
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO telegram_files 
        (id, original_filename, file_extension, mime_type, file_size, telegram_chat_id, telegram_message_id, telegram_file_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          record.id,
          record.original_filename,
          record.file_extension,
          record.mime_type,
          record.file_size,
          record.telegram_chat_id,
          record.telegram_message_id,
          record.telegram_file_id,
          record.created_at
        ]
      );
      return record;
    } catch (err) {
      console.error('PostgreSQL save failed, using local file store:', err);
    }
  }

  const files = ensureLocalDbFile();
  files.unshift(record);
  saveLocalDbFile(files);
  return record;
}

export async function getFileById(id: string): Promise<StoredFile | null> {
  const cleanId = id.trim();
  const pool = getPgPool();
  if (pool) {
    try {
      const res = await pool.query(`SELECT * FROM telegram_files WHERE id = $1 LIMIT 1`, [cleanId]);
      if (res.rows.length > 0) {
        const row = res.rows[0];
        return {
          id: row.id,
          original_filename: row.original_filename,
          file_extension: row.file_extension,
          mime_type: row.mime_type,
          file_size: Number(row.file_size),
          telegram_chat_id: row.telegram_chat_id,
          telegram_message_id: Number(row.telegram_message_id),
          telegram_file_id: row.telegram_file_id,
          created_at: new Date(row.created_at).toISOString()
        };
      }
      return null;
    } catch (err) {
      console.error('PostgreSQL query failed, searching local DB:', err);
    }
  }

  const files = ensureLocalDbFile();
  const localMatch = files.find(f => f.id === cleanId);
  if (localMatch) {
    return localMatch;
  }

  // Fallback 1: Decode 6-character short code to Telegram messageId
  try {
    const msgId = shortCodeToMessageId(cleanId);
    if (msgId) {
      const tgFile = await getTelegramFileByMessageId(msgId);
      if (tgFile) {
        const ext = path.extname(tgFile.filename).toLowerCase() || '.bin';
        const record: StoredFile = {
          id: cleanId,
          original_filename: tgFile.filename,
          file_extension: ext,
          mime_type: tgFile.mimeType || getMimeTypeFromExt(ext),
          file_size: tgFile.fileSize || 0,
          telegram_chat_id: tgFile.chatId,
          telegram_message_id: msgId,
          telegram_file_id: tgFile.fileId,
          created_at: new Date().toISOString()
        };
        // Cache record locally
        saveFileRecord(record).catch(() => {});
        return record;
      }
    }
  } catch (err) {
    console.warn('Error resolving short code to Telegram message:', err);
  }

  // Fallback 2: Decode stateless file token
  try {
    const decoded = decodeFileToken(cleanId);
    if (decoded && decoded.tf) {
      const ext = path.extname(decoded.fn || '').toLowerCase() || '.bin';
      return {
        id: cleanId,
        original_filename: decoded.fn || 'file' + ext,
        file_extension: ext,
        mime_type: decoded.mt || getMimeTypeFromExt(ext),
        file_size: Number(decoded.sz) || 0,
        telegram_chat_id: decoded.ch || '-1003839994672',
        telegram_message_id: Number(decoded.ms) || 0,
        telegram_file_id: decoded.tf,
        created_at: new Date().toISOString()
      };
    }
  } catch (err) {
    // Ignore decode error
  }

  return null;
}

export async function getAllFiles(searchQuery?: string): Promise<StoredFile[]> {
  const pool = getPgPool();
  if (pool) {
    try {
      let query = `SELECT * FROM telegram_files ORDER BY created_at DESC`;
      let params: any[] = [];
      if (searchQuery && searchQuery.trim()) {
        query = `SELECT * FROM telegram_files WHERE LOWER(original_filename) LIKE $1 ORDER BY created_at DESC`;
        params = [`%${searchQuery.trim().toLowerCase()}%`];
      }
      const res = await pool.query(query, params);
      return res.rows.map(row => ({
        id: row.id,
        original_filename: row.original_filename,
        file_extension: row.file_extension,
        mime_type: row.mime_type,
        file_size: Number(row.file_size),
        telegram_chat_id: row.telegram_chat_id,
        telegram_message_id: Number(row.telegram_message_id),
        telegram_file_id: row.telegram_file_id,
        created_at: new Date(row.created_at).toISOString()
      }));
    } catch (err) {
      console.error('PostgreSQL getAllFiles failed, searching local DB:', err);
    }
  }

  let files = ensureLocalDbFile();
  if (searchQuery && searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    files = files.filter(f => f.original_filename.toLowerCase().includes(q));
  }
  return files;
}

export async function deleteFileRecord(id: string): Promise<boolean> {
  const cleanId = id.trim();
  const pool = getPgPool();
  if (pool) {
    try {
      const res = await pool.query(`DELETE FROM telegram_files WHERE id = $1`, [cleanId]);
      if (res.rowCount && res.rowCount > 0) {
        return true;
      }
    } catch (err) {
      console.error('PostgreSQL delete failed, deleting from local DB:', err);
    }
  }

  let files = ensureLocalDbFile();
  const initialLen = files.length;
  files = files.filter(f => f.id !== cleanId);
  if (files.length !== initialLen) {
    saveLocalDbFile(files);
    return true;
  }
  return false;
}
