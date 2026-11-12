# HGhubX NAS 后端

把本地影片目录包装成 HGhubX 能直接接入的服务。零依赖，需要 Node ≥ 18 和 ffmpeg/ffprobe。

    node server.mjs /path/to/media --port 8080 [--cache ./cache]

目录约定：
- `媒体目录/剧名/01.mp4 02.mp4 …`：一个子文件夹是一部剧，视频按文件名自然排序，对应各集。
- `媒体目录/电影.mkv`：散放的视频文件是单集影片。
- 封面：剧文件夹里放 `cover/poster/folder.jpg`，电影放同名 `.jpg`；没有就用 ffmpeg 截一帧。
- 可选 `meta.json`（剧文件夹内）：`{"title":"","description":"","tags":["喜剧"],"score":9.1}`。

客户端设置：
1. 「设置 → 接入地址」填 `http://<NAS-IP>:8080`。
2. 客户端默认的严格安全模式会拒绝私网 IP（192.168.x、10.x、127.x），需要在设置里关闭，
   或用 `HGHUBX_STRICT=0` / `--no-strict` 启动。

说明：
- 首次播放某一集时，用 ffmpeg 封装成 HLS（H.264+AAC 直接拷贝，不重编码；其它编码才转码），结果缓存在 `cache/hls`，所以第一次会等几秒到几十秒。
- 客户端的媒体代理不支持 Range，必须是 HLS 小分片，不能直接给 mp4。
- 没有账号体系：登录接口接受任意用户名，点赞、收藏、评论只是占位。不要把端口暴露到公网。
