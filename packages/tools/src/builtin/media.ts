/**
 * Media tools (toolset "media"): image generation, TTS, STT, image description (vision).
 * These require a real service to be configured (`tools.image.provider`, `voice.*`);
 * there is no offline fallback — calls fail explicitly when the service is unconfigured.
 */
import { readFileSync } from 'node:fs';
import { defineTool, safeFetch, type AnyTool, type ToolContext } from '@mercury/core';
import { params, str, strEnum } from '../util.js';

async function generateImage(ctx: ToolContext, prompt: string, size: string): Promise<Buffer> {
  const cfg = ctx.services.config.tools.image;
  if (cfg.provider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is not set');
    const res = await safeFetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, prompt, size, n: 1, response_format: 'b64_json' }),
    });
    const data = (await res.json()) as { data?: Array<{ b64_json?: string }>; error?: { message: string } };
    if (!res.ok || !data.data?.[0]?.b64_json) throw new Error(`image generation failed: ${data.error?.message ?? res.status}`);
    return Buffer.from(data.data[0].b64_json, 'base64');
  }
  throw new Error(`unknown image provider "${cfg.provider}"`);
}

export const imageGenerate = defineTool<{ prompt: string; size?: string }>({
  name: 'image_generate',
  description: 'Generate an image from a text prompt. The image is attached to the reply.',
  toolset: 'media',
  risk: 'safe',
  parameters: params({ prompt: str('Image description'), size: strEnum(['1024x1024', '1792x1024', '1024x1792'], 'Size') }, ['prompt']),
  async execute(a, ctx) {
    const png = await generateImage(ctx, a.prompt, a.size ?? '1024x1024');
    const att = await ctx.services.attachments.save(ctx.principal.userId, 'image.png', png, 'image/png');
    return { content: `Generated image ${att.id}.`, attachments: [att] };
  },
});

export const textToSpeech = defineTool<{ text: string; voice?: string }>({
  name: 'text_to_speech',
  description: 'Convert text to speech audio and attach it (voice reply).',
  toolset: 'media',
  risk: 'safe',
  parameters: params({ text: str('Text to speak'), voice: str('Voice name') }, ['text']),
  async execute(a, ctx) {
    const r = await ctx.services.voice.speak(a.text, a.voice);
    const att = await ctx.services.attachments.save(ctx.principal.userId, r.mime === 'audio/wav' ? 'speech.wav' : 'speech.mp3', readFileSync(r.path), r.mime);
    return { content: `Audio ${att.id} (${ctx.services.voice.ttsProvider}).`, attachments: [att] };
  },
});

export const speechToText = defineTool<{ attachment_id: string }>({
  name: 'speech_to_text',
  description: 'Transcribe an uploaded audio attachment.',
  toolset: 'media',
  risk: 'safe',
  untrustedOutput: true,
  parameters: params({ attachment_id: str('Attachment id') }, ['attachment_id']),
  async execute(a, ctx) {
    const att = ctx.services.attachments.get(a.attachment_id);
    if (!att?.path || (ctx.services.attachments.owner(att.id) !== ctx.principal.userId && ctx.principal.role !== 'admin')) return { content: 'Attachment not found.', isError: true };
    return ctx.services.voice.transcribe(att.path, att.mime);
  },
});

export const describeImage = defineTool<{ attachment_id: string; question?: string }>({
  name: 'describe_image',
  description: 'Ask a vision-capable model about an uploaded image attachment.',
  toolset: 'media',
  risk: 'safe',
  untrustedOutput: true,
  parameters: params({ attachment_id: str('Attachment id'), question: str('What to look for') }, ['attachment_id']),
  async execute(a, ctx) {
    const att = ctx.services.attachments.get(a.attachment_id);
    if (!att || (ctx.services.attachments.owner(att.id) !== ctx.principal.userId && ctx.principal.role !== 'admin')) return { content: 'Attachment not found.', isError: true };
    const processed = await ctx.services.attachments.process(att);
    const res = await ctx.services.llm.chat({
      principal: ctx.principal,
      messages: [{ role: 'user', content: a.question ?? 'Describe this image in detail.', attachments: [processed] }],
      tags: ['vision'],
      runId: ctx.runId,
      kind: 'vision',
    });
    return res.content;
  },
});

export const mediaTools: AnyTool[] = [imageGenerate, textToSpeech, speechToText, describeImage];
