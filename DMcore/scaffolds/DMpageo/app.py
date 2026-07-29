#!/usr/bin/env python3
"""DMpageo · 页面 / 前端展示服务 (DM 家族示例项目)"""
import os
from flask import Flask, render_template_string, request, jsonify

app = Flask(__name__)
PORT = int(os.environ.get("DM_PORT", "8091"))


@app.route("/")
def index():
    return render_template_string(PAGE, port=PORT)


@app.route("/api/pages", methods=["GET", "POST"])
def pages():
    """极简“页面”存储示例，仅演示服务可被 DMcore 管理。"""
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        return jsonify({"ok": True, "saved": data.get("title", "未命名")})
    return jsonify({"pages": [{"title": "首页", "slug": "home"}, {"title": "关于", "slug": "about"}]})


PAGE = """
<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DMpageo · 页面服务</title>
<style>
 body{margin:0;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;
   background:linear-gradient(135deg,#0d1117,#1a2233);color:#e6edf3;min-height:100vh}
 .wrap{max-width:760px;margin:0 auto;padding:64px 24px}
 .badge{display:inline-block;padding:4px 10px;border-radius:20px;background:rgba(79,140,255,.15);
   color:#4f8cff;font-size:12px;margin-bottom:16px}
 h1{font-size:34px;margin:0 0 12px}
 p{color:#8b949e;line-height:1.7}
 .card{background:#161b22;border:1px solid #2a3140;border-radius:12px;padding:18px;margin-top:20px}
 code{background:#0b0f16;padding:2px 6px;border-radius:6px;color:#3fb950}
</style></head>
<body><div class="wrap">
 <span class="badge">DM 家族 · 页面服务</span>
 <h1>DMpageo</h1>
 <p>这是一个由 <b>DMcore</b> 一键安装并托管的页面服务示例。它监听端口 <code>{{ port }}</code>，
    可作为家族内的前端展示 / 落地页服务。</p>
 <div class="card">
   <p style="margin:0 0 8px;color:#e6edf3">试试调用它的接口：</p>
   <p style="margin:0"><code>GET /api/pages</code> → 返回页面列表<br>
   <code>POST /api/pages</code> → 保存一个页面</p>
 </div>
</div></body></html>
"""


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=False)
