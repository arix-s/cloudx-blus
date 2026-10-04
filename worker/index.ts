export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  ALLOWED_ORIGINS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 1. Handle CORS Preflight
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
      'Access-Control-Max-Age': '86400'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    const url = new URL(request.url);

    // Health check endpoint
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return new Response(
        JSON.stringify({
          status: 'online',
          service: 'CloudX Cloudflare Worker File Upload Backend',
          version: '1.0.0'
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        }
      );
    }

    // Direct Upload Endpoint
    if (request.method === 'POST') {
      try {
        const botToken = env.TELEGRAM_BOT_TOKEN || '6707537751:AAHs-U9vHvmxDu6iyQSGuec9SWFIeMvbg2A';
        const defaultChatId = env.TELEGRAM_CHAT_ID || '-1003839994672';

        const contentType = request.headers.get('content-type') || '';
        if (!contentType.includes('multipart/form-data')) {
          return new Response(
            JSON.stringify({ success: false, error: 'يرجى إرسال ملف عبر multipart/form-data' }),
            {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
          );
        }

        // Parse incoming multipart form data
        const formData = await request.formData();
        const file = formData.get('file') || formData.get('document');

        if (!file || !(file instanceof File)) {
          return new Response(
            JSON.stringify({ success: false, error: 'لم يتم العثور على أي ملف للرفع' }),
            {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
          );
        }

        const customChatId = formData.get('chat_id');
        const chatId = (typeof customChatId === 'string' && customChatId.trim()) ? customChatId.trim() : defaultChatId;

        // Construct FormData for Telegram Bot API
        const tgFormData = new FormData();
        tgFormData.append('chat_id', chatId);
        tgFormData.append('document', file, file.name);

        // Forward stream directly to Telegram Bot API
        const tgResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
          method: 'POST',
          body: tgFormData
        });

        const tgResult = await tgResponse.json() as any;

        if (!tgResponse.ok || !tgResult.ok || !tgResult.result) {
          console.error('Telegram API error in Cloudflare Worker:', tgResult);
          return new Response(
            JSON.stringify({
              success: false,
              error: tgResult?.description || 'حدث خطأ أثناء نقل الملف إلى خوادم التخزين السحابي'
            }),
            {
              status: 502,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
          );
        }

        const msg = tgResult.result;
        let fileId = '';
        if (msg.document?.file_id) fileId = msg.document.file_id;
        else if (msg.video?.file_id) fileId = msg.video.file_id;
        else if (msg.audio?.file_id) fileId = msg.audio.file_id;
        else if (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0) {
          fileId = msg.photo[msg.photo.length - 1].file_id;
        } else if (msg.animation?.file_id) fileId = msg.animation.file_id;

        return new Response(
          JSON.stringify({
            success: true,
            fileId: fileId,
            messageId: msg.message_id,
            chatId: chatId,
            originalFilename: file.name,
            fileSize: file.size,
            mimeType: file.type || 'application/octet-stream'
          }),
          {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        );
      } catch (err: any) {
        console.error('Cloudflare Worker Upload Exception:', err);
        return new Response(
          JSON.stringify({
            success: false,
            error: 'خطأ في خادم Cloudflare Worker: ' + (err.message || String(err))
          }),
          {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        );
      }
    }

    return new Response(
      JSON.stringify({ success: false, error: 'المسار غير موجود' }),
      {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
};
