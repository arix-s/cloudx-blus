import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

import { initDb, saveFileRecord, getFileById, getAllFiles, deleteFileRecord, StoredFile } from './db/index.js';
import { encodeFileToken } from './utils/token.js';
import { messageIdToShortCode } from './utils/shortCode.js';
import {
  uploadFileToTelegram,
  getTelegramFileUrl,
  deleteTelegramMessage,
  testTelegramConnection,
  saveTelegramCredentials,
  getTelegramCredentials
} from './services/telegram.js';

const app = express();

// Increase JSON/urlencoded body limits for large chunk metadata
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/favicon.ico', (req: Request, res: Response) => {
  const faviconPath = path.resolve(process.cwd(), 'public', 'favicon.svg');
  if (fs.existsSync(faviconPath)) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    return res.sendFile(faviconPath);
  }
  res.status(204).end();
});

// Get writable temporary folder for Vercel / local storage
function getWritableDir(sub: string): string {
  const baseDir = process.env.VERCEL ? path.join('/tmp', sub) : path.resolve(process.cwd(), 'data', sub);
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }
  return baseDir;
}

const tmpUploadsDir = getWritableDir('tmp');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tmpUploadsDir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + '-' + file.originalname);
  }
});

// No file size limit on multer - allow unlimited uploads
const upload = multer({
  storage: storage
});

// Chunk upload storage: use disk to avoid loading into memory
const chunkTmpDir = getWritableDir('tmp');
const chunkDiskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, chunkTmpDir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'chunk_' + unique + '-' + file.originalname);
  }
});
const uploadChunk = multer({
  storage: chunkDiskStorage
});

// Initialize database
await initDb();

function generatePublicId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

function getFileExtensionAndName(originalName: string): { extension: string; safeName: string } {
  const ext = path.extname(originalName).toLowerCase() || '.bin';
  const baseName = path.basename(originalName, ext);
  const safeBaseName = baseName.replace(/[^\w\s\u0600-\u06FF\.-]/g, '_') || 'file';
  return {
    extension: ext,
    safeName: `${safeBaseName}${ext}`
  };
}

/**
 * Generates ETag from file record for caching
 */
function generateETag(fileRecord: StoredFile): string {
  return `"${fileRecord.id}-${fileRecord.file_size}-${new Date(fileRecord.created_at).getTime()}"`;
}

/**
 * Sets common caching headers for served files
 */
function setCacheHeaders(res: Response, fileRecord: StoredFile) {
  const etag = generateETag(fileRecord);
  // Files are immutable once uploaded (content doesn't change) - cache aggressively
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('ETag', etag);
  // Set Last-Modified
  res.setHeader('Last-Modified', new Date(fileRecord.created_at).toUTCString());
}

/**
 * Check if client already has a fresh cached copy (304 Not Modified)
 */
function checkFreshCache(req: Request, res: Response, fileRecord: StoredFile): boolean {
  const etag = generateETag(fileRecord);
  const ifNoneMatch = req.headers['if-none-match'];
  const ifModifiedSince = req.headers['if-modified-since'];

  if (ifNoneMatch && ifNoneMatch === etag) {
    res.status(304).end();
    return true;
  }

  if (ifModifiedSince) {
    const clientDate = new Date(ifModifiedSince).getTime();
    const fileDate = new Date(fileRecord.created_at).getTime();
    if (fileDate <= clientDate) {
      res.status(304).end();
      return true;
    }
  }

  return false;
}

