import type { EventBundle } from "../events/event-repository.js";

export function renderEventMarkdown(bundle: EventBundle): string {
  const { event, sources, facts } = bundle;
  const sourceLines = sources.map((source) => `- [${source.publisher}](${source.url})`).join("\n");
  const factLines = facts.length > 0
    ? facts.map((fact) => `- **${fact.key}**：${typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value)}`).join("\n")
    : "- 暂无额外结构化事实";
  return [
    `# ${event.title}`,
    "",
    event.summary,
    "",
    `**为什么值得关注：** ${event.whyItMatters}`,
    "",
    `**评分：** 新颖性 ${event.scores.novelty}｜重要性 ${event.scores.importance}｜颠覆性 ${event.scores.disruption}｜可信度 ${event.scores.confidence}`,
    "",
    "## 事实",
    "",
    factLines,
    "",
    "## 来源",
    "",
    sourceLines,
    "",
  ].join("\n");
}
