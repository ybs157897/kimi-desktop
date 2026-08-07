import { describe, expect, it } from 'vitest';

import { computeScaledSize } from '../src/renderer/src/lib/imageScale';
import { webAppUrl } from '../src/renderer/src/lib/webUrl';

// ------------------------------------------------------------------- webAppUrl

describe('webAppUrl', () => {
  it('deep-links a session with the token in the hash fragment', () => {
    expect(webAppUrl('http://127.0.0.1:58627', 's_abc', 'tok-1')).toBe(
      'http://127.0.0.1:58627/sessions/s_abc#token=tok-1',
    );
  });

  it('drops the token fragment when none is available', () => {
    expect(webAppUrl('http://127.0.0.1:58627', 's_abc', undefined)).toBe(
      'http://127.0.0.1:58627/sessions/s_abc',
    );
  });

  it('opens the bare origin for no session', () => {
    expect(webAppUrl('http://127.0.0.1:58627', null, 'tok-1')).toBe(
      'http://127.0.0.1:58627/#token=tok-1',
    );
    expect(webAppUrl('http://127.0.0.1:58627', null, undefined)).toBe(
      'http://127.0.0.1:58627',
    );
  });

  it('normalizes a trailing slash on the base url', () => {
    expect(webAppUrl('http://127.0.0.1:58627/', 's_abc', 't')).toBe(
      'http://127.0.0.1:58627/sessions/s_abc#token=t',
    );
  });

  it('encodes the session id', () => {
    expect(webAppUrl('http://x:1', 's/1', undefined)).toBe('http://x:1/sessions/s%2F1');
  });

  it('encodes the token', () => {
    expect(webAppUrl('http://x:1', 's1', 'a b')).toBe('http://x:1/sessions/s1#token=a%20b');
  });
});

// ------------------------------------------------------------ computeScaledSize

describe('computeScaledSize', () => {
  it('keeps sizes already within the bound (no upscaling)', () => {
    expect(computeScaledSize(800, 600, 2048)).toEqual({ width: 800, height: 600 });
  });

  it('scales a wide image down to the long edge', () => {
    expect(computeScaledSize(4096, 2048, 2048)).toEqual({ width: 2048, height: 1024 });
  });

  it('scales a tall image down to the long edge', () => {
    expect(computeScaledSize(1024, 4096, 2048)).toEqual({ width: 512, height: 2048 });
  });

  it('rounds fractional results', () => {
    expect(computeScaledSize(3000, 2000, 1000)).toEqual({ width: 1000, height: 667 });
  });

  it('never produces a zero dimension', () => {
    const size = computeScaledSize(1, 10000, 1000);
    expect(size.width).toBeGreaterThanOrEqual(1);
    expect(size.height).toBe(1000);
  });

  it('passes degenerate input through', () => {
    expect(computeScaledSize(0, 100, 1000)).toEqual({ width: 0, height: 100 });
    expect(computeScaledSize(100, 100, 0)).toEqual({ width: 100, height: 100 });
  });
});
