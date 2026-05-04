import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const target = searchParams.get("url")?.trim();
    if (!target) {
      return NextResponse.json({ error: "缺少 url 参数" }, { status: 400 });
    }

    const targetUrl = new URL(target);
    if (!/^https?:$/.test(targetUrl.protocol)) {
      return NextResponse.json({ error: "仅支持 http/https 图片地址" }, { status: 400 });
    }

    const upstream = await fetch(targetUrl.toString(), { method: "GET", cache: "no-store" });
    if (!upstream.ok) {
      return NextResponse.json({ error: `下载图片失败：HTTP ${upstream.status}` }, { status: 400 });
    }

    const contentType = upstream.headers.get("content-type") || "image/png";
    const bytes = await upstream.arrayBuffer();
    return new Response(bytes, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "图片代理失败"
      },
      { status: 400 }
    );
  }
}
