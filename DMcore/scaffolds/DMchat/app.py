#!/usr/bin/env python3
"""DMchat · 即时对话 / 消息服务 (DM 家族示例项目)"""
import os
import time
from flask import Flask, render_template_string, request, jsonify

app = Flask(__name__)
PORT = int(os.environ.get("DM_PORT", "8092"))


@app.route("/")
def index():
    return render_template_string(PAGE, port=PORT)


@app.route("/api/messages", methods=["GET", "POST"])
def messages():
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        text = data.get("text", "")
        # 示例回声机器人
        return jsonify({
            "ok": True,
            "reply": f"[DMbot] 收到：{text}",
            "ts": int(time.time()),
        })
    return jsonify({"messages": [{"from": "DMbot", "text": "欢迎使用 DMchat！"}]})


PAGE = """
<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DMchat · 对话服务</title>
<style>
 body{margin:0;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;
   background:linear-gradient(135deg,#0d1117,#221a2a);color:#e6edf3;min-height:100vh}
 .wrap{max-width:640px;margin:0 auto;padding:48px 24px;display:flex;flex-direction:column;height:90vh}
 .badge{display:inline-block;padding:4px 10px;border-radius:20px;background:rgba(63,185,80,.15);
   color:#3fb950;font-size:12px;margin-bottom:12px;align-self:flex-start}
 h1{font-size:30px;margin:0 0 8px}
 #box{flex:1;overflow:auto;background:#161b22;border:1px solid #2a3140;border-radius:12px;
   padding:16px;margin:16px 0}
 .msg{margin:8px 0;padding:8px 12px;border-radius:10px;max-width:80%;width:fit-content}
 .me{background:#4f8cff;margin-left:auto}
 .bot{background:#21262d}
 .row{display:flex;gap:8px}
 input{flex:1;background:#0b0f16;border:1px solid #2a3140;color:#e6edf3;border-radius:8px;padding:10px}
 button{background:#3fb950;color:#08130a;border:none;padding:0 18px;border-radius:8px;cursor:pointer;font-weight:600}
</style></head>
<body><div class="wrap">
 <span class="badge">DM 家族 · 对话服务</span>
 <h1>DMchat</h1>
 <div id="box"><div class="msg bot">欢迎使用 DMchat！(端口 {{ port }})</div></div>
 <div class="row"><input id="t" placeholder="说点什么…" onkeydown="if(event.key==='Enter')send()">
   <button onclick="send()">发送</button></div>
</div>
<script>
async function send(){
  const t=document.getElementById('t');const v=t.value.trim();if(!v)return;
  const box=document.getElementById('box');
  box.insertAdjacentHTML('beforeend',`<div class="msg me">${v}</div>`);t.value='';
  const r=await fetch('/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:v})});
  const d=await r.json();box.insertAdjacentHTML('beforeend',`<div class="msg bot">${d.reply}</div>`);
  box.scrollTop=box.scrollHeight;
}
</script></body></html>
"""


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=False)
