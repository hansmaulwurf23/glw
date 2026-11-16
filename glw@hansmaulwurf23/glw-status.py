#!/usr/bin/env python3
"""Query all GitLab instances configured in glab for running pipelines and
print the result as JSON on stdout.

Standard library only. Tokens are taken from `glab config get token --host <host>`
(works with the keyring, too), falling back to GITLAB_TOKEN_<HOST>.

Usage:
  glw-status.py [--hosts a,b] [--activity-days 7] [--recent-minutes 60]
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

# Pipeline still running / waiting -> "do not deploy yet"
BUSY = {"created", "waiting_for_resource", "preparing", "pending", "running", "scheduled"}
# Pipeline is through but waits for a manual job (e.g. deploy) -> "ready"
READY = {"manual"}
FINISHED = {"success", "failed", "canceled", "skipped"}

GLAB_CONFIG = os.path.expanduser(os.environ.get("GLAB_CONFIG_DIR", "~/.config/glab-cli")) + "/config.yml"
TIMEOUT = 10


def now_utc():
    return dt.datetime.now(dt.timezone.utc)


def parse_ts(s):
    if not s:
        return None
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def glab_hosts():
    """Hosts from the 'hosts:' block of glab's config.yml (no YAML lib needed)."""
    hosts = []
    try:
        with open(GLAB_CONFIG, encoding="utf-8") as f:
            in_hosts = False
            for line in f:
                if re.match(r"^hosts:\s*$", line):
                    in_hosts = True
                    continue
                if in_hosts:
                    if re.match(r"^\S", line):
                        break
                    m = re.match(r"^ {4}([^\s#][^:]*):\s*$", line)
                    if m:
                        hosts.append(m.group(1).strip())
    except OSError:
        pass
    return hosts


def glab_value(host, key):
    try:
        r = subprocess.run(["glab", "config", "get", key, "--host", host],
                           capture_output=True, text=True, timeout=TIMEOUT)
        return r.stdout.strip() if r.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def host_token(host):
    env = "GITLAB_TOKEN_" + re.sub(r"\W", "_", host).upper()
    return os.environ.get(env) or glab_value(host, "token")


class Api:
    def __init__(self, host, token):
        proto = glab_value(host, "api_protocol") or "https"
        api_host = glab_value(host, "api_host") or host
        self.base = f"{proto}://{api_host}/api/v4/"
        self.token = token

    def get(self, path, **params):
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"PRIVATE-TOKEN": self.token,
                                                   "User-Agent": "glw-cinnamon-applet"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.load(resp)


def check_host(host, activity_days, recent_minutes, only_mine=False, username=""):
    result = {"host": host, "ok": False, "error": None, "projects": 0,
              "busy": [], "ready": [], "recent": []}
    token = host_token(host)
    if not token:
        result["error"] = "no token (run: glab auth login --hostname %s)" % host
        result["skipped"] = True
        return result
    api = Api(host, token)
    since = (now_utc() - dt.timedelta(days=activity_days)).isoformat()
    try:
        # pipelines are filtered by the user who triggered them (push, MR, web, schedule owner)
        pipe_filter = {}
        if only_mine:
            pipe_filter["username"] = username or api.get("user")["username"]
        result["username"] = pipe_filter.get("username")
        projects = []
        page = 1
        while page <= 5:  # at most 500 projects
            batch = api.get("projects", membership="true", archived="false",
                            order_by="last_activity_at", last_activity_after=since,
                            per_page=100, page=page)
            projects += batch
            if len(batch) < 100:
                break
            page += 1
    except (urllib.error.URLError, OSError, ValueError) as e:
        result["error"] = str(e)
        return result

    # projects with CI/CD disabled answer 403 -> do not query them at all
    projects = [p for p in projects
                if p.get("builds_access_level", "enabled") != "disabled" and p.get("jobs_enabled", True)]
    result["projects"] = len(projects)
    recent_limit = now_utc() - dt.timedelta(minutes=recent_minutes)

    def pipelines_of(p):
        return p, api.get(f"projects/{p['id']}/pipelines", per_page=5, **pipe_filter)

    errors = []
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        futs = [ex.submit(pipelines_of, p) for p in projects]
        for fut in cf.as_completed(futs):
            try:
                p, pipes = fut.result()
            except (urllib.error.URLError, OSError, ValueError) as e:
                errors.append(str(e))
                continue
            latest_finished_seen = False
            for pl in pipes:
                entry = {
                    "host": host,
                    "project": p["path_with_namespace"],
                    "id": pl["id"],
                    "ref": pl.get("ref"),
                    "status": pl["status"],
                    "source": pl.get("source"),
                    "url": pl.get("web_url"),
                    "created_at": pl.get("created_at"),
                    "updated_at": pl.get("updated_at"),
                }
                if pl["status"] in BUSY:
                    result["busy"].append(entry)
                elif pl["status"] in READY:
                    result["ready"].append(entry)
                elif pl["status"] in FINISHED and not latest_finished_seen:
                    # only the latest finished pipeline per project
                    latest_finished_seen = True
                    upd = parse_ts(pl.get("updated_at"))
                    if upd and upd >= recent_limit:
                        result["recent"].append(entry)

    for key in ("busy", "ready", "recent"):
        result[key].sort(key=lambda e: e.get("updated_at") or "", reverse=True)
    result["ok"] = True
    if errors:
        result["error"] = "%d project queries failed: %s" % (len(errors), errors[0])
    return result


def parse_users(spec):
    """'alice' -> ('alice', {}); 'a.example=alice, b.example=bob' -> ('', {...}); mixing is allowed."""
    default, per_host = "", {}
    for part in (p.strip() for p in spec.split(",")):
        if not part:
            continue
        if "=" in part:
            host, name = (x.strip() for x in part.split("=", 1))
            per_host[host] = name
        else:
            default = part
    return default, per_host


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hosts", default="", help="comma separated; empty = all glab hosts that have a token")
    ap.add_argument("--activity-days", type=int, default=7)
    ap.add_argument("--recent-minutes", type=int, default=60)
    ap.add_argument("--only-mine", action="store_true",
                    help="only pipelines triggered by the authenticated user (or --user)")
    ap.add_argument("--user", default="",
                    help="username for --only-mine: 'name' for all hosts or 'host=name, host2=name2'; "
                         "empty = the user logged in via glab")
    args = ap.parse_args()

    default_user, host_users = parse_users(args.user)
    explicit = [h.strip() for h in args.hosts.split(",") if h.strip()]
    hosts = explicit or glab_hosts()
    with cf.ThreadPoolExecutor(max_workers=max(1, len(hosts))) as ex:
        results = list(ex.map(lambda h: check_host(h, args.activity_days, args.recent_minutes, args.only_mine,
                                                     host_users.get(h, default_user)), hosts))
    if not explicit:
        # auto-discovery: silently drop hosts without a token (e.g. gitlab.com)
        results = [r for r in results if not r.get("skipped")]

    out = {
        "generated_at": now_utc().isoformat(),
        "hosts": results,
        "busy": [e for r in results for e in r["busy"]],
        "ready": [e for r in results for e in r["ready"]],
        "recent": [e for r in results for e in r["recent"]],
    }
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
