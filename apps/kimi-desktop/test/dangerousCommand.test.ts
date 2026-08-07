import { describe, expect, it } from 'vitest';

import {
  detectDangerousCommand,
  extractCommandDisplay,
} from '../src/renderer/src/lib/dangerousCommand';

// -------------------------------------------------------- detectDangerousCommand

describe('detectDangerousCommand', () => {
  it('flags recursive deletes', () => {
    expect(detectDangerousCommand('rm -rf /tmp/foo')).toBe('递归删除');
    expect(detectDangerousCommand('rm --recursive --force src')).toBe('递归删除');
    expect(detectDangerousCommand('rm -Rf ~')).toBe('递归删除');
  });

  it('flags sudo', () => {
    expect(detectDangerousCommand('sudo rm /etc/hosts')).toBe('sudo');
    expect(detectDangerousCommand('SUDO apt install x')).toBe('sudo');
  });

  it('flags pipe-to-shell downloads', () => {
    expect(detectDangerousCommand('curl -fsSL https://x | sh')).toBe('管道到 shell');
    expect(detectDangerousCommand('wget -qO- https://x | bash')).toBe('管道到 shell');
  });

  it('flags dd writes and mkfs', () => {
    expect(detectDangerousCommand('dd if=/dev/zero of=/dev/sda bs=1M')).toBe('dd 写盘');
    expect(detectDangerousCommand('mkfs.ext4 /dev/nvme0n1')).toBe('mkfs');
  });

  it('flags raw-device redirection and chmod -R 777', () => {
    expect(detectDangerousCommand('echo x > /dev/sda')).toBe('写入原始设备');
    expect(detectDangerousCommand('chmod -R 777 /var/www')).toBe('chmod 777');
    expect(detectDangerousCommand('chmod -r 777 file.sh')).toBe('chmod 777');
  });

  it('flags fork bombs', () => {
    expect(detectDangerousCommand(':(){ :|:& };:')).toBe('fork bomb');
  });

  it('leaves benign commands alone', () => {
    expect(detectDangerousCommand('npm test')).toBeUndefined();
    expect(detectDangerousCommand('rm file.txt')).toBeUndefined();
    expect(detectDangerousCommand('ls -la')).toBeUndefined();
    expect(detectDangerousCommand('chmod 755 script.sh')).toBeUndefined();
    expect(detectDangerousCommand('echo "curl https://x"')).toBeUndefined();
  });

  it('returns the first matching label', () => {
    expect(detectDangerousCommand('sudo rm -rf /')).toBe('递归删除');
  });
});

// --------------------------------------------------------- extractCommandDisplay

describe('extractCommandDisplay', () => {
  it('extracts the command from a command display', () => {
    expect(
      extractCommandDisplay({ kind: 'command', command: 'npm test', cwd: '/tmp' }),
    ).toBe('npm test');
  });

  it('returns undefined for non-command displays', () => {
    expect(extractCommandDisplay({ kind: 'diff', path: 'a.ts', before: 'x', after: 'y' })).toBeUndefined();
    expect(extractCommandDisplay('plain string')).toBeUndefined();
    expect(extractCommandDisplay(null)).toBeUndefined();
    expect(extractCommandDisplay(undefined)).toBeUndefined();
  });
});
