import type { TemplateConfig } from "@/lib/templates/types";

const DEFAULT_PRODUCT_VIEW_PROMPT = `使用输入产品图生成三张白底产品三视图。
输出要求：
- product_1：正面视图
- product_2：侧面视图
- product_3：背面视图

统一要求：
- 纯白背景，主体完整，边缘清晰
- 禁止出现任何场景元素、阴影地台、道具或环境纹理
- 产品款式、纹理、标签位置、长度、材质保持一致
- 禁止改款、改色、改结构、加装饰`;

const DEFAULT_STEP_A_PROMPT = `使用 product_1（正面产品图）和鞋子参考图生成 result_A。
要求：
- 纯白背景（必须）
- 仅展示腿部与脚部
- 袜子严格以 product_1 为准
- 鞋子严格以鞋子参考图为准
- 不生成服装，不生成场景背景`;

const DEFAULT_STEP_B_PROMPT = `基于 result_A 和服装参考图生成 result_B。
要求：
- 纯白背景（必须）
- 添加完整人物与服装
- result_A 中袜子与鞋子保持不变
- 服装参考图用于服装款式与配色
- 本步仍禁止场景化背景`;

const DEFAULT_STEP_C_PROMPT = `基于 result_B 和背景参考图生成 result_0。
要求：
- 人物、袜子、鞋子、服装保持不变
- 从本步开始才允许出现非白底背景
- 加入背景，人物立正站姿
- 背景结构与光感遵循背景参考图`;

const DEFAULT_STEP_D_PROMPT = `基于 result_0 裂变 5 张图（result_1~result_5）。
要求：
- 姿势变化，但人物身份不变
- 继承 result_0 的背景与光线，不回退为白底
- 必须结合 product_1（正面）、product_2（侧面）、product_3（背面）
- 袜子款式、纹理、标签位置、长度、贴合方式必须一致
- 禁止拼图、分屏、加文字、水印、边框`;

export function getDefaultTemplates(): TemplateConfig {
  return {
    mainPrompt: DEFAULT_PRODUCT_VIEW_PROMPT,
    stepOnePrompt: DEFAULT_STEP_A_PROMPT,
    stepThreePrompt: DEFAULT_STEP_B_PROMPT,
    stepTwoPrompt: DEFAULT_STEP_C_PROMPT,
    stepFourPrompt: DEFAULT_STEP_D_PROMPT,
    updatedAt: new Date().toISOString()
  };
}
