#!/usr/bin/env node
/**
 * 离线切片：从 hname TSV 快照里，只抽出「关注列表」里那些 UID 的曾用名。
 *
 * 设计要点：
 * - 原始 TSV 有 1.25 GB / 4900 万行，且**不是全局按 UID 排序**（约 992 段乱序拼接），
 *   所以不能二分查找，只能顺序扫一遍；但只保留关注集合里的 UID，输出只有几百 KB。
 * - 数据文件永远不进仓库：输出目录必须是 repo 内的 `local-data/`（已 gitignore）。
 * - 脚本本身不含任何数据，TSV 路径由 `--tsv` 或环境变量 `HNAME_TSV` 提供。
 *
 * 用法：
 *   node tools/hname-build.mjs --backup <本地备份.json>
 *   node tools/hname-build.mjs --backup <本地备份.json> --tsv "E:\File Data\hname.tsv"
 *   node tools/hname-build.mjs --backup <备份.json> --dry-run     # 只看覆盖报告，不写文件
 *   node tools/hname-build.mjs --uids <每行一个mid.txt>           # 不用备份时
 *
 * 输出：
 *   local-data/hname-slice.json
 *   {
 *     formatVersion: 1,
 *     source: "aicu.cc hname dump",
 *     generatedAt: ISO 时间,
 *     followingCount: 关注数,
 *     matchedUids: 命中的 UID 数,
 *     totalNames: 名字条数,
 *     entries: { "<mid>": ["名字", ...] }
 *   }
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_DATA_DIR = path.join(REPO_ROOT, "local-data");
const DEFAULT_OUT = path.join(LOCAL_DATA_DIR, "hname-slice.json");

/** 与 utils/followingDiff.ts 的 GONE_NAME_PLACEHOLDERS 保持一致，另加两种常见变体 */
const GONE_NAME_PLACEHOLDERS = new Set([
  "账号已注销",
  "用户不存在",
  "已注销",
  "该账号已注销",
  "此账号已注销",
  "账户已注销",
]);

/** B 站昵称上限远小于此。超过基本是脏数据（实测最长 994 字符，多为评论正文） */
const MAX_NAME_LENGTH = 30;

const parseArgs = (argv) => {
  const args = { out: DEFAULT_OUT, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    switch (key) {
      case "--backup":
        args.backup = argv[++i];
        break;
      case "--uids":
        args.uids = argv[++i];
        break;
      case "--tsv":
        args.tsv = argv[++i];
        break;
      case "--out":
        args.out = path.resolve(argv[++i]);
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
        process.exit(0);
        break;
      default:
        if (key.startsWith("--")) {
          console.error(`未知参数：${key}`);
          process.exit(1);
        }
    }
  }
  return args;
};

/** 输出必须落在 `local-data/` 且该目录确实被 gitignore 覆盖，否则拒绝写入 */
const assertSafeOutput = (outPath) => {
  const relative = path.relative(LOCAL_DATA_DIR, outPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `输出路径必须在 ${LOCAL_DATA_DIR} 内，实际为 ${outPath}。请勿把切片写进被 git 跟踪的目录。`,
    );
  }
  const ignoreFile = path.join(REPO_ROOT, ".gitignore");
  const ignoreText = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, "utf8") : "";
  const covered = ignoreText
    .split(/\r?\n/)
    .some((line) => line.trim() === "local-data/" || line.trim() === "local-data");
  if (!covered) {
    throw new Error(".gitignore 里没有 `local-data/`，为防止误提交已中止。请先补上再运行。");
  }
};

/** 从扩展导出/本地备份 JSON 里取关注 UID（按 store 结构显式取，避免误抓视频 mid） */
const readUidsFromBackup = (backupPath) => {
  const raw = fs.readFileSync(backupPath, "utf8");
  let backup;
  try {
    backup = JSON.parse(raw);
  } catch (error) {
    throw new Error(`备份文件不是合法 JSON：${error instanceof Error ? error.message : error}`);
  }
  const following = backup.following ?? backup.data?.following;
  if (!Array.isArray(following)) {
    throw new Error(
      "备份里没有 following 数组。请在扩展的「设置 → 自动备份至本地」里勾选「关注的 UP 主」后重新备份。",
    );
  }
  const uids = new Map();
  for (const item of following) {
    const mid = Number(item?.mid);
    if (!Number.isFinite(mid) || mid <= 0) continue;
    uids.set(mid, typeof item?.name === "string" ? item.name : "");
  }
  return uids;
};

