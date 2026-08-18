import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverSkillInventory, loadSkill } from '../dist/capabilitiesOps.js';

// These harnesses realpath and stat the paths CodexPro returns, so they need the raw
// absolute form. Production defaults to redacted labels; see the redaction assertions
// at the end of scripts/smoke.mjs for coverage of the default behaviour.
process.env.CODEXPRO_EXPOSE_ABSOLUTE_PATHS = '1';

async function writeSkill(root, relativeDir, name, description, heading) {
  const dir = path.join(root, relativeDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${heading}`,
    ''
  ].join('\n'), 'utf8');
}

function onlySkill(inventory, name) {
  const matches = inventory.filter((skill) => skill.name === name);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one active ${name}, found ${matches.length}: ${JSON.stringify(matches)}`);
  }
  return matches[0];
}

const workspaceRootRaw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-skill-workspace-'));
const homeRootRaw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-skill-home-'));
const workspaceRoot = await fs.realpath(workspaceRootRaw);
const homeRoot = await fs.realpath(homeRootRaw);

try {
  await writeSkill(workspaceRoot, path.join('.codex', 'skills', 'smoke-skill'), 'smoke-skill', 'Preferred workspace skill.', 'Workspace Codex Skill');
  await writeSkill(workspaceRoot, path.join('.agents', 'skills', 'smoke-skill'), 'smoke-skill', 'Suppressed workspace duplicate.', 'Workspace Agents Duplicate');
  await writeSkill(homeRoot, path.join('.codex', 'skills', 'smoke-skill'), 'smoke-skill', 'Suppressed user duplicate.', 'User Duplicate');
  await writeSkill(homeRoot, path.join('.agents', 'skills', 'global-smoke-skill'), 'global-smoke-skill', 'Preferred user-global skill.', 'User Global Preferred Skill');
  await writeSkill(homeRoot, path.join('.codex', 'plugins', 'cache', 'test-plugin-a', '1.0.0', 'skills', 'smoke-skill'), 'smoke-skill', 'Suppressed plugin duplicate.', 'Plugin Smoke Duplicate');
  await writeSkill(homeRoot, path.join('.codex', 'plugins', 'cache', 'test-plugin-a', '1.0.0', 'skills', 'global-smoke-skill'), 'global-smoke-skill', 'Suppressed plugin global duplicate.', 'Plugin Global Duplicate');
  await writeSkill(homeRoot, path.join('.codex', 'plugins', 'cache', 'test-plugin-a', '1.0.0', 'skills', 'plugin-only-skill'), 'plugin-only-skill', 'First plugin copy.', 'Plugin First Copy');
  await writeSkill(homeRoot, path.join('.codex', 'plugins', 'cache', 'test-plugin-b', '2.0.0', 'skills', 'plugin-only-skill'), 'plugin-only-skill', 'Second plugin copy.', 'Plugin Second Copy');
  await writeSkill(homeRoot, path.join('.cc-switch', 'skills', 'linked-skill'), 'linked-skill', 'Symlinked user skill.', 'Symlinked User Skill');
  // Point the junction at the pre-realpath home spelling when it differs so
  // Windows short/long path mismatches are exercised end-to-end.
  await fs.symlink(
    path.join(homeRootRaw, '.cc-switch', 'skills', 'linked-skill'),
    path.join(homeRoot, '.codex', 'skills', 'linked-skill'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );

  const workspace = {
    id: 'skill-precedence-smoke',
    root: workspaceRoot,
    openedAt: new Date().toISOString()
  };
  const discoveryOptions = { includeGlobal: true, maxSkills: 50, homeDir: homeRootRaw };
  const inventory = await discoverSkillInventory(workspace, discoveryOptions);

  const workspaceWinner = onlySkill(inventory, 'smoke-skill');
  if (workspaceWinner.source !== 'workspace' || workspaceWinner.path !== '$WORKSPACE/.codex/skills/smoke-skill/SKILL.md') {
    throw new Error(`workspace precedence winner was wrong: ${JSON.stringify(workspaceWinner)}`);
  }

  const userWinner = onlySkill(inventory, 'global-smoke-skill');
  if (userWinner.source !== 'user' || userWinner.path !== '~/.agents/skills/global-smoke-skill/SKILL.md') {
    throw new Error(`user precedence winner was wrong: ${JSON.stringify(userWinner)}`);
  }

  const pluginWinner = onlySkill(inventory, 'plugin-only-skill');
  if (pluginWinner.source !== 'plugin') {
    throw new Error(`plugin duplicate was not reduced to one plugin winner: ${JSON.stringify(pluginWinner)}`);
  }

  const linkedSkill = onlySkill(inventory, 'linked-skill');
  if (linkedSkill.source !== 'user' || linkedSkill.path !== '~/.cc-switch/skills/linked-skill/SKILL.md') {
    throw new Error(`symlinked user skill was not discovered through its real directory: ${JSON.stringify(linkedSkill)}`);
  }

  const loadedWorkspace = await loadSkill(workspace, { name: 'smoke-skill', maxSkills: 50, homeDir: homeRoot });
  if (!loadedWorkspace.text.includes('# Workspace Codex Skill')) {
    throw new Error(`name-only load did not choose the workspace winner: ${loadedWorkspace.skill.path}`);
  }

  const loadedUser = await loadSkill(workspace, { name: 'global-smoke-skill', maxSkills: 50, homeDir: homeRoot });
  if (!loadedUser.text.includes('# User Global Preferred Skill')) {
    throw new Error(`name-only load did not choose the user winner: ${loadedUser.skill.path}`);
  }

  const loadedLinkedSkill = await loadSkill(workspace, { name: 'linked-skill', maxSkills: 50, homeDir: homeRoot });
  if (!loadedLinkedSkill.text.includes('# Symlinked User Skill')) {
    throw new Error(`name-only load did not follow the symlinked skill directory: ${loadedLinkedSkill.skill.path}`);
  }

  const loadedPluginOverride = await loadSkill(workspace, {
    name: 'global-smoke-skill',
    source: 'plugin',
    maxSkills: 50,
    homeDir: homeRoot
  });
  if (!loadedPluginOverride.text.includes('# Plugin Global Duplicate')) {
    throw new Error(`source override did not load the suppressed plugin copy: ${loadedPluginOverride.skill.path}`);
  }

  const loadedPathOverride = await loadSkill(workspace, {
    name: 'smoke-skill',
    path: '$WORKSPACE/.agents/skills/smoke-skill/SKILL.md',
    maxSkills: 50,
    homeDir: homeRoot
  });
  if (!loadedPathOverride.text.includes('# Workspace Agents Duplicate')) {
    throw new Error(`path override did not load the suppressed workspace copy: ${loadedPathOverride.skill.path}`);
  }

  console.log('✓ skill precedence smoke test passed');
} finally {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(homeRoot, { recursive: true, force: true });
}
