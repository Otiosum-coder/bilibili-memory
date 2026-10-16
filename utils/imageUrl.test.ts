import { describe, expect, it } from "vitest";
import { assetFileName } from "./imageUrl";

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
