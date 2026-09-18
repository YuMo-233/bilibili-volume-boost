/**
 * 生成插件图标 PNG（16/32/48/128）— 纯 Node 无依赖
 *
 * 程序化绘制：像素级超采样抗锯齿 + 形状覆盖组合，最后用 zlib 手写 PNG 编码。
 * 视觉与 icons/icon.svg 保持一致（小电视 + 粉色 + 音频波形条）。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- 基础几何（逻辑坐标 0..128，与 SVG viewBox 一致） ----------
const S = 128;

function inRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(dx, 0), oy = Math.max(dy, 0);
  const dist = Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
  return dist <= 0;
}

function inRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function inCircle(x, y, cx, cy, r) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** 线段胶囊判定：点在 (x1,y1)-(x2,y2) 线段距离 ≤ r（模拟 stroke-linecap:round） */
function inSegment(x, y, x1, y1, x2, y2, r) {
  const vx = x2 - x1, vy = y2 - y1;
  const l2 = vx * vx + vy * vy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / l2));
  const dx = x - (x1 + t * vx), dy = y - (y1 + t * vy);
  return dx * dx + dy * dy <= r * r;
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- 颜色 ----------
const BG_C1 = [0xff, 0x9d, 0xb8]; // 渐变浅粉
const BG_C2 = [0xe4, 0x54, 0x7e]; // 渐变深粉
const WHITE = [0xff, 0xff, 0xff];
const BASE_C1 = [0xe4, 0x54, 0x7e];
const BASE_C2 = [0xc2, 0x3a, 0x63];
const SCREEN = [0x2b, 0x2b, 0x3b];
const BAR_MAIN = [0xff, 0x6b, 0x97];
const BAR_LAST = [0xff, 0x8f, 0xb0];
const DOT = [0xff, 0xd3, 0xe0];

// 对角渐变背景色
function bgColor(x, y) {
  const t = clamp((x + y) / (2 * S), 0, 1);
  return [lerp(BG_C1[0], BG_C2[0], t), lerp(BG_C1[1], BG_C2[1], t), lerp(BG_C1[2], BG_C2[2], t)];
}

// 底座垂直渐变
function baseColor(x, y) {
  const t = clamp((y - 100) / 8, 0, 1);
  return [lerp(BASE_C1[0], BASE_C2[0], t), lerp(BASE_C1[1], BASE_C2[1], t), lerp(BASE_C1[2], BASE_C2[2], t)];
}

// ---------- 形状覆盖判定（顶层优先，按绘制顺序） ----------
function colorAt(x, y) {
  // 波长条（最上层，四条 + 亮点）
  if (inRoundRect(x, y, 46.5, 70, 4.5, 4, 2)) return BAR_MAIN;
  if (inRoundRect(x, y, 59.5, 67, 4.5, 7, 2)) return BAR_MAIN;
  if (inRoundRect(x, y, 72.5, 63.5, 4.5, 10.5, 2)) return BAR_MAIN;
  if (inRoundRect(x, y, 85.5, 60.5, 4.5, 13.5, 2)) return BAR_LAST;
  if (inCircle(x, y, 85.5, 44, 2.5)) return DOT;

  // 屏幕
  if (inRoundRect(x, y, 64, 62, 32, 22, 10)) return SCREEN;

  // 底座（机身下方浅粉块）
  if (inRoundRect(x, y, 64, 104, 42, 4, 4)) return baseColor(x, y);

  // 机身白色
  if (inRoundRect(x, y, 64, 66, 42, 36, 16)) return WHITE;
  // 机身下沿浅灰细线
  if (inRect(x, y, 22, 96, 106, 102)) return WHITE;
  if (inRect(x, y, 22, 96, 106, 96.3)) return [0xef, 0xef, 0xef];

  // 天线杆 + 天线球（顶部 V 型双天线）
  if (inSegment(x, y, 64, 30, 46, 12, 3)) return [0xff, 0xeb, 0xf1];
  if (inSegment(x, y, 64, 30, 82, 12, 3)) return [0xff, 0xeb, 0xf1];
  if (inCircle(x, y, 46, 12, 5.5)) return [0xff, 0xeb, 0xf1];
  if (inCircle(x, y, 82, 12, 5.5)) return [0xff, 0xeb, 0xf1];

  // 背景
  return bgColor(x, y);
}

// ---------- 渲染：目标尺寸 + 4x4 超采样抗锯齿 ----------
function render(size) {
  const scale = S / size;
  const img = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const x = (px + (sx + 0.5) / 4) * scale;
          const y = (py + (sy + 0.5) / 4) * scale;
          const c = colorAt(x, y);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = 16;
      const i = (py * size + px) * 3;
      img[i] = Math.round(r / n);
      img[i + 1] = Math.round(g / n);
      img[i + 2] = Math.round(b / n);
    }
  }
  return img;
}

// ---------- PNG 编码（RGB8 无 alpha） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(img, size) {
  const raw = Buffer.alloc(size * (size * 3 + 1)); // 每行前加 filter 0
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    img.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- 主流程 ----------
const outDir = path.join(__dirname, '..', 'icons');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const img = render(size);
  const png = encodePNG(img, size);
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png);
  console.log(`icons/icon-${size}.png  (${png.length} bytes)`);
}