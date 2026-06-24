import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadProfiles } from '../../src/profiles/loader.js';

const TMP = join(import.meta.dirname, '..', '.tmp-profiles');

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe('loadProfiles', () => {
  it('loads a valid YAML profile', async () => {
    writeFileSync(join(TMP, 'git.yaml'), `
tool: git
name: Git
paths:
  sync:
    - "~/.gitconfig"
  skip: []
  sensitive: []
`);
    const profiles = await loadProfiles(TMP);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].tool).toBe('git');
    expect(profiles[0].name).toBe('Git');
    expect(profiles[0].paths.sync).toEqual(['~/.gitconfig']);
  });

  it('rejects profile with invalid tool name', async () => {
    writeFileSync(join(TMP, 'bad.yaml'), `
tool: INVALID_NAME
name: Bad
paths:
  sync:
    - "~/.foo"
  skip: []
  sensitive: []
`);
    await expect(loadProfiles(TMP)).rejects.toThrow();
  });

  it('rejects profile with empty sync paths', async () => {
    writeFileSync(join(TMP, 'empty.yaml'), `
tool: empty
name: Empty
paths:
  sync: []
  skip: []
  sensitive: []
`);
    await expect(loadProfiles(TMP)).rejects.toThrow();
  });

  it('rejects paths not starting with ~/', async () => {
    writeFileSync(join(TMP, 'abs.yaml'), `
tool: abs
name: Absolute
paths:
  sync:
    - "/etc/passwd"
  skip: []
  sensitive: []
`);
    await expect(loadProfiles(TMP)).rejects.toThrow();
  });

  it('loads multiple profiles from directory', async () => {
    writeFileSync(join(TMP, 'git.yaml'), `
tool: git
name: Git
paths:
  sync: ["~/.gitconfig"]
  skip: []
  sensitive: []
`);
    writeFileSync(join(TMP, 'vim.yaml'), `
tool: vim
name: Vim
paths:
  sync: ["~/.vimrc"]
  skip: []
  sensitive: []
`);
    const profiles = await loadProfiles(TMP);
    expect(profiles).toHaveLength(2);
  });
});
