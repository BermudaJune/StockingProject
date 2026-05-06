"use client";

import { useEffect, useRef, useState } from "react";

import { MAIN_ASPECT_RATIOS, VARIANT_ASPECT_RATIO, type MainAspectRatio } from "@/lib/aspect-ratios";
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

const BATCH_ASPECT_RATIO: MainAspectRatio = VARIANT_ASPECT_RATIO;
const BATCH_VARIANT_COUNT = 5;
const THROTTLE_BETWEEN_IMAGES_MS = 1500;
const THROTTLE_BETWEEN_GROUPS_MS = 3500;
const DEFAULT_IMAGE_RETRY_LIMIT = 2;
const MANUAL_STOP_MESSAGE = "任务已手动停止";
const PRODUCT_LOCK_PROMPT = `【产品硬约束（必须执行）】
输入产品图中的袜子是唯一标准，禁止任何改款、改色、改材质、改纹理、改长度、改版型。
必须100%保持与输入产品一致，不得新增装饰、logo、图案或结构变化。`;
const STRICT_CONSISTENCY_PROMPT = `【强一致性约束（最高优先级，必须执行）】
背景必须严格与背景参考图一致：空间版面、机位高度、透视关系、明暗分区、光影方向、墙地比例都不可改变。
鞋子必须严格与鞋子参考图一致：款式、鞋头形状、鞋跟高度、材质反光、配色与细节不可改变。
服装必须严格与服装参考图一致：外套/内搭/下装的服装元素、版型轮廓、颜色关系不可改变。
袜子必须严格与产品参考图一致：脚背是否露出、标签前后位置、纹理细节、开口位置、长度、贴合方式都必须一致。
禁止任何与参考图不一致的改动；若动作与一致性冲突，优先保证一致性。`;
const SINGLE_STEP_A_PROMPT = `生成一张女性腿部与脚部的电商展示图。

【参考图分工】
- 图1：袜子产品图，仅用于袜子外观、纹理、标签位置、镂空结构
- 图2：鞋子参考图，仅用于鞋型与材质

【严格要求】
- 仅生成腿部与脚部（大腿中部到脚尖）
- 袜子必须严格基于图1，标签位置与镂空结构不得改变
- 鞋子必须严格基于图2，不得替换为其他鞋型
- 不生成服装
- 不生成背景或场景
- 姿态自然，符合真实模特拍摄逻辑

输出：单张图像`;
const SINGLE_STEP_B_PROMPT = `基于上一张图片进行编辑。

【绝对锁定】
- 上一张图中的腿部、袜子、鞋子必须完全保持不变
- 不得重绘、不得修改袜子或鞋子

【参考图分工】
- 图2：服装参考图，仅用于服装款式与配色
- 图3：背景参考图，仅用于空间结构、地面/墙面关系、主光方向

【生成要求】
- 添加自然站立的全身模特形象，要时尚有魅力，最大程度吸取服装和背景参考图的高级感
- 服装弱化处理，不得遮挡袜子主体
- 背景与光影严格基于背景参考图
- 构图为竖图，3:4，电商穿搭风格

输出：单张全身主图`;
const VARIANT_ACTION_PROMPTS: Record<number, string> = {
  1: `第 1 张【全身主图・标准正面】
构图：全身竖幅，正面站立，居中对称
姿势：自然直立，双脚与肩同宽，体态舒展
重点：完整展示整体穿搭与袜子主体，品牌视觉核心主图`,
  2: `第 2 张【全身主图・动态侧姿】
构图：全身竖幅
姿势：身体侧转 30°–45°，重心稳定，轻微迈步 / 摆臂动态
重点：展示侧面版型与穿着立体感，提升点击动态感`,
  3: `第 3 张【细节图 1・大腿至脚近景】
构图：近景，仅拍摄大腿到脚部
禁止：完整上半身入镜
姿势：侧身站立，腿部自然放松
重点：突出袜身版型、长度与贴合度`,
  4: `第 4 张【细节图 2・膝盖以下特写】
构图：特写，仅拍摄膝盖至脚尖
姿势：双腿微错开，展示正面 + 侧面纹理
重点：聚焦袜口、针织纹理、脚踝细节`,
  5: `第 5 张【细节图 3・局部极致特写】
低角度仰拍，相机贴地放置，膝盖水平机位，50mm 标准镜头，自然无畸变。模特下半身特写，仅展示大腿到脚部，无完整上半身入镜。模特放松站立，重心单腿支撑，另一条腿微曲前伸，脚尖自然朝前，身体微侧 30°。画面主体为黑色网纱中筒袜，纹理清晰无遮挡，搭配黑色皮鞋，脚部贴近画面底部，腿部占据画面 70% 视觉主体。`
};

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

  const [singleInputDirectory, setSingleInputDirectory] = useState<SelectedDirectory | null>(null);
  const [batchInputDirectory, setBatchInputDirectory] = useState<SelectedDirectory | null>(null);
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [batchLogs, setBatchLogs] = useState<string[]>([]);
  const [isStopRequested, setIsStopRequested] = useState(false);
  const [imageRetryLimit, setImageRetryLimit] = useState<number>(DEFAULT_IMAGE_RETRY_LIMIT);
  const [continueFromExisting, setContinueFromExisting] = useState<boolean>(true);

  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);

  const uploadPreviews = useUploadPreviews(uploads);

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

  async function handlePickSingleInputDirectory() {
    try {
      const directoryHandle = await pickDirectory("single-input", "readwrite");
      const granted = await ensureDirectoryPermission(directoryHandle, "readwrite");
      if (!granted) {
        throw new Error("未获得单组输入目录写入权限，无法回写 result_A 与 result_0 到 result_5");
      }
      setSingleInputDirectory({ name: directoryHandle.name, handle: directoryHandle });
    } catch (error) {
      if (!isAbortError(error)) {
        setErrorMessage(toErrorMessage(error, "选择单组输入目录失败"));
      }
    }
  }

  function handleStopTasks() {
    markStopRequested();
    activeAbortControllerRef.current?.abort();
    setStatusMessage("已请求停止，正在中断当前任务...");
    appendBatchLog("已请求停止，等待当前请求返回...");
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

  async function handleStartGeneration() {
    setErrorMessage("");
    setStatusMessage("");
    if (!singleInputDirectory) {
      setErrorMessage("单组模式请先选择“单组输入目录”，系统会从该目录读取输入图并回写 result_A 与 result_0 到 result_5");
      return;
    }

    const runAbortController = createRunAbortController();
    setIsGenerating(true);
    try {
      const stepAPrompt = buildSingleStepAPrompt(template.stepOnePrompt);
      const stepBPrompt = buildSingleStepBPrompt(template.mainPrompt);
      const stepTwoPrompt = buildStepTwoPrompt(template.stepTwoPrompt);
      const [productFile, shoeFile, outfitFile, backgroundFile] = await readBatchGroupInput(singleInputDirectory.handle);
      const expectedFiles = ["result_A.png", "result_0.png", "result_1.png", "result_2.png", "result_3.png", "result_4.png", "result_5.png"];

      if (continueFromExisting) {
        const missing = await listMissingResultFiles(singleInputDirectory.handle, expectedFiles);
        if (missing.length === 0) {
          setStatusMessage("单组目录已存在 result_A 到 result_5，已跳过。");
          return;
        }
      }

      let stepABlob: Blob;
      const hasResultA = continueFromExisting && (await fileExists(singleInputDirectory.handle, "result_A.png"));
      if (hasResultA) {
        stepABlob = await readBlobFile(singleInputDirectory.handle, "result_A.png");
        setStatusMessage("单组第A步：检测到已存在 result_A.png，跳过重生。");
      } else {
        setStatusMessage("单组第A步：正在生成 result_A...");
        const stepASource = await generateImageWithPerImageRetry({
          createFormData: () =>
            buildImageGenerationFormDataByRole({
              prompt: stepAPrompt,
              aspectRatio,
              outputSize,
              sock: productFile,
              shoe: shoeFile,
              skipPromptGuard: true
            }),
          onProgress: (message) => setStatusMessage(`单组第A步：${message}`),
          taskLabel: "单组第A步 result_A",
          signal: runAbortController.signal
        });
        setGeneratedImageUrl(stepASource);

        throwIfStopRequested();
        stepABlob = await fetchImageBlob(stepASource, runAbortController.signal);
        await writeBlobFile(singleInputDirectory.handle, "result_A.png", stepABlob);
        setStatusMessage("单组第A步：已写入 result_A.png");
      }
      const resultAFile = new File([stepABlob], "result_A.png", { type: stepABlob.type || "image/png" });

      let stepBBlob: Blob;
      const hasResult0 = continueFromExisting && (await fileExists(singleInputDirectory.handle, "result_0.png"));
      if (hasResult0) {
        stepBBlob = await readBlobFile(singleInputDirectory.handle, "result_0.png");
        setStatusMessage("单组第B步：检测到已存在 result_0.png，跳过重生。");
      } else {
        setStatusMessage("单组第B步：正在生成 result_0...");
        const stepBSource = await generateImageWithPerImageRetry({
          createFormData: () =>
            buildImageGenerationFormDataByRole({
              prompt: stepBPrompt,
              aspectRatio: BATCH_ASPECT_RATIO,
              outputSize,
              sock: resultAFile,
              outfit: outfitFile,
              background: backgroundFile,
              skipPromptGuard: true
            }),
          onProgress: (message) => setStatusMessage(`单组第B步：${message}`),
          taskLabel: "单组第B步 result_0",
          signal: runAbortController.signal
        });
        setGeneratedImageUrl(stepBSource);

        throwIfStopRequested();
        stepBBlob = await fetchImageBlob(stepBSource, runAbortController.signal);
        await writeBlobFile(singleInputDirectory.handle, "result_0.png", stepBBlob);
        setStatusMessage("单组第B步：已写入 result_0.png");
      }
      const result0File = new File([stepBBlob], "result_0.png", { type: stepBBlob.type || "image/png" });

      let latestVariantSource = generatedImageUrl;
      for (let variantIndex = 1; variantIndex <= BATCH_VARIANT_COUNT; variantIndex++) {
        if (continueFromExisting && (await fileExists(singleInputDirectory.handle, `result_${variantIndex}.png`))) {
          setStatusMessage(`单组第2步：result_${variantIndex}.png 已存在，跳过。`);
          continue;
        }

        throwIfStopRequested();
        setStatusMessage(`单组第C步：正在生成 result_${variantIndex}...`);
        const variantSource = await generateImageWithPerImageRetry({
          createFormData: () =>
            buildImageGenerationFormData({
              prompt: buildSingleVariantPrompt(stepTwoPrompt, variantIndex),
              aspectRatio: BATCH_ASPECT_RATIO,
              outputSize,
              files: [result0File]
            }),
          onProgress: (message) => setStatusMessage(`单组第C步 result_${variantIndex}：${message}`),
          taskLabel: `单组第C步 result_${variantIndex}`,
          signal: runAbortController.signal
        });
        const variantBlob = await fetchImageBlob(variantSource, runAbortController.signal);
        if (singleInputDirectory) {
          await writeBlobFile(singleInputDirectory.handle, `result_${variantIndex}.png`, variantBlob);
          setStatusMessage(`单组第C步：已写入 result_${variantIndex}.png`);
        }
        latestVariantSource = variantSource;
        setGeneratedImageUrl(variantSource);
        if (variantIndex < BATCH_VARIANT_COUNT) {
          await sleepWithSignal(THROTTLE_BETWEEN_IMAGES_MS, runAbortController.signal);
        }
      }

      if (latestVariantSource) {
        setGeneratedImageUrl(latestVariantSource);
      }
      setStatusMessage(
        "单组三步流程完成，已写入该输入目录：result_A.png 与 result_0.png 到 result_5.png。"
      );
    } catch (error) {
      if (isAbortLikeError(error)) {
        setStatusMessage("单组任务已停止。");
      } else {
        setErrorMessage(toErrorMessage(error, "单组生成失败"));
      }
    } finally {
      setIsGenerating(false);
      clearRunAbortController(runAbortController);
    }
  }

  async function handlePickBatchInputDirectory() {
    try {
      const directoryHandle = await pickDirectory("batch-input", "readwrite");
      const granted = await ensureDirectoryPermission(directoryHandle, "readwrite");
      if (!granted) {
        throw new Error("未获得输入目录写入权限，无法回写 result_0 到 result_5");
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

      const stepOnePrompt = buildStepOnePrompt(template.mainPrompt, template.stepOnePrompt);
      const stepTwoPrompt = buildStepTwoPrompt(template.stepTwoPrompt);

      let success = 0;
      let failed = 0;
      appendBatchLog(`共发现 ${groups.length} 组任务，开始处理...`);
      appendBatchLog(`目录读取顺序：背景 -> 产品 -> 服装 -> 鞋子；模型输入顺序：产品 -> 鞋子 -> 服装 -> 背景。`);

      for (let i = 0; i < groups.length; i++) {
        throwIfStopRequested();
        const group = groups[i];
        if (i > 0) {
          appendBatchLog(`等待 ${Math.round(THROTTLE_BETWEEN_GROUPS_MS / 1000)} 秒，降低限流风险...`);
          await sleepWithSignal(THROTTLE_BETWEEN_GROUPS_MS, runAbortController.signal);
        }
        appendBatchLog(`[${i + 1}/${groups.length}] 处理：${group.name}`);
        try {
          const referenceFiles = await readBatchGroupInput(group.handle);
          const expectedFiles = ["result_0.png", "result_1.png", "result_2.png", "result_3.png", "result_4.png", "result_5.png"];
          if (continueFromExisting) {
            const missing = await listMissingResultFiles(group.handle, expectedFiles);
            if (missing.length === 0) {
              success += 1;
              appendBatchLog(`[${group.name}] 已存在 result_0~5，跳过。`);
              continue;
            }
          }

          let stepOneBlob: Blob;
          if (continueFromExisting && (await fileExists(group.handle, "result_0.png"))) {
            stepOneBlob = await readBlobFile(group.handle, "result_0.png");
            appendBatchLog(`[${group.name}] 检测到 result_0.png，跳过第一步重生。`);
          } else {
            const stepOneSource = await generateImageWithPerImageRetry({
              createFormData: () =>
                buildImageGenerationFormData({
                  prompt: stepOnePrompt,
                  aspectRatio: BATCH_ASPECT_RATIO,
                  outputSize,
                  files: referenceFiles
              }),
              onProgress: (message) => appendBatchLog(`[${group.name}] ${message}`),
              taskLabel: `${group.name} result_0`,
              signal: runAbortController.signal
            });
            stepOneBlob = await fetchImageBlob(stepOneSource, runAbortController.signal);
            await writeBlobFile(group.handle, "result_0.png", stepOneBlob);
            setGeneratedImageUrl(stepOneSource);
            appendBatchLog(`[${group.name}] 已保存 result_0.png`);
          }

          const result0File = new File([stepOneBlob], "result_0.png", { type: stepOneBlob.type || "image/png" });
          let latestVariantSource: string | null = null;

          for (let variantIndex = 1; variantIndex <= BATCH_VARIANT_COUNT; variantIndex++) {
            if (continueFromExisting && (await fileExists(group.handle, `result_${variantIndex}.png`))) {
              appendBatchLog(`[${group.name}] result_${variantIndex}.png 已存在，跳过。`);
              continue;
            }
            throwIfStopRequested();
            appendBatchLog(`[${group.name}] 开始生成 result_${variantIndex}.png`);
            const variantSource = await generateImageWithPerImageRetry({
              createFormData: () =>
                buildImageGenerationFormData({
                  prompt: buildSingleVariantPrompt(stepTwoPrompt, variantIndex),
                  aspectRatio: BATCH_ASPECT_RATIO,
                  outputSize,
                  files: [result0File]
                }),
              onProgress: (message) => appendBatchLog(`[${group.name}] ${message}`),
              taskLabel: `${group.name} result_${variantIndex}`,
              signal: runAbortController.signal
            });
            const variantBlob = await fetchImageBlob(variantSource, runAbortController.signal);
            await writeBlobFile(group.handle, `result_${variantIndex}.png`, variantBlob);
            latestVariantSource = variantSource;
            setGeneratedImageUrl(variantSource);
            appendBatchLog(`[${group.name}] 已生成并写入 result_${variantIndex}.png`);
            if (variantIndex < BATCH_VARIANT_COUNT) {
              await sleepWithSignal(THROTTLE_BETWEEN_IMAGES_MS, runAbortController.signal);
            }
          }

          if (latestVariantSource) {
            setGeneratedImageUrl(latestVariantSource);
          }
          success += 1;
          appendBatchLog(`[${group.name}] 成功，已写入 result_0.png 到 result_5.png`);
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

  async function generateImageWithPerImageRetry(params: {
    createFormData: () => FormData;
    taskLabel: string;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  }): Promise<string> {
    const { createFormData, taskLabel, signal, onProgress } = params;
    const attempts = Math.max(1, Math.floor(imageRetryLimit) + 1);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        if (attempt > 1) {
          onProgress?.(`${taskLabel} 第 ${attempt} 次尝试...`);
        }
        throwIfStopRequested();
        const source = await submitAndWaitImage(createFormData(), onProgress, signal);
        return source;
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

  async function pollTaskUntilDone(taskId: string, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<string> {
    const maxAttempts = 50;
    const intervalMs = 3000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfStopRequested();
      const response = await fetch(`/api/generate?taskId=${encodeURIComponent(taskId)}`, { method: "GET", signal });
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
        await sleepWithSignal(intervalMs, signal);
      }
    }

    throw new Error(`任务超时，请稍后重试。任务ID: ${taskId}`);
  }

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

  function updateUpload(role: UploadRole, file: File | null) {
    setUploads((current) => current.map((slot) => (slot.role === role ? { ...slot, file } : slot)));
  }

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="muted tiny">当前输出画质：{outputSize}</div>
        <span className="hero-badge">四图主图系统 · 两步批处理</span>
        <h1>输入产品/模特/场景，生成展示图</h1>
        <p>批量模式会按每个子文件夹直接回写 result_0 到 result_5，不改变原文件结构。</p>
      </section>

      <div className="layout-grid">
        <div className="stack">
          <section className="panel panel-strong">
            <div className="section">
              <div className="section-header">
                <div>
                  <h2>批量生图</h2>
                  <p>每个子文件夹作为一组，目录读取顺序按“背景-产品-服装-鞋子”，模型输入顺序会自动重排成“产品-鞋子-服装-背景”。</p>
                </div>
                <span className="status-pill status-running">{isBatchGenerating ? "运行中" : "待开始"}</span>
              </div>
              <div className="toolbar-wide">
                <button className="secondary-button" onClick={handlePickBatchInputDirectory}>
                  选择输入目录
                </button>
                <button className="primary-button" disabled={isBatchGenerating} onClick={handleStartBatchGeneration}>
                  {isBatchGenerating ? "批量生成中..." : "开始批量生图"}
                </button>
                <button className="danger-button" disabled={(!isBatchGenerating && !isGenerating) || isStopRequested} onClick={handleStopTasks}>
                  {isStopRequested ? "停止中..." : "停止任务"}
                </button>
              </div>
              <div className="toolbar">
                <div className="field">
                  <label htmlFor="imageRetryLimit">单张失败重试次数</label>
                  <input
                    id="imageRetryLimit"
                    type="number"
                    min={0}
                    max={8}
                    step={1}
                    value={imageRetryLimit}
                    onChange={(event) => setImageRetryLimit(clampRetryLimit(event.target.value))}
                  />
                </div>
                <div className="field">
                  <label htmlFor="continueFromExisting">断点续跑</label>
                  <select id="continueFromExisting" value={continueFromExisting ? "on" : "off"} onChange={(event) => setContinueFromExisting(event.target.value === "on")}>
                    <option value="on">开启（跳过已存在 result 文件）</option>
                    <option value="off">关闭（整组重跑覆盖）</option>
                  </select>
                </div>
              </div>
              <div className="stack">
                <div className="note-card tiny">输入目录：{batchInputDirectory ? batchInputDirectory.name : "未选择"}</div>
                <div className="note-card tiny">输出规则：结果直接写回各子文件夹，命名为 result_0.png 到 result_5.png</div>
                <div className="note-card tiny">当前策略：单张失败最多重试 {imageRetryLimit} 次；{continueFromExisting ? "开启断点续跑" : "关闭断点续跑"}。</div>
              </div>
            </div>

            <div className="section">
              <div className="section-header">
                <div>
                  <h2>单组输入</h2>
                  <p>单组生成会从“单组输入目录”读取图片并回写 result_A 与 result_0 到 result_5。上传区仅用于预览与对照。</p>
                </div>
              </div>

              <div className="toolbar-wide">
                <button className="secondary-button" onClick={handlePickSingleInputDirectory}>
                  选择单组输入目录
                </button>
                <div className="note-card tiny">单组目录：{singleInputDirectory ? singleInputDirectory.name : "未选择（仅预览，不回写）"}</div>
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
                  <p>左下角可直接编辑基础提示词、第一步微调提示词和第二步裂变提示词。</p>
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

              <div className="stack">
                <div className="field">
                  <label htmlFor="mainPrompt">基础提示词</label>
                  <textarea id="mainPrompt" value={template.mainPrompt} onChange={(event) => setTemplate((current) => ({ ...current, mainPrompt: event.target.value }))} />
                </div>
                <div className="field">
                  <label htmlFor="stepOnePrompt">第一步提示词微调</label>
                  <textarea id="stepOnePrompt" value={template.stepOnePrompt} onChange={(event) => setTemplate((current) => ({ ...current, stepOnePrompt: event.target.value }))} />
                </div>
                <div className="field">
                  <label htmlFor="stepTwoPrompt">第二步裂变提示词</label>
                  <textarea id="stepTwoPrompt" value={template.stepTwoPrompt} onChange={(event) => setTemplate((current) => ({ ...current, stepTwoPrompt: event.target.value }))} />
                </div>
              </div>

              <div className="toolbar-wide">
                <button className="primary-button" disabled={isGenerating || isBatchGenerating || !singleInputDirectory} onClick={handleStartGeneration}>
                  {isGenerating ? "单组生成中..." : "开始单组生图"}
                </button>
                <button className="danger-button" disabled={(!isBatchGenerating && !isGenerating) || isStopRequested} onClick={handleStopTasks}>
                  {isStopRequested ? "停止中..." : "停止任务"}
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
                <div className="preview-box preview-full">
                  {generatedImageUrl ? <img alt="最新生成结果" src={generatedImageUrl} /> : <div className="preview-placeholder">暂无结果图</div>}
                </div>
                {generatedImageUrl ? (
                  <div style={{ marginTop: 12 }}>
                    <button className="secondary-button" onClick={() => downloadImageSource(generatedImageUrl, buildResultFileName())}>
                      下载结果
                    </button>
                  </div>
                ) : null}
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

function buildStepOnePrompt(mainPrompt: string, stepOnePrompt: string): string {
  const base = mainPrompt.trim();
  const tweak = stepOnePrompt.trim();
  if (!base) {
    return tweak;
  }
  if (!tweak) {
    return base;
  }
  return `${base}\n\n${tweak}`;
}

function buildSingleStepAPrompt(stepOnePrompt: string): string {
  const tweak = stepOnePrompt.trim();
  if (!tweak) {
    return SINGLE_STEP_A_PROMPT;
  }
  return `${SINGLE_STEP_A_PROMPT}\n\n${tweak}`;
}

function buildSingleStepBPrompt(mainPrompt: string): string {
  const tweak = mainPrompt.trim();
  if (!tweak) {
    return SINGLE_STEP_B_PROMPT;
  }
  return `${SINGLE_STEP_B_PROMPT}\n\n${tweak}`;
}

function buildImageGenerationFormData(params: {
  prompt: string;
  aspectRatio: MainAspectRatio;
  outputSize: OutputSize;
  files: File[];
}): FormData {
  const formData = new FormData();
  formData.append("prompt", buildPromptWithProductLock(params.prompt));
  formData.append("aspectRatio", params.aspectRatio);
  formData.append("outputSize", params.outputSize);

  if (params.files.length === 4) {
    formData.append("sock", params.files[0]);
    formData.append("shoe", params.files[1]);
    formData.append("outfit", params.files[2]);
    formData.append("background", params.files[3]);
    return formData;
  }

  if (params.files.length === 1) {
    formData.append("sock", params.files[0]);
    return formData;
  }

  throw new Error(`不支持的输入图片数量：${params.files.length}`);
}

function buildImageGenerationFormDataByRole(params: {
  prompt: string;
  aspectRatio: MainAspectRatio;
  outputSize: OutputSize;
  sock?: File;
  shoe?: File;
  outfit?: File;
  background?: File;
  skipPromptGuard?: boolean;
}): FormData {
  const formData = new FormData();
  formData.append("prompt", params.skipPromptGuard ? params.prompt : buildPromptWithProductLock(params.prompt));
  formData.append("aspectRatio", params.aspectRatio);
  formData.append("outputSize", params.outputSize);
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

function buildPromptWithProductLock(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return PRODUCT_LOCK_PROMPT;
  }
  if (trimmed.includes("【产品硬约束（必须执行）】")) {
    return appendStrictConsistencyPrompt(trimmed);
  }
  return appendStrictConsistencyPrompt(`${trimmed}\n\n${PRODUCT_LOCK_PROMPT}`);
}

function appendStrictConsistencyPrompt(prompt: string): string {
  if (prompt.includes("【强一致性约束（最高优先级，必须执行）】")) {
    return prompt;
  }
  return `${prompt}\n\n${STRICT_CONSISTENCY_PROMPT}`;
}

function buildStepTwoPrompt(stepTwoPrompt: string): string {
  return stepTwoPrompt.trim();
}

function buildSingleVariantPrompt(stepTwoPrompt: string, variantIndex: number): string {
  const actionPrompt = VARIANT_ACTION_PROMPTS[variantIndex];
  if (!actionPrompt) {
    throw new Error(`无效的裂变索引：${variantIndex}`);
  }

  const base = stepTwoPrompt.trim();
  return `${base}

【本次执行模式（必须）】
仅生成 1 张图片，本次只执行以下动作要求，不允许出现其他动作：
${actionPrompt}

【禁止项（必须）】
禁止把多个动作放进同一张图；
禁止拼图、分屏、九宫格、连拍排版、海报排版；
禁止在画面中添加文字、序号、水印、边框。

如果上文出现“生成5张”，以本节“仅生成1张”为最高优先级执行。`;
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
    throw new Error("该组图片不足4张");
  }

  const background = files[0];
  const product = files[1];
  const outfit = files[2];
  const shoe = files[3];

  return [product, shoe, outfit, background];
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

async function readBlobFile(directoryHandle: FileSystemDirectoryHandle, fileName: string): Promise<Blob> {
  const handle = await directoryHandle.getFileHandle(fileName, { create: false });
  return await handle.getFile();
}

async function listMissingResultFiles(directoryHandle: FileSystemDirectoryHandle, fileNames: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const fileName of fileNames) {
    if (!(await fileExists(directoryHandle, fileName))) {
      missing.push(fileName);
    }
  }
  return missing;
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

function isAbortLikeError(error: unknown): boolean {
  if (isAbortError(error)) {
    return true;
  }
  if (error instanceof Error) {
    return error.message.includes(MANUAL_STOP_MESSAGE) || error.name === "AbortError";
  }
  return false;
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

async function downloadImageSource(source: string, fileName: string): Promise<void> {
  const blob = await fetchImageBlob(source);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = fileName;
    link.click();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
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

function buildResultFileName(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `generated-${timestamp}.png`;
}

function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) {
    return true;
  }
  const lower = file.name.toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"].some((ext) => lower.endsWith(ext));
}

function isGeneratedResultFile(fileName: string): boolean {
  return /^result_[0-5]\.(png|jpg|jpeg|webp|bmp|gif)$/i.test(fileName.trim());
}

function clampRetryLimit(input: string): number {
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_IMAGE_RETRY_LIMIT;
  }
  return Math.max(0, Math.min(8, parsed));
}