function renderOpenGraphPreviewHtml(fileRecord: StoredFile, fileWithExt: string, reqHost: string, protocol: string): string {
  const fullRawUrl = `${protocol}://${reqHost}/f/${fileWithExt}?raw=1`;
  const fullDownloadUrl = `${protocol}://${reqHost}/f/${fileWithExt}?download=1`;
  const isImage = fileRecord.mime_type.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(fileRecord.file_extension.toLowerCase());
  const isVideo = fileRecord.mime_type.startsWith('video/') || ['.mp4', '.webm', '.mkv', '.mov', '.avi'].includes(fileRecord.file_extension.toLowerCase());
  const isAudio = fileRecord.mime_type.startsWith('audio/') || ['.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(fileRecord.file_extension.toLowerCase());

  let formattedSize = 'غير معروف';
  if (fileRecord.file_size > 0) {
    if (fileRecord.file_size < 1024 * 1024) {
      formattedSize = (fileRecord.file_size / 1024).toFixed(1) + ' KB';
    } else {
      formattedSize = (fileRecord.file_size / (1024 * 1024)).toFixed(1) + ' MB';
    }
  }

  const title = fileRecord.original_filename || 'ملف CloudX';
  const description = `حجم الملف: ${formattedSize} | استضافة وتخزين سحابي مباشر سريع عبر منصة CloudX`;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - CloudX</title>
  
  <!-- OpenGraph Meta Tags for Social Media (WhatsApp, Telegram, Facebook, Twitter, Discord) -->
  <meta property="og:site_name" content="CloudX Storage" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${protocol}://${reqHost}/f/${fileWithExt}" />
  ${isImage ? `<meta property="og:type" content="image" /><meta property="og:image" content="${fullRawUrl}" /><meta property="og:image:type" content="${fileRecord.mime_type}" />` : ''}
  ${isVideo ? `<meta property="og:type" content="video.other" /><meta property="og:video" content="${fullRawUrl}" /><meta property="og:video:secure_url" content="${fullRawUrl}" /><meta property="og:video:type" content="video/mp4" /><meta property="og:image" content="${fullRawUrl}" />` : ''}
  ${isAudio ? `<meta property="og:type" content="music.song" /><meta property="og:audio" content="${fullRawUrl}" /><meta property="og:audio:type" content="audio/mpeg" />` : ''}
  
  <meta name="twitter:card" content="${isVideo || isImage ? 'summary_large_image' : 'summary'}" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  ${isImage || isVideo ? `<meta name="twitter:image" content="${fullRawUrl}" />` : ''}

  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Cairo', system-ui, sans-serif; background-color: #030712; color: #f3f4f6; }
  </style>
</head>
<body class="min-h-screen flex flex-col justify-between p-4 md:p-8">
  <header class="max-w-4xl mx-auto w-full flex items-center justify-between pb-6 border-b border-gray-800">
    <a href="/" class="flex items-center gap-2 text-xl font-extrabold text-cyan-400">
      <svg class="w-7 h-7 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.5 19B5.5 5.5 0 0 0 18 8h-1.26A8 8 0 1 0 3 16.3"></path></svg>
      <span>Cloud<span class="text-white">X</span></span>
    </a>
    <span class="text-xs bg-cyan-950 text-cyan-400 border border-cyan-800/50 px-3 py-1 rounded-full font-mono">
      ${formattedSize}
    </span>
  </header>

  <main class="max-w-4xl mx-auto w-full my-auto py-8">
    <div class="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 md:p-8 shadow-2xl backdrop-blur-md">
      <div class="mb-6 text-center">
        <h1 class="text-xl md:text-2xl font-bold text-slate-100 break-all mb-2" dir="ltr">${fileRecord.original_filename}</h1>
        <p class="text-sm text-slate-400">ملف جاهز للعرض والتحميل المباشر الفائق السرعة</p>
      </div>

      <!-- Player / Media Content -->
      <div class="my-6 flex justify-center items-center bg-slate-950/60 rounded-xl p-4 border border-slate-800/80 min-h-[220px]">
        ${isImage ? `<img src="${fullRawUrl}" alt="${title}" class="max-h-[65vh] rounded-lg object-contain shadow-lg" loading="lazy" decoding="async" />` : ''}
        ${isVideo ? `<video controls preload="metadata" class="w-full max-h-[65vh] rounded-lg shadow-lg" src="${fullRawUrl}"></video>` : ''}
        ${isAudio ? `<div class="w-full p-4 text-center"><div class="text-4xl mb-4">🎵</div><audio controls preload="metadata" class="w-full" src="${fullRawUrl}"></audio></div>` : ''}
        ${!isImage && !isVideo && !isAudio ? `<div class="text-center p-8"><div class="text-5xl mb-3">📁</div><p class="text-slate-300 font-medium">${fileRecord.original_filename}</p><p class="text-xs text-slate-500 mt-1">${fileRecord.mime_type}</p></div>` : ''}
      </div>

      <!-- Action Buttons -->
      <div class="flex flex-col sm:flex-row gap-3 justify-center mt-8">
        <a href="${fullDownloadUrl}" class="flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold px-6 py-3.5 rounded-xl shadow-lg transition-all transform hover:-translate-y-0.5">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
          <span>تحميل مباشر سريع</span>
        </a>
        <a href="${fullRawUrl}" target="_blank" class="flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold px-5 py-3.5 rounded-xl border border-slate-700 transition-all">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
          <span>فتح الرابط المباشر (Raw)</span>
        </a>
        <a href="/" class="flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 text-slate-400 font-medium px-4 py-3.5 rounded-xl border border-slate-800 transition-all">
          <span>الرئيسية</span>
        </a>
      </div>
    </div>
  </main>

  <footer class="text-center text-xs text-slate-600 py-4">
    CloudX Storage Platform &copy; 2026 - جميع الحقوق محفوظة
  </footer>
</body>
</html>`;
}

// ----------------------------------------------------------------------
// 1. PUBLIC DIRECT FILE SERVING ROUTE (/f/:fileWithExt)
// ----------------------------------------------------------------------
app.get('/f/:fileWithExt', async (req: Request, res: Response) => {
  let fileRecord: StoredFile | null = null;
  try {
    const fileWithExt = req.params.fileWithExt;
    if (!fileWithExt) {
      return res.status(400).send('اسم الملف غير صحيح');
    }

    const lastDotIndex = fileWithExt.lastIndexOf('.');
    const publicId = lastDotIndex !== -1 ? fileWithExt.substring(0, lastDotIndex) : fileWithExt;

    fileRecord = await getFileById(publicId);

    if (!fileRecord) {
      fileRecord = await getFileById(fileWithExt);
    }

    if (!fileRecord) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
          <meta charset="UTF-8">
          <title>CloudX - الملف غير موجود</title>
          <style>
            body { font-family: sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
            .card { background: #1e293b; padding: 2rem; border-radius: 1rem; border: 1px solid #334155; max-width: 400px; }
            h1 { color: #f43f5e; margin-bottom: 0.5rem; }
            p { color: #94a3b8; }
            a { display: inline-block; margin-top: 1rem; padding: 0.5rem 1rem; background: #0284c7; color: white; border-radius: 0.5rem; text-decoration: none; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>عذراً، الملف غير موجود</h1>
            <p>قد يكون الرابط غير صحيح أو تم حذف الملف من خوادم CloudX.</p>
            <a href="/">العودة للرئيسية</a>
          </div>
        </body>
        </html>
      `);
    }

    const isRawOrMediaReq =
      req.query.raw === '1' ||
      req.query.download === '1' ||
      Boolean(req.headers.range) ||
      req.headers['sec-fetch-dest'] === 'video' ||
      req.headers['sec-fetch-dest'] === 'audio' ||
      req.headers['sec-fetch-dest'] === 'image' ||
      req.headers.accept?.includes('image/') ||
      req.headers.accept?.includes('video/') ||
      req.headers.accept?.includes('audio/');

    const reqHost = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';

    if (!isRawOrMediaReq) {
      return res.status(200).send(renderOpenGraphPreviewHtml(fileRecord, fileWithExt, reqHost, protocol));
    }

    // Check if client cache is still fresh (304 Not Modified)
    if (checkFreshCache(req, res, fileRecord)) {
      return;
    }

    // Check if file is stored in local fallback storage
    if (fileRecord.telegram_file_id.startsWith('local:')) {
      const localFileName = fileRecord.telegram_file_id.substring(6);
      const persistentDir = getWritableDir('uploads');
      const filePath = path.resolve(persistentDir, localFileName);
      if (!fs.existsSync(filePath)) {
        return res.status(404).send('الملف غير موجود في خوادم التخزين');
      }

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const isDownload = req.query.download === '1';
      const encodedFilename = encodeURIComponent(fileRecord.original_filename);

      res.setHeader('Content-Type', fileRecord.mime_type || 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'bytes');
      setCacheHeaders(res, fileRecord);
      res.setHeader(
        'Content-Disposition',
        isDownload
          ? `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`
          : `inline; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`
      );

      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        // Validate range
        if (start >= fileSize || end >= fileSize || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
          return res.end();
        }

        const chunksize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': fileRecord.mime_type || 'application/octet-stream'
        });

        const stream = fs.createReadStream(filePath, { start, end });
        stream.pipe(res);
        return;
      } else {
        res.setHeader('Content-Length', fileSize);
        res.status(200);
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
        return;
      }
    }

    // Check if file is stored as chunks in Telegram
    if (fileRecord.telegram_file_id.startsWith('chunks:')) {
      const chunkFileIds = fileRecord.telegram_file_id.substring(7).split(',').filter(Boolean);
      const isDownload = req.query.download === '1';
      const encodedFilename = encodeURIComponent(fileRecord.original_filename);

      res.setHeader('Content-Type', fileRecord.mime_type || 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'none');
      setCacheHeaders(res, fileRecord);
      res.setHeader(
        'Content-Disposition',
        isDownload
          ? `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`
          : `inline; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`
      );
      if (fileRecord.file_size) {
        res.setHeader('Content-Length', fileRecord.file_size);
      }

      res.status(200);

      for (const chunkId of chunkFileIds) {
        try {
          const chunkUrl = await getTelegramFileUrl(chunkId);
          const chunkRes = await fetch(chunkUrl);
          if (chunkRes.body) {
            // @ts-ignore
            const reader = chunkRes.body.getReader();
            const pump = async (): Promise<void> => {
              const { done, value } = await reader.read();
              if (done) return;
              res.write(Buffer.from(value));
              return pump();
            };
            await pump();
          } else {
            const arrBuf = await chunkRes.arrayBuffer();
            res.write(Buffer.from(arrBuf));
          }
        } catch (cErr) {
          console.error('Error fetching chunk during stream:', cErr);
        }
      }
      res.end();
      return;
    }

    // Retrieve fresh file URL from backend cloud
    const telegramFileUrl = await getTelegramFileUrl(fileRecord.telegram_file_id);

    const headers: Record<string, string> = {};
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const telegramRes = await fetch(telegramFileUrl, { headers });

    res.setHeader('Content-Type', fileRecord.mime_type || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    setCacheHeaders(res, fileRecord);

    const isDownload = req.query.download === '1';
    const encodedFilename = encodeURIComponent(fileRecord.original_filename);

    if (isDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`);
    } else {
      res.setHeader('Content-Disposition', `inline; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`);
    }

    if (telegramRes.headers.get('content-length')) {
      res.setHeader('Content-Length', telegramRes.headers.get('content-length')!);
    }
    if (telegramRes.headers.get('content-range')) {
      res.setHeader('Content-Range', telegramRes.headers.get('content-range')!);
    }

    res.status(telegramRes.status);

    if (telegramRes.body) {
      // @ts-ignore
      const reader = telegramRes.body.getReader();
      const pump = async () => {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          return;
        }
        res.write(Buffer.from(value));
        await pump();
      };
      await pump();
    } else {
      const buffer = await telegramRes.arrayBuffer();
      res.send(Buffer.from(buffer));
    }
  } catch (err: any) {
    console.error('Error serving file:', err);
    if (!res.headersSent) {
      // Clean HTML notice for files that exceed Telegram Bot API 20MB limit or need channel access
      const cleanChatId = fileRecord?.telegram_chat_id ? fileRecord.telegram_chat_id.replace('-100', '') : '';
      const telegramChannelUrl = (cleanChatId && fileRecord?.telegram_message_id) 
        ? `https://t.me/c/${cleanChatId}/${fileRecord.telegram_message_id}`
        : null;

      res.status(200).send(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>CloudX - تنبيه تحميل الملف</title>
          <style>
            body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1.5rem; box-sizing: border-box; }
            .card { background: #1e293b; padding: 2.5rem 2rem; border-radius: 1.25rem; border: 1px solid #334155; max-width: 480px; width: 100%; text-align: center; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.4); }
            .icon { font-size: 3.5rem; margin-bottom: 1rem; display: block; }
            h1 { color: #38bdf8; font-size: 1.35rem; margin-bottom: 0.75rem; font-weight: 700; }
            p { color: #94a3b8; line-height: 1.6; font-size: 0.95rem; margin-bottom: 1.75rem; }
            .file-info { background: #0f172a; padding: 0.75rem 1rem; border-radius: 0.5rem; font-family: monospace; font-size: 0.85rem; color: #38bdf8; margin-bottom: 1.5rem; word-break: break-all; }
            .btn-group { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; }
            .btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; padding: 0.75rem 1.25rem; border-radius: 0.6rem; font-weight: 600; text-decoration: none; font-size: 0.9rem; transition: all 0.2s; }
            .btn-primary { background: #0284c7; color: white; }
            .btn-primary:hover { background: #0369a1; }
            .btn-secondary { background: #334155; color: #f8fafc; }
            .btn-secondary:hover { background: #475569; }
          </style>
        </head>
        <body>
          <div class="card">
            <span class="icon">🎬</span>
            <h1>الملف محفوظ وفي انتظار التحميل</h1>
            <div class="file-info">${fileRecord?.original_filename || 'الملف المطلوب'}</div>
            <p>يتجاوز حجم هذا الملف حد التحميل المباشر الآلي (20MB) عبر المساعد. يمكنك تنزيل أو مشاهدة الفيديو مباشرة عبر قناتك على تلجرام.</p>
            <div class="btn-group">
              ${telegramChannelUrl ? `<a href="${telegramChannelUrl}" target="_blank" class="btn btn-primary">📱 فتح الملف في تلجرام</a>` : ''}
              <a href="/" class="btn btn-secondary">العودة للرئيسية</a>
            </div>
          </div>
        </body>
        </html>
      `);
    }
  }
});

// ----------------------------------------------------------------------
// 2. API ENDPOINTS
// ----------------------------------------------------------------------

// Local Cloudflare Worker simulation/proxy endpoint
app.post('/api/worker-upload', uploadChunk.single('file'), async (req: Request, res: Response) => {
  let tmpPath = '';
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, error: 'لم يتم العثور على أي ملف للرفع' });
    }
    tmpPath = file.path;

    const { safeName } = getFileExtensionAndName(file.originalname || 'document.bin');
    
    // Stream file from disk instead of loading into memory
    const fileBuffer = fs.readFileSync(file.path);
    const tgResult = await uploadFileToTelegram(
      fileBuffer,
      safeName,
      file.mimetype || 'application/octet-stream'
    );

    // Clean up temp file
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (e) {}
    }

    return res.json({
      success: true,
      fileId: tgResult.fileId,
      messageId: tgResult.messageId,
      chatId: tgResult.chatId,
      originalFilename: file.originalname,
      fileSize: file.size,
      mimeType: file.mimetype
    });
  } catch (err: any) {
    // Clean up temp file on error
    if (tmpPath && fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (e) {}
    }
    console.error('Error in worker upload endpoint:', err);
    return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء رفع الملف: ' + (err.message || String(err)) });
  }
});

// Record completed direct client upload
app.post('/api/record-file', async (req: Request, res: Response) => {
  try {
    const { fileId, messageId, chatId, originalFilename, fileSize, mimeType } = req.body;

    if (!fileId || !originalFilename) {
      return res.status(400).json({ success: false, error: 'بيانات التسجيل غير مكتملة' });
    }

    let publicId = '';
    if (messageId && Number(messageId) > 0) {
      publicId = messageIdToShortCode(Number(messageId));
    }
    if (!publicId) {
      publicId = generatePublicId();
    }

    const { extension } = getFileExtensionAndName(originalFilename);

    const createdIso = new Date().toISOString();

    const fileRecord: StoredFile = {
      id: publicId,
      original_filename: originalFilename,
      file_extension: extension,
      mime_type: mimeType || 'application/octet-stream',
      file_size: Number(fileSize) || 0,
      telegram_chat_id: chatId || '-1003839994672',
      telegram_message_id: Number(messageId) || 0,
      telegram_file_id: fileId,
      created_at: createdIso
    };

    await saveFileRecord(fileRecord);

    const protocol = req.protocol || 'http';
    const host = req.get('host') || 'localhost:3000';
    const directUrl = `${protocol}://${host}/f/${publicId}${extension}`;

    return res.json({
      success: true,
      file: {
        id: publicId,
        originalFilename: fileRecord.original_filename,
        fileExtension: fileRecord.file_extension,
        mimeType: fileRecord.mime_type,
        fileSize: fileRecord.file_size,
        createdAt: fileRecord.created_at,
        directUrl: directUrl,
        relativePath: `/f/${publicId}${extension}`
      }
    });
  } catch (err: any) {
    console.error('Error recording file:', err);
    return res.status(500).json({ success: false, error: 'فشل تسجيل بيانات الملف' });
  }
});

// Chunked Upload: 1. Upload chunk to Stateless Storage (Telegram)
app.post('/api/upload/chunk', uploadChunk.single('chunk'), async (req: Request, res: Response) => {
  let tmpPath = '';
  try {
    const rawChunkIndex = req.body?.chunkIndex !== undefined ? req.body.chunkIndex : req.headers['x-chunk-index'];
    if (!req.file || rawChunkIndex === undefined || rawChunkIndex === null) {
      return res.status(400).json({ success: false, error: 'بيانات الجزء المرفوع غير مكتملة' });
    }
    tmpPath = req.file.path;
    const chunkIndex = Number(rawChunkIndex);

    const { safeName } = getFileExtensionAndName(req.file.originalname || 'part.bin');
    
    // Read from disk (not memory) to avoid OOM on large chunks
    const chunkBuffer = fs.readFileSync(req.file.path);
    const tgResult = await uploadFileToTelegram(
      chunkBuffer,
      `part_${chunkIndex}_${safeName}`,
      req.file.mimetype || 'application/octet-stream'
    );

    // Clean up temp file
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (e) {}
    }

    return res.json({
      success: true,
      chunkIndex: Number(chunkIndex),
      fileId: tgResult.fileId
    });
  } catch (err: any) {
    // Clean up temp file on error
    if (tmpPath && fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (e) {}
    }
    console.error('Error uploading chunk:', err);
    return res.status(500).json({ success: false, error: 'فشل حفظ جزء الملف: ' + (err.message || String(err)) });
  }
});

// Chunked Upload: 2. Complete Stateless Chunks
app.post('/api/upload/complete', async (req: Request, res: Response) => {
  try {
    const { chunkFileIds, filename, mimeType, fileSize, chatId, messageId } = req.body;
    if (!filename || !Array.isArray(chunkFileIds) || chunkFileIds.length === 0) {
      return res.status(400).json({ success: false, error: 'بيانات التجميع غير مكتملة' });
    }

    const telegramFileId = chunkFileIds.length === 1
      ? chunkFileIds[0]
      : `chunks:${chunkFileIds.join(',')}`;

    let publicId = '';
    if (messageId && Number(messageId) > 0) {
      publicId = messageIdToShortCode(Number(messageId));
    }
    if (!publicId) {
      publicId = generatePublicId();
    }

    const { extension } = getFileExtensionAndName(filename);

    const createdIso = new Date().toISOString();

    const fileRecord: StoredFile = {
      id: publicId,
      original_filename: filename,
      file_extension: extension,
      mime_type: mimeType || 'application/octet-stream',
      file_size: Number(fileSize) || 0,
      telegram_chat_id: chatId || '-1003839994672',
      telegram_message_id: Number(messageId) || 0,
      telegram_file_id: telegramFileId,
      created_at: createdIso
    };

    await saveFileRecord(fileRecord);

    const protocol = req.protocol || 'http';
    const host = req.get('host') || 'localhost:3000';
    const directUrl = `${protocol}://${host}/f/${publicId}${extension}`;

    return res.json({
      success: true,
      file: {
        id: publicId,
        originalFilename: fileRecord.original_filename,
        fileExtension: fileRecord.file_extension,
        mimeType: fileRecord.mime_type,
        fileSize: fileRecord.file_size,
        createdAt: fileRecord.created_at,
        directUrl: directUrl,
        relativePath: `/f/${publicId}${extension}`
      }
    });
  } catch (err: any) {
    console.error('Error completing chunked upload:', err);
    return res.status(500).json({ success: false, error: 'حدث خطأ أثناء حفظ الملف: ' + (err.message || String(err)) });
  }
});

// Single Request File Upload Endpoint (for small files < 4MB)
app.post('/api/upload', upload.single('file'), async (req: Request, res: Response) => {
  let tmpPath = '';
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'يرجى اختيار ملف لرفعه' });
    }

    const file = req.file;
    tmpPath = file.path;
    const { extension, safeName } = getFileExtensionAndName(file.originalname);
    const publicId = generatePublicId();

    let telegramResult: { chatId: string; messageId: number; fileId: string } | null = null;

    const maxTelegramBytes = 50 * 1024 * 1024;

    if (file.size <= maxTelegramBytes) {
      try {
        const fileBuffer = fs.readFileSync(file.path);
        telegramResult = await uploadFileToTelegram(
          fileBuffer,
          safeName,
          file.mimetype
        );
      } catch (tgErr: any) {
        console.warn('Backend storage fallback:', tgErr.message);
      }
    }

    if (!telegramResult) {
      const persistentUploadsDir = getWritableDir('uploads');
      const localFileName = `${publicId}${extension}`;
      const destPath = path.resolve(persistentUploadsDir, localFileName);

      fs.copyFileSync(file.path, destPath);

      telegramResult = {
        chatId: 'cloudx_local',
        messageId: 0,
        fileId: `local:${localFileName}`
      };
    }

    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (e) {}
    }

    const createdIso = new Date().toISOString();

    const fileRecord: StoredFile = {
      id: publicId,
      original_filename: file.originalname,
      file_extension: extension,
      mime_type: file.mimetype || 'application/octet-stream',
      file_size: file.size,
      telegram_chat_id: telegramResult.chatId,
      telegram_message_id: telegramResult.messageId,
      telegram_file_id: telegramResult.fileId,
      created_at: createdIso
    };

    await saveFileRecord(fileRecord);

    const protocol = req.protocol || 'http';
    const host = req.get('host') || 'localhost:3000';
    const directUrl = `${protocol}://${host}/f/${publicId}${extension}`;

    return res.json({
      success: true,
      file: {
        id: publicId,
        originalFilename: fileRecord.original_filename,
        fileExtension: fileRecord.file_extension,
        mimeType: fileRecord.mime_type,
        fileSize: fileRecord.file_size,
        createdAt: fileRecord.created_at,
        directUrl: directUrl,
        relativePath: `/f/${publicId}${extension}`
      }
    });
  } catch (err: any) {
    if (tmpPath && fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (e) {}
    }
    console.error('Upload Error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'حدث خطأ أثناء رفع الملف إلى خوادم CloudX'
    });
  }
});

