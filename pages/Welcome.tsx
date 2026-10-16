import { useNavigate } from "react-router-dom";
import { UPDATE_HISTORY } from "../utils/constants";

const Welcome = () => {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center min-h-[80vh] bg-white p-6 rounded-xl shadow-sm m-4 max-w-[800px] mx-auto">
      <h1 className="text-3xl font-bold text-gray-800 mb-2">欢迎使用哔哩哔哩记忆</h1>

      <button
        onClick={() => navigate("/")}
        className="px-10 py-3 bg-blue-600 text-white rounded-xl font-semibold shadow-lg hover:shadow-xl hover:bg-blue-700 transform hover:-translate-y-0.5 transition-all duration-200 active:translate-y-0 active:shadow-md mb-12"
      >
        进入首页
      </button>

      {/* About Page Content */}
      <div className="w-full border-t border-gray-100 pt-10">
        <div className="space-y-8 text-left">
          <section>
            <h2 className="text-xl font-semibold mb-3 text-gray-800">简介</h2>
            <div className="text-gray-600 text-base space-y-4">
              <p>
                B 站的历史记录、收藏夹都有上限，关注的 UP 主也可能改名、注销或删除内容。
                等到某天想回头找的时候，往往已经什么都不剩了。
              </p>
              <p>
                这个扩展把观看历史、收藏夹、订阅合集、关注列表，以及点赞过与
                投币过的视频都保存在本地 IndexedDB 里，并记录关注关系每天的变动，
                让「我到底丢了什么」有答案。B 站的点赞与投币列表只保留最近 20 条。
              </p>
            </div>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3 text-gray-800">功能特点</h2>
            <ul className="list-disc list-inside text-gray-600 space-y-2 text-base">
              <li>突破 Bilibili 历史记录的数量限制，支持按时间排序浏览与搜索</li>
              <li>本地保存收藏夹与订阅合集，支持按文件夹增量 / 全量同步</li>
              <li>记录关注的 UP 主，追踪改名、取关与账号注销，并保留注销前的名字与曾用名链路</li>
              <li>永久保存点赞与投币记录，掉出 B 站 20 条窗口的条目也不会被删除</li>
              <li>「消失档案」汇总四处已查不到的内容，保留消失前的完整快照并可恢复回原页面</li>
              <li>所有数据都存储在本地 IndexedDB，可导出 JSON、备份到本地目录或 WebDAV</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3 text-gray-800">使用说明</h2>
            <ol className="list-decimal list-inside text-gray-600 space-y-2 text-base">
              <li>登录 B 站网页版</li>
              <li>安装扩展后，点击扩展图标进入主界面</li>
              <li>首次点击同步按钮会全量同步你的数据</li>
              <li>之后可在设置页配置自动同步间隔</li>
            </ol>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3 text-gray-800">隐私说明</h2>
            <p className="text-gray-600 text-base">
              所有数据都存储在本地，不会上传到任何服务器。使用云同步或 WebDAV 备份时，
              数据只会发往你自己配置的服务地址。
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3 text-gray-800">开源与致谢</h2>
            <p className="text-gray-600 text-base">
              本项目基于开源项目 bilibili-history-wxt 二次开发，在原项目基础上增加了关注 UP
              主追踪等能力。原项目采用 MIT 许可证，版权归原作者及贡献者所有，详见仓库根目录的
              LICENSE 文件。
            </p>
            <p className="text-gray-600 text-base mt-2">上游项目地址：</p>
            <p className="text-lg mb-6 break-all">
              <a
                className="text-blue-500 hover:text-blue-600"
                href="https://github.com/mundane799699/bilibili-history-wxt"
                target="_blank"
                rel="noopener noreferrer"
              >
                https://github.com/mundane799699/bilibili-history-wxt
              </a>
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3 text-gray-800">更新日志</h2>
            <ul className="space-y-8">
              {UPDATE_HISTORY.map((release) => (
                <li key={release.version}>
                  <div className="flex justify-between items-center mb-2">
                    <h2 className="text-lg font-bold text-gray-700">{release.version}</h2>
                    <span className="text-sm text-gray-500 bg-gray-100 px-2 py-1 rounded">
                      {release.date}
                    </span>
                  </div>
                  <ul className="list-disc list-inside text-gray-600 space-y-2 text-base pl-2">
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
    </div>
  );
};

export default Welcome;
