"use client";

import { useRef, useState } from "react";

import { MAIN_ASPECT_RATIOS, type MainAspectRatio } from "@/lib/aspect-ratios";
import { OUTPUT_SIZES, type OutputSize } from "@/lib/output-sizes";

type SelectedDirectory = {
  name: string;
  handle: FileSystemDirectoryHandle;
};

type DirectoryPicker = (options?: { id?: string; mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
type PermissionAwareDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
};

type GeneratePayload = {
  imageDataUrl?: string;
  imageUrl?: string;
  taskId?: string;
  message?: string;
  error?: string;
};

type ModelProvider = "openai" | "banana";

const THROTTLE_BETWEEN_GROUPS_MS = 2800;
const DEFAULT_IMAGE_RETRY_LIMIT = 2;
const MANUAL_STOP_MESSAGE = "任务已手动停止";
const DIRECT_OUTPUT_NAME = "result_txt.png";
const MODEL_PROVIDERS: Array<{ value: ModelProvider; label: string }> = [
  { value: "openai", label: "OpenAI (/v1/chat/completions)" },
  { value: "banana", label: "Banana (/v1beta/...:generateContent)" }
];

const TXT_PRIORITY_PROMPT_PREFIX = `【主提示词（最高优先级）】
以下 prompt.txt 内容为本次生成主导指令，权重最高；若与后文辅助规则冲突，以 prompt.txt 为准执行。

【prompt.txt 内容开始】`;

const TXT_PRIORITY_PROMPT_SUFFIX = `【prompt.txt 内容结束】

【四图角色说明（辅助）】
- 图1：袜子产品图
- 图2：鞋子图
- 图3：服装图
- 图4：背景图

【辅助约束（次优先级）】
- 保持图1袜子关键特征一致（长度类别、纹理、标签、贴合）
- 保持图2鞋子款式一致
- 保持图3服装风格一致
- 背景由图4提供空间与光影`;

export function TxtBatchWorkbench() {
  const [batchInputDirectory, setBatchInputDirectory] = useState<SelectedDirectory | null>(null);
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [batchLogs, setBatchLogs] = useState<string[]>([]);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<MainAspectRatio>("3:4");
  const [outputSize, setOutputSize] = useState<OutputSize>("1K");
  const [imageRetryLimit, setImageRetryLimit] = useState<number>(DEFAULT_IMAGE_RETRY_LIMIT);
  const [continueFromExisting, setContinueFromExisting] = useState<boolean>(true);
  const [isStopRequested, setIsStopRequested] = useState(false);
  const [modelProvider, setModelProvider] = useState<ModelProvider>("openai");

  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);

  function appendBatchLog(message: string) {
    setBatchLogs((current) => [...current, `${new Date().toLocaleTimeString()} ${message}`]);
  }

  function markStopRequested() {
    stopRequestedRef.current = true;
    setIsStopRequested(true);
  }

  function clearStopRequested() {
    stopRequestedRef.current = false;
    setIsStopRequested(false);
  }

  function throwIfStopRequested() {
    if (stopRequestedRef.current) {
      throw new Error(MANUAL_STOP_MESSAGE);
    }
  }

  function createRunAbortController(): AbortController {
    if (activeAbortControllerRef.current) {
      activeAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    activeAbortControllerRef.current = controller;
    clearStopRequested();
    return controller;
  }

  function clearRunAbortController(controller: AbortController) {
    if (activeAbortControllerRef.current === controller) {
      activeAbortControllerRef.current = null;
    }
    clearStopRequested();
  }

  function handleStopTasks() {
    markStopRequested();
    activeAbortControllerRef.current?.abort();
    setStatusMessage("已请求停止，正在中断当前任务...");
    appendBatchLog("已请求停止，等待当前请求返回...");
  }

  async function handlePickBatchInputDirectory() {
    try {
      const directoryHandle = await pickDirectory("txt-batch-input", "readwrite");
      const granted = await ensureDirectoryPermission(directoryHandle, "readwrite");
      if (!granted) {
        throw new Error(`未获得输入目录写入权限，无法回写 ${DIRECT_OUTPUT_NAME}`);
      }
      setBatchInputDirectory({ name: directoryHandle.name, handle: directoryHandle });
    } catch (error) {
      if (!isAbortError(error)) {
        setErrorMessage(toErrorMessage(error, "选择批量输入目录失败"));
      }
    }
  }

  async function handleStartBatchGeneration() {
    setErrorMessage("");
    setStatusMessage("");
    setBatchLogs([]);

    if (!batchInputDirectory) {
      setErrorMessage("请先选择批量输入目录");
      return;
    }

    const runAbortController = createRunAbortController();
    setIsBatchGenerating(true);
    try {
      const groups = await listSubDirectories(batchInputDirectory.handle);
      if (groups.length === 0) {
        throw new Error("输入目录下没有子文件夹");
      }

      let success = 0;
      let failed = 0;
      appendBatchLog(`共发现 ${groups.length} 组任务，开始处理...`);
      appendBatchLog(`每组要求：4张图片（按顺序作为图1~图4）+ prompt.txt；输出 ${DIRECT_OUTPUT_NAME}`);

      for (let i = 0; i < groups.length; i++) {
        throwIfStopRequested();
        const group = groups[i];
        if (i > 0) {
          await sleepWithSignal(THROTTLE_BETWEEN_GROUPS_MS, runAbortController.signal);
        }
        appendBatchLog(`[${i + 1}/${groups.length}] 处理：${group.name}`);
        try {
          const [productFile, shoeFile, outfitFile, backgroundFile] = await readBatchGroupInput(group.handle);
          const promptText = await readPromptTextFromGroup(group.handle);

          if (continueFromExisting && (await fileExists(group.handle, DIRECT_OUTPUT_NAME))) {
            success += 1;
            appendBatchLog(`[${group.name}] 已存在 ${DIRECT_OUTPUT_NAME}，跳过。`);
            continue;
          }

          const finalPrompt = buildTxtFirstPrompt(promptText);
          const source = await generateImageWithPerImageRetry({
            createFormData: () =>
              buildImageGenerationFormDataByRole({
                prompt: finalPrompt,
                aspectRatio,
                outputSize,
                sock: productFile,
                shoe: shoeFile,
                outfit: outfitFile,
                background: backgroundFile,
                modelProvider
              }),
            taskLabel: `${group.name} ${DIRECT_OUTPUT_NAME}`,
            onProgress: (message) => appendBatchLog(`[${group.name}] ${message}`),
            signal: runAbortController.signal,
            imageRetryLimit
          });

          const blob = await fetchImageBlob(source, runAbortController.signal);
          await writeBlobFile(group.handle, DIRECT_OUTPUT_NAME, blob);
          setGeneratedImageUrl(source);
          success += 1;
          appendBatchLog(`[${group.name}] 已生成并写入 ${DIRECT_OUTPUT_NAME}`);
        } catch (error) {
          if (isAbortLikeError(error)) {
            throw error;
          }
          failed += 1;
          appendBatchLog(`[${group.name}] 失败：${toErrorMessage(error, "未知错误")}`);
        }
      }

      setStatusMessage(`批量完成：成功 ${success} 组，失败 ${failed} 组`);
    } catch (error) {
      if (isAbortLikeError(error)) {
        setStatusMessage("批量任务已停止。");
      } else {
        setErrorMessage(toErrorMessage(error, "批量生成失败"));
      }
    } finally {
      setIsBatchGenerating(false);
      clearRunAbortController(runAbortController);
    }
  }

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="top-actions">
          <a className="ghost-button" href="/">
            返回主页
          </a>
          <a className="secondary-button" href="/workflow/step-batch">
            去工作流1：分步骤批量
          </a>
        </div>
        <span className="hero-badge">工作流2 · 批量4图 + prompt.txt 直出</span>
        <h1>每组4图配一份 `prompt.txt`，一键批量直出</h1>
        <p>该工作流以 `prompt.txt` 为最高优先级。每个子文件夹内需包含：产品图、鞋子图、服装图、背景图、prompt.txt。</p>
      </section>

      <div className="layout-grid">
        <div className="stack">
          <section className="panel panel-strong">
            <div className="section">
              <div className="section-header">
                <div>
                  <h2>批量直出</h2>
                  <p>输出文件：{DIRECT_OUTPUT_NAME}。建议先小批量验证后再全量跑。</p>
                </div>
                <span className="status-pill status-running">{isBatchGenerating ? "运行中" : "待开始"}</span>
              </div>

              <div className="toolbar-wide">
                <button className="secondary-button" onClick={handlePickBatchInputDirectory}>
                  选择输入目录
                </button>
                <button className="primary-button" disabled={isBatchGenerating} onClick={handleStartBatchGeneration}>
                  {isBatchGenerating ? "批量生成中..." : "开始批量生成"}
                </button>
                <button className="danger-button" disabled={!isBatchGenerating || isStopRequested} onClick={handleStopTasks}>
                  {isStopRequested ? "停止中..." : "停止任务"}
                </button>
              </div>

              <div className="toolbar">
                <div className="field">
                  <label htmlFor="txtModelProvider">模型通道</label>
                  <select id="txtModelProvider" value={modelProvider} onChange={(event) => setModelProvider(event.target.value as ModelProvider)}>
                    {MODEL_PROVIDERS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="txtAspectRatio">主图比例</label>
                  <select id="txtAspectRatio" value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as MainAspectRatio)}>
                    {MAIN_ASPECT_RATIOS.map((ratio) => (
                      <option key={ratio} value={ratio}>
                        {ratio}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="txtOutputSize">输出画质</label>
                  <select id="txtOutputSize" value={outputSize} onChange={(event) => setOutputSize(event.target.value as OutputSize)}>
                    {OUTPUT_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="txtRetryLimit">失败重试次数</label>
                  <input
                    id="txtRetryLimit"
                    type="number"
                    min={0}
                    max={8}
                    step={1}
                    value={imageRetryLimit}
                    onChange={(event) => setImageRetryLimit(clampRetryLimit(event.target.value))}
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="txtContinueFromExisting">断点续跑</label>
                <select id="txtContinueFromExisting" value={continueFromExisting ? "on" : "off"} onChange={(event) => setContinueFromExisting(event.target.value === "on")}>
                  <option value="on">开启（跳过已存在 result_txt.png）</option>
                  <option value="off">关闭（整组重跑覆盖）</option>
                </select>
              </div>

              <div className="stack">
                <div className="note-card tiny">输入目录：{batchInputDirectory ? batchInputDirectory.name : "未选择"}</div>
                <div className="note-card tiny">识别规则：每组按文件名排序后取前4张图片，依次作为图1~图4；提示词读取 prompt.txt。</div>
                <div className="note-card tiny">当前模型通道：{modelProvider}</div>
                <div className="note-card tiny">主导规则：`prompt.txt` 权重最高，系统仅做辅助约束。</div>
              </div>
            </div>

            <div className="section">
              {statusMessage ? <div className="note-card tiny">{statusMessage}</div> : null}
              {errorMessage ? <div className="error-box">{errorMessage}</div> : null}
            </div>

            <div className="section">
              <div className="section-header">
                <div>
                  <h3>批量日志</h3>
                  <p>用于查看每组任务处理进度。</p>
                </div>
              </div>
              {batchLogs.length === 0 ? (
                <div className="note-card tiny">暂无批量日志</div>
              ) : (
                <div className="stack">
                  {batchLogs.slice(-40).map((log, index) => (
                    <div className="note-card tiny" key={`${index}-${log}`}>
                      {log}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="panel panel-strong">
            <div className="section">
              <div className="section-header">
                <div>
                  <h2>最新结果预览</h2>
                  <p>显示最近成功生成的图片。</p>
                </div>
              </div>
              <div className="upload-card">
                <div className="preview-box preview-full">
                  {generatedImageUrl ? <img alt="最新生成结果" src={generatedImageUrl} /> : <div className="preview-placeholder">暂无结果图</div>}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function buildTxtFirstPrompt(promptText: string): string {
  const trimmed = promptText.trim();
  if (!trimmed) {
    throw new Error("prompt.txt 为空，无法生成");
  }
  return `${TXT_PRIORITY_PROMPT_PREFIX}
${trimmed}

${TXT_PRIORITY_PROMPT_SUFFIX}`;
}

async function submitAndWaitImage(formData: FormData, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<string> {
  const response = await fetch("/api/generate", {
    method: "POST",
    body: formData,
    signal
  });
  const payload = (await response.json()) as GeneratePayload;
  if (!response.ok) {
    throw new Error(payload.error || "提交生成失败");
  }

  const directImage = payload.imageDataUrl || payload.imageUrl || null;
  if (directImage) {
    return directImage;
  }

  const taskId = payload.taskId;
  if (!taskId) {
    throw new Error(payload.message || "未返回任务ID");
  }

  return pollTaskUntilDone(taskId, onProgress, signal);
}

async function pollTaskUntilDone(taskId: string, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<string> {
  const maxAttempts = 50;
  const intervalMs = 3000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const response = await fetch(`/api/generate?taskId=${encodeURIComponent(taskId)}`, { method: "GET", signal });
    const payload = (await response.json()) as {
      status?: number;
      message?: string;
      imageUrl?: string | null;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(payload.error || payload.message || `查询任务失败：HTTP ${response.status}`);
    }
    if (payload.status === 2 && payload.imageUrl) {
      return payload.imageUrl;
    }
    if (payload.status === 3) {
      throw new Error(payload.message || "任务失败（触发平台策略）");
    }

    onProgress?.(`任务进行中 (${attempt}/${maxAttempts})，ID: ${taskId}`);
    await sleepWithSignal(intervalMs, signal);
  }
  throw new Error(`任务超时，请稍后重试。任务ID: ${taskId}`);
}

async function generateImageWithPerImageRetry(params: {
  createFormData: () => FormData;
  taskLabel: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  imageRetryLimit: number;
}): Promise<string> {
  const { createFormData, taskLabel, signal, onProgress, imageRetryLimit } = params;
  const attempts = Math.max(1, Math.floor(imageRetryLimit) + 1);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (attempt > 1) {
        onProgress?.(`${taskLabel} 第 ${attempt} 次尝试...`);
      }
      return await submitAndWaitImage(createFormData(), onProgress, signal);
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw error;
      }
      const reason = toErrorMessage(error, "未知错误");
      const isLastAttempt = attempt >= attempts;
      if (isLastAttempt) {
        throw error;
      }
      onProgress?.(`${taskLabel} 失败：${reason}；准备重试（${attempt}/${attempts - 1}）`);
      await sleepWithSignal(1800 * attempt, signal);
    }
  }

  throw new Error(`${taskLabel} 重试后仍失败`);
}

function buildImageGenerationFormDataByRole(params: {
  prompt: string;
  aspectRatio: MainAspectRatio;
  outputSize: OutputSize;
  sock?: File;
  shoe?: File;
  outfit?: File;
  background?: File;
  modelProvider?: ModelProvider;
}): FormData {
  const formData = new FormData();
  formData.append("prompt", params.prompt);
  formData.append("aspectRatio", params.aspectRatio);
  formData.append("outputSize", params.outputSize);
  if (params.modelProvider) {
    formData.append("modelProvider", params.modelProvider);
  }
  if (params.sock) {
    formData.append("sock", params.sock);
  }
  if (params.shoe) {
    formData.append("shoe", params.shoe);
  }
  if (params.outfit) {
    formData.append("outfit", params.outfit);
  }
  if (params.background) {
    formData.append("background", params.background);
  }
  if (!params.sock && !params.shoe && !params.outfit && !params.background) {
    throw new Error("未提供参考图");
  }
  return formData;
}

async function readPromptTextFromGroup(directoryHandle: FileSystemDirectoryHandle): Promise<string> {
  const iteratorTarget = directoryHandle as unknown as {
    entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
  };
  let fallbackTxtFile: File | null = null;
  for await (const [, handle] of iteratorTarget.entries()) {
    if (handle.kind !== "file") {
      continue;
    }
    const fileHandle = handle as FileSystemFileHandle;
    const file = await fileHandle.getFile();
    const normalized = file.name.trim().toLowerCase();
    if (normalized === "prompt.txt") {
      return (await file.text()).trim();
    }
    if (!fallbackTxtFile && normalized.endsWith(".txt")) {
      fallbackTxtFile = file;
    }
  }
  if (!fallbackTxtFile) {
    throw new Error("缺少 prompt.txt");
  }
  return (await fallbackTxtFile.text()).trim();
}

async function readBatchGroupInput(directoryHandle: FileSystemDirectoryHandle): Promise<[File, File, File, File]> {
  const files: File[] = [];

  const iteratorTarget = directoryHandle as unknown as {
    entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
  };

  for await (const [, handle] of iteratorTarget.entries()) {
    if (handle.kind !== "file") {
      continue;
    }

    const fileHandle = handle as FileSystemFileHandle;
    const file = await fileHandle.getFile();
    if (isImageFile(file) && !isGeneratedResultFile(file.name)) {
      files.push(file);
    }
  }

  files.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));

  if (files.length < 4) {
    throw new Error("该组图片不足4张（需至少4张图片）");
  }

  // 工作流2不再按文件名识别角色，直接按排序后的前4张作为图1~图4输入
  return [files[0] as File, files[1] as File, files[2] as File, files[3] as File];
}

async function listSubDirectories(root: FileSystemDirectoryHandle): Promise<Array<{ name: string; handle: FileSystemDirectoryHandle }>> {
  const dirs: Array<{ name: string; handle: FileSystemDirectoryHandle }> = [];
  const iteratorTarget = root as unknown as {
    entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
  };

  for await (const [name, handle] of iteratorTarget.entries()) {
    if (handle.kind === "directory") {
      dirs.push({ name, handle: handle as FileSystemDirectoryHandle });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  return dirs;
}

async function writeBlobFile(directoryHandle: FileSystemDirectoryHandle, fileName: string, blob: Blob): Promise<void> {
  const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function fileExists(directoryHandle: FileSystemDirectoryHandle, fileName: string): Promise<boolean> {
  try {
    await directoryHandle.getFileHandle(fileName, { create: false });
    return true;
  } catch {
    return false;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isAbortLikeError(error: unknown): boolean {
  if (isAbortError(error)) {
    return true;
  }
  if (error instanceof Error) {
    return error.message.includes(MANUAL_STOP_MESSAGE) || error.name === "AbortError";
  }
  return false;
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}

async function pickDirectory(id: string, mode: "read" | "readwrite"): Promise<FileSystemDirectoryHandle> {
  const picker = getDirectoryPicker();
  if (!picker) {
    throw new Error("当前浏览器不支持目录选择，请使用最新版 Edge 或 Chrome");
  }
  return picker({ id, mode });
}

function getDirectoryPicker(): DirectoryPicker | undefined {
  const candidate = window as Window & {
    showDirectoryPicker?: DirectoryPicker;
  };
  return candidate.showDirectoryPicker;
}

async function ensureDirectoryPermission(handle: FileSystemDirectoryHandle, mode: "read" | "readwrite"): Promise<boolean> {
  const permissionHandle = handle as Partial<PermissionAwareDirectoryHandle>;
  if (typeof permissionHandle.queryPermission !== "function" || typeof permissionHandle.requestPermission !== "function") {
    return true;
  }

  const current = await permissionHandle.queryPermission({ mode });
  if (current === "granted") {
    return true;
  }
  if (current === "denied") {
    return false;
  }
  return (await permissionHandle.requestPermission({ mode })) === "granted";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal.addEventListener("abort", onAbort);
  });
}

async function fetchImageBlob(source: string, signal?: AbortSignal): Promise<Blob> {
  if (source.startsWith("data:")) {
    return dataUrlToBlob(source);
  }

  const response = await fetch(`/api/image-proxy?url=${encodeURIComponent(source)}`, { method: "GET", signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.blob();
}

function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(dataUrl);
  if (!match) {
    throw new Error("无效的数据图片");
  }

  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = !!match[2];
  const data = match[3] || "";

  if (isBase64) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  }

  return new Blob([decodeURIComponent(data)], { type: mimeType });
}

function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) {
    return true;
  }
  const lower = file.name.toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"].some((ext) => lower.endsWith(ext));
}

function isGeneratedResultFile(fileName: string): boolean {
  return /^(result_[0-9A-Za-z]+|product_[1-3])\.(png|jpg|jpeg|webp|bmp|gif)$/i.test(fileName.trim());
}

function clampRetryLimit(input: string): number {
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_IMAGE_RETRY_LIMIT;
  }
  return Math.max(0, Math.min(8, parsed));
}
