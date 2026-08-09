# Expert teams

An expert team organizes several specialized subagents into a fixed collaboration tree: the main agent hands the task to a lead, the lead delegates work by role, verifies the results, and returns one consolidated answer. Teams work well for code review, architecture, product research, and other tasks that need several perspectives with one delivery owner.

Expert teams are managed by Kimi Code Desktop and stored locally. They do not read or depend on configuration from WorkBuddy or another application. Each team is also a standard Kimi plugin containing agent files and an Agent Skill that starts the team.

## Create through conversation

In Desktop, open Settings → Expert teams and select **Create through conversation**. The app opens a new session with `/expert-manager` prefilled. You can also type a request directly in a new session:

```
/expert-manager Create a code-review team that checks correctness, security, and maintainability
```

`expert-manager` confirms the goal, lead, member responsibilities, tool access, and color in order. It writes the local package only after you confirm the final structure. Use this flow when you want to describe the outcome in natural language and let Kimi draft the role prompts.

Keep roles complementary. The lead should only decompose, delegate, verify, and synthesize; each member should own one clear domain. Prefer read-only access unless a member must modify files.

## Create manually

Select **Create manually** to enter the complete configuration:

1. Enter the team ID, display name, description, and color. IDs may contain lowercase letters, numbers, and hyphens only.
2. Configure the lead's name, responsibility, and system prompt. The lead automatically receives the `Agent` and `AgentSwarm` tools and may delegate only to members of this team.
3. Add at least one member and choose read-only or full tool access for each member.
4. Optionally add quick prompts, then save the generated package.

Members are leaf agents by default and cannot dispatch another agent. Read-only access fits research, review, and analysis; full access additionally allows file editing and shell commands.

## Use a team

After saving, the list shows the team's command. A team whose ID is `code-review` uses:

```
/expert-code-review Review the current uncommitted changes
```

The command activates the team Skill and passes the complete task to the lead. The lead calls members and returns a deduplicated, verified result to the main agent. You can also ask naturally—for example, "Ask the code-review team to inspect the current changes"—and the main agent can select the Skill from its description.

Disabling a team stops the runtime from loading its agents and activation Skill; enabling it restores them. Editing regenerates and hot-reloads the package. Deleting first uninstalls the plugin, then moves the local package to the system Trash.

## Local files

Team source files live at:

```text
$KIMI_CODE_HOME/experts/<team-id>/
├── expert-team.json
├── kimi.plugin.json
├── agents/
└── skills/
```

The default `$KIMI_CODE_HOME` is `~/.kimi-code`. `expert-team.json` is the Desktop editor's source data; `kimi.plugin.json`, `agents/`, and `skills/` are the standard plugin content consumed by Kimi.

::: warning Note
System prompts and full tool access directly affect agent behavior. Review every role prompt and tool scope before enabling an imported or manually edited package.
:::

When Desktop is attached to an external kap-server, it can edit and save package files but does not install the plugin for that service. Install `$KIMI_CODE_HOME/experts/<team-id>` through the external host, then reload or restart it as that host requires. Conversation-based creation and live enablement remain unavailable until then.

## Prompt guidance

A reliable lead prompt should specify:

- How to determine scope and when to ask the user for missing information.
- Which work belongs to each member and which assignments may run in parallel.
- How to verify member findings, resolve disagreement, and remove duplicates.
- The final output structure, priorities, and completion criteria.

A member prompt should focus on one domain and require the final message to be a complete, self-contained deliverable. For the underlying agent fields and permissions, read [Agents and subagents](./agents.md#custom-agents).
