import path from 'path';

export interface FileTokenPayload {
  tf: string; // telegram_file_id or chunks:...
  fn: string; // original filename
  sz?: number; // file size
  ch?: string; // chat id
  ms?: number; // message id
  mt?: string; // mime type
}

export function encodeFileToken(payload: FileTokenPayload): string {
  try {
    const jsonStr = JSON.stringify(payload);
    return Buffer.from(jsonStr).toString('base64url');
  } catch (err) {
    console.error('Error encoding file token:', err);
    return '';
  }
}

export function decodeFileToken(token: string): FileTokenPayload | null {
  try {
    const jsonStr = Buffer.from(token, 'base64url').toString('utf-8');
    const parsed = JSON.parse(jsonStr);
    if (parsed && typeof parsed === 'object' && parsed.tf) {
      return parsed as FileTokenPayload;
    }
    return null;
  } catch (err) {
    return null;
  }
}

export function getMimeTypeFromExt(ext: string): string {
  const cleanExt = ext.toLowerCase().replace('.', '');
  switch (cleanExt) {
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mkv':
      return 'video/x-matroska';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
      return 'audio/ogg';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    case 'zip':
      return 'application/zip';
    case 'rar':
      return 'application/x-rar-compressed';
    case 'txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}
