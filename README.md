# Stockings Web 生图项目（Wuyin 异步接口）

项目已改为调用：

- 提交任务：`https://api.wuyinkeji.com/api/async/image_gpt`
- 查询结果：`https://api.wuyinkeji.com/api/async/detail`

## 1. 环境变量

在项目根目录创建 `.env`：

```env
# provider: wuyin | oyy
IMAGE_PROVIDER=wuyin

WUYIN_API_KEY=你的密钥
WUYIN_IMAGE_API_URL=https://api.wuyinkeji.com/api/async/image_gpt
WUYIN_IMAGE_DETAIL_API_URL=https://api.wuyinkeji.com/api/async/detail

OYY_BASE_URL=https://www.oyy-ai.com
OYY_API_KEY=你的欧洋洋令牌
OYY_MODEL=gpt-image-2
```

说明：

- 鉴权使用 `Authorization: <WUYIN_API_KEY>` 请求头
- `?key=...` 方式在你这把 key 上会返回 403（已实测）
- 若要切到欧洋洋中转站：把 `IMAGE_PROVIDER=oyy`
- 若要切回无印：把 `IMAGE_PROVIDER=wuyin`

## 2. 启动

```bash
npm install
npm run dev
```

打开：`http://localhost:3000`

## 3. 调用链路

- 前端：`components/workbench.tsx` -> 点击“开始生成主图”
- 后端：`app/api/generate/route.ts`
  - 先提交异步任务
  - 再轮询 detail 接口（最多约 25 秒）
  - 若拿到结果图，直接返回图片 URL 给前端展示
  - 若未完成，返回任务 ID（可后续继续查）

## 4. 当前注意事项

- 页面上传的是本地图片，后端会转成 `data URL` 后提交给接口。
- 当接口偶发返回 `转发请求失败: 目标服务器返回 500` 时，系统会自动重试；仍失败可稍后重试或更换一组参考图。

## 5. 版本回退

- 当前无印实现已备份：`app/api/generate/route.wuyin-backup.ts`
- 若你后续想彻底回退代码，可直接用该备份覆盖 `app/api/generate/route.ts`
