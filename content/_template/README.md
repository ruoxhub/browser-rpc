# 平台模板

新增平台请使用仓库提供的脚手架：

```text
node browser-rpc/scripts/platforms.mjs new <id>
```

该命令会创建 `platform.json`、`endpoints.js` 和 `api.js`。完成平台描述与 Action 实现后，运行：

```text
node browser-rpc/scripts/platforms.mjs sync
node browser-rpc/scripts/platforms.mjs check
```

只有需要自定义注册流程的平台才应使用 `runtime.mode: "custom"` 并自行提供入口文件。
