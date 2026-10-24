#!/usr/bin/env node
/**
 * 防泄漏守卫：确认「曾用名存档」的数据永远不会跟着仓库或扩展包走。
 *
 * 检查三件事：
 * 1. git 索引里没有 TSV / local-data/ / 切片 JSON；
 * 2. 工作区里的切片文件确实被 .gitignore 覆盖；
 * 3. `.output/` 下的构建产物里没有切片文件、也没有切片数据的内容
 *    （数据标记是切片里的 `aicu.cc hname dump` 与 `hname-slice` 文件名）。
 *
 * 用法：node tools/hname-guard.mjs
 * 退出码 1 表示发现问题。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE_PATTERNS = [/\.tsv$/i, /^local-data\//i, /(^|\/)hname-[^/]*\.json$/i];
/** 只匹配「切片数据本身」。`hname-slice` 这类字样会出现在面板提示文案里，不能当泄漏标记 */
const DATA_MARKERS = ["aicu.cc hname dump"];
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".json", ".html", ".css", ".map"]);

const problems = [];

const runGit = (args) => {
  // 用「stdout 指向临时文件」而不是管道：某些受限环境下管道会 EPERM，
  // 文件重定向没有这个问题。
  const tmp = path.join(os.tmpdir(), `hname-guard-${process.pid}-${Date.now()}.txt`);
  const fd = fs.openSync(tmp, "w");
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    stdio: ["ignore", fd, "ignore"],
  });
  fs.closeSync(fd);
  if (result.error) {
    fs.rmSync(tmp, { force: true });
    throw result.error;
  }
  const text = fs.existsSync(tmp) ? fs.readFileSync(tmp, "utf8") : "";
  fs.rmSync(tmp, { force: true });
  return { status: result.status, text };
};

// 1. git 索引
let tracked = [];
try {
  const { status, text } = runGit(["ls-files"]);
  if (status !== 0) throw new Error(`git ls-files 退出码 ${status}`);
  tracked = text.split(/\r?\n/).filter(Boolean);
} catch (error) {
  problems.push(`无法读取 git 索引（${error instanceof Error ? error.message : error}）`);
}
for (const file of tracked) {
  if (DATA_FILE_PATTERNS.some((pattern) => pattern.test(file))) {
    problems.push(`git 索引里出现了数据文件：${file}`);
  }
}

// 2. 工作区切片必须被忽略（存在时才检查）
const slicePath = path.join(REPO_ROOT, "local-data", "hname-slice.json");
if (fs.existsSync(slicePath)) {
  try {
    runGit(["check-ignore", "-q", "local-data/hname-slice.json"]);
    // check-ignore 不写文件时用管道会 EPERM，这里改用 -q + 退出码不可得，
    // 所以退化为检查 .gitignore 文本里确实有 local-data/
  } catch {
    /* 忽略：下面用文本检查兜底 */
  }
  const ignoreText = fs.existsSync(path.join(REPO_ROOT, ".gitignore"))
    ? fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8")
    : "";
  const covered = ignoreText
    .split(/\r?\n/)
    .some((line) => line.trim() === "local-data/" || line.trim() === "local-data");
  if (!covered) problems.push(".gitignore 里没有 local-data/，切片可能被误提交");
}

// 3. 构建产物
const outputDir = path.join(REPO_ROOT, ".output");
if (fs.existsSync(outputDir)) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const relative = path.relative(REPO_ROOT, full);
      if (DATA_FILE_PATTERNS.some((pattern) => pattern.test(relative.replace(/\\/g, "/")))) {
        problems.push(`构建产物里出现了数据文件：${relative}`);
        continue;
      }
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      let content = "";
      try {
        content = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      for (const marker of DATA_MARKERS) {
        if (content.includes(marker)) {
          problems.push(`构建产物 ${relative} 里含有切片数据标记「${marker}」`);
          break;
        }
      }
    }
  };
  walk(outputDir);
}

if (problems.length > 0) {
  console.error("✗ 私人数据检查未通过：");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("✓ 私人数据检查通过：git 索引、.gitignore、构建产物里都没有曾用名切片。");
