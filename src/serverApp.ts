import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

import { initDb, saveFileRecord, getFileById, getAllFiles, deleteFileRecord, StoredFile } from './db/index.js';
import {
  uploadFileToTelegram,
  getTelegramFileUrl,
  deleteTelegramMessage,
  testTelegramConnection,
  saveTelegramCredentials,
  getTelegramCredentials
} from './services/telegram.js';

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

const upload = multer({
  storage: storage
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

// ----------------------------------------------------------------------
// 1. PUBLIC DIRECT FILE SERVING ROUTE (/f/:fileWithExt)
// ----------------------------------------------------------------------
app.get('/f/:fileWithExt', async (req: Request, res: Response) => {
  try {
    const fileWithExt = req.params.fileWithExt;
    if (!fileWithExt) {
      return res.status(400).send('اسم الملف غير صحيح');
    }

    const lastDotIndex = fileWithExt.lastIndexOf('.');
    const publicId = lastDotIndex !== -1 ? fileWithExt.substring(0, lastDotIndex) : fileWithExt;

    let fileRecord = await getFileById(publicId);

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

    // Retrieve fresh file URL from backend cloud
    const telegramFileUrl = await getTelegramFileUrl(fileRecord.telegram_file_id);

    const headers: Record<string, string> = {};
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const telegramRes = await fetch(telegramFileUrl, { headers });

    res.setHeader('Content-Type', fileRecord.mime_type || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');

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
      res.status(500).send('حدث خطأ أثناء جلب الملف من خوادم CloudX');
    }
  }
});

// ----------------------------------------------------------------------
// 2. API ENDPOINTS
// ----------------------------------------------------------------------

const chunkStorage = multer.memoryStorage();
const uploadChunk = multer({ storage: chunkStorage });

// Local Cloudflare Worker simulation/proxy endpoint
app.post('/api/worker-upload', uploadChunk.single('file'), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, error: 'لم يتم العثور على أي ملف للرفع' });
    }

    const { safeName } = getFileExtensionAndName(file.originalname || 'document.bin');
    const tgResult = await uploadFileToTelegram(
      file.buffer,
      safeName,
      file.mimetype || 'application/octet-stream'
    );

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

    const publicId = generatePublicId();
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

// Chunked Upload: 1. Upload 2MB Chunk directly to Stateless Storage (Telegram)
app.post('/api/upload/chunk', uploadChunk.single('chunk'), async (req: Request, res: Response) => {
  try {
    const rawChunkIndex = req.body?.chunkIndex !== undefined ? req.body.chunkIndex : req.headers['x-chunk-index'];
    if (!req.file || rawChunkIndex === undefined || rawChunkIndex === null) {
      return res.status(400).json({ success: false, error: 'بيانات الجزء المرفوع غير مكتملة' });
    }
    const chunkIndex = Number(rawChunkIndex);

    const { safeName } = getFileExtensionAndName(req.file.originalname || 'part.bin');
    const tgResult = await uploadFileToTelegram(
      req.file.buffer,
      `part_${chunkIndex}_${safeName}`,
      req.file.mimetype || 'application/octet-stream'
    );

    return res.json({
      success: true,
      chunkIndex: Number(chunkIndex),
      fileId: tgResult.fileId
    });
  } catch (err: any) {
    console.error('Error uploading chunk:', err);
    return res.status(500).json({ success: false, error: 'فشل حفظ جزء الملف: ' + (err.message || String(err)) });
  }
});

// Chunked Upload: 2. Complete & Reassemble Stateless Chunks
app.post('/api/upload/complete', async (req: Request, res: Response) => {
  try {
    const { chunkFileIds, filename, mimeType, fileSize } = req.body;
    if (!filename || !Array.isArray(chunkFileIds) || chunkFileIds.length === 0) {
      return res.status(400).json({ success: false, error: 'بيانات التجميع غير مكتملة' });
    }

    const publicId = generatePublicId();
    const { extension, safeName } = getFileExtensionAndName(filename);

    const chunkBuffers: Buffer[] = [];
    let totalSize = 0;

    for (let i = 0; i < chunkFileIds.length; i++) {
      const chunkFileId = chunkFileIds[i];
      const chunkUrl = await getTelegramFileUrl(chunkFileId);
      const chunkRes = await fetch(chunkUrl);
      if (!chunkRes.ok) {
        throw new Error(`فشل جلب الجزء رقم ${i + 1} للتجميع`);
      }
      const chunkArrayBuf = await chunkRes.arrayBuffer();
      const chunkBuf = Buffer.from(chunkArrayBuf);
      totalSize += chunkBuf.length;
      chunkBuffers.push(chunkBuf);
    }

    const assembledBuffer = Buffer.concat(chunkBuffers);

    let telegramResult: { chatId: string; messageId: number; fileId: string } | null = null;
    const maxTelegramBytes = 50 * 1024 * 1024;

    if (assembledBuffer.length <= maxTelegramBytes) {
      try {
        telegramResult = await uploadFileToTelegram(
          assembledBuffer,
          safeName,
          mimeType || 'application/octet-stream'
        );
      } catch (tgErr: any) {
        console.warn('Telegram channel reassemble fallback:', tgErr.message);
      }
    }

    if (!telegramResult) {
      const persistentUploadsDir = getWritableDir('uploads');
      const localFileName = `${publicId}${extension}`;
      const destPath = path.resolve(persistentUploadsDir, localFileName);

      fs.writeFileSync(destPath, assembledBuffer);

      telegramResult = {
        chatId: 'cloudx_local',
        messageId: 0,
        fileId: `local:${localFileName}`
      };
    }

    const createdIso = new Date().toISOString();

    const fileRecord: StoredFile = {
      id: publicId,
      original_filename: filename,
      file_extension: extension,
      mime_type: mimeType || 'application/octet-stream',
      file_size: Number(fileSize) || totalSize,
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
    console.error('Error completing chunked upload:', err);
    return res.status(500).json({ success: false, error: 'حدث خطأ أثناء تجميع وتخزين الملف النهائي: ' + (err.message || String(err)) });
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