const readUidsFromText = (uidsPath) => {
  const text = fs.readFileSync(uidsPath, "utf8");
  const uids = new Map();
  for (const line of text.split(/\r?\n/)) {
    const mid = Number(line.split(/[,\s\t]/)[0]);
    if (Number.isFinite(mid) && mid > 0) uids.set(mid, "");
  }
  return uids;
};

const isGoneName = (name) => {
  const trimmed = name.trim();
  if (trimmed === "") return true;
  if (GONE_NAME_PLACEHOLDERS.has(trimmed)) return true;
  return /^(该|此)?账[号户]已注销$/.test(trimmed);
};

/** 名字清洗；返回 null 表示丢弃 */
const cleanName = (raw) => {
  const name = raw.trim();
  if (!name) return null;
  if (isGoneName(name)) return null;
  if (name.length > MAX_NAME_LENGTH) return null;
  if (/[\u0000-\u001f]/.test(name)) return null;
  return name;
};

/** 从 Buffer 里快速解析 UID（不分配字符串），遇到非数字返回 -1 */
const parseUidBytes = (buf, start, end) => {
  let value = 0;
  if (end - start > 12) return -1; // B 站 UID 不会超过 12 位
  for (let i = start; i < end; i += 1) {
    const digit = buf[i] - 48;
    if (digit < 0 || digit > 9) return -1;
    value = value * 10 + digit;
  }
  return value;
};

