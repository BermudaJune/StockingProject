import { NextResponse } from "next/server";

const DEFAULT_SUBMIT_URL = "https://api.wuyinkeji.com/api/async/image_gpt";
const DEFAULT_DETAIL_URL = "https://api.wuyinkeji.com/api/async/detail";
const DEFAULT_OYY_BASE_URL = "https://www.oyy-ai.com";
const DEFAULT_OYY_IMAGE_API_PATH = "/v1/images/edits";
const DEFAULT_OYY_SOFT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_GEMINI_API_PATH = "/v1beta/models/gemini-3-pro-image-preview:generateContent";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
const DEFAULT_OPENAI_CHAT_API_PATH = "/v1/chat/completions";

type Provider = "banana" | "openai";
type UploadFieldKey = "sock" | "shoe" | "outfit" | "background";
type OyyRequestImageField = "image" | "image[]";

type SubmitApiResponse = {
  code: number;
  msg: string;
  data?: {
    id?: string;
    count?: number | string;
  } | null;
};

type DetailApiResponse = {
  code: number;
  msg: string;
  data?: {
    status?: number;
    result?: string[] | null;
    message?: string;
    count?: number | string;
  } | null;
};

type OyyImageResponse = {
  created?: number;
  data?: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inline_data?: {
          mime_type?: string;
          data?: string;
        };
        inlineData?: {
          mimeType?: string;
          data?: string;
        };
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
};

type OpenAIChatCompletionsResponse = {
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{
            type?: string;
            text?: string;
            image_url?: {
              url?: string;
            };
            b64_json?: string;
            data?: string;
          }>;
      images?: Array<{
        b64_json?: string;
        url?: string;
      }>;
    };
  }>;
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
  error?: {
    message?: string;
  };
};

type ParsedUpstreamResponse<T> = {
  ok: boolean;
  status: number;
  raw: string;
  json: T | null;
};

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const provider = resolveProvider(readOptionalField(formData, "modelProvider"));
    const prompt = readRequiredField(formData, "prompt");

    if (provider === "banana") {
      return await handleGeminiPost(formData, prompt, request.signal);
    }
    return await handleOpenaiChatPost(formData, prompt, request.signal);
  } catch (error) {
    return NextResponse.json({ error: toErrorMessage(error) }, { status: 400 });
  }
}

export async function GET(_request: Request) {
  try {
    return NextResponse.json({
      status: 2,
      message: "当前模型接口为同步返回，请直接使用 POST 返回的图片结果。"
    });
  } catch (error) {
    return NextResponse.json({ error: toErrorMessage(error) }, { status: 400 });
  }
}

