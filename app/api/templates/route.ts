import { NextResponse } from "next/server";

import { getDefaultTemplates } from "@/lib/templates/defaults";
import type { TemplateConfig } from "@/lib/templates/types";
import { readTemplateConfig, writeTemplateConfig } from "@/lib/templates/store";

export async function GET() {
  try {
    const config = await readTemplateConfig();
    return NextResponse.json(config);
  } catch (error) {
    return NextResponse.json({ error: toErrorMessage(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const payload = (await request.json()) as Partial<TemplateConfig>;
    const normalized = validateTemplatePayload(payload);
    const saved = await writeTemplateConfig(normalized);
    return NextResponse.json(saved);
  } catch (error) {
    return NextResponse.json({ error: toErrorMessage(error) }, { status: 400 });
  }
}

export async function DELETE() {
  try {
    const reset = await writeTemplateConfig(getDefaultTemplates());
    return NextResponse.json(reset);
  } catch (error) {
    return NextResponse.json({ error: toErrorMessage(error) }, { status: 500 });
  }
}

function validateTemplatePayload(payload: Partial<TemplateConfig>): TemplateConfig {
  if (typeof payload.mainPrompt !== "string") {
    throw new Error("模板数据结构不合法。");
  }
  if (typeof payload.stepOnePrompt !== "string") {
    throw new Error("模板数据结构不合法。");
  }
  if (typeof payload.stepThreePrompt !== "string") {
    throw new Error("模板数据结构不合法。");
  }
  if (typeof payload.stepTwoPrompt !== "string") {
    throw new Error("模板数据结构不合法。");
  }

  return {
    mainPrompt: payload.mainPrompt,
    stepOnePrompt: payload.stepOnePrompt,
    stepThreePrompt: payload.stepThreePrompt,
    stepTwoPrompt: payload.stepTwoPrompt,
    updatedAt: new Date().toISOString()
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
