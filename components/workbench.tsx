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

const UPLOAD_SLOTS: Array<Omit<UploadSlot, "file">> = [
  {
    role: "sock",
    label: "图 1 · 袜子产品图",
    hint: "主体商品图，系统会把它作为最高优先级还原对象。"
  },
  {
    role: "shoe",
    label: "图 2 · 鞋子图",
    hint: "严格参考鞋型、材质、结构与颜色。"
  },
  {
    role: "outfit",
    label: "图 3 · 穿搭/模特图",
    hint: "只参考人物穿搭和比例，不读取这张图里的背景与道具。"
  },
  {
    role: "background",
    label: "图 4 · 背景场景图",
    hint: "只参考场景空间，不读取其中的人物、商品和道具。"
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
  const [batchInputDirectory, setBatchInputDirectory] = useState<SelectedDirectory | null>(null);
  const [batchOutputDirectory, setBatchOutputDirectory] = useState<SelectedDirectory | null>(null);
  const [batchStatusMessage, setBatchStatusMessage] = useState("");
  const [batchErrorMessage, setBatchErrorMessage] = useState("");
  const uploadPreviews = useUploadPreviews(uploads);
  const hasAllFiles = uploads.every((slot) => slot.file);

  async function handleSaveTemplate() {
    setIsSavingTemplate(true);
    setErrorMessage("");

    try {
      const response = await fetch("/api/templates", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(template)
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `模板保存失败：HTTP ${response.status}`);
      }

      setTemplate(payload as TemplateConfig);
      setStatusMessage("主图模板已保存到本地 config/prompt-templates.json。");
    } catch (error) {
      setErrorMessage(toErrorMessage(error, "模板保存失败。"));
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
      setStatusMessage("主图模板已恢复为默认版本。");
    } catch (error) {
      setErrorMessage(toErrorMessage(error, "模板重置失败。"));
    }
  }

  async function handlePickBatchInputDirectory() {
    setBatchErrorMessage("");

    try {
      const directoryHandle = await pickDirectory("batch-input", "read");
      setBatchInputDirectory({
        name: directoryHandle.name,
        handle: directoryHandle
      });
      setBatchStatusMessage(`已选择输入根文件夹：${directoryHandle.name}`);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      setBatchErrorMessage(toErrorMessage(error, "选择输入根文件夹失败。"));
    }
  }

  async function handlePickBatchOutputDirectory() {
    setBatchErrorMessage("");

    try {
      const directoryHandle = await pickDirectory("batch-output", "readwrite");
      const granted = await ensureDirectoryPermission(directoryHandle, "readwrite");
      if (!granted) {
        throw new Error("未获得输出文件夹的写入权限。");
      }

      setBatchOutputDirectory({
        name: directoryHandle.name,
        handle: directoryHandle
      });
      setBatchStatusMessage(`已选择输出文件夹：${directoryHandle.name}`);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      setBatchErrorMessage(toErrorMessage(error, "选择输出文件夹失败。"));
    }
  }

  function handleStartGeneration() {
    setErrorMessage("");
    setStatusMessage("");

    if (!hasAllFiles) {
      setErrorMessage("请先上传完整的 4 张参考图。");
      return;
    }

    setStatusMessage("当前主图配置已准备完成。");
  }

  function handleBatchButtonClick() {}

  function updateUpload(role: UploadRole, file: File | null) {
    setUploads((current) => current.map((slot) => (slot.role === role ? { ...slot, file } : slot)));
  }

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="muted tiny">当前输出画质：{outputSize}</div>
        <span className="hero-badge">本地主图工作台 · {outputSize}</span>
        <h1>4 图合成主图</h1>
        <p>当前项目保留原工作台布局与模板能力，支持继续整理素材与目录配置。</p>
      </section>

      <div className="layout-grid">
        <div className="stack">
          <section className="panel panel-strong">
            <div className="section">
              <div className="section-header">
                <div>
                  <h2>批量任务</h2>
                  <p>输入根文件夹下每个子文件夹都应包含 4 张图和 1 个 txt。图片会按文件名自然排序后依次映射到图 1、图 2、图 3、图 4。</p>
                </div>
                <span className="status-pill status-running">等待开始</span>
              </div>

              <div className="note-card tiny">可先选择输入与输出文件夹，目录信息会显示在这里。</div>

              <div className="toolbar" style={{ marginTop: 16 }}>
                <div className="field">
                  <label>输入根文件夹</label>
                  <button className="secondary-button" onClick={handlePickBatchInputDirectory}>
                    选择输入文件夹
                  </button>
                </div>

                <div className="field">
                  <label>输出文件夹</label>
                  <button className="secondary-button" onClick={handlePickBatchOutputDirectory}>
                    选择输出文件夹
                  </button>
                </div>
              </div>

              <div className="stack" style={{ gap: 12, marginTop: 16 }}>
                <div className="note-card tiny">
                  {batchInputDirectory ? `输入根文件夹：${batchInputDirectory.name}` : "尚未选择输入根文件夹。"}
                </div>
                <div className="note-card tiny">
                  {batchOutputDirectory ? `输出文件夹：${batchOutputDirectory.name}` : "尚未选择输出文件夹。"}
                </div>
              </div>

              <div className="toolbar-wide" style={{ marginTop: 16 }}>
                <button className="primary-button" onClick={handleBatchButtonClick}>
                  开始批量生图
                </button>
                <button className="ghost-button" onClick={handleBatchButtonClick}>
                  停止批量任务
                </button>
              </div>

              <div className="stack" style={{ gap: 12, marginTop: 16 }}>
                {batchStatusMessage ? <div className="note-card tiny">{batchStatusMessage}</div> : null}
                {batchErrorMessage ? <div className="error-box">{batchErrorMessage}</div> : null}
              </div>
            </div>

            <div className="section">
              <div className="section-header">
                <div>
                  <h2>单组输入工作台</h2>
                  <p>固定顺序上传，避免主图阶段串图。页面仍保留本地预览，方便继续整理素材。</p>
                </div>
                <span className="status-pill status-running">本地预览</span>
              </div>

              <div className="upload-grid">
                {uploads.map((slot, index) => (
                  <div className="upload-card" key={slot.role}>
                    <label htmlFor={`upload-${slot.role}`}>{slot.label}</label>
                    <p className="muted tiny">
                      顺序 {index + 1}。{slot.hint}
                    </p>
                    <div className="preview-box">
                      {uploadPreviews[slot.role] ? (
                        <img alt={slot.label} src={uploadPreviews[slot.role] as string} />
                      ) : (
                        <div className="preview-placeholder">上传后会在这里预览</div>
                      )}
                    </div>
                    <input
                      className="file-input"
                      id={`upload-${slot.role}`}
                      accept="image/*"
                      type="file"
                      onChange={(event) => updateUpload(slot.role, event.target.files?.[0] || null)}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="section">
              <div className="section-header">
                <div>
                  <h3>主图生成参数</h3>
                  <p>画质和比例仍可调整，当前页面会保留这些配置用于素材整理与模板维护。</p>
                </div>
              </div>

              <div className="note-card tiny">参数面板会保留当前比例与画质设置，方便继续整理工作流。</div>

              <div className="toolbar" style={{ marginTop: 16 }}>
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

              <div className="note-card tiny" style={{ marginTop: 16 }}>
                当前页面继续保留原有布局与配置区，方便你整理素材和模板内容。
              </div>

              <div className="toolbar-wide" style={{ marginTop: 16 }}>
                <button className="primary-button" onClick={handleStartGeneration}>
                  开始生成主图
                </button>
              </div>

              {statusMessage ? <div className="note-card tiny">{statusMessage}</div> : null}
              {errorMessage ? <div className="error-box">{errorMessage}</div> : null}
            </div>
          </section>

          <section className="panel">
            <div className="section">
              <div className="section-header">
                <div>
                  <h2>主图模板</h2>
                  <p>这里是单组模式默认使用的主图模板。模板编辑与本地保存能力保持不变。</p>
                </div>
              </div>

              <div className="note-card tiny">模板仍会保存到本地配置文件，方便后续接入新的工作流。</div>

              <div className="field">
                <textarea value={template.mainPrompt} onChange={(event) => setTemplate((current) => ({ ...current, mainPrompt: event.target.value }))} />
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
                  <p>结果区域保留原有展示位，方便后续继续衔接整个主图流程。</p>
                </div>
              </div>

              <div className="note-card tiny">这里会保留结果展示区的版式结构，方便继续查看后续输出。</div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
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
    throw new Error("当前浏览器不支持文件夹选择。请使用最新版 Edge 或 Chrome 打开本地页面。");
  }

  return picker({
    id,
    mode
  });
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

  const currentPermission = await permissionHandle.queryPermission({ mode });
  if (currentPermission === "granted") {
    return true;
  }

  if (currentPermission === "denied") {
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
