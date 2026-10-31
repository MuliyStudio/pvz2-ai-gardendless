import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'in-game');
const b64 = fs.readFileSync(path.join(dir, 'pet', 'fatfish-sheet.webp')).toString('base64');
const header = `/**
 * 大肥鱼桌宠精灵图（构建期内联，GP-Next 模组包只认 scripts/，不能带外部图片）。
 *
 * 图集：7 列 × 6 行，每格 192×208，行顺序 idle / think / success / failed / wait / hover。
 * 原始素材：gmskywalker/deepseek-fat-fish-codex-pet 的 spritesheet.webp
 * （社区二创「大肥鱼 / 鲸鱼娘」，非 DeepSeek 官方形象；仅个人使用，请勿商用）。
 * 由 scripts/build-pet-sprites.mjs 生成，请勿手改。
 */
export const PET_SHEET = 'data:image/webp;base64,${b64}';

export const PET_SHEET_META = {
  cellW: 192,
  cellH: 208,
  cols: 7,
  rows: 6,
  states: {
    idle: { row: 0, frames: 6, ms: 170 },
    think: { row: 1, frames: 6, ms: 190 },
    success: { row: 2, frames: 6, ms: 150 },
    failed: { row: 3, frames: 7, ms: 230 },
    wait: { row: 4, frames: 6, ms: 280 },
    hover: { row: 5, frames: 5, ms: 120 },
  },
};
`;
fs.writeFileSync(path.join(dir, 'pet-sprites.js'), header, 'utf8');
console.log('cwd', process.cwd());
console.log('wrote', fs.statSync(path.join(dir, 'pet-sprites.js')).size);
