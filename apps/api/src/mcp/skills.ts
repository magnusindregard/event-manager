import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Companion skills (apps/api/skills/<name>/SKILL.md). The same files are a Claude Code skill
// folder and the MCP server's prompts, so agents without skill support get the same guidance.

export interface Skill {
  name: string;
  description: string;
  /** The instructions, without the frontmatter. */
  body: string;
}

const DIR = fileURLToPath(new URL("../../skills/", import.meta.url));

function parse(file: string): Skill {
  const text = readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file}: missing frontmatter`);
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(m[1]!)?.[1]?.trim();
  const name = field("name");
  const description = field("description");
  if (!name || !description) throw new Error(`${file}: frontmatter needs name and description`);
  return { name, description, body: m[2]!.trim() };
}

let cache: Skill[] | undefined;

export function loadSkills(): Skill[] {
  cache ??= readdirSync(DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => parse(`${DIR}${d.name}/SKILL.md`))
    .sort((a, b) => a.name.localeCompare(b.name));
  return cache;
}
