# A Code Foundry plugin without the SDK: newline-delimited JSON-RPC 2.0 on stdin/stdout.
import json, sys

def send(m):
    sys.stdout.write(json.dumps(dict(m, jsonrpc="2.0")) + "\n")
    sys.stdout.flush()

waiting = {}  # our request id -> (the command/invoke id it answers, what it was)
armed = {}  # wake subscription id -> its args (wake/subscribed, wake/unsubscribed)
print("pyecho ready", file=sys.stderr, flush=True)
for line in sys.stdin:
    m = json.loads(line)
    method, mid, p = m.get("method"), m.get("id"), m.get("params") or {}
    if method == "initialize":
        send({"id": mid, "result": {"protocol": 1, "capabilities": ["ping"]}})
    elif method == "ping":
        send({"id": mid, "result": {}})
    elif method == "shutdown":
        send({"id": mid, "result": {}})
        break
    elif method == "wake/subscribed":
        armed[p["subscription"]] = p.get("args") or {}
    elif method == "wake/unsubscribed":
        armed.pop(p["subscription"], None)
    elif method == "command/invoke" and p["command"] == "echo":
        send({"id": mid, "result": {"message": "echo: " + p["args"].get("text", "")}})
    elif method == "command/invoke" and p["command"] in ("send", "ring"):
        ask = "py-%d" % (len(waiting) + 1)
        waiting[ask] = (mid, p["command"])
        if p["command"] == "send":
            send({"id": ask, "method": "host/invoke", "params": {"command": "thread.send",
                  "args": {"text": p["args"]["text"]}, "context": p["context"]}})
        else:
            send({"id": ask, "method": "wake/fire", "params": {"source": "bell", "match": {"tone": "high"},
                  "title": "ring (%d armed)" % len(armed), "payload": {"armed": sorted(armed)}}})
    elif method is None and mid in waiting:  # the host's answer to our request
        orig, what = waiting.pop(mid)
        if "error" in m:
            send({"id": orig, "error": m["error"]})
        elif what == "ring":
            send({"id": orig, "result": {"message": "rang: delivered %d" % m["result"]["delivered"]}})
        else:
            send({"id": orig, "result": {"message": "sent: " + m["result"].get("message", "")}})
    elif mid is not None and method is not None:
        send({"id": mid, "error": {"code": -32601, "message": "unknown method " + method}})
