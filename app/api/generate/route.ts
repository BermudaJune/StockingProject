import { NextResponse } from "next/server";

const DEFAULT_SUBMIT_URL = "https://api.wuyinkeji.com/api/async/image_gpt";
const DEFAULT_DETAIL_URL = "https://api.wuyinkeji.com/api/async/detail";
const DEFAULT_OYY_BASE_URL = "https://www.oyy-ai.com";
const DEFAULT_OYY_IMAGE_API_PATH = "/v1/images/edits";
const DEFAULT_OYY_SOFT_TIMEOUT_MS = 10 * 60 * 1000;

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

type ParsedUpstreamResponse<T> = {
  ok: boolean;
  status: number;
  raw: string;
  json: T | null;
};

export async function POST(request: Request) {
  try {
    const provider = getProvider();
    const formData = await request.formData();
    const prompt = readRequiredField(formData, "prompt");

    if (provider === "oyy") {
      return await handleOyyPost(formData, prompt, request.signal);
    }
    return await handleWuyinPost(formData, prompt);
  } catch (error) {
    return NextResponse.json({ error: toErrorMessage(error) }, { status: 400 });
  }
}

export async function GET(request: Request) {
  try {
    const provider = getProvider();
    if (provider === "oyy") {
      return NextResponse.json({
        status: 2,
        message: "OYY 接口为同步返回，请直接查看 POST 返回的图片结果。"
      });
    }

    const apiKey = getWuyinApiKey();
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get("taskId")?.trim();
    if (!taskId) {
      throw new Error("缺少 taskId 参数");
    }

    const detail = await fetchTaskDetail(taskId, apiKey);
    const status = typeof detail.data?.status === "number" ? detail.data.status : 0;
    const imageUrl = detail.data?.result?.[0] || null;
    const detailMessage = detail.data?.message?.trim() || detail.msg || "";

    return NextResponse.json({
      taskId,
      status,
      imageUrl,
      message: detailMessage
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

  let lastErrorMessage = "OYY 请求失败";

  if (useGenerations) {
    const parsed = await requestOyyGenerations({
      baseUrl,
      apiKey,
      model,
      prompt,
      size,
      signal
    });
    const json = parsed.json;
    if (!json) {
      throw new Error(buildUpstreamError("OYY 返回解析失败", { httpStatus: parsed.status, providerMsg: "", raw: parsed.raw }));
    }
    const errorMessage = json.error?.message?.trim();
    if (!parsed.ok || errorMessage) {
      throw new Error(
        buildUpstreamError("OYY 提交失败", {
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
      throw new Error(
        buildUpstreamError("OYY 未返回图片", {
          httpStatus: parsed.status,
          providerMsg: "",
          raw: parsed.raw
        })
      );
    }
    return NextResponse.json({
      status: 2,
      imageUrl,
      imageDataUrl,
      message: "生成完成"
    });
  }

  const responseVariants: OyyRequestImageField[] = ["image[]", "image"];
  for (let i = 0; i < responseVariants.length; i++) {
    const fieldName = responseVariants[i];
    try {
      const parsed = await requestOyyEdits({
        baseUrl,
        apiKey,
        model,
        prompt,
        size,
        files,
        imageFieldName: fieldName,
        imageApiPath,
        signal
      });
      const json = parsed.json;
      if (!json) {
        throw new Error(buildUpstreamError("OYY 返回解析失败", { httpStatus: parsed.status, providerMsg: "", raw: parsed.raw }));
      }

      const errorMessage = json.error?.message?.trim();
      if (!parsed.ok || errorMessage) {
        throw new Error(
          buildUpstreamError("OYY 提交失败", {
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
        throw new Error(
          buildUpstreamError("OYY 未返回图片", {
            httpStatus: parsed.status,
            providerMsg: "",
            raw: parsed.raw
          })
        );
      }

      return NextResponse.json({
        status: 2,
        imageUrl,
        imageDataUrl,
        message: "生成完成"
      });
    } catch (error) {
      lastErrorMessage = toErrorMessage(error);
      if (i === responseVariants.length - 1) {
        throw new Error(lastErrorMessage);
      }
    }
  }
  throw new Error(lastErrorMessage);
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
  let lastError = "OYY 请求失败";
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
      const response = await fetchWithSoftTimeout(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        body,
        cache: "no-store",
        signal
      }, timeoutMs);

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
  let lastError = "OYY 请求失败";
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
  let lastError = "提交失败";

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

      lastError = buildUpstreamError("提交失败", {
        httpStatus: parsed.status,
        providerMsg: submitJson?.msg || "",
        raw: parsed.raw
      });
      const canRetry = /500|转发请求失败|目标服务器返回|timeout/i.test(lastError);
      if (!canRetry || attempt === maxAttempts) {
        throw new Error(lastError);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("提交失败")) {
        throw error;
      }

      lastError = error instanceof Error ? error.message : String(error);
      const canRetry = /500|转发请求失败|目标服务器返回|timeout|network|fetch failed/i.test(lastError);
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
      throw new Error(buildUpstreamError("轮询结果解析失败", { httpStatus: parsed.status, providerMsg: "", raw: parsed.raw }));
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
  return error instanceof Error ? error.message : "未知错误";
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
      throw new Error(`上游请求超时（>${Math.round(timeoutMs / 1000)}秒，软超时）`);
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    detachExternal?.();
  }
}

type UploadFieldKey = "sock" | "shoe" | "outfit" | "background";
type OyyRequestImageField = "image" | "image[]";

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

function getProvider(): "wuyin" | "oyy" {
  const provider = process.env.IMAGE_PROVIDER?.trim().toLowerCase();
  if (provider === "oyy") {
    return "oyy";
  }
  return "wuyin";
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
