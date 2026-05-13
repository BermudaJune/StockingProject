import Link from "next/link";

const EXAMPLES = [
  {
    title: "示例A · 及膝袜通勤风",
    inputs: "4图：产品/鞋子/服装/背景",
    output: "结果：袜长稳定、肤质自然、背景不污染"
  },
  {
    title: "示例B · 连裤袜影棚风",
    inputs: "4图：产品/鞋子/服装/背景",
    output: "结果：连体覆盖、无露肉、光影真实"
  },
  {
    title: "示例C · 丝袜细节风",
    inputs: "4图：产品/鞋子/服装/背景",
    output: "结果：纹理清晰、脚踝自然、人物去AI感"
  }
];

export default function HomePage() {
  return (
    <main className="page-shell home-shell">
      <section className="hero home-hero">
        <span className="hero-badge">Stockings Studio · Workflow Hub</span>
        <h1>选择工作流，稳定出图</h1>
        <p>将复杂生成拆解为可控流程：分步骤批量精修，或 4 图 + prompt.txt 直出批量。按项目目标选择对应入口。</p>
      </section>

      <section className="workflow-grid">
        <article className="workflow-card">
          <div className="workflow-top">
            <h2>工作流1：批量分步骤跑</h2>
            <span className="status-pill status-succeeded">稳定精修</span>
          </div>
          <p>适用于一致性要求高的任务，按 P/A/B/C/D 分阶段控制产品、鞋袜、服装、背景与裂变细节。</p>
          <ul className="info-list">
            <li>先袜长分类，再逐步合成</li>
            <li>污染控制强，适合电商主图标准化</li>
            <li>支持断点续跑与批量回写</li>
          </ul>
          <Link className="primary-button home-cta" href="/workflow/step-batch">
            进入工作流1
          </Link>
        </article>

        <article className="workflow-card workflow-card-alt">
          <div className="workflow-top">
            <h2>工作流2：批量4图 + prompt.txt</h2>
            <span className="status-pill status-running">高自由度</span>
          </div>
          <p>每组子文件夹放 4 图 + prompt.txt，直接生成。prompt.txt 为主导信号，适合快速跑创意方案。</p>
          <ul className="info-list">
            <li>prompt.txt 权重最高</li>
            <li>每组输出 result_txt.png</li>
            <li>批量操作，单张逻辑已融入</li>
          </ul>
          <Link className="primary-button home-cta" href="/workflow/txt-batch">
            进入工作流2
          </Link>
        </article>
      </section>

      <section className="panel panel-strong example-panel">
        <div className="section">
          <div className="section-header">
            <div>
              <h3>内置样例（文本知识库式）</h3>
              <p>默认以规则摘要增强稳定性，不强制每次喂参考图，尽量降低推理耗时。</p>
            </div>
          </div>
          <div className="example-grid">
            {EXAMPLES.map((example) => (
              <article className="example-card" key={example.title}>
                <div className="example-visual">4图 → 成功图</div>
                <h4>{example.title}</h4>
                <p>{example.inputs}</p>
                <p>{example.output}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

