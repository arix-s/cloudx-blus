import React, { useState, useEffect, useRef } from 'react';
import {
  UploadCloud,
  FileText,
  CheckCircle2,
  Copy,
  ExternalLink,
  Trash2,
  Lock,
  Search,
  FileVideo,
  FileImage,
  FileAudio,
  FileArchive,
  FileCode,
  File,
  HardDrive,
  AlertTriangle,
  Download,
  RefreshCw,
  LogOut,
  FolderOpen,
  Send,
  Check,
  Sparkles,
  Cloud,
  User,
  Shield
} from 'lucide-react';
import { formatFileSize, formatDate, getFileCategory } from './utils/formatters';

interface UploadedFileInfo {
  id: string;
  originalFilename: string;
  fileExtension: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
  directUrl: string;
  relativePath: string;
}

interface AdminFileInfo {
  id: string;
  original_filename: string;
  file_extension: string;
  mime_type: string;
  file_size: number;
  created_at: string;
  directUrl: string;
  relativePath: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'upload' | 'login'>('upload');
  const [fileToUpload, setFileToUpload] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedResult, setUploadedResult] = useState<UploadedFileInfo | null>(null);
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [dragActive, setDragActive] = useState<boolean>(false);

  // Stealth Login / Admin state
  const [userToken, setUserToken] = useState<string | null>(() => localStorage.getItem('cloudx_user_token'));
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [managedFiles, setManagedFiles] = useState<AdminFileInfo[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isLoadingFiles, setIsLoadingFiles] = useState<boolean>(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // App statistics
  const [stats, setStats] = useState<{ totalFiles: number; totalBytes: number } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (window.location.pathname === '/login' || window.location.pathname === '/admin') {
      setActiveTab('login');
    }
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();
      if (data.success) {
        setStats({ totalFiles: data.totalFiles, totalBytes: data.totalBytes });
      }
    } catch (e) {
      // Ignore stats error
    }
  };

  useEffect(() => {
    if (activeTab === 'login' && userToken) {
      loadManagedFiles();
    }
  }, [activeTab, userToken, searchQuery]);

  const loadManagedFiles = async () => {
    if (!userToken) return;
    setIsLoadingFiles(true);
    try {
      const url = searchQuery ? `/api/admin/files?q=${encodeURIComponent(searchQuery)}` : '/api/admin/files';
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${userToken}`
        }
      });
      const data = await res.json();
      if (data.success) {
        setManagedFiles(data.files);
      } else {
        if (res.status === 403) {
          localStorage.removeItem('cloudx_user_token');
          setUserToken(null);
          setLoginError('انتهت جلسة تسجيل الدخول');
        }
      }
    } catch (err) {
      console.error('Error fetching files:', err);
    } finally {
      setIsLoadingFiles(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput })
      });
      const data = await res.json();
      if (data.success && data.token) {
        setUserToken(data.token);
        localStorage.setItem('cloudx_user_token', data.token);
        setPasswordInput('');
      } else {
        setLoginError(data.error || 'رمز الدخول غير صحيح');
      }
    } catch (err) {
      setLoginError('فشل الاتصال بالخادم');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('cloudx_user_token');
    setUserToken(null);
  };

  const handleDeleteFile = async (id: string) => {
    if (!window.confirm('هل أنت تأكد من رغبتك في حذف هذا الملف؟')) {
      return;
    }
    setDeletingId(id);
    try {
      const res = await fetch(`/api/admin/files/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${userToken}`
        }
      });
      const data = await res.json();
      if (data.success) {
        setManagedFiles(prev => prev.filter(f => f.id !== id));
        fetchStats();
      } else {
        alert(data.error || 'فشل حذف الملف');
      }
    } catch (err) {
      alert('حدث خطأ أثناء حذف الملف');
    } finally {
      setDeletingId(null);
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      validateAndSelectFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      validateAndSelectFile(e.target.files[0]);
    }
  };

  const validateAndSelectFile = (file: File) => {
    setUploadError(null);
    setUploadedResult(null);
    setFileToUpload(file);
  };

  const handleUpload = async () => {
    if (!fileToUpload) return;

    setIsUploading(true);
    setUploadProgress(1);
    setUploadError(null);

    const file = fileToUpload;
    const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunks (always < 4.5MB Vercel serverless limit)
    const fileSize = file.size;

    try {
      if (fileSize <= 3 * 1024 * 1024) {
        // Direct single upload for small files
        const formData = new FormData();
        formData.append('file', file);

        const progressInterval = setInterval(() => {
          setUploadProgress(prev => (prev < 90 ? prev + 10 : prev));
        }, 300);

        const res = await fetch('/api/upload', {
          method: 'POST',
          body: formData
        });

        clearInterval(progressInterval);
        setUploadProgress(100);

        const data = await res.json();
        if (data.success && data.file) {
          setUploadedResult(data.file);
          setFileToUpload(null);
          fetchStats();
        } else {
          setUploadError(data.error || 'حدث خطأ أثناء رفع الملف إلى خوادم CloudX');
        }
      } else {
        // Stateless Chunked Upload for large files (20MB, 50MB, 100MB, 500MB+)
        const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
        const chunkFileIds: string[] = [];

        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
          const start = chunkIndex * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, fileSize);
          const chunkBlob = file.slice(start, end);

          const chunkFormData = new FormData();
          chunkFormData.append('chunkIndex', String(chunkIndex));
          chunkFormData.append('totalChunks', String(totalChunks));
          chunkFormData.append('chunk', chunkBlob, `${file.name}.part${chunkIndex}`);

          const chunkRes = await fetch('/api/upload/chunk', {
            method: 'POST',
            headers: { 'x-chunk-index': String(chunkIndex) },
            body: chunkFormData
          });

          const chunkData = await chunkRes.json();
          if (!chunkData.success || !chunkData.fileId) {
            throw new Error(chunkData.error || `فشل رفع الجزء رقم ${chunkIndex + 1}`);
          }

          chunkFileIds.push(chunkData.fileId);

          const currentPercent = Math.round(((chunkIndex + 1) / totalChunks) * 85);
          setUploadProgress(currentPercent);
        }

        // Complete and assemble file
        setUploadProgress(90);
        const completeRes = await fetch('/api/upload/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chunkFileIds,
            filename: file.name,
            fileSize: file.size,
            mimeType: file.type
          })
        });

        const completeData = await completeRes.json();
        setUploadProgress(100);

        if (completeData.success && completeData.file) {
          setUploadedResult(completeData.file);
          setFileToUpload(null);
          fetchStats();
        } else {
          setUploadError(completeData.error || 'حدث خطأ أثناء تجميع وتخزين الملف النهائي');
        }
      }
    } catch (err: any) {
      console.error('Upload catch error:', err);
      setUploadError(err.message || 'فشل الاتصال بالخادم، يرجى المحاولة لاحقاً');
    } finally {
      setIsUploading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const copyFileLink = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const renderFileIcon = (category: string) => {
    switch (category) {
      case 'video':
        return <FileVideo className="w-8 h-8 text-cyan-400" />;
      case 'image':
        return <FileImage className="w-8 h-8 text-emerald-400" />;
      case 'audio':
        return <FileAudio className="w-8 h-8 text-amber-400" />;
      case 'pdf':
        return <FileText className="w-8 h-8 text-rose-400" />;
      case 'archive':
        return <FileArchive className="w-8 h-8 text-purple-400" />;
      case 'code':
        return <FileCode className="w-8 h-8 text-blue-400" />;
      default:
        return <File className="w-8 h-8 text-slate-400" />;
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-['Cairo',sans-serif]">
      {/* Top Navbar */}
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-500 via-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <Cloud className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="font-extrabold text-xl text-white tracking-wider leading-none">Cloud<span className="text-cyan-400">X</span></h1>
              <p className="text-xs text-slate-400 mt-1 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                منصة التخزين السحابي الفائق
              </p>
            </div>
          </div>

          <nav className="flex items-center gap-2">
            <button
              onClick={() => {
                setActiveTab('upload');
                window.history.pushState({}, '', '/');
              }}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-2 ${
                activeTab === 'upload'
                  ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
              }`}
            >
              <UploadCloud className="w-4 h-4" />
              <span>الرئيسية والرفع</span>
            </button>

            <button
              onClick={() => {
                setActiveTab('login');
                window.history.pushState({}, '', '/login');
              }}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-2 ${
                activeTab === 'login'
                  ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
              }`}
            >
              <User className="w-4 h-4" />
              <span>تسجيل الدخول</span>
            </button>
          </nav>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-8 flex flex-col space-y-8">
        {activeTab === 'upload' && (
          <div className="flex-1 flex flex-col items-center justify-center space-y-8">
            {/* Hero Banner */}
            <div className="text-center space-y-3 max-w-xl mx-auto">
              <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-xs font-semibold">
                <Sparkles className="w-3.5 h-3.5" />
                <span>رفع وتخزين سحابي فائق السرعة وبدون حدود للحجم</span>
              </div>
              <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight leading-tight">
                تخزين الملفات Cloud<span className="text-cyan-400">X</span>
              </h2>
              <p className="text-slate-400 text-base leading-relaxed">
                ارفع ملفاتك بأي حجم كان واحصل على رابط مباشر ودائم برابط فوري عالي السرعة مع حفظ الامتداد الأصلي للملف.
              </p>
            </div>

            {/* Upload Box */}
            <div className="w-full max-w-2xl bg-slate-900/80 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl relative overflow-hidden">
              <div
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-8 sm:p-12 text-center transition-all cursor-pointer flex flex-col items-center justify-center space-y-4 ${
                  dragActive
                    ? 'border-cyan-400 bg-cyan-500/10 scale-[1.01]'
                    : fileToUpload
                    ? 'border-cyan-500/50 bg-slate-800/50'
                    : 'border-slate-700/80 hover:border-slate-500 bg-slate-950/40 hover:bg-slate-900/50'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  onChange={handleFileChange}
                  className="hidden"
                />

                {!fileToUpload ? (
                  <>
                    <div className="w-16 h-16 rounded-2xl bg-slate-800/80 border border-slate-700/60 flex items-center justify-center text-cyan-400 shadow-inner">
                      <UploadCloud className="w-8 h-8" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-base font-semibold text-white">
                        اسحب الملف وأسقطه هنا أو اضغط للاختيار
                      </p>
                      <p className="text-xs text-slate-400">
                        يدعم جميع أنواع الملفات (فيديو، صور، مستندات، صوت، تطبيقات، أرشيف مضغوط) بدون قيود الحجم
                      </p>
                    </div>
                    <button
                      type="button"
                      className="px-6 py-2.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-sm transition-all shadow-lg shadow-cyan-600/30"
                    >
                      اختيار ملف
                    </button>
                  </>
                ) : (
                  <div className="flex flex-col items-center space-y-3 w-full">
                    {renderFileIcon(getFileCategory(fileToUpload.name, fileToUpload.type))}
                    <div className="text-center">
                      <p className="font-semibold text-white break-all dir-ltr">{fileToUpload.name}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{formatFileSize(fileToUpload.size)}</p>
                    </div>
                    <span className="text-xs text-cyan-400 font-medium">تم اختيار الملف بنجاح</span>
                  </div>
                )}
              </div>

              {/* Upload Error Message */}
              {uploadError && (
                <div className="mt-4 p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-center gap-3 text-rose-300 text-xs leading-relaxed">
                  <AlertTriangle className="w-5 h-5 shrink-0 text-rose-400" />
                  <span>{uploadError}</span>
                </div>
              )}

              {/* Upload Progress Bar */}
              {isUploading && (
                <div className="mt-6 space-y-2">
                  <div className="flex justify-between text-xs font-medium text-slate-300">
                    <span>جاري الرفع إلى خوادم CloudX...</span>
                    <span>{uploadProgress}%</span>
                  </div>
                  <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-gradient-to-r from-cyan-500 via-blue-500 to-indigo-500 h-full rounded-full transition-all duration-300"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              {fileToUpload && !isUploading && (
                <div className="mt-6 flex items-center gap-3">
                  <button
                    onClick={handleUpload}
                    className="flex-1 py-3 px-6 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm transition-all shadow-lg shadow-emerald-600/30 flex items-center justify-center gap-2"
                  >
                    <Send className="w-4 h-4" />
                    <span>تأكيد الرفع الآن</span>
                  </button>
                  <button
                    onClick={() => setFileToUpload(null)}
                    className="py-3 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-sm transition-all"
                  >
                    إلغاء
                  </button>
                </div>
              )}
            </div>

            {/* Uploaded File Result Card */}
            {uploadedResult && (
              <div className="w-full max-w-2xl bg-slate-900 border border-emerald-500/40 rounded-2xl p-6 sm:p-8 space-y-6 shadow-2xl relative">
                <div className="flex items-center gap-3 pb-4 border-b border-slate-800">
                  <div className="w-10 h-10 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
                    <CheckCircle2 className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg text-white">تم رفع الملف بنجاح!</h3>
                    <p className="text-xs text-slate-400">تم حفظ الملف في خوادم CloudX وتوليد رابط مباشر دائم</p>
                  </div>
                </div>

                {/* File Information Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-slate-950/60 p-4 rounded-xl border border-slate-800">
                  <div>
                    <span className="text-xs text-slate-500 block mb-1">اسم الملف:</span>
                    <span className="text-sm font-semibold text-slate-200 break-all dir-ltr block">
                      {uploadedResult.originalFilename}
                    </span>
                  </div>
                  <div>
                    <span className="text-xs text-slate-500 block mb-1">حجم الملف:</span>
                    <span className="text-sm font-semibold text-slate-200 block">
                      {formatFileSize(uploadedResult.fileSize)}
                    </span>
                  </div>
                </div>

                {/* Direct Link Section */}
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-slate-300 block">الرابط المباشر:</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={uploadedResult.directUrl}
                      className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-cyan-400 font-mono dir-ltr focus:outline-none"
                    />
                    <button
                      onClick={() => copyToClipboard(uploadedResult.directUrl)}
                      className={`px-4 py-2.5 rounded-xl font-medium text-sm transition-all flex items-center gap-2 shrink-0 ${
                        isCopied
                          ? 'bg-emerald-600 text-white'
                          : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-lg shadow-cyan-600/20'
                      }`}
                    >
                      {isCopied ? (
                        <>
                          <Check className="w-4 h-4" />
                          <span>تم النسخ!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-4 h-4" />
                          <span>نسخ الرابط</span>
                        </>
                      )}
                    </button>
                    <a
                      href={uploadedResult.directUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-sm transition-all flex items-center gap-2 shrink-0"
                    >
                      <ExternalLink className="w-4 h-4" />
                      <span>فتح</span>
                    </a>
                  </div>
                </div>

                {/* Interactive Inline Media Preview */}
                <div className="pt-2 border-t border-slate-800 space-y-3">
                  <h4 className="text-xs font-semibold text-slate-400">معاينة الملف المباشرة:</h4>
                  {(() => {
                    const category = getFileCategory(uploadedResult.fileExtension, uploadedResult.mimeType);
                    if (category === 'video') {
                      return (
                        <div className="rounded-xl overflow-hidden bg-black border border-slate-800 max-h-96">
                          <video
                            controls
                            className="w-full h-auto max-h-96 object-contain"
                            src={uploadedResult.relativePath}
                          >
                            متصفحك لا يدعم تشغيل الفيديو.
                          </video>
                        </div>
                      );
                    }
                    if (category === 'image') {
                      return (
                        <div className="rounded-xl overflow-hidden bg-slate-950 p-2 border border-slate-800 flex justify-center max-h-80">
                          <img
                            src={uploadedResult.relativePath}
                            alt={uploadedResult.originalFilename}
                            className="max-h-72 object-contain rounded"
                          />
                        </div>
                      );
                    }
                    if (category === 'audio') {
                      return (
                        <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                          <audio controls className="w-full" src={uploadedResult.relativePath}>
                            متصفحك لا يدعم تشغيل الصوت.
                          </audio>
                        </div>
                      );
                    }
                    if (category === 'pdf') {
                      return (
                        <div className="rounded-xl overflow-hidden border border-slate-800 h-80 bg-slate-950">
                          <iframe
                            src={uploadedResult.relativePath}
                            className="w-full h-full"
                            title="PDF Preview"
                          />
                        </div>
                      );
                    }
                    return (
                      <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 flex items-center justify-between text-sm">
                        <span className="text-slate-400">ملف تنزيل مباشر ({uploadedResult.fileExtension})</span>
                        <a
                          href={`${uploadedResult.relativePath}?download=1`}
                          className="text-cyan-400 hover:underline flex items-center gap-1 font-medium"
                        >
                          <Download className="w-4 h-4" />
                          <span>تحميل الملف إلى جهازك</span>
                        </a>
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Stealth Login Tab */}
        {activeTab === 'login' && (
          <div className="flex-1 flex flex-col space-y-6">
            {!userToken ? (
              /* Camouflaged User Login Prompt */
              <div className="max-w-md w-full mx-auto my-auto bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 space-y-6 shadow-2xl">
                <div className="text-center space-y-2">
                  <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 mx-auto flex items-center justify-center">
                    <User className="w-6 h-6" />
                  </div>
                  <h3 className="text-xl font-bold text-white">تسجيل الدخول</h3>
                  <p className="text-xs text-slate-400">أدخل رمز المرور للوصول لحسابك والملفات المرفوعة</p>
                </div>

                <form onSubmit={handleLogin} className="space-y-4">
                  <div>
                    <label className="text-xs font-medium text-slate-300 block mb-1.5">رمز المرور:</label>
                    <input
                      type="password"
                      value={passwordInput}
                      onChange={e => setPasswordInput(e.target.value)}
                      placeholder="••••••••"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 transition-all dir-ltr"
                      required
                    />
                  </div>

                  {loginError && (
                    <p className="text-xs text-rose-400 font-medium bg-rose-500/10 p-2.5 rounded-lg border border-rose-500/20">
                      {loginError}
                    </p>
                  )}

                  <button
                    type="submit"
                    className="w-full py-2.5 px-4 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-sm rounded-xl transition-all shadow-lg shadow-cyan-600/20"
                  >
                    تسجيل الدخول
                  </button>
                </form>
              </div>
            ) : (
              /* File Management Dashboard */
              <div className="space-y-6">
                {/* Dashboard Header */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900 p-6 rounded-2xl border border-slate-800">
                  <div className="space-y-1">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                      <FolderOpen className="w-5 h-5 text-cyan-400" />
                      <span>إدارة الملفات الحالية</span>
                    </h2>
                    <p className="text-xs text-slate-400">عرض وحذف وتصفح ملفاتك المخزنة سحابياً</p>
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={loadManagedFiles}
                      className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-all flex items-center gap-1.5"
                    >
                      <RefreshCw className="w-4 h-4" />
                      <span>تحديث القائمة</span>
                    </button>

                    <button
                      onClick={handleLogout}
                      className="p-2.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 text-xs font-medium transition-all flex items-center gap-1.5"
                    >
                      <LogOut className="w-4 h-4" />
                      <span>تسجيل الخروج</span>
                    </button>
                  </div>
                </div>

                {/* Dashboard Stats */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center justify-center">
                      <FolderOpen className="w-6 h-6" />
                    </div>
                    <div>
                      <span className="text-xs text-slate-400 block">إجمالي الملفات:</span>
                      <span className="text-xl font-bold text-white">{managedFiles.length} ملف</span>
                    </div>
                  </div>

                  <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center">
                      <HardDrive className="w-6 h-6" />
                    </div>
                    <div>
                      <span className="text-xs text-slate-400 block">المساحة المستهلكة:</span>
                      <span className="text-xl font-bold text-white">
                        {formatFileSize(managedFiles.reduce((acc, f) => acc + (f.file_size || 0), 0))}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Search Input */}
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-3.5" />
                  <input
                    type="text"
                    placeholder="ابحث باسم الملف..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl pr-10 pl-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-all"
                  />
                </div>

                {/* Files Table */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
                  {isLoadingFiles ? (
                    <div className="p-12 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
                      <RefreshCw className="w-6 h-6 animate-spin text-cyan-400" />
                      <span>جاري تحميل الملفات...</span>
                    </div>
                  ) : managedFiles.length === 0 ? (
                    <div className="p-12 text-center text-slate-400 text-sm">
                      لا توجد ملفات مرفوعة حالياً
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-right text-sm text-slate-300">
                        <thead className="bg-slate-950/80 text-slate-400 text-xs font-semibold border-b border-slate-800 uppercase">
                          <tr>
                            <th className="px-4 py-3.5">الملف</th>
                            <th className="px-4 py-3.5">الحجم</th>
                            <th className="px-4 py-3.5">تاريخ الرفع</th>
                            <th className="px-4 py-3.5 text-center">الرابط المباشر</th>
                            <th className="px-4 py-3.5 text-center">إجراءات</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60">
                          {managedFiles.map(file => (
                            <tr key={file.id} className="hover:bg-slate-800/40 transition-colors">
                              <td className="px-4 py-3.5 font-medium text-white max-w-xs truncate dir-ltr">
                                <div className="flex items-center gap-2">
                                  {renderFileIcon(getFileCategory(file.file_extension, file.mime_type))}
                                  <span className="truncate">{file.original_filename}</span>
                                </div>
                              </td>
                              <td className="px-4 py-3.5 text-slate-400 text-xs whitespace-nowrap">
                                {formatFileSize(file.file_size)}
                              </td>
                              <td className="px-4 py-3.5 text-slate-400 text-xs whitespace-nowrap">
                                {formatDate(file.created_at)}
                              </td>
                              <td className="px-4 py-3.5 text-center whitespace-nowrap dir-ltr">
                                <span className="text-xs text-cyan-400 font-mono bg-slate-950 px-2.5 py-1 rounded-md border border-slate-800">
                                  /f/{file.id}{file.file_extension}
                                </span>
                              </td>
                              <td className="px-4 py-3.5 text-center whitespace-nowrap">
                                <div className="flex items-center justify-center gap-2">
                                  <button
                                    onClick={() => copyFileLink(file.directUrl, file.id)}
                                    title="نسخ الرابط"
                                    className={`p-2 rounded-lg text-xs font-medium transition-all ${
                                      copiedId === file.id
                                        ? 'bg-emerald-500/20 text-emerald-400'
                                        : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                                    }`}
                                  >
                                    {copiedId === file.id ? (
                                      <Check className="w-4 h-4" />
                                    ) : (
                                      <Copy className="w-4 h-4" />
                                    )}
                                  </button>

                                  <a
                                    href={file.relativePath}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title="فتح الملف"
                                    className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-all"
                                  >
                                    <ExternalLink className="w-4 h-4" />
                                  </a>

                                  <button
                                    onClick={() => handleDeleteFile(file.id)}
                                    disabled={deletingId === file.id}
                                    title="حذف الملف"
                                    className="p-2 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 transition-all"
                                  >
                                    {deletingId === file.id ? (
                                      <RefreshCw className="w-4 h-4 animate-spin" />
                                    ) : (
                                      <Trash2 className="w-4 h-4" />
                                    )}
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 py-6 text-center text-xs text-slate-500 bg-slate-950">
        <div className="max-w-5xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <span>CloudX High-Performance Cloud Storage</span>
          <span className="text-slate-600">جميع الحقوق محفوظة © {new Date().getFullYear()} CloudX</span>
        </div>
      </footer>
    </div>
  );
}
