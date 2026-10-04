import fs from 'fs';
import path from 'path';

export interface TelegramUploadResult {
  messageId: number;
  fileId: string;
  chatId: string;
}

export interface TelegramBotInfo {
  id: number;
  first_name: string;
  username: string;
}

function getConfigFile(): string {
  if (process.env.VERCEL) {
    return '/tmp/data/telegram_config.json';
  }
  return path.resolve(process.cwd(), 'data', 'telegram_config.json');
}

let runtimeConfig: { token?: string; chatId?: string } = {};

function loadRuntimeConfig() {
  try {
    const configFile = getConfigFile();
    if (fs.existsSync(configFile)) {
      const raw = fs.readFileSync(configFile, 'utf-8');
      runtimeConfig = JSON.parse(raw);
    }
  } catch (e) {
    // ignore
  }
}

loadRuntimeConfig();

function formatChatId(chatId: string): string {
  let clean = chatId.trim();
  if (/^\d{8,12}$/.test(clean)) {
    return `-100${clean}`;
  }
  return clean;
}

export function saveTelegramCredentials(token: string, chatId: string) {
  runtimeConfig.token = token.trim();
  runtimeConfig.chatId = formatChatId(chatId);

  const configFile = getConfigFile();
  const dataDir = path.dirname(configFile);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(configFile, JSON.stringify(runtimeConfig, null, 2), 'utf-8');
}

export function getTelegramCredentials() {
  const token =
    runtimeConfig.token ||
    process.env.TELEGRAM_BOT_TOKEN ||
    '6707537751:AAHs-U9vHvmxDu6iyQSGuec9SWFIeMvbg2A';
  const rawChatId =
    runtimeConfig.chatId ||
    process.env.TELEGRAM_CHAT_ID ||
    '-1003839994672';
  return { token: token.trim(), chatId: formatChatId(rawChatId) };
}

/**
 * Gets Telegram Bot Info
 */
export async function getBotInfo(): Promise<{ success: boolean; bot?: TelegramBotInfo; error?: string }> {
  const { token } = getTelegramCredentials();
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    if (data.ok && data.result) {
      return { success: true, bot: data.result };
    }
    return { success: false, error: 'فشل الاتصال بالخادم الرئيسي' };
  } catch (err: any) {
    return { success: false, error: 'خطأ في شبكة خادم التخزين' };
  }
}

/**
 * Tests Cloud Storage Connection
 */
export async function testTelegramConnection(): Promise<{ success: boolean; botUsername?: string; message?: string }> {
  const { token, chatId } = getTelegramCredentials();

  const botRes = await getBotInfo();
  if (!botRes.success || !botRes.bot) {
    return {
      success: false,
      message: 'تعذر الاتصال بخادم التخزين السحابي الرئيسي'
    };
  }

  const botUsername = botRes.bot.username;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '🔔 CloudX Cloud Storage - System Active'
      })
    });

    const data = await res.json();

    if (data.ok) {
      return {
        success: true,
        botUsername,
        message: 'خادم التخزين السحابي يعمل بنجاح!'
      };
    }

    return {
      success: false,
      botUsername,
      message: 'جاري العمل بنظام التخزين المحلي الاحتياطي'
    };
  } catch (err: any) {
    return {
      success: false,
      botUsername,
      message: 'فشل الاتصال بالخادم الرئيسي'
    };
  }
}

/**
 * Uploads a file buffer to Telegram using sendDocument API
 */
export async function uploadFileToTelegram(
  fileBuffer: Buffer,
  filename: string,
  mimeType: string
): Promise<TelegramUploadResult> {
  const { token, chatId } = getTelegramCredentials();

  if (!token || !chatId) {
    throw new Error('بيانات إعدادات خادم التخزين غير مكتملة');
  }

  const formData = new FormData();
  formData.append('chat_id', chatId);

  const uint8Array = new Uint8Array(fileBuffer);
  const blob = new Blob([uint8Array], { type: mimeType || 'application/octet-stream' });
  formData.append('document', blob, filename);

  const telegramUrl = `https://api.telegram.org/bot${token}/sendDocument`;

  const response = await fetch(telegramUrl, {
    method: 'POST',
    body: formData
  });

  const data = await response.json();

  if (!data.ok || !data.result) {
    console.error('CloudX backend storage response:', data);
    throw new Error('فشل رفع الملف إلى خادم التخزين السحابي');
  }

  const result = data.result;
  const messageId = result.message_id;

  let fileId = '';
  if (result.document?.file_id) {
    fileId = result.document.file_id;
  } else if (result.video?.file_id) {
    fileId = result.video.file_id;
  } else if (result.audio?.file_id) {
    fileId = result.audio.file_id;
  } else if (result.photo && Array.isArray(result.photo) && result.photo.length > 0) {
    fileId = result.photo[result.photo.length - 1].file_id;
  } else if (result.animation?.file_id) {
    fileId = result.animation.file_id;
  }

  if (!fileId) {
    throw new Error('لم يتم الحصول على معرف الملف');
  }

  return {
    messageId,
    fileId,
    chatId
  };
}

/**
 * Fetches fresh direct download URL for a file
 */
export async function getTelegramFileUrl(fileId: string): Promise<string> {
  const { token } = getTelegramCredentials();
  const getFileUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;

  const res = await fetch(getFileUrl);
  const data = await res.json();

  if (!data.ok || !data.result?.file_path) {
    throw new Error('الملف غير متاح حالياً');
  }

  return `https://api.telegram.org/file/bot${token}/${data.result.file_path}`;
}

/**
 * Deletes a file record
 */
export async function deleteTelegramMessage(chatId: string, messageId: number): Promise<boolean> {
  try {
    const { token } = getTelegramCredentials();
    const deleteUrl = `https://api.telegram.org/bot${token}/deleteMessage`;

    const res = await fetch(deleteUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId
      })
    });

    const data = await res.json();
    return data.ok === true;
  } catch (err) {
    return false;
  }
}
