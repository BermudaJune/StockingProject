import fs from "node:fs/promises";
import path from "node:path";

import { getDefaultTemplates } from "@/lib/templates/defaults";
import type { TemplateConfig } from "@/lib/templates/types";

const CONFIG_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), "config");
const CONFIG_FILE = path.join(CONFIG_DIR, "prompt-templates.json");

export async function readTemplateConfig(filePath = CONFIG_FILE): Promise<TemplateConfig> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(stripUtf8Bom(raw)) as Partial<TemplateConfig>;

    if (typeof parsed.mainPrompt !== "string") {
      throw new Error("Invalid template config shape.");
    }

    const defaults = getDefaultTemplates();

    const mainPrompt = normalizePrompt(parsed.mainPrompt);
    if (looksLikeCorruptedPrompt(mainPrompt)) {
      await writeTemplateConfig(defaults, filePath);
      return defaults;
    }

    const hasStepFourPrompt = typeof parsed.stepFourPrompt === "string" && parsed.stepFourPrompt.trim().length > 0;
    if (!hasStepFourPrompt) {
      const migrated: TemplateConfig = {
        // legacy(4-step) -> new(5-step):
        // old mainPrompt(A), stepOne(B), stepThree(C), stepTwo(D)
        // new mainPrompt(P), stepOne(A), stepThree(B), stepTwo(C), stepFour(D)
        mainPrompt: defaults.mainPrompt,
        stepOnePrompt:
          typeof parsed.mainPrompt === "string" && parsed.mainPrompt.trim()
            ? normalizePrompt(parsed.mainPrompt)
            : defaults.stepOnePrompt,
        stepThreePrompt:
          typeof parsed.stepOnePrompt === "string" && parsed.stepOnePrompt.trim()
            ? normalizePrompt(parsed.stepOnePrompt)
            : defaults.stepThreePrompt,
        stepTwoPrompt:
          typeof parsed.stepThreePrompt === "string" && parsed.stepThreePrompt.trim()
            ? normalizePrompt(parsed.stepThreePrompt)
            : defaults.stepTwoPrompt,
        stepFourPrompt:
          typeof parsed.stepTwoPrompt === "string" && parsed.stepTwoPrompt.trim()
            ? normalizePrompt(parsed.stepTwoPrompt)
            : defaults.stepFourPrompt,
        updatedAt: new Date().toISOString()
      };
      await writeTemplateConfig(migrated, filePath);
      return migrated;
    }

    return {
      mainPrompt,
      stepOnePrompt:
        typeof parsed.stepOnePrompt === "string" && parsed.stepOnePrompt.trim()
          ? normalizePrompt(parsed.stepOnePrompt)
          : defaults.stepOnePrompt,
      stepThreePrompt:
        typeof parsed.stepThreePrompt === "string" && parsed.stepThreePrompt.trim()
          ? normalizePrompt(parsed.stepThreePrompt)
          : defaults.stepThreePrompt,
      stepTwoPrompt:
        typeof parsed.stepTwoPrompt === "string" && parsed.stepTwoPrompt.trim()
          ? normalizePrompt(parsed.stepTwoPrompt)
          : defaults.stepTwoPrompt,
      stepFourPrompt:
        typeof parsed.stepFourPrompt === "string" && parsed.stepFourPrompt.trim()
          ? normalizePrompt(parsed.stepFourPrompt)
          : defaults.stepFourPrompt,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    const defaults = getDefaultTemplates();
    await writeTemplateConfig(defaults, filePath);
    return defaults;
  }
}

function stripUtf8Bom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

export async function writeTemplateConfig(config: TemplateConfig, filePath = CONFIG_FILE): Promise<TemplateConfig> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const normalized: TemplateConfig = {
    mainPrompt: normalizePrompt(config.mainPrompt),
    stepOnePrompt: normalizePrompt(config.stepOnePrompt),
    stepThreePrompt: normalizePrompt(config.stepThreePrompt),
    stepTwoPrompt: normalizePrompt(config.stepTwoPrompt),
    stepFourPrompt: normalizePrompt(config.stepFourPrompt),
    updatedAt: new Date().toISOString()
  };

  await fs.writeFile(filePath, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

function normalizePrompt(input: string): string {
  return input.replace(/\r\n/g, "\n").trim();
}

function looksLikeCorruptedPrompt(input: string): boolean {
  return input.includes("\u9286");
}

export const TEMPLATE_CONFIG_FILE = CONFIG_FILE;
