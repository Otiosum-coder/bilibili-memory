const Feedback = () => {
  return (
    <div className="max-w-[800px] mx-auto p-6">
      <h2 className="text-3xl font-semibold mb-3">建议反馈</h2>

      <section className="mt-10 text-gray-600 text-base space-y-4">
        <p>
          本项目是基于 bilibili-history-wxt 的二次开发版本，目前由使用者自行维护，
          没有设立公开的反馈渠道，也没有交流群。
        </p>
        <p>
          与上游原有功能相关的问题和建议，请提交到上游仓库；与本项目新增功能相关的问题，
          请在你的仓库中提出。
        </p>
        <p className="text-lg">
          <a
            className="text-blue-500 break-all"
            href="https://github.com/mundane799699/bilibili-history-wxt"
            target="_blank"
            rel="noopener noreferrer"
          >
            https://github.com/mundane799699/bilibili-history-wxt
          </a>
        </p>
      </section>
    </div>
  );
};

export default Feedback;