async function handleWuyinPost(formData: FormData, prompt: string) {
  const apiKey = getWuyinApiKey();
  const aspectRatio = readOptionalField(formData, "aspectRatio") || "auto";
  const submitUrl = process.env.WUYIN_IMAGE_API_URL?.trim() || DEFAULT_SUBMIT_URL;
  const urls = await extractImageUrlsFromFormData(formData);

  const submitJson = await submitTaskWithRetry({
    submitUrl,
    apiKey,
    prompt,
    aspectRatio,
    urls
  });

  const submitData = submitJson.data;
  if (!submitData?.id) {
    throw new Error(`提交失败：${submitJson.msg || "未返回任务ID"}`);
  }

  const taskId = submitData.id;
  const detailJson = await waitForTaskResult(taskId, apiKey);
  const status = typeof detailJson?.data?.status === "number" ? detailJson.data.status : 0;
  const imageUrl = detailJson?.data?.result?.[0] || null;
  const detailMessage = detailJson?.data?.message?.trim() || detailJson?.msg || "";

  if (status === 3) {
    return NextResponse.json(
      {
        error: detailMessage || "任务失败（触发平台策略）",
        taskId,
        status
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    taskId,
    count: submitData.count ?? detailJson?.data?.count ?? 1,
    status,
    imageUrl,
    message: imageUrl ? "生成完成" : detailMessage || "任务已提交，仍在处理中"
  });
}

async function handleOyyPost(formData: FormData, prompt: string, signal?: AbortSignal) {
  const baseUrl = (process.env.OYY_BASE_URL?.trim() || DEFAULT_OYY_BASE_URL).replace(/\/+$/, "");
  const apiKey = getOyyApiKey();
  const model = process.env.OYY_MODEL?.trim() || "gpt-image-2";
  const imageApiPath = normalizeOyyImageApiPath(process.env.OYY_IMAGE_API_PATH?.trim() || DEFAULT_OYY_IMAGE_API_PATH);
  const aspectRatio = readOptionalField(formData, "aspectRatio") || "3:4";
  const size = mapAspectRatioToOyySize(aspectRatio);
  const files = getImageFilesFromFormData(formData);
  const useGenerations = imageApiPath === "/v1/images/generations";

  if (useGenerations) {
    const parsed = await requestOyyGenerations({ baseUrl, apiKey, model, prompt, size, signal });
    return buildOyySuccessResponse(parsed, "OYY generations");
  }

  const responseVariants: OyyRequestImageField[] = ["image[]", "image"];
  let lastErrorMessage = "OYY 鐠囬攱鐪版径杈Е";
  for (let i = 0; i < responseVariants.length; i++) {
    try {
      const parsed = await requestOyyEdits({
        baseUrl,
        apiKey,
        model,
        prompt,
        size,
        files,
        imageFieldName: responseVariants[i],
        imageApiPath,
        signal
      });
      return buildOyySuccessResponse(parsed, "OYY edits");
    } catch (error) {
      lastErrorMessage = toErrorMessage(error);
      if (i === responseVariants.length - 1) {
        throw new Error(lastErrorMessage);
      }
    }
  }

  throw new Error(lastErrorMessage);
}

function buildOyySuccessResponse(parsed: ParsedUpstreamResponse<OyyImageResponse>, prefix: string) {
  const json = parsed.json;
  if (!json) {
    throw new Error(buildUpstreamError(`${prefix} 鏉╂柨娲栫憴锝嗙€芥径杈Е`, { httpStatus: parsed.status, providerMsg: "", raw: parsed.raw }));
  }
  const errorMessage = json.error?.message?.trim();
  if (!parsed.ok || errorMessage) {
    throw new Error(
      buildUpstreamError(`${prefix} 閹绘劒姘︽径杈Е`, {
        httpStatus: parsed.status,
        providerMsg: errorMessage || "",
        raw: parsed.raw
      })
    );
  }
  const first = json.data?.[0];
  const imageUrl = first?.url?.trim() || null;
  const imageDataUrl = first?.b64_json ? `data:image/png;base64,${first.b64_json}` : null;
  if (!imageUrl && !imageDataUrl) {
    throw new Error("OYY 未返回图片结果");
  }
  return NextResponse.json({
    status: 2,
    imageUrl,
    imageDataUrl,
    message: "生成完成"
  });
}

async function handleGeminiPost(formData: FormData, prompt: string, signal?: AbortSignal) {
  const baseUrl = (
    process.env.GEMINI_BASE_URL?.trim() ||
    process.env.OYY_BASE_URL?.trim() ||
    DEFAULT_GEMINI_BASE_URL
  ).replace(/\/+$/, "");
  const apiPath = normalizeApiPath(process.env.GEMINI_API_PATH?.trim() || DEFAULT_GEMINI_API_PATH);
  const endpoint = resolveHttpEndpoint(baseUrl, apiPath);
  const apiKey = getGeminiApiKey();
  const files = getImageFilesFromFormData(formData);

  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    parts.push({
      inline_data: {
        mime_type: file.type || "image/png",
        data: buffer.toString("base64")
      }
    });
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts
        }
      ],
      generationConfig: {
        responseModalities: ["IMAGE", "TEXT"]
      }
    }),
    cache: "no-store",
    signal
  });

  const parsed = await parseUpstreamResponse<GeminiGenerateContentResponse>(response);
  const json = parsed.json;
  if (!json) {
    throw new Error(buildUpstreamError("Gemini 鏉╂柨娲栫憴锝嗙€芥径杈Е", { httpStatus: parsed.status, providerMsg: "", raw: parsed.raw }));
  }
  const errorMessage = json.error?.message?.trim();
  if (!parsed.ok || errorMessage) {
    throw new Error(
      buildUpstreamError("Gemini 閹绘劒姘︽径杈Е", {
        httpStatus: parsed.status,
        providerMsg: errorMessage || "",
        raw: parsed.raw
      })
    );
  }

  const candidateParts = json.candidates?.[0]?.content?.parts || [];
  const imagePart = candidateParts.find((part) => part.inline_data?.data || part.inlineData?.data);
  const imageData = imagePart?.inline_data?.data || imagePart?.inlineData?.data || "";
  const imageMime = imagePart?.inline_data?.mime_type || imagePart?.inlineData?.mimeType || "image/png";
  if (!imageData) {
    throw new Error("Gemini 未返回图片数据");
  }

  return NextResponse.json({
    status: 2,
    imageDataUrl: `data:${imageMime};base64,${imageData}`,
    message: "生成完成"
  });
}

