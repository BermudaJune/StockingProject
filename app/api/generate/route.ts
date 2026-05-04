import { NextResponse } from "next/server";

const DEFAULT_SUBMIT_URL = "https://api.wuyinkeji.com/api/async/image_gpt";
const DEFAULT_DETAIL_URL = "https://api.wuyinkeji.com/api/async/detail";

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

type ParsedUpstreamResponse<T> = {
  ok: boolean;
  status: number;
  raw: string;
  json: T | null;
};

export async function POST(request: Request) {
  try {
    const apiKey = getApiKey();
    const formData = await request.formData();

    const prompt = readRequiredField(formData, "prompt");
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
  } catch (error) {
    return NextResponse.json({ error: toErrorMessage(error) }, { status: 400 });
  }
}

export async function GET(request: Request) {
  try {
    const apiKey = getApiKey();
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
        const hint = /500|转发请求失败|目标服务器返回/i.test(lastError) ? "这是上游生图服务返回的 500（本地鉴权已通过），建议稍后重试或更换参考图。" : "";
        throw new Error(`${lastError}${hint ? ` ${hint}` : ""}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("提交失败")) {
        throw error;
      }

      lastError = error instanceof Error ? error.message : String(error);
      const canRetry = /500|转发请求失败|目标服务器返回|timeout|network|fetch failed/i.test(lastError);
      if (!canRetry || attempt === maxAttempts) {
        const hint = /500|转发请求失败|目标服务器返回/i.test(lastError) ? "这是上游生图服务返回的 500（本地鉴权已通过），建议稍后重试或更换参考图。" : "";
        throw new Error(`提交失败：${lastError}${hint ? ` ${hint}` : ""}`);
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
  const imageKeys: UploadFieldKey[] = ["sock", "shoe", "outfit", "background"];
  const files = imageKeys.map((key) => formData.get(key)).filter((value): value is File => value instanceof File);

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

type UploadFieldKey = "sock" | "shoe" | "outfit" | "background";

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
    raw: limitRaw(raw),
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

function limitRaw(raw: string): string {
  const maxLength = 1500;
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...(truncated)`;
}
