#!/usr/bin/env node

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const COLORS = new Set([
  'amber',
  'coral',
  'orange',
  'mint',
  'cyan',
  'blue',
  'violet',
  'pink',
]);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const root = path.join(
  process.env.KIMI_CODE_HOME || path.join(homedir(), '.kimi-code'),
  'experts',
);
const [command, argument] = process.argv.slice(2);

if (command === 'save') {
  if (!argument) fail('Usage: expertctl save /absolute/path/to/spec.json');
  const draft = validate(
    JSON.parse(await readFile(path.resolve(argument), 'utf8')),
  );
  await save(draft);
  console.log(
    JSON.stringify({
      ok: true,
      id: draft.id,
      command: `/expert-${draft.id}`,
      path: path.join(root, draft.id),
    }),
  );
} else if (command === 'show') {
  if (!argument || !ID.test(argument)) fail('Usage: expertctl show TEAM_ID');
  console.log(
    await readFile(path.join(root, argument, 'expert-team.json'), 'utf8'),
  );
} else if (command === 'list') {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const entries = (await readdir(root)).filter(
    (entry) => !entry.startsWith('.'),
  );
  console.log(JSON.stringify(entries));
} else {
  fail('Usage: expertctl save SPEC.json | show TEAM_ID | list');
}

function validate(value) {
  if (!value || typeof value !== 'object')
    fail('Expert team spec must be an object');
  text(value.id, 'id');
  if (!ID.test(value.id)) fail('id must be kebab-case');
  text(value.displayName, 'displayName', 80);
  text(value.description, 'description', 500);
  if (!COLORS.has(value.color)) fail('unsupported color');
  role(value.lead, 'lead');
  if (
    !Array.isArray(value.members) ||
    value.members.length < 1 ||
    value.members.length > 16
  )
    fail('members must contain 1-16 roles');
  value.members.forEach((item, index) => role(item, `members[${index}]`));
  const ids = [value.lead.id, ...value.members.map((item) => item.id)];
  if (new Set(ids).size !== ids.length) fail('role ids must be unique');
  if (
    !Array.isArray(value.quickPrompts) ||
    value.quickPrompts.length > 8 ||
    value.quickPrompts.some(
      (item) =>
        typeof item !== 'string' || !item.trim() || item.trim().length > 500,
    )
  )
    fail('quickPrompts must be strings');
  return value;
}

function role(value, label) {
  if (!value || typeof value !== 'object') fail(`${label} must be an object`);
  text(value.id, `${label}.id`);
  if (!ID.test(value.id)) fail(`${label}.id must be kebab-case`);
  text(value.displayName, `${label}.displayName`, 80);
  text(value.description, `${label}.description`, 500);
  text(value.prompt, `${label}.prompt`);
  if (value.toolPreset !== 'full' && value.toolPreset !== 'read-only')
    fail(`${label}.toolPreset is invalid`);
}

function text(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required`);
  if (maxLength !== undefined && value.trim().length > maxLength) {
    fail(`${label} must be at most ${maxLength} characters`);
  }
}

async function save(draft) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(path.join(root, '.expert-team-'));
  const target = path.join(root, draft.id);
  const backup = `${target}.backup`;
  try {
    await compile(temp, draft);
    await rm(backup, { recursive: true, force: true });
    let previous = false;
    try {
      await rename(target, backup);
      previous = true;
    } catch {}
    try {
      await rename(temp, target);
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      if (previous) await rename(backup, target);
      throw error;
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function compile(dir, draft) {
  const agents = path.join(dir, 'agents');
  const skills = path.join(dir, 'skills', `expert-${draft.id}`);
  await Promise.all([
    mkdir(agents, { recursive: true, mode: 0o700 }),
    mkdir(skills, { recursive: true, mode: 0o700 }),
  ]);
  const profile = (role) => `expert-${draft.id}-${role.id}`;
  const memberNames = draft.members.map(profile);
  const manifest = {
    name: `expert-team-${draft.id}`,
    version: '1.0.0',
    description: draft.description,
    agents: './agents',
    skills: './skills',
    interface: {
      displayName: draft.displayName,
      shortDescription: draft.description,
      developerName: 'Kimi Code Desktop',
    },
    'x-kimi-desktop': {
      schemaVersion: 1,
      kind: 'expert-team',
      id: draft.id,
      displayName: draft.displayName,
      color: draft.color,
      lead: profile(draft.lead),
      members: memberNames,
      quickPrompts: draft.quickPrompts,
    },
  };
  await Promise.all([
    writeFile(
      path.join(dir, 'expert-team.json'),
      `${JSON.stringify(draft, null, 2)}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      path.join(dir, 'kimi.plugin.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      path.join(agents, `${draft.lead.id}.md`),
      agentFile(draft, draft.lead, memberNames, true),
      { mode: 0o600 },
    ),
    ...draft.members.map((member) =>
      writeFile(
        path.join(agents, `${member.id}.md`),
        agentFile(draft, member, [], false),
        { mode: 0o600 },
      ),
    ),
    writeFile(
      path.join(skills, 'SKILL.md'),
      activation(draft, profile(draft.lead)),
      { mode: 0o600 },
    ),
  ]);
}

function agentFile(team, role, subagents, lead) {
  const tools = lead
    ? [
        'Agent',
        'AgentSwarm',
        'Read',
        'Glob',
        'Grep',
        'Skill',
        'AskUserQuestion',
      ]
    : role.toolPreset === 'read-only'
      ? ['Read', 'ReadMediaFile', 'Glob', 'Grep', 'WebSearch', 'FetchURL']
      : [
          'Read',
          'ReadMediaFile',
          'Glob',
          'Grep',
          'Edit',
          'Write',
          'Bash',
          'Skill',
          'WebSearch',
          'FetchURL',
        ];
  return `---\nname: expert-${team.id}-${role.id}\ndescription: ${JSON.stringify(role.description)}\ncolor: ${team.color}\ntools: [${tools.join(', ')}]\n${subagents.length ? `subagents: [${subagents.join(', ')}]\n` : ''}---\n\n${role.prompt.trim()}\n`;
}

function activation(team, lead) {
  return `---\nname: expert-${team.id}\ndescription: ${JSON.stringify(`使用${team.displayName}处理需要多位专家协作的任务`)}\n---\n\n你正在激活「${team.displayName}」。\n\n用户的原始任务：\n\n$ARGUMENTS\n\n必须立即调用 \`Agent\` 工具，将完整原始任务交给 \`${lead}\`。不要在主 Agent 中模拟团员；等待团长完成分派和汇总后，再把团长的最终结果交付给用户。\n`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
