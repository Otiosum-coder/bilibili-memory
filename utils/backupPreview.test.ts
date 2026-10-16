import { describe, expect, it } from "vitest";
import {
  BACKUP_KEY_SPECS,
  buildBackupPreview,
  formatBackupPreview,
} from "./backupPreview";

describe("buildBackupPreview", () => {
  it("统计出哪些是新增、哪些本地已有", () => {
    const rows = buildBackupPreview(
      {
        favFolders: [{ id: 1 }, { id: 2 }, { id: 3 }],
      },
      { favFolders: new Set(["1", "2"]) },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "favFolders", incoming: 3, existing: 2, isNew: 1 });
  });

  it("关键：只统计文件里真实存在的项，不做任何写库", () => {
    // 预览必须是纯函数——否则"看一下"就已经改了数据
    const payload = { following: [{ mid: 10 }] };
    const localIds = { following: new Set<string>() };

    buildBackupPreview(payload, localIds);

    expect(localIds.following.size).toBe(0);
    expect(payload.following).toEqual([{ mid: 10 }]);
  });

  it("复合主键的 store 用 folder_id:id 判重", () => {
    const rows = buildBackupPreview(
      {
        favResources: [
          { id: 5, folder_id: 100 },
          { id: 5, folder_id: 200 }, // 同一个 id 但在另一个收藏夹，算新增
        ],
      },
      { favResources: new Set(["100:5"]) },
    );

    expect(rows[0]).toMatchObject({ incoming: 2, existing: 1, isNew: 1 });
  });

  it("消失档案同样用复合主键", () => {
    const rows = buildBackupPreview(
      { vanishedFavResources: [{ id: 5, folder_id: 100 }] },
      { vanishedFavResources: new Set(["100:5"]) },
    );
    expect(rows[0]).toMatchObject({ incoming: 1, existing: 1, isNew: 0 });
  });

  it("关注用 mid 判重", () => {
    const rows = buildBackupPreview({ following: [{ mid: 7 }, { mid: 8 }] }, { following: new Set(["7"]) });
    expect(rows[0]).toMatchObject({ incoming: 2, existing: 1, isNew: 1 });
  });

  it("关注变动用 event_id 判重", () => {
    const rows = buildBackupPreview(
      { followingEvents: [{ event_id: "a" }, { event_id: "b" }] },
      { followingEvents: new Set(["a", "b"]) },
    );
    expect(rows[0]).toMatchObject({ incoming: 2, existing: 2, isNew: 0 });
  });

  it("关键：history 用总数代替键集合，避免为了预览读几万条", () => {
    const rows = buildBackupPreview(
      { history: [{ id: 1 }, { id: 2 }, { id: 3 }] },
      {}, // 刻意不提供 history 的键集合
      1,
    );

    expect(rows[0]).toMatchObject({ key: "history", incoming: 3, existing: 1, isNew: 2 });
  });

  it("history 本地更多时不会算出负数", () => {
    const rows = buildBackupPreview({ history: [{ id: 1 }] }, {}, 999);
    expect(rows[0]).toMatchObject({ incoming: 1, existing: 1, isNew: 0 });
  });

  it("忽略文件里没有的数据项", () => {
    const rows = buildBackupPreview({ favFolders: [{ id: 1 }] }, {});
    expect(rows.map((row) => row.key)).toEqual(["favFolders"]);
  });

  it("忽略不是数组的字段（避免把 exportTime 之类的元数据当数据项）", () => {
    const rows = buildBackupPreview({ exportTime: "2026-10-08", version: "2.0" }, {});
    expect(rows).toEqual([]);
  });

  it("缺少判重键的条目不计入重复，但计入总数", () => {
    const rows = buildBackupPreview({ favFolders: [{ id: 1 }, {}] }, { favFolders: new Set(["1"]) });
    expect(rows[0]).toMatchObject({ incoming: 2, existing: 1, isNew: 1 });
  });

  it("每一项都有中文标签", () => {
    for (const spec of BACKUP_KEY_SPECS) {
      expect(spec.label.length).toBeGreaterThan(0);
    }
  });
});

describe("formatBackupPreview", () => {
  it("列出每一项的新增与重复数", () => {
    const text = formatBackupPreview([
      { key: "favFolders", label: "收藏夹", incoming: 3, existing: 2, isNew: 1 },
    ]);

    expect(text).toContain("收藏夹：3 条，其中 1 条是新的，2 条本地已有");
    expect(text).toContain("合计新增约 1 条");
  });

  it("全部重复时措辞更简短", () => {
    const text = formatBackupPreview([
      { key: "favFolders", label: "收藏夹", incoming: 3, existing: 3, isNew: 0 },
    ]);

    expect(text).toContain("收藏夹：3 条，本地都已有");
  });

  it("空预览给出明确提示", () => {
    expect(formatBackupPreview([])).toContain("没有可识别的数据项");
  });
});
