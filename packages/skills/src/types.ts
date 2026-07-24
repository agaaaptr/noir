export interface SkillFrontmatter {
  name: string;
  description: string;
  references?: string[];
  [k: string]: unknown; // tolerate + ignore extra keys (user-invocable, allowed-tools, …)
}

export interface BuiltinReference {
  name: string; // <kebab>.md
  content: string;
}

export interface BuiltinSkill {
  name: string; // 'noir-brainstorm'
  dir: string; // absolute builtin/<name> dir
  skillMd: string; // raw SKILL.md
  frontmatter: SkillFrontmatter;
  references: BuiltinReference[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface EmittedFile {
  path: string[]; // relative to the skill's own dir, e.g. ['SKILL.md'] or ['references','x.md']
  content: string;
}

export interface CompiledSkill {
  name: string;
  files: EmittedFile[];
}

export interface EmitSummary {
  dir: string;
  emitted: string[]; // skill names written
  references: number; // reference files written (excludes SKILL.md)
}

export type CompileTarget = 'claude';
