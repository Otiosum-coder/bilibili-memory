import { describe, expect, it } from "vitest";
import { assetFileName, sourceUrlFromAssetId } from "./imageUrl";

/**
 * 备份文件名必须**由 asset id 确定派生**：
 * 这样还原时不需要额外的映射表，且同一个 id 永远得到同一个文件名（可安全跳过已存在的）。
 */
describe("assetFileName", () => {
  it("把 kind 分隔符与路径分隔符换成文件名安全字符", () => {
    expect(assetFileName("cover:/bfs/archive/abc.jpg")).toBe("cover__bfs_archive_abc.jpg");
    expect(assetFileName("avatar:/bfs/face/member/noface.jpg")).toBe(
      "avatar__bfs_face_member_noface.jpg",
    );
  });

  it("保留扩展名，文件在资源管理器里能正常预览", () => {
    expect(assetFileName("cover:/bfs/archive/abc.webp").endsWith(".webp")).toBe(true);
    expect(assetFileName("cover:/bfs/archive/abc.png").endsWith(".png")).toBe(true);
  });

  it("结果是确定的——同一个 id 永远得到同一个名字", () => {
    const id = "cover:/bfs/archive/698cc9994bec70aac7a913ed2d15cb113acdbc6e.jpg";
    expect(assetFileName(id)).toBe(assetFileName(id));
  });

  it("不同的 id 不会撞名", () => {
    const a = assetFileName("cover:/bfs/archive/aaa.jpg");
    const b = assetFileName("avatar:/bfs/archive/aaa.jpg");
    expect(a).not.toBe(b);
  });

  it("不含路径分隔符（否则会被当成子目录）", () => {
    const name = assetFileName("cover:/bfs/archive/sub/abc.jpg");
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
  });
});

describe("sourceUrlFromAssetId", () => {
  it("从封面 asset id 还原原始地址", () => {
    expect(sourceUrlFromAssetId("cover:/bfs/archive/abc.jpg")).toBe(
      "https://i0.hdslb.com/bfs/archive/abc.jpg",
    );
  });

  it("头像同理", () => {
    expect(sourceUrlFromAssetId("avatar:/bfs/face/abc.jpg")).toBe(
      "https://i0.hdslb.com/bfs/face/abc.jpg",
    );
  });

  it("占位图不生成可抓取地址", () => {
    expect(sourceUrlFromAssetId("cover:/bfs/archive/be27fd62c99036dce67efface486fb0a88ffed06.jpg")).toBe(
      null,
    );
    expect(sourceUrlFromAssetId("avatar:/bfs/face/member/noface.jpg")).toBe(null);
  });

  it("非法 id 返回 null", () => {
    expect(sourceUrlFromAssetId(undefined)).toBe(null);
    expect(sourceUrlFromAssetId("cover:")).toBe(null);
    expect(sourceUrlFromAssetId("random")).toBe(null);
  });
});