async function handleOpenaiChatPost(formData: FormData, prompt: string, signal?: AbortSignal) {
  const baseUrl = (
    process.env.OPENAI_BASE_URL?.trim() ||
    process.env.OYY_BASE_URL?.trim() ||
    DEFAULT_OPENAI_BASE_URL
  ).replace(/\/+$/, "");
  const apiPath = normalizeApiPath(process.env.OPENAI_CHAT_API_PATH?.trim() || DEFAULT_OPENAI_CHAT_API_PATH);
  const endpoint = resolveHttpEndpoint(baseUrl, apiPath);
  const apiKey = getOpenAIApiKey();
  const model = process.env.OPENAI_CHAT_MODEL?.trim() || "gpt-4o";
  const files = getImageFilesFromFormData(formData);

  const contentParts: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const mime = file.type || "image/png";
    contentParts.push({
      type: "image_url",
      image_url: {
        url: `data:${mime};base64,${buffer.toString("base64")}`
      }
    });
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: contentParts
        }
      ],
      max_tokens: 4096
    }),
    cache: "no-store",
    signal
  });

  const parsed = await parseUpstreamResponse<OpenAIChatCompletionsResponse>(response);
  const json = parsed.json;
  if (!json) {
    throw new Error(buildUpstreamError("OpenAI 杩斿洖瑙ｆ瀽澶辫触", { httpStatus: parsed.status, providerMsg: "", raw: parsed.raw }));
  }
  const errorMessage = json.error?.message?.trim();
  if (!parsed.ok || errorMessage) {
    throw new Error(
      buildUpstreamError("OpenAI 鎻愪氦澶辫触", {
        httpStatus: parsed.status,
        providerMsg: errorMessage || "",
        raw: parsed.raw
      })
    );
  }

  const directDataImage = json.data?.[0];
  if (directDataImage?.b64_json) {
    return NextResponse.json({
      status: 2,
      imageDataUrl: `data:image/png;base64,${directDataImage.b64_json}`,
      message: "鐢熸垚瀹屾垚"
    });
  }
  if (directDataImage?.url) {
    return NextResponse.json({
      status: 2,
      imageUrl: directDataImage.url,
      message: "鐢熸垚瀹屾垚"
    });
  }

  const message = json.choices?.[0]?.message;
  const messageImages = message?.images || [];
  if (messageImages[0]?.b64_json) {
    return NextResponse.json({
      status: 2,
      imageDataUrl: `data:image/png;base64,${messageImages[0].b64_json}`,
      message: "鐢熸垚瀹屾垚"
    });
  }
  if (messageImages[0]?.url) {
    return NextResponse.json({
      status: 2,
      imageUrl: messageImages[0].url,
      message: "鐢熸垚瀹屾垚"
    });
  }

  const messageContent = message?.content;
  if (Array.isArray(messageContent)) {
    const contentImage = messageContent.find((part) => part.image_url?.url || part.b64_json || part.data);
    if (contentImage?.image_url?.url) {
      return NextResponse.json({
        status: 2,
        imageUrl: contentImage.image_url.url,
        message: "鐢熸垚瀹屾垚"
      });
    }
    if (contentImage?.b64_json || contentImage?.data) {
      return NextResponse.json({
        status: 2,
        imageDataUrl: `data:image/png;base64,${contentImage.b64_json || contentImage.data || ""}`,
        message: "鐢熸垚瀹屾垚"
      });
    }

    const textContent = messageContent
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter((text) => !!text)
      .join("\n");
    const extractedFromArrayText = extractImageFromText(textContent);
    if (extractedFromArrayText) {
      return NextResponse.json({
        status: 2,
        ...extractedFromArrayText,
        message: "鐢熸垚瀹屾垚"
      });
    }
  }

  if (typeof messageContent === "string") {
    const extractedFromString = extractImageFromText(messageContent);
    if (extractedFromString) {
      return NextResponse.json({
        status: 2,
        ...extractedFromString,
        message: "鐢熸垚瀹屾垚"
      });
    }

    const preview = messageContent.trim().slice(0, 240);
    if (preview) {
      throw new Error(`OpenAI /v1/chat/completions 鏈繑鍥炲彲瑙ｆ瀽鐨勫浘鐗囩粨鏋滐紱content棰勮=${preview}`);
    }
  }

  throw new Error("OpenAI /v1/chat/completions 未返回可解析的图片结果");
}

