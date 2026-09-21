import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PRD 验收项 A11 —— 视觉可替换性
 *
 * v1.0 走中性视觉，二次元风格留给 v1.1。能不能"只换皮不重写"，
 * 完全取决于所有视觉值是否收敛在 tokens.css 一处。
 * 本测试就是这个约束的执行者。
 */

const ROOT = join(__dirname, '..');
const SCAN_DIRS = ['src/renderer'];
const TOKENS_FILE = 'tokens.css';
const EXTS = ['.ts', '.tsx', '.css'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

interface Violation { file: string; line: number; text: string; rule: string }

const RULES: { rule: string; re: RegExp }[] = [
  { rule: '颜色字面量（#hex）', re: /#[0-9a-fA-F]{3,8}\b/g },
  { rule: '颜色字面量（rgb/rgba/hsl）', re: /\b(?:rgba?|hsla?)\(/g },
  { rule: '字号字面量（font-size: Npx）', re: /font-size:\s*\d+(?:\.\d+)?px/g },
  { rule: '圆角字面量（border-radius: Npx）', re: /border-radius:\s*\d+(?:\.\d+)?px/g },
  { rule: '间距字面量（padding/margin/gap 用了 px）', re: /(?:padding|margin|gap)(?:-[a-z]+)?:\s*[^;{}]*\d+px/g },
];

function scanFile(file: string): Violation[] {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (rel.endsWith(TOKENS_FILE)) return []; // token 层是唯一的例外
  const lines = readFileSync(file, 'utf8').split('\n');
  const out: Violation[] = [];
  lines.forEach((line, i) => {
    // 允许注释里提到颜色（例如说明性文字）
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    for (const { rule, re } of RULES) {
      re.lastIndex = 0;
      if (re.test(code)) {
        out.push({ file: rel, line: i + 1, text: line.trim().slice(0, 120), rule });
      }
    }
  });
  return out;
}

describe('A11 视觉 token 化', () => {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));

  it('扫描范围覆盖全部渲染层文件', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
    expect(files.some((f) => f.endsWith('tokens.css'))).toBe(true);
    expect(files.some((f) => f.endsWith('.tsx'))).toBe(true);
  });

  it('组件与样式文件中不存在硬编码的视觉值', () => {
    const violations = files.flatMap(scanFile);
    const msg = violations
      .slice(0, 20)
      .map((v) => `  ${v.file}:${v.line} [${v.rule}] ${v.text}`)
      .join('\n');
    expect(violations, `发现 ${violations.length} 处硬编码视觉值：\n${msg}`).toEqual([]);
  });

  it('tokens.css 同时定义了基础层与主题层', () => {
    const css = readFileSync(join(ROOT, 'src/renderer/styles/tokens.css'), 'utf8');
    for (const token of [
      '--space-1', '--radius-md', '--text-md', '--font-sans', '--dur-fast',
      '--surface-page', '--text-primary', '--brand', '--quote-up', '--deco-slot-size',
    ]) {
      expect(css, `缺少 token ${token}`).toContain(token);
    }
    expect(css).toContain("[data-theme='light']");
    expect(css).toContain("[data-theme='dark']");
    for (const extra of ['--space-hairline', '--radius-hairline', '--space-9']) {
      expect(css, `缺少 token ${extra}`).toContain(extra);
    }
  });

  it('v1.1 换肤所需的接口已预留：装饰槽位 + 语义化命名', () => {
    const raw = readFileSync(join(ROOT, 'src/renderer/styles/tokens.css'), 'utf8');
    // T5 预留插图槽位
    expect(raw).toContain('--deco-slot-size');
    // 命名检查要剥掉注释——文档注释里正举例说明了被禁止的写法
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    // T3 禁止按外观命名：不应出现 --blue-500 / --radius-12 这类名字
    expect(css, 'token 名里出现了按外观命名的写法').not.toMatch(/--(?:blue|red|green|amber|purple|teal|gray)-\d/);
    expect(css, 'token 名里出现了按尺寸命名的圆角').not.toMatch(/--radius-\d+/);
  });

  it('涨红跌绿：金融数据配色遵守 A 股约定', () => {
    const src = readFileSync(join(ROOT, 'src/renderer/styles/tokens.css'), 'utf8');
    const light = src.slice(src.indexOf("[data-theme='light']"), src.indexOf("[data-theme='dark']"));
    const up = light.match(/--quote-up:\s*(#[0-9a-fA-F]{6})/)?.[1] ?? '';
    const down = light.match(/--quote-down:\s*(#[0-9a-fA-F]{6})/)?.[1] ?? '';
    expect(up).toBeTruthy();
    expect(down).toBeTruthy();
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
    };
    // 红比绿更"暖"：红通道显著高于绿通道
    const red = parseInt(up.slice(1, 3), 16);
    const greenOfUp = parseInt(up.slice(3, 5), 16);
    expect(red, `--quote-up 应为红色系，实际 ${up}`).toBeGreaterThan(greenOfUp);
    const redOfDown = parseInt(down.slice(1, 3), 16);
    const greenOfDown = parseInt(down.slice(3, 5), 16);
    expect(greenOfDown, `--quote-down 应为绿色系，实际 ${down}`).toBeGreaterThan(redOfDown);
    expect(lum(up)).toBeGreaterThan(0);
  });
});
