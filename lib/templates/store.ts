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

    return {
      mainPrompt,
      stepOnePrompt:
        typeof parsed.stepOnePrompt === "string" && parsed.stepOnePrompt.trim()
          ? normalizePrompt(parsed.stepOnePrompt)
          : defaults.stepOnePrompt,
      stepTwoPrompt:
        typeof parsed.stepTwoPrompt === "string" && parsed.stepTwoPrompt.trim()
          ? normalizePrompt(parsed.stepTwoPrompt)
          : defaults.stepTwoPrompt,
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
    stepTwoPrompt: normalizePrompt(config.stepTwoPrompt),
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
