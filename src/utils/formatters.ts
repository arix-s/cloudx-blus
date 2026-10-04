/**
 * Formats bytes into human-readable Arabic file sizes (B, KB, MB)
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 بايت';
  const k = 1024;
  const sizes = ['بايت', 'كيلوبايت', 'ميجابايت', 'جيجابايت'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = (bytes / Math.pow(k, i)).toFixed(i > 1 ? 2 : 1);
  return `${val} ${sizes[i]}`;
}

/**
 * Formats ISO date string to Arabic formatted date
 */
export function formatDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    return new Intl.DateTimeFormat('ar-SA', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(d);
  } catch {
    return isoString;
  }
}

/**
 * Helper to determine file category for icons & previews
 */
export function getFileCategory(ext: string, mimeType: string): 'video' | 'image' | 'audio' | 'pdf' | 'archive' | 'code' | 'other' {
  const cleanExt = ext.toLowerCase().replace('.', '');
  
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(cleanExt) || mimeType.startsWith('video/')) {
    return 'video';
  }
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'bmp'].includes(cleanExt) || mimeType.startsWith('image/')) {
    return 'image';
  }
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(cleanExt) || mimeType.startsWith('audio/')) {
    return 'audio';
  }
  if (cleanExt === 'pdf' || mimeType.includes('pdf')) {
    return 'pdf';
  }
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(cleanExt)) {
    return 'archive';
  }
  if (['json', 'txt', 'html', 'css', 'js', 'ts', 'py', 'xml'].includes(cleanExt)) {
    return 'code';
  }
  return 'other';
}