async function requestOyyEdits(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  size: string;
  files: File[];
  imageFieldName: OyyRequestImageField;
  imageApiPath: string;
  signal?: AbortSignal;
}): Promise<ParsedUpstreamResponse<OyyImageResponse>> {
  const { baseUrl, apiKey, model, prompt, size, files, imageFieldName, imageApiPath, signal } = params;
  const endpoint = `${baseUrl}${imageApiPath}`;
  const maxAttempts = 3;
  let lastError = "OYY 鐠囬攱鐪版径杈Е";
  const timeoutMs = getOyySoftTimeoutMs();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const body = new FormData();
    body.append("model", model);
    body.append("prompt", prompt);
    body.append("size", size);
    for (const file of files) {
      body.append(imageFieldName, file, file.name || "image.png");
    }

    try {
      const response = await fetchWithSoftTimeout(
        endpoint,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`
          },
          body,
          cache: "no-store",
          signal
        },
        timeoutMs
      );

      const parsed = await parseUpstreamResponse<OyyImageResponse>(response);
      if (isModerationBlockedOyyResponse(parsed)) {
        return parsed;
      }
      if (isRetryableOyyStatus(parsed.status) && attempt < maxAttempts) {
        await sleep(800 * attempt);
        continue;
      }
      return parsed;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      lastError = toErrorMessage(error);
      if (attempt >= maxAttempts) {
        throw new Error(lastError);
      }
      await sleep(800 * attempt);
    }
  }

  throw new Error(lastError);
}

async function requestOyyGenerations(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  size: string;
  signal?: AbortSignal;
}): Promise<ParsedUpstreamResponse<OyyImageResponse>> {
  const { baseUrl, apiKey, model, prompt, size, signal } = params;
  const endpoint = `${baseUrl}/v1/images/generations`;
  const maxAttempts = 3;
  let lastError = "OYY 鐠囬攱鐪版径杈Е";
  const timeoutMs = getOyySoftTimeoutMs();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchWithSoftTimeout(
        endpoint,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            prompt,
            size,
            n: 1
          }),
          cache: "no-store",
          signal
        },
        timeoutMs
      );

      const parsed = await parseUpstreamResponse<OyyImageResponse>(response);
      if (isModerationBlockedOyyResponse(parsed)) {
        return parsed;
      }
      if (isRetryableOyyStatus(parsed.status) && attempt < maxAttempts) {
        await sleep(800 * attempt);
        continue;
      }
      return parsed;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      lastError = toErrorMessage(error);
      if (attempt >= maxAttempts) {
        throw new Error(lastError);
      }
      await sleep(800 * attempt);
    }
  }

  throw new Error(lastError);
}

async function submitTaskWithRetry(params: {
  submitUrl: string;
  apiKey: string;
  prompt: string;
  aspectRatio: string;
  urls: string[];
}): Promise<SubmitApiResponse> {
  const { submitUrl, apiKey, prompt, aspectRatio, urls } = params;
  const maxAttempts = 3;
  let lastError = "閹绘劒姘︽径杈Е";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const sizeForAttempt = attempt >= 2 ? "auto" : aspectRatio;
      const submitResp = await fetch(submitUrl, {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prompt,
          size: sizeForAttempt,
          ...(urls.length > 0 ? { urls } : {})
        }),
        cache: "no-store"
      });

      const parsed = await parseUpstreamResponse<SubmitApiResponse>(submitResp);
      const submitJson = parsed.json;
      const ok = parsed.ok && submitJson?.code === 200 && !!submitJson.data?.id;
      if (ok) {
        return submitJson;
      }

      lastError = buildUpstreamError("閹绘劒姘︽径杈Е", {
        httpStatus: parsed.status,
        providerMsg: submitJson?.msg || "",
        raw: parsed.raw
      });
      const canRetry = /500|timeout|network|fetch failed/i.test(lastError);
      if (!canRetry || attempt === maxAttempts) {
        throw new Error(lastError);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const canRetry = /500|timeout|network|fetch failed/i.test(lastError);
      if (!canRetry || attempt === maxAttempts) {
        throw new Error(`提交失败：${lastError}`);
      }
    }
    await sleep(1200 * attempt);
  }

  throw new Error(`提交失败：${lastError}`);
}

async function waitForTaskResult(taskId: string, apiKey: string): Promise<DetailApiResponse | null> {
  const detailUrl = process.env.WUYIN_IMAGE_DETAIL_API_URL?.trim() || DEFAULT_DETAIL_URL;
  const timeoutMs = 60000;
  const intervalMs = 1500;
  const start = Date.now();
  let latest: DetailApiResponse | null = null;

  while (Date.now() - start < timeoutMs) {
    const response = await fetch(`${detailUrl}?id=${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers: { Authorization: apiKey },
      cache: "no-store"
    });

    const parsed = await parseUpstreamResponse<DetailApiResponse>(response);
    const json = parsed.json;
    if (!json) {
      throw new Error(buildUpstreamError("鏉烆喛顕楃紒鎾寸亯鐟欙絾鐎芥径杈Е", { httpStatus: parsed.status, providerMsg: "", raw: parsed.raw }));
    }
    latest = json;

    const status = json.data?.status;
    const firstImage = json.data?.result?.[0];
    if (response.ok && json.code === 200 && ((status === 2 && firstImage) || status === 3)) {
      return json;
    }

    await sleep(intervalMs);
  }

  return latest;
}

