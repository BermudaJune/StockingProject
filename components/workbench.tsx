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

type ModelProvider = "openai" | "banana";

const UPLOAD_SLOTS: Array<Omit<UploadSlot, "file">> = [
  {
    role: "sock",
    label: "图1：产品图（袜子）",
    hint: "核心袜子产品参考图，优先级最高。"
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
const MODEL_PROVIDERS: Array<{ value: ModelProvider; label: string }> = [
  { value: "openai", label: "OpenAI (/v1/chat/completions)" },
  { value: "banana", label: "Banana (/v1beta/...:generateContent)" }
];
const PRODUCT_VIEW_FILE_NAMES = ["product_1.png", "product_2.png", "product_3.png"] as const;
const RESULT_FILE_NAMES = ["result_A.png", "result_B.png", "result_0.png", "result_1.png", "result_2.png", "result_3.png", "result_4.png", "result_5.png"] as const;
const ALL_EXPECTED_OUTPUT_FILES = [...PRODUCT_VIEW_FILE_NAMES, ...RESULT_FILE_NAMES];
const PRODUCT_LOCK_PROMPT = `【产品硬约束（必须执行）】
输入产品图（及 product_1/product_2/product_3）中的袜子是唯一标准，禁止任何改款、改色、改材质、改纹理、改长度、改版型。
必须100%保持与输入产品一致，不得新增装饰、logo、图案或结构变化。`;
const STRICT_CONSISTENCY_PROMPT = `【强一致性约束（最高优先级，必须执行）】
背景必须严格与背景参考图一致：空间版面、机位高度、透视关系、明暗分区、光影方向、墙地比例都不可改变。
鞋子必须严格与鞋子参考图一致：款式、鞋头形状、鞋跟高度、材质反光、配色与细节不可改变。
服装必须严格与服装参考图一致：外套/内搭/下装的服装元素、版型轮廓、颜色关系不可改变。
袜子必须严格与 product_1（正面）、product_2（侧面）、product_3（背面）一致：脚背是否露出、标签前后位置、纹理细节、开口位置、长度、贴合方式都必须一致。
禁止任何与参考图不一致的改动；若动作与一致性冲突，优先保证一致性。`;
const PRODUCT_VIEW_PROMPTS: Record<1 | 2 | 3, string> = {
  1: `使用输入袜子产品图生成 product_1（正面）白底图。
要求：只输出单一产品，纯白背景，完整展示正面结构；保持款式、纹理、标签位置、长度与材质一致；禁止场景元素。`,
  2: `使用输入袜子产品图生成 product_2（侧面）白底图。
要求：只输出单一产品，纯白背景，完整展示侧面结构；保持款式、纹理、标签位置、长度与材质一致；禁止场景元素。`,
  3: `使用输入袜子产品图生成 product_3（背面）白底图。
要求：只输出单一产品，纯白背景，完整展示背面结构；保持款式、纹理、标签位置、长度与材质一致；禁止场景元素。`
};
const PRODUCT_STEP_SOCK_ONLY_PROMPT = `【P步产品定义（必须）】
此处“产品图”仅指袜子产品图，不是鞋子、服装或其他商品；
product_1 / product_2 / product_3 必须只展示袜子本体。`;
const SINGLE_STEP_A_PROMPT = `生成一张女性腿部与脚部的电商展示图（输出 result_A）。

【参考图分工】
- 图1：product_1（正面产品图），用于正面外观标准
- 图2：鞋子参考图，仅用于鞋型与材质
- 图3：product_2（侧面产品图），用于侧面结构与贴合标准
- 图4：product_3（背面产品图），用于背面结构与标签位置标准

【严格要求】
- 仅生成腿部与脚部（大腿中部到脚尖）
- 袜子必须严格使用产品图同款，产品图中的袜子是唯一标准
- 不得替换袜型，不得改动纹理、镂空、标签位置、长度与贴合方式
- 鞋子必须严格基于图2，不得替换为其他鞋型
- 不生成服装
- 若产品图判定为连裤袜，腿部皮肤不得露出，必须呈现连体覆盖
- 背景必须保持纯白，不生成场景
- 姿态自然，符合真实模特拍摄逻辑

输出：单张图像`;
const SINGLE_STEP_B_PROMPT = `基于 result_A 与服装参考图进行编辑（输出 result_B）。

【绝对锁定】
- result_A 中的腿部、袜子、鞋子必须完全保持不变
- 不得重绘、不得修改袜子或鞋子

【参考图分工】
- 图2：服装参考图，仅用于服装款式与配色

【生成要求】
- 添加自然站立的全身模特形象，要时尚有魅力，最大程度吸取服装参考图的高级感
- 模特设定为亚洲女性，五官与体态保持自然真实
- 服装弱化处理，不得遮挡袜子主体
- 背景必须保持纯白，不生成场景
- 构图为竖图，3:4，电商穿搭风格

输出：单张全身主图`;
const SINGLE_STEP_C_PROMPT = `基于 result_B 与背景参考图进行编辑（输出 result_0）。

【绝对锁定】
- result_B 中的人物、腿部、袜子、鞋子、服装必须完全保持不变
- 不得重绘、不得修改人物、袜子、鞋子或服装

【参考图分工】
- 图3：背景参考图，仅用于空间结构、地面/墙面关系、主光方向

【生成要求】
- 从本步开始才允许出现非白底背景
- 仅替换背景与光影，背景图只负责背景空间与光影，不得影响人物主体
- result_B 中的服装、鞋子、袜子必须严格继承，不得被背景图污染
- 模特保持亚洲女性特征，不改变人物身份
- 构图为竖图，3:4，电商穿搭风格

输出：单张全身主图`;
const STEP_C_BODY_LOCK_PROMPT = `【Step C 继承锁定（最高优先级，必须）】
result_B 中的服装、鞋子、袜子必须 100% 保持不变；
背景图只允许提供背景空间与光影，不得影响人物、鞋子、袜子、服装的任何细节。`;
const STEP_C_PANTYHOSE_LOCK_PROMPT = `【Step C 连裤袜锁定（必须）】
如果 result_B 判定为连裤袜，则 result_0 也必须继续保持腿部皮肤不露出，不得因为背景而露肉。`;
const STEP_A_SOCK_LOCK = `【Step A 袜子硬约束（必须）】
product_1 / product_2 / product_3 三视图是唯一标准；
不得替换袜型，不得修改纹理、镂空、标签位置、长度与贴合方式。`;
const STEP_A_SOCK_PRIORITY_PROMPT = `【Step A 优先级（必须）】
当鞋子与袜子信息存在冲突时，优先保留袜子三视图信息；
袜子一致性优先级高于鞋子风格迁移。`;
const STEP_A_DETAIL_LOCK_PROMPT = `【Step A 细节对齐（最高优先级，必须）】
必须充分参考 product_1 / product_2 / product_3 的细节，尤其是：
- 纹理走向、针织密度、镂空结构
- 标签位置与前后朝向
- 长度、开口位置、包裹贴合方式
- 若判定为连裤袜，腿部不得出现“袜口以上露肉”
若生成结果与三视图细节冲突，以三视图为唯一标准重对齐。`;
const STEP_B_OUTFIT_SCOPE_LOCK_PROMPT = `【Step B 服装参考范围（必须）】
服装参考图只允许提供上衣/外套/下装等服装信息；
禁止参考其中的鞋子与袜子信息。`;
const STEP_B_SHOE_SOCK_LOCK_PROMPT = `【Step B 鞋袜锁定（最高优先级，必须）】
result_A 中的鞋子与袜子必须 100% 保持不变；
不得因为服装参考图中的鞋袜而替换、重绘、改色或改纹理。`;
const SOCK_LENGTH_CLASSIFICATION_PROMPT = `【袜长分类约束（最高优先级，必须）】
执行顺序必须为：先完成袜长分类并锁定类别，再进行生成与重绘。
袜子必须按“长度类别”严格匹配，不得串类或模糊化：
- 短筒袜：袜口在踝部附近（低于小腿中段）
- 长筒袜：袜口在小腿中上段（低于膝盖）
- 及膝袜：袜口到膝盖附近
- 连裤袜：从腰臀到脚部一体连接
- 丝袜：薄透质感类别，长度仍需归入上述对应长度形态
如果产品图无法清晰看出腿部露肉边界，必须判定为连裤袜；连裤袜生成时腿部皮肤不得露出，必须表现为连体覆盖效果。
先判定长度类别，再执行纹理/标签/贴合一致性约束。`;
const MODEL_REALISM_PROMPT = `【模特自然度与体态约束（必须）】
默认使用亚洲女性模特，整体气质纤细、自然、干净，适合电商穿搭展示。

体型要求：
- 身材纤细修长
- 腿部线条自然流畅
- 小腿收紧
- 脚踝清晰
- 比例自然
- 不要夸张超模感
- 不要肌肉感过强

肤色与皮肤质感要求：
- 中性偏冷白或自然干净肤色
- 皮肤通透
- 保留真实皮肤质感
- 腿部可有轻微自然高光
- 禁止塑料皮肤感
- 禁止AI过度磨皮与假人质感

细节瑕疵要求（必须保留）：
- pores（毛孔）
- skin texture（皮肤纹理）
- freckles（雀斑）
- uneven skin tone（不均匀肤色）
- birthmarks（痣/胎记）

面部非对称要求（必须保留）：
- asymmetrical features（轻微不对称面部特征）
- slightly crooked nose（鼻梁/鼻尖轻微不完全对称）
- uneven eyes（轻微大小眼）

成像与光影质感：
- natural lighting
- subsurface scattering（皮肤透光）
- film grain
- shot on 35mm
- 保留轻微真实拍摄缺陷，避免CG级过度干净边缘`;
const ANTI_AI_NEGATIVE_PROMPT = `【Negative Prompt（抑制AI感，必须避免）】
smooth skin, airbrushed, plastic skin, doll-like, perfect symmetry, cg render, unreal engine, 3d render`;
const VARIANT_PRODUCT_VIEW_LOCK_PROMPT = `【三视图一致性约束（必须）】
- product_1：正面标准
- product_2：侧面标准
- product_3：背面标准
裂变时必须同时参考三张图并保持袜子外观严格一致。`;
const PRE_BACKGROUND_WHITE_LOCK_PROMPT = `【白底约束（必须）】
在加入背景前（product_1~3、result_A、result_B）必须保持纯白背景，不得出现任何场景元素。`;
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
  5: `第 5 张【细节图・袜子质感特写】
- 中近景，聚焦小腿至脚踝区域
- 模特自然站立，单腿微重心
- 袜子占据画面主要视觉，细节清晰
- 浅景深处理，弱化背景与腿部其余部分
- 强调针织肌理、镂空细节与面料高级感`
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
  const [modelProvider, setModelProvider] = useState<ModelProvider>("openai");

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
        throw new Error("未获得单组输入目录写入权限，无法回写 product_1~3 与 result_A/B/0/1~5");
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
      setErrorMessage("单组模式请先选择“单组输入目录”，系统会从该目录读取输入图并回写 product_1~3 与 result_A/B/0/1~5");
      return;
    }

    const runAbortController = createRunAbortController();
    setIsGenerating(true);
    try {
      const productViewPrompt = buildProductViewPrompt(template.mainPrompt);
      const stepAPrompt = buildSingleStepAPrompt(template.stepOnePrompt);
      const stepBPrompt = buildSingleStepBPrompt(template.stepThreePrompt);
      const stepCPrompt = buildSingleStepCPrompt(template.stepTwoPrompt);
      const stepDPrompt = buildStepFourPrompt(template.stepFourPrompt);
      const [productFile, shoeFile, outfitFile, backgroundFile] = await readBatchGroupInput(singleInputDirectory.handle);

      if (continueFromExisting) {
        const missing = await listMissingResultFiles(singleInputDirectory.handle, ALL_EXPECTED_OUTPUT_FILES);
        if (missing.length === 0) {
          setStatusMessage("单组目录已存在 product_1~3 与 result_A/B/0/1~5，已跳过。");
          return;
        }
      }

      const productViewFiles: File[] = [];
      for (const productViewIndex of [1, 2, 3] as const) {
        const viewFileName = `product_${productViewIndex}.png`;
        let productViewBlob: Blob;
        if (continueFromExisting && (await fileExists(singleInputDirectory.handle, viewFileName))) {
          productViewBlob = await readBlobFile(singleInputDirectory.handle, viewFileName);
          setStatusMessage(`单组第P步：检测到已存在 ${viewFileName}，跳过重生。`);
        } else {
          setStatusMessage(`单组第P步：正在生成 ${viewFileName}...`);
          const productViewSource = await generateImageWithPerImageRetry({
            createFormData: () =>
              buildImageGenerationFormDataByRole({
                prompt: buildSingleProductViewPrompt(productViewPrompt, productViewIndex),
                aspectRatio,
                outputSize,
                sock: productFile,
                modelProvider,
                skipPromptGuard: true
              }),
            onProgress: (message) => setStatusMessage(`单组第P步 ${viewFileName}：${message}`),
            taskLabel: `单组第P步 ${viewFileName}`,
            signal: runAbortController.signal
          });
          setGeneratedImageUrl(productViewSource);
          throwIfStopRequested();
          productViewBlob = await fetchImageBlob(productViewSource, runAbortController.signal);
          await writeBlobFile(singleInputDirectory.handle, viewFileName, productViewBlob);
          setStatusMessage(`单组第P步：已写入 ${viewFileName}`);
        }
        productViewFiles[productViewIndex - 1] = new File([productViewBlob], viewFileName, { type: productViewBlob.type || "image/png" });
      }
      const productOneFile = productViewFiles[0];
      const productTwoFile = productViewFiles[1];
      const productThreeFile = productViewFiles[2];
      if (!productOneFile || !productTwoFile || !productThreeFile) {
        throw new Error("product_1~3 生成失败，无法继续后续步骤");
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
              sock: productOneFile,
              shoe: shoeFile,
              outfit: productTwoFile,
              background: productThreeFile,
              modelProvider,
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
      const hasResultB = continueFromExisting && (await fileExists(singleInputDirectory.handle, "result_B.png"));
      if (hasResultB) {
        stepBBlob = await readBlobFile(singleInputDirectory.handle, "result_B.png");
        setStatusMessage("单组第B步：检测到已存在 result_B.png，跳过重生。");
      } else {
        setStatusMessage("单组第B步：正在生成 result_B...");
        const stepBSource = await generateImageWithPerImageRetry({
          createFormData: () =>
            buildImageGenerationFormDataByRole({
              prompt: stepBPrompt,
              aspectRatio: BATCH_ASPECT_RATIO,
              outputSize,
              sock: resultAFile,
              outfit: outfitFile,
              modelProvider,
              skipPromptGuard: true
            }),
          onProgress: (message) => setStatusMessage(`单组第B步：${message}`),
          taskLabel: "单组第B步 result_B",
          signal: runAbortController.signal
        });
        setGeneratedImageUrl(stepBSource);

        throwIfStopRequested();
        stepBBlob = await fetchImageBlob(stepBSource, runAbortController.signal);
        await writeBlobFile(singleInputDirectory.handle, "result_B.png", stepBBlob);
        setStatusMessage("单组第B步：已写入 result_B.png");
      }
      const resultBFile = new File([stepBBlob], "result_B.png", { type: stepBBlob.type || "image/png" });

      let stepCBlob: Blob;
      const hasResult0 = continueFromExisting && (await fileExists(singleInputDirectory.handle, "result_0.png"));
      if (hasResult0) {
        stepCBlob = await readBlobFile(singleInputDirectory.handle, "result_0.png");
        setStatusMessage("单组第C步：检测到已存在 result_0.png，跳过重生。");
      } else {
        setStatusMessage("单组第C步：正在生成 result_0...");
        const stepCSource = await generateImageWithPerImageRetry({
          createFormData: () =>
            buildImageGenerationFormDataByRole({
              prompt: stepCPrompt,
              aspectRatio: BATCH_ASPECT_RATIO,
              outputSize,
              sock: resultBFile,
              background: backgroundFile,
              modelProvider,
              skipPromptGuard: true
            }),
          onProgress: (message) => setStatusMessage(`单组第C步：${message}`),
          taskLabel: "单组第C步 result_0",
          signal: runAbortController.signal
        });
        setGeneratedImageUrl(stepCSource);

        throwIfStopRequested();
        stepCBlob = await fetchImageBlob(stepCSource, runAbortController.signal);
        await writeBlobFile(singleInputDirectory.handle, "result_0.png", stepCBlob);
        setStatusMessage("单组第C步：已写入 result_0.png");
      }
      const result0File = new File([stepCBlob], "result_0.png", { type: stepCBlob.type || "image/png" });

      let latestVariantSource = generatedImageUrl;
      for (let variantIndex = 1; variantIndex <= BATCH_VARIANT_COUNT; variantIndex++) {
        if (continueFromExisting && (await fileExists(singleInputDirectory.handle, `result_${variantIndex}.png`))) {
          setStatusMessage(`单组第D步：result_${variantIndex}.png 已存在，跳过。`);
          continue;
        }

        throwIfStopRequested();
        setStatusMessage(`单组第D步：正在生成 result_${variantIndex}...`);
        const variantSource = await generateImageWithPerImageRetry({
          createFormData: () =>
            buildImageGenerationFormDataByRole({
              prompt: buildSingleVariantPrompt(stepDPrompt, variantIndex),
              aspectRatio: BATCH_ASPECT_RATIO,
              outputSize,
              sock: result0File,
              shoe: productOneFile,
              outfit: productTwoFile,
              background: productThreeFile,
              modelProvider,
              skipPromptGuard: true
            }),
          onProgress: (message) => setStatusMessage(`单组第D步 result_${variantIndex}：${message}`),
          taskLabel: `单组第D步 result_${variantIndex}`,
          signal: runAbortController.signal
        });
        const variantBlob = await fetchImageBlob(variantSource, runAbortController.signal);
        if (singleInputDirectory) {
          await writeBlobFile(singleInputDirectory.handle, `result_${variantIndex}.png`, variantBlob);
          setStatusMessage(`单组第D步：已写入 result_${variantIndex}.png`);
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
        "单组流程完成，已写入该输入目录：product_1~3、result_A.png、result_B.png、result_0.png 与 result_1~result_5.png。"
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
        throw new Error("未获得输入目录写入权限，无法回写 product_1~3 与 result_A/B/0/1~5");
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

      const productViewPrompt = buildProductViewPrompt(template.mainPrompt);
      const stepAPrompt = buildSingleStepAPrompt(template.stepOnePrompt);
      const stepBPrompt = buildSingleStepBPrompt(template.stepThreePrompt);
      const stepCPrompt = buildSingleStepCPrompt(template.stepTwoPrompt);
      const stepDPrompt = buildStepFourPrompt(template.stepFourPrompt);

      let success = 0;
      let failed = 0;
      appendBatchLog(`共发现 ${groups.length} 组任务，开始处理...`);
      appendBatchLog(`按文件名关键词识别角色：产品=“款/产品”，鞋子=“鞋”，背景=“背景”，服装=“服装”；输入顺序：产品 -> 鞋子 -> 服装 -> 背景。`);

      for (let i = 0; i < groups.length; i++) {
        throwIfStopRequested();
        const group = groups[i];
        if (i > 0) {
          appendBatchLog(`等待 ${Math.round(THROTTLE_BETWEEN_GROUPS_MS / 1000)} 秒，降低限流风险...`);
          await sleepWithSignal(THROTTLE_BETWEEN_GROUPS_MS, runAbortController.signal);
        }
        appendBatchLog(`[${i + 1}/${groups.length}] 处理：${group.name}`);
        try {
          const [productFile, shoeFile, outfitFile, backgroundFile] = await readBatchGroupInput(group.handle);
          if (continueFromExisting) {
            const missing = await listMissingResultFiles(group.handle, ALL_EXPECTED_OUTPUT_FILES);
            if (missing.length === 0) {
              success += 1;
              appendBatchLog(`[${group.name}] 已存在 product_1~3 与 result_A/B/0/1~5，跳过。`);
              continue;
            }
          }

          const productViewFiles: File[] = [];
          for (const productViewIndex of [1, 2, 3] as const) {
            const viewFileName = `product_${productViewIndex}.png`;
            let productViewBlob: Blob;
            if (continueFromExisting && (await fileExists(group.handle, viewFileName))) {
              productViewBlob = await readBlobFile(group.handle, viewFileName);
              appendBatchLog(`[${group.name}] 检测到 ${viewFileName}，跳过第P步重生。`);
            } else {
              appendBatchLog(`[${group.name}] 开始生成 ${viewFileName}`);
              const productViewSource = await generateImageWithPerImageRetry({
                createFormData: () =>
                  buildImageGenerationFormDataByRole({
                    prompt: buildSingleProductViewPrompt(productViewPrompt, productViewIndex),
                    aspectRatio,
                    outputSize,
                    sock: productFile,
                    modelProvider,
                    skipPromptGuard: true
                  }),
                onProgress: (message) => appendBatchLog(`[${group.name}] ${message}`),
                taskLabel: `${group.name} ${viewFileName}`,
                signal: runAbortController.signal
              });
              productViewBlob = await fetchImageBlob(productViewSource, runAbortController.signal);
              await writeBlobFile(group.handle, viewFileName, productViewBlob);
              setGeneratedImageUrl(productViewSource);
              appendBatchLog(`[${group.name}] 已保存 ${viewFileName}`);
            }
            productViewFiles[productViewIndex - 1] = new File([productViewBlob], viewFileName, { type: productViewBlob.type || "image/png" });
          }
          const productOneFile = productViewFiles[0];
          const productTwoFile = productViewFiles[1];
          const productThreeFile = productViewFiles[2];
          if (!productOneFile || !productTwoFile || !productThreeFile) {
            throw new Error("product_1~3 生成失败，无法继续后续步骤");
          }

          let stepABlob: Blob;
          if (continueFromExisting && (await fileExists(group.handle, "result_A.png"))) {
            stepABlob = await readBlobFile(group.handle, "result_A.png");
            appendBatchLog(`[${group.name}] 检测到 result_A.png，跳过第A步重生。`);
          } else {
            const stepASource = await generateImageWithPerImageRetry({
              createFormData: () =>
                buildImageGenerationFormDataByRole({
                  prompt: stepAPrompt,
                  aspectRatio,
                  outputSize,
                  sock: productOneFile,
                  shoe: shoeFile,
                  outfit: productTwoFile,
                  background: productThreeFile,
                  modelProvider,
                  skipPromptGuard: true
                }),
              onProgress: (message) => appendBatchLog(`[${group.name}] ${message}`),
              taskLabel: `${group.name} result_A`,
              signal: runAbortController.signal
            });
            stepABlob = await fetchImageBlob(stepASource, runAbortController.signal);
            await writeBlobFile(group.handle, "result_A.png", stepABlob);
            setGeneratedImageUrl(stepASource);
            appendBatchLog(`[${group.name}] 已保存 result_A.png`);
          }

          const resultAFile = new File([stepABlob], "result_A.png", { type: stepABlob.type || "image/png" });

          let stepBBlob: Blob;
          if (continueFromExisting && (await fileExists(group.handle, "result_B.png"))) {
            stepBBlob = await readBlobFile(group.handle, "result_B.png");
            appendBatchLog(`[${group.name}] 检测到 result_B.png，跳过第B步重生。`);
          } else {
            const stepBSource = await generateImageWithPerImageRetry({
              createFormData: () =>
                buildImageGenerationFormDataByRole({
                  prompt: stepBPrompt,
                  aspectRatio: BATCH_ASPECT_RATIO,
                  outputSize,
                  sock: resultAFile,
                  outfit: outfitFile,
                  modelProvider,
                  skipPromptGuard: true
                }),
              onProgress: (message) => appendBatchLog(`[${group.name}] ${message}`),
              taskLabel: `${group.name} result_B`,
              signal: runAbortController.signal
            });
            stepBBlob = await fetchImageBlob(stepBSource, runAbortController.signal);
            await writeBlobFile(group.handle, "result_B.png", stepBBlob);
            setGeneratedImageUrl(stepBSource);
            appendBatchLog(`[${group.name}] 已保存 result_B.png`);
          }

          const resultBFile = new File([stepBBlob], "result_B.png", { type: stepBBlob.type || "image/png" });

          let stepCBlob: Blob;
          if (continueFromExisting && (await fileExists(group.handle, "result_0.png"))) {
            stepCBlob = await readBlobFile(group.handle, "result_0.png");
            appendBatchLog(`[${group.name}] 检测到 result_0.png，跳过第C步重生。`);
          } else {
            const stepCSource = await generateImageWithPerImageRetry({
              createFormData: () =>
                buildImageGenerationFormDataByRole({
                  prompt: stepCPrompt,
                  aspectRatio: BATCH_ASPECT_RATIO,
                  outputSize,
                  sock: resultBFile,
                  background: backgroundFile,
                  modelProvider,
                  skipPromptGuard: true
                }),
              onProgress: (message) => appendBatchLog(`[${group.name}] ${message}`),
              taskLabel: `${group.name} result_0`,
              signal: runAbortController.signal
            });
            stepCBlob = await fetchImageBlob(stepCSource, runAbortController.signal);
            await writeBlobFile(group.handle, "result_0.png", stepCBlob);
            setGeneratedImageUrl(stepCSource);
            appendBatchLog(`[${group.name}] 已保存 result_0.png`);
          }

          const result0File = new File([stepCBlob], "result_0.png", { type: stepCBlob.type || "image/png" });
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
                buildImageGenerationFormDataByRole({
                  prompt: buildSingleVariantPrompt(stepDPrompt, variantIndex),
                  aspectRatio: BATCH_ASPECT_RATIO,
                  outputSize,
                  sock: result0File,
                  shoe: productOneFile,
                  outfit: productTwoFile,
                  background: productThreeFile,
                  modelProvider,
                  skipPromptGuard: true
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
          appendBatchLog(`[${group.name}] 成功，已写入 product_1~3、result_A/B/0 与 result_1~5`);
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
        <div className="top-actions">
          <a className="ghost-button" href="/">
            返回主页
          </a>
          <a className="secondary-button" href="/workflow/txt-batch">
            去工作流2：4图+prompt.txt
          </a>
        </div>
        <div className="muted tiny">当前输出画质：{outputSize}</div>
        <span className="hero-badge">四图主图系统 · 五阶段批处理</span>
        <h1>输入产品/模特/场景，生成展示图</h1>
        <p>批量模式会按每个子文件夹直接回写 product_1~3 与 result_A/B/0/1~5，不改变原文件结构。</p>
      </section>

      <div className="layout-grid">
        <div className="stack">
          <section className="panel panel-strong">
            <div className="section">
              <div className="section-header">
                <div>
                  <h2>批量生图</h2>
                  <p>每个子文件夹作为一组：先由产品图生成 product_1~3，再依次生成 result_A、result_B、result_0 与 result_1~5。</p>
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
                  <label htmlFor="modelProvider">模型通道</label>
                  <select id="modelProvider" value={modelProvider} onChange={(event) => setModelProvider(event.target.value as ModelProvider)}>
                    {MODEL_PROVIDERS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>
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
                    <option value="on">开启（跳过已存在 product/result 文件）</option>
                    <option value="off">关闭（整组重跑覆盖）</option>
                  </select>
                </div>
              </div>
              <div className="stack">
                <div className="note-card tiny">输入目录：{batchInputDirectory ? batchInputDirectory.name : "未选择"}</div>
                <div className="note-card tiny">输出规则：结果直接写回各子文件夹，命名为 product_1~3、result_A、result_B、result_0、result_1~5</div>
                <div className="note-card tiny">当前模型通道：{modelProvider}</div>
                <div className="note-card tiny">背景规则：在 C 步之前（product_1~3、result_A、result_B）必须保持纯白背景；从 C 步开始加入背景。</div>
                <div className="note-card tiny">当前策略：单张失败最多重试 {imageRetryLimit} 次；{continueFromExisting ? "开启断点续跑" : "关闭断点续跑"}。</div>
              </div>
            </div>

            <div className="section">
              <div className="section-header">
                <div>
                  <h2>单组输入</h2>
                  <p>单组生成会从“单组输入目录”读取图片并回写 product_1~3 与 result_A/B/0/1~5。上传区仅用于预览与对照。</p>
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
                  <p>左下角可直接编辑 P步（三视图）、A步（穿鞋）、B步（穿衣）、C步（加背景）与 D步（裂变）提示词。</p>
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
                  <label htmlFor="mainPrompt">P步提示词（袜子产品图生成 product_1~3，含袜长分类）</label>
                  <textarea id="mainPrompt" value={template.mainPrompt} onChange={(event) => setTemplate((current) => ({ ...current, mainPrompt: event.target.value }))} />
                </div>
                <div className="field">
                  <label htmlFor="stepOnePrompt">A步提示词（product_1+product_2+product_3 + 鞋子 生成白底 result_A）</label>
                  <textarea id="stepOnePrompt" value={template.stepOnePrompt} onChange={(event) => setTemplate((current) => ({ ...current, stepOnePrompt: event.target.value }))} />
                </div>
                <div className="field">
                  <label htmlFor="stepThreePrompt">B步提示词（result_A + 服装 生成白底 result_B）</label>
                  <textarea id="stepThreePrompt" value={template.stepThreePrompt} onChange={(event) => setTemplate((current) => ({ ...current, stepThreePrompt: event.target.value }))} />
                </div>
                <div className="field">
                  <label htmlFor="stepTwoPrompt">C步提示词（result_B + 背景 生成 result_0；主体严格继承 result_B）</label>
                  <textarea id="stepTwoPrompt" value={template.stepTwoPrompt} onChange={(event) => setTemplate((current) => ({ ...current, stepTwoPrompt: event.target.value }))} />
                </div>
                <div className="field">
                  <label htmlFor="stepFourPrompt">D步裂变提示词（result_0 结合 product_1/2/3 生成 result_1~5）</label>
                  <textarea id="stepFourPrompt" value={template.stepFourPrompt} onChange={(event) => setTemplate((current) => ({ ...current, stepFourPrompt: event.target.value }))} />
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

function buildProductViewPrompt(productPrompt: string): string {
  const tweak = productPrompt.trim();
  if (!tweak) {
    return PRODUCT_STEP_SOCK_ONLY_PROMPT;
  }
  if (tweak.includes("【P步产品定义（必须）】")) {
    return tweak;
  }
  return `${PRODUCT_STEP_SOCK_ONLY_PROMPT}\n\n${tweak}`;
}

function buildSingleProductViewPrompt(productPrompt: string, viewIndex: 1 | 2 | 3): string {
  const viewPrompt = PRODUCT_VIEW_PROMPTS[viewIndex];
  const tweak = productPrompt.trim();
  if (!tweak) {
    return `${viewPrompt}\n\n${PRE_BACKGROUND_WHITE_LOCK_PROMPT}`;
  }
  return `${viewPrompt}\n\n${tweak}\n\n${PRE_BACKGROUND_WHITE_LOCK_PROMPT}`;
}

function buildSingleStepAPrompt(stepAPrompt: string): string {
  const tweak = stepAPrompt.trim();
  const basePrompt = tweak ? `${SINGLE_STEP_A_PROMPT}\n\n${tweak}` : SINGLE_STEP_A_PROMPT;
  const withWhiteLock = basePrompt.includes("【白底约束（必须）】")
    ? basePrompt
    : `${basePrompt}\n\n${PRE_BACKGROUND_WHITE_LOCK_PROMPT}`;
  const withPriority = withWhiteLock.includes("【Step A 优先级（必须）】")
    ? withWhiteLock
    : `${withWhiteLock}\n\n${STEP_A_SOCK_PRIORITY_PROMPT}`;
  const withDetailLock = withPriority.includes("【Step A 细节对齐（最高优先级，必须）】")
    ? withPriority
    : `${withPriority}\n\n${STEP_A_DETAIL_LOCK_PROMPT}`;
  const withLengthClass = withDetailLock.includes("【袜长分类约束（最高优先级，必须）】")
    ? withDetailLock
    : `${withDetailLock}\n\n${SOCK_LENGTH_CLASSIFICATION_PROMPT}`;
  const withNegativePrompt = withLengthClass.includes("【Negative Prompt（抑制AI感，必须避免）】")
    ? withLengthClass
    : `${withLengthClass}\n\n${ANTI_AI_NEGATIVE_PROMPT}`;
  if (withNegativePrompt.includes("Step A 袜子硬约束")) {
    return withNegativePrompt;
  }
  return `${withNegativePrompt}\n\n${STEP_A_SOCK_LOCK}`;
}

function buildSingleStepBPrompt(stepBPrompt: string): string {
  const tweak = stepBPrompt.trim();
  const basePrompt = !tweak ? SINGLE_STEP_B_PROMPT : `${SINGLE_STEP_B_PROMPT}\n\n${tweak}`;
  const withWhiteLock = basePrompt.includes("【白底约束（必须）】")
    ? basePrompt
    : `${basePrompt}\n\n${PRE_BACKGROUND_WHITE_LOCK_PROMPT}`;
  const withOutfitScope = withWhiteLock.includes("【Step B 服装参考范围（必须）】")
    ? withWhiteLock
    : `${withWhiteLock}\n\n${STEP_B_OUTFIT_SCOPE_LOCK_PROMPT}`;
  const withModelRealism = withOutfitScope.includes("【模特自然度与体态约束（必须）】")
    ? withOutfitScope
    : `${withOutfitScope}\n\n${MODEL_REALISM_PROMPT}`;
  const withLengthClass = withModelRealism.includes("【袜长分类约束（最高优先级，必须）】")
    ? withModelRealism
    : `${withModelRealism}\n\n${SOCK_LENGTH_CLASSIFICATION_PROMPT}`;
  const withNegativePrompt = withLengthClass.includes("【Negative Prompt（抑制AI感，必须避免）】")
    ? withLengthClass
    : `${withLengthClass}\n\n${ANTI_AI_NEGATIVE_PROMPT}`;
  if (withNegativePrompt.includes("【Step B 鞋袜锁定（最高优先级，必须）】")) {
    return withNegativePrompt;
  }
  return `${withNegativePrompt}\n\n${STEP_B_SHOE_SOCK_LOCK_PROMPT}`;
}

function buildSingleStepCPrompt(stepCPrompt: string): string {
  const tweak = stepCPrompt.trim();
  const basePrompt = !tweak ? SINGLE_STEP_C_PROMPT : `${SINGLE_STEP_C_PROMPT}\n\n${tweak}`;
  const withModelRealism = basePrompt.includes("【模特自然度与体态约束（必须）】")
    ? basePrompt
    : `${basePrompt}\n\n${MODEL_REALISM_PROMPT}`;
  const withLengthClass = withModelRealism.includes("【袜长分类约束（最高优先级，必须）】")
    ? withModelRealism
    : `${withModelRealism}\n\n${SOCK_LENGTH_CLASSIFICATION_PROMPT}`;
  const withBodyLock = withLengthClass.includes("【Step C 继承锁定（最高优先级，必须）】")
    ? withLengthClass
    : `${withLengthClass}\n\n${STEP_C_BODY_LOCK_PROMPT}`;
  const withNegativePrompt = withBodyLock.includes("【Negative Prompt（抑制AI感，必须避免）】")
    ? withBodyLock
    : `${withBodyLock}\n\n${ANTI_AI_NEGATIVE_PROMPT}`;
  if (withNegativePrompt.includes("【Step C 连裤袜锁定（必须）】")) {
    return withNegativePrompt;
  }
  return `${withNegativePrompt}\n\n${STEP_C_PANTYHOSE_LOCK_PROMPT}`;
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
  skipPromptGuard?: boolean;
}): FormData {
  const formData = new FormData();
  formData.append("prompt", params.skipPromptGuard ? params.prompt : buildPromptWithProductLock(params.prompt));
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

function buildStepFourPrompt(stepFourPrompt: string): string {
  return stepFourPrompt.trim();
}

function buildSingleVariantPrompt(stepFourPrompt: string, variantIndex: number): string {
  const actionPrompt = VARIANT_ACTION_PROMPTS[variantIndex];
  if (!actionPrompt) {
    throw new Error(`无效的裂变索引：${variantIndex}`);
  }

  const base = stepFourPrompt.trim();
  return `${base}

【本次执行模式（必须）】
仅生成 1 张图片，本次只执行以下动作要求，不允许出现其他动作：
${actionPrompt}

【人物约束（必须）】
模特保持亚洲女性特征，不改变人物身份。

${VARIANT_PRODUCT_VIEW_LOCK_PROMPT}

${MODEL_REALISM_PROMPT}

${SOCK_LENGTH_CLASSIFICATION_PROMPT}

${ANTI_AI_NEGATIVE_PROMPT}

【背景约束（必须）】
继承 result_0 的背景与光线，不得回退为纯白背景。

【袜子强约束（必须）】
袜子必须严格使用 product_1 / product_2 / product_3 同款，三视图为唯一标准；
不得替换为其他袜型，不得改动纹理、镂空、标签位置、长度与贴合方式。

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

  const byRole = classifyFilesByName(files);
  const missingRoles: string[] = [];
  if (!byRole.product) missingRoles.push("产品（文件名含“款”或“产品”）");
  if (!byRole.shoe) missingRoles.push("鞋子（文件名含“鞋”）");
  if (!byRole.outfit) missingRoles.push("服装（文件名含“服装”）");
  if (!byRole.background) missingRoles.push("背景（文件名含“背景”）");

  if (missingRoles.length > 0) {
    const fileNames = files.map((file) => file.name).join("、");
    throw new Error(`无法按文件名识别图片角色，缺少：${missingRoles.join("；")}。当前文件：${fileNames}`);
  }

  return [byRole.product as File, byRole.shoe as File, byRole.outfit as File, byRole.background as File];
}

function classifyFilesByName(files: File[]): {
  product: File | null;
  shoe: File | null;
  outfit: File | null;
  background: File | null;
} {
  let product: File | null = null;
  let shoe: File | null = null;
  let outfit: File | null = null;
  let background: File | null = null;

  for (const file of files) {
    const name = normalizeFileName(file.name);

    if (!background && name.includes("背景")) {
      background = file;
      continue;
    }
    if (!outfit && name.includes("服装")) {
      outfit = file;
      continue;
    }
    if (!shoe && name.includes("鞋")) {
      shoe = file;
      continue;
    }
    if (!product && (name.includes("产品") || name.includes("款"))) {
      product = file;
      continue;
    }
  }

  return { product, shoe, outfit, background };
}

function normalizeFileName(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
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
  return /^(result_[0-5]|result_[AB]|product_[1-3])\.(png|jpg|jpeg|webp|bmp|gif)$/i.test(fileName.trim());
}

function clampRetryLimit(input: string): number {
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_IMAGE_RETRY_LIMIT;
  }
  return Math.max(0, Math.min(8, parsed));
}
