import { scanForbiddenPatterns } from './forbidden-patterns';

const details = (code: string) => scanForbiddenPatterns(code).map((f) => f.detail);

describe('scanForbiddenPatterns (FIX 3 — AXIS-C static scan)', () => {
  it('clean snippet → no flags', () => {
    const clean = [
      'def solve(n):',
      '    total = sum(range(n))',
      '    print(total)',
      'solve(int(input()))',
    ].join('\n');
    expect(scanForbiddenPatterns(clean)).toEqual([]);
  });

  it('subprocess import → forbidden_pattern flag', () => {
    const flags = scanForbiddenPatterns('import subprocess\nsubprocess.run(["ls"])');
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((f) => f.code === 'forbidden_pattern')).toBe(true);
    expect(details('import subprocess').join()).toContain('subprocess');
  });

  it('requests usage → flag', () => {
    expect(details('import requests\nrequests.get("http://x")').join()).toContain('requests');
  });

  it('os.system / os.environ / __import__ / eval( / exec( / fetch( → flags', () => {
    expect(details('os.system("rm -rf /")').join()).toContain('os.system');
    expect(details('key = os.environ["SECRET"]').join()).toContain('os.environ');
    expect(details('__import__("os")').join()).toContain('__import__');
    expect(details('eval(user_input)').join()).toContain('eval(');
    expect(details('exec(code)').join()).toContain('exec(');
    expect(details('fetch("https://x")').join()).toContain('fetch(');
  });

  it("open('out.txt','w') outside /tmp → flag; /tmp write and read-only open → no flag", () => {
    expect(details("open('out.txt', 'w')").length).toBe(1);
    expect(details("open('log.txt', 'a')").length).toBe(1);
    expect(scanForbiddenPatterns("open('/tmp/out.txt', 'w')")).toEqual([]);
    expect(scanForbiddenPatterns("open('data.txt', 'r')")).toEqual([]);
    expect(scanForbiddenPatterns("open('data.txt')")).toEqual([]);
  });

  it('all flags are HIGH severity (route to mandatory review)', () => {
    const flags = scanForbiddenPatterns('import subprocess, socket');
    expect(flags.length).toBe(2);
    expect(flags.every((f) => f.severity === 'HIGH')).toBe(true);
  });

  it('empty / null input → no flags', () => {
    expect(scanForbiddenPatterns('')).toEqual([]);
    expect(scanForbiddenPatterns(null)).toEqual([]);
    expect(scanForbiddenPatterns(undefined)).toEqual([]);
  });
});