// System Status Check
app.get('/api/system/status', async (req: Request, res: Response) => {
  const result = await testTelegramConnection();
  return res.json({
    success: true,
    message: 'خوادم CloudX للتخزين المباشر تعمل بكفاءة'
  });
});

// Camouflaged Login Endpoint
app.post('/api/admin/login', (req: Request, res: Response) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || 'Aa123456';

  if (password === adminPassword) {
    const token = Buffer.from(`admin_${adminPassword}_${Date.now()}`).toString('base64');
    return res.json({ success: true, token });
  } else {
    return res.status(401).json({ success: false, error: 'رمز الدخول غير صحيح' });
  }
});

// Admin Check Middleware
function authAdminMiddleware(req: Request, res: Response, next: any) {
  const authHeader = req.headers.authorization;
  const adminPassword = process.env.ADMIN_PASSWORD || 'Aa123456';

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf-8');
      if (decoded.startsWith(`admin_${adminPassword}`)) {
        return next();
      }
    } catch (e) {
      // Invalid token
    }
  }

  return res.status(403).json({ success: false, error: 'يرجى تسجيل الدخول أولاً.' });
}

// Get All Files (Protected Route)
app.get('/api/admin/files', authAdminMiddleware, async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;
    const files = await getAllFiles(query);
    const protocol = req.protocol || 'http';
    const host = req.get('host') || 'localhost:3000';

    const enrichedFiles = files.map(f => ({
      ...f,
      directUrl: `${protocol}://${host}/f/${f.id}${f.file_extension}`,
      relativePath: `/f/${f.id}${f.file_extension}`
    }));

    return res.json({ success: true, files: enrichedFiles });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || 'فشل جلب قائمة الملفات' });
  }
});