async function extractImageUrlsFromFormData(formData: FormData): Promise<string[]> {
  const files = collectImageFilesFromFormData(formData);
  return await Promise.all(
    files.map(async (file) => {
      const buffer = Buffer.from(await file.arrayBuffer());
      const mime = file.type || "image/png";
      return `data:${mime};base64,${buffer.toString("base64")}`;
    })
  );
}

async function fetchTaskDetail(taskId: string, apiKey: string): Promise<DetailApiResponse> {
  const detailUrl = process.env.WUYIN_IMAGE_DETAIL_API_URL?.trim() || DEFAULT_DETAIL_URL;
  const response = await fetch(`${detailUrl}?id=${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: { Authorization: apiKey },
    cache: "no-store"
  });

  const parsed = await parseUpstreamResponse<DetailApiResponse>(response);
  const json = parsed.json;
  if (!json) {
    throw new Error(buildUpstreamError("结果查询失败", { httpStatus: parsed.status, providerMsg: "", raw: parsed.raw }));
  }
  if (!parsed.ok || json.code !== 200 || !json.data) {
    throw new Error(buildUpstreamError("结果查询失败", { httpStatus: parsed.status, providerMsg: json.msg || "", raw: parsed.raw }));
  }
  return json;
}

function getApiKey(): string {
  const apiKey = process.env.WUYIN_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("缺少 WUYIN_API_KEY，请在 .env 中配置");
  }
  return apiKey;
}

function getWuyinApiKey(): string {
  return getApiKey();
}

function getOyyApiKey(): string {
  const apiKey = process.env.OYY_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("缺少 OYY_API_KEY，请在 .env 中配置");
  }
  return apiKey;
}

function getGeminiApiKey(): string {
  const apiKey =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.OYY_API_KEY?.trim() ||
    process.env.WUYIN_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("缺少 GEMINI_API_KEY（也可复用 OYY_API_KEY / WUYIN_API_KEY），请在 .env 中配置");
  }
  return apiKey;
}

function getOpenAIApiKey(): string {
  const apiKey =
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.OYY_API_KEY?.trim() ||
    process.env.WUYIN_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("缺少 OPENAI_API_KEY（也可复用 OYY_API_KEY / WUYIN_API_KEY），请在 .env 中配置");
  }
  return apiKey;
}

function readRequiredField(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`缺少字段：${key}`);
  }
  return value.trim();
}

function readOptionalField(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "閺堫亞鐓￠柨娆掝嚖";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithSoftTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const timeoutController = new AbortController();
  const externalSignal = init.signal;
  const hasSoftTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  let softTimedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detachExternal: (() => void) | null = null;

  if (hasSoftTimeout) {
    timer = setTimeout(() => {
      softTimedOut = true;
      timeoutController.abort();
    }, timeoutMs);
  }

  if (externalSignal) {
    if (externalSignal.aborted) {
      timeoutController.abort();
    } else {
      const onAbort = () => timeoutController.abort();
      externalSignal.addEventListener("abort", onAbort, { once: true });
      detachExternal = () => externalSignal.removeEventListener("abort", onAbort);
    }
  }

  try {
    return await fetch(input, { ...init, signal: timeoutController.signal });
  } catch (error) {
    if (softTimedOut) {
      throw new Error(`上游请求超时（>${Math.round(timeoutMs / 1000)}秒）`);
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    detachExternal?.();
  }
}

function getImageFilesFromFormData(formData: FormData): File[] {
  return collectImageFilesFromFormData(formData);
}

function collectImageFilesFromFormData(formData: FormData): File[] {
  const orderedKeys: Array<UploadFieldKey | "anchor"> = ["sock", "shoe", "outfit", "background", "anchor"];
  const fromOrdered = orderedKeys.map((key) => formData.get(key)).filter((value): value is File => value instanceof File);
  const fromExtras: File[] = [];

  for (const [key, value] of formData.entries()) {
    if (orderedKeys.includes(key as UploadFieldKey | "anchor")) {
      continue;
    }
    if (value instanceof File && value.size > 0 && value.type.startsWith("image/")) {
      fromExtras.push(value);
    }
  }

  return [...fromOrdered, ...fromExtras];
}

function mapAspectRatioToOyySize(aspectRatio: string): string {
  const normalized = aspectRatio.trim();
  switch (normalized) {
    case "1:1":
      return "1024x1024";
    case "4:3":
      return "1536x1024";
    case "3:4":
      return "1024x1536";
    default:
      return "1024x1536";
  }
}

function getProvider(): Provider {
  const provider = process.env.IMAGE_PROVIDER?.trim().toLowerCase();
  if (provider === "banana" || provider === "gemini") {
    return "banana";
  }
  if (provider === "openai") {
    return "openai";
  }
  return "openai";
}

function resolveProvider(raw: string | null): Provider {
  const normalized = (raw || "").trim().toLowerCase();
  if (normalized === "banana" || normalized === "gemini") {
    return "banana";
  }
  if (normalized === "openai") {
    return "openai";
  }
  return getProvider();
}

function isRetryableOyyStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function getOyySoftTimeoutMs(): number {
  const configured = Number.parseInt(process.env.OYY_SOFT_TIMEOUT_MS || "", 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_OYY_SOFT_TIMEOUT_MS;
}

function normalizeOyyImageApiPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return DEFAULT_OYY_IMAGE_API_PATH;
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function normalizeApiPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/";
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function resolveHttpEndpoint(baseUrl: string, apiPath: string): string {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, "");
  const normalizedPath = normalizeApiPath(apiPath);
  if (!trimmedBase) {
    return normalizedPath;
  }

  if (/^https?:\/\/[^/]+\/v\d+\/chat\/completions$/i.test(trimmedBase)) {
    return trimmedBase;
  }

  try {
    const parsed = new URL(trimmedBase);
    const basePath = parsed.pathname.replace(/\/+$/, "");
    if (basePath && basePath !== "/" && normalizedPath.startsWith(`${basePath}/`)) {
      return `${parsed.origin}${normalizedPath}`;
    }
  } catch {
    return `${trimmedBase}${normalizedPath}`;
  }

  return `${trimmedBase}${normalizedPath}`;
}

function extractImageFromText(text: string): { imageUrl?: string; imageDataUrl?: string } | null {
  const input = text.trim();
  if (!input) {
    return null;
  }

  const dataUrlMatch = input.match(/(data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=\r\n]+)/i);
  if (dataUrlMatch?.[1]) {
    return { imageDataUrl: dataUrlMatch[1].replace(/\s+/g, "") };
  }

  const markdownImageMatch = input.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+|data:image\/[^\s)]+)\)/i);
  if (markdownImageMatch?.[1]) {
    if (markdownImageMatch[1].startsWith("data:image/")) {
      return { imageDataUrl: markdownImageMatch[1] };
    }
    return { imageUrl: markdownImageMatch[1] };
  }

  const directUrlMatch = input.match(/https?:\/\/[^\s"'<>]+/i);
  if (directUrlMatch?.[0]) {
    return { imageUrl: directUrlMatch[0] };
  }

  return null;
}

function isModerationBlockedOyyResponse(parsed: ParsedUpstreamResponse<OyyImageResponse>): boolean {
  const providerMessage = parsed.json?.error?.message?.trim() || parsed.raw;
  return /moderation_blocked|safety system|safety_violations|sexual/i.test(providerMessage);
}

async function parseUpstreamResponse<T>(response: Response): Promise<ParsedUpstreamResponse<T>> {
  const raw = await response.text();
  let json: T | null = null;
  try {
    json = JSON.parse(raw) as T;
  } catch {
    json = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    raw,
    json
  };
}

function buildUpstreamError(
  prefix: string,
  params: {
    httpStatus: number;
    providerMsg: string;
    raw: string;
  }
): string {
  const { httpStatus, providerMsg, raw } = params;
  const pieces = [prefix, `HTTP=${httpStatus}`];
  if (providerMsg.trim()) {
    pieces.push(`msg=${providerMsg.trim()}`);
  }
  if (raw.trim()) {
    pieces.push(`raw=${raw.trim()}`);
  }
  return pieces.join(" | ");
}



