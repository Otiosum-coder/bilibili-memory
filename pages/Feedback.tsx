const REPO_URL = "https://github.com/Otiosum-coder/bilibili-memory";
const ISSUES_URL = `${REPO_URL}/issues`;

const Feedback = () => {
  return (
    <div className="max-w-[800px] mx-auto p-6">
      <h2 className="text-3xl font-semibold mb-3">建议反馈</h2>

      <section className="mt-10 text-gray-600 text-base space-y-4">
        <p>
          本项目是 <strong>哔哩哔哩记忆</strong>（基于开源项目 bilibili-history-wxt 二次开发），
          目前由个人维护。问题和建议请直接提交到下面的仓库。
        </p>

        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-sm text-gray-500 dark:text-neutral-400">提交问题或建议</p>
          <p className="mt-1 text-lg">
            <a
              className="break-all text-pink-600 hover:underline dark:text-pink-400"
              href={ISSUES_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              {ISSUES_URL}
            </a>
          </p>
        </div>

        <p className="text-sm leading-relaxed text-gray-500 dark:text-neutral-400">
          提 issue 时建议附上：扩展版本号、浏览器版本，以及问题对应的页面。
          <strong className="font-medium text-gray-700 dark:text-neutral-300">
            请不要在 issue 里贴 Cookie / SESSDATA / WebDAV 密码
          </strong>
          ——这些信息不需要，泄露会危及你的账号。
        </p>

        <p className="text-sm leading-relaxed text-gray-500 dark:text-neutral-400">
          如果你也使用了上游的 bilibili-history-wxt，与<strong>上游原有功能</strong>相关的问题
          请提交到上游仓库：
          <a
            className="ml-1 break-all text-blue-500 hover:underline"
            href="https://github.com/mundane799699/bilibili-history-wxt/issues"
            target="_blank"
            rel="noopener noreferrer"
          >
            github.com/mundane799699/bilibili-history-wxt
          </a>
        </p>
      </section>
    </div>
  );
};

export default Feedback;
