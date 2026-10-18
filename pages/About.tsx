import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { FIRST_RUN_GUIDE_COMPLETED, UPDATE_HISTORY } from "../utils/constants";
import { setStorageValue } from "../utils/storage";

export const About: React.FC = () => {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    // 兼容 Chrome/Firefox
    const manifest = browser?.runtime?.getManifest?.();
    if (manifest?.version) {
      setVersion(manifest.version);
    }
  }, []);

  /** 把首次引导的完成标记重置，MainLayout 监听到后会在当前页面重新打开引导 */
  const replayFirstRunGuide = async () => {
    await setStorageValue(FIRST_RUN_GUIDE_COMPLETED, false);
    toast.success("首次引导已重新打开");
  };

  return (
    <div className="max-w-[800px] mx-auto p-6">
      {/* 品牌 lockup：图标 + 「bilibili memory」艺术字 + 标语，右侧配版本号。
          侧边栏只有 160px 放不下艺术字，所以完整组合放在这里。 */}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <img
          src="/brand/lockup.png"
          alt="哔哩哔哩记忆 · 留住你在 B 站的每一份喜欢"
          className="w-full max-w-[420px]"
        />
        {version ? (
          <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-sm text-gray-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400">
            v{version}
          </span>
        ) : null}
      </div>

      <div className="space-y-6">
        <section>
          <h2 className="text-xl font-semibold mb-3">简介</h2>
          <div className="text-gray-600 text-base space-y-4">
            <p>
              B 站的历史记录、收藏夹都有上限，关注的 UP 主也可能改名、注销或删除内容。
              等到某天想回头找的时候，往往已经什么都不剩了。
            </p>
            <p>
              这个扩展把观看历史、收藏夹、订阅合集、关注列表，以及点赞过与
              投币过的视频都保存在本地 IndexedDB 里，并记录关注关系每天的变动——谁被新关注了、
              谁被取关了、谁改了名字、谁注销了账号。目的是让"我到底丢了什么"这个问题有答案。
              B 站的点赞与投币列表只保留最近 20 条，超出之后在 B 站上再也查不到，只能靠本地留存。
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-3">功能特点</h2>
          <ul className="list-disc list-inside text-gray-600 space-y-2 text-base">
            <li>突破 Bilibili 历史记录的数量限制，按时间排序浏览与搜索</li>
            <li>本地保存收藏夹与订阅合集，支持按文件夹增量 / 全量同步</li>
            <li>记录关注的 UP 主，追踪改名、取关与账号注销，并保留注销前的名字与曾用名链路</li>
            <li>永久保存点赞与投币记录（B 站只留最近 20 条），掉出窗口的条目也不会被删除</li>
            <li>
              「消失档案」汇总收藏、订阅合集、关注、互动四处已查不到的内容，保留消失前的完整快照
            </li>
            <li>所有数据都存储在本地 IndexedDB，可导出 JSON、备份到本地目录或 WebDAV</li>
            <li>支持 WebDAV 双向同步，合并时逐字段择优，不因单向覆盖丢数据</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-3">使用说明</h2>
          <ol className="list-decimal list-inside text-gray-600 space-y-2 text-base">
            <li>登录 B 站网页版</li>
            <li>安装扩展后，点击扩展图标进入主界面</li>
            <li>首次点击同步按钮会全量同步你的数据</li>
            <li>之后可在设置页配置自动同步间隔</li>
          </ol>

          {/* 首次引导原本放在「数据与存储管理」里，但它既不涉及数据也不涉及存储，
              只是重看一遍介绍，放在关于页更合适。 */}
          <button
            type="button"
            onClick={() => void replayFirstRunGuide()}
            className="mt-4 rounded-lg border border-blue-300 px-3 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-50 dark:border-blue-500/30 dark:text-blue-300 dark:hover:bg-blue-500/10"
          >
            重新查看首次引导
          </button>
          <p className="mt-2 text-xs text-gray-400 dark:text-neutral-500">
            引导会依次指向侧边栏入口、历史记录工具栏与备份功能。
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-3">隐私说明</h2>
          <p className="text-gray-600 text-base">
            所有数据都存储在本地，不会上传到任何服务器。扩展不收集个人信息或浏览数据。
            使用云同步或 WebDAV 备份时，数据只会发往你自己配置的服务地址。
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-3">开源与致谢</h2>
          <p className="text-gray-600 text-base">
            本项目基于开源项目 bilibili-history-wxt 二次开发，在原项目基础上增加了关注 UP
            主追踪等能力。原项目采用 MIT 许可证，版权归原作者及贡献者所有，详见仓库根目录的
            LICENSE 文件。
          </p>
          <p className="text-gray-600 text-base mt-3">上游项目地址：</p>
          <p className="text-lg mb-4">
            <a
              className="text-blue-500 break-all"
              href="https://github.com/mundane799699/bilibili-history-wxt"
              target="_blank"
              rel="noopener noreferrer"
            >
              https://github.com/mundane799699/bilibili-history-wxt
            </a>
          </p>
          <p className="text-gray-600 text-base">
            仓库代码同样以 MIT 许可证开源，欢迎查看与改进。
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-3">更新日志</h2>
          <ul className="space-y-8">
            {UPDATE_HISTORY.map((release) => (
              <li key={release.version}>
                <div className="flex justify-between items-center">
                  <h2 className="text-lg">{release.version}</h2>
                  <p className="text-gray-600 text-base">{release.date}</p>
                </div>
                <ul className="list-disc list-inside text-gray-600 space-y-2 text-base">
                  {release.changes.map((change, index) => (
                    <li key={index}>{change}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
};
