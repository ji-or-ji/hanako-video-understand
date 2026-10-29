# sdk/

这里的 `app-contract/*.js` 是从 Hana Server 1.3.6-beta 随附的 `@hana/app-sdk` 里原样复制出来的运行时闭包
（只保留服务端需要的那部分，去掉 `.d.ts` / `.js.map` / UI 组件）。Hana 的 App 进程不会去用户机器上
`npm install`，也不会从宿主的 `node_modules` 解析依赖，所以这份文件必须跟着应用一起分发。

升级 Hana 后若 SDK 有变化，用 `hana-app-creator` 的脚手架重新生成一个空应用，把新生成的
`sdk/app-contract/*.js` 覆盖过来即可，不要手改这里的文件。
