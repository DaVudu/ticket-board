#!/usr/bin/env python3
"""Liest alle EMP-Tickets samt Kommentaren aus Jira (nur lesend) und schreibt sie als JSON.
Grundlage fuer server/import-jira.js. Geht direkt per Streamable HTTP an den Atlassian-MCP v2
(die normale REST-API lehnt das gescopte Token ab). Zugang aus ~/.config/jira/emperor.env
(JIRA_EMAIL, JIRA_API_TOKEN); das Token wird nie ausgegeben.

Aufruf: python3 scripts/export-jira.py data/jira-export.json"""
import base64, json, os, sys, urllib.request

URL = "https://mcp.atlassian.com/v2/mcp"
CID = "fdb0a7bd-a068-40c4-93a1-dd7661ff6023"
if len(sys.argv) != 2:
    sys.exit("Aufruf: export-jira.py <ausgabe.json>")
OUT = sys.argv[1]

env = {}
for line in open(os.path.expanduser("~/.config/jira/emperor.env")):
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
AUTH = "Basic " + base64.b64encode(f"{env['JIRA_EMAIL']}:{env['JIRA_API_TOKEN']}".encode()).decode()
del env

session = None
def post(msg):
    global session
    headers = {"Authorization": AUTH, "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if session: headers["Mcp-Session-Id"] = session
    req = urllib.request.Request(URL, data=json.dumps(msg).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        session = session or r.headers.get("Mcp-Session-Id")
        body = r.read().decode()
    if "id" not in msg: return None
    for line in body.splitlines():
        if line.startswith("data: "):
            d = json.loads(line[6:])
            if d.get("id") == msg["id"]: return d
    return json.loads(body) if body.strip().startswith("{") else None

n = 10
def call(tool, args):
    global n
    n += 1
    d = post({"jsonrpc": "2.0", "id": n, "method": "tools/call", "params": {"name": tool, "arguments": args}})
    res = d["result"]
    text = "".join(c.get("text", "") for c in res.get("content", []))
    if res.get("isError"): raise RuntimeError(f"{tool}: {text[:500]}")
    data = json.loads(text)
    return data.get("data", data)

post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "export", "version": "0"}}})
post({"jsonrpc": "2.0", "method": "notifications/initialized"})

FIELDS = ["summary", "description", "status", "issuetype", "priority", "assignee", "labels",
          "issuelinks", "parent", "created", "updated", "comment", "customfield_10019"]
issues, token = [], None
while True:
    args = {"cloudId": CID, "jql": "project = EMP ORDER BY key ASC", "maxResults": 100, "fields": FIELDS, "view": "full"}
    if token: args["nextPageToken"] = token
    page = call("searchJiraIssuesUsingJql", args)
    issues += page["issues"]
    print(f"Seite: {len(page['issues'])} (gesamt {len(issues)})", file=sys.stderr)
    token = page.get("nextPageToken")
    if page.get("isLast", True) or not token: break

for i, issue in enumerate(issues):
    total = (issue["fields"].get("comment") or {}).get("total", 0)
    if total:
        r = call("executeRead", {"cloudId": CID, "name": "listJiraIssueComments", "inputs": {"issueIdOrKey": issue["key"], "maxResults": 100}})
        issue["_comments"] = r.get("comments", [])
        if len(issue["_comments"]) < total: print(f"WARN {issue['key']}: {len(issue['_comments'])}/{total} Kommentare", file=sys.stderr)
    if i % 25 == 0: print(f"Kommentare: {i}/{len(issues)}", file=sys.stderr)

json.dump(issues, open(OUT, "w"), ensure_ascii=False, indent=1)
print(f"{len(issues)} Tickets -> {OUT}")
