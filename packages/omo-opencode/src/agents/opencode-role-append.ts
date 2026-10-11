import type {
  AvailableAgent,
  AvailableCategory,
  AvailableSkill,
} from "./dynamic-agent-prompt-types"
import { buildCategorySkillsDelegationGuide } from "./dynamic-agent-category-skills-guide"
import { buildDelegationTable, buildOracleSection } from "./dynamic-agent-core-sections"

export const OPENCODE_ROLES = {
  sisyphus: "Coordinate the requested work as Sisyphus. Use the available agents and categories for independent work; own integration and the final verified result.",
  "sisyphus-junior": "Execute the delegated task as Sisyphus-Junior. Work directly within its scope. The task tool is unavailable; call_omo_agent may be used for explore/librarian research.",
  hephaestus: "Complete the requested engineering task as Hephaestus, an autonomous deep worker. Explore the relevant implementation, make the change, and verify its real behavior.",
  atlas: "Coordinate the supplied plan as Atlas. Read the plan, track its tasks, delegate independent work, and verify each result before marking it complete.",
  oracle: "Provide read-only architecture and debugging advice as Oracle. Give a concrete recommendation, its trade-offs, and actionable next steps. Do not implement.",
  momus: "Review the supplied .omo/plans/*.md file as Momus. Check referenced code and whether the plan is executable and verifiable. Return APPROVE or REJECT; report at most three concrete blocking issues. Do not implement.",
  metis: "Analyze the request before planning as Metis. Read the relevant code, identify hidden scope and ambiguities, and give the planner concrete constraints and agent-executable acceptance checks. Do not implement.",
} as const

export interface OpenCodeRoleContext {
  readonly agents?: AvailableAgent[]
  readonly skills?: AvailableSkill[]
  readonly categories?: AvailableCategory[]
  readonly useTaskSystem?: boolean
}

export function buildOpenCodeRoleAppend(
  role: keyof typeof OPENCODE_ROLES,
  context: OpenCodeRoleContext = {},
): string {
  const agents = role === "hephaestus"
    ? (context.agents ?? []).filter((agent) => ["explore", "librarian", "oracle"].includes(agent.name))
    : context.agents ?? []
  const sections = [`<opencode-role name="${role}">`, OPENCODE_ROLES[role]]
  if (agents.length > 0) {
    sections.push("Available agents:", ...agents.map((agent) => `- ${agent.name}: ${agent.description}`))
    sections.push(buildDelegationTable(agents))
    if (role === "hephaestus") sections.push(buildOracleSection(agents))
  }
  if (context.categories?.length || context.skills?.length) {
    sections.push(buildCategorySkillsDelegationGuide(context.categories ?? [], context.skills ?? []))
  }
  if (context.useTaskSystem) {
    sections.push("Track work with task_create, task_get, task_list and task_update.")
  } else {
    sections.push("Track work with todowrite.")
  }
  sections.push("</opencode-role>")
  return sections.join("\n\n")
}
