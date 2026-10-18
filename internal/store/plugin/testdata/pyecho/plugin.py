# A Code Foundry plugin without the SDK: newline-delimited JSON-RPC 2.0 on stdin/stdout.
import json, sys

def send(m):
    sys.stdout.write(json.dumps(dict(m, jsonrpc="2.0")) + "\n")
    sys.stdout.flush()

waiting = {}  # our host/invoke id -> the command/invoke id it answers
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
    elif method == "command/invoke" and p["command"] == "echo":
        send({"id": mid, "result": {"message": "echo: " + p["args"].get("text", "")}})
    elif method == "command/invoke" and p["command"] == "send":
        ask = "py-%d" % (len(waiting) + 1)
        waiting[ask] = mid
        send({"id": ask, "method": "host/invoke", "params": {"command": "thread.send",
              "args": {"text": p["args"]["text"]}, "context": p["context"]}})
    elif method is None and mid in waiting:  # the host's answer to our host/invoke
        orig = waiting.pop(mid)
        if "error" in m:
            send({"id": orig, "error": m["error"]})
        else:
            send({"id": orig, "result": {"message": "sent: " + m["result"].get("message", "")}})
    elif mid is not None and method is not None:
        send({"id": mid, "error": {"code": -32601, "message": "unknown method " + method}})