// Delete File (Protected Route)
app.delete('/api/admin/files/:id', authAdminMiddleware, async (req: Request, res: Response) => {
  try {
    const fileId = req.params.id;
    const fileRecord = await getFileById(fileId);

    if (!fileRecord) {
      return res.status(404).json({ success: false, error: 'الملف غير موجود' });
    }

    if (fileRecord.telegram_file_id.startsWith('local:')) {
      const localFileName = fileRecord.telegram_file_id.substring(6);
      const persistentDir = getWritableDir('uploads');
      const filePath = path.resolve(persistentDir, localFileName);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } else if (fileRecord.telegram_chat_id && fileRecord.telegram_message_id) {
      await deleteTelegramMessage(fileRecord.telegram_chat_id, fileRecord.telegram_message_id);
    }

    await deleteFileRecord(fileId);

    return res.json({ success: true, message: 'تم حذف الملف بنجاح' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || 'حدث خطأ أثناء حذف الملف' });
  }
});

// App Stats Endpoint
app.get('/api/stats', async (req: Request, res: Response) => {
  try {
    const files = await getAllFiles();
    const totalCount = files.length;
    const totalBytes = files.reduce((acc, f) => acc + (f.file_size || 0), 0);

    // Cache stats for 30 seconds
    res.setHeader('Cache-Control', 'public, max-age=30');

    return res.json({
      success: true,
      totalFiles: totalCount,
      totalBytes: totalBytes
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default app;