const scanTsv = (tsvPath, wantedUids) => {
  const fd = fs.openSync(tsvPath, "r");
  const fileSize = fs.fstatSync(fd).size;
  const BUF_SIZE = 16 * 1024 * 1024;
  const buf = Buffer.allocUnsafe(BUF_SIZE);

  const namesByUid = new Map();
  const stats = {
    lines: 0,
    bytes: 0,
    matchedRows: 0,
    droppedGone: 0,
    droppedTooLong: 0,
    droppedDuplicate: 0,
  };

  let totalBytes = 0;
  let partial = null; // Buffer，跨 chunk 的残行
  const startedAt = Date.now();

  const handleLine = (lineBuf) => {
    stats.lines += 1;
    const tab = lineBuf.indexOf(9);
    if (tab <= 0) return;
    const uid = parseUidBytes(lineBuf, 0, tab);
    if (uid < 0 || !wantedUids.has(uid)) return;
    stats.matchedRows += 1;
    let lineEnd = lineBuf.length;
    if (lineEnd > 0 && lineBuf[lineEnd - 1] === 13) lineEnd -= 1;
    const rawName = lineBuf.toString("utf8", tab + 1, lineEnd);
    const name = cleanName(rawName);
    if (name === null) {
      if (rawName.trim().length > MAX_NAME_LENGTH) stats.droppedTooLong += 1;
      else stats.droppedGone += 1;
      return;
    }
    const list = namesByUid.get(uid) ?? [];
    if (list.includes(name)) {
      stats.droppedDuplicate += 1;
      return;
    }
    list.push(name);
    namesByUid.set(uid, list);
  };

  while (true) {
    const read = fs.readSync(fd, buf, 0, BUF_SIZE, totalBytes);
    if (read <= 0) break;
    const chunk = buf.subarray(0, read);
    let pos = 0;
    while (true) {
      const nl = chunk.indexOf(10, pos);
      if (nl === -1) break;
      if (partial) {
        handleLine(Buffer.concat([partial, chunk.subarray(pos, nl)]));
        partial = null;
      } else {
        handleLine(chunk.subarray(pos, nl));
      }
      pos = nl + 1;
    }
    if (pos < chunk.length) partial = Buffer.from(chunk.subarray(pos));
    totalBytes += read;
    if (totalBytes % (256 * 1024 * 1024) < BUF_SIZE) {
      const percent = ((totalBytes / fileSize) * 100).toFixed(0);
      process.stdout.write(`\r扫描中 ${percent}% (${(totalBytes / 1024 / 1024).toFixed(0)} MB)`);
    }
  }
  if (partial && partial.length > 0) handleLine(partial);
  fs.closeSync(fd);
  if (fileSize > 0) process.stdout.write("\r");

  stats.bytes = totalBytes;
  stats.elapsedMs = Date.now() - startedAt;
  return { namesByUid, stats };
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  const tsvPath = args.tsv ?? process.env.HNAME_TSV;
  if (!tsvPath) {
    console.error(
      [
        "缺少 TSV 路径。两种方式任选其一：",
        '  node tools/hname-build.mjs --backup <备份.json> --tsv "E:\\File Data\\hname.tsv"',
        "  $env:HNAME_TSV = <tsv路径>; node tools/hname-build.mjs --backup <备份.json>",
      ].join("\n"),
    );
    process.exit(1);
  }
  if (!fs.existsSync(tsvPath)) {
    console.error(`TSV 不存在：${tsvPath}`);
    process.exit(1);
  }
  if (!args.backup && !args.uids) {
    console.error("缺少 --backup <备份.json> 或 --uids <mid列表.txt>。");
    process.exit(1);
  }

  const wantedUids = args.uids ? readUidsFromText(args.uids) : readUidsFromBackup(args.backup);
  console.log(`关注 UID 数：${wantedUids.size}`);
  console.log(`TSV：${tsvPath}（${(fs.statSync(tsvPath).size / 1024 / 1024).toFixed(0)} MB）`);

  const { namesByUid, stats } = scanTsv(tsvPath, wantedUids);
  const entries = {};
  let totalNames = 0;
  let withFormer = 0;
  for (const [uid, names] of namesByUid) {
    if (names.length === 0) continue;
    entries[String(uid)] = names;
    totalNames += names.length;
    if (names.length >= 2) withFormer += 1;
  }

  const matchedUids = Object.keys(entries).length;
  const coverage = wantedUids.size > 0 ? ((matchedUids / wantedUids.size) * 100).toFixed(1) : "0.0";
  console.log("");
  console.log(`扫描行数：${stats.lines.toLocaleString()}（${(stats.bytes / 1024 / 1024).toFixed(0)} MB，${
    (stats.elapsedMs / 1000).toFixed(1)
  }s）`);
  console.log(`命中名字行：${stats.matchedRows.toLocaleString()}`);
  console.log(
    `丢弃：占位/空名 ${stats.droppedGone}，超长 ${stats.droppedTooLong}，同 UID 重复 ${stats.droppedDuplicate}`,
  );
  console.log(`关注数 ${wantedUids.size}，有存档的 ${matchedUids}（覆盖 ${coverage}%）`);
  console.log(`其中名字 ≥2 个（存在曾用名）的 ${withFormer} 个，名字总条数 ${totalNames}`);

  const preview = Object.entries(entries).slice(0, 5);
  if (preview.length > 0) {
    console.log("样例：");
    for (const [uid, names] of preview) {
      console.log(`  ${uid}: ${names.join(" / ")}`);
    }
  }

  if (args.dryRun) {
    console.log("\n--dry-run：未写文件。");
    return;
  }

  const slice = {
    formatVersion: 1,
    source: "aicu.cc hname dump",
    generatedAt: new Date().toISOString(),
    followingCount: wantedUids.size,
    matchedUids,
    totalNames,
    entries,
  };
  assertSafeOutput(args.out);
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  const json = JSON.stringify(slice);
  fs.writeFileSync(args.out, json);
  console.log(`\n已写入：${args.out}（${(Buffer.byteLength(json) / 1024).toFixed(0)} KB）`);
  console.log("下一步：在扩展「设置 → 曾用名存档」里导入这个 JSON。");
};

main();
