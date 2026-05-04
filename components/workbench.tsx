"use client";

import { useEffect, useState } from "react";

import { MAIN_ASPECT_RATIOS, type MainAspectRatio } from "@/lib/aspect-ratios";
import { OUTPUT_SIZES, type OutputSize } from "@/lib/output-sizes";
import type { TemplateConfig } from "@/lib/templates/types";

type UploadRole = "sock" | "shoe" | "outfit" | "background";

type UploadSlot = {
  role: UploadRole;
  label: string;
  hint: string;
  file: File | null;
};

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

const UPLOAD_SLOTS: Array<Omit<UploadSlot, "file">> = [
  {
    role: "sock",
    label: "图1：产品图",
    hint: "核心产品参考图，优先级最高。"
  },
  {
    role: "shoe",
    label: "图2：鞋子图",
    hint: "鞋型、材质、颜色参考。"
  },
  {
    role: "outfit",
    label: "图3：模特穿搭图",
    hint: "人物姿态与穿搭风格参考。"
  },
  {
    role: "background",
    label: "图4：场景图",
    hint: "背景空间与氛围参考。"
  }
];

type Props = {
  initialTemplates: TemplateConfig;
};

export function Workbench({ initialTemplates }: Props) {
  const [template, setTemplate] = useState<TemplateConfig>(initialTemplates);
  const [uploads, setUploads] = useState<UploadSlot[]>(() => UPLOAD_SLOTS.map((slot) => ({ ...slot, file: null })));
  const [aspectRatio, setAspectRatio] = useState<MainAspectRatio>("3:4");
  const [outputSize, setOutputSize] = useState<OutputSize>("1K");
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);

  const [batchInputDirectory, setBatchInputDirectory] = useState<SelectedDirectory | null>(null);
  const [batchOutputDirectory, setBatchOutputDirectory] = useState<SelectedDirectory | null>(null);
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [batchLogs, setBatchLogs] = useState<string[]>([]);

  const uploadPreviews = useUploadPreviews(uploads);
  const hasAllFiles = uploads.every((slot) => slot.file);

  async function handleSaveTemplate() {
    setIsSavingTemplate(true);
    setErrorMessage("");
    try {
      const response = await fetch("/api/templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(template)
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `模板保存失败：HTTP ${response.status}`);
      }
      setTemplate(payload as TemplateConfig);
      setStatusMessage("模板已保存到 config/prompt-templates.json");
    } catch (error) {
      setErrorMessage(toErrorMessage(error, "模板保存失败"));
    } finally {
      setIsSavingTemplate(false);
    }
  }

  async function handleResetTemplate() {
    setErrorMessage("");
    try {
      const response = await fetch("/api/templates", { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `模板重置失败：HTTP ${response.status}`);
      }
      setTemplate(payload as TemplateConfig);
      setStatusMessage("模板已恢复默认");
    } catch (error) {
      setErrorMessage(toErrorMessage(error, "模板重置失败"));
    }
  }

  async function handleStartGeneration() {
    setErrorMessage("");
    setStatusMessage("");
    if (!hasAllFiles) {
      setErrorMessage("请先上传完整的4张参考图");
      return;
    }

    setIsGenerating(true);
    try {
      setStatusMessage("正在提交单组任务...");
      const formData = new FormData();
      formData.append("prompt", template.mainPrompt);
      formData.append("aspectRatio", aspectRatio);
      formData.append("outputSize", outputSize);
      for (const slot of uploads) {
        if (slot.file) {
          formData.append(slot.role, slot.file);
        }
      }

      const finalImageUrl = await submitAndWaitImage(formData, (message) => setStatusMessage(message));
      setGeneratedImageUrl(finalImageUrl);
      setStatusMessage("生成完成，已在右侧展示。");
    } catch (error) {
      setErrorMessage(toErrorMessage(error, "单组生成失败"));
    } finally {
      setIsGenerating(false);
    }
  }

  async function handlePickBatchInputDirectory() {
    try {
      const directoryHandle = await pickDirectory("batch-input", "read");
      setBatchInputDirectory({ name: directoryHandle.name, handle: directoryHandle });
    } catch (error) {
      if (!isAbortError(error)) {
        setErrorMessage(toErrorMessage(error, "选择批量输入目录失败"));
      }
    }
  }

  async function handlePickBatchOutputDirectory() {
    try {
      const directoryHandle = await pickDirectory("batch-output", "readwrite");
      const granted = await ensureDirectoryPermission(directoryHandle, "readwrite");
      if (!granted) {
        throw new Error("未获得批量输出目录写入权限");
      }
      setBatchOutputDirectory({ name: directoryHandle.name, handle: directoryHandle });
    } catch (error) {
      if (!isAbortError(error)) {
        setErrorMessage(toErrorMessage(error, "选择批量输出目录失败"));
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
    if (!batchOutputDirectory) {
      setErrorMessage("请先选择批量输出目录");
      return;
    }

    setIsBatchGenerating(true);
    try {
      const groups = await listSubDirectories(batchInputDirectory.handle);
      if (groups.length === 0) {
        throw new Error("输入目录下没有子文件夹");
      }

      let success = 0;
      let failed = 0;
      appendBatchLog(`共发现 ${groups.length} 组任务，开始处理...`);

      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        appendBatchLog(`[${i + 1}/${groups.length}] 处理：${group.name}`);
        try {
          const { prompt, files } = await readGroupInput(group.handle, template.mainPrompt);

          const formData = new FormData();
          formData.append("prompt", prompt);
          formData.append("aspectRatio", aspectRatio);
          formData.append("outputSize", outputSize);
          formData.append("sock", files[0]);
          formData.append("shoe", files[1]);
          formData.append("outfit", files[2]);
          formData.append("background", files[3]);

          const imageUrl = await submitAndWaitImage(formData, (message) => appendBatchLog(`[${group.name}] ${message}`));
          setGeneratedImageUrl(imageUrl);
          await saveBatchResult(batchOutputDirectory.handle, group.name, imageUrl, prompt);
          success += 1;
          appendBatchLog(`[${group.name}] 成功`);
        } catch (error) {
          failed += 1;
          appendBatchLog(`[${group.name}] 失败：${toErrorMessage(error, "未知错误")}`);
        }
      }

      setStatusMessage(`批量完成：成功 ${success} 组，失败 ${failed} 组`);
    } catch (error) {
      setErrorMessage(toErrorMessage(error, "批量生成失败"));
    } finally {
      setIsBatchGenerating(false);
    }
  }

  async function submitAndWaitImage(formData: FormData, onProgress?: (message: string) => void): Promise<string> {
    const response = await fetch("/api/generate", {
      method: "POST",
      body: formData
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

    return pollTaskUntilDone(taskId, onProgress);
  }

  async function pollTaskUntilDone(taskId: string, onProgress?: (message: string) => void): Promise<string> {
    const maxAttempts = 50;
    const intervalMs = 3000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await fetch(`/api/generate?taskId=${encodeURIComponent(taskId)}`, { method: "GET" });
      const payload = (await response.json()) as {
        status?: number;
        imageUrl?: string | null;
        message?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "轮询任务失败");
      }

      if (payload.status === 2 && payload.imageUrl) {
        return payload.imageUrl;
      }
      if (payload.status === 3) {
        throw new Error(payload.message || "任务失败（触发平台策略）");
      }

      if (attempt < maxAttempts) {
        onProgress?.(`任务进行中 (${attempt}/${maxAttempts})，ID: ${taskId}`);
        await sleep(intervalMs);
      }
    }

    throw new Error(`任务超时，请稍后重试。任务ID: ${taskId}`);
  }

  function appendBatchLog(message: string) {
    setBatchLogs((current) => [...current, `${new Date().toLocaleTimeString()} ${message}`]);
  }

  function updateUpload(role: UploadRole, file: File | null) {
    setUploads((current) => current.map((slot) => (slot.role === role ? { ...slot, file } : slot)));
  }

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="muted tiny">当前输出画质：{outputSize}</div>
        <span className="hero-badge">四图主图系统 · 中文版</span>
        <h1>输入产品/模特/场景，生成展示图</h1>
        <p>支持单组与批量模式。批量模式下，每个子文件夹一组（4张图+可选txt提示词）。</p>
      </section>

      <div className="layout-grid">
        <div className="stack">
          <section className="panel panel-strong">
            <div className="section">
              <div className="section-header">
                <div>
                  <h2>批量生图</h2>
                  <p>输入目录下每个子文件夹为一组，默认按文件名排序取前4张图。</p>
                </div>
                <span className="status-pill status-running">{isBatchGenerating ? "运行中" : "待开始"}</span>
              </div>
              <div className="toolbar-wide">
                <button className="secondary-button" onClick={handlePickBatchInputDirectory}>
                  选择输入目录
                </button>
                <button className="secondary-button" onClick={handlePickBatchOutputDirectory}>
                  选择输出目录
                </button>
                <button className="primary-button" disabled={isBatchGenerating} onClick={handleStartBatchGeneration}>
                  {isBatchGenerating ? "批量生成中..." : "开始批量生图"}
                </button>
              </div>
              <div className="stack">
                <div className="note-card tiny">输入目录：{batchInputDirectory ? batchInputDirectory.name : "未选择"}</div>
                <div className="note-card tiny">输出目录：{batchOutputDirectory ? batchOutputDirectory.name : "未选择"}</div>
              </div>
            </div>

            <div className="section">
              <div className="section-header">
                <div>
                  <h2>单组输入</h2>
                  <p>按图1-图4顺序上传参考图。</p>
                </div>
              </div>

              <div className="upload-grid">
                {uploads.map((slot, index) => (
                  <div className="upload-card" key={slot.role}>
                    <label htmlFor={`upload-${slot.role}`}>{slot.label}</label>
                    <p className="muted tiny">
                      顺序 {index + 1}。{slot.hint}
                    </p>
                    <div className="preview-box">
                      {uploadPreviews[slot.role] ? <img alt={slot.label} src={uploadPreviews[slot.role] as string} /> : <div className="preview-placeholder">上传后在此预览</div>}
                    </div>
                    <input className="file-input" id={`upload-${slot.role}`} accept="image/*" type="file" onChange={(event) => updateUpload(slot.role, event.target.files?.[0] || null)} />
                  </div>
                ))}
              </div>
            </div>

            <div className="section">
              <div className="section-header">
                <div>
                  <h3>参数与模板</h3>
                  <p>可编辑主提示词模板，支持本地保存。</p>
                </div>
              </div>
              <div className="toolbar">
                <div className="field">
                  <label htmlFor="aspectRatio">主图比例</label>
                  <select id="aspectRatio" value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as MainAspectRatio)}>
                    {MAIN_ASPECT_RATIOS.map((ratio) => (
                      <option key={ratio} value={ratio}>
                        {ratio}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="outputSize">输出画质</label>
                  <select id="outputSize" value={outputSize} onChange={(event) => setOutputSize(event.target.value as OutputSize)}>
                    {OUTPUT_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label>模板保存</label>
                  <button className="secondary-button" disabled={isSavingTemplate} onClick={handleSaveTemplate}>
                    {isSavingTemplate ? "保存中..." : "保存当前模板"}
                  </button>
                </div>

                <div className="field">
                  <label>模板恢复</label>
                  <button className="ghost-button" onClick={handleResetTemplate}>
                    恢复默认模板
                  </button>
                </div>
              </div>

              <div className="field">
                <textarea value={template.mainPrompt} onChange={(event) => setTemplate((current) => ({ ...current, mainPrompt: event.target.value }))} />
              </div>

              <div className="toolbar-wide">
                <button className="primary-button" disabled={isGenerating || isBatchGenerating} onClick={handleStartGeneration}>
                  {isGenerating ? "单组生成中..." : "开始单组生图"}
                </button>
              </div>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="panel panel-strong">
            <div className="section">
              <div className="section-header">
                <div>
                  <h2>生成结果</h2>
                  <p>最新成功结果显示在这里。</p>
                </div>
              </div>
              <div className="upload-card">
                <div className="preview-box">
                  {generatedImageUrl ? <img alt="最新生成结果" src={generatedImageUrl} /> : <div className="preview-placeholder">暂无结果图</div>}
                </div>
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
                  <p>用于查看每组任务执行情况。</p>
                </div>
              </div>
              {batchLogs.length === 0 ? (
                <div className="note-card tiny">暂无批量日志</div>
              ) : (
                <div className="stack">
                  {batchLogs.slice(-30).map((log, index) => (
                    <div className="note-card tiny" key={`${index}-${log}`}>
                      {log}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

async function readGroupInput(directoryHandle: FileSystemDirectoryHandle, fallbackPrompt: string): Promise<{ prompt: string; files: [File, File, File, File] }> {
  const files: File[] = [];
  const txtFiles: File[] = [];

  const iteratorTarget = directoryHandle as unknown as {
    entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
  };

  for await (const [, handle] of iteratorTarget.entries()) {
    if (handle.kind !== "file") {
      continue;
    }

    const fileHandle = handle as FileSystemFileHandle;
    const file = await fileHandle.getFile();
    if (isImageFile(file)) {
      files.push(file);
    } else if (file.name.toLowerCase().endsWith(".txt")) {
      txtFiles.push(file);
    }
  }

  files.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  if (files.length < 4) {
    throw new Error("该组图片不足4张");
  }

  let prompt = fallbackPrompt;
  if (txtFiles.length > 0) {
    txtFiles.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
    const customPrompt = (await txtFiles[0].text()).trim();
    if (customPrompt) {
      prompt = customPrompt;
    }
  }

  return {
    prompt,
    files: [files[0], files[1], files[2], files[3]]
  };
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

async function saveBatchResult(outputRoot: FileSystemDirectoryHandle, groupName: string, imageUrl: string, prompt: string): Promise<void> {
  const groupDir = await outputRoot.getDirectoryHandle(groupName, { create: true });
  const meta = {
    groupName,
    imageUrl,
    prompt,
    savedAt: new Date().toISOString()
  };

  await writeTextFile(groupDir, "result.meta.json", JSON.stringify(meta, null, 2));

  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();
    await writeBlobFile(groupDir, "result.png", blob);
  } catch {
    await writeTextFile(groupDir, "result.url.txt", imageUrl);
  }
}

async function writeTextFile(directoryHandle: FileSystemDirectoryHandle, fileName: string, content: string): Promise<void> {
  const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function writeBlobFile(directoryHandle: FileSystemDirectoryHandle, fileName: string, blob: Blob): Promise<void> {
  const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) {
    return true;
  }
  const lower = file.name.toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"].some((ext) => lower.endsWith(ext));
}

function useUploadPreviews(uploads: UploadSlot[]) {
  const [previews, setPreviews] = useState<Record<UploadRole, string | null>>({
    sock: null,
    shoe: null,
    outfit: null,
    background: null
  });

  useEffect(() => {
    const nextPreviews: Record<UploadRole, string | null> = {
      sock: null,
      shoe: null,
      outfit: null,
      background: null
    };
    const objectUrls: string[] = [];

    for (const slot of uploads) {
      if (slot.file) {
        const objectUrl = URL.createObjectURL(slot.file);
        nextPreviews[slot.role] = objectUrl;
        objectUrls.push(objectUrl);
      }
    }

    setPreviews(nextPreviews);
    return () => {
      for (const objectUrl of objectUrls) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [uploads]);

  return previews;
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
