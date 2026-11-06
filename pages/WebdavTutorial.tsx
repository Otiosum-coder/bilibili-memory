export const WebdavTutorial = () => {
  return (
    <div className="container mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">WebDAV 配置教程</h1>
      <p className="text-sm mb-8">
        以坚果云为示例，参考教程：
        <a href="https://help.jianguoyun.com/?p=2064" target="_blank" rel="noopener noreferrer">
          https://help.jianguoyun.com/?p=2064
        </a>
      </p>
      <div className="max-w-3xl space-y-5 text-sm">
        <ol className="list-decimal space-y-3 pl-5 leading-6">
          <li>
            <b>服务器地址</b>：填 WebDAV 根地址，坚果云是
            <code className="mx-1 rounded bg-gray-100 px-1.5 py-0.5 dark:bg-neutral-800">
              https://dav.jianguoyun.com/dav/
            </code>
            。不要填具体文件或目录地址。
          </li>
          <li>
            <b>用户名</b>：填坚果云账号邮箱；<b>密码</b>：填「应用密码」，不是登录密码。
          </li>
          <li>
            <b>远程路径</b>：填一个单独目录，例如
            <code className="mx-1 rounded bg-gray-100 px-1.5 py-0.5 dark:bg-neutral-800">
              /bilibili-memory/
            </code>
            。目录不存在时会自动创建。
          </li>
          <li>
            先点「保存配置」，再点「测试连接」。连接成功后，才能使用「备份到 WebDAV」和「从 WebDAV 恢复」。
          </li>
        </ol>

        <div className="max-w-xl rounded-xl border border-pink-100 bg-pink-50/60 p-4 leading-6 dark:border-pink-900/40 dark:bg-pink-950/20">
          <p className="mb-2 font-medium">以坚果云为例，填写后大概是：</p>
          <dl className="grid grid-cols-[5.5rem_1fr] gap-y-1.5">
            <dt className="text-gray-500 dark:text-neutral-400">服务器地址</dt>
            <dd className="break-all">https://dav.jianguoyun.com/dav/</dd>
            <dt className="text-gray-500 dark:text-neutral-400">用户名</dt>
            <dd>你的坚果云账号</dd>
            <dt className="text-gray-500 dark:text-neutral-400">密码</dt>
            <dd>应用密码（不是登录密码）</dd>
            <dt className="text-gray-500 dark:text-neutral-400">远程路径</dt>
            <dd>/bilibili-memory/</dd>
          </dl>
        </div>

        <p className="text-gray-500 dark:text-neutral-400">
          提示：修改任一配置后都要重新「保存配置」，否则自动同步仍会使用旧地址。
        </p>
      </div>
    </div>
  );
};
