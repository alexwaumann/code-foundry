#!/bin/bash
# Code Foundry WebSocket + Chrome probe. Nothing is installed: temp Chrome profile, about:blank only.
# Run it, then open the printed file in Code Foundry. Press Enter here to stop Chrome.
D="$HOME/cf-probe"; P=9377; rm -rf "$D"; mkdir -p "$D"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=$P \
  --remote-allow-origins='*' --force-device-scale-factor=2 --user-data-dir="$D/profile" --no-first-run \
  --disable-background-networking --disable-component-update --disable-sync about:blank >/dev/null 2>&1 &
C=$!; trap 'kill $C 2>/dev/null; wait $C 2>/dev/null; sleep 1; pkill -f "user-data-dir=$D/profile" 2>/dev/null; rm -rf "$D"' EXIT
for i in $(seq 1 30); do J=$(curl -s http://127.0.0.1:$P/json/version) && [ -n "$J" ] && break; sleep 0.3; done
URL=$(printf '%s' "$J" | sed -n 's/.*"webSocketDebuggerUrl": *"\([^"]*\)".*/\1/p')
[ -z "$URL" ] && { echo "FAIL: Chrome did not answer on port $P"; exit 1; }
cat > "$D/probe.html" <<HTML
<!doctype html><meta charset=utf-8><title>CF probe</title>
<body style="margin:0;padding:14px;background:#0d1117;color:#e6edf3;font:14px/1.5 ui-monospace,Menlo,monospace">
<b>Code Foundry WebSocket + Chrome probe</b><pre id=o style="white-space:pre-wrap;margin:8px 0"></pre>
<canvas id=c style="width:320px;height:200px;background:#000;border-radius:6px"></canvas>
<script>
const U="$URL",o=document.getElementById('o'),c=document.getElementById('c'),x=c.getContext('2d');
const log=s=>{o.textContent+=s+"\n"},sleep=m=>new Promise(r=>setTimeout(r,m));
log(navigator.userAgent.includes('Chrome')?'WARNING: not WebKit, open this inside Code Foundry':'engine: WebKit');
function open(){return new Promise(r=>{const w=new WebSocket(U);w.binaryType='arraybuffer';w.onopen=()=>r(w);w.onerror=()=>r(null);setTimeout(()=>r(null),4000)})}
function rpc(w){let i=0;const p=new Map(),ev=[];w.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m.result||m.error);p.delete(m.id)}else ev.forEach(f=>f(m))};
 return{on:f=>ev.push(f),send:(method,params={},sessionId)=>new Promise(r=>{const n=++i;p.set(n,r);w.send(JSON.stringify({id:n,method,params,sessionId}))})}}
(async()=>{
 const ws=(await Promise.all([...Array(40)].map(open))).filter(Boolean);
 log((ws.length===40?'PASS':'FAIL')+' sockets open: '+ws.length+' of 40');
 if(!ws.length)return log('RESULT: FAIL');
 const rs=ws.map(rpc),t=performance.now();const got=await Promise.all(rs.map(r=>Promise.race([r.send('Browser.getVersion'),sleep(3000).then(()=>null)])));
 const ok=got.filter(Boolean).length;log((ok===ws.length?'PASS':'FAIL')+' round trips: '+ok+' in '+Math.round(performance.now()-t)+' ms');
 const r=rs[0],{targetId}=await r.send('Target.createTarget',{url:'about:blank'}),{sessionId:s}=await r.send('Target.attachToTarget',{targetId,flatten:true});
 await r.send('Page.enable',{},s);await r.send('Runtime.enable',{},s);
 await r.send('Emulation.setDeviceMetricsOverride',{width:640,height:400,deviceScaleFactor:2,mobile:false},s);
 await r.send('Runtime.evaluate',{expression:"window.hits=0;document.body.style.cssText='margin:0;height:2000px;background:#fff';document.body.innerHTML='<button id=b style=\"position:fixed;left:20px;top:20px;width:160px;height:60px\">click</button><div id=a style=\"position:fixed;top:120px;width:60px;height:60px;background:#1f6feb\"></div>';b.onclick=()=>hits++;let k=0;(function f(){k+=5;a.style.transform='translateX('+k%600+'px)';requestAnimationFrame(f)})();1"},s);
 let n=0,ms=0,busy=false,w=0;
 r.on(async m=>{if(m.method!=='Page.screencastFrame')return;r.send('Page.screencastFrameAck',{sessionId:m.params.sessionId},s);if(busy)return;busy=true;const t0=performance.now();const b=Uint8Array.from(atob(m.params.data),q=>q.charCodeAt(0));const im=await createImageBitmap(new Blob([b],{type:'image/jpeg'}));w=im.width;c.width=im.width;c.height=im.height;x.drawImage(im,0,0);im.close();n++;ms+=performance.now()-t0;busy=false});
 await r.send('Page.startScreencast',{format:'jpeg',quality:80,everyNthFrame:1,maxWidth:1280,maxHeight:800},s);
 await sleep(5000);const fps=n/5;log((fps>20?'PASS':'FAIL')+' Chrome frames: '+fps.toFixed(1)+' fps, '+(ms/Math.max(n,1)).toFixed(1)+' ms decode+draw, width '+w+(w>=1280?' (2x)':' (1x)'));
 for(const type of['mousePressed','mouseReleased'])await r.send('Input.dispatchMouseEvent',{type,x:60,y:40,button:'left',clickCount:1},s);
 await sleep(200);const h=await r.send('Runtime.evaluate',{expression:'hits',returnByValue:true},s);
 const hits=h.result&&h.result.value;log((hits===1?'PASS':'FAIL')+' input reached Chrome: '+hits+' click');
 log('RESULT: '+(o.textContent.includes('FAIL')?'FAIL':'PASS')+'. Leave open to check sockets survive idle.');
 const line=document.createTextNode('');o.after(line);const t1=Date.now();setInterval(()=>{const a=ws.filter(q=>q.readyState===1).length;line.textContent='sockets alive: '+a+' of '+ws.length+' after '+Math.round((Date.now()-t1)/60000)+' min'},5000);
})();
</script>
HTML
echo "Chrome is running. In Code Foundry, open this file (or ask a thread to open it in the side panel):"
echo "  $D/probe.html"
read -r -p "Press Enter when finished, to stop Chrome. "
